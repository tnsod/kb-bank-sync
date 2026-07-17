import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/env.js";

const keypadFailure = vi.hoisted(() => new Error("keypad classification failed"));

vi.mock("../src/bank/kb-form.js", () => ({ fillLookupForm: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/bank/kb-keypad.js", () => ({ enterPasswordWithKeypad: vi.fn().mockRejectedValue(keypadFailure) }));

import { performLookup } from "../src/bank/kb-client.js";

const config: AppConfig = {
  KB_QUICK_LOOKUP_URL: "https://example.test/quick-lookup",
  KB_ACCOUNT_NUMBER: "12345678901234",
  KB_BIRTH_DATE: "900101",
  KB_WEB_PASSWORD: "1234",
  KB_LOOKUP_START_DATE: "2026-07-01",
  KB_LOOKUP_END_DATE: "2026-07-15",
  GOOGLE_SPREADSHEET_ID: "test-sheet",
  GOOGLE_SHEET_NAME: "거래내역",
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: "credentials/test.json",
  SYNC_OVERLAP_DAYS: 3,
  INITIAL_LOOKBACK_MONTHS: 6,
  DRY_RUN: true,
  ENABLE_SHEETS_WRITE: false,
  ENABLE_DEEP_DIAGNOSTICS: false,
  ENABLE_RESPONSE_MEMORY_INSPECTION: false,
  ENABLE_SUBMIT_TRACING: false,
  PLAYWRIGHT_BROWSER_MODE: "new-headless",
  PLAYWRIGHT_SUBMIT_CLICK_MODE: "locator",
  LOG_LEVEL: "silent",
  TZ: "Asia/Seoul",
  NODE_ENV: "test",
};

describe("keypad failure submit guard", () => {
  it("does not locate or click the lookup button after classification failure", async () => {
    const submitClick = vi.fn();
    const locator = vi.fn(() => ({ count: vi.fn().mockResolvedValue(1), click: submitClick }));
    const page = {
      goto: vi.fn().mockResolvedValue(null),
      locator,
      url: vi.fn().mockReturnValue(config.KB_QUICK_LOOKUP_URL),
    } as unknown as Page;

    await expect(performLookup(page, config)).rejects.toBe(keypadFailure);
    expect(locator).not.toHaveBeenCalled();
    expect(submitClick).not.toHaveBeenCalled();
  });
});
