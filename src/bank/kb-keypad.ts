import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "playwright";

import { KB_SELECTORS } from "../config/selectors.js";
import { KeypadError, KeypadRecognitionError } from "./kb-errors.js";
import {
  extractButtonImages,
  recognizeButtonImages,
  validateButtonRects,
  type KeypadRect,
  type ShuffledDigit,
} from "./keypad-recognition.js";

interface KeypadButton {
  locator: Locator;
  rect: KeypadRect;
}

const KEYPAD_LIMITS = {
  minimumWidth: 180,
  maximumWidth: 260,
  minimumHeight: 280,
  maximumHeight: 400,
  clickIntervalMs: 120,
} as const;

export const FIXED_DIGIT_SLOT_INDEXES = {
  "1": 0,
  "2": 1,
  "3": 2,
  "4": 3,
  "6": 5,
} as const;

export const SHUFFLED_SLOT_INDEXES = [4, 6, 7, 8, 10] as const;

const TEMPLATE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/keypad-templates",
);

export function parseAreaRect(coords: string | null): KeypadRect | null {
  if (coords === null) return null;
  const values = coords.split(",").map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  const [left, top, right, bottom] = values;
  if (left === undefined || top === undefined || right === undefined || bottom === undefined || right <= left || bottom <= top) {
    return null;
  }
  return { left, top, width: right - left, height: bottom - top };
}

function validateGridTopology(buttons: readonly KeypadButton[]): void {
  for (let row = 0; row < 4; row += 1) {
    const rowButtons = buttons.slice(row * 3, row * 3 + 3);
    if (rowButtons.length !== 3) throw new KeypadRecognitionError("키패드 숫자 그리드 행 구성이 올바르지 않습니다");
    const tops = rowButtons.map((button) => button.rect.top);
    if (Math.max(...tops) - Math.min(...tops) > 3) {
      throw new KeypadRecognitionError("키패드 버튼의 행 정렬이 예상 범위를 벗어났습니다");
    }
    if (!(rowButtons[0]!.rect.left < rowButtons[1]!.rect.left && rowButtons[1]!.rect.left < rowButtons[2]!.rect.left)) {
      throw new KeypadRecognitionError("키패드 버튼의 열 정렬이 올바르지 않습니다");
    }
  }
}

async function collectGridButtons(areas: Locator): Promise<KeypadButton[]> {
  const buttons: KeypadButton[] = [];
  for (let index = 0; index < await areas.count(); index += 1) {
    const locator = areas.nth(index);
    const rect = parseAreaRect(await locator.getAttribute("coords"));
    if (rect !== null && rect.width >= 50 && rect.width <= 60 && rect.height >= 50 && rect.height <= 60) {
      buttons.push({ locator, rect });
    }
  }
  buttons.sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left);
  validateButtonRects(buttons.map((button) => button.rect));
  validateGridTopology(buttons);
  return buttons;
}

export function createDigitSlotMap(digitsByShuffledSlot: readonly ShuffledDigit[]): Map<string, number> {
  if (digitsByShuffledSlot.length !== SHUFFLED_SLOT_INDEXES.length || new Set(digitsByShuffledSlot).size !== 5) {
    throw new KeypadRecognitionError("셔플 숫자 슬롯 매핑이 올바르지 않습니다");
  }
  const result = new Map<string, number>(Object.entries(FIXED_DIGIT_SLOT_INDEXES));
  digitsByShuffledSlot.forEach((digit, index) => {
    const slotIndex = SHUFFLED_SLOT_INDEXES[index];
    if (slotIndex === undefined) throw new KeypadRecognitionError("셔플 슬롯 인덱스가 누락되었습니다");
    result.set(digit, slotIndex);
  });
  if (result.size !== 10) throw new KeypadRecognitionError("0부터 9까지 전체 숫자 맵을 만들지 못했습니다");
  return result;
}

