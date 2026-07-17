import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { fingerprintTransaction } from "../src/transaction/fingerprint.js";
import type { TransactionWithoutSourceKey } from "../src/transaction/transaction.js";

const transaction: TransactionWithoutSourceKey = {
  bank: "KB",
  accountId: "KB-1234",
  occurredAt: "2026-07-16T12:30:00+09:00",
  transactionType: "deposit",
  description: "architecture-neutral fixture",
  memo: null,
  withdrawal: 0,
  deposit: 1000,
  balance: 10000,
  branch: null,
  collectedAt: "2026-07-17T01:00:00+09:00",
};

describe("ARM64 container compatibility", () => {
  it("keeps the Playwright package and multi-architecture image versions aligned", async () => {
    const [dockerfile, packageJson] = await Promise.all([
      readFile("Dockerfile", "utf8"),
      readFile("package.json", "utf8").then((value) => JSON.parse(value) as {
        dependencies: Record<string, string>;
      }),
    ]);

    expect(dockerfile).toMatch(/^FROM mcr\.microsoft\.com\/playwright:v1\.61\.1-noble$/mu);
    expect(packageJson.dependencies.playwright).toBe("1.61.1");
  });

  it("does not force the production container to amd64", async () => {
    const [dockerfile, compose] = await Promise.all([
      readFile("Dockerfile", "utf8"),
      readFile("docker-compose.yml", "utf8"),
    ]);

    expect(`${dockerfile}\n${compose}`).not.toMatch(/(?:linux\/amd64|x86_64)/u);
  });

  it("locks the Linux ARM64 Sharp and libvips packages", async () => {
    const packageLock = await readFile("package-lock.json", "utf8");
    expect(packageLock).toContain('"node_modules/@img/sharp-linux-arm64"');
    expect(packageLock).toContain('"node_modules/@img/sharp-libvips-linux-arm64"');
  });

  it("does not include runtime architecture metadata in sourceKey", () => {
    const arm64Input = { ...transaction, runtimeArchitecture: "arm64" };
    const amd64Input = { ...transaction, runtimeArchitecture: "amd64" };

    expect(fingerprintTransaction(arm64Input).sourceKey)
      .toBe(fingerprintTransaction(amd64Input).sourceKey);
  });
});
