const { solveCaptchaWithOCR } = require("./ocrSolver");
const { solveCaptchaWithApi } = require("./apiSolver");
const { solveCaptchaWithTelegram } = require("./telegramSolver");

async function solveCaptcha(imageBuffer, config, logger) {
  if (config.captcha.mode === "telegram") {
    if (!config.notifications.telegramEnabled) {
      throw new Error(
        "CAPTCHA_MODE=telegram requires TELEGRAM_FALLBACK_ENABLED=true with Telegram credentials configured"
      );
    }
    logger.warn("CAPTCHA mode is telegram; skipping OCR and requesting user input via Telegram");
    return solveCaptchaWithTelegram(imageBuffer, config, logger);
  }

  const provider = config.captcha.provider;

  if (provider === "api") {
    return solveCaptchaWithApi(imageBuffer, config, logger);
  }

  if (provider === "ocr") {
    try {
      return await solveCaptchaWithOCR(imageBuffer, config, logger);
    } catch (error) {
      if (config.notifications.telegramEnabled) {
        logger.warn("OCR failed; falling back to Telegram CAPTCHA prompt", {
          error: error.message
        });
        return solveCaptchaWithTelegram(imageBuffer, config, logger);
      }
      throw error;
    }
  }

  throw new Error(`Unsupported CAPTCHA provider: ${provider}`);
}

module.exports = { solveCaptcha };
