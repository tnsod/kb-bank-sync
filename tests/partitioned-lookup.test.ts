import { describe, expect, it, vi } from "vitest";

import { runPartitionedLookup } from "../src/sync/partitioned-lookup.js";
import { runSync } from "../src/sync/sync-service.js";
import { defaultCli, rawTransaction, sheetClient, stage2Config, successfulLookup } from "./stage2-helpers.js";

const config = { ...stage2Config, KB_LOOKUP_START_DATE: "2026-07-14", KB_LOOKUP_END_DATE: "2026-07-16" };
const paginated = { ...successfulLookup(), status: "page_structure_changed" as const, paginationDetected: true, rawTransactions: [] };

describe("safe paginated date partitioning", () => {
  it("splits only explicit pagination into nonoverlapping days and keeps the original parser", async () => {
    const lookup = vi.fn((input: typeof config) => Promise.resolve(input.KB_LOOKUP_START_DATE !== input.KB_LOOKUP_END_DATE ? paginated : successfulLookup()));
    const parts = await runPartitionedLookup(config, lookup);
    expect(parts.map(p => [p.startDate, p.endDate])).toEqual([
      ["2026-07-14", "2026-07-14"], ["2026-07-15", "2026-07-15"], ["2026-07-16", "2026-07-16"],
    ]);
    expect(parts.every(p => p.result.paginationDetected === false)).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(5);
  });

  it.each(["invalid_credentials", "result_page_unknown", "maintenance", "timeout"] as const)("does not retry %s", async (status) => {
    const lookup = vi.fn(() => Promise.resolve({ ...paginated, status }));
    expect((await runPartitionedLookup(config, lookup))[0]?.result.status).toBe(status);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("stops on unknown DOM or a paginated single day", async () => {
    const unknown = vi.fn(() => Promise.resolve({ ...paginated, paginationDetected: null }));
    await runPartitionedLookup(config, unknown); expect(unknown).toHaveBeenCalledTimes(1);
    const single = vi.fn(() => Promise.resolve(paginated));
    const result = await runPartitionedLookup({ ...config, KB_LOOKUP_END_DATE: config.KB_LOOKUP_START_DATE }, single);
    expect(result[0]?.result.status).toBe("page_structure_changed"); expect(single).toHaveBeenCalledTimes(1);
  });

  it("stops later partitions after authentication fails", async () => {
    const lookup = vi.fn().mockResolvedValueOnce(paginated).mockResolvedValueOnce({ ...paginated, status: "invalid_credentials" });
    await runPartitionedLookup(config, lookup); expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("batches successful partition results in one append and validates each leaf date", async () => {
    const append = vi.fn(() => Promise.resolve({ appendedRowCount: 2, updatedRange: "Sheet1!A2:L3" }));
    const lookup = vi.fn().mockResolvedValueOnce(paginated)
      .mockResolvedValueOnce(successfulLookup([{ ...rawTransaction, dateText: "2026.07.14" }]))
      .mockResolvedValueOnce(successfulLookup([{ ...rawTransaction, dateText: "2026.07.16" }]));
    const result = await runSync({ ...stage2Config, DRY_RUN: false, ENABLE_SHEETS_WRITE: true }, { ...defaultCli, from: "2026-07-14", to: "2026-07-16" }, {
      sheets: sheetClient({ appendTransactions: append }), lookup, now: "2026-07-16T23:00:00+09:00",
    });
    expect(result).toMatchObject({ status: "success", parsedRowCount: 2, insertedCount: 2 }); expect(append).toHaveBeenCalledTimes(1);
  });
});
