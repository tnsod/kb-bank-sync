import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { KeypadRecognitionError } from "./kb-errors.js";

export const SHUFFLED_DIGITS = ["0", "5", "7", "8", "9"] as const;
export type ShuffledDigit = (typeof SHUFFLED_DIGITS)[number];

export interface KeypadRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RecognitionThresholds {
  maximumAverageDistance: number;
  minimumPermutationGap: number;
}

export interface RecognitionResult {
  digitsBySlot: ShuffledDigit[];
  bestScore: number;
  secondBestScore: number;
  scoreGap: number;
}

export type TemplateVectors = Record<ShuffledDigit, Uint8Array[]>;

export const NORMALIZED_GLYPH_SIZE = { width: 24, height: 36 } as const;
export const BUTTON_SIZE_RANGE = { minimum: 50, maximum: 60 } as const;
export const DEFAULT_RECOGNITION_THRESHOLDS: RecognitionThresholds = {
  maximumAverageDistance: 0.12,
  minimumPermutationGap: 0.025,
};

function assertButtonDimensions(width: number, height: number): void {
  if (
    width < BUTTON_SIZE_RANGE.minimum ||
    width > BUTTON_SIZE_RANGE.maximum ||
    height < BUTTON_SIZE_RANGE.minimum ||
    height > BUTTON_SIZE_RANGE.maximum
  ) {
    throw new KeypadRecognitionError("키패드 숫자 버튼 크기가 검증된 범위를 벗어났습니다");
  }
}

export function validateButtonRects(rects: readonly KeypadRect[]): void {
  if (rects.length !== 12) {
    throw new KeypadRecognitionError("숫자 그리드의 버튼 슬롯 수가 12개가 아닙니다");
  }
  for (const rect of rects) assertButtonDimensions(rect.width, rect.height);
}

export async function preprocessButtonImage(input: Buffer): Promise<Uint8Array> {
  const metadata = await sharp(input).metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new KeypadRecognitionError("키패드 버튼 이미지 크기를 읽지 못했습니다");
  }
  assertButtonDimensions(metadata.width, metadata.height);

  const horizontalInset = 8;
  const verticalInset = 5;
  const { data, info } = await sharp(input)
    .extract({
      left: horizontalInset,
      top: verticalInset,
      width: metadata.width - horizontalInset * 2,
      height: metadata.height - verticalInset * 2,
    })
    .grayscale()
    .threshold(175)
    .trim({ background: "#ffffff" })
    .resize(NORMALIZED_GLYPH_SIZE.width, NORMALIZED_GLYPH_SIZE.height, {
      fit: "contain",
      background: "#ffffff",
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== NORMALIZED_GLYPH_SIZE.width || info.height !== NORMALIZED_GLYPH_SIZE.height) {
    throw new KeypadRecognitionError("키패드 숫자 이미지 정규화 크기가 올바르지 않습니다");
  }
  return new Uint8Array(data);
}

export async function readNormalizedTemplate(input: Buffer): Promise<Uint8Array> {
  const { data, info } = await sharp(input)
    .grayscale()
    .resize(NORMALIZED_GLYPH_SIZE.width, NORMALIZED_GLYPH_SIZE.height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== NORMALIZED_GLYPH_SIZE.width || info.height !== NORMALIZED_GLYPH_SIZE.height) {
    throw new KeypadRecognitionError("키패드 템플릿 크기가 올바르지 않습니다");
  }
  return new Uint8Array(data);
}

export async function loadTemplateVectors(templateDirectory: string): Promise<TemplateVectors> {
  const entries = await Promise.all(SHUFFLED_DIGITS.map(async (digit) => {
    const contents = await readFile(path.join(templateDirectory, `${digit}.png`));
    return { digit, vectors: [await readNormalizedTemplate(contents)] };
  }));
  const vectorsFor = (digit: ShuffledDigit): Uint8Array[] => {
    const entry = entries.find((candidate) => candidate.digit === digit);
    if (entry === undefined) throw new KeypadRecognitionError("필수 키패드 템플릿을 찾지 못했습니다");
    return entry.vectors;
  };
  return {
    "0": vectorsFor("0"),
    "5": vectorsFor("5"),
    "7": vectorsFor("7"),
    "8": vectorsFor("8"),
    "9": vectorsFor("9"),
  };
}

