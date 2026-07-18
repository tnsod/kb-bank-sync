import { describe, expect, it } from "vitest";

import type { TransactionRowStructureDiagnostic } from "../src/bank/kb-errors.js";
import {
  buildValidationStructureContext,
  classifyRawAmount,
  classifyTransactionType,
} from "../src/transaction/safe-diagnostics.js";
import type { RawKbTransaction } from "../src/transaction/transaction.js";

const baseRaw: RawKbTransaction = {
  dateText: "2026.07.15", timeText: "14:30:00", transactionTypeText: "입금",
  descriptionText: "가상 거래", memoText: "", withdrawalText: "-", depositText: "100",
  balanceText: "1000", branchText: "샘플점",
};

function structure(mappingMatches = true): TransactionRowStructureDiagnostic {
  const cell = (cellIndex: number) => ({
    cellIndex, logicalColumnIndex: cellIndex, colspan: 1, rowspan: 1, hidden: false,
    inputCount: 0, spanCount: 0, textContentLength: 1, numericTokenCount: 1, numericTokenHasSign: false,
  });
  return {
    selectedRowCellCount: 8,
    headerTransactionTypeCellIndex: 7,
    headerWithdrawalCellIndex: 3, headerDepositCellIndex: 4, headerBalanceCellIndex: 5,
    withdrawalCell: cell(3), depositCell: cell(4), balanceCell: cell(5),
    transactionTypeCell: null,
    columnMappingMatchesHeader: mappingMatches,
  };
}

describe("privacy-safe transaction diagnostics", () => {
  it("classifies normal deposit and withdrawal transactions", () => {
    expect(classifyTransactionType("입금")).toBe("deposit");
    expect(classifyTransactionType("출금")).toBe("withdrawal");
    expect(classifyRawAmount("-")).toBe("dash");
    expect(classifyRawAmount("100")).toBe("positive_numeric");
    expect(classifyRawAmount("1,000원")).toBe("formatted_numeric");
    expect(classifyRawAmount("-100")).toBe("negative_numeric");
  });

  it("marks a verified known zero-amount row as a non-monetary candidate", () => {
    const raw = { ...baseRaw, transactionTypeText: "이자", withdrawalText: "-", depositText: "0" };
    const next = { ...baseRaw, transactionTypeText: "출금", withdrawalText: "100", depositText: "-" };
    const diagnostic = buildValidationStructureContext(1, [baseRaw, raw, next], [structure(), structure(), structure()]);
    expect(diagnostic).toMatchObject({
      parsedTransactionTypeCategory: "interest",
      withdrawalRawCategory: "dash",
      depositRawCategory: "zero",
      neighborColumnMappingConsistent: true,
      nonMonetaryTransactionCandidate: true,
      amountColumnMappingError: false,
      previousTransaction: {
        transactionIndex: 0, withdrawalRawCategory: "dash", depositRawCategory: "positive_numeric",
        withdrawalCellIndex: 3, depositCellIndex: 4, balanceCellIndex: 5,
      },
      nextTransaction: {
        transactionIndex: 2, withdrawalRawCategory: "positive_numeric", depositRawCategory: "dash",
        withdrawalCellIndex: 3, depositCellIndex: 4, balanceCellIndex: 5,
      },
    });
  });

  it("keeps an unknown zero-amount transaction rejected as a candidate", () => {
    const privateType = "PRIVATE_UNCLASSIFIED_TYPE";
    const raw = { ...baseRaw, transactionTypeText: privateType, withdrawalText: "-", depositText: "0" };
    const diagnostic = buildValidationStructureContext(0, [raw], [structure()]);
    expect(diagnostic).toMatchObject({
      parsedTransactionTypeCategory: "unknown",
      nonMonetaryTransactionCandidate: false,
    });
    expect(JSON.stringify(diagnostic)).not.toContain(privateType);
  });

  it("flags a column mapping mismatch without changing validation behavior", () => {
    const raw = { ...baseRaw, transactionTypeText: "조정", withdrawalText: "-", depositText: "0" };
    const diagnostic = buildValidationStructureContext(0, [raw], [structure(false)]);
    expect(diagnostic).toMatchObject({
      parsedTransactionTypeCategory: "adjustment",
      nonMonetaryTransactionCandidate: false,
      amountColumnMappingError: true,
    });
  });
});
