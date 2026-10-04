import { describe, expect, it } from "vitest";

import { buildExistingSheetState, type RawSheetRow } from "../src/spreadsheet/sheet-state.js";
import { legacyRowDigest, validateVerifiedLegacyRecords } from "../src/spreadsheet/verified-legacy.js";
import { assertSheetsWriteAllowed } from "../src/spreadsheet/write-guard.js";
import { transactionToSheetRow } from "../src/spreadsheet/sheet-mapper.js";
import { fingerprintTransaction } from "../src/transaction/fingerprint.js";
import { normalizeAndValidateTransaction } from "../src/transaction/validate.js";
import { runSync } from "../src/sync/sync-service.js";
import { defaultCli, rawTransaction, sheetClient, stage2Config, successfulLookup } from "./stage2-helpers.js";

const tx = fingerprintTransaction(normalizeAndValidateTransaction(rawTransaction, stage2Config.KB_ACCOUNT_NUMBER, "2026-07-16T00:00:00+09:00"));
const legacyRow: RawSheetRow = transactionToSheetRow(tx).slice(0, 9);
legacyRow[6] = "사용자 적요";
const record = {
  version: 1, rowDigest: legacyRowDigest(legacyRow), accountId: tx.accountId,
  sourceKey: tx.sourceKey, legacySourceKey: "a".repeat(64),
};