export function pixelDistance(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length || left.length === 0) {
    throw new KeypadRecognitionError("비교할 키패드 이미지 벡터 크기가 일치하지 않습니다");
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return difference / (left.length * 255);
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  const result: T[][] = [];
  values.forEach((value, index) => {
    const remainder = values.filter((_, candidateIndex) => candidateIndex !== index);
    for (const suffix of permutations(remainder)) result.push([value, ...suffix]);
  });
  return result;
}

export function recognizePermutation(
  slots: readonly Uint8Array[],
  templates: TemplateVectors,
  thresholds: RecognitionThresholds = DEFAULT_RECOGNITION_THRESHOLDS,
): RecognitionResult {
  if (slots.length !== SHUFFLED_DIGITS.length) {
    throw new KeypadRecognitionError("셔플 숫자 슬롯이 정확히 다섯 개가 아닙니다");
  }

  const distanceMatrix = slots.map((slot) => Object.fromEntries(SHUFFLED_DIGITS.map((digit) => {
    const candidates = templates[digit];
    if (candidates.length === 0) throw new KeypadRecognitionError("키패드 숫자 템플릿이 비어 있습니다");
    return [digit, Math.min(...candidates.map((template) => pixelDistance(slot, template)))] as const;
  })) as Record<ShuffledDigit, number>);

  const ranked = permutations(SHUFFLED_DIGITS)
    .map((digitsBySlot) => ({
      digitsBySlot,
      score: digitsBySlot.reduce((sum, digit, slotIndex) => sum + (distanceMatrix[slotIndex]?.[digit] ?? Infinity), 0),
    }))
    .sort((left, right) => left.score - right.score);
  const best = ranked[0];
  const second = ranked[1];
  if (best === undefined || second === undefined) {
    throw new KeypadRecognitionError("키패드 숫자 순열을 계산하지 못했습니다");
  }
  const averageDistance = best.score / SHUFFLED_DIGITS.length;
  const scoreGap = second.score - best.score;
  if (averageDistance > thresholds.maximumAverageDistance) {
    throw new KeypadRecognitionError("키패드 숫자 인식 오차가 허용 기준을 초과했습니다");
  }
  if (scoreGap < thresholds.minimumPermutationGap) {
    throw new KeypadRecognitionError("키패드 숫자 인식의 최적 조합과 차선 조합을 충분히 구분하지 못했습니다");
  }
  if (new Set(best.digitsBySlot).size !== SHUFFLED_DIGITS.length) {
    throw new KeypadRecognitionError("셔플 숫자가 정확히 한 번씩 배정되지 않았습니다");
  }
  return {
    digitsBySlot: best.digitsBySlot,
    bestScore: best.score,
    secondBestScore: second.score,
    scoreGap,
  };
}

export async function extractButtonImages(keypadImage: Buffer, rects: readonly KeypadRect[]): Promise<Buffer[]> {
  return Promise.all(rects.map((rect) => sharp(keypadImage).extract(rect).png().toBuffer()));
}

export async function recognizeButtonImages(
  buttonImages: readonly Buffer[],
  templateDirectory: string,
  thresholds: RecognitionThresholds = DEFAULT_RECOGNITION_THRESHOLDS,
): Promise<RecognitionResult> {
  if (buttonImages.length !== SHUFFLED_DIGITS.length) {
    throw new KeypadRecognitionError("셔플 숫자 슬롯이 정확히 다섯 개가 아닙니다");
  }
  const [slots, templates] = await Promise.all([
    Promise.all(buttonImages.map(preprocessButtonImage)),
    loadTemplateVectors(templateDirectory),
  ]);
  return recognizePermutation(slots, templates, thresholds);
}
