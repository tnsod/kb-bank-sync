import { describe, expect, it, vi } from "vitest";

import {
  classifyDialogMessage,
  classifySubmitTransition,
  createLookupSubmissionTarget,
  createSanitizedRequestFailure,
  createSanitizedResponseMetadata,
  deduplicateByIdentity,
  executeAfterArming,
  findResultAcrossPages,
  finalizeTransitionStatus,
  isUnexpectedDialogType,
  sanitizeDialogEvent,
  sanitizeUrl,
  waitForResultPageReadiness,
} from "../src/bank/submit-diagnostics.js";
import { KB_SELECTORS } from "../src/config/selectors.js";
import type { Frame, Page } from "playwright";

describe("submit transition classification", () => {
  it.each([
    ["same-page navigation", { navigationDetected: true }, "same_page_navigation"],
    ["context page", { newPageDetected: true }, "new_page"],
    ["popup", { popupDetected: true }, "popup"],
    ["new iframe", { frameNavigationDetected: true }, "frame_navigation"],
    ["XHR DOM update", { relevantRequestCount: 1 }, "xhr_dom_update"],
    ["structural DOM update", { domChanged: true }, "xhr_dom_update"],
    ["dialog", { dialogDetected: true }, "dialog"],
  ] as const)("recognizes %s", (_name, override, expected) => {
    expect(classifySubmitTransition({
      newPageDetected: false,
      popupDetected: false,
      dialogDetected: false,
      navigationDetected: false,
      frameNavigationDetected: false,
      relevantRequestCount: 0,
      domChanged: false,
      ...override,
    })).toBe(expected);
  });

  it("uses no_submit_transition only when no event or DOM change exists", () => {
    expect(classifySubmitTransition({
      newPageDetected: false, popupDetected: false, dialogDetected: false,
      navigationDetected: false, frameNavigationDetected: false,
      relevantRequestCount: 0, domChanged: false,
    })).toBe("no_transition_detected");
  });

  it("does not turn a navigation timeout into authentication failure", () => {
    const status = classifySubmitTransition({
      newPageDetected: false, popupDetected: false, dialogDetected: false,
      navigationDetected: false, frameNavigationDetected: false,
      relevantRequestCount: 1, domChanged: false,
    });
    expect(status).toBe("xhr_dom_update");
    expect(status).not.toBe("dialog");
  });

  it("marks a detected transition without a result as result unknown", () => {
    expect(finalizeTransitionStatus("xhr_dom_update", false)).toBe("transition_detected_result_unknown");
    expect(finalizeTransitionStatus("xhr_dom_update", true)).toBe("xhr_dom_update");
    expect(finalizeTransitionStatus("no_transition_detected", false)).toBe("no_transition_detected");
  });
});

describe("pre-click event arming", () => {
  it("registers observation before a synchronous popup/response emitted by click", async () => {
    const order: string[] = [];
    const fastEvent = vi.fn(() => order.push("fast-event"));
    await executeAfterArming(
      () => order.push("armed"),
      () => {
        order.push("click");
        fastEvent();
        return Promise.resolve();
      },
    );
    expect(order).toEqual(["armed", "click", "fast-event"]);
    expect(fastEvent).toHaveBeenCalledTimes(1);
  });

  it("deduplicates the same popup reported by page and context", () => {
    const popup = {};
    expect(deduplicateByIdentity([popup, popup])).toEqual([popup]);
  });
});

function createResultFrame(resultVisible: boolean) {
  const locator = vi.fn((selector: string) => {
    if (selector === KB_SELECTORS.errorRegion) return { isVisible: vi.fn().mockResolvedValue(false) };
    if (selector === KB_SELECTORS.resultComponent) {
      return { isVisible: vi.fn().mockResolvedValue(resultVisible), innerText: vi.fn().mockResolvedValue("조회결과") };
    }
    if (selector === KB_SELECTORS.resultComponentAlternates[1]) {
      return { isVisible: vi.fn().mockResolvedValue(false) };
    }
    if (selector === "[role='alert']:visible") {
      return { first: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }) };
    }
    if (selector === "table:visible") return { count: vi.fn().mockResolvedValue(0) };
    throw new Error(`Unexpected selector: ${selector}`);
  });
  return { frame: { locator } as unknown as Frame, locator };
}

function createMockPage(frames: Frame[]): Page {
  return { frames: vi.fn().mockReturnValue(frames) } as unknown as Page;
}

