import {
  QuantizerCelebi,
  Score,
  Hct,
  argbFromRgb,
  hexFromArgb,
} from "@material/material-color-utilities";

const SAMPLE_SIZE = 128;
const MAX_COLORS = 128;
const gradientCache = new Map();

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image load failed"));
    image.src = src;
  });
}

function readSampledImageData(src) {
  return loadImage(src).then((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not get canvas context");
    }
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  });
}

function argbPixelsFromImageData(imageData) {
  const pixels = [];
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 255) continue;
    pixels.push(argbFromRgb(data[i], data[i + 1], data[i + 2]));
  }
  return pixels;
}

function splitTopBottomPixels(imageData) {
  const { width, height, data } = imageData;
  const midpoint = Math.floor(height / 2);
  const top = [];
  const bottom = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] < 255) continue;
      const argb = argbFromRgb(data[index], data[index + 1], data[index + 2]);
      if (y < midpoint) {
        top.push(argb);
      } else {
        bottom.push(argb);
      }
    }
  }
  return { top, bottom };
}

function scoreBestColor(pixels, fallbackArgb) {
  if (!pixels.length) return fallbackArgb;
  const quantizerResult = QuantizerCelebi.quantize(pixels, MAX_COLORS);
  const ranked = Score.score(quantizerResult, {
    desired: 1,
    fallbackColorARGB: fallbackArgb,
    filter: true,
  });
  return ranked[0] ?? fallbackArgb;
}

function enhanceGradientColor(argb) {
  const hct = Hct.fromInt(argb);
  const chroma = Math.min(hct.chroma * 1.35 + 8, 56);
  const tone = Math.max(18, Math.min(hct.tone * 0.72, 38));
  return Hct.from(hct.hue, chroma, tone).toInt();
}

function argbToCssHex(argb) {
  return hexFromArgb(argb | 0xff000000);
}

export async function extractTwoToneGradientFromImage(src) {
  if (!src) return null;
  if (gradientCache.has(src)) {
    return gradientCache.get(src);
  }

  const request = readSampledImageData(src)
    .then((imageData) => {
      const { top, bottom } = splitTopBottomPixels(imageData);
      const allPixels = argbPixelsFromImageData(imageData);
      const fallback = scoreBestColor(allPixels, 0xff121212);
      const topArgb = enhanceGradientColor(scoreBestColor(top, fallback));
      const bottomArgb = enhanceGradientColor(
        scoreBestColor(bottom, topArgb || fallback),
      );
      return {
        top: argbToCssHex(topArgb),
        bottom: argbToCssHex(bottomArgb),
      };
    })
    .catch(() => null);

  gradientCache.set(src, request);
  const result = await request;
  if (!result) {
    gradientCache.delete(src);
  }
  return result;
}
