import { canonicalizeTransaction } from "../transaction/fingerprint.js";
import type { Transaction } from "../transaction/transaction.js";
import { SyncError } from "./sync-errors.js";

export interface DeduplicationResult {
  transactions: Transaction[];
  internalDuplicateCount: number;
}

export function deduplicateTransactions(transactions: readonly Transaction[]): DeduplicationResult {
  const seen = new Map<string, string>();
  const unique: Transaction[] = [];
  let internalDuplicateCount = 0;
  for (const transaction of transactions) {
    const canonical = canonicalizeTransaction(transaction);
    const prior = seen.get(transaction.sourceKey);
    if (prior === undefined) {
      seen.set(transaction.sourceKey, canonical);
      unique.push(transaction);
    } else if (prior === canonical) {
      internalDuplicateCount += 1;
    } else {
      throw new SyncError("FINGERPRINT_CONFLICT", "같은 sourceKey에 서로 다른 거래 데이터가 감지되었습니다");
    }
  }
  return { transactions: unique, internalDuplicateCount };
}

export function selectNewTransactions(
  transactions: readonly Transaction[],
  existingSourceKeys: ReadonlySet<string>,
): { transactions: Transaction[]; existingTransactionCount: number } {
  const indexed = transactions.map((transaction, index) => ({ transaction, index }));
  const existingTransactionCount = indexed.filter(({ transaction }) => existingSourceKeys.has(transaction.sourceKey)).length;
  const fresh = indexed
    .filter(({ transaction }) => !existingSourceKeys.has(transaction.sourceKey))
    .sort((left, right) => left.transaction.occurredAt.localeCompare(right.transaction.occurredAt) || left.index - right.index)
    .map(({ transaction }) => transaction);
  return { transactions: fresh, existingTransactionCount };
}
