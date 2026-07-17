import { SyncError } from "../sync/sync-errors.js";
import type { SheetLayoutResult, SheetsClient } from "./google-sheets-client.js";
import { headersAreExact, headersAreLegacy } from "./sheet-state.js";

export interface SheetInitializationResult {
  worksheetCreated: boolean;
  headerCreated: boolean;
  layout: SheetLayoutResult | null;
}

export async function initializeSheet(
  client: SheetsClient,
  options: { dryRun: boolean; sheetsWriteEnabled: boolean; onInitialized?: () => void },
): Promise<SheetInitializationResult> {
  let info = await client.getWorksheetInfo();
  if (options.dryRun) {
    if (!info.exists) throw new SyncError("SHEET_INITIALIZATION_REQUIRED", "Dry-run에서는 워크시트를 생성할 수 없습니다");
    const headers = await client.readHeader();
    if (!headersAreExact(headers)) throw new SyncError("SHEET_INITIALIZATION_REQUIRED", "Dry-run에서는 헤더나 레이아웃을 변경할 수 없습니다");
    return { worksheetCreated: false, headerCreated: false, layout: null };
  }
  if (!options.sheetsWriteEnabled) throw new SyncError("SHEETS_WRITE_DISABLED", "시트 초기화에는 ENABLE_SHEETS_WRITE=true가 필요합니다");

  let worksheetCreated = false;
  if (!info.exists) {
    const sheetId = await client.createWorksheet();
    info = { exists: true, sheetId };
    worksheetCreated = true;
  }
  const headers = await client.readHeader();
  const headerEmpty = headers.every((cell) => String(cell ?? "").trim() === "");
  let headerCreated = false;
  if (headerEmpty) {
    await client.writeHeader();
    headerCreated = true;
  } else if (headersAreLegacy(headers)) {
    const rows = await client.readDataRows();
    const hasData = rows.some((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
    if (hasData) {
      throw new SyncError("SHEET_LAYOUT_MIGRATION_REQUIRED", "구형 레이아웃 데이터가 있어 --migrate-sheet-layout 실행이 필요합니다");
    }
    await client.writeHeader();
    headerCreated = true;
  } else if (!headersAreExact(headers)) {
    throw new SyncError("SHEET_HEADER_MISMATCH", "기존 시트 헤더가 예상 헤더와 정확히 일치하지 않습니다");
  }
  const layout = info.sheetId === null ? null : await client.applySheetLayout(info.sheetId);
  options.onInitialized?.();
  return { worksheetCreated, headerCreated, layout };
}
