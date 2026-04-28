const cron = require("node-cron");
const config = require("./config");
const { createLogger } = require("./logger");
const { withRetry } = require("./utils/retry");
const { runLoginWorkflow } = require("./automation/loginWorkflow");
const { sendTelegramMessage } = require("./captcha/telegramSolver");

const logger = createLogger(config.runtime.logLevel);

function toDdMmYyyy(date, timezone) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(date);
  const day = parts.find((p) => p.type === "day")?.value || "01";
  const month = parts.find((p) => p.type === "month")?.value || "01";
  const year = parts.find((p) => p.type === "year")?.value || "1970";
  return `${day}/${month}/${year}`;
}

function shouldSkipToday(configObj) {
  const today = toDdMmYyyy(new Date(), configObj.runtime.timezone);
  return configObj.runtime.skipDates.includes(today);
}

function buildCronExpressions(times) {
  return times.map((time) => {
    const [hour, minute] = time.split(":");
    return `${Number(minute)} ${Number(hour)} * * 1-5`;
  });
}

function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short"
  }).formatToParts(date);
  const obj = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      obj[p.type] = p.value;
    }
  }
  return obj;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isWeekdayShort(weekday) {
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
}

function getNextExecutionInfo(configObj, fromDate = new Date()) {
  const timezone = configObj.runtime.timezone;
  const scheduleTimes = [...configObj.runtime.scheduleTimes].sort();
  const nowParts = getZonedParts(fromDate, timezone);
  const nowHm = `${nowParts.hour}:${nowParts.minute}`;

  for (let offset = 0; offset <= 366; offset += 1) {
    const candidate = addDays(fromDate, offset);
    const p = getZonedParts(candidate, timezone);
    const ddmmyyyy = `${p.day}/${p.month}/${p.year}`;
    if (!isWeekdayShort(p.weekday)) {
      continue;
    }
    if (configObj.runtime.skipDates.includes(ddmmyyyy)) {
      continue;
    }

    for (const hm of scheduleTimes) {
      if (offset === 0 && hm <= nowHm) {
        continue;
      }
      return {
        time: hm,
        date: ddmmyyyy
      };
    }
  }

  return null;
}

function formatModeLabel(mode) {
  return mode === "telegram" ? "Telegram Mode" : "Auto Mode";
}

async function notifySuccess(configObj, logger) {
  if (!configObj.notifications.telegramEnabled) {
    return;
  }

  const now = new Date();
  const current = getZonedParts(now, configObj.runtime.timezone);
  const currentStamp = `${current.hour}:${current.minute} ${current.day}/${current.month}/${current.year.slice(
    -2
  )}`;
  const next = getNextExecutionInfo(configObj, now);

  const nextLine = next
    ? `Next execution at Date and Time ${next.time} ${next.date}`
    : "Next execution at Date and Time unavailable";

  const text = `Success! ${formatModeLabel(configObj.captcha.mode)} mode at ${currentStamp}\n${nextLine}`;
  await sendTelegramMessage(configObj, text, logger);
}

async function executeScheduledRun(trigger) {
  if (trigger === "cron" && shouldSkipToday(config)) {
    logger.info("Skipping scheduled run (date is in SKIP_DATES)", {
      trigger,
      date: toDdMmYyyy(new Date(), config.runtime.timezone)
    });
    return;
  }

  const startedAt = new Date().toISOString();
  logger.info("Run started", { trigger, startedAt, mode: config.captcha.mode });

  await withRetry(
    async (attempt) => {
      logger.info("Attempt started", { attempt });
      await runLoginWorkflow(config, logger);
    },
    {
      attempts: config.retry.maxRunAttempts,
      delayMs: config.retry.retryDelayMs,
      logger,
      taskName: "scheduled-login"
    }
  );

  logger.info("Automation run completed", { trigger });
  try {
    await notifySuccess(config, logger);
  } catch (notifyError) {
    logger.warn("Success Telegram notification failed", { error: notifyError.message });
  }
}

function registerSchedule() {
  const cronExpressions = buildCronExpressions(config.runtime.scheduleTimes);

  for (const expression of cronExpressions) {
    cron.schedule(
      expression,
      async () => {
        try {
          await executeScheduledRun("cron");
        } catch (error) {
          logger.error("Scheduled run failed after retries", { error: error.message });
        }
      },
      {
        timezone: config.runtime.timezone
      }
    );
  }

  logger.info("Scheduler registered", {
    cronExpressions,
    times: config.runtime.scheduleTimes,
    timezone: config.runtime.timezone
  });
}

async function bootstrap() {
  if (config.runtime.runOnce) {
    try {
      await executeScheduledRun("run-once");
      process.exitCode = 0;
    } catch (error) {
      logger.error("One-off run failed", { error: error.message });
      process.exitCode = 1;
    }
    return;
  }

  registerSchedule();
  const next = getNextExecutionInfo(config);
  logger.info("Scheduler is active and waiting for next run", {
    next
  });
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error: error.message });
});

bootstrap();
