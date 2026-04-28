const { solveCaptchaWithOCR } = require("./ocrSolver");
const { solveCaptchaWithApi } = require("./apiSolver");
const { solveCaptchaManually } = require("./manualSolver");
const { solveCaptchaWithTelegram } = require("./telegramSolver");

async function solveCaptcha(imageBuffer, config, logger) {
  const provider = config.captcha.provider;

  if (provider === "manual") {
    return solveCaptchaManually(config, logger);
  }

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
      if (config.captcha.manualFallbackEnabled) {
        logger.warn("OCR failed; falling back to manual CAPTCHA", {
          error: error.message
        });
        return solveCaptchaManually(config, logger);
      }
      throw error;
    }
  }

  throw new Error(`Unsupported CAPTCHA provider: ${provider}`);
}

module.exports = { solveCaptcha };
