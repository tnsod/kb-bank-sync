import type { Transaction } from "../transaction/transaction.js";
import type { AppendResult, SheetsClient } from "../spreadsheet/google-sheets-client.js";
import { isGoogleAuthenticationError, isUncertainAppendError } from "../spreadsheet/google-sheets-client.js";
import { buildExistingSheetState } from "../spreadsheet/sheet-state.js";
import type { SheetsWriteGuard } from "../spreadsheet/write-guard.js";
import { SyncError } from "./sync-errors.js";

export interface AppendRecoveryResult extends AppendResult {
  retryCount: number;
  confirmedSourceKeyCount: number;
}

async function readPresentKeys(client: SheetsClient, accountId: string): Promise<Set<string>> {
  return buildExistingSheetState(await client.readDataRows("source_key_verification"), accountId).sourceKeys;
}

export async function appendWithRecovery(
  client: SheetsClient,
  transactions: readonly Transaction[],
  guard: SheetsWriteGuard,
  accountId: string,
): Promise<AppendRecoveryResult> {
  try {
    const result = await client.appendTransactions(transactions, guard);
    if (result.appendedRowCount !== transactions.length || result.updatedRange === null) {
      throw new SyncError("GOOGLE_APPEND_FAILED", "Google Sheets가 보고한 추가 행 수 또는 범위가 요청과 일치하지 않습니다", true);
    }
    return { ...result, retryCount: 0, confirmedSourceKeyCount: transactions.length };
  } catch (error) {
    const retryable = error instanceof SyncError ? error.retryable : isUncertainAppendError(error);
    if (!retryable) {
      if (error instanceof SyncError) throw error;
      throw new SyncError(
        isGoogleAuthenticationError(error) ? "GOOGLE_AUTH_FAILED" : "GOOGLE_APPEND_FAILED",
        "Google Sheets append 요청이 복구 불가능한 오류로 실패했습니다",
        false,
        { cause: error },
      );
    }

    const present = await readPresentKeys(client, accountId);
    const remaining = transactions.filter((transaction) => !present.has(transaction.sourceKey));
    if (remaining.length > 0) {
      const retryGuard = { ...guard, newTransactionCount: remaining.length };
      try {
        const retry = await client.appendTransactions(remaining, retryGuard);
        if (retry.appendedRowCount !== remaining.length || retry.updatedRange === null) {
          throw new SyncError("GOOGLE_APPEND_FAILED", "append 재시도 결과가 요청 건수와 일치하지 않습니다");
        }
      } catch (retryError) {
        throw new SyncError("GOOGLE_APPEND_FAILED", "Google Sheets append 재시도에 실패했습니다", false, { cause: retryError });
      }
    }
    const confirmed = await readPresentKeys(client, accountId);
    const confirmedSourceKeyCount = transactions.filter((transaction) => confirmed.has(transaction.sourceKey)).length;
    if (confirmedSourceKeyCount !== transactions.length) {
      throw new SyncError("GOOGLE_APPEND_FAILED", "append 복구 후 모든 sourceKey를 확인하지 못했습니다");
    }
    return { appendedRowCount: transactions.length, updatedRange: null, retryCount: remaining.length > 0 ? 1 : 0, confirmedSourceKeyCount };
  }
}
