export type SyncErrorCode =
  | "GOOGLE_ENV_MISSING"
  | "GOOGLE_SPREADSHEET_ID_INVALID"
  | "GOOGLE_KEY_FILE_NOT_FOUND"
  | "GOOGLE_KEY_FILE_NOT_READABLE"
  | "GOOGLE_KEY_JSON_INVALID"
  | "GOOGLE_CREDENTIAL_TYPE_INVALID"
  | "GOOGLE_CREDENTIAL_FIELDS_MISSING"
  | "GOOGLE_AUTH_TOKEN_FAILED"
  | "SPREADSHEET_NOT_FOUND"
  | "SPREADSHEET_PERMISSION_DENIED"
  | "GOOGLE_SHEETS_API_DISABLED"
  | "SHEET_INITIALIZATION_FAILED"
  | "SHEET_HEADER_MISMATCH"
  | "SHEET_LAYOUT_MIGRATION_REQUIRED"
  | "SHEETS_WRITE_DISABLED"
  | "SHEETS_WRITE_GUARD_REJECTED"
  | "SHEET_INITIALIZATION_REQUIRED"
  | "SHEET_DATA_REQUIRES_MIGRATION"
  | "SHEET_DATA_INVALID"
  | "GOOGLE_AUTH_FAILED"
  | "GOOGLE_APPEND_FAILED"
  | "CONFIGURATION_ERROR"
  | "FINGERPRINT_CONFLICT";

export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
    readonly diagnostic?: {
      httpStatus?: number;
      googleReason?: string;
      originalErrorName?: string;
    },
  ) {
    super(message, options);
    this.name = "SyncError";
  }
}
