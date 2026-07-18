import { parse, type HTMLElement } from "node-html-parser";
import type { Frame } from "playwright";

import { KB_SELECTORS } from "../config/selectors.js";
import {
  TransactionParseError,
  type ParserErrorCode,
  type ParserStage,
  type ParserStructureDiagnostics,
  type AmountCellStructureDiagnostic,
  type TransactionRowStructureDiagnostic,
} from "./kb-errors.js";
import { normalizeMoney, normalizeOccurredAt, normalizeText } from "../transaction/normalize.js";
import type { RawKbTransaction } from "../transaction/transaction.js";

type RawField = keyof RawKbTransaction;
type HeaderField = RawField | "dateTimeText";

export interface ParseOptions {
  expectedTransactionCount?: number;
}

export type DetailRowRole =
  | "empty"
  | "transaction_memo"
  | "sender_description"
  | "receiver_description"
  | "additional_description"
  | "accessibility_duplicate"
  | "layout_only"
  | "unknown";

type DetailRowRoleFamily = "sender_side" | "receiver_side" | "neutral" | "unknown";

export interface TransactionRowDiagnostics {
  totalBodyRowCount: number;
  mainTransactionRowCount: number;
  detailRowCount: number;
  matchedDetailRowCount: number;
  unmatchedDetailRowCount: number;
  orphanDetailRowCount: number;
  detailRowsMatchedToTransactions: boolean;
  detailRowRole: DetailRowRole | null;
  detailRowsFollowMain: boolean;
  detailColspanValidated: boolean;
  transactionStructures?: readonly TransactionRowStructureDiagnostic[];
}

export interface ParsedRawTransactions {
  transactions: RawKbTransaction[];
  rowDiagnostics: TransactionRowDiagnostics;
}

type ParsedTable = ParsedRawTransactions & { parserDiagnostics: ParserStructureDiagnostics };

interface ParserTableContext {
  tableCount: number;
  candidateTableCount: number;
  selectedTableIndex: number;
}

const HEADER_ALIASES: ReadonlyArray<readonly [HeaderField, readonly string[]]> = [
  ["dateTimeText", ["거래일시", "거래일자/시간"]],
  ["dateText", ["거래일자", "거래일", "날짜"]],
  ["timeText", ["거래시간", "시간"]],
  ["transactionTypeText", ["거래구분", "거래유형", "구분"]],
  ["descriptionText", ["적요", "거래내용", "내용"]],
  ["memoText", ["메모", "통장표시", "내통장표시내용", "받는분/보낸분"]],
  ["withdrawalText", ["출금액", "찾으신금액", "출금금액"]],
  ["depositText", ["입금액", "맡기신금액", "입금금액"]],
  ["balanceText", ["잔액", "거래후잔액"]],
  ["branchText", ["취급점", "거래점", "처리점"]],
];

const RAW_FIELDS: readonly RawField[] = [
  "dateText",
  "timeText",
  "transactionTypeText",
  "descriptionText",
  "memoText",
  "withdrawalText",
  "depositText",
  "balanceText",
  "branchText",
];

const EXPLICIT_EMPTY_PATTERNS = [
  /거래\s*내역이\s*없/iu,
  /조회된\s*내역이\s*없/iu,
  /조회\s*결과가\s*없/iu,
  /조회하실\s*내역이\s*없/iu,
] as const;

function isExplicitEmpty(value: string): boolean {
  return EXPLICIT_EMPTY_PATTERNS.some((pattern) => pattern.test(normalizeText(value)));
}

function emptyRawTransaction(): RawKbTransaction {
  return {
    dateText: "",
    timeText: "",
    transactionTypeText: "",
    descriptionText: "",
    memoText: "",
    withdrawalText: "",
    depositText: "",
    balanceText: "",
    branchText: "",
  };
}

function compactHeader(value: string): string {
  return normalizeText(value).replace(/\s+/gu, "");
}

function identifyHeader(value: string): HeaderField | null {
  const compact = compactHeader(value);
  for (const [field, aliases] of HEADER_ALIASES) {
    if (aliases.some((alias) => compact === compactHeader(alias))) {
      return field;
    }
  }
  return null;
}

