const { createWorker } = require("tesseract.js");
const sharp = require("sharp");

const UPSCALE_WIDTH = 1200;

function normalizeOcrText(text, numericOnly) {
  const cleaned = String(text || "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();

  if (!numericOnly) {
    return cleaned;
  }

  return cleaned
    .replace(/[OQD]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/Z/g, "2")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/\D/g, "");
}

async function paddedSource(imageBuffer) {
  return sharp(imageBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .extend({
      top: 40,
      bottom: 40,
      left: 64,
      right: 64,
      background: { r: 255, g: 255, b: 255 }
    })
    .png()
    .toBuffer();
}

async function recognizeWhole(worker, buffer, label, logger) {
  await worker.setParameters({
    tessedit_pageseg_mode: "8",
    tessedit_char_whitelist: "0123456789",
    classify_bln_numeric_mode: 1,
    user_defined_dpi: "300"
  });

  const {
    data: { text, confidence }
  } = await worker.recognize(buffer);

  const digits = normalizeOcrText(text, true);
  const conf = typeof confidence === "number" ? confidence : 0;

  logger.info("OCR whole image", {
    variant: label,
    rawText: String(text || "").trim(),
    digits,
    confidence: conf
  });

  return { label, digits, confidence: conf };
}

function pickFourDigits(reads, expectedLen) {
  const priority = [
    "bin160",
    "bin162",
    "bin165",
    "bin158",
    "bin168",
    "bin172",
    "gray"
  ];

  const exact = reads.filter((r) => r.digits.length === expectedLen);
  if (exact.length) {
    exact.sort((a, b) => {
      const pa = priority.indexOf(a.label);
      const pb = priority.indexOf(b.label);
      const ra = pa === -1 ? 999 : pa;
      const rb = pb === -1 ? 999 : pb;
      if (ra !== rb) {
        return ra - rb;
      }
      return b.confidence - a.confidence;
    });
    return exact[0].digits;
  }

  const long = reads.filter((r) => r.digits.length > expectedLen);
  if (long.length) {
    long.sort((a, b) => {
      const pa = priority.indexOf(a.label);
      const pb = priority.indexOf(b.label);
      const ra = pa === -1 ? 999 : pa;
      const rb = pb === -1 ? 999 : pb;
      if (ra !== rb) {
        return ra - rb;
      }
      return b.confidence - a.confidence;
    });
    return long[0].digits.slice(0, expectedLen);
  }

  return null;
}

async function recognizeBand(worker, sliceBuf, logger, band, tag) {
  let best = { digit: "", confidence: -1 };

  for (const psm of ["10", "8"]) {
    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      tessedit_char_whitelist: "0123456789",
      user_defined_dpi: "300"
    });
    const {
      data: { text, confidence }
    } = await worker.recognize(sliceBuf);
    const normalized = normalizeOcrText(text, true).replace(/\D/g, "");
    const ch = normalized.slice(0, 1) || "";
    const conf = typeof confidence === "number" ? confidence : 0;

    logger.info("OCR band", {
      band,
      tag,
      psm,
      rawText: String(text || "").trim(),
      digit: ch,
      confidence: conf
    });

    if (ch && conf >= best.confidence) {
      best = { digit: ch, confidence: conf };
    }
  }

  return best;
}

async function overlapFourBandsDetailed(worker, basePng, threshold, logger) {
  const bin = await sharp(basePng)
    .grayscale()
    .normalize()
    .resize({ width: UPSCALE_WIDTH })
    .median(3)
    .threshold(threshold)
    .png()
    .toBuffer();

  const { width, height } = await sharp(bin).metadata();
  const seg = width / 4;
  const overlap = Math.max(12, Math.floor(seg * 0.3));

  const tag = `bands-${threshold}`;
  const cells = [];

  for (let i = 0; i < 4; i += 1) {
    const lo = Math.floor(i * seg);
    const hi = Math.floor((i + 1) * seg) - 1;
    const left = Math.max(0, lo - overlap);
    const right = Math.min(width - 1, hi + overlap);
    const sliceW = Math.max(1, right - left + 1);

    const sliceBuf = await sharp(bin)
      .extract({ left, top: 0, width: sliceW, height })
      .resize({
        height: 160,
        kernel: sharp.kernel.lanczos3,
        fit: "inside",
        withoutEnlargement: false
      })
      .extend({
        top: 14,
        bottom: 14,
        left: 14,
        right: 14,
        background: { r: 255, g: 255, b: 255 }
      })
      .png()
      .toBuffer();

    cells.push(await recognizeBand(worker, sliceBuf, logger, i, tag));
  }

  return cells;
}

function mergeBandCells(perThresholdCells) {
  const merged = [
    { digit: "", confidence: -1 },
    { digit: "", confidence: -1 },
    { digit: "", confidence: -1 },
    { digit: "", confidence: -1 }
  ];

  for (const cells of perThresholdCells) {
    for (let i = 0; i < 4; i += 1) {
      const { digit, confidence } = cells[i];
      if (digit && confidence >= merged[i].confidence) {
        merged[i] = { digit, confidence };
      }
    }
  }

  return merged.map((x) => x.digit).join("");
}

async function bandsFirstCompleteString(worker, basePng, logger) {
  for (const th of [162, 165, 160, 158, 156, 168, 172]) {
    const cells = await overlapFourBandsDetailed(worker, basePng, th, logger);
    const s = cells.map((c) => c.digit).join("");
    if (s.length === 4 && /^\d{4}$/.test(s)) {
      return s;
    }
  }

  return null;
}

async function solveCaptchaWithOCR(imageBuffer, config, logger) {
  const expectedLen = config.captcha.ocrExpectedLength;
  const worker = await createWorker(config.captcha.ocrLanguage);

  try {
    const base = await paddedSource(imageBuffer);

    const gray = await sharp(base)
      .grayscale()
      .normalize()
      .resize({ width: UPSCALE_WIDTH })
      .png()
      .toBuffer();

    const mkBin = (t) =>
      sharp(base)
        .grayscale()
        .normalize()
        .resize({ width: UPSCALE_WIDTH })
        .median(3)
        .threshold(t)
        .png()
        .toBuffer();

    const reads = [];
    reads.push(await recognizeWhole(worker, gray, "gray", logger));
    reads.push(await recognizeWhole(worker, await mkBin(158), "bin158", logger));
    reads.push(await recognizeWhole(worker, await mkBin(160), "bin160", logger));
    reads.push(await recognizeWhole(worker, await mkBin(162), "bin162", logger));
    reads.push(await recognizeWhole(worker, await mkBin(165), "bin165", logger));
    reads.push(await recognizeWhole(worker, await mkBin(168), "bin168", logger));
    reads.push(await recognizeWhole(worker, await mkBin(172), "bin172", logger));

    let code = pickFourDigits(reads, expectedLen);

    if (!code || code.length !== expectedLen) {
      logger.info("Whole-image OCR inconclusive; overlapping bands");

      code = await bandsFirstCompleteString(worker, base, logger);

      if (!code) {
        const bandRuns = [];
        for (const th of [156, 160, 162, 165, 168, 172]) {
          bandRuns.push(await overlapFourBandsDetailed(worker, base, th, logger));
        }

        code = mergeBandCells(bandRuns);
      }

      if (code.length !== expectedLen || !/^\d{4}$/.test(code)) {
        throw new Error(
          `OCR could not read ${expectedLen} digits (got "${code}")`
        );
      }
    }

    logger.info("CAPTCHA OCR result", { code });
    return code;
  } finally {
    await worker.terminate();
  }
}

module.exports = { solveCaptchaWithOCR };
