import { Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logging/logger.js";

describe("sensitive logging guard", () => {
  it("redacts credentials and transaction details", () => {
    let output = "";
    const destination = new Writable({
      write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        callback();
      },
    });
    const logger = createLogger({ LOG_LEVEL: "info" }, destination);
    logger.info({
      accountNumber: "00000000001234",
      birthDate: "000000",
      webPassword: "0000",
      transactions: [{ description: "민감거래상세", balance: 987654321 }],
    });
    expect(output).not.toContain("00000000001234");
    expect(output).not.toContain("민감거래상세");
    expect(output).not.toContain("987654321");
    expect(output).toContain("[REDACTED]");
  });

  it("keeps result fixtures free of credentials, account summaries, and session data", async () => {
    const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
    const contents = await Promise.all([
      readFile(path.join(fixtureDirectory, "kb-result-success.html"), "utf8"),
      readFile(path.join(fixtureDirectory, "kb-result-empty.html"), "utf8"),
    ]);
    for (const html of contents) {
      expect(html).not.toMatch(/\d{10,16}/u);
      expect(html).not.toMatch(/(?:계좌번호|주민사업자번호|고객식별번호|비밀번호|signed_msg|요청키|session|token)/iu);
      expect(html).not.toMatch(/<input[^>]+value=/iu);
      expect(html).not.toMatch(/총잔액|출금가능잔액/u);
    }
  });
});
