import { describe, expect, it } from "vitest";

import { parseRawTransactionsWithDiagnostics } from "../src/bank/kb-parser.js";
import type { TransactionTypeCellDiagnostic } from "../src/bank/kb-errors.js";

function diagnosticFor(content: string, cellAttributes = ""): TransactionTypeCellDiagnostic {
  const html = `
    <table><thead><tr>
      <th>거래일시</th><th>적요</th><th>내통장표시내용</th><th>출금금액</th>
      <th>입금금액</th><th>잔액</th><th>거래점</th><th>구분</th>
    </tr></thead><tbody><tr>
      <td>2026-07-01 10:00:00</td><td>가상항목</td><td>샘플</td><td>1</td><td>0</td><td>10</td><td>샘플점</td>
      <td ${cellAttributes}>${content}</td>
    </tr></tbody></table>`;
  const diagnostic = parseRawTransactionsWithDiagnostics(html, { expectedTransactionCount: 1 })
    .rowDiagnostics.transactionStructures?.[0]?.transactionTypeCell;
  if (diagnostic === undefined || diagnostic === null) throw new Error("Expected a transaction type cell diagnostic");
  return diagnostic;
}

describe("transaction type cell diagnostics", () => {
  it("finds a value in a visible nested span", () => {
    const diagnostic = diagnosticFor("<span>입금</span>");
    expect(diagnostic).toMatchObject({
      tagName: "td", physicalCellIndex: 7, logicalCellIndex: 7,
      childElementCount: 1, descendantElementCount: 1, spanCount: 1,
      normalizedTextLength: 2, candidateValuesConflict: false,
    });
    expect(diagnostic.candidateSourcesWithValues).toContain("visible_text");
  });

  it("records an input value without retaining it", () => {
    const privateValue = "PRIVATE_INPUT_TRANSACTION_TYPE";
    const diagnostic = diagnosticFor(`<input type="hidden" value="${privateValue}">`);
    expect(diagnostic).toMatchObject({
      normalizedTextLength: 0, inputCount: 1, inputTypes: ["hidden"],
      inputValuePresent: true, inputValueLengths: [privateValue.length],
    });
    expect(diagnostic.candidateSourcesWithValues).toContain("input_value_0");
    expect(JSON.stringify(diagnostic)).not.toContain(privateValue);
  });

  it("records aria-label and title candidates without their values", () => {
    const privateDataValue = "PRIVATE_DATA_TYPE";
    const diagnostic = diagnosticFor('<span aria-label="이자" title="기타"></span>', `data-type="${privateDataValue}"`);
    expect(diagnostic).toMatchObject({
      normalizedTextLength: 0, ariaLabelPresent: true, ariaLabelLengths: [2], titlePresent: true, titleLengths: [2],
      candidateValuesConflict: true,
    });
    expect(diagnostic.candidateSourcesWithValues).toEqual(expect.arrayContaining(["aria_label_0", "title_0"]));
    expect(diagnostic.dataAttributes).toMatchObject([{
      name: "data-type", valuePresent: true, valueLength: privateDataValue.length,
    }]);
    expect(JSON.stringify(diagnostic)).not.toContain(privateDataValue);
  });

  it("records img alt and selected option candidates", () => {
    const diagnostic = diagnosticFor('<img alt="출금"><select><option selected value="W">출금</option></select>');
    expect(diagnostic).toMatchObject({
      imgCount: 1, imgAltPresent: true, imgAltLengths: [2], selectCount: 1,
      selectedOptionPresent: true, selectedOptionLengths: [2],
    });
    expect(diagnostic.candidateSourcesWithValues).toEqual(expect.arrayContaining([
      "img_alt_0", "selected_option_text_0", "selected_option_value_0",
    ]));
  });

  it("detects accessibility duplicate text without exposing it", () => {
    const privateValue = "PRIVATE_VISIBLE_TYPE";
    const diagnostic = diagnosticFor(`<span>${privateValue}</span><span class="sr-only">${privateValue}</span>`);
    expect(diagnostic).toMatchObject({ accessibilityClassDescendantCount: 1, candidateValuesConflict: true });
    expect(diagnostic.normalization.accessibilityDuplicateRemovedLength)
      .toBeLessThan(diagnostic.normalization.whitespaceCollapsedLength);
    expect(JSON.stringify(diagnostic)).not.toContain(privateValue);
  });

  it("detects conflicting visible and accessibility candidates", () => {
    const diagnostic = diagnosticFor("<span>입금</span>", 'aria-label="출금"');
    expect(diagnostic.candidateValuesConflict).toBe(true);
  });

  it("reports the normalization stage when every candidate is empty", () => {
    const diagnostic = diagnosticFor("                ");
    expect(diagnostic).toMatchObject({
      normalizedTextLength: 0,
      candidateSourcesWithValues: [],
      candidateValuesConflict: false,
      normalization: { rawCandidateLength: 16, trimmedLength: 0, finalNormalizedLength: 0, zeroedAtStage: "trimmed" },
    });
  });
});
