import dayjs from "dayjs";

import { EXPECTED_HEADERS, LEGACY_HEADERS, sheetsSerialToOccurredAt, type SheetCell } from "./sheet-mapper.js";

const ISO_OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u;

export interface ExistingSheetState {
  sourceKeys: Set<string>;
  latestOccurredAt: string | null;
  rowCount: number;
  duplicateSourceKeys: string[];
  invalidDateRowCount: number;
  missingSourceKeyRowCount: number;
  shortRowCount: number;
  differentAccountIdRowCount: number;
  dataAfterEmptyRowCount: number;
  invalidDateRows: Array<{ rowNumber: number; errorType: "invalid_occurred_at" }>;
}

export type RawSheetRow = Array<SheetCell | null>;

export function headersAreExact(headers: readonly unknown[]): boolean {
  return headers.length === EXPECTED_HEADERS.length && EXPECTED_HEADERS.every((header, index) => headers[index] === header);
}

export function headersAreLegacy(headers: readonly unknown[]): boolean {
  return headers.length === LEGACY_HEADERS.length && LEGACY_HEADERS.every((header, index) => headers[index] === header);
}

function occurredAtFromCell(cell: SheetCell | null | undefined): string | null {
  if (typeof cell === "number") return sheetsSerialToOccurredAt(cell);
  if (typeof cell !== "string") return null;
  const value = cell.trim();
  return ISO_OCCURRED_AT.test(value) && dayjs(value).isValid() ? value : null;
}

export function buildExistingSheetState(rows: readonly RawSheetRow[], expectedAccountId: string): ExistingSheetState {
  const sourceKeys = new Set<string>();
  const duplicateSourceKeys = new Set<string>();
  const invalidDateRows: ExistingSheetState["invalidDateRows"] = [];
  let latestOccurredAt: string | null = null;
  let rowCount = 0;
  let missingSourceKeyRowCount = 0;
  let shortRowCount = 0;
  let differentAccountIdRowCount = 0;
  let dataAfterEmptyRowCount = 0;
  let emptyRowSeen = false;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const empty = row.every((cell) => cell === null || String(cell).trim() === "");
    if (empty) {
      emptyRowSeen = true;
      return;
    }
    rowCount += 1;
    if (emptyRowSeen) dataAfterEmptyRowCount += 1;
    if (row.length < EXPECTED_HEADERS.length) shortRowCount += 1;
    const occurredAt = occurredAtFromCell(row[0]);
    const parsed = occurredAt === null ? null : dayjs(occurredAt);
    if (occurredAt === null || parsed === null || !parsed.isValid()) invalidDateRows.push({ rowNumber, errorType: "invalid_occurred_at" });
    else if (latestOccurredAt === null || parsed.valueOf() > dayjs(latestOccurredAt).valueOf()) latestOccurredAt = occurredAt;

    const accountId = String(row[9] ?? "").trim();
    if (accountId !== expectedAccountId) differentAccountIdRowCount += 1;
    const sourceKey = String(row[11] ?? "").trim();
    if (sourceKey === "") missingSourceKeyRowCount += 1;
    else if (sourceKeys.has(sourceKey)) duplicateSourceKeys.add(sourceKey);
    else sourceKeys.add(sourceKey);
  });

  return {
    sourceKeys,
    latestOccurredAt,
    rowCount,
    duplicateSourceKeys: [...duplicateSourceKeys],
    invalidDateRowCount: invalidDateRows.length,
    missingSourceKeyRowCount,
    shortRowCount,
    differentAccountIdRowCount,
    dataAfterEmptyRowCount,
    invalidDateRows,
  };
}