describe("verified legacy compatibility index", () => {
  it("rejects a verified row edited during KB lookup before append", async () => {
    let read = 0; let appended = false;
    await expect(runSync({ ...stage2Config, DRY_RUN: false, ENABLE_SHEETS_WRITE: true }, defaultCli, {
      sheets: sheetClient({
        readDataRows: () => { read++; const current = [...legacyRow]; if (read > 1) current[6] = "concurrent change"; return Promise.resolve([current]); },
        readSheetDeveloperMetadata: () => Promise.resolve([{ metadataId: 1, value: JSON.stringify(record) }]),
        appendTransactions: () => { appended = true; return Promise.resolve({ appendedRowCount: 1, updatedRange: "Sheet1!A3:L3" }); },
      }),
      lookup: () => Promise.resolve(successfulLookup([{ ...rawTransaction, timeText: "14:30:01" }])),
      now: "2026-07-16T00:00:00+09:00",
    })).rejects.toMatchObject({ code: "SHEET_DATA_INVALID" });
    expect(appended).toBe(false);
  });
  it("keeps 81 physically missing system rows blocked without independently verified records", () => {
    const rows = Array.from({ length: 81 }, (_, i) => [...legacyRow.slice(0, 6), `가상 적요 ${i}`]);
    expect(buildExistingSheetState(rows, tx.accountId)).toMatchObject({
      rowCount: 81, missingSourceKeyRowCount: 81, verifiedLegacyRowCount: 0, shortRowCount: 81,
    });
  });

  it("indexes both KB keys while preserving every original cell", () => {
    const before = structuredClone(legacyRow);
    const state = buildExistingSheetState([legacyRow], tx.accountId, [JSON.stringify(record)]);
    expect(state).toMatchObject({ missingSourceKeyRowCount: 1, verifiedLegacyRowCount: 1, shortRowCount: 0, differentAccountIdRowCount: 0 });
    expect(state.sourceKeys).toEqual(new Set([record.sourceKey, record.legacySourceKey]));
    expect(legacyRow).toEqual(before);
  });

  it("accepts whole-row sorting and H/I edits", () => {
    const edited = [...legacyRow]; edited[7] = "새 증빙"; edited[8] = "새 비고";
    const normal = transactionToSheetRow({ ...tx, sourceKey: "b".repeat(64) }); normal[0] = "2026-07-14T00:00:00+09:00";
    expect(validateVerifiedLegacyRecords([normal, edited], tx.accountId, [JSON.stringify(record)]).has(1)).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 5, 6])("rejects an edit in verified A:G column %i", (column) => {
    const edited = [...legacyRow]; edited[column] = "modified";
    expect(() => validateVerifiedLegacyRecords([edited], tx.accountId, [JSON.stringify(record)])).toThrow(/변경/u);
  });

  it("rejects duplicate rows, duplicate records, system edits and key collisions", () => {
    const value = JSON.stringify(record);
    expect(() => validateVerifiedLegacyRecords([legacyRow, legacyRow], tx.accountId, [value])).toThrow(/1:1/u);
    expect(() => validateVerifiedLegacyRecords([legacyRow], tx.accountId, [value, value])).toThrow(/1:1/u);
    const changed = [...legacyRow]; changed[9] = tx.accountId;
    expect(() => validateVerifiedLegacyRecords([changed], tx.accountId, [value])).toThrow(/시스템/u);
    expect(() => validateVerifiedLegacyRecords([legacyRow, transactionToSheetRow(tx)], tx.accountId, [value])).toThrow(/충돌/u);
  });

  it("rejects invalid metadata and a different account", () => {
    for (const value of ["{", JSON.stringify({ ...record, sourceKey: "bad" }), JSON.stringify({ ...record, accountId: "KB-9999" })]) {
      expect(() => validateVerifiedLegacyRecords([legacyRow], tx.accountId, [value])).toThrow();
    }
  });

  it("prevents a repeated KB transaction from appending despite edited legacy description", async () => {
    const summary = await runSync(stage2Config, defaultCli, {
      sheets: sheetClient({ readDataRows: () => Promise.resolve([legacyRow]), readSheetDeveloperMetadata: () => Promise.resolve([{ metadataId: 1, value: JSON.stringify(record) }]) }),
      lookup: () => Promise.resolve(successfulLookup()), now: "2026-07-16T00:00:00+09:00",
    });
    expect(summary).toMatchObject({ status: "dry_run", existingTransactionCount: 1, newTransactionCount: 0, missingSourceKeyRowCount: 1, verifiedLegacyRowCount: 1, appendCalled: false });
  });

  it("appends only a distinct new transaction with covered legacy rows", async () => {
    const calls: number[] = [];
    const summary = await runSync({ ...stage2Config, DRY_RUN: false, ENABLE_SHEETS_WRITE: true }, defaultCli, {
      sheets: sheetClient({
        readDataRows: () => Promise.resolve([legacyRow]),
        readSheetDeveloperMetadata: () => Promise.resolve([{ metadataId: 1, value: JSON.stringify(record) }]),
        appendTransactions: (transactions, guard) => { assertSheetsWriteAllowed(guard); calls.push(transactions.length); return Promise.resolve({ appendedRowCount: transactions.length, updatedRange: "Sheet1!A3:L3" }); },
      }),
      lookup: () => Promise.resolve(successfulLookup([rawTransaction, { ...rawTransaction, timeText: "14:30:01" }])),
      now: "2026-07-16T00:00:00+09:00",
    });
    expect(summary).toMatchObject({ status: "success", existingTransactionCount: 1, newTransactionCount: 1, insertedCount: 1 });
    expect(calls).toEqual([1]);
  });

  it("rejects partially covered missing rows before any KB authentication", async () => {
    let lookedUp = false;
    await expect(runSync(stage2Config, defaultCli, {
      sheets: sheetClient({ readDataRows: () => Promise.resolve([legacyRow, [...legacyRow.slice(0, 6), "다른 적요"]]), readSheetDeveloperMetadata: () => Promise.resolve([{ metadataId: 1, value: JSON.stringify(record) }]) }),
      lookup: () => { lookedUp = true; return Promise.resolve(successfulLookup()); }, now: "2026-07-16T00:00:00+09:00",
    })).rejects.toMatchObject({ code: "SHEET_DATA_REQUIRES_MIGRATION" });
    expect(lookedUp).toBe(false);
  });
});
