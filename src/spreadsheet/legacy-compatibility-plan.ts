import { fingerprintTransaction } from "../transaction/fingerprint.js";
import { normalizeText, normalizeTransactionInstitution } from "../transaction/normalize.js";
import type { Transaction, TransactionWithoutSourceKey } from "../transaction/transaction.js";
import { SyncError } from "../sync/sync-errors.js";
import { displayTransactionType, signedTransactionAmount, sheetsSerialToOccurredAt } from "./sheet-mapper.js";
import type { RawSheetRow } from "./sheet-state.js";
import { legacyRowDigest, validateVerifiedLegacyRecords, type VerifiedLegacyRecord } from "./verified-legacy.js";

export interface LegacyKbCandidate {
  transaction: Transaction;
  legacyTransaction: TransactionWithoutSourceKey;
}

export type LegacyMatchClassification = "EXACT_MATCH" | "UNIQUE_COMPATIBLE_MATCH" | "AMBIGUOUS" | "NO_MATCH";
export interface LegacyCompatibilityPlan {
  classifications: Array<{ rowNumber: number; classification: LegacyMatchClassification }>;
  records: VerifiedLegacyRecord[];
}

function text(cell: RawSheetRow[number] | undefined): string {
  return typeof cell === "string" ? normalizeText(cell) : "";
}

function matchesStrongIdentity(row: RawSheetRow, candidate: LegacyKbCandidate): boolean {
  const { transaction, legacyTransaction } = candidate;
  const date = typeof row[0] === "number" ? sheetsSerialToOccurredAt(row[0]) : text(row[0]);
  const memo = text(row[1]);
  const institution = normalizeTransactionInstitution(text(row[3]));
  const amount = row[4];
  const balance = row[5];
  return date === transaction.occurredAt && text(row[2]) === displayTransactionType(transaction) &&
    typeof amount === "number" && Number.isSafeInteger(amount) && amount !== 0 &&
    Math.abs(amount) === Math.abs(signedTransactionAmount(transaction)) &&
    typeof balance === "number" && Number.isSafeInteger(balance) && balance === transaction.balance &&
    memo !== "" && [normalizeText(transaction.memo), normalizeText(legacyTransaction.memo)].includes(memo) &&
    institution !== "" && institution === normalizeText(transaction.branch);
}

// This creates a separate, snapshot-bound duplicate index. A description or
// signed display difference is NEVER used to guess or rewrite missing J:L.
// Identity requires exact second, direction, absolute amount, balance,
// counterparty and institution, uniquely in BOTH the KB and Sheet datasets.
export function buildLegacyCompatibilityPlan(
  rows: readonly RawSheetRow[], candidates: readonly LegacyKbCandidate[], accountId: string,
): LegacyCompatibilityPlan {
  const unique = new Map<string, LegacyKbCandidate>();
  for (const candidate of candidates) {
    if (candidate.transaction.accountId !== accountId ||
      fingerprintTransaction(candidate.transaction).sourceKey !== candidate.transaction.sourceKey) {
      throw new SyncError("SHEET_DATA_INVALID", "KB 후보 계좌 또는 sourceKey 검증 실패");
    }
    const { transaction, legacyTransaction } = candidate;
    if (fingerprintTransaction({ ...legacyTransaction, memo: transaction.memo, branch: transaction.branch }).sourceKey !== transaction.sourceKey) {
      throw new SyncError("SHEET_DATA_INVALID", "KB legacy 후보의 기본 거래 필드가 다릅니다");
    }
    unique.set(transaction.sourceKey, candidate);
  }
  const classifications: LegacyCompatibilityPlan["classifications"] = [];
  const records: VerifiedLegacyRecord[] = [];
  const assigned = new Set<string>();
  rows.forEach((row, index) => {
    if (row.every((cell) => String(cell ?? "").trim() === "") || text(row[11]) !== "") return;
    if ([9, 10].some((column) => String(row[column] ?? "").trim() !== "")) {
      throw new SyncError("SHEET_DATA_INVALID", "부분 시스템 열은 자동 legacy migration 대상이 아닙니다");
    }
    const matches = [...unique.values()].filter((candidate) => matchesStrongIdentity(row, candidate));
    if (matches.length !== 1) {
      classifications.push({ rowNumber: index + 2, classification: matches.length === 0 ? "NO_MATCH" : "AMBIGUOUS" });
      return;
    }
    const candidate = matches[0];
    if (candidate === undefined) return;
    const { transaction, legacyTransaction } = candidate;
    if (assigned.has(transaction.sourceKey) || rows.filter((other) => matchesStrongIdentity(other, candidate)).length !== 1) {
      classifications.push({ rowNumber: index + 2, classification: "AMBIGUOUS" });
      return;
    }
    assigned.add(transaction.sourceKey);
    const descriptionMatches = text(row[6]) === normalizeText(transaction.description);
    const signedAmountMatches = row[4] === signedTransactionAmount(transaction);
    const exact = text(row[1]) === normalizeText(transaction.memo) && text(row[3]) === normalizeText(transaction.branch);
    classifications.push({ rowNumber: index + 2,
      classification: descriptionMatches && signedAmountMatches ? (exact ? "EXACT_MATCH" : "UNIQUE_COMPATIBLE_MATCH") : "NO_MATCH",
    });
    records.push({
      version: 1, rowDigest: legacyRowDigest(row), accountId,
      sourceKey: transaction.sourceKey, legacySourceKey: fingerprintTransaction(legacyTransaction).sourceKey,
    });
  });
  if (records.length !== classifications.length) {
    throw new SyncError("SHEET_DATA_REQUIRES_MIGRATION", "모든 누락 행의 강한 거래 식별자가 1:1로 확인되지 않았습니다");
  }
  validateVerifiedLegacyRecords(rows, accountId, records.map((record) => JSON.stringify(record)));
  return { classifications, records };
}
