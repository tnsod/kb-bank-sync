import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  combineRawTransactionColumns,
  parseKbTransactions,
  parseRawTransactionsFromHtml,
  parseRawTransactionsWithDiagnostics,
} from "../src/bank/kb-parser.js";
import { normalizeAndValidateTransaction } from "../src/transaction/validate.js";
import { KB_SELECTORS } from "../src/config/selectors.js";
import { TransactionParseError, parserFailureDiagnostic } from "../src/bank/kb-errors.js";
import type { Frame } from "playwright";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "kb-transactions-sanitized.html");
const actualStructureSuccessFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "kb-result-success.html");
const actualStructureEmptyFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "kb-result-empty.html");
const mixedDetailRolesFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "fixtures", "kb-result-mixed-detail-roles.html",
);

function detailRoleTable(detailRows: readonly string[]): string {
  const mainRows = detailRows.map((detail, index) => `
    <tr>
      <td>2026-01-0${index + 1} 0${index + 1}:00:00</td><td>가상항목-${index + 1}</td><td>샘플-${index + 1}</td>
      <td>${index % 2 === 0 ? index + 1 : ""}</td><td>${index % 2 === 0 ? "" : index + 1}</td>
      <td>${100 + index}</td><td>샘플점</td><td>${index % 2 === 0 ? "출금" : "입금"}</td>
    </tr>
    ${detail}`).join("");
  return `
    <table class="tType01"><thead>
      <tr><th>거래일시</th><th>적요</th><th>내통장표시내용</th><th>출금금액</th><th>입금금액</th><th>잔액</th><th>거래점</th><th>구분</th></tr>
      <tr><th>상세정보</th></tr>
    </thead><tbody>${mainRows}</tbody></table>`;
}

function knownDetailRow(role: string, value: string): string {
  return `<tr><th scope="row">${role}</th><td colspan="7">${value}</td></tr>`;
}

