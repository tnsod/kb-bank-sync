import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { SyncError } from "../sync/sync-errors.js";
import type { SheetLayoutResult, SheetMigrationOperations, SheetsClient } from "./google-sheets-client.js";
import { EXPECTED_HEADERS, legacyRowToNewRow, type SheetRow } from "./sheet-mapper.js";
import { buildExistingSheetState, headersAreExact, headersAreLegacy, type RawSheetRow } from "./sheet-state.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export type SheetMigrationClient = SheetsClient & SheetMigrationOperations;

export interface SheetMigrationResult {
  alreadyMigrated: boolean;
  backupCreated: boolean;
  backupSheetName: string | null;
  originalRowCount: number;
  migratedRowCount: number;
  sourceKeysPreserved: boolean;
  layout: SheetLayoutResult;
}

function nonEmptyRows(rows: readonly RawSheetRow[]): RawSheetRow[] {
  return rows.filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
}

function sourceKeys(rows: readonly RawSheetRow[], index: number): string[] {
  return rows.map((row) => String(row[index] ?? "").trim());
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function timestamp(value?: string | Date): string {
  const parsed = value === undefined ? dayjs().tz("Asia/Seoul") : dayjs(value).tz("Asia/Seoul");
  if (!parsed.isValid()) throw new SyncError("CONFIGURATION_ERROR", "마이그레이션 실행 시각이 유효하지 않습니다");
  return parsed.format("YYYYMMDD_HHmmss");
}

function limitedTitle(prefix: string, suffix: string): string {
  return `${prefix.slice(0, Math.max(1, 99 - suffix.length))}_${suffix}`;
}

function validateLegacyRows(rows: readonly RawSheetRow[], expectedAccountId: string): SheetRow[] {
  return rows.map((row) => {
    const key = String(row[10] ?? "").trim();
    if (key === "") throw new SyncError("SHEET_DATA_REQUIRES_MIGRATION", "sourceKey가 없는 구형 행은 자동 마이그레이션할 수 없습니다");
    if (String(row[8] ?? "").trim() !== expectedAccountId) {
      throw new SyncError("SHEET_DATA_INVALID", "다른 계좌식별자가 포함된 시트는 마이그레이션할 수 없습니다");
    }
    return legacyRowToNewRow(row);
  });
}

export async function migrateSheetLayout(
  client: SheetMigrationClient,
  options: { dryRun: boolean; sheetsWriteEnabled: boolean; expectedAccountId: string; sheetName: string; now?: string | Date },
): Promise<SheetMigrationResult> {
  if (options.dryRun) throw new SyncError("SHEETS_WRITE_DISABLED", "Dry-run에서는 시트 레이아웃을 마이그레이션할 수 없습니다");
  if (!options.sheetsWriteEnabled) throw new SyncError("SHEETS_WRITE_DISABLED", "마이그레이션에는 ENABLE_SHEETS_WRITE=true가 필요합니다");
  const info = await client.getWorksheetInfo();
  if (!info.exists || info.sheetId === null) throw new SyncError("SHEET_INITIALIZATION_REQUIRED", "마이그레이션할 워크시트가 없습니다");
  const header = await client.readHeader();
  if (headersAreExact(header)) {
    const rows = nonEmptyRows(await client.readDataRows());
    const state = buildExistingSheetState(rows, options.expectedAccountId);
    if (state.missingSourceKeyRowCount > 0 || state.invalidDateRowCount > 0 || state.shortRowCount > 0 || state.differentAccountIdRowCount > 0) {
      throw new SyncError("SHEET_DATA_INVALID", "새 레이아웃 시트 데이터가 유효하지 않습니다");
    }
    return {
      alreadyMigrated: true,
      backupCreated: false,
      backupSheetName: null,
      originalRowCount: state.rowCount,
      migratedRowCount: state.rowCount,
      sourceKeysPreserved: true,
      layout: await client.applySheetLayout(info.sheetId),
    };
  }
  if (!headersAreLegacy(header)) throw new SyncError("SHEET_HEADER_MISMATCH", "지원되는 구형 또는 신형 헤더가 아닙니다");

  const legacyRows = nonEmptyRows(await client.readDataRows());
  if (legacyRows.length === 0) {
    throw new SyncError("SHEET_LAYOUT_MIGRATION_REQUIRED", "데이터가 없는 구형 시트는 --initialize-sheet로 초기화하십시오");
  }
  const migratedRows = validateLegacyRows(legacyRows, options.expectedAccountId);
  const originalKeys = sourceKeys(legacyRows, 10);
  const suffix = timestamp(options.now);
  const backupSheetName = limitedTitle(options.sheetName, `backup_${suffix}`);
  const temporarySheetName = limitedTitle(options.sheetName, `migration_${suffix}`);
  const temporaryOldTitle = limitedTitle(options.sheetName, `legacy_${suffix}`);

  await client.duplicateWorksheet(info.sheetId, backupSheetName);
  const backupRows = await client.readNamedSheetRows(backupSheetName);
  const backupData = nonEmptyRows(backupRows.slice(1));
  if (backupData.length !== legacyRows.length || !sameMultiset(sourceKeys(backupData, 10), originalKeys)) {
    throw new SyncError("SHEET_DATA_INVALID", "백업 워크시트 검증에 실패했습니다");
  }

  const temporarySheetId = await client.createNamedWorksheet(temporarySheetName);
  await client.writeNamedSheetRows(temporarySheetName, [[...EXPECTED_HEADERS], ...migratedRows]);
  const temporaryRows = await client.readNamedSheetRows(temporarySheetName);
  if (!headersAreExact(temporaryRows[0] ?? [])) throw new SyncError("SHEET_DATA_INVALID", "임시 워크시트 헤더 검증에 실패했습니다");
  const temporaryData = nonEmptyRows(temporaryRows.slice(1));
  const temporaryState = buildExistingSheetState(temporaryData, options.expectedAccountId);
  const preserved = sameMultiset(sourceKeys(temporaryData, 11), originalKeys);
  if (temporaryState.rowCount !== legacyRows.length || temporaryState.missingSourceKeyRowCount > 0
    || temporaryState.invalidDateRowCount > 0 || temporaryState.shortRowCount > 0
    || temporaryState.differentAccountIdRowCount > 0 || !preserved) {
    throw new SyncError("SHEET_DATA_INVALID", "임시 워크시트 데이터 검증에 실패했습니다");
  }
  const layout = await client.applySheetLayout(temporarySheetId);
  await client.replaceWorksheet(info.sheetId, temporarySheetId, options.sheetName, temporaryOldTitle);

  const finalRows = await client.readNamedSheetRows(options.sheetName);
  const finalData = nonEmptyRows(finalRows.slice(1));
  if (!headersAreExact(finalRows[0] ?? []) || finalData.length !== legacyRows.length
    || !sameMultiset(sourceKeys(finalData, 11), originalKeys)) {
    throw new SyncError("SHEET_DATA_INVALID", "교체된 워크시트 최종 검증에 실패했습니다");
  }
  return {
    alreadyMigrated: false,
    backupCreated: true,
    backupSheetName,
    originalRowCount: legacyRows.length,
    migratedRowCount: finalData.length,
    sourceKeysPreserved: true,
    layout,
  };
}