describe("result Page and Frame resolution", () => {
  it("finds the result in a popup/context Page instead of the opener", async () => {
    const openerFrame = createResultFrame(false).frame;
    const resultFrame = createResultFrame(true).frame;
    const opener = createMockPage([openerFrame]);
    const popup = createMockPage([resultFrame]);
    const found = await findResultAcrossPages([opener, popup], [popup]);
    expect(found.located).toMatchObject({ page: popup, frame: resultFrame, source: "known-result" });
    const target = createLookupSubmissionTarget(opener, [opener, popup], found.located);
    expect(target).toMatchObject({ resultPage: popup, resultFrame, openedNewPage: true, resultPageIndex: 1 });
  });

  it("finds a result in the existing opener Page", async () => {
    const resultFrame = createResultFrame(true).frame;
    const opener = createMockPage([resultFrame]);
    const found = await findResultAcrossPages([opener], []);
    expect(createLookupSubmissionTarget(opener, [opener], found.located)).toMatchObject({
      resultPage: opener, resultFrame, openedNewPage: false, resultPageIndex: 0,
    });
  });

  it("finds a result in a child frame", async () => {
    const mainFrame = createResultFrame(false).frame;
    const childFrame = createResultFrame(true).frame;
    const page = createMockPage([mainFrame, childFrame]);
    const found = await findResultAcrossPages([page], []);
    expect(found.located?.frame).toBe(childFrame);
  });

  it("waits for an about:blank popup to navigate", async () => {
    let url = "about:blank";
    const waitForURL = vi.fn(() => {
      url = "https://obank.example/quics?secret=value";
      return Promise.resolve();
    });
    const page = {
      url: vi.fn(() => url),
      waitForURL,
      locator: vi.fn().mockReturnValue({ waitFor: vi.fn(() => new Promise<void>(() => undefined)) }),
    } as unknown as Page;
    await waitForResultPageReadiness(page, 100);
    expect(waitForURL).toHaveBeenCalledTimes(1);
    expect(sanitizeUrl(page.url())).toEqual({ origin: "https://obank.example", pathname: "/quics" });
  });
});

describe("safe metadata", () => {
  it("removes URL query strings and fragments", () => {
    expect(sanitizeUrl("https://obank.example/quics?account=secret#fragment")).toEqual({
      origin: "https://obank.example",
      pathname: "/quics",
    });
  });

  it("stores response metadata without body, headers, or query", () => {
    const metadata = createSanitizedResponseMetadata({
      method: "POST", status: 200, resourceType: "document",
      url: "https://obank.example/quics?password=secret",
    });
    expect(metadata).toEqual({
      method: "POST", status: 200, resourceType: "document",
      origin: "https://obank.example", pathname: "/quics",
    });
    expect(JSON.stringify(metadata)).not.toMatch(/secret|body|headers|query/iu);
  });

  it("stores only a normalized request failure category", () => {
    const failure = createSanitizedRequestFailure({
      method: "POST", resourceType: "xhr",
      url: "https://obank.example/result?user=private",
      failureText: "net::ERR_CONNECTION_RESET at https://secret.invalid/?token=x",
    });
    expect(failure).toEqual({
      method: "POST", resourceType: "xhr", origin: "https://obank.example",
      pathname: "/result", failureText: "net::ERR_CONNECTION_RESET",
    });
    expect(JSON.stringify(failure)).not.toMatch(/private|token|secret\.invalid/iu);
  });
});

describe("dialog safety and classification", () => {
  it("classifies an authentication alert without retaining its raw message", () => {
    const raw = "비밀번호 확인이 필요합니다 account-secret";
    const event = sanitizeDialogEvent("alert", raw);
    expect(event).toEqual({ type: "alert", messageCategory: "authentication" });
    expect(JSON.stringify(event)).not.toContain(raw);
  });

  it("classifies validation and maintenance dialogs", () => {
    expect(classifyDialogMessage("필수 입력값을 확인하세요")).toBe("validation");
    expect(classifyDialogMessage("서비스 점검 중입니다")).toBe("maintenance");
  });

  it("does not infer authentication from an unknown or timeout-like message", () => {
    expect(classifyDialogMessage("처리 결과를 확인할 수 없습니다")).toBe("validation");
    expect(classifyDialogMessage("timeout")).toBe("unknown");
  });

  it("stops on unexpected confirm and prompt types", () => {
    expect(isUnexpectedDialogType("alert")).toBe(false);
    expect(isUnexpectedDialogType("confirm")).toBe(true);
    expect(isUnexpectedDialogType("prompt")).toBe(true);
  });
});
