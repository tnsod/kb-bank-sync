import { describe, expect, it } from "vitest";

import { buildLegacyCompatibilityPlan, type LegacyKbCandidate } from "../src/spreadsheet/legacy-compatibility-plan.js";
import { transactionToSheetRow } from "../src/spreadsheet/sheet-mapper.js";
import { fingerprintTransaction } from "../src/transaction/fingerprint.js";
import { normalizeAndValidateTransaction } from "../src/transaction/validate.js";
import { rawTransaction, stage2Config } from "./stage2-helpers.js";

const transaction = normalizeAndValidateTransaction(rawTransaction, stage2Config.KB_ACCOUNT_NUMBER, "2026-07-16T00:00:00+09:00");
const candidate: LegacyKbCandidate = { transaction: fingerprintTransaction(transaction), legacyTransaction: transaction };
const row = transactionToSheetRow(candidate.transaction).slice(0, 9);
const plan = (rows = [row], candidates = [candidate]) => buildLegacyCompatibilityPlan(rows, candidates, transaction.accountId);

describe("legacy migration planning from independently read KB candidates", () => {
  it("classifies exact and known institution/counterparty compatibility", () => {
    expect(plan().classifications[0]?.classification).toBe("EXACT_MATCH");
    const current = { ...transaction, branch: "국민은행" };
    const legacy = { ...current, memo: `${current.memo} 이전 통장표시`, branch: "청라" };
    const compatibleRow = [...row]; compatibleRow[1] = legacy.memo; compatibleRow[3] = "청라";
    expect(plan([compatibleRow], [{ transaction: fingerprintTransaction(current), legacyTransaction: legacy }]).classifications[0]?.classification).toBe("UNIQUE_COMPATIBLE_MATCH");
  });

  it("creates a snapshot-bound index without calling a description mismatch a restored match", () => {
    const edited = [...row]; edited[6] = "사용자 적요";
    const result = plan([edited]);
    expect(result.classifications[0]?.classification).toBe("NO_MATCH");
    expect(result.records[0]?.sourceKey).toBe(candidate.transaction.sourceKey);
    expect(edited[9]).toBeUndefined(); expect(edited[11]).toBeUndefined();
  });

  it("preserves positive display amounts for withdrawals using explicit direction", () => {
    const withdrawal = { ...transaction, transactionType: "출금", withdrawal: 1000, deposit: 0 };
    const c = { transaction: fingerprintTransaction(withdrawal), legacyTransaction: withdrawal };
    const edited = transactionToSheetRow(c.transaction).slice(0, 9); edited[4] = 1000;
    const result = plan([edited], [c]);
    expect(result.classifications[0]?.classification).toBe("NO_MATCH"); expect(result.records).toHaveLength(1);
    expect(edited[4]).toBe(1000);
  });

  it.each([0, 1, 2, 3, 4, 5])("refuses an unconfirmed strong identity column %i", (column) => {
    const edited = [...row]; edited[column] = column === 4 || column === 5 ? 999 : "different";
    expect(() => plan([edited])).toThrow(/1:1/u);
  });

  it("refuses weak identities with missing counterparty, institution or balance", () => {
    for (const column of [1, 3, 5]) { const edited = [...row]; edited[column] = ""; expect(() => plan([edited])).toThrow(); }
  });

  it("refuses two KB candidates or two Sheet rows with the same strong identity", () => {
    const other = { ...transaction, description: "다른 은행 적요" };
    expect(() => plan([row], [candidate, { transaction: fingerprintTransaction(other), legacyTransaction: other }])).toThrow(/1:1/u);
    expect(() => plan([row, row])).toThrow(/1:1/u);
  });

  it("refuses partial system values, existing key collisions and forged candidate keys", () => {
    const partial = [...row]; partial[9] = transaction.accountId;
    expect(() => plan([partial])).toThrow(/부분/u);
    const full = transactionToSheetRow(candidate.transaction); full[1] = "사용자가 편집한 정상 거래처";
    expect(() => plan([row, full])).toThrow(/충돌/u);
    expect(() => plan([row], [{ ...candidate, transaction: { ...candidate.transaction, sourceKey: "f".repeat(64) } }])).toThrow(/sourceKey/u);
  });
});
