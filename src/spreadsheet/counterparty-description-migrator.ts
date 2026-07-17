import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { SyncError } from "../sync/sync-errors.js";
import type { CounterpartyDescriptionMigrationOperations, SheetsClient } from "./google-sheets-client.js";
import { headersAreExact, type RawSheetRow } from "./sheet-state.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export const LAYOUT_MAPPING_METADATA_KEY = "kb_bank_sync_layout_mapping_version";
export const LAYOUT_MAPPING_VERSION = "2";

export interface CounterpartyDescriptionMigrationOptions {
  dryRun: boolean;
  sheetsWriteEnabled: boolean;
  sheetName: string;
  now?: string | Date;
}

export interface CounterpartyDescriptionMigrationResult {
  alreadyMigrated: boolean;
  backupCreated: boolean;
  backupSheetName: string | null;
  originalRowCount: number;
  updatedRowCount: number;
  sourceKeysPreserved: boolean;
  evidenceNotesPreserved: boolean;
  migrationVersion: number;
}

type MigrationClient = SheetsClient & CounterpartyDescriptionMigrationOperations;

function isEmptyRow(row: readonly RawSheetRow[number][]): boolean {
  return row.every((cell) => cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === ""));
}

function actualTransactionRows(rows: readonly RawSheetRow[]): RawSheetRow[] {
  let lastIndex = rows.length - 1;
  while (lastIndex >= 0 && isEmptyRow(rows[lastIndex] ?? [])) lastIndex -= 1;
  const actual = rows.slice(0, lastIndex + 1).map((row) => [...row]);
  if (actual.some(isEmptyRow)) {
    throw new SyncError("SHEET_DATA_INVALID", "실제 거래 행 사이에 빈 행이 있어 마이그레이션을 중단합니다");
  }
  return actual;
}

function sourceKeys(rows: readonly RawSheetRow[]): string[] {
  const keys = rows.map((row, index) => {
    if (row.length < 12) {
      throw new SyncError("SHEET_DATA_INVALID", `시트 ${index + 2}행의 열 수가 12개보다 적습니다`);
    }
    const key = String(row[11] ?? "").trim();
    if (key === "") throw new SyncError("SHEET_DATA_REQUIRES_MIGRATION", `시트 ${index + 2}행의 sourceKey가 비어 있습니다`);
    return key;
  });
  if (new Set(keys).size !== keys.length) {
    throw new SyncError("SHEET_DATA_INVALID", "중복 sourceKey가 있어 B/G 마이그레이션을 중단합니다");
  }
  return keys;
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index]);
}

function sameCell(left: unknown, right: unknown): boolean {
  return (left ?? "") === (right ?? "");
}

function sameRows(left: readonly RawSheetRow[], right: readonly RawSheetRow[]): boolean {
  return left.length === right.length && left.every((row, rowIndex) => {
    const other = right[rowIndex] ?? [];
    const width = Math.max(row.length, other.length);
    return Array.from({ length: width }, (_, index) => index).every((index) => sameCell(row[index], other[index]));
  });
}

function verifyOnlySwapped(before: readonly RawSheetRow[], after: readonly RawSheetRow[]): void {
  if (before.length !== after.length) throw new SyncError("SHEET_DATA_INVALID", "B/G 교환 후 거래 행 수가 달라졌습니다");
  const unchangedIndexes = [0, 2, 3, 4, 5, 7, 8, 9, 10, 11] as const;
  before.forEach((row, rowIndex) => {
    const updated = after[rowIndex] ?? [];
    if (!sameCell(updated[1], row[6]) || !sameCell(updated[6], row[1])) {
      throw new SyncError("SHEET_DATA_INVALID", `B/G 교환 후 ${rowIndex + 2}행 값이 예상과 다릅니다`);
    }
    if (unchangedIndexes.some((index) => !sameCell(updated[index], row[index]))) {
      throw new SyncError("SHEET_DATA_INVALID", `B/G 외 열이 ${rowIndex + 2}행에서 변경되었습니다`);
    }
  });
}

function timestamp(value?: string | Date): string {
  const parsed = value === undefined ? dayjs().tz("Asia/Seoul") : dayjs(value).tz("Asia/Seoul");
  if (!parsed.isValid()) throw new SyncError("CONFIGURATION_ERROR", "마이그레이션 실행 시각이 유효하지 않습니다");
  return parsed.format("YYYYMMDD_HHmmss");
}

