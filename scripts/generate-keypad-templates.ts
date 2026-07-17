import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  extractButtonImages,
  NORMALIZED_GLYPH_SIZE,
  preprocessButtonImage,
  SHUFFLED_DIGITS,
  type KeypadRect,
  type ShuffledDigit,
} from "../src/bank/keypad-recognition.js";

const SHUFFLED_RECTS: readonly KeypadRect[] = [
  { left: 75, top: 100, width: 55, height: 55 },
  { left: 17, top: 158, width: 55, height: 55 },
  { left: 75, top: 158, width: 55, height: 55 },
  { left: 133, top: 158, width: 55, height: 55 },
  { left: 75, top: 216, width: 55, height: 55 },
];

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined || value === "") throw new Error(`Missing ${prefix}<value>`);
  return value;
}

const source = argument("source");
const layout = argument("layout").split(",") as ShuffledDigit[];
if (layout.length !== SHUFFLED_DIGITS.length || new Set(layout).size !== SHUFFLED_DIGITS.length ||
  layout.some((digit) => !SHUFFLED_DIGITS.includes(digit))) {
  throw new Error("Layout must be a permutation of 0,5,7,8,9");
}

const outputDirectory = path.resolve("assets", "keypad-templates");
const buttons = await extractButtonImages(await readFile(source), SHUFFLED_RECTS);
await Promise.all(buttons.map(async (button, index) => {
  const digit = layout[index];
  if (digit === undefined) throw new Error("Missing digit for template slot");
  const pixels = await preprocessButtonImage(button);
  await sharp(Buffer.from(pixels), {
    raw: { width: NORMALIZED_GLYPH_SIZE.width, height: NORMALIZED_GLYPH_SIZE.height, channels: 1 },
  }).png().toFile(path.join(outputDirectory, `${digit}.png`));
}));
