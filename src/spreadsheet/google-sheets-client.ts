import { google, type sheets_v4 } from "googleapis";

import type { Transaction } from "../transaction/transaction.js";
import { SyncError } from "../sync/sync-errors.js";
import { classifyGoogleApiError } from "./google-api-errors.js";
import type { GoogleSetupDiagnostic } from "./google-auth.js";
import { assertSheetsWriteAllowed, type SheetsWriteGuard } from "./write-guard.js";
import { transactionToSheetRow } from "./sheet-mapper.js";
import type { RawSheetRow } from "./sheet-state.js";

export interface WorksheetInfo {
  exists: boolean;
  sheetId: number | null;
}

export interface AppendResult {
  appendedRowCount: number;
  updatedRange: string | null;
}

export interface SheetLayoutResult {
  systemColumnsHidden: boolean;
  frozenHeader: boolean;
  basicFilterApplied: boolean;
  bandingApplied: boolean;
  conditionalFormatRuleCount: number;
  dataValidationApplied: boolean;
}

export interface SheetMigrationOperations {
  duplicateWorksheet(sourceSheetId: number, title: string): Promise<number>;
  createNamedWorksheet(title: string): Promise<number>;
  writeNamedSheetRows(title: string, rows: readonly RawSheetRow[]): Promise<void>;
  readNamedSheetRows(title: string): Promise<RawSheetRow[]>;
  replaceWorksheet(originalSheetId: number, replacementSheetId: number, originalTitle: string, temporaryOldTitle: string): Promise<void>;
  deleteWorksheet(sheetId: number): Promise<void>;
}

export interface SheetDeveloperMetadata {
  metadataId: number;
  value: string;
}

export interface CounterpartyDescriptionSwapRequest {
  sheetId: number;
  rows: readonly RawSheetRow[];
  metadataKey: string;
  metadataValue: string;
  existingMetadataId: number | null;
}

export interface CounterpartyDescriptionMigrationOperations {
  readSheetDeveloperMetadata(metadataKey: string, sheetId: number): Promise<SheetDeveloperMetadata[]>;
  swapCounterpartyDescriptionColumns(request: CounterpartyDescriptionSwapRequest): Promise<void>;
}

export interface GoogleApiCallCounts {
  metadataRead: number;
  headerRead: number;
  dataRead: number;
  append: number;
  sourceKeyVerificationRead: number;
  batchUpdate: number;
  headerWrite: number;
}

export interface SheetsClient extends SheetMigrationOperations, CounterpartyDescriptionMigrationOperations {
  getWorksheetInfo(): Promise<WorksheetInfo>;
  createWorksheet(): Promise<number>;
  readHeader(): Promise<RawSheetRow>;
  readDataRows(purpose?: "state" | "source_key_verification"): Promise<RawSheetRow[]>;
  writeHeader(): Promise<void>;
  applySheetLayout(sheetId: number): Promise<SheetLayoutResult>;
  appendTransactions(transactions: readonly Transaction[], guard: SheetsWriteGuard): Promise<AppendResult>;
  getApiCallCounts?(): GoogleApiCallCounts;
}

function quoteSheetName(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

function normalizeRows(values: unknown[][] | null | undefined): RawSheetRow[] {
  return (values ?? []).map((row) => row.map((cell) => {
    if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") return cell;
    return null;
  }));
}

function extendedValue(cell: RawSheetRow[number] | undefined): sheets_v4.Schema$ExtendedValue {
  if (typeof cell === "number") return { numberValue: cell };
  if (typeof cell === "boolean") return { boolValue: cell };
  return { stringValue: cell === null || cell === undefined ? "" : cell };
}

function statusFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; response?: { status?: unknown } };
  if (typeof candidate.response?.status === "number") return candidate.response.status;
  return typeof candidate.code === "number" ? candidate.code : undefined;
}

export function isUncertainAppendError(error: unknown): boolean {
  const status = statusFromError(error);
  if (status !== undefined) return status >= 500;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  return /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|socket hang up|timeout/iu.test(`${code} ${message}`);
}

export function isGoogleAuthenticationError(error: unknown): boolean {
  const status = statusFromError(error);
  return status === 401 || status === 403;
}

export class GoogleSheetsClient implements SheetsClient {
  private readonly api: sheets_v4.Sheets;
  private appendSucceeded = false;
  private readonly callCounts: GoogleApiCallCounts = {
    metadataRead: 0, headerRead: 0, dataRead: 0, append: 0,
    sourceKeyVerificationRead: 0, batchUpdate: 0, headerWrite: 0,
  };

