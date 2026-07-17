import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Docker credential path separation", () => {
  it("mounts the host key at a fixed read-only container path", async () => {
    const compose = await readFile(path.resolve("docker-compose.yml"), "utf8");
    expect(compose).toContain("source: ${GOOGLE_SERVICE_ACCOUNT_KEY_PATH");
    expect(compose).toContain("target: /run/secrets/google-service-account.json");
    expect(compose).toContain("GOOGLE_SERVICE_ACCOUNT_KEY_PATH: /run/secrets/google-service-account.json");
    expect(compose).toContain("DRY_RUN: ${DRY_RUN:-true}");
    expect(compose).toContain("ENABLE_SHEETS_WRITE: ${ENABLE_SHEETS_WRITE:-false}");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("kb-sync:");
    expect(compose).toContain("image: kb-bank-sync:0.1.0");
  });

  it("excludes environment and credential material from the build context", async () => {
    const ignored = await readFile(path.resolve(".dockerignore"), "utf8");
    expect(ignored).toMatch(/^\.env$/mu);
    expect(ignored).toContain("credentials");
    expect(ignored).toContain("secrets");
    expect(ignored).toContain("**/*service-account*.json");
  });
});
