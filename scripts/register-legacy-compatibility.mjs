// Explicit one-time migration. Never invoked by the scheduled sync job.
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import path from "node:path";
import { google } from "googleapis";

import { loadConfig } from "../dist/config/env.js";
import { createGoogleAuth } from "../dist/spreadsheet/google-auth.js";
import { buildLegacyCompatibilityPlan } from "../dist/spreadsheet/legacy-compatibility-plan.js";
import { VERIFIED_LEGACY_METADATA_KEY, validateVerifiedLegacyRecords } from "../dist/spreadsheet/verified-legacy.js";
import { normalizeAndValidateTransaction } from "../dist/transaction/validate.js";
import { normalizeNullableText } from "../dist/transaction/normalize.js";
import { fingerprintTransaction } from "../dist/transaction/fingerprint.js";
import { EXPECTED_HEADERS } from "../dist/spreadsheet/sheet-mapper.js";

try {
  const { values: options } = parseArgs({ options: {
    backup: { type: "string" }, candidates: { type: "string" }, apply: { type: "boolean", default: false },
  } });
  const config = loadConfig();
  async function protectedJson(path) {
    if (!path || ((await stat(path)).mode & 0o077) !== 0) throw new Error("Protected input required");
    return JSON.parse(await readFile(path, "utf8"));
  }
  const backup = await protectedJson(options.backup);
  const bank = await protectedJson(options.candidates);
  if (!Array.isArray(bank.evidence) || bank.evidence.some(e =>
    !["success", "empty"].includes(e.status) && !(e.status === "page_structure_changed" && e.paginationDetected === true && e.from < e.to))) {
    throw new Error("Unsafe KB collection evidence");
  }
  const candidates = bank.candidates.map(c => {
    const day = c.transaction.occurredAt.slice(0, 10);
    const leaf = bank.evidence.find(e => e.status === "success" && e.paginationDetected === false && day >= e.from && day <= e.to);
    if (!leaf) throw new Error("Missing unpaginated KB leaf evidence");
    const transaction = normalizeAndValidateTransaction(c.raw, config.KB_ACCOUNT_NUMBER, bank.collectedAt,
      { lookupStartDate: leaf.from, lookupEndDate: leaf.to });
    if (fingerprintTransaction(transaction).sourceKey !== c.transaction.sourceKey) throw new Error("Changed KB candidate");
    return { transaction: fingerprintTransaction(transaction), legacyTransaction: {
      ...transaction, memo: normalizeNullableText(c.raw.legacyMemoText ?? c.raw.memoText), branch: normalizeNullableText(c.raw.branchText),
    } };
  });
  const api = google.sheets({ version: "v4", auth: await createGoogleAuth(config) });
  const spreadsheetId = config.GOOGLE_SPREADSHEET_ID;
  const range = `'${config.GOOGLE_SHEET_NAME.replaceAll("'", "''")}'!A:L`;
  const read = async valueRenderOption => (await api.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption })).data.values ?? [];
  const current = await read("UNFORMATTED_VALUE");
  const formulas = await read("FORMULA");
  if (JSON.stringify(current) !== JSON.stringify(backup.values) || JSON.stringify(formulas) !== JSON.stringify(backup.formulas) ||
      JSON.stringify(current[0]) !== JSON.stringify(EXPECTED_HEADERS)) throw new Error("Sheet changed since full backup");
  const metadata = (await api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title),developerMetadata" })).data;
  const sheetId = metadata.sheets?.find(s => s.properties?.title === config.GOOGLE_SHEET_NAME)?.properties?.sheetId;
  if (sheetId === undefined) throw new Error("Worksheet missing");
  const accountId = `KB-${config.KB_ACCOUNT_NUMBER.slice(-4)}`;
  const plan = buildLegacyCompatibilityPlan(current.slice(1), candidates, accountId);
  const counts = Object.fromEntries(["EXACT_MATCH", "UNIQUE_COMPATIBLE_MATCH", "AMBIGUOUS", "NO_MATCH"].map(c =>
    [c, plan.classifications.filter(p => p.classification === c).length]));
  const existing = (await api.spreadsheets.developerMetadata.search({ spreadsheetId, requestBody: {
    dataFilters: [{ developerMetadataLookup: { metadataKey: VERIFIED_LEGACY_METADATA_KEY, locationType: "SHEET" } }],
  } })).data.matchedDeveloperMetadata?.map(m => m.developerMetadata).filter(m => m?.location?.sheetId === sheetId) ?? [];
  if (existing.length) throw new Error("Legacy index already exists; refuse to overwrite");
  const report = { counts, verifiedStrongIdentityCount: plan.records.length, systemCellsWritten: 0,
    backupSha256: createHash("sha256").update(await readFile(options.backup)).digest("hex"), applied: false };
  if (options.apply) {
    if (config.DRY_RUN || !config.ENABLE_SHEETS_WRITE) throw new Error("Migration writes disabled");
    // One request, metadata only. Never update cells, insert, delete or sort rows.
    await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: plan.records.map(record => ({
      createDeveloperMetadata: { developerMetadata: { metadataKey: VERIFIED_LEGACY_METADATA_KEY,
        metadataValue: JSON.stringify(record), visibility: "DOCUMENT", location: { sheetId } } },
    })) } });
    const after = await read("UNFORMATTED_VALUE");
    const afterFormulas = await read("FORMULA");
    if (JSON.stringify(after) !== JSON.stringify(current) || JSON.stringify(afterFormulas) !== JSON.stringify(formulas)) {
      throw new Error("Concurrent cell edit detected after metadata registration");
    }
    const registered = (await api.spreadsheets.developerMetadata.search({ spreadsheetId, requestBody: {
      dataFilters: [{ developerMetadataLookup: { metadataKey: VERIFIED_LEGACY_METADATA_KEY, locationType: "SHEET" } }],
    } })).data.matchedDeveloperMetadata?.map(m => m.developerMetadata).filter(m => m?.location?.sheetId === sheetId) ?? [];
    const resolved = validateVerifiedLegacyRecords(after.slice(1), accountId, registered.map(m => m.metadataValue ?? ""));
    if (resolved.size !== plan.records.length) throw new Error("Incomplete legacy metadata registration");
    report.applied = true; report.registeredCount = resolved.size; report.changedCells = 0;
  }
  await writeFile(path.resolve("output/legacy-compatibility-registration.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  // Google request errors may contain credentials and transaction data.
  process.stderr.write(`${JSON.stringify({ status: "migration_failed", errorType: error instanceof Error ? error.name : "Unknown" })}\n`);
  process.exitCode = 1;
}
