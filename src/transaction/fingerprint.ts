import { createHash } from "node:crypto";

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { normalizeText } from "./normalize.js";
import type { Transaction, TransactionWithoutSourceKey } from "./transaction.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const NULL_TOKEN = "<null>";

function canonicalText(value: string | null): string {
  const normalized = normalizeText(value);
  return normalized === "" ? NULL_TOKEN : normalized;
}

function canonicalNumber(value: number | null): string {
  if (value === null) return NULL_TOKEN;
  return Object.is(value, -0) ? "0" : String(value);
}

function canonicalOccurredAt(value: string): string {
  const parsed = dayjs(value);
  if (!parsed.isValid()) throw new Error("sourceKey 거래일시가 유효하지 않습니다");
  return parsed.tz("Asia/Seoul").format("YYYY-MM-DDTHH:mm:ssZ");
}

export function canonicalizeTransaction(transaction: TransactionWithoutSourceKey): string {
  return JSON.stringify([
    transaction.bank,
    canonicalText(transaction.accountId),
    canonicalOccurredAt(transaction.occurredAt),
    canonicalText(transaction.transactionType),
    canonicalText(transaction.description),
    canonicalText(transaction.memo),
    canonicalNumber(transaction.withdrawal),
    canonicalNumber(transaction.deposit),
    canonicalNumber(transaction.balance),
    canonicalText(transaction.branch),
  ]);
}

export function fingerprintTransaction(transaction: TransactionWithoutSourceKey): Transaction {
  const canonical = canonicalizeTransaction(transaction);
  return {
    ...transaction,
    sourceKey: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}
