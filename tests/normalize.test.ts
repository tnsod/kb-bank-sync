import { describe, expect, it } from "vitest";

import { normalizeMoney, normalizeNullableText, normalizeOccurredAt, normalizeText } from "../src/transaction/normalize.js";
import {
  INFORMATIONAL_ROW_REASON,
  normalizeAndClassifyTransaction,
  normalizeAndValidateTransaction,
} from "../src/transaction/validate.js";
import { TransactionValidationError } from "../src/bank/kb-errors.js";
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

function validationFailure(
  raw: RawKbTransaction,
  context = { lookupStartDate: "2026-07-01", lookupEndDate: "2026-07-31" },
): TransactionValidationError {
  try {
    normalizeAndValidateTransaction(raw, "12345678901234", "2026-07-15T15:00:00+09:00", context);
    expect.fail("Expected a transaction validation error");
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionValidationError);
    return error as TransactionValidationError;
  }
}

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
  const classificationOptions = {
    informationalRowStructureValidated: true,
    validationContext: { lookupStartDate: "2026-07-01", lookupEndDate: "2026-07-31" },
  };

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

  it("classifies a structurally valid zero-amount row with a blank transaction type as informational", () => {
    const result = normalizeAndClassifyTransaction(
      { ...validRaw, transactionTypeText: "   ", withdrawalText: "0", depositText: "-" },
      "12345678901234",
      "2026-07-15T15:00:00+09:00",
      classificationOptions,
    );
    expect(result).toEqual({ kind: "informational_row", reason: INFORMATIONAL_ROW_REASON });
  });

  it("keeps rejecting a zero-amount row whose transaction type is present", () => {
    expect(() => normalizeAndClassifyTransaction(
      { ...validRaw, transactionTypeText: "안내", withdrawalText: "0", depositText: "0" },
      "12345678901234",
      "2026-07-15T15:00:00+09:00",
      classificationOptions,
    )).toThrow(/모두 0/u);
  });

  it("does not classify malformed amounts as informational", () => {
    try {
      normalizeAndClassifyTransaction(
        { ...validRaw, transactionTypeText: " ", withdrawalText: "not-a-number", depositText: "0" },
        "12345678901234",
        "2026-07-15T15:00:00+09:00",
        classificationOptions,
      );
      expect.fail("Expected invalid withdrawal validation");
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionValidationError);
      expect((error as TransactionValidationError).validationDiagnostic.validationErrorCode).toBe("INVALID_WITHDRAWAL");
    }
  });

  it("does not classify invalid dates or balances as informational", () => {
    for (const raw of [
      { ...validRaw, transactionTypeText: " ", withdrawalText: "0", depositText: "0", dateText: "2026-02-30" },
      { ...validRaw, transactionTypeText: " ", withdrawalText: "0", depositText: "0", balanceText: "invalid" },
    ]) {
      expect(() => normalizeAndClassifyTransaction(
        raw, "12345678901234", "2026-07-15T15:00:00+09:00", classificationOptions,
      )).toThrow(TransactionValidationError);
    }
  });

  it("does not exclude normal deposits or withdrawals", () => {
    const deposit = normalizeAndClassifyTransaction(
      validRaw, "12345678901234", "2026-07-15T15:00:00+09:00", classificationOptions,
    );
    const withdrawal = normalizeAndClassifyTransaction(
      { ...validRaw, transactionTypeText: "출금", withdrawalText: "100", depositText: "0" },
      "12345678901234", "2026-07-15T15:00:00+09:00", classificationOptions,
    );
    expect(deposit.kind).toBe("transaction");
    expect(withdrawal.kind).toBe("transaction");
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

  it.each([
    {
      name: "empty description",
      raw: { ...validRaw, descriptionText: "" },
      code: "EMPTY_DESCRIPTION",
      stage: "description_validation",
      field: "descriptionText",
      rule: "required_non_empty",
    },
    {
      name: "invalid withdrawal",
      raw: { ...validRaw, withdrawalText: "PRIVATE_INVALID_WITHDRAWAL" },
      code: "INVALID_WITHDRAWAL",
      stage: "withdrawal_normalization",
      field: "withdrawalText",
      rule: "valid_money",
    },
    {
      name: "invalid deposit",
      raw: { ...validRaw, depositText: "PRIVATE_INVALID_DEPOSIT" },
      code: "INVALID_DEPOSIT",
      stage: "deposit_normalization",
      field: "depositText",
      rule: "valid_money",
    },
    {
      name: "invalid balance",
      raw: { ...validRaw, balanceText: "PRIVATE_INVALID_BALANCE" },
      code: "INVALID_BALANCE",
      stage: "balance_normalization",
      field: "balanceText",
      rule: "valid_optional_money",
    },
    {
      name: "invalid date",
      raw: { ...validRaw, dateText: "2026-02-30" },
      code: "INVALID_OCCURRED_AT",
      stage: "occurred_at_normalization",
      field: "dateText/timeText",
      rule: "valid_korea_datetime",
    },
    {
      name: "both amounts",
      raw: { ...validRaw, withdrawalText: "1" },
      code: "BOTH_WITHDRAWAL_AND_DEPOSIT",
      stage: "amount_exclusivity_validation",
      field: "withdrawal/deposit",
      rule: "mutually_exclusive_positive_amounts",
    },
    {
      name: "neither amount",
      raw: { ...validRaw, withdrawalText: "-", depositText: "" },
      code: "NEITHER_WITHDRAWAL_NOR_DEPOSIT",
      stage: "amount_exclusivity_validation",
      field: "withdrawal/deposit",
      rule: "one_nonzero_amount_required",
    },
    {
      name: "outside lookup range",
      raw: validRaw,
      code: "OCCURRED_AT_OUTSIDE_LOOKUP_RANGE",
      stage: "lookup_range_validation",
      field: "occurredAt",
      rule: "within_requested_lookup_range",
      context: { lookupStartDate: "2026-07-01", lookupEndDate: "2026-07-14" },
    },
    {
      name: "deposit direction",
      raw: { ...validRaw, transactionTypeText: "출금" },
      code: "WITHDRAWAL_DIRECTION_MISMATCH",
      stage: "transaction_type_validation",
      field: "transactionTypeText",
      rule: "withdrawal_type_matches_amount_direction",
    },
    {
      name: "withdrawal direction",
      raw: { ...validRaw, transactionTypeText: "입금", withdrawalText: "1", depositText: "-" },
      code: "DEPOSIT_DIRECTION_MISMATCH",
      stage: "transaction_type_validation",
      field: "transactionTypeText",
      rule: "deposit_type_matches_amount_direction",
    },
  ] as const)("preserves a safe code for $name", ({ raw, code, stage, field, rule, ...testCase }) => {
    const error = validationFailure(raw, "context" in testCase ? testCase.context : undefined);
    expect(error).toMatchObject({ code: "TRANSACTION_VALIDATION_ERROR", stage });
    expect(error.validationDiagnostic).toMatchObject({
      topLevelCode: "TRANSACTION_VALIDATION_ERROR",
      validationErrorCode: code,
      validationStage: stage,
      transactionIndex: null,
      transactionCount: null,
      failedFieldName: field,
      failedRuleName: rule,
    });
    expect(JSON.stringify(error.validationDiagnostic)).not.toMatch(/PRIVATE_INVALID_/u);
  });
});
