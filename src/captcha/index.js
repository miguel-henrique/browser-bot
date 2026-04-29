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
    const value = await solveCaptchaWithTelegram(imageBuffer, config, logger);
    return { value, method: "telegram" };
  }

  const provider = config.captcha.provider;

  if (provider === "api") {
    const value = await solveCaptchaWithApi(imageBuffer, config, logger);
    return { value, method: "api" };
  }

  if (provider === "ocr") {
    try {
      const value = await solveCaptchaWithOCR(imageBuffer, config, logger);
      return { value, method: "ocr" };
    } catch (error) {
      if (config.notifications.telegramEnabled) {
        logger.warn("OCR failed; falling back to Telegram CAPTCHA prompt", {
          error: error.message
        });
        const value = await solveCaptchaWithTelegram(imageBuffer, config, logger);
        return { value, method: "telegram" };
      }
      throw error;
    }
  }

  throw new Error(`Unsupported CAPTCHA provider: ${provider}`);
}

module.exports = { solveCaptcha };
