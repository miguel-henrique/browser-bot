const axios = require("axios");

async function solveCaptchaWithApi(imageBuffer, config) {
  if (!config.captcha.apiUrl || !config.captcha.apiKey) {
    throw new Error("CAPTCHA API is selected but CAPTCHA_API_URL/API_KEY is missing");
  }

  const response = await axios.post(
    config.captcha.apiUrl,
    {
      imageBase64: imageBuffer.toString("base64")
    },
    {
      headers: {
        Authorization: `Bearer ${config.captcha.apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: config.captcha.apiTimeoutMs
    }
  );

  const text = String(response.data?.text || "").trim();
  if (!text) {
    throw new Error("CAPTCHA API response did not include solved text");
  }

  return text;
}

module.exports = { solveCaptchaWithApi };
