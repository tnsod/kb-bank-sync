import type { BrowserContextOptions, LaunchOptions } from "playwright";

export type BrowserMode = "default-headless" | "new-headless" | "headed";

export const KB_BROWSER_CONTEXT_OPTIONS = Object.freeze({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  locale: "ko-KR",
  timezoneId: "Asia/Seoul",
}) satisfies BrowserContextOptions;

export function chromiumLaunchOptions(mode: BrowserMode): LaunchOptions {
  const args = ["--disable-dev-shm-usage"];
  switch (mode) {
    case "default-headless":
      return { headless: true, args };
    case "new-headless":
      return { headless: true, channel: "chromium", args };
    case "headed":
      return { headless: false, channel: "chromium", args };
  }
}
