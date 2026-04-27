# Automated Login and CAPTCHA Handling Script

## Overview

This project is an automated browser-based script designed to access an internal web application, perform a login procedure, and handle CAPTCHA validation in a controlled and scheduled manner.  
It is intended for **authorized internal use**, such as operational automation, system availability checks, or repetitive access tasks in approved environments.

The application uses **Node.js with Puppeteer (Chromium)** to simulate real user interaction with the web interface and includes scheduling logic to execute the automation at predefined times throughout the day.

---

## Purpose

The main purpose of this application is to:

- Automate the access to a web-based system that requires authentication.
- Reduce manual effort for repetitive login tasks.
- Execute the process automatically at specific business times.
- Detect and handle CAPTCHA challenges using configurable methods.
- Provide traceability through logs and screenshots.

This solution is designed to be **modular, configurable, and secure**, following good automation and DevOps practices.

---

## Execution Schedule

The script is configured to run automatically at the following times, using the **Brazil Time Zone (BRT – UTC-3)**:

- **07:00**
- **12:00**
- **13:00**
- **16:00**

Scheduling is handled programmatically using a cron-based scheduler.

---

## How It Works

At each scheduled execution, the script performs the following steps:

1. Launches a Chromium browser instance using Puppeteer.
2. Navigates to the configured application URL.
3. Waits for the login page to fully load.
4. Verifies the presence of the username and password fields.
   - If the fields are empty, they are filled using values provided via environment variables.
   - If already filled, the script preserves the existing values.
5. Waits for the CAPTCHA image to appear.
6. Solves the CAPTCHA using a configurable approach:
   - OCR-based image recognition (for numeric CAPTCHAs), or
   - An external CAPTCHA-solving API (if enabled and authorized).
7. Enters the resolved CAPTCHA value into the form.
8. Submits the login request.
9. Validates whether login was successful (based on page behavior or elements).
10. Captures screenshots for success and failure scenarios.
11. Logs execution details and errors.
12. Closes the browser gracefully.

Each run is isolated and fault-tolerant, ensuring stability even in case of partial failures.

---

## Security and Configuration

- **No credentials, secrets, or URLs are hardcoded** in the source code.
- All sensitive data is provided via **environment variables**.
- CAPTCHA handling can be enabled or disabled via configuration flags.
- External CAPTCHA APIs are optional and must be configured explicitly.
- This project assumes compliance with organizational policies and legal restrictions regarding automation and CAPTCHA usage.

---

## Intended Use

✅ Approved internal automation  
✅ Test and homologation environments  
✅ Operational or monitoring workflows  

🚫 Not intended for unauthorized access  
🚫 Not intended to bypass security mechanisms without formal approval  

---

## Summary

This project provides a robust, scheduled, and configurable automation solution for authenticated web access, combining browser automation, scheduling, CAPTCHA handling, and operational logging into a single maintainable Node.js application.