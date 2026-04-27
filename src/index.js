const cron = require("node-cron");
const config = require("./config");
const { createLogger } = require("./logger");
const { withRetry } = require("./utils/retry");
const { runLoginWorkflow } = require("./automation/loginWorkflow");

const logger = createLogger(config.runtime.logLevel);
const CRON_EXPRESSION = "0 7,12,13,16 * * *";

async function executeScheduledRun(trigger) {
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
  cron.schedule(
    CRON_EXPRESSION,
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

  logger.info("Scheduler registered", {
    cron: CRON_EXPRESSION,
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
