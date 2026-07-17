import { parse, type HTMLElement } from "node-html-parser";
import type { Frame } from "playwright";

import { KB_SELECTORS } from "../config/selectors.js";
import { TransactionParseError } from "./kb-errors.js";
import { normalizeText } from "../transaction/normalize.js";
import type { RawKbTransaction } from "../transaction/transaction.js";

type RawField = keyof RawKbTransaction;
type HeaderField = RawField | "dateTimeText";

export interface ParseOptions {
  expectedTransactionCount?: number;
}

export type DetailRowRole =
  | "empty"
  | "transaction_memo"
  | "additional_description"
  | "accessibility_duplicate"
  | "layout_only"
  | "unknown";

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
}

export interface ParsedRawTransactions {
  transactions: RawKbTransaction[];
  rowDiagnostics: TransactionRowDiagnostics;
}

type ParsedTable = ParsedRawTransactions;

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

function appendDetailText(raw: RawKbTransaction, value: string): void {
  raw.memoText = normalizeText([raw.memoText, value].filter((part) => normalizeText(part) !== "").join(" "));
}

function classifyDetailRow(
  row: HTMLElement,
  cells: readonly HTMLElement[],
  headerCount: number,
  previous: RawKbTransaction | undefined,
  secondaryHeaderText: string,
): { role: DetailRowRole; colspanValidated: boolean } | null {
  if (cells.length !== 1) return null;
  const directHeaders = row.querySelectorAll(":scope > th");
  const headerText = normalizeText([directHeaders.map((header) => header.text).join(" "), secondaryHeaderText].join(" "));
  const value = normalizeText(cells[0]?.text ?? "");
  const colspan = Number.parseInt(cells[0]?.getAttribute("colspan") ?? "0", 10);
  const logicalColumnCount = directHeaders.length + (Number.isFinite(colspan) ? colspan : 0);
  const colspanValidated = logicalColumnCount === headerCount || colspan === headerCount;
  const looksLikeDetail = /(?:의뢰인|수취인|보낸분|받는분|메모|통장표시)/u.test(headerText) || colspanValidated;
  if (!looksLikeDetail) return null;
  if (previous === undefined) {
    throw new TransactionParseError("상세 행 앞에 본거래 행이 없습니다");
  }
  if (value === "") return { role: "empty", colspanValidated };
  if (/(?:메모|통장표시)/u.test(headerText)) {
    appendDetailText(previous, value);
    return { role: "transaction_memo", colspanValidated };
  }
  if (/(?:의뢰인|수취인|보낸분|받는분)/u.test(headerText)) {
    appendDetailText(previous, value);
    return { role: "additional_description", colspanValidated };
  }
  if ([previous.descriptionText, previous.memoText].some((text) => normalizeText(text) === value)) {
    return { role: "accessibility_duplicate", colspanValidated };
  }
  if (/^(?:-|—|ㆍ|\u00a0)$/u.test(value)) return { role: "layout_only", colspanValidated };
  return { role: "unknown", colspanValidated };
}

function validateRawRows(transactions: readonly RawKbTransaction[]): void {
  for (const transaction of transactions) {
    if (normalizeText(transaction.dateText) === "") {
      throw new TransactionParseError("거래 날짜가 비어 있습니다");
    }
    if (normalizeText(transaction.withdrawalText) === "" && normalizeText(transaction.depositText) === "") {
      throw new TransactionParseError("거래 금액 정보가 비어 있습니다");
    }
  }
}

