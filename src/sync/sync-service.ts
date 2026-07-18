import type { Logger } from "pino";

import { runKbLookup, type KbLookupResult, type LookupHooks } from "../bank/kb-client.js";
import type { ParserFailureDiagnostic } from "../bank/kb-errors.js";
import type { CliOptions } from "../config/cli.js";
import type { AppConfig, BankLookupConfig } from "../config/env.js";
import type { GoogleApiCallCounts, SheetLayoutResult, SheetsClient } from "../spreadsheet/google-sheets-client.js";
import { migrateCounterpartyDescription } from "../spreadsheet/counterparty-description-migrator.js";
import { migrateSheetLayout } from "../spreadsheet/sheet-migrator.js";
import { headersAreExact, headersAreLegacy, buildExistingSheetState } from "../spreadsheet/sheet-state.js";
import { initializeSheet, type SheetInitializationResult } from "../spreadsheet/sheet-initializer.js";
import { assertSheetsWriteAllowed, type SheetsWriteGuard } from "../spreadsheet/write-guard.js";
import { fingerprintTransaction } from "../transaction/fingerprint.js";
import { nowInKorea } from "../transaction/normalize.js";
import { normalizeAndValidateTransaction } from "../transaction/validate.js";
import { accountIdFromNumber } from "../utils/masking.js";
import { appendWithRecovery } from "./append-recovery.js";
import { deduplicateTransactions, selectNewTransactions } from "./deduplicate.js";
import { calculateLookupRange } from "./lookup-range.js";
import { SyncError } from "./sync-errors.js";

export type SyncRunStatus =
  | "success"
  | "no_new_transactions"
  | "dry_run"
  | "sheet_initialized"
  | "sheet_migrated"
  | "counterparty_description_migrated"
  | "counterparty_description_already_migrated"
  | "sheet_initialization_required"
  | "sheet_layout_migration_required"
  | "sheet_data_requires_migration"
  | "sheet_data_invalid"
  | "sheets_write_disabled"
  | "bank_maintenance"
  | "authentication_failed"
  | "page_structure_changed"
  | "network_failed"
  | "google_auth_failed"
  | "google_append_failed"
  | "validation_failed"
  | "unknown_failed";

export interface SyncSummary {
  status: SyncRunStatus;
  lookupStartDate: string | null;
  lookupEndDate: string | null;
  minimumAllowedDate: string | null;
  existingRowCount: number;
  scrapedCount: number;
  fingerprintedCount: number;
  uniqueScrapedCount: number;
  internalDuplicateCount: number;
  existingTransactionCount: number;
  newTransactionCount: number;
  insertedCount: number;
  appendCalled: boolean;
  sheetsWriteEnabled: boolean;
  durationMs: number;
  retryCount: number;
  duplicateSourceKeyCount: number;
  invalidDateRowCount: number;
  missingSourceKeyRowCount: number;
  worksheetCreated?: boolean;
  headerCreated?: boolean;
  layout?: SheetLayoutResult | null;
  backupCreated?: boolean;
  backupSheetName?: string | null;
  originalRowCount?: number;
  migratedRowCount?: number;
  sourceKeysPreserved?: boolean;
  updatedRowCount?: number;
  evidenceNotesPreserved?: boolean;
  migrationVersion?: number;
  googleApiCalls: GoogleApiCallCounts;
  parserFailure?: ParserFailureDiagnostic;
}

export interface SyncDependencies {
  sheets: SheetsClient;
  lookup?: (config: BankLookupConfig, hooks?: LookupHooks) => Promise<KbLookupResult>;
  hooks?: LookupHooks;
  now?: string | Date;
  collectedAt?: () => string;
  logger?: Logger;
  onSheetInitialized?: () => void;
}