export function passwordToSlotSequence(password: string, digitSlotMap: ReadonlyMap<string, number>): number[] {
  return [...password].map((digit) => {
    const slot = digitSlotMap.get(digit);
    if (slot === undefined) throw new KeypadRecognitionError("비밀번호 숫자에 대응하는 키패드 슬롯이 없습니다");
    return slot;
  });
}

export async function enterPasswordWithKeypad(page: Page, password: string): Promise<void> {
  const checkbox = page.locator(KB_SELECTORS.mouseInputCheckbox);
  await checkbox.waitFor({ state: "visible", timeout: 10_000 }).catch((error: unknown) => {
    throw new KeypadError("마우스 입력 체크박스를 찾을 수 없습니다", { cause: error });
  });
  await checkbox.check();
  await page.locator(KB_SELECTORS.password).click();

  const image = page.locator(KB_SELECTORS.keypadImage);
  await image.waitFor({ state: "visible", timeout: 10_000 }).catch((error: unknown) => {
    throw new KeypadError("이미지 키패드가 표시되지 않았습니다", { cause: error });
  });
  await image.evaluate(async (element: HTMLImageElement) => {
    if (element.complete && element.naturalWidth > 0) return;
    await new Promise<void>((resolve, reject) => {
      element.addEventListener("load", () => resolve(), { once: true });
      element.addEventListener("error", () => reject(new Error("Keypad image failed to load")), { once: true });
    });
  });

  const box = await image.boundingBox();
  if (
    box === null ||
    box.width < KEYPAD_LIMITS.minimumWidth ||
    box.width > KEYPAD_LIMITS.maximumWidth ||
    box.height < KEYPAD_LIMITS.minimumHeight ||
    box.height > KEYPAD_LIMITS.maximumHeight
  ) {
    throw new KeypadRecognitionError("키패드 이미지 크기가 검증된 범위를 벗어났습니다");
  }

  const buttons = await collectGridButtons(page.locator(KB_SELECTORS.keypadAreas));
  const shuffledButtons = SHUFFLED_SLOT_INDEXES.map((index) => buttons[index]);
  if (shuffledButtons.some((button) => button === undefined)) {
    throw new KeypadRecognitionError("셔플 슬롯이 정확히 다섯 개가 아닙니다");
  }

  let recognition;
  try {
    const keypadScreenshot = await image.screenshot();
    const buttonImages = await extractButtonImages(
      keypadScreenshot,
      shuffledButtons.map((button) => button!.rect),
    );
    recognition = await recognizeButtonImages(buttonImages, TEMPLATE_DIRECTORY);
  } catch (error) {
    if (error instanceof KeypadRecognitionError) throw error;
    throw new KeypadRecognitionError("키패드 숫자 이미지 분류에 실패했습니다", { cause: error });
  }

  const digitSlotMap = createDigitSlotMap(recognition.digitsBySlot);
  const passwordInput = page.locator(KB_SELECTORS.password);
  for (const slotIndex of passwordToSlotSequence(password, digitSlotMap)) {
    const button = buttons[slotIndex];
    if (button === undefined) throw new KeypadRecognitionError("클릭할 키패드 버튼 슬롯이 없습니다");
    const beforeLength = (await passwordInput.inputValue()).length;
    await image.click({
      position: {
        x: button.rect.left + button.rect.width / 2,
        y: button.rect.top + button.rect.height / 2,
      },
    });
    await page.waitForTimeout(KEYPAD_LIMITS.clickIntervalMs);
    const afterLength = (await passwordInput.inputValue()).length;
    if (afterLength !== beforeLength + 1) {
      throw new KeypadRecognitionError("키패드 입력 자릿수 증가 검증에 실패했습니다");
    }
  }

  if ((await passwordInput.inputValue()).length !== password.length) {
    throw new KeypadRecognitionError("키패드 입력 자릿수 검증에 실패했습니다");
  }
}