function hasRequiredHeaders(headers: readonly (HeaderField | null)[]): boolean {
  const hasDate = headers.includes("dateText") || headers.includes("dateTimeText");
  return hasDate && headers.includes("descriptionText") &&
    headers.includes("withdrawalText") && headers.includes("depositText");
}

function emptyParserDiagnostics(overrides: Partial<ParserStructureDiagnostics> = {}): ParserStructureDiagnostics {
  return {
    tableCount: 0,
    candidateTableCount: 0,
    selectedTableIndex: null,
    selectedTableRowCount: null,
    selectedTableColumnCount: null,
    headerRowCount: 0,
    dataRowCount: 0,
    detailRowCount: 0,
    rowCellCounts: [],
    mainTransactionCandidateCount: 0,
    detailRowCandidateCount: 0,
    headerMatched: false,
    dateParseSuccessCount: 0,
    dateParseFailureCount: 0,
    amountParseSuccessCount: 0,
    amountParseFailureCount: 0,
    balanceParseSuccessCount: 0,
    balanceParseFailureCount: 0,
    detailRowsMatchedToTransactions: null,
    ...overrides,
  };
}

function refreshValueDiagnostics(
  transactions: readonly RawKbTransaction[],
  diagnostics: ParserStructureDiagnostics,
): void {
  diagnostics.dateParseSuccessCount = 0;
  diagnostics.dateParseFailureCount = 0;
  diagnostics.amountParseSuccessCount = 0;
  diagnostics.amountParseFailureCount = 0;
  diagnostics.balanceParseSuccessCount = 0;
  diagnostics.balanceParseFailureCount = 0;
  for (const transaction of transactions) {
    try {
      normalizeOccurredAt(transaction.dateText, transaction.timeText);
      diagnostics.dateParseSuccessCount += 1;
    } catch {
      diagnostics.dateParseFailureCount += 1;
    }
    try {
      normalizeMoney(transaction.withdrawalText);
      normalizeMoney(transaction.depositText);
      if (normalizeText(transaction.withdrawalText) === "" && normalizeText(transaction.depositText) === "") {
        throw new Error("missing amount");
      }
      diagnostics.amountParseSuccessCount += 1;
    } catch {
      diagnostics.amountParseFailureCount += 1;
    }
    try {
      normalizeMoney(transaction.balanceText, { nullable: true });
      diagnostics.balanceParseSuccessCount += 1;
    } catch {
      diagnostics.balanceParseFailureCount += 1;
    }
  }
}

function parserError(
  message: string,
  parserErrorCode: ParserErrorCode,
  parserStage: ParserStage,
  diagnostics: ParserStructureDiagnostics,
  transactions: readonly RawKbTransaction[] = [],
): TransactionParseError {
  refreshValueDiagnostics(transactions, diagnostics);
  return new TransactionParseError(message, {
    parserErrorCode,
    parserStage,
    parserDiagnostics: { ...diagnostics, rowCellCounts: [...diagnostics.rowCellCounts] },
  });
}

function splitDateTime(value: string): { dateText: string; timeText: string } {
  const match = normalizeText(value).match(/^(\d{4}[./-]?\d{2}[./-]?\d{2})\s+(.+)$/u);
  if (match?.[1] === undefined || match[2] === undefined) {
    return { dateText: value, timeText: "" };
  }
  return { dateText: match[1], timeText: match[2] };
}

function isHiddenOrTemplateRow(row: HTMLElement): boolean {
  const style = row.getAttribute("style") ?? "";
  const className = row.getAttribute("class") ?? "";
  return row.getAttribute("hidden") !== undefined ||
    row.getAttribute("aria-hidden") === "true" ||
    /display\s*:\s*none/iu.test(style) ||
    /(?:^|\s)(?:hidden|template|sample)(?:\s|$)/iu.test(className);
}

