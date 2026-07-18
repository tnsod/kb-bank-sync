import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import { fingerprintTransaction } from "../src/transaction/fingerprint.js";
import { normalizeAndValidateTransaction } from "../src/transaction/validate.js";
import { TransactionValidationError } from "../src/bank/kb-errors.js";
import { runSync } from "../src/sync/sync-service.js";
import { transactionToSheetRow } from "../src/spreadsheet/sheet-mapper.js";
import type { Transaction } from "../src/transaction/transaction.js";
import { defaultCli, rawTransaction, sheetClient, stage2Config, successfulLookup } from "./stage2-helpers.js";

const now = "2026-07-16T00:00:00+09:00";
const collectedAt = "2026-07-16T01:00:00+09:00";

function existingRow(sourceKey: string) {
  return ["2026-07-15T14:30:00+09:00", "가상 거래", "입금", "테스트점", 1000, 10000, "가상 상세",
    "사용자 증빙", "사용자 비고", "KB-1234", collectedAt, sourceKey];
}

function transactionKey(): string {
  return fingerprintTransaction(normalizeAndValidateTransaction(
    rawTransaction, stage2Config.KB_ACCOUNT_NUMBER, collectedAt,
    { lookupStartDate: "2026-01-16", lookupEndDate: "2026-07-16" },
  )).sourceKey;
}

