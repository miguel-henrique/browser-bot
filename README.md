# Browser Bot

Scheduled Node.js browser automation using Puppeteer (Chromium), with optional CAPTCHA solving and retry logic.

## Features

- Runs automatically at `07:00`, `12:00`, `13:00`, and `16:00` (BRT / `America/Sao_Paulo`).
- Uses environment variables for credentials, URL, selectors, and integration settings.
- Supports pluggable CAPTCHA solving:
  - OCR (`tesseract.js`)
  - External API provider
- Includes:
  - structured logging
  - retries for transient failures
  - success/failure screenshots
  - timeout handling and graceful browser shutdown

## Requirements

- Node.js `>=18`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your env file:

```bash
cp .env.example .env
```

3. Edit `.env` with your real values.

> Sensitive values such as `LOGIN_USER`, `LOGIN_PASSWORD`, and API keys must stay in `.env` and never be hardcoded.
> If a value contains `#` (such as CSS selectors like `input#j_username`), wrap it in double quotes in `.env`.

## Run

- Run scheduler mode (keeps process alive and runs on cron schedule):

```bash
npm start
```

- Run one immediate test execution:

```bash
npm run run:once
```

## Schedule and Timezone

- Cron expression: `0 7,12,13,16 * * *`
- Timezone: configurable via `TIMEZONE` (default: `America/Sao_Paulo`)

## CAPTCHA Notes

- Use `ENABLE_CAPTCHA=true|false` to toggle CAPTCHA handling.
- Choose provider using `CAPTCHA_PROVIDER=ocr|api`.
- External API solving should only be enabled in approved/legal environments.
- OCR tuning options:
  - `OCR_EXPECTED_LENGTH` (default `4`)
  - `OCR_MIN_LENGTH` (default `3`)
  - `OCR_MAX_ATTEMPTS` (default `10`)

## Login Success Detection

Configure one or more of:

- `LOGIN_SUCCESS_URL_CONTAINS`
- `LOGIN_SUCCESS_SELECTOR`
- `LOGIN_SUCCESS_TEXT`

If none is configured, the script uses navigation completion as fallback.
You can also configure `LOGIN_ERROR_SELECTOR` and `LOGIN_SETTLE_WAIT_MS` to improve failure detection after submit.

## Debug Logging

- Set `DEBUG_LOG_VALUES=true` to print selector/value diagnostics (username and CAPTCHA values) during runs.
- Password values are never logged directly (only length metadata).

## Artifacts

- Screenshots are saved in `SCREENSHOT_DIR` (default: `./artifacts/screenshots`).
