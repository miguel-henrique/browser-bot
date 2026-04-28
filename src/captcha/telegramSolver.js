const fs = require("fs/promises");
const path = require("path");

async function telegramRequest(config, method, payload, logger) {
  const token = config.notifications.telegramBotToken;
  const url = `https://api.telegram.org/bot${token}/${method}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`Telegram API HTTP ${res.status} on ${method}`);
  }

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error on ${method}: ${data.description || "unknown"}`);
  }

  logger.debug("Telegram API request ok", { method });
  return data.result;
}

async function telegramSendPhotoBuffer(config, chatId, imageBuffer, caption, logger) {
  const token = config.notifications.telegramBotToken;
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("photo", new Blob([imageBuffer], { type: "image/png" }), "captcha.png");

  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`Telegram API HTTP ${res.status} on sendPhoto`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error on sendPhoto: ${data.description || "unknown"}`);
  }
  logger.debug("Telegram API request ok", { method: "sendPhoto" });
  return data.result;
}

function parseCodeFromText(text, expectedLength) {
  const digits = String(text || "").replace(/\D/g, "");
  if (digits.length < expectedLength) {
    return "";
  }
  return digits.slice(0, expectedLength);
}

async function solveCaptchaWithTelegram(imageBuffer, config, logger) {
  const chatId = config.notifications.telegramChatId;
  const expectedLength = config.captcha.ocrExpectedLength;
  const timeoutMs = config.notifications.telegramReplyTimeoutMs;
  const pollingMs = config.notifications.telegramPollIntervalMs;

  if (!config.notifications.telegramEnabled) {
    throw new Error("Telegram fallback is disabled");
  }
  if (!config.notifications.telegramBotToken || !chatId) {
    throw new Error("Telegram fallback requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  }

  await fs.mkdir(config.runtime.screenshotDir, { recursive: true });
  const fallbackName = `captcha-fallback-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const fallbackPath = path.join(config.runtime.screenshotDir, fallbackName);
  await fs.writeFile(fallbackPath, imageBuffer);

  await telegramSendPhotoBuffer(
    config,
    chatId,
    imageBuffer,
    [
      "Browser bot could not solve CAPTCHA.",
      `Reply with the ${expectedLength}-digit code only.`
    ].join("\n"),
    logger
  );

  await telegramRequest(
    config,
    "sendMessage",
    {
      chat_id: chatId,
      text: "Waiting for your reply..."
    },
    logger
  );

  const existingUpdates = await telegramRequest(
    config,
    "getUpdates",
    { timeout: 0, limit: 1 },
    logger
  );
  let offset =
    existingUpdates && existingUpdates.length
      ? existingUpdates[existingUpdates.length - 1].update_id + 1
      : undefined;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const updates = await telegramRequest(
      config,
      "getUpdates",
      { timeout: Math.max(1, Math.floor(pollingMs / 1000)), offset, limit: 50 },
      logger
    );

    if (updates && updates.length) {
      offset = updates[updates.length - 1].update_id + 1;
      for (const update of updates) {
        const msg = update.message || update.edited_message;
        if (!msg) {
          continue;
        }
        if (String(msg.chat?.id) !== String(chatId)) {
          continue;
        }
        const parsed = parseCodeFromText(msg.text || msg.caption || "", expectedLength);
        if (parsed.length === expectedLength) {
          await telegramRequest(
            config,
            "sendMessage",
            { chat_id: chatId, text: `Received code: ${parsed}. Continuing automation.` },
            logger
          );
          return parsed;
        }
      }
    }
  }

  throw new Error(`Telegram fallback timed out after ${timeoutMs}ms`);
}

module.exports = { solveCaptchaWithTelegram };
