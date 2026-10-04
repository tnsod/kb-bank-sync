import { createHash } from "node:crypto";

import { z } from "zod";

import { SyncError } from "../sync/sync-errors.js";
import type { RawSheetRow } from "./sheet-state.js";

export const VERIFIED_LEGACY_METADATA_KEY = "kb_sync_verified_legacy_v1";
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const recordSchema = z.object({
  version: z.literal(1),
  rowDigest: sha256,
  accountId: z.string().regex(/^KB-\d{4}$/u),
  sourceKey: sha256,
  legacySourceKey: sha256,
}).strict();

export type VerifiedLegacyRecord = z.infer<typeof recordSchema>;

// H/I remain user editable. A:G must still be exactly the values independently
// verified against KB during migration; sorting whole rows does not change this.
export function legacyRowDigest(row: readonly RawSheetRow[number][]): string {
  return createHash("sha256").update(JSON.stringify(
    Array.from({ length: 7 }, (_, index) => row[index] ?? ""),
  )).digest("hex");
}

export function sheetIdentitySnapshot(rows: readonly RawSheetRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows.map((row) => JSON.stringify([
    legacyRowDigest(row), ...[9, 10, 11].map((index) => row[index] ?? ""),
  ])).sort())).digest("hex");
}

export function validateVerifiedLegacyRecords(
  rows: readonly RawSheetRow[],
  accountId: string,
  metadataValues: readonly string[],
): Map<number, VerifiedLegacyRecord> {
  const resolved = new Map<number, VerifiedLegacyRecord>();
  const usedKeys = new Set<string>();
  const existingKeys = new Set(rows.map((row) => String(row[11] ?? "").trim()).filter(Boolean));
  for (const value of metadataValues) {
    let record: VerifiedLegacyRecord;
    try {
      record = recordSchema.parse(JSON.parse(value));
    } catch {
      throw new SyncError("SHEET_DATA_INVALID", "검증된 legacy metadata 형식이 유효하지 않습니다");
    }
    if (record.accountId !== accountId) {
      throw new SyncError("SHEET_DATA_INVALID", "검증된 legacy metadata 계좌가 일치하지 않습니다");
    }
    const matches = rows.flatMap((row, index) => legacyRowDigest(row) === record.rowDigest ? [index] : []);
    const index = matches[0];
    if (matches.length !== 1 || index === undefined || resolved.has(index)) {
      throw new SyncError("SHEET_DATA_INVALID", "검증된 legacy 행이 변경됐거나 1:1 대응이 아닙니다");
    }
    const row = rows[index];
    if (row === undefined || [9, 10, 11].some((column) => String(row[column] ?? "").trim() !== "")) {
      throw new SyncError("SHEET_DATA_INVALID", "검증된 legacy 행 시스템 열이 변경됐습니다");
    }
    for (const key of new Set([record.sourceKey, record.legacySourceKey])) {
      if (existingKeys.has(key) || usedKeys.has(key)) {
        throw new SyncError("SHEET_DATA_INVALID", "검증된 legacy 거래 키가 다른 행과 충돌합니다");
      }
      usedKeys.add(key);
    }
    resolved.set(index, record);
  }
  return resolved;
}
