import { describe, expect, it, vi } from "vitest";

import { appendWithRecovery } from "../src/sync/append-recovery.js";
import type { Transaction } from "../src/transaction/transaction.js";
import type { SheetsWriteGuard } from "../src/spreadsheet/write-guard.js";
import { sheetClient } from "./stage2-helpers.js";

const transactions: Transaction[] = [1, 2].map((number) => ({
  sourceKey: `key-${number}`, bank: "KB", accountId: "KB-1234",
  occurredAt: `2026-07-1${number}T10:00:00+09:00`, transactionType: "입금",
  description: `가상 ${number}`, memo: null, withdrawal: 0, deposit: number,
  balance: 100 + number, branch: null, collectedAt: "2026-07-16T00:00:00+09:00",
}));

const guard: SheetsWriteGuard = {
  dryRun: false, sheetsWriteEnabled: true, lookupStatus: "success", resultContainerDetected: true,
  transactionTableDetected: true, pageStructureValidated: true, allTransactionsValidated: true,
  parsedTransactionCount: 2, skippedInformationalRowCount: 0, normalizedTransactionCount: 2, newTransactionCount: 2,
  sheetHeadersValidated: true, missingSourceKeyRowCount: 0,
};

function rows(keys: string[]) {
  return keys.map((key, index) => [
    `2026-07-1${index + 1}T10:00:00+09:00`, "가상", "입금", "", 1, 100, "", "", "", "KB-1234",
    "2026-07-16T00:00:00+09:00", key,
  ]);
}

const uncertain = Object.assign(new Error("response lost"), { code: 503 });

describe("uncertain append recovery", () => {
  it("does not retry when all rows were actually stored", async () => {
    const appendTransactions = vi.fn().mockRejectedValueOnce(uncertain);
    const readDataRows = vi.fn().mockResolvedValue(rows(["key-1", "key-2"]));
    const result = await appendWithRecovery(sheetClient({ appendTransactions, readDataRows }), transactions, guard, "KB-1234");
    expect(result).toMatchObject({ appendedRowCount: 2, retryCount: 0, confirmedSourceKeyCount: 2 });
    expect(appendTransactions).toHaveBeenCalledOnce();
  });

  it("retries only a partially missing subset once", async () => {
    const appendTransactions = vi.fn()
      .mockRejectedValueOnce(uncertain)
      .mockResolvedValueOnce({ appendedRowCount: 1, updatedRange: "거래내역!A3:L3" });
    const readDataRows = vi.fn()
      .mockResolvedValueOnce(rows(["key-1"]))
      .mockResolvedValueOnce(rows(["key-1", "key-2"]));
    const result = await appendWithRecovery(sheetClient({ appendTransactions, readDataRows }), transactions, guard, "KB-1234");
    expect(result.retryCount).toBe(1);
    expect(appendTransactions.mock.calls[1]?.[0]).toEqual([transactions[1]]);
  });

  it("retries the batch once when none were stored", async () => {
    const appendTransactions = vi.fn()
      .mockRejectedValueOnce(uncertain)
      .mockResolvedValueOnce({ appendedRowCount: 2, updatedRange: "거래내역!A2:L3" });
    const readDataRows = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows(["key-1", "key-2"]));
    const result = await appendWithRecovery(sheetClient({ appendTransactions, readDataRows }), transactions, guard, "KB-1234");
    expect(result.retryCount).toBe(1);
    expect(appendTransactions).toHaveBeenCalledTimes(2);
  });

  it("treats an ETIMEDOUT response loss as uncertain and retries at most once", async () => {
    const timeout = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const appendTransactions = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ appendedRowCount: 2, updatedRange: "거래내역!A2:L3" });
    const readDataRows = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows(["key-1", "key-2"]));
    const result = await appendWithRecovery(sheetClient({ appendTransactions, readDataRows }), transactions, guard, "KB-1234");
    expect(result.retryCount).toBe(1);
    expect(appendTransactions).toHaveBeenCalledTimes(2);
  });

  it("does not retry authentication or permission errors", async () => {
    for (const code of [401, 403]) {
      const appendTransactions = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { code }));
      const readDataRows = vi.fn();
      await expect(appendWithRecovery(sheetClient({ appendTransactions, readDataRows }), transactions, guard, "KB-1234")).rejects.toThrow();
      expect(appendTransactions).toHaveBeenCalledOnce();
      expect(readDataRows).not.toHaveBeenCalled();
    }
  });

  it("stops after the single retry fails", async () => {
    const appendTransactions = vi.fn().mockRejectedValue(uncertain);
    const readDataRows = vi.fn().mockResolvedValue([]);
    await expect(appendWithRecovery(sheetClient({ appendTransactions, readDataRows }), transactions, guard, "KB-1234"))
      .rejects.toMatchObject({ code: "GOOGLE_APPEND_FAILED" });
    expect(appendTransactions).toHaveBeenCalledTimes(2);
  });
});
