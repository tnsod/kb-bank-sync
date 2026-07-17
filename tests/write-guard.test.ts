import { describe, expect, it } from "vitest";

import { assertSheetsWriteAllowed, type SheetsWriteGuard } from "../src/spreadsheet/write-guard.js";

const valid: SheetsWriteGuard = {
  dryRun: false, sheetsWriteEnabled: true, lookupStatus: "success", resultContainerDetected: true,
  transactionTableDetected: true, pageStructureValidated: true, allTransactionsValidated: true,
  parsedTransactionCount: 1, normalizedTransactionCount: 1, newTransactionCount: 1,
  sheetHeadersValidated: true, missingSourceKeyRowCount: 0,
};

describe("Sheets write guard", () => {
  it("accepts only the complete safe state", () => {
    expect(() => assertSheetsWriteAllowed(valid)).not.toThrow();
  });

  it.each([
    ["resultContainerDetected", false], ["transactionTableDetected", false], ["pageStructureValidated", false],
    ["allTransactionsValidated", false], ["sheetHeadersValidated", false], ["missingSourceKeyRowCount", 1],
    ["normalizedTransactionCount", 0], ["newTransactionCount", 0],
  ] as const)("rejects an unsafe %s state", (field, value) => {
    expect(() => assertSheetsWriteAllowed({ ...valid, [field]: value })).toThrow();
  });

  it("distinguishes disabled writes", () => {
    try {
      assertSheetsWriteAllowed({ ...valid, sheetsWriteEnabled: false });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "SHEETS_WRITE_DISABLED" });
    }
  });
});