function emptySummary(status: SyncRunStatus, writeEnabled: boolean, startedAt: number): SyncSummary {
  return {
    status, lookupStartDate: null, lookupEndDate: null, minimumAllowedDate: null,
    existingRowCount: 0, scrapedCount: 0, fingerprintedCount: 0, uniqueScrapedCount: 0,
    internalDuplicateCount: 0, existingTransactionCount: 0, newTransactionCount: 0,
    insertedCount: 0, appendCalled: false, sheetsWriteEnabled: writeEnabled,
    durationMs: Date.now() - startedAt, retryCount: 0, duplicateSourceKeyCount: 0,
    invalidDateRowCount: 0, missingSourceKeyRowCount: 0,
    googleApiCalls: { metadataRead: 0, headerRead: 0, dataRead: 0, append: 0, sourceKeyVerificationRead: 0, batchUpdate: 0, headerWrite: 0 },
  };
}

function callCounts(client: SheetsClient): GoogleApiCallCounts {
  return client.getApiCallCounts?.() ?? {
    metadataRead: 0, headerRead: 0, dataRead: 0, append: 0,
    sourceKeyVerificationRead: 0, batchUpdate: 0, headerWrite: 0,
  };
}

function mapLookupFailure(status: KbLookupResult["status"]): SyncRunStatus {
  if (status === "invalid_credentials") return "authentication_failed";
  if (status === "maintenance") return "bank_maintenance";
  if (status === "page_structure_changed" || status === "result_page_unknown" || status === "no_submit_transition") {
    return "page_structure_changed";
  }
  if (status === "timeout") return "network_failed";
  return "unknown_failed";
}

async function runInitialization(
  config: AppConfig,
  cli: CliOptions,
  dependencies: SyncDependencies,
  startedAt: number,
): Promise<SyncSummary> {
  const result: SheetInitializationResult = await initializeSheet(dependencies.sheets, {
    dryRun: cli.dryRun ?? config.DRY_RUN,
    sheetsWriteEnabled: config.ENABLE_SHEETS_WRITE,
    ...(dependencies.onSheetInitialized === undefined ? {} : { onInitialized: dependencies.onSheetInitialized }),
  });
  return {
    ...emptySummary("sheet_initialized", config.ENABLE_SHEETS_WRITE, startedAt),
    worksheetCreated: result.worksheetCreated,
    headerCreated: result.headerCreated,
    layout: result.layout,
    googleApiCalls: callCounts(dependencies.sheets),
  };
}

