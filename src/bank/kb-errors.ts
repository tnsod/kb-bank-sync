export type KbErrorCode =
  | "CONFIGURATION_ERROR"
  | "PAGE_STRUCTURE_CHANGED"
  | "KEYPAD_ERROR"
  | "KEYPAD_RECOGNITION_ERROR"
  | "AUTHENTICATION_FAILED"
  | "LOOKUP_TIMEOUT"
  | "TRANSACTION_PARSE_ERROR"
  | "TRANSACTION_VALIDATION_ERROR"
  | "NETWORK_ERROR";

export type ParserErrorCode =
  | "HEADER_MISMATCH"
  | "UNEXPECTED_ROW_CELL_COUNT"
  | "ORPHAN_DETAIL_ROW"
  | "MISSING_DETAIL_ROW"
  | "UNKNOWN_DETAIL_ROW"
  | "INCONSISTENT_DETAIL_ROW_ROLE"
  | "INVALID_TRANSACTION_DATE"
  | "INVALID_AMOUNT"
  | "INVALID_BALANCE"
  | "NO_TRANSACTION_ROWS"
  | "MULTIPLE_CANDIDATE_TABLES"
  | "PAGINATION_DETECTED"
  | "SCREEN_TRANSACTION_COUNT_MISMATCH"
  | "COLUMN_LENGTH_MISMATCH"
  | "TRANSACTION_TABLE_NOT_FOUND"
  | "UNCLASSIFIED_TRANSACTION_PARSE_ERROR";

export type ParserStage =
  | "table_discovery"
  | "header_validation"
  | "row_classification"
  | "row_shape_validation"
  | "detail_link_validation"
  | "transaction_validation"
  | "screen_count_validation"
  | "column_validation"
  | "date_normalization"
  | "amount_normalization"
  | "balance_normalization"
  | "transaction_parse";

export interface ParserStructureDiagnostics {
  tableCount: number;
  candidateTableCount: number;
  selectedTableIndex: number | null;
  selectedTableRowCount: number | null;
  selectedTableColumnCount: number | null;
  headerRowCount: number;
  dataRowCount: number;
  detailRowCount: number;
  rowCellCounts: number[];
  mainTransactionCandidateCount: number;
  detailRowCandidateCount: number;
  headerMatched: boolean;
  dateParseSuccessCount: number;
  dateParseFailureCount: number;
  amountParseSuccessCount: number;
  amountParseFailureCount: number;
  balanceParseSuccessCount: number;
  balanceParseFailureCount: number;
  detailRowsMatchedToTransactions: boolean | null;
}

export interface ParserFailureDiagnostic extends ParserStructureDiagnostics {
  parserErrorCode: ParserErrorCode;
  parserStage: ParserStage;
}

export type ValidationErrorCode =
  | "EMPTY_DESCRIPTION"
  | "INVALID_WITHDRAWAL"
  | "INVALID_DEPOSIT"
  | "INVALID_BALANCE"
  | "INVALID_OCCURRED_AT"
  | "BOTH_WITHDRAWAL_AND_DEPOSIT"
  | "NEITHER_WITHDRAWAL_NOR_DEPOSIT"
  | "OCCURRED_AT_OUTSIDE_LOOKUP_RANGE"
  | "DEPOSIT_DIRECTION_MISMATCH"
  | "WITHDRAWAL_DIRECTION_MISMATCH";

export type ValidationStage =
  | "description_validation"
  | "withdrawal_normalization"
  | "deposit_normalization"
  | "balance_normalization"
  | "occurred_at_normalization"
  | "amount_exclusivity_validation"
  | "lookup_range_validation"
  | "transaction_type_validation";

export type ValidationAmountState = "zero" | "nonzero" | "null" | "not_evaluated";

export interface TransactionValidationDiagnostic {
  topLevelCode: "TRANSACTION_VALIDATION_ERROR";
  validationErrorCode: ValidationErrorCode;
  validationStage: ValidationStage;
  transactionIndex: number | null;
  transactionCount: number | null;
  failedFieldName: string;
  failedRuleName: string;
  rawFieldPresent: boolean;
  rawFieldEmpty: boolean;
  normalizedFieldPresent: boolean;
  valueType: string;
  stringLength: number | null;
  numericParsingSucceeded: boolean | null;
  dateParsingSucceeded: boolean | null;
  withdrawalState: ValidationAmountState;
  depositState: ValidationAmountState;
  balancePresent: boolean;
}

export class KbSyncError extends Error {
  constructor(
    message: string,
    readonly code: KbErrorCode,
    readonly stage: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends KbSyncError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "CONFIGURATION_ERROR", "configuration", options);
  }
}

export class PageStructureError extends KbSyncError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "PAGE_STRUCTURE_CHANGED", "page_structure", options);
  }
}

export class KeypadError extends KbSyncError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "KEYPAD_ERROR", "keypad", options);
  }
}

export class KeypadRecognitionError extends KbSyncError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "KEYPAD_RECOGNITION_ERROR", "keypad_recognition", options);
  }
}

export class AuthenticationError extends KbSyncError {
  constructor(message = "KB rejected the supplied lookup credentials") {
    super(message, "AUTHENTICATION_FAILED", "authentication");
  }
}

export class LookupTimeoutError extends KbSyncError {
  constructor(message = "Timed out while waiting for a KB lookup result", options?: ErrorOptions) {
    super(message, "LOOKUP_TIMEOUT", "lookup", options);
  }
}

export class NetworkError extends KbSyncError {
  constructor(message = "KB 페이지 네트워크 요청에 실패했습니다", options?: ErrorOptions) {
    super(message, "NETWORK_ERROR", "network", options);
  }
}

export class TransactionParseError extends KbSyncError {
  readonly parserErrorCode: ParserErrorCode;
  readonly parserStage: ParserStage;
  readonly parserDiagnostics: ParserStructureDiagnostics | null;

  constructor(
    message: string,
    diagnostic: {
      parserErrorCode?: ParserErrorCode;
      parserStage?: ParserStage;
      parserDiagnostics?: ParserStructureDiagnostics | null;
    } = {},
    options?: ErrorOptions,
  ) {
    super(message, "TRANSACTION_PARSE_ERROR", diagnostic.parserStage ?? "transaction_parse", options);
    this.parserErrorCode = diagnostic.parserErrorCode ?? "UNCLASSIFIED_TRANSACTION_PARSE_ERROR";
    this.parserStage = diagnostic.parserStage ?? "transaction_parse";
    this.parserDiagnostics = diagnostic.parserDiagnostics ?? null;
  }
}

export function parserFailureDiagnostic(error: TransactionParseError): ParserFailureDiagnostic {
  return {
    parserErrorCode: error.parserErrorCode,
    parserStage: error.parserStage,
    ...(error.parserDiagnostics ?? {
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
    }),
  };
}

export class TransactionValidationError extends KbSyncError {
  constructor(
    message: string,
    readonly validationDiagnostic: TransactionValidationDiagnostic,
    options?: ErrorOptions,
  ) {
    super(message, "TRANSACTION_VALIDATION_ERROR", validationDiagnostic.validationStage, options);
  }

  withTransactionContext(transactionIndex: number, transactionCount: number): TransactionValidationError {
    return new TransactionValidationError(this.message, {
      ...this.validationDiagnostic,
      transactionIndex,
      transactionCount,
    }, { cause: this });
  }
}
