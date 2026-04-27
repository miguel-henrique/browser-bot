const fs = require("fs/promises");
const path = require("path");
const puppeteer = require("puppeteer");
const { solveCaptcha } = require("../captcha");

function buildRunId() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-");
}

async function ensureDirExists(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function capture(page, config, runId, stage) {
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
    error.message.includes("Execution context was destroyed");

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

async function runLoginWorkflow(config, logger) {
  const runId = buildRunId();
  let browser;
  let activePage;

  try {
    logger.info("Launching browser", {
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

    logger.info("Loaded login page", { url: page.url() });

    const totalCaptchaAttempts = Math.max(1, config.captcha.maxSubmitAttempts);
    for (let captchaAttempt = 1; captchaAttempt <= totalCaptchaAttempts; captchaAttempt += 1) {
      logger.info("Starting captcha submit attempt", {
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
        logger.info("CAPTCHA enabled; waiting for image");
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
        await ensureDirExists(config.runtime.screenshotDir);
        const captchaShot = path.join(
          config.runtime.screenshotDir,
          `${runId}-attempt-${captchaAttempt}-captcha.png`
        );
        await fs.writeFile(captchaShot, imageBuffer);
        logger.info("CAPTCHA image captured", { screenshot: captchaShot });
        const solvedCaptcha = await solveCaptcha(imageBuffer, config, logger);

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
        logger.info("Pre-submit screenshot captured", { screenshot: preSubmitShot });

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
      logger.info("Submitted login form");

      try {
        await validateLoginSuccess(page, config, logger);
        const successShot = await capture(page, config, runId, "success");
        logger.info("Workflow completed successfully", { screenshot: successShot });
        return;
      } catch (error) {
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
        logger.info("Failure screenshot captured", { screenshot: failShot });
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
