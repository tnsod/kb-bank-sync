import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

import { normalizeText } from "../transaction/normalize.js";
import type { Transaction } from "../transaction/transaction.js";
import { SyncError } from "../sync/sync-errors.js";

dayjs.extend(utc);

export const USER_HEADERS = [
  "거래 일시", "거래처", "거래 유형", "거래 기관", "거래 금액", "거래 후 잔액", "적요", "증빙", "비고",
] as const;

export const SYSTEM_HEADERS = ["계좌식별자", "수집시각", "sourceKey"] as const;

export const EXPECTED_HEADERS = [...USER_HEADERS, ...SYSTEM_HEADERS] as const;

export const LEGACY_HEADERS = [
  "거래일시", "거래구분", "적요", "메모", "출금액", "입금액", "잔액", "취급점", "계좌식별자", "수집시각", "sourceKey",
] as const;

export type SheetCell = string | number | boolean;
export type SheetRow = SheetCell[];
export type DisplayTransactionType = "입금" | "출금" | "기타";

const SHEETS_EPOCH_DAYS = 25_569;
const MILLISECONDS_PER_DAY = 86_400_000;

export function occurredAtToSheetsSerial(occurredAt: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(occurredAt);
  if (match === null) throw new SyncError("SHEET_DATA_INVALID", "거래 일시를 Google Sheets 날짜 값으로 변환할 수 없습니다");
  const [, year, month, day, hour, minute, second] = match;
  const milliseconds = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return milliseconds / MILLISECONDS_PER_DAY + SHEETS_EPOCH_DAYS;
}

export function sheetsSerialToOccurredAt(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const milliseconds = Math.round((serial - SHEETS_EPOCH_DAYS) * MILLISECONDS_PER_DAY / 1000) * 1000;
  const parsed = dayjs.utc(milliseconds);
  if (!parsed.isValid()) return null;
  return `${parsed.format("YYYY-MM-DDTHH:mm:ss")}+09:00`;
}

export function displayTransactionType(transaction: Pick<Transaction, "deposit" | "withdrawal">): DisplayTransactionType {
  if (transaction.deposit > 0 && transaction.withdrawal > 0) {
    throw new SyncError("SHEET_DATA_INVALID", "입금액과 출금액이 동시에 존재하는 거래는 표시할 수 없습니다");
  }
  if (transaction.deposit > 0) return "입금";
  if (transaction.withdrawal > 0) return "출금";
  return "기타";
}

export function signedTransactionAmount(transaction: Pick<Transaction, "deposit" | "withdrawal">): number {
  const type = displayTransactionType(transaction);
  const value = type === "입금" ? transaction.deposit : type === "출금" ? -transaction.withdrawal : 0;
  return Object.is(value, -0) ? 0 : value;
}

export function transactionToSheetRow(transaction: Transaction): SheetRow {
  return [
    occurredAtToSheetsSerial(transaction.occurredAt),
    normalizeText(transaction.memo),
    displayTransactionType(transaction),
    normalizeText(transaction.branch),
    signedTransactionAmount(transaction),
    transaction.balance ?? "",
    normalizeText(transaction.description),
    "",
    "",
    transaction.accountId,
    transaction.collectedAt,
    transaction.sourceKey,
  ];
}

function legacyNumber(cell: SheetCell | null | undefined, field: string, allowEmpty = false): number | null {
  if (cell === null || cell === undefined || String(cell).trim() === "") {
    if (allowEmpty) return null;
    return 0;
  }
  if (typeof cell !== "number" || !Number.isFinite(cell)) {
    throw new SyncError("SHEET_DATA_INVALID", `${field} 값이 숫자가 아닙니다`);
  }
  return Object.is(cell, -0) ? 0 : cell;
}

export function legacyRowToNewRow(row: readonly (SheetCell | null)[]): SheetRow {
  if (row.length < LEGACY_HEADERS.length) throw new SyncError("SHEET_DATA_INVALID", "구형 시트 행의 열 수가 부족합니다");
  const occurredAt = typeof row[0] === "string" ? row[0].trim() : "";
  const withdrawal = legacyNumber(row[4], "출금액") ?? 0;
  const deposit = legacyNumber(row[5], "입금액") ?? 0;
  const balance = legacyNumber(row[6], "잔액", true);
  const type = displayTransactionType({ deposit, withdrawal });
  const amount = signedTransactionAmount({ deposit, withdrawal });
  return [
    occurredAtToSheetsSerial(occurredAt),
    normalizeText(typeof row[3] === "string" ? row[3] : ""),
    type,
    normalizeText(typeof row[7] === "string" ? row[7] : ""),
    amount,
    balance ?? "",
    normalizeText(typeof row[2] === "string" ? row[2] : ""),
    "",
    "",
    String(row[8] ?? "").trim(),
    String(row[9] ?? "").trim(),
    String(row[10] ?? "").trim(),
  ];
}
