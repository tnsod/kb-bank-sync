import { describe, expect, it } from "vitest";

import { fingerprintTransaction } from "../src/transaction/fingerprint.js";
import type { TransactionWithoutSourceKey } from "../src/transaction/transaction.js";

const transaction: TransactionWithoutSourceKey = {
  bank: "KB", accountId: "KB-1234", occurredAt: "2026-07-15T14:30:00+09:00",
  transactionType: "입금", description: "가상 거래", memo: "내통장 표시 상세 설명",
  withdrawal: 0, deposit: 1000, balance: 10000, branch: "테스트점",
  collectedAt: "2026-07-16T01:00:00+09:00",
};

describe("transaction sourceKey", () => {
  it("is stable across collection times and equivalent whitespace", () => {
    const first = fingerprintTransaction(transaction).sourceKey;
    expect(fingerprintTransaction({ ...transaction, collectedAt: "2026-07-16T02:00:00+09:00" }).sourceKey).toBe(first);
    expect(fingerprintTransaction({ ...transaction, description: " 가상\n  거래 " }).sourceKey).toBe(first);
  });

  it("changes for amount, balance, and combined detail changes", () => {
    const key = fingerprintTransaction(transaction).sourceKey;
    expect(fingerprintTransaction({ ...transaction, deposit: 1001 }).sourceKey).not.toBe(key);
    expect(fingerprintTransaction({ ...transaction, balance: 10001 }).sourceKey).not.toBe(key);
    expect(fingerprintTransaction({ ...transaction, memo: "다른 상세 설명" }).sourceKey).not.toBe(key);
  });

  it("normalizes null and empty optional text consistently", () => {
    expect(fingerprintTransaction({ ...transaction, memo: null }).sourceKey)
      .toBe(fingerprintTransaction({ ...transaction, memo: "" }).sourceKey);
  });
});
