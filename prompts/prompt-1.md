You are a senior automation engineer.

Develop a Node.js automation script using Puppeteer (with Chromium) that performs a scheduled browser automation workflow.

GENERAL REQUIREMENTS
- Use Node.js + Puppeteer.
- Use environment variables for sensitive data (username, password, URLs, API keys).
- The script must run automatically at the following times (BRT – UTC-3):
  - 07:00
  - 12:00
  - 13:00
  - 16:00
- Implement scheduling using node-cron (or equivalent).
- Add robust logging, error handling, and retry logic.
- The code must be clean, modular, and well-documented.

AUTOMATION FLOW (Executed at each scheduled time)
1. Launch a Chromium browser instance (non-headless configurable).
2. Navigate to the target application URL (from environment variable).
3. Wait for the login page to load completely.
4. Check if the "username" and "password" input fields exist.
   - If they exist and are empty, fill:
     - Username from process.env.LOGIN_USER
     - Password from process.env.LOGIN_PASSWORD
   - If already filled, do not overwrite.
5. Detect when a CAPTCHA image appears.
6. Solve the CAPTCHA using ONE of the following approaches (make it pluggable/configurable):
   - OCR-based solution (e.g., Tesseract.js) for numeric CAPTCHA.
   - External CAPTCHA-solving API (only if legally permitted and configured via env vars).
7. Enter the CAPTCHA result into the appropriate input field.
8. Submit the login form.
9. Wait for confirmation that login succeeded (URL change, element presence, or status message).
10. Capture screenshots on success and on failure.
11. Close the browser gracefully.

IMPORTANT CONSTRAINTS
- Do NOT hardcode credentials or secrets.
- Assume CAPTCHA solving is allowed ONLY in approved/test environments.
- Make CAPTCHA handling optional via a configuration flag.
- Ensure the schedule respects BRT timezone explicitly (UTC-3).
- Handle timeouts, incorrect CAPTCHA, and transient failures gracefully.

DELIVERABLES
- Complete Node.js project structure.
- Package.json with required dependencies.
- Clear instructions in comments on how to configure environment variables.
- Example .env template (without real values).

Produce production-quality code following best practices.
