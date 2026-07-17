import { describe, expect, it, vi } from "vitest";

import { EXPECTED_HEADERS, LEGACY_HEADERS } from "../src/spreadsheet/sheet-mapper.js";
import { initializeSheet } from "../src/spreadsheet/sheet-initializer.js";
import { sheetClient } from "./stage2-helpers.js";

const layout = {
  systemColumnsHidden: true,
  frozenHeader: true,
  basicFilterApplied: true,
  bandingApplied: true,
  conditionalFormatRuleCount: 3,
  dataValidationApplied: true,
};

describe("sheet initializer", () => {
  it("creates a missing worksheet, writes A:L headers, and applies the user layout", async () => {
    const createWorksheet = vi.fn().mockResolvedValue(7);
    const writeHeader = vi.fn().mockResolvedValue(undefined);
    const applySheetLayout = vi.fn().mockResolvedValue(layout);
    const result = await initializeSheet(sheetClient({
      getWorksheetInfo: vi.fn().mockResolvedValue({ exists: false, sheetId: null }),
      createWorksheet, readHeader: vi.fn().mockResolvedValue([]), writeHeader, applySheetLayout,
    }), { dryRun: false, sheetsWriteEnabled: true });
    expect(result).toEqual({ worksheetCreated: true, headerCreated: true, layout });
    expect(createWorksheet).toHaveBeenCalledOnce();
    expect(writeHeader).toHaveBeenCalledOnce();
    expect(applySheetLayout).toHaveBeenCalledWith(7);
  });

  it("keeps an exact existing header and reapplies the layout idempotently", async () => {
    const writeHeader = vi.fn();
    const applySheetLayout = vi.fn().mockResolvedValue(layout);
    await initializeSheet(sheetClient({ readHeader: vi.fn().mockResolvedValue([...EXPECTED_HEADERS]), writeHeader, applySheetLayout }), {
      dryRun: false, sheetsWriteEnabled: true,
    });
    expect(writeHeader).not.toHaveBeenCalled();
    expect(applySheetLayout).toHaveBeenCalledOnce();
    await expect(initializeSheet(sheetClient({ readHeader: vi.fn().mockResolvedValue(["wrong"]) }), {
      dryRun: false, sheetsWriteEnabled: true,
    })).rejects.toMatchObject({ code: "SHEET_HEADER_MISMATCH" });
  });

  it("requires explicit migration for a populated legacy sheet", async () => {
    await expect(initializeSheet(sheetClient({
      readHeader: vi.fn().mockResolvedValue([...LEGACY_HEADERS]),
      readDataRows: vi.fn().mockResolvedValue([["legacy data"]]),
    }), { dryRun: false, sheetsWriteEnabled: true })).rejects.toMatchObject({ code: "SHEET_LAYOUT_MIGRATION_REQUIRED" });
  });

  it("updates an empty legacy sheet without creating a backup", async () => {
    const writeHeader = vi.fn();
    await initializeSheet(sheetClient({
      readHeader: vi.fn().mockResolvedValue([...LEGACY_HEADERS]), readDataRows: vi.fn().mockResolvedValue([]), writeHeader,
    }), { dryRun: false, sheetsWriteEnabled: true });
    expect(writeHeader).toHaveBeenCalledOnce();
  });

  it("does not mutate anything during dry-run", async () => {
    const createWorksheet = vi.fn();
    const writeHeader = vi.fn();
    const applySheetLayout = vi.fn();
    await expect(initializeSheet(sheetClient({
      getWorksheetInfo: vi.fn().mockResolvedValue({ exists: false, sheetId: null }), createWorksheet, writeHeader, applySheetLayout,
    }), { dryRun: true, sheetsWriteEnabled: true })).rejects.toMatchObject({ code: "SHEET_INITIALIZATION_REQUIRED" });
    expect(createWorksheet).not.toHaveBeenCalled();
    expect(writeHeader).not.toHaveBeenCalled();
    expect(applySheetLayout).not.toHaveBeenCalled();
  });
});
