import type {
  NeighborTransactionAmountDiagnostic,
  ParsedTransactionTypeCategory,
  RawAmountCategory,
  TransactionRowStructureDiagnostic,
  TransactionValidationStructureContext,
} from "../bank/kb-errors.js";
import { normalizeMoney, normalizeOccurredAt, normalizeText } from "./normalize.js";
import type { RawKbTransaction } from "./transaction.js";

export function classifyTransactionType(value: string): ParsedTransactionTypeCategory {
  const normalized = normalizeText(value);
  if (normalized === "") return "unknown";
  if (/이자/u.test(normalized)) return "interest";
  if (/수수료/u.test(normalized)) return "fee";
  if (/(?:정정|조정)/u.test(normalized)) return "adjustment";
  if (/취소/u.test(normalized)) return "cancellation";
  if (/(?:이체|송금)/u.test(normalized)) return "transfer";
  if (/입금/u.test(normalized)) return "deposit";
  if (/출금/u.test(normalized)) return "withdrawal";
  if (/기타/u.test(normalized)) return "other";
  return "unknown";
}

export function classifyRawAmount(value: string): RawAmountCategory {
  const normalized = normalizeText(value);
  if (normalized === "") return "empty";
  if (/^(?:-|—|ㆍ)$/u.test(normalized)) return "dash";
  const compact = normalized.replace(/[원,\s]/gu, "");
  const parenthesized = /^\(.*\)$/u.test(compact);
  const trailingMinus = compact.endsWith("-") && !compact.startsWith("-");
  const numericText = parenthesized ? compact.slice(1, -1) : trailingMinus ? compact.slice(0, -1) : compact;
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(numericText)) return "other";
  const parsed = Number(numericText);
  if (!Number.isFinite(parsed)) return "other";
  if (parsed === 0) return "zero";
  if (parenthesized || trailingMinus || parsed < 0) return "negative_numeric";
  if (/[,원\s]/u.test(normalized)) return "formatted_numeric";
  return "positive_numeric";
}

function dateParses(raw: RawKbTransaction): boolean {
  try {
    normalizeOccurredAt(raw.dateText, raw.timeText);
    return true;
  } catch {
    return false;
  }
}

function amountParses(value: string): boolean {
  try {
    normalizeMoney(value);
    return true;
  } catch {
    return false;
  }
}

function neighborDiagnostic(
  transactionIndex: number,
  raw: RawKbTransaction | undefined,
  structure: TransactionRowStructureDiagnostic | undefined,
): NeighborTransactionAmountDiagnostic | null {
  if (raw === undefined) return null;
  return {
    transactionIndex,
    withdrawalRawCategory: classifyRawAmount(raw.withdrawalText),
    depositRawCategory: classifyRawAmount(raw.depositText),
    selectedRowCellCount: structure?.selectedRowCellCount ?? null,
    headerWithdrawalCellIndex: structure?.headerWithdrawalCellIndex ?? null,
    headerDepositCellIndex: structure?.headerDepositCellIndex ?? null,
    headerBalanceCellIndex: structure?.headerBalanceCellIndex ?? null,
    withdrawalCellIndex: structure?.withdrawalCell?.cellIndex ?? null,
    depositCellIndex: structure?.depositCell?.cellIndex ?? null,
    balanceCellIndex: structure?.balanceCell?.cellIndex ?? null,
    withdrawalCell: structure?.withdrawalCell ?? null,
    depositCell: structure?.depositCell ?? null,
    balanceCell: structure?.balanceCell ?? null,
    columnMappingMatchesHeader: structure?.columnMappingMatchesHeader ?? null,
  };
}

export function buildValidationStructureContext(
  transactionIndex: number,
  rawTransactions: readonly RawKbTransaction[],
  structures: readonly TransactionRowStructureDiagnostic[] | undefined,
): TransactionValidationStructureContext {
  const raw = rawTransactions[transactionIndex];
  if (raw === undefined) throw new Error("Transaction index is outside the parsed transaction list");
  const structure = structures?.[transactionIndex];
  const previous = neighborDiagnostic(transactionIndex - 1, rawTransactions[transactionIndex - 1], structures?.[transactionIndex - 1]);
  const next = neighborDiagnostic(transactionIndex + 1, rawTransactions[transactionIndex + 1], structures?.[transactionIndex + 1]);
  const comparableNeighbors = [previous, next].filter((value): value is NeighborTransactionAmountDiagnostic => value !== null);
  const neighborColumnMappingConsistent = structure === undefined || comparableNeighbors.some((neighbor) =>
    neighbor.columnMappingMatchesHeader === null)
    ? null
    : comparableNeighbors.every((neighbor) => neighbor.columnMappingMatchesHeader === structure.columnMappingMatchesHeader &&
      neighbor.withdrawalCellIndex === structure.withdrawalCell?.cellIndex &&
      neighbor.depositCellIndex === structure.depositCell?.cellIndex &&
      neighbor.balanceCellIndex === structure.balanceCell?.cellIndex);
  const typeCategory = classifyTransactionType(raw.transactionTypeText);
  const withdrawalCategory = classifyRawAmount(raw.withdrawalText);
  const depositCategory = classifyRawAmount(raw.depositText);
  const amountCellsShowZeroOrDash = [withdrawalCategory, depositCategory].every((category) =>
    category === "zero" || category === "dash");
  const mappingMatches = structure?.columnMappingMatchesHeader === true && neighborColumnMappingConsistent === true;
  const requiredDescriptionPresent = normalizeText(raw.descriptionText) !== "";
  const balancePresent = normalizeText(raw.balanceText) !== "" && normalizeText(raw.balanceText) !== "-";
  const monetaryFieldsParse = amountParses(raw.withdrawalText) && amountParses(raw.depositText);
  const knownNonMonetaryType = ["interest", "adjustment", "cancellation", "other"].includes(typeCategory);
  return {
    parsedTransactionTypeCategory: typeCategory,
    rawTransactionTypePresent: raw.transactionTypeText !== undefined && raw.transactionTypeText !== null,
    rawTransactionTypeEmpty: normalizeText(raw.transactionTypeText) === "",
    rawTransactionTypeLength: raw.transactionTypeText.length,
    withdrawalRawCategory: withdrawalCategory,
    depositRawCategory: depositCategory,
    requiredDescriptionPresent,
    headerWithdrawalCellIndex: structure?.headerWithdrawalCellIndex ?? null,
    headerDepositCellIndex: structure?.headerDepositCellIndex ?? null,
    headerBalanceCellIndex: structure?.headerBalanceCellIndex ?? null,
    selectedRowCellCount: structure?.selectedRowCellCount ?? null,
    withdrawalCell: structure?.withdrawalCell ?? null,
    depositCell: structure?.depositCell ?? null,
    balanceCell: structure?.balanceCell ?? null,
    previousTransaction: previous,
    nextTransaction: next,
    neighborColumnMappingConsistent,
    nonMonetaryTransactionCandidate: knownNonMonetaryType && amountCellsShowZeroOrDash && mappingMatches &&
      balancePresent && requiredDescriptionPresent && dateParses(raw) && monetaryFieldsParse,
    amountColumnMappingError: structure === undefined || neighborColumnMappingConsistent === null
      ? null
      : !mappingMatches,
  };
}
