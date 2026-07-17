import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";

describe(".env loading precedence", () => {
  it("loads missing values while preserving current process values", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "kb-bank-sync-env-"));
    try {
      const file = path.join(directory, ".env");
      await writeFile(file, "GOOGLE_SHEET_NAME=from-file\nDRY_RUN=true\n", "utf8");
      const target: Record<string, string> = { GOOGLE_SHEET_NAME: "from-process" };
      const result = loadDotenv({ path: file, processEnv: target, override: false, quiet: true });
      expect(result.error).toBeUndefined();
      expect(target).toEqual({ GOOGLE_SHEET_NAME: "from-process", DRY_RUN: "true" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
