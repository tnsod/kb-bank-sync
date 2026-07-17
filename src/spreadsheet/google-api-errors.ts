import { SyncError, type SyncErrorCode } from "../sync/sync-errors.js";

interface GoogleErrorShape {
  code?: unknown;
  name?: unknown;
  response?: {
    status?: unknown;
    data?: { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown } };
  };
}

export interface SafeGoogleErrorDiagnostic {
  httpStatus?: number;
  googleReason?: string;
  originalErrorName?: string;
}

export function safeGoogleErrorDiagnostic(error: unknown): SafeGoogleErrorDiagnostic {
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as GoogleErrorShape;
  const status = typeof candidate.response?.status === "number"
    ? candidate.response.status
    : typeof candidate.code === "number" ? candidate.code : undefined;
  const rawReason = candidate.response?.data?.error?.errors?.[0]?.reason ?? candidate.response?.data?.error?.status;
  return {
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(typeof rawReason === "string" ? { googleReason: rawReason } : {}),
    originalErrorName: typeof candidate.name === "string" ? candidate.name : error instanceof Error ? error.name : "Unknown",
  };
}

export function classifyGoogleApiError(error: unknown, fallback: SyncErrorCode): SyncError {
  if (error instanceof SyncError) return error;
  const diagnostic = safeGoogleErrorDiagnostic(error);
  const reason = diagnostic.googleReason ?? "";
  let code = fallback;
  if (diagnostic.httpStatus === 401) code = "GOOGLE_AUTH_TOKEN_FAILED";
  else if (diagnostic.httpStatus === 404) code = "SPREADSHEET_NOT_FOUND";
  else if (diagnostic.httpStatus === 403 && /accessNotConfigured|serviceDisabled|API_DISABLED/iu.test(reason)) {
    code = "GOOGLE_SHEETS_API_DISABLED";
  } else if (diagnostic.httpStatus === 403) code = "SPREADSHEET_PERMISSION_DENIED";
  const retryable = (diagnostic.httpStatus ?? 0) >= 500;
  return new SyncError(code, "Google Sheets API 요청이 실패했습니다", retryable, { cause: error }, diagnostic);
}
