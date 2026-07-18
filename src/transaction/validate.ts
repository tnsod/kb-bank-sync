import {
  TransactionValidationError,
  type TransactionValidationDiagnostic,
  type ValidationAmountState,
  type ValidationErrorCode,
  type ValidationStage,
} from "../bank/kb-errors.js";
import { accountIdFromNumber } from "../utils/masking.js";
import { normalizeMoney, normalizeNullableText, normalizeOccurredAt, normalizeText } from "./normalize.js";
import type { RawKbTransaction, TransactionWithoutSourceKey } from "./transaction.js";

export interface TransactionValidationContext {
  lookupStartDate: string;
  lookupEndDate: string;
}

type ValidationDiagnosticInput = Omit<
  TransactionValidationDiagnostic,
  "topLevelCode" | "transactionIndex" | "transactionCount"
>;

function amountState(value: number | null | undefined): ValidationAmountState {
  if (value === undefined) return "not_evaluated";
  if (value === null) return "null";
  return value === 0 ? "zero" : "nonzero";
}

function rawValueMetadata(value: unknown): Pick<
  TransactionValidationDiagnostic,
  "rawFieldPresent" | "rawFieldEmpty" | "valueType" | "stringLength"
> {
  const present = value !== undefined && value !== null;
  return {
    rawFieldPresent: present,
    rawFieldEmpty: !present || (typeof value === "string" && normalizeText(value) === ""),
    valueType: value === null ? "null" : typeof value,
    stringLength: typeof value === "string" ? value.length : null,
  };
}

function rawBalancePresent(raw: RawKbTransaction): boolean {
  const value = normalizeText(raw.balanceText);
  return value !== "" && value !== "-";
}

function validationError(
  message: string,
  validationErrorCode: ValidationErrorCode,
  validationStage: ValidationStage,
  rawValue: unknown,
  diagnostic: Omit<
    ValidationDiagnosticInput,
    "validationErrorCode" | "validationStage" | "rawFieldPresent" | "rawFieldEmpty" | "valueType" | "stringLength"
  >,
  cause?: unknown,
): TransactionValidationError {
  return new TransactionValidationError(message, {
    topLevelCode: "TRANSACTION_VALIDATION_ERROR",
    validationErrorCode,
    validationStage,
    transactionIndex: null,
    transactionCount: null,
    ...rawValueMetadata(rawValue),
    ...diagnostic,
  }, cause === undefined ? undefined : { cause });
}