describe("sync service", () => {
  it("calculates new rows during dry-run and never appends", async () => {
    const appendTransactions = vi.fn();
    const summary = await runSync(stage2Config, defaultCli, {
      sheets: sheetClient({ appendTransactions }), lookup: vi.fn().mockResolvedValue(successfulLookup()),
      now, collectedAt: () => collectedAt,
    });
    expect(summary).toMatchObject({ status: "dry_run", scrapedCount: 1, uniqueScrapedCount: 1, newTransactionCount: 1, appendCalled: false });
    expect(appendTransactions).not.toHaveBeenCalled();
  });

  it("skips a structurally valid informational row and counts only normal transactions as scraped", async () => {
    const privateDescription = "PRIVATE_INFORMATIONAL_DESCRIPTION";
    const privateMemo = "PRIVATE_INFORMATIONAL_MEMO";
    const informational = {
      ...rawTransaction,
      dateText: "2026.07.14",
      transactionTypeText: "                ",
      descriptionText: privateDescription,
      memoText: privateMemo,
      withdrawalText: "0",
      depositText: "-",
    };
    const withdrawal = {
      ...rawTransaction,
      dateText: "2026.07.13",
      transactionTypeText: "출금",
      withdrawalText: "500",
      depositText: "0",
    };
    const info = vi.fn();
    const appendTransactions = vi.fn();
    const summary = await runSync(stage2Config, defaultCli, {
      sheets: sheetClient({ appendTransactions }),
      lookup: vi.fn().mockResolvedValue(successfulLookup([rawTransaction, informational, withdrawal])),
      now,
      collectedAt: () => collectedAt,
      logger: { info } as unknown as Logger,
    });
    expect(summary).toMatchObject({
      status: "dry_run",
      parsedRowCount: 3,
      skippedInformationalRowCount: 1,
      scrapedCount: 2,
      fingerprintedCount: 2,
      uniqueScrapedCount: 2,
      insertedCount: 0,
      appendCalled: false,
    });
    expect(info).toHaveBeenCalledWith({
      event: "informational_row_skipped",
      transactionIndex: 1,
      reason: "ZERO_AMOUNT_EMPTY_TRANSACTION_TYPE",
    }, "Informational row skipped");
    expect(JSON.stringify(info.mock.calls)).not.toContain(privateDescription);
    expect(JSON.stringify(info.mock.calls)).not.toContain(privateMemo);
    expect(appendTransactions).not.toHaveBeenCalled();
  });

  it("returns a normal no-new-transactions status when every parsed row is informational", async () => {
    const informationalRows = ["2026.07.15", "2026.07.14"].map((dateText) => ({
      ...rawTransaction,
      dateText,
      transactionTypeText: " ",
      withdrawalText: "0",
      depositText: "0",
    }));
    const appendTransactions = vi.fn();
    const summary = await runSync(stage2Config, defaultCli, {
      sheets: sheetClient({ appendTransactions }),
      lookup: vi.fn().mockResolvedValue(successfulLookup(informationalRows)),
      now,
      collectedAt: () => collectedAt,
    });
    expect(summary).toMatchObject({
      status: "no_new_transactions",
      parsedRowCount: 2,
      skippedInformationalRowCount: 2,
      scrapedCount: 0,
      fingerprintedCount: 0,
      insertedCount: 0,
      appendCalled: false,
    });
    expect(appendTransactions).not.toHaveBeenCalled();
  });

  it("never fingerprints or appends the informational row during a write-enabled run", async () => {
    const informational = {
      ...rawTransaction,
      dateText: "2026.07.14",
      transactionTypeText: "\t ",
      withdrawalText: "0",
      depositText: "0",
    };
    const appendTransactions = vi.fn().mockResolvedValue({ appendedRowCount: 1, updatedRange: "Sheet1!A2:L2" });
    const summary = await runSync({ ...stage2Config, DRY_RUN: false, ENABLE_SHEETS_WRITE: true }, defaultCli, {
      sheets: sheetClient({ appendTransactions }),
      lookup: vi.fn().mockResolvedValue(successfulLookup([rawTransaction, informational])),
      now,
      collectedAt: () => collectedAt,
    });
    expect(summary).toMatchObject({
      status: "success",
      parsedRowCount: 2,
      skippedInformationalRowCount: 1,
      scrapedCount: 1,
      fingerprintedCount: 1,
      insertedCount: 1,
      appendCalled: true,
    });
    expect(appendTransactions).toHaveBeenCalledOnce();
    expect(appendTransactions.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("keeps rejecting a zero-amount blank-type row when its detail structure is not validated", async () => {
    const lookup = successfulLookup([{
      ...rawTransaction,
      transactionTypeText: " ",
      withdrawalText: "0",
      depositText: "0",
    }]);
    if (lookup.rowDiagnostics === null) throw new Error("Expected row diagnostics");
    lookup.rowDiagnostics = { ...lookup.rowDiagnostics, detailRowsMatchedToTransactions: false };
    await expect(runSync(stage2Config, defaultCli, {
      sheets: sheetClient(), lookup: vi.fn().mockResolvedValue(lookup), now, collectedAt: () => collectedAt,
    })).rejects.toMatchObject({
      validationDiagnostic: { validationErrorCode: "NEITHER_WITHDRAWAL_NOR_DEPOSIT" },
    });
  });

  it("preserves the zero-based transaction index and total count for validation failures", async () => {
    const privateDescription = "PRIVATE_TRANSACTION_DESCRIPTION";
    const lookup = successfulLookup([
      rawTransaction,
      { ...rawTransaction, dateText: "2026.07.14", descriptionText: "", memoText: privateDescription },
      { ...rawTransaction, dateText: "2026.07.13" },
    ]);
    try {
      await runSync(stage2Config, defaultCli, {
        sheets: sheetClient(), lookup: vi.fn().mockResolvedValue(lookup), now, collectedAt: () => collectedAt,
      });
      expect.fail("Expected a transaction validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionValidationError);
      const diagnostic = (error as TransactionValidationError).validationDiagnostic;
      expect(diagnostic).toMatchObject({
        validationErrorCode: "EMPTY_DESCRIPTION",
        transactionIndex: 1,
        transactionCount: 3,
        failedFieldName: "descriptionText",
      });
      expect(JSON.stringify(diagnostic)).not.toContain(privateDescription);
    }
  });

  it("does not append when every scraped transaction already exists", async () => {
    const appendTransactions = vi.fn();
    const summary = await runSync({ ...stage2Config, DRY_RUN: false }, defaultCli, {
      sheets: sheetClient({ readDataRows: vi.fn().mockResolvedValue([existingRow(transactionKey())]), appendTransactions }),
      lookup: vi.fn().mockResolvedValue(successfulLookup()), now, collectedAt: () => collectedAt,
    });
    expect(summary).toMatchObject({ status: "no_new_transactions", existingTransactionCount: 1, newTransactionCount: 0 });
    expect(appendTransactions).not.toHaveBeenCalled();
  });

  it("appends multiple new transactions once and removes internal duplicates", async () => {
    const appendTransactions = vi.fn().mockImplementation((transactions: unknown[]) => Promise.resolve({
      appendedRowCount: transactions.length, updatedRange: "거래내역!A2:L3",
    }));
    const second = { ...rawTransaction, dateText: "2026.07.14", depositText: "2,000" };
    const lookup = successfulLookup([rawTransaction, rawTransaction, second]);
    const summary = await runSync({ ...stage2Config, DRY_RUN: false, ENABLE_SHEETS_WRITE: true }, defaultCli, {
      sheets: sheetClient({ appendTransactions }), lookup: vi.fn().mockResolvedValue(lookup), now, collectedAt: () => collectedAt,
    });
    expect(summary).toMatchObject({ status: "success", scrapedCount: 3, uniqueScrapedCount: 2, internalDuplicateCount: 1, insertedCount: 2 });
    expect(appendTransactions).toHaveBeenCalledOnce();
    const appended = appendTransactions.mock.calls[0]?.[0] as Array<{ occurredAt: string }>;
    expect(appended.map((transaction) => transaction.occurredAt)).toEqual([
      "2026-07-14T14:30:00+09:00", "2026-07-15T14:30:00+09:00",
    ]);
  });

  it("keeps existing H/I values untouched and appends only a new transaction with the corrected B/G mapping", async () => {
    const existing = existingRow(transactionKey());
    const readDataRows = vi.fn().mockResolvedValue([existing]);
    const appendTransactions = vi.fn().mockImplementation((transactions: readonly Transaction[]) => Promise.resolve({
      appendedRowCount: transactions.length, updatedRange: "거래내역!A3:L3",
    }));
    const fresh = { ...rawTransaction, dateText: "2026.07.16", descriptionText: "349", memoText: "빛쌤", depositText: "2,000" };
    const summary = await runSync({ ...stage2Config, DRY_RUN: false, ENABLE_SHEETS_WRITE: true }, defaultCli, {
      sheets: sheetClient({ readDataRows, appendTransactions }),
      lookup: vi.fn().mockResolvedValue(successfulLookup([rawTransaction, fresh])), now, collectedAt: () => collectedAt,
    });
    expect(summary).toMatchObject({ existingTransactionCount: 1, newTransactionCount: 1, insertedCount: 1, appendCalled: true });
    expect(existing[7]).toBe("사용자 증빙");
    expect(existing[8]).toBe("사용자 비고");
    const appendedTransactions = appendTransactions.mock.calls[0]?.[0] as readonly Transaction[] | undefined;
    const appendedTransaction = appendedTransactions?.[0];
    if (appendedTransaction === undefined) throw new Error("expected one appended transaction");
    const appendedRow = transactionToSheetRow(appendedTransaction);
    expect(appendedRow[1]).toBe("빛쌤");
    expect(appendedRow[6]).toBe("349");
    expect(appendedRow.slice(7, 9)).toEqual(["", ""]);
  });

  it("refuses writes when the explicit enable flag is false", async () => {
    const appendTransactions = vi.fn();
    await expect(runSync({ ...stage2Config, DRY_RUN: false }, defaultCli, {
      sheets: sheetClient({ appendTransactions }), lookup: vi.fn().mockResolvedValue(successfulLookup()), now,
    })).rejects.toMatchObject({ code: "SHEETS_WRITE_DISABLED" });
    expect(appendTransactions).not.toHaveBeenCalled();
  });

  it("stops before append for failed lookup or unvalidated page structure", async () => {
    const appendTransactions = vi.fn();
    const failed = { ...successfulLookup(), status: "maintenance" as const, rawTransactions: [] };
    const summary = await runSync({ ...stage2Config, DRY_RUN: false, ENABLE_SHEETS_WRITE: true }, defaultCli, {
      sheets: sheetClient({ appendTransactions }), lookup: vi.fn().mockResolvedValue(failed), now,
    });
    expect(summary.status).toBe("bank_maintenance");
    const structurallyInvalid = { ...successfulLookup(), rowDiagnostics: null };
    await expect(runSync({ ...stage2Config, DRY_RUN: false, ENABLE_SHEETS_WRITE: true }, defaultCli, {
      sheets: sheetClient({ appendTransactions }), lookup: vi.fn().mockResolvedValue(structurallyInvalid), now,
    })).rejects.toMatchObject({ code: "SHEETS_WRITE_GUARD_REJECTED" });
    expect(appendTransactions).not.toHaveBeenCalled();
  });

  it("preserves a safe parser failure diagnostic through the final sync summary", async () => {
    const parserFailure = {
      parserErrorCode: "UNEXPECTED_ROW_CELL_COUNT" as const,
      parserStage: "row_shape_validation" as const,
      tableCount: 3,
      candidateTableCount: 1,
      selectedTableIndex: 1,
      selectedTableRowCount: 8,
      selectedTableColumnCount: 8,
      headerRowCount: 2,
      dataRowCount: 6,
      detailRowCount: 1,
      rowCellCounts: [8, 1, 7],
      mainTransactionCandidateCount: 1,
      detailRowCandidateCount: 1,
      headerMatched: true,
      dateParseSuccessCount: 1,
      dateParseFailureCount: 0,
      amountParseSuccessCount: 1,
      amountParseFailureCount: 0,
      balanceParseSuccessCount: 1,
      balanceParseFailureCount: 0,
      detailRowsMatchedToTransactions: false,
    };
    const lookup = {
      ...successfulLookup([]),
      status: "page_structure_changed" as const,
      parserFailure,
    };
    const summary = await runSync(stage2Config, defaultCli, {
      sheets: sheetClient(), lookup: vi.fn().mockResolvedValue(lookup), now,
    });
    expect(summary).toMatchObject({ status: "page_structure_changed", parserFailure });
    expect(JSON.stringify(summary.parserFailure)).not.toMatch(/거래처|적요|금액|잔액/u);
  });

  it("blocks sourceKey migration issues before bank lookup", async () => {
    const lookup = vi.fn();
    await expect(runSync(stage2Config, defaultCli, {
      sheets: sheetClient({ readDataRows: vi.fn().mockResolvedValue([existingRow("").slice(0, 11)]) }), lookup, now,
    })).rejects.toMatchObject({ code: "SHEET_DATA_REQUIRES_MIGRATION" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("initialization never calls the bank lookup", async () => {
    const lookup = vi.fn();
    const summary = await runSync({ ...stage2Config, DRY_RUN: false, ENABLE_SHEETS_WRITE: true }, {
      ...defaultCli, initializeSheet: true,
    }, { sheets: sheetClient(), lookup });
    expect(summary.status).toBe("sheet_initialized");
    expect(lookup).not.toHaveBeenCalled();
  });
});
