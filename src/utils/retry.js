function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(taskFn, options) {
  const { attempts, delayMs, logger, taskName } = options;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) {
        logger.info(`${taskName}: retrying`, { attempt, attempts });
      }
      return await taskFn(attempt);
    } catch (error) {
      lastError = error;
      logger.warn(`${taskName}: attempt failed`, {
        attempt,
        attempts,
        error: error.message
      });
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

module.exports = { withRetry, sleep };
