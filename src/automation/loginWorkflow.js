const fs = require("fs/promises");
const path = require("path");
const puppeteer = require("puppeteer");
const { solveCaptcha } = require("../captcha");
const {
  solveCaptchaWithTelegram,
  TelegramReplyTimeoutError
} = require("../captcha/telegramSolver");
const { solveCaptchaWithOCR } = require("../captcha/ocrSolver");

function buildRunId() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-");
}

async function ensureDirExists(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function capture(page, config, runId, stage) {
  if (!config.runtime.captureScreenshots) {
    return null;
  }
  await ensureDirExists(config.runtime.screenshotDir);
  const filePath = path.join(config.runtime.screenshotDir, `${runId}-${stage}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

function maskValue(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 2) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 2)}${"*".repeat(Math.max(0, value.length - 2))}`;
}

async function isVisible(page, selector) {
  const handle = await page.$(selector);
  if (!handle) {
    return false;
  }
  return page.$eval(selector, (el) => {
    const style = window.getComputedStyle(el);
    return style && style.visibility !== "hidden" && style.display !== "none";
  });
}

async function setInputValueAndDispatch(page, selector, value) {
  return page.$eval(
    selector,
    (el, nextValue) => {
      const input = el;
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;

      if (nativeSetter) {
        nativeSetter.call(input, nextValue);
      } else {
        input.value = nextValue;
      }

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return input.value ?? "";
    },
    value
  );
}

async function fillIfEmpty(page, selector, value, logger, fieldName) {
  await page.waitForSelector(selector, { timeout: 10000, visible: true });
  const existingValue = await page.$eval(selector, (el) => el.value ?? "");
  logger.info(`${fieldName} field located`, {
    selector,
    existingLength: existingValue.length
  });

  if (!existingValue) {
    await page.click(selector, { clickCount: 3 });
    await page.type(selector, value, { delay: 40 });
    const typedValue = await page.$eval(selector, (el) => el.value ?? "");
    logger.info(`Filled ${fieldName} field`, {
      selector,
      typedLength: typedValue.length
    });
  } else {
    logger.info(`Skipped ${fieldName}, field already has value`);
  }

  return page.$eval(selector, (el) => el.value ?? "");
}

async function validateLoginSuccess(page, config, logger) {
  const defaultSuccessSelector = "#messages .ui-messages-info, #messages .ui-messages-info-summary";
  const defaultSuccessText = "Ponto registrado com sucesso";

  const explicitSuccessSelector = config.loginSuccess.selector || defaultSuccessSelector;
  const explicitSuccessText = config.loginSuccess.text || defaultSuccessText;
  const isContextDestroyedError = (error) =>
    error &&
    typeof error.message === "string" &&
    (error.message.includes("Execution context was destroyed") ||
      error.message.includes("Cannot find context with specified id"));

  const deadlineMs = Date.now() + 12000;
  let contextResetCount = 0;

  while (Date.now() < deadlineMs) {
    try {
      if (config.loginSuccess.urlContains && page.url().includes(config.loginSuccess.urlContains)) {
        logger.info("Detected success by URL", { url: page.url() });
        return true;
      }

      const messages = await page.$$eval(
        "#messages .ui-messages-info-summary, #messages .ui-messages-info, #messages .ui-messages-error-summary, #messages .ui-messages-error-detail, #messages .ui-message-error-detail",
        (els) => els.map((el) => (el.textContent || "").trim()).filter(Boolean)
      );

      const successMessage = messages.find((text) =>
        explicitSuccessText ? text.includes(explicitSuccessText) : false
      );
      if (successMessage) {
        logger.info("Detected success message", { message: successMessage });
        return true;
      }

      const errorMessage = messages.find((text) =>
        /captcha|incorreto|inv[aá]lido|erro/i.test(text)
      );
      if (errorMessage) {
        throw new Error(`Login failed with page error: ${errorMessage}`);
      }

      // If we see any message but it's not captcha-related, it's likely a non-retryable error
      // (e.g. LDAP locked, invalid credentials, system outage). Abort this run for the current slot.
      if (messages.length > 0) {
        const firstMessage = messages[0];
        const err = new Error(`Login failed with page error: ${firstMessage}`);
        err.nonRetryable = true;
        throw err;
      }

      if (explicitSuccessSelector) {
        const successHandle = await page.$(explicitSuccessSelector);
        if (successHandle) {
          logger.info("Detected success message by selector", {
            selector: explicitSuccessSelector
          });
          return true;
        }
      }
    } catch (error) {
      if (!isContextDestroyedError(error)) {
        throw error;
      }
      contextResetCount += 1;
      logger.warn("Execution context changed while validating submit result", {
        contextResetCount
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  const loginFieldsStillVisible = await Promise.all([
    isVisible(page, config.selectors.username).catch(() => false),
    isVisible(page, config.selectors.password).catch(() => false)
  ]);
  throw new Error(
    `Submit result timeout (login form still visible: ${loginFieldsStillVisible.some(Boolean)})`
  );
}

function isCaptchaMismatchError(error) {
  const message = String(error?.message || "");
  return /captcha/i.test(message) && /n[aã]o corresponde|inv[aá]lido|incorrect|incorreto/i.test(message);
}

function isRetryableCaptchaError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    isCaptchaMismatchError(error) ||
    message.includes("ocr result invalid") ||
    message.includes("ocr too uncertain") ||
    message.includes("could not read") ||
    message.includes("segmented ocr") ||
    message.includes("captcha image changed") ||
    message.includes("captcha value mismatch before submit")
  );
}

async function attemptTelegramCaptchaRescue(page, config, logger, runId) {
  if (!config.notifications?.telegramEnabled) {
    return false;
  }

  logger.warn("CAPTCHA rescue: requesting code from Telegram");
  await page.waitForSelector(config.selectors.captchaImage, {
    timeout: 20000,
    visible: true
  });

  const captchaElement = await page.$(config.selectors.captchaImage);
  if (!captchaElement) {
    throw new Error("CAPTCHA image element not found during Telegram rescue");
  }

  const imageBuffer = await captchaElement.screenshot({ encoding: "binary" });
  if (config.runtime.captureScreenshots) {
    await ensureDirExists(config.runtime.screenshotDir);
    const rescueShot = path.join(
      config.runtime.screenshotDir,
      `${runId}-telegram-rescue-captcha.png`
    );
    await fs.writeFile(rescueShot, imageBuffer);
    logger.info("CAPTCHA rescue: local image saved", { screenshot: rescueShot });
  } else {
    logger.info("CAPTCHA rescue: local image capture disabled by config");
  }

  let rescuedCaptcha;
  try {
    rescuedCaptcha = await solveCaptchaWithTelegram(imageBuffer, config, logger);
  } catch (error) {
    if (error && error.code === "TELEGRAM_REPLY_TIMEOUT") {
      logger.warn("CAPTCHA rescue: Telegram timed out; switching to OCR recovery", {
        maxAttempts: config.notifications.telegramOcrMaxAttemptsAfterTimeout
      });
      return attemptOcrRecoveryAfterTelegramTimeout(page, config, logger, runId, "telegram-rescue");
    }
    throw error;
  }
  console.log("[CAPTCHA] Telegram provided code:", rescuedCaptcha);

  // After a failed submit, the page can clear credential fields.
  await fillIfEmpty(page, config.selectors.username, config.loginUser, logger, "username");
  await fillIfEmpty(page, config.selectors.password, config.loginPassword, logger, "password");

  await page.waitForSelector(config.selectors.captchaInput, {
    timeout: 10000,
    visible: true
  });
  await page.click(config.selectors.captchaInput, { clickCount: 3 });
  await setInputValueAndDispatch(page, config.selectors.captchaInput, rescuedCaptcha);

  const settleMs = Math.max(0, Number(config.captcha.submitDelayMs) || 0);
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  await page.waitForSelector(config.selectors.submit, { timeout: 10000, visible: true });
  await page.click(config.selectors.submit);
  logger.info("CAPTCHA rescue: submitted login form with Telegram code");

  await validateLoginSuccess(page, config, logger);
  const successShot = await capture(page, config, runId, "telegram-rescue-success");
  if (successShot) {
    logger.info("Workflow completed with Telegram CAPTCHA rescue", { screenshot: successShot });
  } else {
    logger.info("Workflow completed with Telegram CAPTCHA rescue");
  }
  return { captchaMethodUsed: "telegram" };
}

async function attemptOcrRecoveryAfterTelegramTimeout(page, config, logger, runId, contextLabel) {
  const maxAttempts = config.notifications.telegramOcrMaxAttemptsAfterTimeout;
  logger.warn("OCR recovery: trying to solve CAPTCHA after Telegram timeout", {
    context: contextLabel,
    maxAttempts
  });

  // Reuse the same settle delay, but we want many independent OCR+submit attempts.
  const settleMs = Math.max(0, Number(config.captcha.submitDelayMs) || 0);

  for (let ocrAttempt = 1; ocrAttempt <= maxAttempts; ocrAttempt += 1) {
    logger.info("OCR recovery attempt", { ocrAttempt, maxAttempts });

    // Ensure credentials are present (they can be cleared after errors).
    await fillIfEmpty(
      page,
      config.selectors.username,
      config.loginUser,
      logger,
      "username"
    );
    await fillIfEmpty(
      page,
      config.selectors.password,
      config.loginPassword,
      logger,
      "password"
    );

    await page.waitForSelector(config.selectors.captchaImage, {
      timeout: 20000,
      visible: true
    });

    const captchaElement = await page.$(config.selectors.captchaImage);
    if (!captchaElement) {
      throw new Error("CAPTCHA image element not found during OCR recovery");
    }

    const imageBuffer = await captchaElement.screenshot({ encoding: "binary" });

    let solvedCaptcha;
    try {
      solvedCaptcha = await solveCaptchaWithOCR(imageBuffer, config, logger);
    } catch (ocrError) {
      logger.warn("OCR recovery: could not decode CAPTCHA; retrying with a fresh attempt", {
        ocrAttempt,
        error: ocrError.message
      });
      try {
        await page.reload({
          waitUntil: "networkidle2",
          timeout: config.browser.navigationTimeoutMs
        });
      } catch (reloadError) {
        logger.warn("OCR recovery: reload failed after OCR decode error", { error: reloadError.message });
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      continue;
    }

    await page.waitForSelector(config.selectors.captchaInput, {
      timeout: 10000,
      visible: true
    });
    await page.click(config.selectors.captchaInput, { clickCount: 3 });
    const enteredCaptcha = await setInputValueAndDispatch(
      page,
      config.selectors.captchaInput,
      solvedCaptcha
    );

    if (enteredCaptcha !== solvedCaptcha) {
      throw new Error(
        `CAPTCHA value mismatch during OCR recovery (solved=${solvedCaptcha}, entered=${enteredCaptcha})`
      );
    }

    if (settleMs > 0) {
      logger.info("OCR recovery: waiting before submit", { ms: settleMs });
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }

    await page.waitForSelector(config.selectors.submit, { timeout: 10000, visible: true });
    await page.click(config.selectors.submit);
    logger.info("OCR recovery: submitted login form");

    try {
      await validateLoginSuccess(page, config, logger);
      logger.info("OCR recovery: success");
      return { captchaMethodUsed: "ocr" };
    } catch (error) {
      if (isRetryableCaptchaError(error)) {
        logger.warn("OCR recovery: captcha rejected; reloading page", { error: error.message });
        try {
          await page.reload({
            waitUntil: "networkidle2",
            timeout: config.browser.navigationTimeoutMs
          });
        } catch (reloadError) {
          logger.warn("OCR recovery: reload failed", { error: reloadError.message });
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
        continue;
      }
      throw error;
    }
  }

  throw new Error(`OCR recovery failed after ${maxAttempts} attempts`);
}

async function runLoginWorkflow(config, logger) {
  const runId = buildRunId();
  let browser;
  let activePage;
  let captchaMethodUsed = null;

  try {
    logger.info("Step 1/5: launching browser", {
      headless: config.browser.headless,
      ignoreHTTPSErrors: config.browser.ignoreHTTPSErrors
    });

    browser = await puppeteer.launch({
      headless: config.browser.headless,
      ignoreHTTPSErrors: config.browser.ignoreHTTPSErrors,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"]
    });

    const page = await browser.newPage();
    activePage = page;
    page.setDefaultTimeout(config.browser.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);

    await page.goto(config.appUrl, {
      waitUntil: "networkidle2",
      timeout: config.browser.navigationTimeoutMs
    });

    logger.info("Step 2/5: login page loaded", { url: page.url() });

    const totalCaptchaAttempts = Math.max(1, config.captcha.maxSubmitAttempts);
    for (let captchaAttempt = 1; captchaAttempt <= totalCaptchaAttempts; captchaAttempt += 1) {
      logger.info("Step 3/5: preparing login form and captcha", {
        captchaAttempt,
        totalCaptchaAttempts
      });

      // Refill each attempt in case the page cleared fields after a submit.
      const usernameValue = await fillIfEmpty(
        page,
        config.selectors.username,
        config.loginUser,
        logger,
        "username"
      );
      const passwordValue = await fillIfEmpty(
        page,
        config.selectors.password,
        config.loginPassword,
        logger,
        "password"
      );

      if (config.runtime.debugLogValues) {
        logger.info("Field debug values", {
          username: usernameValue,
          passwordLength: passwordValue.length
        });
      }

      if (config.captcha.enabled) {
        logger.info("CAPTCHA enabled; waiting for image element");
        await page.waitForSelector(config.selectors.captchaImage, {
          timeout: 20000,
          visible: true
        });

        const captchaMetaBefore = await page.$eval(config.selectors.captchaImage, (el) => ({
          src: el.getAttribute("src") || "",
          currentSrc: el.currentSrc || ""
        }));
        logger.info("CAPTCHA metadata before OCR", captchaMetaBefore);

        const captchaElement = await page.$(config.selectors.captchaImage);
        if (!captchaElement) {
          throw new Error("CAPTCHA image element was not found");
        }

        const imageBuffer = await captchaElement.screenshot({ encoding: "binary" });
        if (config.runtime.captureScreenshots) {
          await ensureDirExists(config.runtime.screenshotDir);
          const captchaShot = path.join(
            config.runtime.screenshotDir,
            `${runId}-attempt-${captchaAttempt}-captcha.png`
          );
          await fs.writeFile(captchaShot, imageBuffer);
          logger.info("CAPTCHA image captured", { screenshot: captchaShot });
        } else {
          logger.info("CAPTCHA image captured in memory (local screenshot disabled)");
        }
        let solvedCaptcha;
        try {
          const solved = await solveCaptcha(imageBuffer, config, logger);
          solvedCaptcha = solved.value;
          captchaMethodUsed = solved.method;
        } catch (error) {
          if (error && error.code === "TELEGRAM_REPLY_TIMEOUT") {
            return attemptOcrRecoveryAfterTelegramTimeout(page, config, logger, runId, "telegram-mode/timeout");
          }
          throw error;
        }

        console.log("[CAPTCHA] Resolved code:", solvedCaptcha);

        await page.waitForSelector(config.selectors.captchaInput, {
          timeout: 10000,
          visible: true
        });
        await page.click(config.selectors.captchaInput, { clickCount: 3 });
        const enteredCaptcha = await setInputValueAndDispatch(
          page,
          config.selectors.captchaInput,
          solvedCaptcha
        );
        logger.info("CAPTCHA value entered", {
          enteredLength: enteredCaptcha.length
        });
        if (enteredCaptcha !== solvedCaptcha) {
          throw new Error(
            `CAPTCHA value mismatch before submit (solved=${solvedCaptcha}, entered=${enteredCaptcha})`
          );
        }

        const captchaMetaBeforeSubmit = await page.$eval(config.selectors.captchaImage, (el) => ({
          src: el.getAttribute("src") || "",
          currentSrc: el.currentSrc || ""
        }));
        if (
          captchaMetaBeforeSubmit.src !== captchaMetaBefore.src ||
          captchaMetaBeforeSubmit.currentSrc !== captchaMetaBefore.currentSrc
        ) {
          throw new Error("CAPTCHA image changed after OCR and before submit");
        }

        const preSubmitShot = await capture(page, config, runId, `attempt-${captchaAttempt}-pre-submit`);
        if (preSubmitShot) {
          logger.info("Pre-submit screenshot captured", { screenshot: preSubmitShot });
        }

        if (config.runtime.debugLogValues) {
          logger.info("CAPTCHA debug values", {
            solvedCaptcha,
            enteredCaptcha
          });
        } else {
          logger.info("CAPTCHA solved preview", {
            solvedCaptchaMasked: maskValue(solvedCaptcha)
          });
        }
      } else {
        logger.info("CAPTCHA handling is disabled by config");
      }

      const settleMs = Math.max(0, Number(config.captcha.submitDelayMs) || 0);
      if (settleMs > 0) {
        logger.info("Waiting before submit", { ms: settleMs });
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }

      await page.waitForSelector(config.selectors.submit, { timeout: 10000, visible: true });
      await page.click(config.selectors.submit);
      logger.info("Step 4/5: login form submitted");

      try {
        await validateLoginSuccess(page, config, logger);
        const successShot = await capture(page, config, runId, "success");
        if (successShot) {
          logger.info("Step 5/5: workflow completed successfully", { screenshot: successShot });
        } else {
          logger.info("Step 5/5: workflow completed successfully");
        }
        return { captchaMethodUsed: captchaMethodUsed || (config.captcha.mode === "telegram" ? "telegram" : "ocr") };
      } catch (error) {
        if (isRetryableCaptchaError(error) && captchaAttempt >= totalCaptchaAttempts) {
          try {
            const rescued = await attemptTelegramCaptchaRescue(page, config, logger, runId);
            if (rescued) {
              return rescued;
            }
          } catch (rescueError) {
            logger.warn("Telegram CAPTCHA rescue failed", {
              error: rescueError.message
            });
          }
        }
        if (isRetryableCaptchaError(error) && captchaAttempt < totalCaptchaAttempts) {
          logger.warn("Retryable CAPTCHA failure, trying a fresh captcha", {
            captchaAttempt,
            totalCaptchaAttempts,
            error: error.message
          });
          try {
            await page.reload({
              waitUntil: "networkidle2",
              timeout: config.browser.navigationTimeoutMs
            });
          } catch (reloadError) {
            logger.warn("Page reload failed after captcha retryable error", {
              error: reloadError.message
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 700));
          continue;
        }
        throw error;
      }
    }

    throw new Error("CAPTCHA attempts exhausted without success");
  } catch (error) {
    logger.error("Workflow failed", { error: error.message });
    if (browser && activePage) {
      try {
        const failShot = await capture(activePage, config, runId, "failure");
        if (failShot) {
          logger.info("Failure screenshot captured", { screenshot: failShot });
        }
      } catch (captureError) {
        logger.warn("Could not capture failure screenshot", {
          error: captureError.message
        });
      }
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      logger.info("Browser closed");
    }
  }
}

module.exports = { runLoginWorkflow };
