import { describe, expect, it } from "vitest";

import { parseCliOptions } from "../src/config/cli.js";

describe("dry-run CLI", () => {
  it("accepts dry-run and explicit lookup dates", () => {
    expect(parseCliOptions(["--dry-run", "--from", "2026-07-01", "--to=2026-07-15"])).toEqual({
      dryRun: true,
      initializeSheet: false,
      migrateSheetLayout: false,
      swapCounterpartyDescription: false,
      captureSanitizedFixture: false,
      diagnoseSubmit: false,
      headed: false,
      pauseAfterSubmit: false,
      from: "2026-07-01",
      to: "2026-07-15",
    });
  });

  it("defers to environment dry-run without an explicit flag", () => {
    expect(parseCliOptions([])).toEqual({
      initializeSheet: false,
      migrateSheetLayout: false,
      swapCounterpartyDescription: false,
      captureSanitizedFixture: false,
      diagnoseSubmit: false,
      headed: false,
      pauseAfterSubmit: false,
    });
  });

  it("enables only a sanitized structure fixture capture", () => {
    expect(parseCliOptions(["--capture-sanitized-fixture"])).toEqual({
      initializeSheet: false,
      migrateSheetLayout: false,
      swapCounterpartyDescription: false,
      captureSanitizedFixture: true,
      diagnoseSubmit: false,
      headed: false,
      pauseAfterSubmit: false,
    });
  });

  it("supports headed pause diagnostics only as an explicit pair", () => {
    expect(parseCliOptions(["--diagnose-submit", "--headed", "--pause-after-submit"])).toMatchObject({
      diagnoseSubmit: true,
      headed: true,
      pauseAfterSubmit: true,
    });
    expect(() => parseCliOptions(["--pause-after-submit"])).toThrow();
  });

  it("rejects unsupported arguments", () => {
    expect(() => parseCliOptions(["--write"])).toThrow();
  });

  it("supports isolated sheet initialization and rejects date options with it", () => {
    expect(parseCliOptions(["--initialize-sheet"])).toMatchObject({ initializeSheet: true });
    expect(() => parseCliOptions(["--initialize-sheet", "--from", "2026-07-01"])).toThrow();
  });

  it("supports isolated layout migration and rejects conflicting options", () => {
    expect(parseCliOptions(["--migrate-sheet-layout"])).toMatchObject({ migrateSheetLayout: true, initializeSheet: false });
    expect(() => parseCliOptions(["--migrate-sheet-layout", "--dry-run"])).toThrow();
    expect(() => parseCliOptions(["--migrate-sheet-layout", "--from", "2026-07-01"])).toThrow();
    expect(() => parseCliOptions(["--migrate-sheet-layout", "--initialize-sheet"])).toThrow();
  });

  it("supports only an isolated counterparty/description swap migration", () => {
    expect(parseCliOptions(["--swap-counterparty-description"])).toMatchObject({
      swapCounterpartyDescription: true, initializeSheet: false, migrateSheetLayout: false,
    });
    expect(() => parseCliOptions(["--swap-counterparty-description", "--dry-run"])).toThrow();
    expect(() => parseCliOptions(["--swap-counterparty-description", "--initialize-sheet"])).toThrow();
    expect(() => parseCliOptions(["--swap-counterparty-description", "--from", "2026-07-01"])).toThrow();
  });
});
