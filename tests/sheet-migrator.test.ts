import { describe, expect, it, vi } from "vitest";

import { migrateSheetLayout } from "../src/spreadsheet/sheet-migrator.js";
import { EXPECTED_HEADERS, LEGACY_HEADERS } from "../src/spreadsheet/sheet-mapper.js";
import type { RawSheetRow } from "../src/spreadsheet/sheet-state.js";
import { sheetClient } from "./stage2-helpers.js";

const legacyRows: RawSheetRow[] = [
  ["2026-07-15T10:00:00+09:00", "bank type", "counterparty A", "memo A", 0, 2000, 12000, "institution A", "KB-1234", "2026-07-16T00:00:00+09:00", "key-a"],
  ["2026-07-16T11:00:00+09:00", "bank type", "counterparty B", "memo B", 400, 0, 11600, "institution B", "KB-1234", "2026-07-16T00:00:00+09:00", "key-b"],
];

const layout = {
  systemColumnsHidden: true, frozenHeader: true, basicFilterApplied: true,
  bandingApplied: true, conditionalFormatRuleCount: 3, dataValidationApplied: true,
};

describe("sheet layout migration", () => {
  it("backs up legacy A:K, converts to A:L, and preserves row count and sourceKeys", async () => {
    let written: readonly RawSheetRow[] = [];
    let replacementComplete = false;
    const writeNamedSheetRows = vi.fn((_: string, rows: readonly RawSheetRow[]) => { written = rows; return Promise.resolve(); });
    const replaceWorksheet = vi.fn(() => { replacementComplete = true; return Promise.resolve(); });
    const readNamedSheetRows = vi.fn((title: string) => {
      if (title.includes("backup_")) return Promise.resolve([[...LEGACY_HEADERS], ...legacyRows]);
      if (replacementComplete || title.includes("migration_")) return Promise.resolve(written.map((row) => [...row]));
      return Promise.resolve([]);
    });
    const duplicateWorksheet = vi.fn().mockResolvedValue(2);
    const result = await migrateSheetLayout(sheetClient({
      readHeader: vi.fn().mockResolvedValue([...LEGACY_HEADERS]),
      readDataRows: vi.fn().mockResolvedValue(legacyRows),
      duplicateWorksheet,
      createNamedWorksheet: vi.fn().mockResolvedValue(3),
      writeNamedSheetRows,
      readNamedSheetRows,
      applySheetLayout: vi.fn().mockResolvedValue(layout),
      replaceWorksheet,
    }), {
      dryRun: false, sheetsWriteEnabled: true, expectedAccountId: "KB-1234", sheetName: "test",
      now: "2026-07-17T03:55:00+09:00",
    });

    expect(result).toMatchObject({
      backupCreated: true, backupSheetName: "test_backup_20260717_035500",
      originalRowCount: 2, migratedRowCount: 2, sourceKeysPreserved: true,
    });
    expect(duplicateWorksheet).toHaveBeenCalledOnce();
    expect(replaceWorksheet).toHaveBeenCalledOnce();
    expect(written[0]).toEqual([...EXPECTED_HEADERS]);
    expect(written[1]).toHaveLength(12);
    expect(written[1]?.[2]).toBe("입금");
    expect(written[1]?.[1]).toBe("memo A");
    expect(written[1]?.[6]).toBe("counterparty A");
    expect(written[1]?.[4]).toBe(2000);
    expect(written[2]?.[2]).toBe("출금");
    expect(written[2]?.[4]).toBe(-400);
    expect(written[1]?.slice(7, 9)).toEqual(["", ""]);
    expect(written.slice(1).map((row) => row[11])).toEqual(["key-a", "key-b"]);
  });

  it("keeps the original worksheet untouched when temporary verification fails", async () => {
    const replaceWorksheet = vi.fn();
    const duplicateWorksheet = vi.fn().mockResolvedValue(2);
    await expect(migrateSheetLayout(sheetClient({
      readHeader: vi.fn().mockResolvedValue([...LEGACY_HEADERS]),
      readDataRows: vi.fn().mockResolvedValue(legacyRows),
      duplicateWorksheet,
      createNamedWorksheet: vi.fn().mockResolvedValue(3),
      writeNamedSheetRows: vi.fn(),
      readNamedSheetRows: vi.fn()
        .mockResolvedValueOnce([[...LEGACY_HEADERS], ...legacyRows])
        .mockResolvedValueOnce([["wrong"]]),
      replaceWorksheet,
    }), {
      dryRun: false, sheetsWriteEnabled: true, expectedAccountId: "KB-1234", sheetName: "test",
      now: "2026-07-17T03:55:00+09:00",
    })).rejects.toMatchObject({ code: "SHEET_DATA_INVALID" });
    expect(duplicateWorksheet).toHaveBeenCalledOnce();
    expect(replaceWorksheet).not.toHaveBeenCalled();
  });

  it("does not create another backup when the new layout already exists", async () => {
    const duplicateWorksheet = vi.fn();
    const result = await migrateSheetLayout(sheetClient({
      readHeader: vi.fn().mockResolvedValue([...EXPECTED_HEADERS]),
      readDataRows: vi.fn().mockResolvedValue([]),
      duplicateWorksheet,
      applySheetLayout: vi.fn().mockResolvedValue(layout),
    }), { dryRun: false, sheetsWriteEnabled: true, expectedAccountId: "KB-1234", sheetName: "test" });
    expect(result).toMatchObject({ alreadyMigrated: true, backupCreated: false, migratedRowCount: 0 });
    expect(duplicateWorksheet).not.toHaveBeenCalled();
  });
});