describe("KB transaction parser", () => {
  it("parses privacy-safe transaction rows by their common parent", async () => {
    const html = await readFile(fixturePath, "utf8");
    const transactions = parseRawTransactionsFromHtml(html);
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      dateText: "2026.07.14",
      timeText: "09:10:11",
      descriptionText: "가상거래 A",
      withdrawalText: "-",
      depositText: "12,345원",
    });
  });

  it("returns an empty list for a recognized empty table", () => {
    const html = "<table><thead><tr><th>거래일자</th><th>적요</th><th>출금액</th><th>입금액</th></tr></thead><tbody></tbody></table>";
    expect(parseRawTransactionsFromHtml(html)).toEqual([]);
  });

  it("recognizes the verified KB empty-result row without counting it as a transaction", async () => {
    const html = await readFile(actualStructureEmptyFixture, "utf8");
    expect(parseRawTransactionsFromHtml(html, { expectedTransactionCount: 0 })).toEqual([]);
  });

  it("parses the sanitized #b028770 transaction table header and rows", async () => {
    const html = await readFile(actualStructureSuccessFixture, "utf8");
    const transactions = parseRawTransactionsFromHtml(html, { expectedTransactionCount: 2 });
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      dateText: "2026.07.01",
      timeText: "14:30:00",
      memoText: "테스트메모 테스트사용자",
      withdrawalText: "",
      depositText: "10000",
      branchText: "테스트지점",
      transactionTypeText: "입금",
    });
  });

  it("parses the explicitly resolved result Frame without touching the opener Frame", async () => {
    const html = await readFile(actualStructureSuccessFixture, "utf8");
    const openerLocator = vi.fn(() => { throw new Error("The opener must not be parsed"); });
    const resultLocator = vi.fn((selector: string) => {
      if (selector === KB_SELECTORS.resultComponent) {
        return {
          count: vi.fn().mockResolvedValue(1),
          isVisible: vi.fn().mockResolvedValue(true),
          innerHTML: vi.fn().mockResolvedValue(html),
        };
      }
      if (selector === KB_SELECTORS.transactionTable) {
        return { count: vi.fn().mockResolvedValue(1), isVisible: vi.fn().mockResolvedValue(true) };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    });
    const resultFrame = { locator: resultLocator } as unknown as Frame;
    const parsed = await parseKbTransactions(resultFrame, { expectedTransactionCount: 2 });
    expect(parsed.transactions).toHaveLength(2);
    expect(resultLocator).toHaveBeenCalledWith(KB_SELECTORS.resultComponent);
    expect(openerLocator).not.toHaveBeenCalled();
  });

  it("classifies verified one-cell rows as additional descriptions following each transaction", async () => {
    const html = await readFile(actualStructureSuccessFixture, "utf8");
    const parsed = parseRawTransactionsWithDiagnostics(html, { expectedTransactionCount: 2 });
    expect(parsed.rowDiagnostics).toMatchObject({
      totalBodyRowCount: 4,
      mainTransactionRowCount: 2,
      detailRowCount: 2,
      matchedDetailRowCount: 2,
      unmatchedDetailRowCount: 0,
      orphanDetailRowCount: 0,
      detailRowsMatchedToTransactions: true,
      detailRowRole: "additional_description",
      detailRowsFollowMain: true,
      detailColspanValidated: true,
    });
    expect(parsed.transactions.every((transaction) => transaction.memoText.includes("테스트사용자"))).toBe(true);
    expect(parsed.rowDiagnostics.transactionStructures).toHaveLength(2);
    expect(parsed.rowDiagnostics.transactionStructures?.[0]).toMatchObject({
      selectedRowCellCount: 8,
      headerWithdrawalCellIndex: 3,
      headerDepositCellIndex: 4,
      headerBalanceCellIndex: 5,
      columnMappingMatchesHeader: true,
      withdrawalCell: { cellIndex: 3, colspan: 1, rowspan: 1, inputCount: 0, spanCount: 0 },
      depositCell: { cellIndex: 4, colspan: 1, rowspan: 1, inputCount: 0, spanCount: 0 },
      balanceCell: { cellIndex: 5, colspan: 1, rowspan: 1, inputCount: 0, spanCount: 0 },
    });
  });

  it("records nested amount elements and a shifted logical column without exposing cell text", () => {
    const privateAmount = "PRIVATE_AMOUNT_TOKEN";
    const html = `
      <table><thead><tr>
        <th>거래일시</th><th>적요</th><th>내통장표시내용</th><th>출금금액</th>
        <th>입금금액</th><th>잔액</th><th>거래점</th><th>구분</th>
      </tr></thead><tbody><tr>
        <td>2026-07-01 10:00:00</td><td>가상항목</td><td>샘플</td>
        <td colspan="2"><span>1</span><input value="${privateAmount}"></td><td></td><td>10</td><td>샘플점</td><td>출금</td>
      </tr></tbody></table>`;
    const parsed = parseRawTransactionsWithDiagnostics(html, { expectedTransactionCount: 1 });
    const structure = parsed.rowDiagnostics.transactionStructures?.[0];
    expect(structure).toMatchObject({
      selectedRowCellCount: 8,
      columnMappingMatchesHeader: false,
      withdrawalCell: { cellIndex: 3, logicalColumnIndex: 3, colspan: 2, inputCount: 1, spanCount: 1 },
      depositCell: { cellIndex: 4, logicalColumnIndex: 5 },
      balanceCell: { cellIndex: 5, logicalColumnIndex: 6 },
    });
    expect(JSON.stringify(structure)).not.toContain(privateAmount);
  });

  it("accepts three matching known detail roles", () => {
    const html = detailRoleTable([
      knownDetailRow("보낸분", "샘플표시-A"),
      knownDetailRow("보낸분", "샘플표시-B"),
      knownDetailRow("보낸분", "샘플표시-C"),
    ]);
    const parsed = parseRawTransactionsWithDiagnostics(html, { expectedTransactionCount: 3 });
    expect(parsed.transactions).toHaveLength(3);
    expect(parsed.rowDiagnostics).toMatchObject({
      detailRowRole: "sender_description",
      detailRowsMatchedToTransactions: true,
      detailRowsFollowMain: true,
    });
  });

  it("accepts mixed sender, receiver, and neutral known detail roles", async () => {
    const html = await readFile(mixedDetailRolesFixture, "utf8");
    const parsed = parseRawTransactionsWithDiagnostics(html, { expectedTransactionCount: 3 });
    expect(parsed.transactions).toHaveLength(3);
    expect(parsed.rowDiagnostics).toMatchObject({
      totalBodyRowCount: 6,
      mainTransactionRowCount: 3,
      detailRowCount: 3,
      detailRowsMatchedToTransactions: true,
      detailRowRole: null,
      detailRowsFollowMain: true,
      detailColspanValidated: true,
    });
  });

  it.each([
    {
      name: "date",
      search: "2026.01.02 02:02:02",
      replacement: "2026.02.30 02:02:02",
      parserErrorCode: "INVALID_TRANSACTION_DATE",
    },
    {
      name: "amount",
      search: "<td></td><td>202</td><td>1203</td>",
      replacement: "<td></td><td>invalid</td><td>1203</td>",
      parserErrorCode: "INVALID_AMOUNT",
    },
    {
      name: "balance",
      search: "<td></td><td>202</td><td>1203</td>",
      replacement: "<td></td><td>202</td><td>invalid</td>",
      parserErrorCode: "INVALID_BALANCE",
    },
  ] as const)("rejects mixed known roles when $name parsing fails", async ({ search, replacement, parserErrorCode }) => {
    const fixture = await readFile(mixedDetailRolesFixture, "utf8");
    expect(fixture).toContain(search);
    try {
      parseRawTransactionsWithDiagnostics(fixture.replace(search, replacement), { expectedTransactionCount: 3 });
      expect.fail("Expected a parser error");
    } catch (error) {
      expect(parserFailureDiagnostic(error as TransactionParseError)).toMatchObject({ parserErrorCode });
    }
  });

  it("accepts mixed known neutral detail roles", () => {
    const html = detailRoleTable([
      knownDetailRow("메모", "샘플메모-A"),
      knownDetailRow("상세정보", "-"),
      knownDetailRow("상세정보", "가상항목-3"),
    ]);
    const parsed = parseRawTransactionsWithDiagnostics(html, { expectedTransactionCount: 3 });
    expect(parsed.transactions).toHaveLength(3);
    expect(parsed.rowDiagnostics).toMatchObject({ detailRowsMatchedToTransactions: true, detailRowsFollowMain: true });
  });

  it.each([
    {
      name: "a missing detail row",
      rows: [knownDetailRow("보낸분", "샘플-A"), "", knownDetailRow("받는분", "샘플-C")],
    },
    {
      name: "an excessive detail row",
      rows: [
        `${knownDetailRow("보낸분", "샘플-A")}${knownDetailRow("받는분", "샘플-과다")}`,
        knownDetailRow("받는분", "샘플-B"),
        knownDetailRow("메모", "샘플-C"),
      ],
    },
    {
      name: "an out-of-order detail row",
      rows: [
        "",
        `${knownDetailRow("보낸분", "샘플-A")}${knownDetailRow("받는분", "샘플-B")}`,
        knownDetailRow("메모", "샘플-C"),
      ],
    },
  ])("rejects $name while preserving the 1:1 alternating guard", ({ rows }) => {
    expect(() => parseRawTransactionsWithDiagnostics(detailRoleTable(rows), { expectedTransactionCount: 3 }))
      .toThrowError(TransactionParseError);
    try {
      parseRawTransactionsWithDiagnostics(detailRoleTable(rows), { expectedTransactionCount: 3 });
      expect.fail("Expected a parser error");
    } catch (error) {
      expect(parserFailureDiagnostic(error as TransactionParseError)).toMatchObject({
        parserErrorCode: "MISSING_DETAIL_ROW",
        parserStage: "detail_link_validation",
        detailRowsMatchedToTransactions: false,
      });
    }
  });

  it("rejects an unknown one-cell detail row instead of discarding it", () => {
    const privateDetail = "PRIVATE_COUNTERPARTY_DETAIL";
    const html = `
      <table><thead><tr><th>거래일시</th><th>적요</th><th>출금금액</th><th>입금금액</th></tr></thead><tbody>
        <tr><td>2026-07-01 10:00:00</td><td>테스트</td><td>-</td><td>10000</td></tr>
        <tr><th>알수없음</th><td colspan="3">${privateDetail}</td></tr>
      </tbody></table>`;
    try {
      parseRawTransactionsWithDiagnostics(html);
      expect.fail("Expected a parser error");
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionParseError);
      const diagnostic = parserFailureDiagnostic(error as TransactionParseError);
      expect(diagnostic).toMatchObject({
        parserErrorCode: "UNKNOWN_DETAIL_ROW",
        parserStage: "row_classification",
        tableCount: 1,
        candidateTableCount: 1,
        selectedTableIndex: 0,
        rowCellCounts: [4, 1],
        mainTransactionCandidateCount: 1,
        detailRowCandidateCount: 1,
      });
      expect(JSON.stringify(diagnostic)).not.toContain(privateDetail);
    }
  });

  it("reports structural counts without retaining cell text for an unexpected row width", () => {
    const privateCell = "PRIVATE_DESCRIPTION_VALUE";
    const html = `
      <table><thead><tr><th>거래일시</th><th>적요</th><th>출금금액</th><th>입금금액</th></tr></thead><tbody>
        <tr><td>2026-07-01 10:00:00</td><td>${privateCell}</td><td>10000</td></tr>
      </tbody></table>`;
    try {
      parseRawTransactionsWithDiagnostics(html);
      expect.fail("Expected a parser error");
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionParseError);
      const diagnostic = parserFailureDiagnostic(error as TransactionParseError);
      expect(diagnostic).toMatchObject({
        parserErrorCode: "UNEXPECTED_ROW_CELL_COUNT",
        parserStage: "row_shape_validation",
        selectedTableRowCount: 2,
        selectedTableColumnCount: 4,
        dataRowCount: 1,
        rowCellCounts: [3],
        mainTransactionCandidateCount: 0,
        detailRowCandidateCount: 0,
      });
      expect(JSON.stringify(diagnostic)).not.toContain(privateCell);
    }
  });

  it("rejects a #b028770 screen count mismatch", async () => {
    const html = await readFile(actualStructureSuccessFixture, "utf8");
    try {
      parseRawTransactionsFromHtml(html, { expectedTransactionCount: 1 });
      expect.fail("Expected a parser error");
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionParseError);
      expect(parserFailureDiagnostic(error as TransactionParseError)).toMatchObject({
        parserErrorCode: "SCREEN_TRANSACTION_COUNT_MISMATCH",
        parserStage: "screen_count_validation",
        mainTransactionCandidateCount: 2,
        detailRowCandidateCount: 2,
        dateParseFailureCount: 0,
        amountParseFailureCount: 0,
        balanceParseFailureCount: 0,
        detailRowsMatchedToTransactions: true,
      });
    }
  });

  it("normalizes the sanitized rows with deposit and withdrawal directions intact", async () => {
    const html = await readFile(actualStructureSuccessFixture, "utf8");
    const raw = parseRawTransactionsFromHtml(html, { expectedTransactionCount: 2 });
    const transactions = raw.map((transaction) => normalizeAndValidateTransaction(
      transaction,
      "00000000000000",
      "2026-07-15T22:00:00+09:00",
      { lookupStartDate: "2026-07-01", lookupEndDate: "2026-07-15" },
    ));
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({ accountId: "KB-0000", withdrawal: 0, deposit: 10000 });
    expect(transactions[1]).toMatchObject({ accountId: "KB-0000", withdrawal: 5000, deposit: 0 });
  });

  it("combines aligned split columns", () => {
    expect(combineRawTransactionColumns({
      dateText: ["2026-07-15"],
      descriptionText: ["가상 거래"],
      withdrawalText: ["-"],
      depositText: ["1,000"],
    })).toHaveLength(1);
  });

  it("rejects mismatched required array lengths", () => {
    expect(() => combineRawTransactionColumns({
      dateText: ["2026-07-15", "2026-07-14"],
      descriptionText: ["가상 거래"],
      withdrawalText: ["-"],
      depositText: ["1,000"],
    })).toThrow(/배열 길이/u);
  });

  it("rejects a missing date or both missing amount fields", () => {
    expect(() => combineRawTransactionColumns({
      dateText: [""],
      descriptionText: ["가상 거래"],
      withdrawalText: [""],
      depositText: [""],
    })).toThrow();
  });

  it("rejects an unknown DOM structure", () => {
    expect(() => parseRawTransactionsFromHtml("<div>changed</div>")).toThrow(/구조/u);
  });

  it("excludes hidden template rows", () => {
    const html = `
      <table><thead><tr><th>거래일자</th><th>적요</th><th>출금액</th><th>입금액</th></tr></thead><tbody>
        <tr class="template" style="display:none"><td></td><td></td><td></td><td></td></tr>
        <tr><td>2026-07-15</td><td>테스트입금</td><td>-</td><td>10000</td></tr>
      </tbody></table>`;
    expect(parseRawTransactionsFromHtml(html)).toHaveLength(1);
  });

  it("rejects a mismatch between screen and parsed transaction counts", async () => {
    const html = await readFile(fixturePath, "utf8");
    expect(() => parseRawTransactionsFromHtml(html, { expectedTransactionCount: 3 })).toThrow(/건수/u);
  });

  it("rejects table rows with missing amount fields", () => {
    const html = `
      <table><thead><tr><th>거래일자</th><th>적요</th><th>출금액</th><th>입금액</th></tr></thead><tbody>
        <tr><td>2026-07-15</td><td>테스트거래</td><td></td><td></td></tr>
      </tbody></table>`;
    expect(() => parseRawTransactionsFromHtml(html)).toThrow(/금액/u);
  });

  it("rejects a result container without transaction structure", () => {
    expect(() => parseRawTransactionsFromHtml("<section id='b048488'></section>")).toThrow(/구조/u);
  });
});
