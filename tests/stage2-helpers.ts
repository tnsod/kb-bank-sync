import type { KbLookupResult } from "../src/bank/kb-client.js";
import type { CliOptions } from "../src/config/cli.js";
import type { AppConfig } from "../src/config/env.js";
import type { SheetsClient } from "../src/spreadsheet/google-sheets-client.js";
import { EXPECTED_HEADERS } from "../src/spreadsheet/sheet-mapper.js";

export const stage2Config: AppConfig = {
  KB_QUICK_LOOKUP_URL: "https://example.test/quick-lookup",
  KB_ACCOUNT_NUMBER: "12345678901234", KB_BIRTH_DATE: "900101", KB_WEB_PASSWORD: "1234",
  GOOGLE_SPREADSHEET_ID: "test-sheet", GOOGLE_SHEET_NAME: "거래내역",
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: "credentials/test.json",
  SYNC_OVERLAP_DAYS: 3, INITIAL_LOOKBACK_MONTHS: 6,
  DRY_RUN: true, ENABLE_SHEETS_WRITE: false,
  ENABLE_DEEP_DIAGNOSTICS: false, ENABLE_RESPONSE_MEMORY_INSPECTION: false, ENABLE_SUBMIT_TRACING: false,
  PLAYWRIGHT_BROWSER_MODE: "new-headless", PLAYWRIGHT_SUBMIT_CLICK_MODE: "locator",
  LOG_LEVEL: "silent", TZ: "Asia/Seoul", NODE_ENV: "test",
};

export const defaultCli: CliOptions = {
  initializeSheet: false, migrateSheetLayout: false, swapCounterpartyDescription: false,
  captureSanitizedFixture: false, diagnoseSubmit: false,
  headed: false, pauseAfterSubmit: false,
};

export const rawTransaction = {
  dateText: "2026.07.15", timeText: "14:30:00", transactionTypeText: "입금",
  descriptionText: "가상 거래", memoText: "가상 상세", withdrawalText: "-",
  depositText: "1,000", balanceText: "10,000", branchText: "테스트점",
};

export function successfulLookup(rawTransactions = [rawTransaction]): KbLookupResult {
  return {
    status: rawTransactions.length === 0 ? "empty" : "success",
    rawTransactions,
    currentUrl: "https://example.test/result", screenTransactionCount: rawTransactions.length,
    paginationDetected: false, pageCount: 1, submitted: true,
    submitDiagnostics: { resultContainerDetected: true } as KbLookupResult["submitDiagnostics"],
    rowDiagnostics: rawTransactions.length === 0 ? null : {
      totalBodyRowCount: rawTransactions.length * 2, mainTransactionRowCount: rawTransactions.length,
      detailRowCount: rawTransactions.length, matchedDetailRowCount: rawTransactions.length,
      unmatchedDetailRowCount: 0, orphanDetailRowCount: 0, detailRowsMatchedToTransactions: true,
      detailRowRole: "additional_description", detailRowsFollowMain: true, detailColspanValidated: true,
    },
  };
}

export function sheetClient(overrides: Partial<SheetsClient> = {}): SheetsClient {
  return {
    getWorksheetInfo: () => Promise.resolve({ exists: true, sheetId: 1 }),
    createWorksheet: () => Promise.resolve(1),
    readHeader: () => Promise.resolve([...EXPECTED_HEADERS]),
    readDataRows: () => Promise.resolve([]),
    readSheetDeveloperMetadata: () => Promise.resolve([]),
    swapCounterpartyDescriptionColumns: () => Promise.resolve(),
    writeHeader: () => Promise.resolve(),
    applySheetLayout: () => Promise.resolve({
      systemColumnsHidden: true, frozenHeader: true, basicFilterApplied: true,
      bandingApplied: true, conditionalFormatRuleCount: 3, dataValidationApplied: true,
    }),
    duplicateWorksheet: () => Promise.resolve(2),
    createNamedWorksheet: () => Promise.resolve(3),
    writeNamedSheetRows: () => Promise.resolve(),
    readNamedSheetRows: () => Promise.resolve([]),
    replaceWorksheet: () => Promise.resolve(),
    deleteWorksheet: () => Promise.resolve(),
    appendTransactions: (transactions) => Promise.resolve({ appendedRowCount: transactions.length, updatedRange: "거래내역!A2:L2" }),
    ...overrides,
  };
}