  constructor(
    auth: NonNullable<sheets_v4.Options["auth"]>,
    private readonly spreadsheetId: string,
    private readonly sheetName: string,
    private readonly diagnostic?: GoogleSetupDiagnostic,
  ) {
    this.api = google.sheets({ version: "v4", auth });
  }

  async getWorksheetInfo(): Promise<WorksheetInfo> {
    this.callCounts.metadataRead += 1;
    try {
      const response = await this.api.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: "sheets.properties(sheetId,title)",
      });
      const match = response.data.sheets?.find((sheet) => sheet.properties?.title === this.sheetName);
      this.diagnostic?.("spreadsheet_metadata_read", true);
      return { exists: match !== undefined, sheetId: match?.properties?.sheetId ?? null };
    } catch (error) {
      throw classifyGoogleApiError(error, "SPREADSHEET_NOT_FOUND");
    }
  }

  async createWorksheet(): Promise<number> {
    this.callCounts.batchUpdate += 1;
    try {
      const response = await this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: this.sheetName } } }] },
    });
      const sheetId = response.data.replies?.[0]?.addSheet?.properties?.sheetId;
      if (sheetId === undefined || sheetId === null) throw new SyncError("SHEET_INITIALIZATION_FAILED", "생성된 워크시트 ID를 확인하지 못했습니다");
      return sheetId;
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
  }

  async readHeader(): Promise<RawSheetRow> {
    this.callCounts.headerRead += 1;
    try {
      const response = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(this.sheetName)}!A1:L1`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
      return normalizeRows(response.data.values)[0] ?? [];
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
  }

  async readDataRows(purpose: "state" | "source_key_verification" = "state"): Promise<RawSheetRow[]> {
    if (purpose === "source_key_verification") this.callCounts.sourceKeyVerificationRead += 1;
    else this.callCounts.dataRead += 1;
    try {
      const response = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(this.sheetName)}!A2:L`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
      return normalizeRows(response.data.values);
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_DATA_INVALID");
    }
  }

  async readSheetDeveloperMetadata(metadataKey: string, sheetId: number): Promise<SheetDeveloperMetadata[]> {
    this.callCounts.metadataRead += 1;
    try {
      const response = await this.api.spreadsheets.developerMetadata.search({
        spreadsheetId: this.spreadsheetId,
        requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey, locationType: "SHEET" } }] },
      });
      return (response.data.matchedDeveloperMetadata ?? [])
        .map((match) => match.developerMetadata)
        .filter((metadata): metadata is sheets_v4.Schema$DeveloperMetadata => metadata?.location?.sheetId === sheetId)
        .map((metadata) => {
          if (metadata.metadataId === undefined || metadata.metadataId === null) {
            throw new SyncError("SHEET_DATA_INVALID", "마이그레이션 metadata ID를 확인할 수 없습니다");
          }
          return { metadataId: metadata.metadataId, value: metadata.metadataValue ?? "" };
        });
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw classifyGoogleApiError(error, "SHEET_DATA_INVALID");
    }
  }

  async swapCounterpartyDescriptionColumns(request: CounterpartyDescriptionSwapRequest): Promise<void> {
    const rowsForColumn = (sourceColumnIndex: number): sheets_v4.Schema$RowData[] => request.rows.map((row) => ({
      values: [{ userEnteredValue: extendedValue(row[sourceColumnIndex]) }],
    }));
    const requests: sheets_v4.Schema$Request[] = [];
    if (request.rows.length > 0) {
      requests.push(
        { updateCells: {
          range: { sheetId: request.sheetId, startRowIndex: 1, endRowIndex: request.rows.length + 1, startColumnIndex: 1, endColumnIndex: 2 },
          rows: rowsForColumn(6), fields: "userEnteredValue",
        } },
        { updateCells: {
          range: { sheetId: request.sheetId, startRowIndex: 1, endRowIndex: request.rows.length + 1, startColumnIndex: 6, endColumnIndex: 7 },
          rows: rowsForColumn(1), fields: "userEnteredValue",
        } },
      );
    }
    if (request.existingMetadataId === null) {
      requests.push({ createDeveloperMetadata: { developerMetadata: {
        metadataKey: request.metadataKey,
        metadataValue: request.metadataValue,
        visibility: "DOCUMENT",
        location: { sheetId: request.sheetId },
      } } });
    } else {
      requests.push({ updateDeveloperMetadata: {
        dataFilters: [{ developerMetadataLookup: { metadataId: request.existingMetadataId } }],
        developerMetadata: { metadataValue: request.metadataValue },
        fields: "metadataValue",
      } });
    }
    this.callCounts.batchUpdate += 1;
    try {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests },
      });
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_DATA_INVALID");
    }
  }

  async writeHeader(): Promise<void> {
    this.callCounts.headerWrite += 1;
    const { EXPECTED_HEADERS } = await import("./sheet-mapper.js");
    try {
      await this.api.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(this.sheetName)}!A1:L1`,
      valueInputOption: "RAW",
      requestBody: { values: [[...EXPECTED_HEADERS]] },
      });
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
  }

  async applySheetLayout(sheetId: number): Promise<SheetLayoutResult> {
    this.callCounts.metadataRead += 1;
    let sheet: sheets_v4.Schema$Sheet | undefined;
    try {
      const response = await this.api.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: "sheets(properties(sheetId,gridProperties(rowCount)),basicFilter,bandedRanges(bandedRangeId,range,rowProperties),conditionalFormats(ranges,booleanRule(condition,format(backgroundColorStyle))))",
      });
      sheet = response.data.sheets?.find((candidate) => candidate.properties?.sheetId === sheetId);
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
    if (sheet === undefined) throw new SyncError("SHEET_INITIALIZATION_FAILED", "서식 적용 대상 워크시트를 찾을 수 없습니다");

    const logicalRange: sheets_v4.Schema$GridRange = { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 12 };
    const filterRange: sheets_v4.Schema$GridRange = { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 9 };
    const bodyRange = (startColumnIndex: number, endColumnIndex: number): sheets_v4.Schema$GridRange => ({
      sheetId, startRowIndex: 1, startColumnIndex, endColumnIndex,
    });
    const colorMatches = (color: sheets_v4.Schema$Color | null | undefined,
      expected: { red: number; green: number; blue: number }): boolean => color !== null && color !== undefined
      && Math.abs((color.red ?? -1) - expected.red) < 0.01
      && Math.abs((color.green ?? -1) - expected.green) < 0.01
      && Math.abs((color.blue ?? -1) - expected.blue) < 0.01;
    const headerColor = { red: 0.10, green: 0.32, blue: 0.20 };
    const firstBandColor = { red: 1, green: 1, blue: 1 };
    const secondBandColor = { red: 0.93, green: 0.97, blue: 0.94 };
    const managedBandings = (sheet.bandedRanges ?? []).filter((banding) => banding.range?.sheetId === sheetId
      && (banding.range.startRowIndex ?? 0) === 0 && (banding.range.startColumnIndex ?? 0) === 0
      && (banding.range.endColumnIndex === 9 || banding.range.endColumnIndex === 12));
    const managedBandingIsExact = managedBandings.length === 1 && managedBandings[0]?.range?.endColumnIndex === 12
      && colorMatches(managedBandings[0]?.rowProperties?.headerColorStyle?.rgbColor, headerColor)
      && colorMatches(managedBandings[0]?.rowProperties?.firstBandColorStyle?.rgbColor, firstBandColor)
      && colorMatches(managedBandings[0]?.rowProperties?.secondBandColorStyle?.rgbColor, secondBandColor);
    const conditionalFormats: Array<{ value: string; red: number; green: number; blue: number }> = [
      { value: "입금", red: 0.82, green: 0.94, blue: 0.84 },
      { value: "출금", red: 0.84, green: 0.90, blue: 0.98 },
      { value: "기타", red: 0.90, green: 0.90, blue: 0.90 },
    ];
    const desiredConditionalRange = bodyRange(2, 3);
    const managedValues = new Set(conditionalFormats.map((format) => format.value));
    const currentConditionalFormats = sheet.conditionalFormats ?? [];
    const managedConditionalRuleIndices = currentConditionalFormats.flatMap((rule, index) => {
      const value = rule.booleanRule?.condition?.values?.[0]?.userEnteredValue;
      return rule.booleanRule?.condition?.type === "TEXT_EQ" && value !== undefined && value !== null
        && managedValues.has(value) ? [index] : [];
    });
    const rangeMatches = (range: sheets_v4.Schema$GridRange | null | undefined): boolean => range?.sheetId === sheetId
      && (range.startRowIndex ?? 0) === 1
      && (range.endRowIndex === undefined || range.endRowIndex === sheet.properties?.gridProperties?.rowCount)
      && range.startColumnIndex === 2 && range.endColumnIndex === 3;
    const managedConditionalRulesAreExact = managedConditionalRuleIndices.length === conditionalFormats.length
      && conditionalFormats.every((expected) => currentConditionalFormats.some((rule) => {
        const condition = rule.booleanRule?.condition;
        const values = condition?.values ?? [];
        const ranges = rule.ranges ?? [];
        return condition?.type === "TEXT_EQ" && values.length === 1 && values[0]?.userEnteredValue === expected.value
          && ranges.length === 1 && rangeMatches(ranges[0])
          && colorMatches(rule.booleanRule?.format?.backgroundColorStyle?.rgbColor, expected);
      }));

    const requests: sheets_v4.Schema$Request[] = [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 12 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } },
      { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 36 }, fields: "pixelSize" } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 }, cell: { userEnteredFormat: {
        backgroundColorStyle: { rgbColor: headerColor },
        textFormat: { foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } }, bold: true },
        horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP",
      } }, fields: "userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)" } },
      { repeatCell: { range: bodyRange(0, 12), cell: { userEnteredFormat: {
        textFormat: { foregroundColorStyle: { rgbColor: { red: 0, green: 0, blue: 0 } },
          bold: false, italic: false, strikethrough: false, underline: false }, verticalAlignment: "MIDDLE",
      } }, fields: "userEnteredFormat(backgroundColorStyle,textFormat.foregroundColorStyle,textFormat.bold,textFormat.italic,textFormat.strikethrough,textFormat.underline,verticalAlignment)" } },
      { repeatCell: { range: bodyRange(0, 1), cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "yyyy-MM-dd HH:mm:ss" }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat(numberFormat,horizontalAlignment)" } },
      { repeatCell: { range: bodyRange(2, 3), cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat.horizontalAlignment" } },
      { repeatCell: { range: bodyRange(4, 6), cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0;-#,##0" }, horizontalAlignment: "RIGHT" } }, fields: "userEnteredFormat(numberFormat,horizontalAlignment)" } },
      { repeatCell: { range: bodyRange(6, 9), cell: { userEnteredFormat: { horizontalAlignment: "LEFT", wrapStrategy: "WRAP" } }, fields: "userEnteredFormat(horizontalAlignment,wrapStrategy)" } },
      { repeatCell: { range: bodyRange(9, 10), cell: { userEnteredFormat: { numberFormat: { type: "TEXT", pattern: "@" }, horizontalAlignment: "LEFT" } }, fields: "userEnteredFormat(numberFormat,horizontalAlignment)" } },
      { repeatCell: { range: bodyRange(10, 11), cell: { userEnteredFormat: { numberFormat: { type: "TEXT", pattern: "@" }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat(numberFormat,horizontalAlignment)" } },
      { repeatCell: { range: bodyRange(11, 12), cell: { userEnteredFormat: { numberFormat: { type: "TEXT", pattern: "@" }, horizontalAlignment: "LEFT" } }, fields: "userEnteredFormat(numberFormat,horizontalAlignment)" } },
      { setBasicFilter: { filter: { range: filterRange } } },
      { setDataValidation: { range: bodyRange(2, 3), rule: { condition: { type: "ONE_OF_LIST", values: [
        { userEnteredValue: "입금" }, { userEnteredValue: "출금" }, { userEnteredValue: "기타" },
      ] }, strict: true, showCustomUi: true } } },
    ];
    const widths = [170, 170, 110, 170, 140, 150, 230, 150, 230];
    widths.forEach((pixelSize, index) => requests.push({ updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 }, properties: { pixelSize }, fields: "pixelSize",
    } }));
    if (!managedBandingIsExact) {
      for (const banding of managedBandings) {
        if (banding.bandedRangeId !== undefined && banding.bandedRangeId !== null) {
          requests.push({ deleteBanding: { bandedRangeId: banding.bandedRangeId } });
        }
      }
      requests.push({ addBanding: { bandedRange: { range: logicalRange, rowProperties: {
        headerColorStyle: { rgbColor: headerColor }, firstBandColorStyle: { rgbColor: firstBandColor },
        secondBandColorStyle: { rgbColor: secondBandColor },
      } } } });
    }
    if (!managedConditionalRulesAreExact) {
      for (const index of [...managedConditionalRuleIndices].sort((left, right) => right - left)) {
        requests.push({ deleteConditionalFormatRule: { sheetId, index } });
      }
      let conditionalIndex = currentConditionalFormats.length - managedConditionalRuleIndices.length;
      for (const format of conditionalFormats) {
        requests.push({ addConditionalFormatRule: { index: conditionalIndex, rule: {
          ranges: [desiredConditionalRange],
          booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: format.value }] },
            format: { backgroundColorStyle: { rgbColor: { red: format.red, green: format.green, blue: format.blue } } } },
        } } });
        conditionalIndex += 1;
      }
    }
    this.callCounts.batchUpdate += 1;
    try {
      await this.api.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } });
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
    return {
      systemColumnsHidden: true,
      frozenHeader: true,
      basicFilterApplied: true,
      bandingApplied: true,
      conditionalFormatRuleCount: conditionalFormats.length,
      dataValidationApplied: true,
    };
  }

  async appendTransactions(transactions: readonly Transaction[], guard: SheetsWriteGuard): Promise<AppendResult> {
    assertSheetsWriteAllowed(guard);
    if (this.appendSucceeded) throw new SyncError("SHEETS_WRITE_GUARD_REJECTED", "동일 실행에서 완료된 append를 다시 호출할 수 없습니다");
    if (transactions.length !== guard.newTransactionCount) {
      throw new SyncError("SHEETS_WRITE_GUARD_REJECTED", "쓰기 보호 건수와 append 거래 건수가 일치하지 않습니다");
    }
    try {
      this.callCounts.append += 1;
      const response = await this.api.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${quoteSheetName(this.sheetName)}!A:L`,
      valueInputOption: "RAW",
      insertDataOption: "OVERWRITE",
      requestBody: { values: transactions.map(transactionToSheetRow) },
    });
      const appendedRowCount = response.data.updates?.updatedRows ?? 0;
      if (appendedRowCount === transactions.length) this.appendSucceeded = true;
      return { appendedRowCount, updatedRange: response.data.updates?.updatedRange ?? null };
    } catch (error) {
      throw classifyGoogleApiError(error, "GOOGLE_APPEND_FAILED");
    }
  }

  async duplicateWorksheet(sourceSheetId: number, title: string): Promise<number> {
    this.callCounts.batchUpdate += 1;
    try {
      const response = await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [{ duplicateSheet: { sourceSheetId, newSheetName: title } }] },
      });
      const sheetId = response.data.replies?.[0]?.duplicateSheet?.properties?.sheetId;
      if (sheetId === undefined || sheetId === null) throw new SyncError("SHEET_INITIALIZATION_FAILED", "백업 워크시트 ID를 확인할 수 없습니다");
      return sheetId;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
  }

  async createNamedWorksheet(title: string): Promise<number> {
    this.callCounts.batchUpdate += 1;
    try {
      const response = await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      });
      const sheetId = response.data.replies?.[0]?.addSheet?.properties?.sheetId;
      if (sheetId === undefined || sheetId === null) throw new SyncError("SHEET_INITIALIZATION_FAILED", "임시 워크시트 ID를 확인할 수 없습니다");
      return sheetId;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
  }

  async writeNamedSheetRows(title: string, rows: readonly RawSheetRow[]): Promise<void> {
    try {
      await this.api.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${quoteSheetName(title)}!A1:L${Math.max(rows.length, 1)}`,
        valueInputOption: "RAW",
        requestBody: { values: rows.map((row) => row.map((cell) => cell ?? "")) },
      });
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
  }

  async readNamedSheetRows(title: string): Promise<RawSheetRow[]> {
    try {
      const response = await this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${quoteSheetName(title)}!A1:L`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      return normalizeRows(response.data.values);
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_DATA_INVALID");
    }
  }

  async replaceWorksheet(
    originalSheetId: number,
    replacementSheetId: number,
    originalTitle: string,
    temporaryOldTitle: string,
  ): Promise<void> {
    this.callCounts.batchUpdate += 1;
    try {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [
          { updateSheetProperties: { properties: { sheetId: originalSheetId, title: temporaryOldTitle }, fields: "title" } },
          { updateSheetProperties: { properties: { sheetId: replacementSheetId, title: originalTitle }, fields: "title" } },
          { deleteSheet: { sheetId: originalSheetId } },
        ] },
      });
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
  }

  async deleteWorksheet(sheetId: number): Promise<void> {
    this.callCounts.batchUpdate += 1;
    try {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [{ deleteSheet: { sheetId } }] },
      });
    } catch (error) {
      throw classifyGoogleApiError(error, "SHEET_INITIALIZATION_FAILED");
    }
  }

  getApiCallCounts(): GoogleApiCallCounts {
    return { ...this.callCounts };
  }
}
