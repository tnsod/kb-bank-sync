import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  chromiumLaunchOptions,
  KB_BROWSER_CONTEXT_OPTIONS,
} from "../src/bank/browser-mode.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Playwright browser modes", () => {
  it("uses Playwright's default headless shell without a channel", () => {
    expect(chromiumLaunchOptions("default-headless")).toEqual({ headless: true, args: ["--disable-dev-shm-usage"] });
  });

  it("uses the Chromium channel for new headless", () => {
    expect(chromiumLaunchOptions("new-headless")).toEqual({
      headless: true, channel: "chromium", args: ["--disable-dev-shm-usage"],
    });
  });

  it("uses headed Chromium for Xvfb mode", () => {
    expect(chromiumLaunchOptions("headed")).toEqual({
      headless: false, channel: "chromium", args: ["--disable-dev-shm-usage"],
    });
  });

  it("keeps one identical context configuration for every mode", () => {
    expect(KB_BROWSER_CONTEXT_OPTIONS).toEqual({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
    });
  });
});

describe("Docker Xvfb entrypoint", () => {
  it("forwards every CLI argument through xvfb-run in headed mode", async () => {
    const script = await readFile(path.join(projectRoot, "scripts", "docker-entrypoint.sh"), "utf8");
    expect(script).toContain('xvfb-run -a node dist/index.js "$@" &');
    expect(script).toContain('wait "$child_pid"');
    expect(script).toContain('exec node dist/index.js "$@"');
  });

  it("uses Google Sheets without adding a database dependency", async () => {
    const packageJson = await readFile(path.join(projectRoot, "package.json"), "utf8");
    expect(packageJson).toContain("googleapis");
    expect(packageJson).not.toMatch(/sqlite|postgres|typeorm|prisma/iu);
  });
});
