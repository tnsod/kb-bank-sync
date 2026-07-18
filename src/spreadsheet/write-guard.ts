import { SyncError } from "../sync/sync-errors.js";

export interface SheetsWriteGuard {
  dryRun: boolean;
  sheetsWriteEnabled: boolean;
  lookupStatus: "success";
  resultContainerDetected: boolean;
  transactionTableDetected: boolean;
  pageStructureValidated: boolean;
  allTransactionsValidated: boolean;
  parsedTransactionCount: number;
  skippedInformationalRowCount: number;
  normalizedTransactionCount: number;
  newTransactionCount: number;
  sheetHeadersValidated: boolean;
  missingSourceKeyRowCount: number;
}

export function assertSheetsWriteAllowed(guard: SheetsWriteGuard): void {
  if (guard.dryRun || !guard.sheetsWriteEnabled) {
    throw new SyncError("SHEETS_WRITE_DISABLED", "Google Sheets 쓰기가 명시적으로 활성화되지 않았습니다");
  }
  const allowed = guard.lookupStatus === "success" &&
    guard.resultContainerDetected && guard.transactionTableDetected && guard.pageStructureValidated &&
    guard.allTransactionsValidated &&
    guard.parsedTransactionCount === guard.normalizedTransactionCount + guard.skippedInformationalRowCount &&
    guard.newTransactionCount > 0 && guard.sheetHeadersValidated && guard.missingSourceKeyRowCount === 0;
  if (!allowed) throw new SyncError("SHEETS_WRITE_GUARD_REJECTED", "Google Sheets 쓰기 보호 조건을 충족하지 못했습니다");
}
