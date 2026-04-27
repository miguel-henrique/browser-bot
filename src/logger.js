const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function createLogger(levelName = "info") {
  const activeLevel = LEVELS[levelName] ?? LEVELS.info;

  function log(level, message, meta = undefined) {
    if ((LEVELS[level] ?? 999) < activeLevel) {
      return;
    }

    const timestamp = new Date().toISOString();
    const payload =
      meta && Object.keys(meta).length
        ? `${message} | ${JSON.stringify(meta)}`
        : message;
    // eslint-disable-next-line no-console
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${payload}`);
  }

  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta)
  };
}

module.exports = { createLogger };
