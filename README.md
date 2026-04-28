# Browser Bot

Scheduled Node.js browser automation using Puppeteer (Chromium), with OCR CAPTCHA solving and fallback options.

## Features

- Weekday scheduler with `.env`-defined times (`SCHEDULE_TIMES`) in your timezone.
- Manual skip dates via `.env` (`SKIP_DATES`) for holidays, leave, or custom off days.
- CAPTCHA flow:
  - OCR first
  - optional Telegram fallback (send captcha image to your phone, reply with code)
  - optional terminal manual fallback
- Conservative defaults to reduce lockout risk:
  - `MAX_RUN_ATTEMPTS=1`
  - `CAPTCHA_SUBMIT_MAX_ATTEMPTS=1`
- Structured logs and screenshot artifacts for debugging.

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
> If a value contains `#` (including passwords, tokens, or selectors like `input#j_username`), wrap it in double quotes in `.env`.

## Run

- Run scheduler mode (keeps process alive and runs on cron schedule):

```bash
npm start
```

- Run one immediate test execution:

```bash
npm run run:once
```

## Stop / Inspect

- Stop foreground run: `Ctrl+C`
- Run in background:

```bash
nohup npm start > bot.log 2>&1 &
echo $! > bot.pid
```

- Check process:

```bash
ps -fp "$(cat bot.pid)"
```

- Tail logs:

```bash
tail -f bot.log
```

- Stop background process:

```bash
kill "$(cat bot.pid)"
```

## Schedule and Timezone

- Weekdays only (Mon-Fri), times from `.env`:
  - `SCHEDULE_TIMES=07:00,11:25,12:25,16:00`
- Timezone from `.env`:
  - `TIMEZONE=America/Sao_Paulo`
- Skip dates from `.env`:
  - `SKIP_DATES=01/05/2026,07/09/2026`

## CAPTCHA Notes

- Use `ENABLE_CAPTCHA=true|false` to toggle CAPTCHA handling.
- Choose provider using `CAPTCHA_PROVIDER=ocr|api|manual`.
- If OCR fails and `TELEGRAM_FALLBACK_ENABLED=true`, bot sends the captcha image to Telegram and waits for your reply.
- If OCR returns a wrong code and the site rejects it, Telegram rescue is also attempted on the final captcha attempt.
- Optional safety valve: set `CAPTCHA_MANUAL_FALLBACK=true` to prompt in terminal when OCR fails and Telegram fallback is off.
- `CAPTCHA_SUBMIT_MAX_ATTEMPTS` controls retries inside one login run (recommended: `1` to avoid LDAP lockouts).
- External API solving should only be enabled in approved/legal environments.
- OCR options:
  - `OCR_EXPECTED_LENGTH` (default `4`)
  - `OCR_MIN_LENGTH` (default `3`)
  - `OCR_MAX_ATTEMPTS` (default `10`)

### Telegram Fallback Setup (free + mobile-friendly)

1. In Telegram, create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Start a chat with your bot and send any message.
3. Get your chat id:

```bash
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
```

4. Set in `.env`:

```env
TELEGRAM_FALLBACK_ENABLED=true
TELEGRAM_BOT_TOKEN=<YOUR_TOKEN>
TELEGRAM_CHAT_ID=<YOUR_CHAT_ID>
```

When OCR fails, you receive the captcha image in Telegram. Reply with the 4-digit code; the automation uses your reply.

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

## Running Location: PC vs Server

- **Your PC**
  - Pros: simplest, zero extra cloud cost.
  - Cons: computer must remain on, connected, and not sleeping.
- **Server/VPS**
  - Pros: always-on reliability, better for strict schedules.
  - Cons: monthly cost, setup/ops responsibility.

### Practical recommendation

- Start on your PC while tuning captcha behavior.
- After stability is good, move to a low-cost Linux VPS (1 vCPU / 1 GB RAM is enough) and run with `pm2` or systemd.
