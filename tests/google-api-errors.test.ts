import { describe, expect, it } from "vitest";

import { classifyGoogleApiError } from "../src/spreadsheet/google-api-errors.js";

function googleError(status: number, reason?: string): Error & { response: object } {
  return Object.assign(new Error("safe test error"), {
    response: { status, data: { error: { errors: reason === undefined ? [] : [{ reason }] } } },
  });
}

describe("Google API error classification", () => {
  it("separates token, permission, not-found, and API-disabled errors", () => {
    expect(classifyGoogleApiError(googleError(401), "SHEET_DATA_INVALID").code).toBe("GOOGLE_AUTH_TOKEN_FAILED");
    expect(classifyGoogleApiError(googleError(403, "forbidden"), "SHEET_DATA_INVALID").code).toBe("SPREADSHEET_PERMISSION_DENIED");
    expect(classifyGoogleApiError(googleError(404), "SHEET_DATA_INVALID").code).toBe("SPREADSHEET_NOT_FOUND");
    expect(classifyGoogleApiError(googleError(403, "accessNotConfigured"), "SHEET_DATA_INVALID").code).toBe("GOOGLE_SHEETS_API_DISABLED");
  });

  it("retains only safe diagnostics", () => {
    const error = classifyGoogleApiError(googleError(403, "forbidden"), "SHEET_DATA_INVALID");
    expect(error.diagnostic).toEqual({ httpStatus: 403, googleReason: "forbidden", originalErrorName: "Error" });
  });
});
