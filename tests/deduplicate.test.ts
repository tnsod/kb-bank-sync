import { describe, expect, it } from "vitest";

import { deduplicateTransactions, selectNewTransactions } from "../src/sync/deduplicate.js";
import type { Transaction } from "../src/transaction/transaction.js";

const base: Transaction = {
  sourceKey: "same", bank: "KB", accountId: "KB-1234", occurredAt: "2026-07-15T10:00:00+09:00",
  transactionType: null, description: "가상", memo: null, withdrawal: 0, deposit: 1,
  balance: null, branch: null, collectedAt: "2026-07-16T00:00:00+09:00",
};

describe("in-run and existing-sheet deduplication", () => {
  it("removes exact duplicates and rejects same-key conflicting canonical data", () => {
    expect(deduplicateTransactions([base, { ...base, collectedAt: "2026-07-16T01:00:00+09:00" }]))
      .toMatchObject({ internalDuplicateCount: 1, transactions: [base] });
    try {
      deduplicateTransactions([base, { ...base, deposit: 2 }]);
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "FINGERPRINT_CONFLICT" });
    }
  });

  it("preserves scrape order when timestamps are equal", () => {
    const first = { ...base, sourceKey: "a", description: "first" };
    const second = { ...base, sourceKey: "b", description: "second" };
    expect(selectNewTransactions([first, second], new Set()).transactions.map((item) => item.description))
      .toEqual(["first", "second"]);
  });
});
