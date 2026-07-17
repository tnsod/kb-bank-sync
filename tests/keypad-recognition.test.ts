import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  extractButtonImages,
  loadTemplateVectors,
  pixelDistance,
  preprocessButtonImage,
  recognizeButtonImages,
  validateButtonRects,
  type KeypadRect,
  type ShuffledDigit,
} from "../src/bank/keypad-recognition.js";
import { createDigitSlotMap, passwordToSlotSequence } from "../src/bank/kb-keypad.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(testDirectory, "fixtures", "keypads");
const templateDirectory = path.resolve(testDirectory, "..", "assets", "keypad-templates");
const shuffledRects: readonly KeypadRect[] = [
  { left: 75, top: 100, width: 55, height: 55 },
  { left: 17, top: 158, width: 55, height: 55 },
  { left: 75, top: 158, width: 55, height: 55 },
  { left: 133, top: 158, width: 55, height: 55 },
  { left: 75, top: 216, width: 55, height: 55 },
];
const expectedLayouts: readonly ShuffledDigit[][] = [
  ["0", "8", "5", "9", "7"],
  ["9", "0", "5", "7", "8"],
  ["8", "0", "7", "9", "5"],
  ["0", "5", "7", "8", "9"],
  ["0", "7", "8", "9", "5"],
  ["8", "9", "5", "7", "0"],
  ["8", "0", "7", "9", "5"],
  ["5", "9", "7", "8", "0"],
  ["5", "9", "7", "8", "0"],
  ["5", "8", "7", "9", "0"],
];

async function fixtureButtons(index: number): Promise<Buffer[]> {
  const image = await readFile(path.join(fixtureDirectory, `session-${index}.png`));
  return extractButtonImages(image, shuffledRects);
}

describe("keypad image recognition", () => {
  it("recognizes every shuffled digit template", async () => {
    const templates = await loadTemplateVectors(templateDirectory);
    const buttons = await fixtureButtons(0);
    const expected = expectedLayouts[0]!;
    for (let index = 0; index < buttons.length; index += 1) {
      const digit = expected[index]!;
      const candidate = await preprocessButtonImage(buttons[index]!);
      expect(pixelDistance(candidate, templates[digit][0]!)).toBe(0);
    }
  });

  it.each(expectedLayouts.map((layout, index) => [index, layout] as const))(
    "recognizes Docker headless sample %i as a global permutation",
    async (index, expected) => {
      const result = await recognizeButtonImages(await fixtureButtons(index), templateDirectory);
      expect(result.digitsBySlot).toEqual(expected);
      expect(new Set(result.digitsBySlot).size).toBe(5);
    },
  );

  it("distinguishes visually similar 5 and 9 glyphs", async () => {
    const templates = await loadTemplateVectors(templateDirectory);
    const buttons = await fixtureButtons(7);
    const five = await preprocessButtonImage(buttons[0]!);
    const nine = await preprocessButtonImage(buttons[1]!);
    expect(pixelDistance(five, templates["5"][0]!)).toBeLessThan(pixelDistance(five, templates["9"][0]!));
    expect(pixelDistance(nine, templates["9"][0]!)).toBeLessThan(pixelDistance(nine, templates["5"][0]!));
  });

  it("rejects duplicate glyphs instead of assigning a digit more than once", async () => {
    const buttons = await fixtureButtons(0);
    await expect(recognizeButtonImages(Array.from({ length: 5 }, () => buttons[2]!), templateDirectory)).rejects.toThrow();
  });

  it("stops when image confidence is insufficient", async () => {
    const blank = await sharp({ create: { width: 55, height: 55, channels: 3, background: "#ffcc00" } }).png().toBuffer();
    await expect(recognizeButtonImages(Array.from({ length: 5 }, () => blank), templateDirectory)).rejects.toThrow();
  });

  it("stops when a button size changes", () => {
    const validRects = Array.from({ length: 12 }, (_, index) => ({ left: index * 60, top: 0, width: 55, height: 55 }));
    expect(() => validateButtonRects(validRects.map((rect, index) => index === 4 ? { ...rect, width: 61 } : rect))).toThrow();
  });

  it("combines fixed and shuffled digits in password order", () => {
    const map = createDigitSlotMap(expectedLayouts[0]!);
    expect(passwordToSlotSequence("160578", map)).toEqual([0, 5, 4, 7, 10, 6]);
  });
});
