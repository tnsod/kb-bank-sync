import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, CDPSession } from "playwright";
import { describe, expect, it, vi } from "vitest";

import {
  classifyResponseBody,
  createCdpTargetRecorder,
  installSafePageDiagnostics,
  invokeObservedWindowOpen,
  summarizeInputValues,
} from "../src/bank/deep-diagnostics.js";
import { parseRawTransactionsWithDiagnostics } from "../src/bank/kb-parser.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "kb-result-success.html");

describe("window.open diagnostics", () => {
  it("preserves the original call, arguments, this value, and return value", () => {
    const returnValue = { marker: "same-window" };
    const original = vi.fn(function (this: object) {
      return this === thisValue ? returnValue : null;
    });
    const thisValue = { opener: true };
    const args = ["/quics?account=private#fragment", "resultWindow", "width=800"];
    const observed = invokeObservedWindowOpen(original, thisValue, args, "https://obank.example/input", 12);
    expect(observed.result).toBe(returnValue);
    expect(original).toHaveBeenCalledWith(...args);
    expect(observed.observation).toMatchObject({ atMs: 12, targetPresent: true, returnedNull: false });
  });

  it("removes query and fragment from an observed URL", () => {
    const observed = invokeObservedWindowOpen(() => null, null, ["/quics?secret=value#part"], "https://obank.example/input");
    expect(observed.observation.url).toEqual({ origin: "https://obank.example", pathname: "/quics" });
    expect(JSON.stringify(observed.observation)).not.toMatch(/secret|value|part/u);
  });
});

describe("response body memory classification", () => {
  it("detects verified result HTML and feeds the same strict DOM parser", async () => {
    const html = await readFile(fixturePath, "utf8");
    const classified = classifyResponseBody(html, "text/html; charset=utf-8");
    expect(classified.classification).toMatchObject({
      contentTypeCategory: "html",
      containsResultContainer: true,
      containsTransactionTable: true,
      containsAuthenticationError: false,
    });
    expect(parseRawTransactionsWithDiagnostics(classified.resultHtml ?? "").transactions).toHaveLength(2);
  });

  it("detects result HTML nested in JSON without retaining unrelated private text", () => {
    const body = JSON.stringify({ html: '<div id="b028770"><table class="tType01"></table></div>', private: "PRIVATE_COUNTERPARTY" });
    const classified = classifyResponseBody(body, "application/json");
    expect(classified.resultHtml).toContain("b028770");
    expect(JSON.stringify(classified.classification)).not.toContain("PRIVATE_COUNTERPARTY");
  });

  it("classifies authentication error structure without exposing its source", () => {
    const source = '<div id="errorDiv">비밀번호 입력정보를 확인하십시오 PRIVATE_ACCOUNT</div>';
    const classified = classifyResponseBody(source, "text/html");
    expect(classified.classification.containsAuthenticationError).toBe(true);
    expect(JSON.stringify(classified.classification)).not.toContain("PRIVATE_ACCOUNT");
  });
});

describe("safe page and input diagnostics", () => {
  it("the MutationObserver implementation records no text, HTML, or input values", () => {
    const source = installSafePageDiagnostics.toString();
    expect(source).not.toMatch(/innerText|innerHTML|textContent|\.value\b/u);
    expect(source).toMatch(/element\.id|classList/u);
  });

  it("returns only input presence and validation booleans", () => {
    const secret = "PRIVATE_INPUT_VALUE";
    const summary = summarizeInputValues({
      accountValue: secret,
      userIdentifierValue: secret,
      startParts: ["2026", "01", "15"],
      endParts: ["2026", "07", "15"],
      passwordLength: 4,
      expectedPasswordLength: 4,
      requiredRadioSelected: true,
      submitButtonEnabled: true,
      populatedHiddenInputCount: 2,
      activeElementTag: "input",
      activeElementId: "account_num",
    });
    expect(summary).toMatchObject({
      accountValuePresent: true,
      userIdentifierValuePresent: true,
      dateRangeComplete: true,
      passwordLengthMatches: true,
    });
    expect(JSON.stringify(summary)).not.toContain(secret);
  });
});

describe("CDP target lifecycle", () => {
  it("records an immediately created and destroyed target without query data", async () => {
    const handlers = new Map<string, Array<(payload: never) => void>>();
    const session = {
      on: vi.fn((event: string, handler: (payload: never) => void) => {
        handlers.set(event, [...handlers.get(event) ?? [], handler]);
      }),
      send: vi.fn().mockResolvedValue({}),
      detach: vi.fn().mockResolvedValue(undefined),
    } as unknown as CDPSession;
    const browser = { newBrowserCDPSession: vi.fn().mockResolvedValue(session) } as unknown as Browser;
    const recorder = await createCdpTargetRecorder(browser);
    handlers.get("Target.targetCreated")?.[0]?.({
      targetInfo: { targetId: "private-target-id", type: "page", openerId: "opener", url: "https://obank.example/quics?secret=value" },
    } as never);
    handlers.get("Target.targetDestroyed")?.[0]?.({ targetId: "private-target-id" } as never);
    const snapshot = recorder.snapshot();
    expect(snapshot.immediatelyDestroyedCount).toBe(1);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events[0]?.url).toEqual({ origin: "https://obank.example", pathname: "/quics" });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-target-id|secret|value/u);
    await recorder.dispose();
  });
});
