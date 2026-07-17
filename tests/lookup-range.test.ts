import { describe, expect, it } from "vitest";

import { calculateLookupRange } from "../src/sync/lookup-range.js";

const base = { latestOccurredAt: null, overlapDays: 3, initialLookbackMonths: 6, now: "2026-07-16T00:00:00+09:00" } as const;

describe("KST lookup range", () => {
  it("uses execution-day KST for the six-month lower bound", () => {
    expect(calculateLookupRange(base)).toEqual({
      startDate: "2026-01-16", endDate: "2026-07-16", minimumAllowedDate: "2026-01-16", todayKst: "2026-07-16",
    });
  });

  it("rejects dates outside the bank range before lookup", () => {
    expect(() => calculateLookupRange({ ...base, from: "2026-01-15" })).toThrow(/2026-01-16/u);
    expect(() => calculateLookupRange({ ...base, to: "2026-07-17" })).toThrow(/미래/u);
    expect(() => calculateLookupRange({ ...base, from: "2026-07-15", to: "2026-07-14" })).toThrow(/늦을/u);
  });

  it("does not derive the lower bound from a CLI end date", () => {
    expect(() => calculateLookupRange({ ...base, from: "2026-01-15", to: "2026-07-15" })).toThrow(/2026-01-16/u);
  });

  it("overlaps latest date and clamps to the execution-day lower bound", () => {
    expect(calculateLookupRange({ ...base, latestOccurredAt: "2026-01-17T10:00:00+09:00" }).startDate).toBe("2026-01-16");
    expect(calculateLookupRange({ ...base, latestOccurredAt: "2026-07-15T10:00:00+09:00" }).startDate).toBe("2026-07-12");
  });

  it("handles leap years, month ends, and the KST date boundary", () => {
    expect(calculateLookupRange({ ...base, now: "2024-08-31T12:00:00+09:00" }).minimumAllowedDate).toBe("2024-02-29");
    expect(calculateLookupRange({ ...base, now: "2026-07-15T15:01:00Z" }).todayKst).toBe("2026-07-16");
  });
});
