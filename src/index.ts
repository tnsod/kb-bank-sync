import { randomUUID } from "node:crypto";

import { createLookupHooks } from "./bank/lookup-hooks.js";
import { KbSyncError, TransactionValidationError } from "./bank/kb-errors.js";
import { parseCliOptions } from "./config/cli.js";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./logging/logger.js";
import { createGoogleAuth, type GoogleSetupStage } from "./spreadsheet/google-auth.js";
import { parseSpreadsheetId } from "./spreadsheet/google-config.js";
import { GoogleSheetsClient } from "./spreadsheet/google-sheets-client.js";
import { runSync, type SyncRunStatus } from "./sync/sync-service.js";
import { SyncError } from "./sync/sync-errors.js";

function statusForError(error: unknown): SyncRunStatus {
  if (error instanceof KbSyncError) {
    return error.code === "CONFIGURATION_ERROR" ? "validation_failed" : "unknown_failed";
  }
  if (!(error instanceof SyncError)) {
    if (typeof error === "object" && error !== null) {
      const candidate = error as { code?: unknown; response?: { status?: unknown } };
      const status = typeof candidate.response?.status === "number" ? candidate.response.status : candidate.code;
      if (status === 401 || status === 403) return "google_auth_failed";
    }
    return "unknown_failed";
  }
  if (error.code === "SHEET_INITIALIZATION_REQUIRED") return "sheet_initialization_required";
  if (error.code === "SHEET_DATA_REQUIRES_MIGRATION") return "sheet_data_requires_migration";
  if (error.code === "SHEET_LAYOUT_MIGRATION_REQUIRED") return "sheet_layout_migration_required";
  if (error.code === "SHEET_DATA_INVALID") return "sheet_data_invalid";
  if (error.code === "SHEETS_WRITE_DISABLED") return "sheets_write_disabled";
  if (error.code === "GOOGLE_AUTH_FAILED") return "google_auth_failed";
  if (["GOOGLE_KEY_FILE_NOT_FOUND", "GOOGLE_KEY_FILE_NOT_READABLE", "GOOGLE_KEY_JSON_INVALID",
    "GOOGLE_CREDENTIAL_TYPE_INVALID", "GOOGLE_CREDENTIAL_FIELDS_MISSING", "GOOGLE_AUTH_TOKEN_FAILED",
    "SPREADSHEET_PERMISSION_DENIED", "GOOGLE_SHEETS_API_DISABLED"].includes(error.code)) return "google_auth_failed";
  if (["SPREADSHEET_NOT_FOUND", "SHEET_INITIALIZATION_FAILED", "SHEET_HEADER_MISMATCH"].includes(error.code)) {
    return "sheet_initialization_required";
  }
  if (error.code === "GOOGLE_APPEND_FAILED") return "google_append_failed";
  return "unknown_failed";
}

async function main(): Promise<void> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const cli = parseCliOptions(process.argv.slice(2));
  const config = loadConfig({
    ...process.env,
    ...(cli.headed ? { PLAYWRIGHT_BROWSER_MODE: "headed" } : {}),
  });
  const logger = createLogger(config);
  const spreadsheetFormat = parseSpreadsheetId(process.env.GOOGLE_SPREADSHEET_ID ?? config.GOOGLE_SPREADSHEET_ID).format;
  const googleDiagnostic = (stage: GoogleSetupStage, success: boolean): void => {
    logger.info({ event: "google_setup_diagnostic", stage, success });
  };
  logger.info({ event: "google_setup_diagnostic", stage: "env_loaded", success: true });
  logger.info({ event: "google_setup_diagnostic", stage: "env_validated", success: true });
  logger.info({ event: "google_setup_diagnostic", stage: "spreadsheet_id_parsed", success: true,
    spreadsheetIdRecognized: true, spreadsheetIdSource: "env", spreadsheetIdFormat: spreadsheetFormat });
  logger.info({ event: "sync_started", runId, startedAt: new Date(startedAt).toISOString(), dryRun: cli.dryRun ?? config.DRY_RUN });

  try {
    const auth = await createGoogleAuth(config, googleDiagnostic);
    const sheets = new GoogleSheetsClient(auth, config.GOOGLE_SPREADSHEET_ID, config.GOOGLE_SHEET_NAME, googleDiagnostic);
    const summary = await runSync(config, cli, {
      sheets,
      hooks: createLookupHooks(config, cli, logger),
      logger,
      onSheetInitialized: () => googleDiagnostic("worksheet_initialized", true),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    logger.info({
      event: "sync_finished", runId, status: summary.status, existingRowCount: summary.existingRowCount,
      scrapedCount: summary.scrapedCount, uniqueScrapedCount: summary.uniqueScrapedCount,
      newTransactionCount: summary.newTransactionCount, insertedCount: summary.insertedCount,
      appendCalled: summary.appendCalled, durationMs: summary.durationMs,
      ...(summary.parserFailure === undefined ? {} : {
        parserErrorCode: summary.parserFailure.parserErrorCode,
        parserStage: summary.parserFailure.parserStage,
      }),
    });
    process.exitCode = ["success", "no_new_transactions", "dry_run", "sheet_initialized", "sheet_migrated",
      "counterparty_description_migrated", "counterparty_description_already_migrated"].includes(summary.status) ? 0 : 1;
  } catch (error) {
    const status = statusForError(error);
    const safe = error instanceof SyncError
      ? { errorCode: error.code, errorType: error.name, ...error.diagnostic }
      : error instanceof TransactionValidationError
        ? { errorCode: error.code, errorType: error.name, ...error.validationDiagnostic }
      : error instanceof KbSyncError
        ? { errorCode: error.code, errorType: error.name }
        : { errorCode: "UNKNOWN_ERROR", errorType: error instanceof Error ? error.name : "Unknown" };
    logger.error({ ...safe, runId, status, durationMs: Date.now() - startedAt }, "Synchronization failed");
    process.stdout.write(`${JSON.stringify({ status, ...safe, durationMs: Date.now() - startedAt }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  const errorType = error instanceof Error ? error.name : "Unknown";
  const safeMessage = error instanceof KbSyncError || error instanceof SyncError ? error.message : undefined;
  const errorCode = error instanceof KbSyncError || error instanceof SyncError ? error.code : "UNKNOWN_ERROR";
  process.stderr.write(`${JSON.stringify({ status: "configuration_failed", errorCode, errorType,
    ...(safeMessage === undefined ? {} : { message: safeMessage }), ...(error instanceof SyncError ? error.diagnostic : {}) })}\n`);
  process.exitCode = 1;
}
