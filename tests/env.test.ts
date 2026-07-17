import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config/env.js";

const validEnvironment: NodeJS.ProcessEnv = {
  KB_QUICK_LOOKUP_URL: "https://example.test/quick-lookup",
  KB_ACCOUNT_NUMBER: "12345678901234",
  KB_BIRTH_DATE: "900101",
  KB_WEB_PASSWORD: "1234",
  KB_LOOKUP_START_DATE: "2026-07-01",
  KB_LOOKUP_END_DATE: "2026-07-15",
  GOOGLE_SPREADSHEET_ID: "test-spreadsheet-id-123456",
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: "credentials/test-service-account.json",
  PLAYWRIGHT_BROWSER_MODE: "new-headless",
  PLAYWRIGHT_SUBMIT_CLICK_MODE: "locator",
  LOG_LEVEL: "info",
  TZ: "Asia/Seoul",
  NODE_ENV: "test",
};

describe("environment validation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00+09:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a complete valid configuration", () => {
    const config = loadConfig(validEnvironment);
    expect(config.PLAYWRIGHT_BROWSER_MODE).toBe("new-headless");
  });

  it.each([
    "C:\\secure\\google-service-account.json",
    "C:/secure/google-service-account.json",
    "/Users/test/secure/google-service-account.json",
    "/opt/kb-bank-sync/secrets/google-service-account.json",
    "/run/secrets/google-service-account.json",
  ])("preserves a platform service-account path without rewriting it: %s", (credentialPath) => {
    const config = loadConfig({ ...validEnvironment, GOOGLE_SERVICE_ACCOUNT_KEY_PATH: credentialPath });
    expect(config.GOOGLE_SERVICE_ACCOUNT_KEY_PATH).toBe(credentialPath);
  });

  it("continues to reject an empty service-account path", () => {
    expect(() => loadConfig({ ...validEnvironment, GOOGLE_SERVICE_ACCOUNT_KEY_PATH: "" }))
      .toThrow(/GOOGLE_SERVICE_ACCOUNT_KEY_PATH/u);
  });

  it("rejects missing required values before browser startup", () => {
    expect(() => loadConfig({})).toThrow(/Google 환경변수/u);
  });

  it("accepts a full Google Sheets URL and strips surrounding whitespace", () => {
    const config = loadConfig({
      ...validEnvironment,
      GOOGLE_SPREADSHEET_ID: "  https://docs.google.com/spreadsheets/d/test-spreadsheet-id-123456/edit#gid=0  ",
    });
    expect(config.GOOGLE_SPREADSHEET_ID).toBe("test-spreadsheet-id-123456");
  });

  it("rejects an invalid Spreadsheet ID before Google API access", () => {
    try {
      loadConfig({ ...validEnvironment, GOOGLE_SPREADSHEET_ID: "not valid" });
      throw new Error("expected invalid Spreadsheet ID");
    } catch (error) {
      expect(error).toMatchObject({ code: "GOOGLE_SPREADSHEET_ID_INVALID" });
    }
  });

  it("applies safe write and diagnostics defaults", () => {
    const config = loadConfig(validEnvironment);
    expect(config).toMatchObject({
      DRY_RUN: true,
      ENABLE_SHEETS_WRITE: false,
      ENABLE_DEEP_DIAGNOSTICS: false,
      ENABLE_RESPONSE_MEMORY_INSPECTION: false,
      ENABLE_SUBMIT_TRACING: false,
      SYNC_OVERLAP_DAYS: 3,
      INITIAL_LOOKBACK_MONTHS: 6,
    });
  });

  it("rejects malformed booleans and integers before browser startup", () => {
    expect(() => loadConfig({ ...validEnvironment, DRY_RUN: "yes" })).toThrow(/DRY_RUN/u);
    expect(() => loadConfig({ ...validEnvironment, SYNC_OVERLAP_DAYS: "3.5" })).toThrow(/SYNC_OVERLAP_DAYS/u);
  });

  it("rejects malformed sensitive fields without including their values in the error", () => {
    const invalidPassword = "not-a-pin";
    let message = "";
    try {
      loadConfig({ ...validEnvironment, KB_WEB_PASSWORD: invalidPassword });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(invalidPassword);
    expect(message).toContain("KB_WEB_PASSWORD");
  });

  it("rejects an unsupported browser mode before browser startup", () => {
    expect(() => loadConfig({ ...validEnvironment, PLAYWRIGHT_BROWSER_MODE: "unsupported" })).toThrow(
      /PLAYWRIGHT_BROWSER_MODE/u,
    );
  });

  it("requires an explicit browser mode before browser startup", () => {
    const withoutBrowserMode = { ...validEnvironment };
    delete withoutBrowserMode.PLAYWRIGHT_BROWSER_MODE;
    expect(() => loadConfig(withoutBrowserMode)).toThrow(/PLAYWRIGHT_BROWSER_MODE/u);
  });

  it("rejects an unsupported submit click mode", () => {
    expect(() => loadConfig({ ...validEnvironment, PLAYWRIGHT_SUBMIT_CLICK_MODE: "unsupported" })).toThrow(
      /PLAYWRIGHT_SUBMIT_CLICK_MODE/u,
    );
  });
});
