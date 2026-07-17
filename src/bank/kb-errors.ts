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
  constructor(message: string, options?: ErrorOptions) {
    super(message, "TRANSACTION_PARSE_ERROR", "transaction_parse", options);
  }
}

export class TransactionValidationError extends KbSyncError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "TRANSACTION_VALIDATION_ERROR", "transaction_validation", options);
  }
}
