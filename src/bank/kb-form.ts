import type { Locator, Page } from "playwright";

import type { BankLookupConfig } from "../config/env.js";
import { KB_SELECTORS } from "../config/selectors.js";
import { PageStructureError } from "./kb-errors.js";

async function fillAndVerify(locator: Locator, value: string, fieldName: string): Promise<void> {
  try {
    const tagName = await locator.evaluate((element) => element.tagName);
    if (tagName === "SELECT") {
      await locator.selectOption(value);
    } else {
      await locator.fill(value);
    }
    if ((await locator.inputValue()) !== value) {
      throw new PageStructureError(`${fieldName} 입력값이 DOM에 적용되지 않았습니다`);
    }
  } catch (error) {
    if (error instanceof PageStructureError) throw error;
    throw new PageStructureError(`${fieldName} 입력 또는 검증에 실패했습니다`, { cause: error });
  }
}

async function fillDate(page: Page, prefix: "start" | "end", date: string): Promise<void> {
  const [year, month, day] = date.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    throw new PageStructureError("검증된 조회 날짜를 필드로 분리하지 못했습니다");
  }
  const [yearSelector, monthSelector, daySelector] = prefix === "start"
    ? [KB_SELECTORS.startYear, KB_SELECTORS.startMonth, KB_SELECTORS.startDay]
    : [KB_SELECTORS.endYear, KB_SELECTORS.endMonth, KB_SELECTORS.endDay];
  await fillAndVerify(page.locator(yearSelector), year, `${prefix} year`);
  await fillAndVerify(page.locator(monthSelector), month, `${prefix} month`);
  await fillAndVerify(page.locator(daySelector), day, `${prefix} day`);
}

export async function fillLookupForm(page: Page, config: BankLookupConfig): Promise<void> {
  const root = page.locator(KB_SELECTORS.inputComponent);
  await root.waitFor({ state: "visible", timeout: 15_000 }).catch((error: unknown) => {
    throw new PageStructureError("빠른조회 입력 컴포넌트를 찾을 수 없습니다", { cause: error });
  });

  await fillAndVerify(page.locator(KB_SELECTORS.accountNumber), config.KB_ACCOUNT_NUMBER, "account number");
  await page.locator(KB_SELECTORS.birthDateMode).check();
  await fillAndVerify(page.locator(KB_SELECTORS.birthDate), config.KB_BIRTH_DATE, "birth date or business number");
  await fillDate(page, "start", config.KB_LOOKUP_START_DATE);
  await fillDate(page, "end", config.KB_LOOKUP_END_DATE);
}
