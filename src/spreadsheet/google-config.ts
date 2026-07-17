import { SyncError } from "../sync/sync-errors.js";

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,}$/u;
const SPREADSHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/?#]+)(?:[/?#]|$)/iu;

export function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseSpreadsheetId(value: string): { id: string; format: "id" | "url" } {
  const normalized = stripOptionalQuotes(value);
  const urlMatch = SPREADSHEET_URL.exec(normalized);
  const id = urlMatch?.[1] ?? normalized;
  if (!SPREADSHEET_ID.test(id)) {
    throw new SyncError("GOOGLE_SPREADSHEET_ID_INVALID", "Google Spreadsheet ID 또는 URL 형식이 올바르지 않습니다");
  }
  return { id, format: urlMatch === null ? "id" : "url" };
}
