const { createWorker } = require("tesseract.js");
const sharp = require("sharp");

function normalizeOcrText(text, numericOnly) {
  const cleaned = String(text || "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();

  if (!numericOnly) {
    return cleaned;
  }

  // Common OCR confusions for captcha-like fonts.
  return cleaned
    .replace(/[OQD]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/Z/g, "2")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/\D/g, "");
}

function scoreCandidate(value, expectedLength) {
  if (!value) {
    return -1;
  }
  const lengthPenalty = Math.abs(value.length - expectedLength);
  return 100 - lengthPenalty * 10;
}

async function buildImageVariants(imageBuffer) {
  const base = sharp(imageBuffer).grayscale().normalize();
  const metadata = await base.metadata();
  const targetWidth = Math.max(560, (metadata.width || 280) * 2);

  const variants = [];
  variants.push({ name: "raw", buffer: imageBuffer });
  variants.push({
    name: "normalized",
    buffer: await base.resize({ width: targetWidth }).png().toBuffer()
  });
  variants.push({
    name: "threshold-150",
    buffer: await base
      .resize({ width: targetWidth })
      .threshold(150)
      .png()
      .toBuffer()
  });
  variants.push({
    name: "threshold-175",
    buffer: await base
      .resize({ width: targetWidth })
      .threshold(175)
      .png()
      .toBuffer()
  });
  variants.push({
    name: "blur-threshold",
    buffer: await base
      .resize({ width: targetWidth })
      .blur(0.6)
      .threshold(165)
      .png()
      .toBuffer()
  });

  return variants;
}

async function splitIntoFourDigitSlices(imageBuffer) {
  const prepared = sharp(imageBuffer).grayscale().normalize();
  const { data, info } = await prepared
    .resize({ width: 560 })
    .threshold(165)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const colInk = new Array(width).fill(0);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = data[y * width + x];
      if (pixel < 128) {
        colInk[x] += 1;
      }
    }
  }

  const nonEmptyCols = colInk
    .map((value, idx) => ({ value, idx }))
    .filter((item) => item.value > 1)
    .map((item) => item.idx);

  const contentLeft = nonEmptyCols.length ? nonEmptyCols[0] : 0;
  const contentRight = nonEmptyCols.length ? nonEmptyCols[nonEmptyCols.length - 1] : width - 1;
  const contentWidth = Math.max(1, contentRight - contentLeft + 1);
  const digitBandWidth = Math.floor(contentWidth / 4);
  const overlap = Math.max(6, Math.floor(digitBandWidth * 0.12));

  const slices = [];
  for (let i = 0; i < 4; i += 1) {
    const left = Math.max(0, contentLeft + i * digitBandWidth - overlap);
    const nominalRight =
      i === 3 ? contentRight : contentLeft + (i + 1) * digitBandWidth - 1 + overlap;
    const right = Math.min(width - 1, nominalRight);
    const sliceWidth = Math.max(1, right - left + 1);

    const buffer = await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .resize({ width: 560 })
      .extract({ left, top: 0, width: sliceWidth, height })
      .threshold(165)
      .png()
      .toBuffer();

    slices.push({ index: i, left, right, buffer });
  }

  return slices;
}

async function solveBySegmentingDigits(imageBuffer, worker, config, logger) {
  const slices = await splitIntoFourDigitSlices(imageBuffer);
  const digitPsmModes = [10, 13, 8];
  let solved = "";

  for (const slice of slices) {
    let bestDigit = "";
    for (const psm of digitPsmModes) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const {
        data: { text }
      } = await worker.recognize(slice.buffer);
      const normalized = normalizeOcrText(text, config.captcha.ocrNumericOnly);
      const singleDigit = normalized[0] || "";

      logger.info("OCR segmented digit attempt", {
        digitIndex: slice.index,
        psm,
        rawText: String(text || "").trim(),
        normalized
      });

      if (/^\d$/.test(singleDigit)) {
        bestDigit = singleDigit;
        break;
      }
    }

    solved += bestDigit;
  }

  if (solved.length !== 4 || !/^\d{4}$/.test(solved)) {
    throw new Error("Segmented OCR could not extract exactly 4 digits");
  }

  logger.info("CAPTCHA solved with segmented OCR", { solved });
  return solved;
}

async function solveCaptchaWithOCR(imageBuffer, config, logger) {
  const worker = await createWorker(config.captcha.ocrLanguage);

  try {
    if (config.captcha.ocrNumericOnly) {
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789",
        classify_bln_numeric_mode: 1
      });
    }

    const psmModes = [8, 7, 13, 11, 6];
    const attempts = Math.max(1, config.captcha.ocrMaxAttempts);
    const imageVariants = await buildImageVariants(imageBuffer);
    let bestCandidate = "";
    let bestScore = -1;
    const candidates = [];

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const psm = psmModes[(attempt - 1) % psmModes.length];
      const variant = imageVariants[(attempt - 1) % imageVariants.length];
      await worker.setParameters({ tessedit_pageseg_mode: psm });

      const {
        data: { text }
      } = await worker.recognize(variant.buffer);

      const normalized = normalizeOcrText(text, config.captcha.ocrNumericOnly);
      const score = scoreCandidate(normalized, config.captcha.ocrExpectedLength);
      const candidate = {
        attempt,
        psm,
        variant: variant.name,
        rawText: String(text || "").trim(),
        normalized,
        score
      };
      candidates.push(candidate);

      logger.info("OCR attempt finished", {
        attempt,
        psm,
        variant: variant.name,
        rawText: String(text || "").trim(),
        normalized,
        score
      });

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = normalized;
      }

      if (normalized.length >= config.captcha.ocrExpectedLength) {
        break;
      }
    }

    const exactLengthCandidate = candidates
      .filter((item) => item.normalized.length === config.captcha.ocrExpectedLength)
      .sort((a, b) => b.score - a.score)[0];
    if (exactLengthCandidate) {
      bestCandidate = exactLengthCandidate.normalized;
      bestScore = exactLengthCandidate.score;
    }

    const hasExactLength = bestCandidate.length === config.captcha.ocrExpectedLength;
    if (!bestCandidate || bestCandidate.length < config.captcha.ocrMinLength || !hasExactLength) {
      try {
        const segmentedValue = await solveBySegmentingDigits(
          imageBuffer,
          worker,
          config,
          logger
        );
        return segmentedValue;
      } catch (segmentationError) {
        logger.warn("Segmented OCR fallback failed", {
          error: segmentationError.message
        });
        throw new Error(
          `OCR result invalid (expectedLength=${config.captcha.ocrExpectedLength}, minLength=${config.captcha.ocrMinLength})`
        );
      }
    }

    logger.info("CAPTCHA solved with OCR", {
      valueLength: bestCandidate.length,
      score: bestScore
    });
    return bestCandidate;
  } finally {
    await worker.terminate();
  }
}

module.exports = { solveCaptchaWithOCR };