function backupTitle(sheetName: string, now?: string | Date): string {
  const suffix = `_backup_swap_${timestamp(now)}`;
  const maximumBaseLength = Math.max(0, 100 - suffix.length);
  return `${sheetName.slice(0, maximumBaseLength)}${suffix}`;
}

export async function migrateCounterpartyDescription(
  client: MigrationClient,
  options: CounterpartyDescriptionMigrationOptions,
): Promise<CounterpartyDescriptionMigrationResult> {
  if (options.dryRun || !options.sheetsWriteEnabled) {
    throw new SyncError("SHEETS_WRITE_DISABLED", "B/G 마이그레이션에는 DRY_RUN=false와 ENABLE_SHEETS_WRITE=true가 필요합니다");
  }

  const worksheet = await client.getWorksheetInfo();
  if (!worksheet.exists || worksheet.sheetId === null) {
    throw new SyncError("SHEET_INITIALIZATION_REQUIRED", "B/G 마이그레이션 대상 워크시트가 없습니다");
  }
  const header = await client.readHeader();
  if (!headersAreExact(header)) {
    throw new SyncError("SHEET_HEADER_MISMATCH", "B/G 마이그레이션 대상 헤더가 현재 A:L 구조와 정확히 일치하지 않습니다");
  }
  const before = actualTransactionRows(await client.readDataRows());
  const keysBefore = sourceKeys(before);
  const metadata = await client.readSheetDeveloperMetadata(LAYOUT_MAPPING_METADATA_KEY, worksheet.sheetId);
  if (metadata.length > 1) throw new SyncError("SHEET_DATA_INVALID", "B/G 마이그레이션 metadata가 중복되어 있습니다");
  const currentVersion = metadata[0]?.value;
  if (currentVersion === LAYOUT_MAPPING_VERSION) {
    return {
      alreadyMigrated: true,
      backupCreated: false,
      backupSheetName: null,
      originalRowCount: before.length,
      updatedRowCount: 0,
      sourceKeysPreserved: true,
      evidenceNotesPreserved: true,
      migrationVersion: Number(LAYOUT_MAPPING_VERSION),
    };
  }
  if (currentVersion !== undefined && currentVersion !== "" && currentVersion !== "1") {
    throw new SyncError("SHEET_DATA_INVALID", `지원하지 않는 시트 매핑 버전입니다: ${currentVersion}`);
  }

  const backupSheetName = backupTitle(options.sheetName, options.now);
  await client.duplicateWorksheet(worksheet.sheetId, backupSheetName);
  const backup = await client.readNamedSheetRows(backupSheetName);
  const expectedBackup = [[...header], ...before];
  if (!sameRows(backup, expectedBackup)) {
    throw new SyncError("SHEET_DATA_INVALID", "백업 워크시트가 원본 데이터와 정확히 일치하지 않습니다");
  }
  if (!sameMultiset(sourceKeys(actualTransactionRows(backup.slice(1))), keysBefore)) {
    throw new SyncError("SHEET_DATA_INVALID", "백업 워크시트의 sourceKey가 원본과 일치하지 않습니다");
  }

  await client.swapCounterpartyDescriptionColumns({
    sheetId: worksheet.sheetId,
    rows: before,
    metadataKey: LAYOUT_MAPPING_METADATA_KEY,
    metadataValue: LAYOUT_MAPPING_VERSION,
    existingMetadataId: metadata[0]?.metadataId ?? null,
  });

  const after = actualTransactionRows(await client.readDataRows());
  verifyOnlySwapped(before, after);
  if (!sameMultiset(sourceKeys(after), keysBefore)) {
    throw new SyncError("SHEET_DATA_INVALID", "B/G 교환 전후 sourceKey multiset이 일치하지 않습니다");
  }

  return {
    alreadyMigrated: false,
    backupCreated: true,
    backupSheetName,
    originalRowCount: before.length,
    updatedRowCount: before.length,
    sourceKeysPreserved: true,
    evidenceNotesPreserved: true,
    migrationVersion: Number(LAYOUT_MAPPING_VERSION),
  };
}
