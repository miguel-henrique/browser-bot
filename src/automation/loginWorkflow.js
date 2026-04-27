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
  if (config.loginSuccess.urlContains) {
    await page.waitForFunction(
      (expected) => window.location.href.includes(expected),
      { timeout: 30000 },
      config.loginSuccess.urlContains
    );
    return true;
  }

  if (config.loginSuccess.selector) {
    await page.waitForSelector(config.loginSuccess.selector, {
      timeout: 30000,
      visible: true
    });
    return true;
  }

  if (config.loginSuccess.text) {
    await page.waitForFunction(
      (txt) => document.body && document.body.innerText.includes(txt),
      { timeout: 30000 },
      config.loginSuccess.text
    );
    return true;
  }

  // Fallback path: wait for page to settle, then infer success/failure.
  await Promise.race([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 8000 }).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, config.loginSuccess.settleWaitMs))
  ]);

  if (config.loginSuccess.errorSelector) {
    const errorPresent = await page.$(config.loginSuccess.errorSelector);
    if (errorPresent) {
      const errorText = await page.$eval(
        config.loginSuccess.errorSelector,
        (el) => (el.textContent || "").trim()
      );
      throw new Error(`Login failed with page error: ${errorText || "unknown error message"}`);
    }
  }

  const loginFieldsStillVisible = await Promise.all([
    isVisible(page, config.selectors.username),
    isVisible(page, config.selectors.password)
  ]);

  if (loginFieldsStillVisible.some(Boolean)) {
    logger.warn("Login form is still visible after submit", {
      usernameVisible: loginFieldsStillVisible[0],
      passwordVisible: loginFieldsStillVisible[1],
      currentUrl: page.url()
    });
    throw new Error("Login appears to have failed (still on login form)");
  }

  return true;
}

async function runLoginWorkflow(config, logger) {
  const runId = buildRunId();
  let browser;

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
    page.setDefaultTimeout(config.browser.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);

    await page.goto(config.appUrl, {
      waitUntil: "networkidle2",
      timeout: config.browser.navigationTimeoutMs
    });

    logger.info("Loaded login page", { url: page.url() });

    // Fill sequentially to avoid focus/typing race conditions on the same page.
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

      const captchaElement = await page.$(config.selectors.captchaImage);
      if (!captchaElement) {
        throw new Error("CAPTCHA image element was not found");
      }

      const imageBuffer = await captchaElement.screenshot({ encoding: "binary" });
      await ensureDirExists(config.runtime.screenshotDir);
      const captchaShot = path.join(config.runtime.screenshotDir, `${runId}-captcha.png`);
      await fs.writeFile(captchaShot, imageBuffer);
      logger.info("CAPTCHA image captured", { screenshot: captchaShot });
      const solvedCaptcha = await solveCaptcha(imageBuffer, config, logger);

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

    await page.waitForSelector(config.selectors.submit, { timeout: 10000, visible: true });
    await page.click(config.selectors.submit);
    logger.info("Submitted login form");

    await validateLoginSuccess(page, config, logger);
    const successShot = await capture(page, config, runId, "success");
    logger.info("Workflow completed successfully", { screenshot: successShot });
  } catch (error) {
    logger.error("Workflow failed", { error: error.message });
    if (browser) {
      try {
        const [page] = await browser.pages();
        if (page) {
          const failShot = await capture(page, config, runId, "failure");
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
