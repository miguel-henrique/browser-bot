const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function getEnv(name, { required = false, defaultValue = undefined } = {}) {
  const value = process.env[name] ?? defaultValue;
  if (required && (value === undefined || value === "")) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).trim().toLowerCase() === "true";
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTimeList(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return fallback;
  }
  const parts = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const valid = parts.filter((item) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(item));
  return valid.length ? valid : fallback;
}

function parseDateList(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^\d{2}\/\d{2}\/\d{4}$/.test(item));
}

function parseCaptchaMode(value) {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (normalized === "auto" || normalized === "telegram") {
    return normalized;
  }
  // Helps with accidental values like "auto|telegram".
  if (normalized.includes("|")) {
    const first = normalized.split("|")[0].trim();
    if (first === "auto" || first === "telegram") {
      return first;
    }
  }
  return "auto";
}

function parseOcrLanguage(value) {
  const normalized = String(value ?? "eng").trim().toLowerCase();
  // This project ships/uses English trained data. Fallback prevents crashes from invalid values.
  return normalized === "eng" ? normalized : "eng";
}

function selectorEnv(name, defaultValue) {
  const value = getEnv(name, { defaultValue });
  // dotenv treats '#' as comment delimiter when values are not quoted.
  // This catches common truncations like "input#id" becoming "input".
  if (value === "input" || value === "button" || value === "img") {
    throw new Error(
      `Invalid ${name}="${value}". If your selector contains '#', wrap it in double quotes in .env`
    );
  }
  return value;
}

const config = {
  appUrl: getEnv("APP_URL", { required: true }),
  loginUser: getEnv("LOGIN_USER", { required: true }),
  loginPassword: getEnv("LOGIN_PASSWORD", { required: true }),
  browser: {
    headless: toBoolean(getEnv("HEADLESS", { defaultValue: "true" }), true),
    ignoreHTTPSErrors: toBoolean(
      getEnv("IGNORE_HTTPS_ERRORS", { defaultValue: "true" }),
      true
    ),
    navigationTimeoutMs: toNumber(
      getEnv("NAVIGATION_TIMEOUT_MS", { defaultValue: "45000" }),
      45000
    )
  },
  retry: {
    maxRunAttempts: toNumber(
      getEnv("MAX_RUN_ATTEMPTS", { defaultValue: "1" }),
      1
    ),
    retryDelayMs: toNumber(getEnv("RETRY_DELAY_MS", { defaultValue: "3000" }), 3000)
  },
  selectors: {
    username: selectorEnv("USERNAME_SELECTOR", "input#j_username"),
    password: selectorEnv("PASSWORD_SELECTOR", "input#j_password"),
    captchaImage: selectorEnv("CAPTCHA_IMAGE_SELECTOR", "img#j_idt141"),
    captchaInput: selectorEnv("CAPTCHA_INPUT_SELECTOR", "input#captchaId"),
    submit: selectorEnv("SUBMIT_SELECTOR", "button#btnRegistrarPontoPresencial")
  },
  loginSuccess: {
    urlContains: getEnv("LOGIN_SUCCESS_URL_CONTAINS", { defaultValue: "" }),
    selector: getEnv("LOGIN_SUCCESS_SELECTOR", { defaultValue: "" }),
    text: getEnv("LOGIN_SUCCESS_TEXT", { defaultValue: "" }),
    errorSelector: getEnv("LOGIN_ERROR_SELECTOR", {
      defaultValue:
        ".ui-messages-error-summary, .ui-messages-error-detail, .ui-message-error-detail"
    }),
    settleWaitMs: toNumber(getEnv("LOGIN_SETTLE_WAIT_MS", { defaultValue: "3000" }), 3000)
  },
  captcha: {
    enabled: toBoolean(getEnv("ENABLE_CAPTCHA", { defaultValue: "true" }), true),
    mode: parseCaptchaMode(getEnv("CAPTCHA_MODE", { defaultValue: "auto" })),
    provider: getEnv("CAPTCHA_PROVIDER", { defaultValue: "ocr" }),
    maxSubmitAttempts: toNumber(
      getEnv("CAPTCHA_SUBMIT_MAX_ATTEMPTS", { defaultValue: "1" }),
      1
    ),
    ocrLanguage: parseOcrLanguage(getEnv("OCR_LANGUAGE", { defaultValue: "eng" })),
    ocrNumericOnly: toBoolean(getEnv("OCR_NUMERIC_ONLY", { defaultValue: "true" }), true),
    ocrExpectedLength: toNumber(getEnv("OCR_EXPECTED_LENGTH", { defaultValue: "4" }), 4),
    ocrMinLength: toNumber(getEnv("OCR_MIN_LENGTH", { defaultValue: "3" }), 3),
    ocrMaxAttempts: toNumber(getEnv("OCR_MAX_ATTEMPTS", { defaultValue: "10" }), 10),
    apiUrl: getEnv("CAPTCHA_API_URL", { defaultValue: "" }),
    apiKey: getEnv("CAPTCHA_API_KEY", { defaultValue: "" }),
    apiTimeoutMs: toNumber(
      getEnv("CAPTCHA_API_TIMEOUT_MS", { defaultValue: "30000" }),
      30000
    ),
    submitDelayMs: toNumber(getEnv("CAPTCHA_SUBMIT_DELAY_MS", { defaultValue: "1500" }), 1500)
  },
  runtime: {
    screenshotDir: path.resolve(
      getEnv("SCREENSHOT_DIR", { defaultValue: "./artifacts/screenshots" })
    ),
    logLevel: getEnv("LOG_LEVEL", { defaultValue: "info" }),
    debugLogValues: toBoolean(getEnv("DEBUG_LOG_VALUES", { defaultValue: "false" }), false),
    captureScreenshots: toBoolean(getEnv("CAPTURE_SCREENSHOTS", { defaultValue: "true" }), true),
    timezone: getEnv("TIMEZONE", { defaultValue: "America/Sao_Paulo" }),
    runOnce: toBoolean(getEnv("RUN_ONCE", { defaultValue: "false" }), false),
    scheduleTimes: parseTimeList(
      getEnv("SCHEDULE_TIMES", { defaultValue: "07:00,11:25,12:25,16:00" }),
      ["07:00", "11:25", "12:25", "16:00"]
    ),
    skipDates: parseDateList(getEnv("SKIP_DATES", { defaultValue: "" }))
  },
  notifications: {
    telegramEnabled: toBoolean(getEnv("TELEGRAM_FALLBACK_ENABLED", { defaultValue: "false" }), false),
    telegramBotToken: getEnv("TELEGRAM_BOT_TOKEN", { defaultValue: "" }),
    telegramChatId: getEnv("TELEGRAM_CHAT_ID", { defaultValue: "" }),
    telegramReplyTimeoutMs: toNumber(getEnv("TELEGRAM_REPLY_TIMEOUT_MS", { defaultValue: "180000" }), 180000),
    telegramPollIntervalMs: toNumber(getEnv("TELEGRAM_POLL_INTERVAL_MS", { defaultValue: "4000" }), 4000),
    telegramOcrMaxAttemptsAfterTimeout: toNumber(
      getEnv("TELEGRAM_OCR_MAX_ATTEMPTS_AFTER_TIMEOUT", { defaultValue: "10" }),
      10
    )
  }
};

module.exports = config;
