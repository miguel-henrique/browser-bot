const readline = require("readline/promises");
const { stdin, stdout } = require("process");

async function solveCaptchaManually(config, logger) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    logger.warn("Manual CAPTCHA input requested");
    const answer = await rl.question(
      `Enter CAPTCHA (${config.captcha.ocrExpectedLength} digits): `
    );
    const value = String(answer || "").replace(/\s+/g, "").trim();
    if (!/^\d{4}$/.test(value)) {
      throw new Error("Manual CAPTCHA must be exactly 4 digits");
    }
    return value;
  } finally {
    rl.close();
  }
}

module.exports = { solveCaptchaManually };
