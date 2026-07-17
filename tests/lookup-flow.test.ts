import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "playwright";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/env.js";
import { KB_SELECTORS } from "../src/config/selectors.js";

const mocks = vi.hoisted(() => ({
  fillLookupForm: vi.fn(),
  enterPasswordWithKeypad: vi.fn(),
  observeSubmitTransition: vi.fn(),
  captureSafeResultStructure: vi.fn(),
  result: "authentication" as "authentication" | "empty" | "response",
}));

vi.mock("../src/bank/kb-form.js", () => ({ fillLookupForm: mocks.fillLookupForm }));
vi.mock("../src/bank/kb-keypad.js", () => ({ enterPasswordWithKeypad: mocks.enterPasswordWithKeypad }));
vi.mock("../src/bank/submit-diagnostics.js", () => ({ observeSubmitTransition: mocks.observeSubmitTransition }));
vi.mock("../src/bank/result-diagnostics.js", () => ({ captureSafeResultStructure: mocks.captureSafeResultStructure }));

import { performLookup } from "../src/bank/kb-client.js";

const responseFixture = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "kb-result-success.html"),
  "utf8",
);

const config: AppConfig = {
  KB_QUICK_LOOKUP_URL: "https://example.test/quick-lookup",
  KB_ACCOUNT_NUMBER: "00000000001234",
  KB_BIRTH_DATE: "000000",
  KB_WEB_PASSWORD: "0000",
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

function createPage(result: "authentication" | "empty") {
  const submitClick = vi.fn().mockResolvedValue(undefined);
  const mouseClick = vi.fn().mockResolvedValue(undefined);
  const goto = vi.fn().mockResolvedValue(null);
  const locator = vi.fn((selector: string) => {
    if (selector === KB_SELECTORS.submit) {
      return {
        count: vi.fn().mockResolvedValue(1),
        click: submitClick,
        scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
        boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 40, height: 30 }),
      };
    }
    if (selector === KB_SELECTORS.errorRegion) {
      return { isVisible: vi.fn().mockResolvedValue(result === "authentication") };
    }
    if (selector === KB_SELECTORS.errorMessage) return { innerText: vi.fn().mockResolvedValue("비밀번호 확인") };
    if (selector === KB_SELECTORS.resultComponent) {
      return {
        isVisible: vi.fn().mockResolvedValue(result === "empty"),
        innerText: vi.fn().mockResolvedValue("조회된 내역이 없습니다"),
      };
    }
    throw new Error(`Unexpected selector: ${selector}`);
  });
  return {
    page: {
      goto,
      locator,
      context: vi.fn().mockReturnValue({}),
      url: vi.fn().mockReturnValue(config.KB_QUICK_LOOKUP_URL),
      mouse: { click: mouseClick },
    } as unknown as Page,
    goto,
    submitClick,
    mouseClick,
  };
}

describe("one-shot lookup flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fillLookupForm.mockResolvedValue(undefined);
    mocks.enterPasswordWithKeypad.mockResolvedValue(undefined);
    mocks.captureSafeResultStructure.mockResolvedValue({
      tables: [], transactionTableIndex: null, screenTransactionCount: 0,
      paginationDetected: false, nextButtonDetected: false, moreButtonDetected: false,
      emptyDetected: true, sanitizedHtml: "<section data-fixture='kb-result-empty'></section>",
    });
    mocks.observeSubmitTransition.mockImplementation(async (_context: unknown, page: Page, _submit: unknown, click: () => Promise<void>) => {
      await click();
      const diagnostics = {
        activePageUrl: { origin: "https://example.test", pathname: "/result" },
        transitionStatus: "xhr_dom_update",
      };
      if (mocks.result === "response") {
        return {
          diagnostics: {
            ...diagnostics,
            responseBodies: [{
              containsResultContainer: true,
              containsTransactionTable: true,
              paginationPatternDetected: false,
            }],
          },
          locatedResult: null,
          target: null,
          resultResponseHtml: responseFixture,
          authenticationDialogDetected: false,
          unexpectedDialogDetected: false,
        };
      }
      return mocks.result === "authentication"
        ? { diagnostics, locatedResult: null, target: null, authenticationDialogDetected: true, unexpectedDialogDetected: false }
        : (() => {
            const frame = {};
            return {
              diagnostics,
              locatedResult: { page, frame, locator: {}, status: "empty", source: "known-result" },
              target: { openerPage: page, resultPage: page, resultFrame: frame, openedNewPage: false, resultPageIndex: 0 },
              resultResponseHtml: null,
              authenticationDialogDetected: false,
              unexpectedDialogDetected: false,
            };
          })();
    });
  });

  it("submits once only after keypad validation and does not retry authentication failure", async () => {
    const { page, goto, submitClick } = createPage("authentication");
    mocks.result = "authentication";
    const result = await performLookup(page, config);
    expect(result.status).toBe("invalid_credentials");
    expect(result.submitted).toBe(true);
    expect(submitClick).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledTimes(1);
    expect(mocks.enterPasswordWithKeypad.mock.invocationCallOrder[0]).toBeLessThan(submitClick.mock.invocationCallOrder[0]!);
  });

  it("treats no transactions as a successful empty result", async () => {
    const { page, submitClick } = createPage("empty");
    mocks.result = "empty";
    const result = await performLookup(page, config);
    expect(result).toMatchObject({ status: "empty", submitted: true, screenTransactionCount: 0 });
    expect(submitClick).toHaveBeenCalledTimes(1);
  });

  it("parses an authenticated result response in memory when DOM rendering is missing", async () => {
    const { page, submitClick } = createPage("empty");
    mocks.result = "response";
    const result = await performLookup(page, { ...config, ENABLE_RESPONSE_MEMORY_INSPECTION: true });
    expect(result).toMatchObject({ status: "success", submitted: true, screenTransactionCount: 2 });
    expect(result.rawTransactions).toHaveLength(2);
    expect(submitClick).toHaveBeenCalledTimes(1);
  });

  it("uses the element-relative mouse path exactly once when configured", async () => {
    const { page, submitClick, mouseClick } = createPage("empty");
    mocks.result = "empty";
    const result = await performLookup(page, {
      ...config,
      PLAYWRIGHT_SUBMIT_CLICK_MODE: "mouse",
    });
    expect(result).toMatchObject({ status: "empty", submitted: true });
    expect(mouseClick).toHaveBeenCalledOnce();
    expect(mouseClick).toHaveBeenCalledWith(30, 35);
    expect(submitClick).not.toHaveBeenCalled();
  });
});
