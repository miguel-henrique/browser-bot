const { solveCaptchaWithOCR } = require("./ocrSolver");
const { solveCaptchaWithApi } = require("./apiSolver");

async function solveCaptcha(imageBuffer, config, logger) {
  switch (config.captcha.provider) {
    case "ocr":
      return solveCaptchaWithOCR(imageBuffer, config, logger);
    case "api":
      return solveCaptchaWithApi(imageBuffer, config, logger);
    default:
      throw new Error(`Unsupported CAPTCHA provider: ${config.captcha.provider}`);
  }
}

module.exports = { solveCaptcha };