function positiveSpan(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function isHiddenCell(cell: HTMLElement): boolean {
  const style = cell.getAttribute("style") ?? "";
  const className = cell.getAttribute("class") ?? "";
  return cell.getAttribute("hidden") !== undefined || cell.getAttribute("aria-hidden") === "true" ||
    /display\s*:\s*none/iu.test(style) || /(?:^|\s)hidden(?:\s|$)/iu.test(className);
}

function amountCellStructure(
  cells: readonly HTMLElement[],
  cellIndex: number,
): AmountCellStructureDiagnostic | null {
  const cell = cells[cellIndex];
  if (cell === undefined) return null;
  const logicalColumnIndex = cells.slice(0, cellIndex)
    .reduce((total, previous) => total + positiveSpan(previous.getAttribute("colspan")), 0);
  const text = cell.text;
  const numericTokens = normalizeText(text).match(/[+-]?\d[\d,]*(?:\.\d+)?-?/gu) ?? [];
  return {
    cellIndex,
    logicalColumnIndex,
    colspan: positiveSpan(cell.getAttribute("colspan")),
    rowspan: positiveSpan(cell.getAttribute("rowspan")),
    hidden: isHiddenCell(cell),
    inputCount: cell.querySelectorAll("input").length,
    spanCount: cell.querySelectorAll("span").length,
    textContentLength: text.length,
    numericTokenCount: numericTokens.length,
    numericTokenHasSign: numericTokens.some((token) => /^[+-]/u.test(token) || token.endsWith("-")),
  };
}

function transactionRowStructure(
  headers: readonly (HeaderField | null)[],
  cells: readonly HTMLElement[],
): TransactionRowStructureDiagnostic {
  const headerWithdrawalCellIndex = headers.indexOf("withdrawalText");
  const headerDepositCellIndex = headers.indexOf("depositText");
  const headerBalanceCellIndex = headers.indexOf("balanceText");
  const withdrawalCell = amountCellStructure(cells, headerWithdrawalCellIndex);
  const depositCell = amountCellStructure(cells, headerDepositCellIndex);
  const balanceCell = amountCellStructure(cells, headerBalanceCellIndex);
  const matches = (cell: AmountCellStructureDiagnostic | null, headerIndex: number): boolean =>
    cell !== null && headerIndex >= 0 && cell.cellIndex === headerIndex && cell.logicalColumnIndex === headerIndex &&
    cell.colspan === 1 && !cell.hidden;
  return {
    selectedRowCellCount: cells.length,
    headerWithdrawalCellIndex: headerWithdrawalCellIndex < 0 ? null : headerWithdrawalCellIndex,
    headerDepositCellIndex: headerDepositCellIndex < 0 ? null : headerDepositCellIndex,
    headerBalanceCellIndex: headerBalanceCellIndex < 0 ? null : headerBalanceCellIndex,
    withdrawalCell,
    depositCell,
    balanceCell,
    columnMappingMatchesHeader: cells.length === headers.length && matches(withdrawalCell, headerWithdrawalCellIndex) &&
      matches(depositCell, headerDepositCellIndex) && matches(balanceCell, headerBalanceCellIndex),
  };
}

function appendDetailText(raw: RawKbTransaction, value: string): void {
  raw.memoText = normalizeText([raw.memoText, value].filter((part) => normalizeText(part) !== "").join(" "));
}

function classifyDetailRow(
  row: HTMLElement,
  cells: readonly HTMLElement[],
  headerCount: number,
  previous: RawKbTransaction | undefined,
  secondaryHeaderText: string,
  diagnostics: ParserStructureDiagnostics,
  transactions: readonly RawKbTransaction[],
): { role: DetailRowRole; family: DetailRowRoleFamily; colspanValidated: boolean } | null {
  if (cells.length !== 1) return null;
  const directHeaders = row.querySelectorAll(":scope > th");
  const directHeaderText = normalizeText(directHeaders.map((header) => header.text).join(" "));
  const knownRoleHeader = /(?:메모|통장표시|의뢰인|보낸분|보내는분|송금인|수취인|받는분|받으실분)/u;
  const roleHeaderText = knownRoleHeader.test(directHeaderText)
    ? directHeaderText
    : (secondaryHeaderText || directHeaderText);
  const headerText = normalizeText([directHeaderText, secondaryHeaderText].join(" "));
  const value = normalizeText(cells[0]?.text ?? "");
  const colspan = Number.parseInt(cells[0]?.getAttribute("colspan") ?? "0", 10);
  const logicalColumnCount = directHeaders.length + (Number.isFinite(colspan) ? colspan : 0);
  const colspanValidated = logicalColumnCount === headerCount || colspan === headerCount;
  const looksLikeDetail = /(?:의뢰인|수취인|보낸분|받는분|메모|통장표시)/u.test(headerText) || colspanValidated;
  if (!looksLikeDetail) return null;
  if (previous === undefined) {
    throw parserError("상세 행 앞에 본거래 행이 없습니다", "ORPHAN_DETAIL_ROW", "row_classification", diagnostics, transactions);
  }
  if (value === "") return { role: "empty", family: "neutral", colspanValidated };
  if (/(?:메모|통장표시)/u.test(roleHeaderText)) {
    appendDetailText(previous, value);
    return { role: "transaction_memo", family: "neutral", colspanValidated };
  }
  const senderSide = /(?:의뢰인|보낸분|보내는분|송금인)/u.test(roleHeaderText);
  const receiverSide = /(?:수취인|받는분|받으실분)/u.test(roleHeaderText);
  if (senderSide && !receiverSide) {
    appendDetailText(previous, value);
    return { role: "sender_description", family: "sender_side", colspanValidated };
  }
  if (receiverSide && !senderSide) {
    appendDetailText(previous, value);
    return { role: "receiver_description", family: "receiver_side", colspanValidated };
  }
  if (senderSide && receiverSide) {
    appendDetailText(previous, value);
    return { role: "additional_description", family: "neutral", colspanValidated };
  }
  if ([previous.descriptionText, previous.memoText].some((text) => normalizeText(text) === value)) {
    return { role: "accessibility_duplicate", family: "neutral", colspanValidated };
  }
  if (/^(?:-|—|ㆍ|\u00a0)$/u.test(value)) return { role: "layout_only", family: "neutral", colspanValidated };
  return { role: "unknown", family: "unknown", colspanValidated };
}

function validateRawRows(transactions: readonly RawKbTransaction[], diagnostics: ParserStructureDiagnostics): void {
  refreshValueDiagnostics(transactions, diagnostics);
  for (const transaction of transactions) {
    if (normalizeText(transaction.dateText) === "") {
      throw parserError(
        "거래 날짜가 비어 있습니다", "INVALID_TRANSACTION_DATE", "transaction_validation", diagnostics, transactions,
      );
    }
    if (normalizeText(transaction.withdrawalText) === "" && normalizeText(transaction.depositText) === "") {
      throw parserError("거래 금액 정보가 비어 있습니다", "INVALID_AMOUNT", "transaction_validation", diagnostics, transactions);
    }
  }
}

function parseTable(table: HTMLElement, context: ParserTableContext): ParsedTable | null {
  const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
  if (headerRow === null) return null;
  const headers = headerRow.querySelectorAll("th,td").map((cell) => identifyHeader(cell.text));
  const secondaryHeaderText = normalizeText(
    table.querySelectorAll("thead tr").slice(1).flatMap((row) => row.querySelectorAll("th,td")).map((cell) => cell.text).join(" "),
  );
  const hasRequiredColumns = hasRequiredHeaders(headers);
  if (!hasRequiredColumns) return null;

  const bodyRows = table.querySelectorAll("tbody tr");
  const candidateRows = (bodyRows.length > 0
    ? bodyRows
    : table.querySelectorAll("tr").filter((row) => row !== headerRow))
    .filter((row) => row !== headerRow && !isHiddenOrTemplateRow(row) && !isExplicitEmpty(row.text));
  const rowCellCounts = candidateRows.map((row) => row.querySelectorAll(":scope > td").length);
  const diagnostics = emptyParserDiagnostics({
    tableCount: context.tableCount,
    candidateTableCount: context.candidateTableCount,
    selectedTableIndex: context.selectedTableIndex,
    selectedTableRowCount: table.querySelectorAll("tr").length,
    selectedTableColumnCount: headers.length,
    headerRowCount: table.querySelectorAll("thead tr").length || 1,
    dataRowCount: candidateRows.length,
    rowCellCounts,
    mainTransactionCandidateCount: rowCellCounts.filter((count) => count === headers.length).length,
    detailRowCandidateCount: rowCellCounts.filter((count) => count === 1).length,
    headerMatched: true,
  });
  const transactions: RawKbTransaction[] = [];
  const transactionStructures: TransactionRowStructureDiagnostic[] = [];
  const detailRoles: DetailRowRole[] = [];
  const detailRoleFamilies: DetailRowRoleFamily[] = [];
  let detailRowsFollowMain = true;
  let detailColspanValidated = true;
  let previousMainHasDetail = true;
  for (const row of candidateRows) {
    const cells = row.querySelectorAll(":scope > td");
    if (cells.length === 0) continue;
    const detail = classifyDetailRow(
      row, cells, headers.length, transactions.at(-1), secondaryHeaderText, diagnostics, transactions,
    );
    if (detail !== null) {
      if (transactions.length === 0 || previousMainHasDetail) detailRowsFollowMain = false;
      previousMainHasDetail = true;
      detailRoles.push(detail.role);
      detailRoleFamilies.push(detail.family);
      diagnostics.detailRowCount = detailRoles.length;
      detailColspanValidated &&= detail.colspanValidated;
      if (detail.role === "unknown") {
        throw parserError(
          "거래 상세 행의 역할을 확정할 수 없습니다",
          "UNKNOWN_DETAIL_ROW",
          "row_classification",
          diagnostics,
          transactions,
        );
      }
      continue;
    }
    if (cells.length !== headers.length) {
      throw parserError(
        "거래 행의 필드 개수가 헤더 개수와 일치하지 않습니다",
        "UNEXPECTED_ROW_CELL_COUNT",
        "row_shape_validation",
        diagnostics,
        transactions,
      );
    }
    if (transactions.length > 0 && !previousMainHasDetail) detailRowsFollowMain = false;
    const raw = emptyRawTransaction();
    for (let index = 0; index < headers.length; index += 1) {
      const field = headers[index];
      const cell = cells[index];
      if (field === null || field === undefined || cell === undefined) continue;
      if (field === "dateTimeText") {
        Object.assign(raw, splitDateTime(cell.text));
      } else {
        raw[field] = cell.text;
      }
    }
    transactionStructures.push(transactionRowStructure(headers, cells));
    transactions.push(raw);
    previousMainHasDetail = false;
  }
  diagnostics.detailRowsMatchedToTransactions = detailRowsFollowMain &&
    (detailRoles.length === 0 || detailRoles.length === transactions.length);
  if (detailRoles.length > 0 && (!previousMainHasDetail || detailRoles.length !== transactions.length || !detailRowsFollowMain)) {
    diagnostics.detailRowsMatchedToTransactions = false;
    throw parserError(
      "본거래 행과 상세 행의 반복 관계가 일치하지 않습니다",
      "MISSING_DETAIL_ROW",
      "detail_link_validation",
      diagnostics,
      transactions,
    );
  }
  const distinctRoles = [...new Set(detailRoles)];
  const distinctRoleFamilies = [...new Set(detailRoleFamilies)];
  refreshValueDiagnostics(transactions, diagnostics);
  if (distinctRoles.length > 1 || distinctRoleFamilies.length > 1) {
    if (diagnostics.dateParseFailureCount > 0) {
      throw parserError(
        "혼합 상세 역할 거래의 날짜를 검증할 수 없습니다",
        "INVALID_TRANSACTION_DATE",
        "date_normalization",
        diagnostics,
        transactions,
      );
    }
    if (diagnostics.amountParseFailureCount > 0) {
      throw parserError(
        "혼합 상세 역할 거래의 금액을 검증할 수 없습니다",
        "INVALID_AMOUNT",
        "amount_normalization",
        diagnostics,
        transactions,
      );
    }
    if (diagnostics.balanceParseFailureCount > 0) {
      throw parserError(
        "혼합 상세 역할 거래의 잔액을 검증할 수 없습니다",
        "INVALID_BALANCE",
        "balance_normalization",
        diagnostics,
        transactions,
      );
    }
  }
  return {
    transactions,
    parserDiagnostics: diagnostics,
    rowDiagnostics: {
      totalBodyRowCount: candidateRows.length,
      mainTransactionRowCount: transactions.length,
      detailRowCount: detailRoles.length,
      matchedDetailRowCount: detailRoles.length,
      unmatchedDetailRowCount: 0,
      orphanDetailRowCount: 0,
      detailRowsMatchedToTransactions: detailRowsFollowMain &&
        (detailRoles.length === 0 || detailRoles.length === transactions.length),
      detailRowRole: distinctRoles.length === 1 ? (distinctRoles[0] ?? null) : null,
      detailRowsFollowMain,
      detailColspanValidated,
      transactionStructures,
    },
  };
}

export function combineRawTransactionColumns(columns: Partial<Record<RawField, string[]>>): RawKbTransaction[] {
  const requiredFields: readonly RawField[] = ["dateText", "descriptionText", "withdrawalText", "depositText"];
  const requiredLengths = requiredFields.map((field) => columns[field]?.length ?? 0);
  if (new Set(requiredLengths).size !== 1) {
    throw new TransactionParseError("필수 거래 필드 배열 길이가 일치하지 않습니다", {
      parserErrorCode: "COLUMN_LENGTH_MISMATCH",
      parserStage: "column_validation",
    });
  }
  const count = requiredLengths[0] ?? 0;
  for (const [field, values] of Object.entries(columns)) {
    if (values !== undefined && values.length !== count) {
      throw new TransactionParseError(`선택 거래 필드 배열 길이가 일치하지 않습니다: ${field}`, {
        parserErrorCode: "COLUMN_LENGTH_MISMATCH",
        parserStage: "column_validation",
      });
    }
  }

  return Array.from({ length: count }, (_, index) => {
    const raw = emptyRawTransaction();
    for (const field of RAW_FIELDS) {
      raw[field] = columns[field]?.[index] ?? "";
    }
    if (normalizeText(raw.dateText) === "") {
      throw new TransactionParseError("거래 날짜가 비어 있습니다", {
        parserErrorCode: "INVALID_TRANSACTION_DATE",
        parserStage: "transaction_validation",
      });
    }
    if (normalizeText(raw.withdrawalText) === "" && normalizeText(raw.depositText) === "") {
      throw new TransactionParseError("거래 금액 정보가 비어 있습니다", {
        parserErrorCode: "INVALID_AMOUNT",
        parserStage: "transaction_validation",
      });
    }
    return raw;
  });
}

function parseSplitColumns(root: HTMLElement): RawKbTransaction[] | null {
  const columns: Partial<Record<RawField, string[]>> = {};
  for (const field of RAW_FIELDS) {
    const elements = root.querySelectorAll(`[data-kb-field="${field}"]`);
    if (elements.length > 0) columns[field] = elements.map((element) => element.text);
  }
  return Object.keys(columns).length === 0 ? null : combineRawTransactionColumns(columns);
}

export function parseRawTransactionsWithDiagnostics(html: string, options: ParseOptions = {}): ParsedRawTransactions {
  const root = parse(html);
  if (isExplicitEmpty(root.text)) {
    return {
      transactions: [],
      rowDiagnostics: {
        totalBodyRowCount: 1,
        mainTransactionRowCount: 0,
        detailRowCount: 0,
        matchedDetailRowCount: 0,
        unmatchedDetailRowCount: 0,
        orphanDetailRowCount: 0,
        detailRowsMatchedToTransactions: true,
        detailRowRole: null,
        detailRowsFollowMain: true,
        detailColspanValidated: true,
      },
    };
  }
  const tables = root.querySelectorAll("table");
  const candidateTableCount = tables.filter((table) => {
    const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
    if (headerRow === null) return false;
    return hasRequiredHeaders(headerRow.querySelectorAll("th,td").map((cell) => identifyHeader(cell.text)));
  }).length;
  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    const table = tables[tableIndex];
    if (table === undefined) continue;
    const parsed = parseTable(table, { tableCount: tables.length, candidateTableCount, selectedTableIndex: tableIndex });
    if (parsed !== null) {
      validateRawRows(parsed.transactions, parsed.parserDiagnostics);
      if (options.expectedTransactionCount !== undefined && parsed.transactions.length !== options.expectedTransactionCount) {
        throw parserError(
          "화면 거래 건수와 파싱 거래 건수가 일치하지 않습니다",
          "SCREEN_TRANSACTION_COUNT_MISMATCH",
          "screen_count_validation",
          parsed.parserDiagnostics,
          parsed.transactions,
        );
      }
      return { transactions: parsed.transactions, rowDiagnostics: parsed.rowDiagnostics };
    }
  }
  const split = parseSplitColumns(root);
  if (split !== null) {
    const splitDiagnostics = emptyParserDiagnostics({
      tableCount: tables.length,
      candidateTableCount,
      dataRowCount: split.length,
      mainTransactionCandidateCount: split.length,
      headerMatched: false,
    });
    validateRawRows(split, splitDiagnostics);
    if (options.expectedTransactionCount !== undefined && split.length !== options.expectedTransactionCount) {
      throw parserError(
        "화면 거래 건수와 파싱 거래 건수가 일치하지 않습니다",
        "SCREEN_TRANSACTION_COUNT_MISMATCH",
        "screen_count_validation",
        splitDiagnostics,
        split,
      );
    }
    return {
      transactions: split,
      rowDiagnostics: {
        totalBodyRowCount: split.length,
        mainTransactionRowCount: split.length,
        detailRowCount: 0,
        matchedDetailRowCount: 0,
        unmatchedDetailRowCount: 0,
        orphanDetailRowCount: 0,
        detailRowsMatchedToTransactions: true,
        detailRowRole: null,
        detailRowsFollowMain: true,
        detailColspanValidated: true,
      },
    };
  }
  throw new TransactionParseError("지원되는 거래별 부모 또는 필드 배열 구조를 찾지 못했습니다", {
    parserErrorCode: candidateTableCount > 1 ? "MULTIPLE_CANDIDATE_TABLES" : "HEADER_MISMATCH",
    parserStage: candidateTableCount > 1 ? "table_discovery" : "header_validation",
    parserDiagnostics: emptyParserDiagnostics({ tableCount: tables.length, candidateTableCount }),
  });
}

