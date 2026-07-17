import { describe, expect, it } from "vitest";

import { EXPECTED_HEADERS, LEGACY_HEADERS, occurredAtToSheetsSerial } from "../src/spreadsheet/sheet-mapper.js";
import { buildExistingSheetState, headersAreExact, headersAreLegacy, type RawSheetRow } from "../src/spreadsheet/sheet-state.js";

function row(date: string | number, accountId = "KB-1234", sourceKey = "key-1"): RawSheetRow {
  return [date, "counterparty", "입금", "institution", 1000, 2000, "memo", "user evidence", "user note",
    accountId, "2026-07-16T00:00:00+09:00", sourceKey];
}

describe("sheet state", () => {
  it("validates exact new and legacy headers", () => {
    expect(headersAreExact(EXPECTED_HEADERS)).toBe(true);
    expect(headersAreLegacy(LEGACY_HEADERS)).toBe(true);
    expect(headersAreExact([...EXPECTED_HEADERS.slice(0, 11), "wrong"])).toBe(false);
    expect(headersAreExact([])).toBe(false);
  });

  it("handles empty and header-only sheets", () => {
    expect(buildExistingSheetState([], "KB-1234")).toMatchObject({ rowCount: 0, latestOccurredAt: null });
  });

  it("finds the latest A-column date across sorted or unsorted rows and accepts Sheets date serials", () => {
    const state = buildExistingSheetState([
      row("2026-07-15T10:00:00+09:00", "KB-1234", "a"),
      row(occurredAtToSheetsSerial("2026-07-10T10:00:00+09:00"), "KB-1234", "b"),
      row(occurredAtToSheetsSerial("2026-07-16T09:00:00+09:00"), "KB-1234", "c"),
    ], "KB-1234");
    expect(state.latestOccurredAt).toBe("2026-07-16T09:00:00+09:00");
  });

  it("ignores user-managed H/I cells while validating J account IDs and L sourceKeys", () => {
    const state = buildExistingSheetState([row("2026-07-15T10:00:00+09:00")], "KB-1234");
    expect(state).toMatchObject({ rowCount: 1, differentAccountIdRowCount: 0, missingSourceKeyRowCount: 0 });
  });

  it("detects missing and duplicate keys, invalid dates, short rows, other accounts, and data gaps", () => {
    const state = buildExistingSheetState([
      row("invalid", "KB-9999", "dup"), [], row("2026-07-15T10:00:00+09:00", "KB-1234", "dup"),
      row("2026-07-14T10:00:00+09:00", "KB-1234", "").slice(0, 11),
    ], "KB-1234");
    expect(state).toMatchObject({
      rowCount: 3, invalidDateRowCount: 1, missingSourceKeyRowCount: 1, shortRowCount: 1,
      differentAccountIdRowCount: 1, dataAfterEmptyRowCount: 2,
    });
    expect(state.duplicateSourceKeys).toEqual(["dup"]);
    expect(state.invalidDateRows).toEqual([{ rowNumber: 2, errorType: "invalid_occurred_at" }]);
  });
});
