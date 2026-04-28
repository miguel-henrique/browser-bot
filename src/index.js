const cron = require("node-cron");
const config = require("./config");
const { createLogger } = require("./logger");
const { withRetry } = require("./utils/retry");
const { runLoginWorkflow } = require("./automation/loginWorkflow");

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

async function executeScheduledRun(trigger) {
  if (trigger === "cron" && shouldSkipToday(config)) {
    logger.info("Skipping scheduled run (date is in SKIP_DATES)", {
      trigger,
      date: toDdMmYyyy(new Date(), config.runtime.timezone)
    });
    return;
  }

  const startedAt = new Date().toISOString();
  logger.info("Starting automation run", { trigger, startedAt });

  await withRetry(
    async (attempt) => {
      logger.info("Workflow attempt started", { attempt });
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
  logger.info("Scheduler is active and waiting for next run");
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error: error.message });
});

bootstrap();