export function parseRawTransactionsFromHtml(html: string, options: ParseOptions = {}): RawKbTransaction[] {
  return parseRawTransactionsWithDiagnostics(html, options).transactions;
}

export async function parseKbTransactions(
  resultFrame: Frame,
  options: ParseOptions = {},
): Promise<ParsedRawTransactions> {
  const resultContainer = resultFrame.locator(KB_SELECTORS.resultComponent);
  const transactionTable = resultFrame.locator(KB_SELECTORS.transactionTable);
  const [containerCount, tableCount, containerVisible, tableVisible] = await Promise.all([
    resultContainer.count(),
    transactionTable.count(),
    resultContainer.isVisible().catch(() => false),
    transactionTable.isVisible().catch(() => false),
  ]);
  if (containerCount !== 1 || tableCount !== 1 || !containerVisible || !tableVisible) {
    throw new TransactionParseError("결과 Page 또는 Frame에서 검증된 거래 테이블을 찾지 못했습니다", {
      parserErrorCode: "TRANSACTION_TABLE_NOT_FOUND",
      parserStage: "table_discovery",
      parserDiagnostics: emptyParserDiagnostics({
        tableCount,
        candidateTableCount: tableCount,
        headerMatched: tableCount === 1,
      }),
    });
  }
  return parseRawTransactionsWithDiagnostics(await resultContainer.innerHTML(), options);
}