export function normalizeAndValidateTransaction(
  raw: RawKbTransaction,
  accountNumber: string,
  collectedAt: string,
  context?: TransactionValidationContext,
): TransactionWithoutSourceKey {
  const description = normalizeText(raw.descriptionText);
  if (description === "") {
    throw validationError(
      "필수 적요가 비어 있습니다", "EMPTY_DESCRIPTION", "description_validation", raw.descriptionText,
      {
        failedFieldName: "descriptionText", failedRuleName: "required_non_empty",
        normalizedFieldPresent: false, numericParsingSucceeded: null, dateParsingSucceeded: null,
        withdrawalState: "not_evaluated", depositState: "not_evaluated", balancePresent: rawBalancePresent(raw),
      },
    );
  }

  let withdrawal: number | null;
  try {
    withdrawal = normalizeMoney(raw.withdrawalText);
  } catch (error) {
    throw validationError(
      "출금액을 정규화할 수 없습니다", "INVALID_WITHDRAWAL", "withdrawal_normalization", raw.withdrawalText,
      {
        failedFieldName: "withdrawalText", failedRuleName: "valid_money",
        normalizedFieldPresent: false, numericParsingSucceeded: false, dateParsingSucceeded: null,
        withdrawalState: "null", depositState: "not_evaluated", balancePresent: rawBalancePresent(raw),
      },
      error,
    );
  }
  let deposit: number | null;
  try {
    deposit = normalizeMoney(raw.depositText);
  } catch (error) {
    throw validationError(
      "입금액을 정규화할 수 없습니다", "INVALID_DEPOSIT", "deposit_normalization", raw.depositText,
      {
        failedFieldName: "depositText", failedRuleName: "valid_money",
        normalizedFieldPresent: false, numericParsingSucceeded: false, dateParsingSucceeded: null,
        withdrawalState: amountState(withdrawal), depositState: "null", balancePresent: rawBalancePresent(raw),
      },
      error,
    );
  }
  let balance: number | null;
  try {
    balance = normalizeMoney(raw.balanceText, { nullable: true });
  } catch (error) {
    throw validationError(
      "잔액을 정규화할 수 없습니다", "INVALID_BALANCE", "balance_normalization", raw.balanceText,
      {
        failedFieldName: "balanceText", failedRuleName: "valid_optional_money",
        normalizedFieldPresent: false, numericParsingSucceeded: false, dateParsingSucceeded: null,
        withdrawalState: amountState(withdrawal), depositState: amountState(deposit), balancePresent: rawBalancePresent(raw),
      },
      error,
    );
  }
  if (withdrawal === null || deposit === null) {
    const withdrawalInvalid = withdrawal === null;
    throw validationError(
      "입출금액은 null일 수 없습니다",
      withdrawalInvalid ? "INVALID_WITHDRAWAL" : "INVALID_DEPOSIT",
      withdrawalInvalid ? "withdrawal_normalization" : "deposit_normalization",
      withdrawalInvalid ? raw.withdrawalText : raw.depositText,
      {
        failedFieldName: withdrawalInvalid ? "withdrawalText" : "depositText", failedRuleName: "non_null_amount",
        normalizedFieldPresent: false, numericParsingSucceeded: true, dateParsingSucceeded: null,
        withdrawalState: amountState(withdrawal), depositState: amountState(deposit), balancePresent: balance !== null,
      },
    );
  }
  if (withdrawal > 0 && deposit > 0) {
    throw validationError(
      "입금액과 출금액이 동시에 양수입니다", "BOTH_WITHDRAWAL_AND_DEPOSIT",
      "amount_exclusivity_validation", `${raw.withdrawalText}${raw.depositText}`,
      {
        failedFieldName: "withdrawal/deposit", failedRuleName: "mutually_exclusive_positive_amounts",
        normalizedFieldPresent: true, numericParsingSucceeded: true, dateParsingSucceeded: null,
        withdrawalState: amountState(withdrawal), depositState: amountState(deposit), balancePresent: balance !== null,
      },
    );
  }
  if (withdrawal === 0 && deposit === 0) {
    throw validationError(
      "입금액과 출금액이 모두 0입니다", "NEITHER_WITHDRAWAL_NOR_DEPOSIT",
      "amount_exclusivity_validation", `${raw.withdrawalText}${raw.depositText}`,
      {
        failedFieldName: "withdrawal/deposit", failedRuleName: "one_nonzero_amount_required",
        normalizedFieldPresent: true, numericParsingSucceeded: true, dateParsingSucceeded: null,
        withdrawalState: amountState(withdrawal), depositState: amountState(deposit), balancePresent: balance !== null,
      },
    );
  }

  let occurredAt: string;
  try {
    occurredAt = normalizeOccurredAt(raw.dateText, raw.timeText);
  } catch (error) {
    throw validationError(
      "거래 일시를 정규화할 수 없습니다", "INVALID_OCCURRED_AT", "occurred_at_normalization",
      `${raw.dateText}${raw.timeText}`,
      {
        failedFieldName: "dateText/timeText", failedRuleName: "valid_korea_datetime",
        normalizedFieldPresent: false, numericParsingSucceeded: true, dateParsingSucceeded: false,
        withdrawalState: amountState(withdrawal), depositState: amountState(deposit), balancePresent: balance !== null,
      },
      error,
    );
  }
  const occurredDate = occurredAt.slice(0, 10);
  if (context !== undefined &&
    (occurredDate < context.lookupStartDate || occurredDate > context.lookupEndDate)) {
    throw validationError(
      "거래일시가 요청한 조회 기간을 벗어났습니다", "OCCURRED_AT_OUTSIDE_LOOKUP_RANGE",
      "lookup_range_validation", `${raw.dateText}${raw.timeText}`,
      {
        failedFieldName: "occurredAt", failedRuleName: "within_requested_lookup_range",
        normalizedFieldPresent: true, numericParsingSucceeded: true, dateParsingSucceeded: true,
        withdrawalState: amountState(withdrawal), depositState: amountState(deposit), balancePresent: balance !== null,
      },
    );
  }
  const transactionType = normalizeNullableText(raw.transactionTypeText);
  if (transactionType?.includes("입금") === true && !transactionType.includes("출금") &&
    (deposit <= 0 || withdrawal > 0)) {
    throw validationError(
      "입금 거래의 금액 방향이 화면 구분과 일치하지 않습니다", "DEPOSIT_DIRECTION_MISMATCH",
      "transaction_type_validation", raw.transactionTypeText,
      {
        failedFieldName: "transactionTypeText", failedRuleName: "deposit_type_matches_amount_direction",
        normalizedFieldPresent: transactionType !== null, numericParsingSucceeded: true, dateParsingSucceeded: true,
        withdrawalState: amountState(withdrawal), depositState: amountState(deposit), balancePresent: balance !== null,
      },
    );
  }
  if (transactionType?.includes("출금") === true && !transactionType.includes("입금") &&
    (withdrawal <= 0 || deposit > 0)) {
    throw validationError(
      "출금 거래의 금액 방향이 화면 구분과 일치하지 않습니다", "WITHDRAWAL_DIRECTION_MISMATCH",
      "transaction_type_validation", raw.transactionTypeText,
      {
        failedFieldName: "transactionTypeText", failedRuleName: "withdrawal_type_matches_amount_direction",
        normalizedFieldPresent: transactionType !== null, numericParsingSucceeded: true, dateParsingSucceeded: true,
        withdrawalState: amountState(withdrawal), depositState: amountState(deposit), balancePresent: balance !== null,
      },
    );
  }

  return {
    bank: "KB",
    accountId: accountIdFromNumber(accountNumber),
    occurredAt,
    transactionType,
    description,
    memo: normalizeNullableText(raw.memoText),
    withdrawal,
    deposit,
    balance,
    branch: normalizeNullableText(raw.branchText),
    collectedAt,
  };
}
