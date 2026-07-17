import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("entrypoint configuration error reporting", () => {
  it("maps pre-browser ConfigurationError to validation_failed instead of unknown", async () => {
    const source = await readFile("src/index.ts", "utf8");
    expect(source).toContain('error.code === "CONFIGURATION_ERROR" ? "validation_failed"');
    expect(source).toContain("error instanceof KbSyncError");
  });
});
