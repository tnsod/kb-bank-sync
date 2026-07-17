import { describe, expect, it } from "vitest";

import { normalizeMoney, normalizeNullableText, normalizeOccurredAt, normalizeText } from "../src/transaction/normalize.js";
import { normalizeAndValidateTransaction } from "../src/transaction/validate.js";
import { accountIdFromNumber, maskAccountNumber } from "../src/utils/masking.js";
import type { RawKbTransaction } from "../src/transaction/transaction.js";

const validRaw: RawKbTransaction = {
  dateText: "2026.07.15",
  timeText: "14:30:00",
  transactionTypeText: " 입금 ",
  descriptionText: " 가상   거래 ",
  memoText: "",
  withdrawalText: "-",
  depositText: "1,234 원",
  balanceText: "10,000원",
  branchText: " 테스트점 ",
};

describe("text normalization", () => {
  it("removes controls, trims, and collapses whitespace", () => {
    expect(normalizeText("  가상\u0000   거래  ")).toBe("가상 거래");
  });

  it("normalizes empty optional values to null", () => {
    expect(normalizeNullableText(" \t ")).toBeNull();
  });
});

describe("money normalization", () => {
  it.each([
    ["1,234원", 1234],
    [" -1,234 원 ", -1234],
    ["(1,234)", -1234],
    ["1,234-", -1234],
    ["-", 0],
    ["", 0],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeMoney(input)).toBe(expected);
  });

  it("returns null for an absent optional balance", () => {
    expect(normalizeMoney("-", { nullable: true })).toBeNull();
  });

  it("rejects malformed values instead of substituting zero", () => {
    expect(() => normalizeMoney("12,3x원")).toThrow();
  });
});

describe("date normalization", () => {
  it("creates an ISO 8601 value in Korea time", () => {
    expect(normalizeOccurredAt("2026-07-15", "14:30:00")).toBe("2026-07-15T14:30:00+09:00");
  });

  it("rejects invalid dates", () => {
    expect(() => normalizeOccurredAt("2026-02-30", "14:30:00")).toThrow();
  });
});

describe("masking", () => {
  it("retains only the last four account digits", () => {
    expect(accountIdFromNumber("12345678901234")).toBe("KB-1234");
    expect(maskAccountNumber("123-456-78901234")).toBe("KB-1234");
  });
});

describe("transaction validation", () => {
  it("normalizes a valid transaction", () => {
    const transaction = normalizeAndValidateTransaction(validRaw, "12345678901234", "2026-07-15T15:00:00+09:00");
    expect(transaction).toMatchObject({
      bank: "KB",
      accountId: "KB-1234",
      description: "가상 거래",
      memo: null,
      withdrawal: 0,
      deposit: 1234,
      balance: 10000,
    });
  });

  it("rejects missing descriptions", () => {
    expect(() => normalizeAndValidateTransaction({ ...validRaw, descriptionText: "" }, "12345678901234", "2026-07-15T15:00:00+09:00")).toThrow();
  });

  it("rejects simultaneous positive deposit and withdrawal", () => {
    expect(() => normalizeAndValidateTransaction({ ...validRaw, withdrawalText: "1" }, "12345678901234", "2026-07-15T15:00:00+09:00")).toThrow();
  });

  it("rejects a transaction whose deposit and withdrawal both normalize to zero", () => {
    expect(() => normalizeAndValidateTransaction(
      { ...validRaw, withdrawalText: "-", depositText: "" },
      "12345678901234",
      "2026-07-15T15:00:00+09:00",
    )).toThrow(/모두 0/u);
  });

  it("rejects transactions outside the requested lookup period", () => {
    expect(() => normalizeAndValidateTransaction(
      validRaw,
      "12345678901234",
      "2026-07-15T15:00:00+09:00",
      { lookupStartDate: "2026-07-01", lookupEndDate: "2026-07-14" },
    )).toThrow(/조회 기간/u);
  });

  it("validates deposit and withdrawal direction against the transaction type", () => {
    expect(() => normalizeAndValidateTransaction(
      { ...validRaw, transactionTypeText: "출금" },
      "12345678901234",
      "2026-07-15T15:00:00+09:00",
    )).toThrow(/방향/u);
    expect(normalizeAndValidateTransaction(
      { ...validRaw, transactionTypeText: "출금", withdrawalText: "1000", depositText: "-" },
      "12345678901234",
      "2026-07-15T15:00:00+09:00",
    ).withdrawal).toBe(1000);
  });
});
