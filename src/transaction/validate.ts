import { TransactionParseError, TransactionValidationError } from "../bank/kb-errors.js";
import { accountIdFromNumber } from "../utils/masking.js";
import { normalizeMoney, normalizeNullableText, normalizeOccurredAt, normalizeText } from "./normalize.js";
import type { RawKbTransaction, TransactionWithoutSourceKey } from "./transaction.js";

export interface TransactionValidationContext {
  lookupStartDate: string;
  lookupEndDate: string;
}

export function normalizeAndValidateTransaction(
  raw: RawKbTransaction,
  accountNumber: string,
  collectedAt: string,
  context?: TransactionValidationContext,
): TransactionWithoutSourceKey {
  const description = normalizeText(raw.descriptionText);
  if (description === "") {
    throw new TransactionValidationError("필수 적요가 비어 있습니다");
  }

  const withdrawal = normalizeMoney(raw.withdrawalText);
  const deposit = normalizeMoney(raw.depositText);
  const balance = normalizeMoney(raw.balanceText, { nullable: true });
  if (withdrawal === null || deposit === null) {
    throw new TransactionParseError("입출금액은 null일 수 없습니다");
  }
  if (withdrawal > 0 && deposit > 0) {
    throw new TransactionValidationError("입금액과 출금액이 동시에 양수입니다");
  }
  if (withdrawal === 0 && deposit === 0) {
    throw new TransactionValidationError("입금액과 출금액이 모두 0입니다");
  }

  const occurredAt = normalizeOccurredAt(raw.dateText, raw.timeText);
  const occurredDate = occurredAt.slice(0, 10);
  if (context !== undefined &&
    (occurredDate < context.lookupStartDate || occurredDate > context.lookupEndDate)) {
    throw new TransactionValidationError("거래일시가 요청한 조회 기간을 벗어났습니다");
  }
  const transactionType = normalizeNullableText(raw.transactionTypeText);
  if (transactionType?.includes("입금") === true && !transactionType.includes("출금") &&
    (deposit <= 0 || withdrawal > 0)) {
    throw new TransactionValidationError("입금 거래의 금액 방향이 화면 구분과 일치하지 않습니다");
  }
  if (transactionType?.includes("출금") === true && !transactionType.includes("입금") &&
    (withdrawal <= 0 || deposit > 0)) {
    throw new TransactionValidationError("출금 거래의 금액 방향이 화면 구분과 일치하지 않습니다");
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