function parseTable(table: HTMLElement): ParsedTable | null {
  const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
  if (headerRow === null) return null;
  const headers = headerRow.querySelectorAll("th,td").map((cell) => identifyHeader(cell.text));
  const secondaryHeaderText = normalizeText(
    table.querySelectorAll("thead tr").slice(1).flatMap((row) => row.querySelectorAll("th,td")).map((cell) => cell.text).join(" "),
  );
  const hasDate = headers.includes("dateText") || headers.includes("dateTimeText");
  const hasRequiredColumns = hasDate && headers.includes("descriptionText") &&
    headers.includes("withdrawalText") && headers.includes("depositText");
  if (!hasRequiredColumns) return null;

  const bodyRows = table.querySelectorAll("tbody tr");
  const candidateRows = (bodyRows.length > 0
    ? bodyRows
    : table.querySelectorAll("tr").filter((row) => row !== headerRow))
    .filter((row) => row !== headerRow && !isHiddenOrTemplateRow(row) && !isExplicitEmpty(row.text));
  const transactions: RawKbTransaction[] = [];
  const detailRoles: DetailRowRole[] = [];
  let detailRowsFollowMain = true;
  let detailColspanValidated = true;
  let previousMainHasDetail = true;
  for (const row of candidateRows) {
    const cells = row.querySelectorAll(":scope > td");
    if (cells.length === 0) continue;
    const detail = classifyDetailRow(row, cells, headers.length, transactions.at(-1), secondaryHeaderText);
    if (detail !== null) {
      if (transactions.length === 0 || previousMainHasDetail) detailRowsFollowMain = false;
      previousMainHasDetail = true;
      detailRoles.push(detail.role);
      detailColspanValidated &&= detail.colspanValidated;
      if (detail.role === "unknown") {
        throw new TransactionParseError("거래 상세 행의 역할을 확정할 수 없습니다");
      }
      continue;
    }
    if (cells.length !== headers.length) {
      throw new TransactionParseError("거래 행의 필드 개수가 헤더 개수와 일치하지 않습니다");
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
    transactions.push(raw);
    previousMainHasDetail = false;
  }
  if (detailRoles.length > 0 && (!previousMainHasDetail || detailRoles.length !== transactions.length || !detailRowsFollowMain)) {
    throw new TransactionParseError("본거래 행과 상세 행의 반복 관계가 일치하지 않습니다");
  }
  const distinctRoles = [...new Set(detailRoles)];
  if (distinctRoles.length > 1) {
    throw new TransactionParseError("거래 상세 행 역할이 거래마다 일치하지 않습니다");
  }
  return {
    transactions,
    rowDiagnostics: {
      totalBodyRowCount: candidateRows.length,
      mainTransactionRowCount: transactions.length,
      detailRowCount: detailRoles.length,
      matchedDetailRowCount: detailRoles.length,
      unmatchedDetailRowCount: 0,
      orphanDetailRowCount: 0,
      detailRowsMatchedToTransactions: detailRowsFollowMain &&
        (detailRoles.length === 0 || detailRoles.length === transactions.length),
      detailRowRole: distinctRoles[0] ?? null,
      detailRowsFollowMain,
      detailColspanValidated,
    },
  };
}

export function combineRawTransactionColumns(columns: Partial<Record<RawField, string[]>>): RawKbTransaction[] {
  const requiredFields: readonly RawField[] = ["dateText", "descriptionText", "withdrawalText", "depositText"];
  const requiredLengths = requiredFields.map((field) => columns[field]?.length ?? 0);
  if (new Set(requiredLengths).size !== 1) {
    throw new TransactionParseError("필수 거래 필드 배열 길이가 일치하지 않습니다");
  }
  const count = requiredLengths[0] ?? 0;
  for (const [field, values] of Object.entries(columns)) {
    if (values !== undefined && values.length !== count) {
      throw new TransactionParseError(`선택 거래 필드 배열 길이가 일치하지 않습니다: ${field}`);
    }
  }

  return Array.from({ length: count }, (_, index) => {
    const raw = emptyRawTransaction();
    for (const field of RAW_FIELDS) {
      raw[field] = columns[field]?.[index] ?? "";
    }
    if (normalizeText(raw.dateText) === "") {
      throw new TransactionParseError("거래 날짜가 비어 있습니다");
    }
    if (normalizeText(raw.withdrawalText) === "" && normalizeText(raw.depositText) === "") {
      throw new TransactionParseError("거래 금액 정보가 비어 있습니다");
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
  for (const table of root.querySelectorAll("table")) {
    const parsed = parseTable(table);
    if (parsed !== null) {
      validateRawRows(parsed.transactions);
      if (options.expectedTransactionCount !== undefined && parsed.transactions.length !== options.expectedTransactionCount) {
        throw new TransactionParseError("화면 거래 건수와 파싱 거래 건수가 일치하지 않습니다");
      }
      return parsed;
    }
  }
  const split = parseSplitColumns(root);
  if (split !== null) {
    validateRawRows(split);
    if (options.expectedTransactionCount !== undefined && split.length !== options.expectedTransactionCount) {
      throw new TransactionParseError("화면 거래 건수와 파싱 거래 건수가 일치하지 않습니다");
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
  throw new TransactionParseError("지원되는 거래별 부모 또는 필드 배열 구조를 찾지 못했습니다");
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
    throw new TransactionParseError("결과 Page 또는 Frame에서 검증된 거래 테이블을 찾지 못했습니다");
  }
  return parseRawTransactionsWithDiagnostics(await resultContainer.innerHTML(), options);
}
