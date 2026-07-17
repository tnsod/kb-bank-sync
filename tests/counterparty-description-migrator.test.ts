import { describe, expect, it, vi } from "vitest";

import {
  LAYOUT_MAPPING_METADATA_KEY,
  migrateCounterpartyDescription,
} from "../src/spreadsheet/counterparty-description-migrator.js";
import { EXPECTED_HEADERS } from "../src/spreadsheet/sheet-mapper.js";
import type { RawSheetRow } from "../src/spreadsheet/sheet-state.js";
import { sheetClient } from "./stage2-helpers.js";

const originalRows: RawSheetRow[] = [
  [1, "349", "입금", "기관 A", 1000, 10000, "빛쌤", "증빙 A", "비고 A", "KB-1234", "2026-07-17T01:00:00+09:00", "key-a"],
  [2, "", "출금", "기관 B", -500, 9500, "적요 B", "증빙 B", "비고 B", "KB-1234", "2026-07-17T01:00:00+09:00", "key-b"],
  [3, "거래처 C", "기타", "기관 C", 0, 9500, "", "증빙 C", "비고 C", "KB-1234", "2026-07-17T01:00:00+09:00", "key-c"],
];

const options = {
  dryRun: false,
  sheetsWriteEnabled: true,
  sheetName: "거래내역",
  now: "2026-07-17T14:30:00+09:00",
};

describe("counterparty/description data migration", () => {
  it("creates and verifies a backup, swaps only B/G, and records version 2", async () => {
    let rows = originalRows.map((row) => [...row]);
    let backup: RawSheetRow[] = [];
    const duplicateWorksheet = vi.fn((_: number, title: string) => {
      expect(title).toBe("거래내역_backup_swap_20260717_143000");
      backup = [[...EXPECTED_HEADERS], ...rows.map((row) => [...row])];
      return Promise.resolve(2);
    });
    const swapCounterpartyDescriptionColumns = vi.fn((request) => {
      expect(request).toMatchObject({
        sheetId: 1,
        metadataKey: LAYOUT_MAPPING_METADATA_KEY,
        metadataValue: "2",
        existingMetadataId: 41,
      });
      rows = rows.map((row) => {
        const updated = [...row];
        updated[1] = row[6] ?? "";
        updated[6] = row[1] ?? "";
        return updated;
      });
      return Promise.resolve();
    });
    const result = await migrateCounterpartyDescription(sheetClient({
      readDataRows: vi.fn(() => Promise.resolve(rows.map((row) => [...row]))),
      readSheetDeveloperMetadata: vi.fn().mockResolvedValue([{ metadataId: 41, value: "1" }]),
      duplicateWorksheet,
      readNamedSheetRows: vi.fn(() => Promise.resolve(backup.map((row) => [...row]))),
      swapCounterpartyDescriptionColumns,
    }), options);

    expect(result).toEqual({
      alreadyMigrated: false,
      backupCreated: true,
      backupSheetName: "거래내역_backup_swap_20260717_143000",
      originalRowCount: 3,
      updatedRowCount: 3,
      sourceKeysPreserved: true,
      evidenceNotesPreserved: true,
      migrationVersion: 2,
    });
    expect(rows[0]).toEqual([1, "빛쌤", "입금", "기관 A", 1000, 10000, "349", "증빙 A", "비고 A", "KB-1234", "2026-07-17T01:00:00+09:00", "key-a"]);
    expect(rows[1]?.[1]).toBe("적요 B");
    expect(rows[1]?.[6]).toBe("");
    expect(rows[2]?.[1]).toBe("");
    expect(rows[2]?.[6]).toBe("거래처 C");
    expect(rows.map((row) => row[7])).toEqual(originalRows.map((row) => row[7]));
    expect(rows.map((row) => row[8])).toEqual(originalRows.map((row) => row[8]));
    expect(rows.map((row) => row[11])).toEqual(originalRows.map((row) => row[11]));
    expect(duplicateWorksheet).toHaveBeenCalledOnce();
    expect(swapCounterpartyDescriptionColumns).toHaveBeenCalledOnce();
  });

  it("does not swap or back up again when version 2 is already present", async () => {
    const duplicateWorksheet = vi.fn();
    const swapCounterpartyDescriptionColumns = vi.fn();
    const result = await migrateCounterpartyDescription(sheetClient({
      readDataRows: vi.fn().mockResolvedValue(originalRows),
      readSheetDeveloperMetadata: vi.fn().mockResolvedValue([{ metadataId: 42, value: "2" }]),
      duplicateWorksheet,
      swapCounterpartyDescriptionColumns,
    }), options);
    expect(result).toMatchObject({
      alreadyMigrated: true,
      backupCreated: false,
      updatedRowCount: 0,
      migrationVersion: 2,
    });
    expect(duplicateWorksheet).not.toHaveBeenCalled();
    expect(swapCounterpartyDescriptionColumns).not.toHaveBeenCalled();
  });

  it("leaves the original untouched when backup verification fails", async () => {
    const swapCounterpartyDescriptionColumns = vi.fn();
    await expect(migrateCounterpartyDescription(sheetClient({
      readDataRows: vi.fn().mockResolvedValue(originalRows),
      readSheetDeveloperMetadata: vi.fn().mockResolvedValue([]),
      duplicateWorksheet: vi.fn().mockResolvedValue(2),
      readNamedSheetRows: vi.fn().mockResolvedValue([[...EXPECTED_HEADERS], ["wrong"]]),
      swapCounterpartyDescriptionColumns,
    }), options)).rejects.toMatchObject({ code: "SHEET_DATA_INVALID" });
    expect(swapCounterpartyDescriptionColumns).not.toHaveBeenCalled();
  });

  it("fails before creating a backup when sourceKeys are missing or duplicated", async () => {
    for (const invalidRows of [
      originalRows.map((row, index) => index === 0 ? [...row.slice(0, 11), ""] : row),
      originalRows.map((row, index) => index === 1 ? [...row.slice(0, 11), "key-a"] : row),
    ]) {
      const duplicateWorksheet = vi.fn();
      const swapCounterpartyDescriptionColumns = vi.fn();
      await expect(migrateCounterpartyDescription(sheetClient({
        readDataRows: vi.fn().mockResolvedValue(invalidRows),
        duplicateWorksheet,
        swapCounterpartyDescriptionColumns,
      }), options)).rejects.toBeTruthy();
      expect(duplicateWorksheet).not.toHaveBeenCalled();
      expect(swapCounterpartyDescriptionColumns).not.toHaveBeenCalled();
    }
  });
});