async function runMigration(
  config: AppConfig,
  cli: CliOptions,
  dependencies: SyncDependencies,
  startedAt: number,
): Promise<SyncSummary> {
  const result = await migrateSheetLayout(dependencies.sheets, {
    dryRun: cli.dryRun ?? config.DRY_RUN,
    sheetsWriteEnabled: config.ENABLE_SHEETS_WRITE,
    expectedAccountId: accountIdFromNumber(config.KB_ACCOUNT_NUMBER),
    sheetName: config.GOOGLE_SHEET_NAME,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  return {
    ...emptySummary("sheet_migrated", config.ENABLE_SHEETS_WRITE, startedAt),
    existingRowCount: result.originalRowCount,
    layout: result.layout,
    backupCreated: result.backupCreated,
    backupSheetName: result.backupSheetName,
    originalRowCount: result.originalRowCount,
    migratedRowCount: result.migratedRowCount,
    sourceKeysPreserved: result.sourceKeysPreserved,
    googleApiCalls: callCounts(dependencies.sheets),
  };
}

async function runCounterpartyDescriptionMigration(
  config: AppConfig,
  dependencies: SyncDependencies,
  startedAt: number,
): Promise<SyncSummary> {
  const result = await migrateCounterpartyDescription(dependencies.sheets, {
    dryRun: config.DRY_RUN,
    sheetsWriteEnabled: config.ENABLE_SHEETS_WRITE,
    sheetName: config.GOOGLE_SHEET_NAME,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  return {
    ...emptySummary(result.alreadyMigrated
      ? "counterparty_description_already_migrated"
      : "counterparty_description_migrated", config.ENABLE_SHEETS_WRITE, startedAt),
    existingRowCount: result.originalRowCount,
    backupCreated: result.backupCreated,
    backupSheetName: result.backupSheetName,
    originalRowCount: result.originalRowCount,
    updatedRowCount: result.updatedRowCount,
    sourceKeysPreserved: result.sourceKeysPreserved,
    evidenceNotesPreserved: result.evidenceNotesPreserved,
    migrationVersion: result.migrationVersion,
    googleApiCalls: callCounts(dependencies.sheets),
  };
}

export async function runSync(config: AppConfig, cli: CliOptions, dependencies: SyncDependencies): Promise<SyncSummary> {
  const startedAt = Date.now();
  if (cli.initializeSheet) return runInitialization(config, cli, dependencies, startedAt);
  if (cli.migrateSheetLayout) return runMigration(config, cli, dependencies, startedAt);
  if (cli.swapCounterpartyDescription) return runCounterpartyDescriptionMigration(config, dependencies, startedAt);

  const dryRun = cli.dryRun ?? config.DRY_RUN;
  const accountId = accountIdFromNumber(config.KB_ACCOUNT_NUMBER);
  const info = await dependencies.sheets.getWorksheetInfo();
  if (!info.exists) throw new SyncError("SHEET_INITIALIZATION_REQUIRED", "워크시트가 없습니다. --initialize-sheet를 먼저 실행하십시오");
  const headers = await dependencies.sheets.readHeader();
  if (headers.length === 0) throw new SyncError("SHEET_INITIALIZATION_REQUIRED", "시트 헤더가 없습니다. --initialize-sheet를 먼저 실행하십시오");
  if (headersAreLegacy(headers)) throw new SyncError("SHEET_LAYOUT_MIGRATION_REQUIRED", "구형 시트 레이아웃입니다. --migrate-sheet-layout을 실행하십시오");
  if (!headersAreExact(headers)) throw new SyncError("SHEET_HEADER_MISMATCH", "시트 헤더가 예상 값과 정확히 일치하지 않습니다");

  const state = buildExistingSheetState(await dependencies.sheets.readDataRows(), accountId);
  if (state.duplicateSourceKeys.length > 0) {
    dependencies.logger?.warn({ duplicateSourceKeyCount: state.duplicateSourceKeys.length }, "Existing duplicate sourceKeys detected");
  }
  if (state.missingSourceKeyRowCount > 0) {
    dependencies.logger?.error({ missingSourceKeyRowCount: state.missingSourceKeyRowCount }, "Sheet data migration required");
    throw new SyncError("SHEET_DATA_REQUIRES_MIGRATION", "sourceKey가 없는 기존 거래가 있어 실제 append를 차단합니다");
  }
  if (state.invalidDateRowCount > 0 || state.shortRowCount > 0 || state.differentAccountIdRowCount > 0 || state.dataAfterEmptyRowCount > 0) {
    dependencies.logger?.error({
      invalidDateRows: state.invalidDateRows,
      shortRowCount: state.shortRowCount,
      differentAccountIdRowCount: state.differentAccountIdRowCount,
      dataAfterEmptyRowCount: state.dataAfterEmptyRowCount,
    }, "Invalid sheet data detected");
    throw new SyncError("SHEET_DATA_INVALID", "기존 시트 데이터 구조 이상으로 append를 차단합니다");
  }

  const configuredFrom = cli.from ?? config.KB_LOOKUP_START_DATE;
  const configuredTo = cli.to ?? config.KB_LOOKUP_END_DATE;
  const range = calculateLookupRange({
    latestOccurredAt: state.latestOccurredAt,
    overlapDays: config.SYNC_OVERLAP_DAYS,
    initialLookbackMonths: config.INITIAL_LOOKBACK_MONTHS,
    ...(configuredFrom === undefined ? {} : { from: configuredFrom }),
    ...(configuredTo === undefined ? {} : { to: configuredTo }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  const bankConfig: BankLookupConfig = {
    ...config,
    ENABLE_SUBMIT_TRACING: config.ENABLE_SUBMIT_TRACING || cli.diagnoseSubmit,
    KB_LOOKUP_START_DATE: range.startDate,
    KB_LOOKUP_END_DATE: range.endDate,
  };
  const lookup = await (dependencies.lookup ?? runKbLookup)(bankConfig, dependencies.hooks);
  if (lookup.status !== "success" && lookup.status !== "empty") {
    return {
      ...emptySummary(mapLookupFailure(lookup.status), config.ENABLE_SHEETS_WRITE, startedAt),
      lookupStartDate: range.startDate, lookupEndDate: range.endDate, minimumAllowedDate: range.minimumAllowedDate,
      existingRowCount: state.rowCount, duplicateSourceKeyCount: state.duplicateSourceKeys.length,
      googleApiCalls: callCounts(dependencies.sheets),
      ...(lookup.parserFailure === undefined || lookup.parserFailure === null
        ? {}
        : { parserFailure: lookup.parserFailure }),
    };
  }

  const collectedAt = dependencies.collectedAt?.() ?? nowInKorea();
  const normalized = lookup.rawTransactions.map((raw) => normalizeAndValidateTransaction(
    raw, config.KB_ACCOUNT_NUMBER, collectedAt,
    { lookupStartDate: range.startDate, lookupEndDate: range.endDate },
  ));
  if (normalized.length !== lookup.rawTransactions.length) {
    throw new SyncError("SHEET_DATA_INVALID", "파싱 건수와 정규화 건수가 일치하지 않습니다");
  }
  const fingerprinted = normalized.map(fingerprintTransaction);
  const deduplicated = deduplicateTransactions(fingerprinted);
  const fresh = selectNewTransactions(deduplicated.transactions, state.sourceKeys);
  const base: SyncSummary = {
    status: dryRun ? "dry_run" : "success",
    lookupStartDate: range.startDate, lookupEndDate: range.endDate, minimumAllowedDate: range.minimumAllowedDate,
    existingRowCount: state.rowCount, scrapedCount: lookup.rawTransactions.length,
    fingerprintedCount: fingerprinted.length, uniqueScrapedCount: deduplicated.transactions.length,
    internalDuplicateCount: deduplicated.internalDuplicateCount,
    existingTransactionCount: fresh.existingTransactionCount, newTransactionCount: fresh.transactions.length,
    insertedCount: 0, appendCalled: false, sheetsWriteEnabled: config.ENABLE_SHEETS_WRITE,
    durationMs: 0, retryCount: 0, duplicateSourceKeyCount: state.duplicateSourceKeys.length,
    invalidDateRowCount: state.invalidDateRowCount, missingSourceKeyRowCount: state.missingSourceKeyRowCount,
    googleApiCalls: callCounts(dependencies.sheets),
  };
  if (dryRun) return { ...base, googleApiCalls: callCounts(dependencies.sheets), durationMs: Date.now() - startedAt };
  if (fresh.transactions.length === 0) {
    return { ...base, status: "no_new_transactions", googleApiCalls: callCounts(dependencies.sheets), durationMs: Date.now() - startedAt };
  }
  if (!config.ENABLE_SHEETS_WRITE) throw new SyncError("SHEETS_WRITE_DISABLED", "신규 거래가 있지만 Sheets 쓰기가 비활성화되어 있습니다");

  const resultContainerDetected = lookup.submitDiagnostics?.resultContainerDetected === true;
  const transactionTableDetected = lookup.rowDiagnostics !== null;
  const guard: SheetsWriteGuard = {
    dryRun, sheetsWriteEnabled: config.ENABLE_SHEETS_WRITE, lookupStatus: "success",
    resultContainerDetected, transactionTableDetected,
    pageStructureValidated: lookup.status === "success" && lookup.paginationDetected === false && transactionTableDetected,
    allTransactionsValidated: true,
    parsedTransactionCount: lookup.rawTransactions.length,
    normalizedTransactionCount: normalized.length,
    newTransactionCount: fresh.transactions.length,
    sheetHeadersValidated: true,
    missingSourceKeyRowCount: state.missingSourceKeyRowCount,
  };
  assertSheetsWriteAllowed(guard);
  const append = await appendWithRecovery(dependencies.sheets, fresh.transactions, guard, accountId);
  return {
    ...base, status: "success", insertedCount: append.appendedRowCount, appendCalled: true,
    retryCount: append.retryCount, durationMs: Date.now() - startedAt,
    googleApiCalls: callCounts(dependencies.sheets),
  };
}
