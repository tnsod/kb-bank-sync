import { describe, expect, it } from "vitest";

import { fingerprintTransaction } from "../src/transaction/fingerprint.js";
import type { Transaction, TransactionWithoutSourceKey } from "../src/transaction/transaction.js";
import { EXPECTED_HEADERS, SYSTEM_HEADERS, transactionToSheetRow, USER_HEADERS } from "../src/spreadsheet/sheet-mapper.js";

const base: Transaction = {
  sourceKey: "a".repeat(64),
  bank: "KB",
  accountId: "KB-1234",
  occurredAt: "2026-07-16T14:30:00+09:00",
  transactionType: "original bank type",
  description: "  counterparty   name ",
  memo: "  detail\n text ",
  withdrawal: 0,
  deposit: 2000,
  balance: 10000,
  branch: " institution ",
  collectedAt: "2026-07-17T01:00:00+09:00",
};

describe("new sheet row mapping", () => {
  it("defines nine user columns and three hidden system columns", () => {
    expect(USER_HEADERS).toHaveLength(9);
    expect(SYSTEM_HEADERS).toEqual(["계좌식별자", "수집시각", "sourceKey"]);
    expect(EXPECTED_HEADERS).toHaveLength(12);
  });

  it("maps a deposit to a positive numeric amount and normalized user fields", () => {
    const row = transactionToSheetRow(base);
    expect(row).toHaveLength(12);
    expect(typeof row[0]).toBe("number");
    expect(row.slice(1, 9)).toEqual([
      "detail text", "입금", "institution", 2000, 10000, "counterparty name", "", "",
    ]);
    expect(row.slice(9)).toEqual([base.accountId, base.collectedAt, base.sourceKey]);
  });

  it("maps a withdrawal to a negative numeric amount", () => {
    const row = transactionToSheetRow({ ...base, deposit: 0, withdrawal: 400 });
    expect(row[2]).toBe("출금");
    expect(row[4]).toBe(-400);
    expect(typeof row[4]).toBe("number");
  });

  it("rejects simultaneous deposit and withdrawal values", () => {
    expect(() => transactionToSheetRow({ ...base, withdrawal: 1 })).toThrow();
  });

  it("maps missing memo or description to an empty display cell and always returns 12 columns", () => {
    const withoutMemo = transactionToSheetRow({ ...base, memo: null });
    const withoutDescription = transactionToSheetRow({ ...base, description: undefined as unknown as string });
    expect(withoutMemo).toHaveLength(12);
    expect(withoutMemo[1]).toBe("");
    expect(withoutMemo[6]).toBe("counterparty name");
    expect(withoutDescription).toHaveLength(12);
    expect(withoutDescription[1]).toBe("detail text");
    expect(withoutDescription[6]).toBe("");
  });

  it("does not change sourceKey when only the sheet display positions are swapped", () => {
    const before = fingerprintTransaction(base as TransactionWithoutSourceKey).sourceKey;
    transactionToSheetRow(base);
    const after = fingerprintTransaction(base as TransactionWithoutSourceKey).sourceKey;
    expect(after).toBe(before);
  });

  it("keeps user evidence, notes, and display labels out of sourceKey", () => {
    const input = base as TransactionWithoutSourceKey;
    const first = fingerprintTransaction({ ...input, evidence: "receipt A", note: "manual note", displayType: "입금" }).sourceKey;
    const second = fingerprintTransaction({ ...input, evidence: "receipt B", note: "changed", displayType: "출금" }).sourceKey;
    expect(second).toBe(first);
    expect(fingerprintTransaction({ ...input, collectedAt: "2026-07-17T02:00:00+09:00" }).sourceKey).toBe(first);
  });
});
