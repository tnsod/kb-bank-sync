import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { google, type sheets_v4 } from "googleapis";

import type { AppConfig } from "../config/env.js";
import { SyncError } from "../sync/sync-errors.js";
import { stripOptionalQuotes } from "./google-config.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export type GoogleSetupStage =
  | "key_path_resolved"
  | "key_file_readable"
  | "key_json_parsed"
  | "credential_schema_validated"
  | "google_auth_created"
  | "google_client_created"
  | "authentication_completed"
  | "spreadsheet_metadata_read"
  | "worksheet_initialized";

export interface ServiceAccountCredential {
  type: "service_account";
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface ValidatedGoogleCredential {
  resolvedPath: string;
  credential: ServiceAccountCredential;
}

export type GoogleSetupDiagnostic = (stage: GoogleSetupStage, success: boolean) => void;

function fileErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

export async function validateServiceAccountKeyFile(
  configuredPath: string,
  projectRoot = process.cwd(),
  diagnostic?: GoogleSetupDiagnostic,
): Promise<ValidatedGoogleCredential> {
  const cleaned = stripOptionalQuotes(configuredPath);
  const resolvedPath = path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(projectRoot, cleaned);
  diagnostic?.("key_path_resolved", true);
  if (path.extname(resolvedPath).toLowerCase() !== ".json") {
    throw new SyncError("GOOGLE_KEY_JSON_INVALID", "Google 서비스 계정 키 파일은 .json 확장자여야 합니다");
  }
  let source: string;
  try {
    const information = await stat(resolvedPath);
    if (!information.isFile()) throw new SyncError("GOOGLE_KEY_FILE_NOT_READABLE", "Google 키 경로가 파일이 아닙니다");
    source = await readFile(resolvedPath, "utf8");
    diagnostic?.("key_file_readable", true);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    diagnostic?.("key_file_readable", false);
    const code = fileErrorCode(error);
    throw new SyncError(
      code === "ENOENT" ? "GOOGLE_KEY_FILE_NOT_FOUND" : "GOOGLE_KEY_FILE_NOT_READABLE",
      code === "ENOENT" ? "Google 서비스 계정 키 파일을 찾을 수 없습니다" : "Google 서비스 계정 키 파일을 읽을 수 없습니다",
      false,
      { cause: error },
      { originalErrorName: error instanceof Error ? error.name : "Unknown" },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/u, ""));
    diagnostic?.("key_json_parsed", true);
  } catch (error) {
    diagnostic?.("key_json_parsed", false);
    throw new SyncError("GOOGLE_KEY_JSON_INVALID", "Google 키 파일이 유효한 UTF-8 JSON이 아닙니다", false,
      { cause: error }, { originalErrorName: error instanceof Error ? error.name : "Unknown" });
  }
  if (typeof value !== "object" || value === null) {
    throw new SyncError("GOOGLE_KEY_JSON_INVALID", "Google 키 JSON 최상위 값이 객체가 아닙니다");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "service_account") {
    diagnostic?.("credential_schema_validated", false);
    throw new SyncError("GOOGLE_CREDENTIAL_TYPE_INVALID", "Google credential type이 service_account가 아닙니다");
  }
  if (typeof candidate.client_email !== "string" || candidate.client_email === "" ||
    typeof candidate.private_key !== "string" || candidate.private_key === "") {
    diagnostic?.("credential_schema_validated", false);
    throw new SyncError("GOOGLE_CREDENTIAL_FIELDS_MISSING", "Google 서비스 계정 필수 필드가 없습니다");
  }
  diagnostic?.("credential_schema_validated", true);
  return {
    resolvedPath,
    credential: {
      type: "service_account",
      ...(typeof candidate.project_id === "string" ? { project_id: candidate.project_id } : {}),
      client_email: candidate.client_email,
      private_key: candidate.private_key,
      ...(typeof candidate.token_uri === "string" ? { token_uri: candidate.token_uri } : {}),
    },
  };
}

export async function createGoogleAuth(
  config: Pick<AppConfig, "GOOGLE_SERVICE_ACCOUNT_KEY_PATH">,
  diagnostic?: GoogleSetupDiagnostic,
): Promise<NonNullable<sheets_v4.Options["auth"]>> {
  const validated = await validateServiceAccountKeyFile(config.GOOGLE_SERVICE_ACCOUNT_KEY_PATH, process.cwd(), diagnostic);
  const auth = new google.auth.GoogleAuth({ credentials: validated.credential, scopes: [SHEETS_SCOPE] });
  diagnostic?.("google_auth_created", true);
  try {
    await auth.getAccessToken();
    diagnostic?.("authentication_completed", true);
    diagnostic?.("google_client_created", true);
    return auth;
  } catch (error) {
    diagnostic?.("authentication_completed", false);
    diagnostic?.("google_client_created", false);
    throw new SyncError("GOOGLE_AUTH_TOKEN_FAILED", "Google 서비스 계정 access token 발급에 실패했습니다", false,
      { cause: error }, { originalErrorName: error instanceof Error ? error.name : "Unknown" });
  }
}
