import type { Browser, CDPSession, Frame, Page } from "playwright";

import { KB_SELECTORS } from "../config/selectors.js";

export interface DiagnosticUrl {
  origin: string;
  pathname: string;
}

export interface WindowOpenObservation {
  atMs: number;
  url: DiagnosticUrl | null;
  urlPresent: boolean;
  targetPresent: boolean;
  returnedNull: boolean;
}

export interface SafeDomMutation {
  action: "added" | "removed" | "changed";
  atMs: number;
  tag: string;
  id: string;
  classes: string[];
  parentId: string;
  parentClasses: string[];
  hidden: boolean;
  resultContainer: boolean;
  transactionTable: boolean;
}

export interface SafeUiEvent {
  atMs: number;
  type: string;
  tag: string;
  id: string;
}

export interface SafeFunctionEvent {
  atMs: number;
  name: string;
  phase: "enter" | "return" | "throw" | "settled" | "rejected";
  argumentCount: number;
  returnKind: "none" | "undefined" | "null" | "boolean-true" | "boolean-false" | "promise" | "other";
}

export interface PageRuntimeDiagnostics {
  windowOpenEvents: WindowOpenObservation[];
  mutations: SafeDomMutation[];
  uiEvents: SafeUiEvent[];
  functionEvents: SafeFunctionEvent[];
}

export interface InputStateDiagnostics {
  accountValuePresent: boolean;
  userIdentifierValuePresent: boolean;
  dateRangeComplete: boolean;
  passwordLengthMatches: boolean;
  requiredRadioSelected: boolean;
  submitButtonEnabled: boolean;
  populatedHiddenInputCount: number;
  activeElementTag: string;
  activeElementId: string;
  accountValueMatchesExpected: boolean | null;
  userIdentifierValueMatchesExpected: boolean | null;
  dateRangeMatchesExpected: boolean | null;
}

export interface ExpectedInputState {
  accountNumber: string;
  userIdentifier: string;
  startDate: string;
  endDate: string;
}

export interface FormStateDiagnostics {
  method: string;
  target: string;
  targetPresent: boolean;
  action: DiagnosticUrl | null;
  hiddenInputs: Array<{ name: string; id: string; valuePresent: boolean }>;
}

export type ContentTypeCategory = "html" | "json" | "script" | "text" | "other";

export interface ResponseBodyClassification {
  contentTypeCategory: ContentTypeCategory;
  bodyLength: number;
  containsResultContainer: boolean;
  containsTransactionTable: boolean;
  containsErrorContainer: boolean;
  containsAuthenticationError: boolean;
  containsMaintenanceMessage: boolean;
  containsWindowOpen: boolean;
  containsDomInsertion: boolean;
  paginationPatternDetected: boolean;
}

export interface ClassifiedResponseBody {
  classification: ResponseBodyClassification;
  resultHtml: string | null;
}

export interface SafeResponseBodyDiagnostic extends ResponseBodyClassification {
  method: string;
  status: number;
  resourceType: string;
  origin: string;
  pathname: string;
}

export interface CdpTargetEvent {
  sequence: number;
  event: "created" | "changed" | "destroyed" | "attached" | "detached";
  targetType: "page" | "iframe" | "other";
  openerPresent: boolean;
  url: DiagnosticUrl;
  atMs: number;
}

export interface CdpTargetDiagnostics {
  supported: boolean;
  events: CdpTargetEvent[];
  immediatelyDestroyedCount: number;
}

export interface CdpTargetRecorder {
  snapshot(): CdpTargetDiagnostics;
  dispose(): Promise<void>;
}

export interface StorageKeyDiagnostics {
  localStorageKeys: string[];
  sessionStorageKeys: string[];
}

const MAX_CDP_EVENTS = 300;

export function sanitizeDiagnosticUrl(rawUrl: string, baseUrl?: string): DiagnosticUrl | null {
  try {
    const parsed = baseUrl === undefined ? new URL(rawUrl) : new URL(rawUrl, baseUrl);
    return { origin: parsed.origin, pathname: parsed.pathname };
  } catch {
    return null;
  }
}

export function invokeObservedWindowOpen<T>(
  originalOpen: (...args: unknown[]) => T,
  thisValue: unknown,
  args: readonly unknown[],
  baseUrl: string,
  atMs = 0,
): { result: T; observation: WindowOpenObservation } {
  const rawUrl = typeof args[0] === "string" ? args[0] : "";
  const result = Reflect.apply(originalOpen, thisValue, args);
  return {
    result,
    observation: {
      atMs,
      url: sanitizeDiagnosticUrl(rawUrl, baseUrl),
      urlPresent: rawUrl !== "",
      targetPresent: typeof args[1] === "string" && args[1].length > 0,
      returnedNull: result === null,
    },
  };
}

function contentTypeCategory(contentType: string, body: string): ContentTypeCategory {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("json")) return "json";
  if (normalized.includes("html") || /<(?:!doctype|html|body|div|table)\b/iu.test(body)) return "html";
  if (normalized.includes("javascript") || normalized.includes("ecmascript")) return "script";
  if (normalized.startsWith("text/")) return "text";
  return "other";
}

function findResultHtmlInJson(value: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    return /id=["']b028770["']/iu.test(value) && /<table\b[^>]*class=["'][^"']*\btType01\b/iu.test(value)
      ? value : null;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findResultHtmlInJson(child, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      const found = findResultHtmlInJson(child, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

export function classifyResponseBody(body: string, contentType = ""): ClassifiedResponseBody {
  const directResult = /id=["']b028770["']/iu.test(body);
  const directTable = /<table\b[^>]*class=["'][^"']*\btType01\b/iu.test(body);
  let resultHtml: string | null = directResult && directTable ? body : null;
  let parsedJson = false;
  if (resultHtml === null && (contentType.toLowerCase().includes("json") || /^\s*[[{]/u.test(body))) {
    try {
      resultHtml = findResultHtmlInJson(JSON.parse(body));
      parsedJson = true;
    } catch {
      parsedJson = false;
    }
  }
  const searchable = resultHtml ?? body;
  return {
    classification: {
      contentTypeCategory: parsedJson ? "json" : contentTypeCategory(contentType, body),
      bodyLength: body.length,
      containsResultContainer: directResult || /id=["']b028770["']/iu.test(searchable),
      containsTransactionTable: directTable || /<table\b[^>]*class=["'][^"']*\btType01\b/iu.test(searchable),
      containsErrorContainer: /id=["'](?:errorDiv|errMsg)["']/iu.test(searchable),
      containsAuthenticationError: /(?:비밀번호|인증정보|입력정보).{0,40}(?:오류|일치하지|확인)/u.test(searchable),
      containsMaintenanceMessage: /(?:서비스|시스템).{0,40}(?:점검|중단|이용시간)/u.test(searchable),
      containsWindowOpen: /\bwindow\.open\s*\(/u.test(searchable),
      containsDomInsertion: /(?:\.innerHTML\s*=|insertAdjacentHTML\s*\(|appendChild\s*\(|replaceWith\s*\(|\.html\s*\()/u.test(searchable),
      paginationPatternDetected: /(?:pagination|paging|더보기|다음\s*페이지)/iu.test(searchable),
    },
    resultHtml,
  };
}

function safeIdentifier(value: string): string {
  const normalized = value.trim();
  return /^[A-Za-z가-힣_-][A-Za-z0-9가-힣_-]{0,63}$/u.test(normalized) && !/\d{8,}/u.test(normalized)
    ? normalized : "";
}

export function summarizeInputValues(input: {
  accountValue: string;
  userIdentifierValue: string;
  startParts: string[];
  endParts: string[];
  passwordLength: number;
  expectedPasswordLength: number;
  requiredRadioSelected: boolean;
  submitButtonEnabled: boolean;
  populatedHiddenInputCount: number;
  activeElementTag: string;
  activeElementId: string;
  expected?: ExpectedInputState;
}): InputStateDiagnostics {
  const startDate = input.startParts.join("-");
  const endDate = input.endParts.join("-");
  return {
    accountValuePresent: input.accountValue !== "",
    userIdentifierValuePresent: input.userIdentifierValue !== "",
    dateRangeComplete: [...input.startParts, ...input.endParts].every((part) => part !== ""),
    passwordLengthMatches: input.passwordLength === input.expectedPasswordLength,
    requiredRadioSelected: input.requiredRadioSelected,
    submitButtonEnabled: input.submitButtonEnabled,
    populatedHiddenInputCount: input.populatedHiddenInputCount,
    activeElementTag: safeIdentifier(input.activeElementTag.toLowerCase()),
    activeElementId: safeIdentifier(input.activeElementId),
    accountValueMatchesExpected: input.expected === undefined ? null : input.accountValue === input.expected.accountNumber,
    userIdentifierValueMatchesExpected: input.expected === undefined ? null : input.userIdentifierValue === input.expected.userIdentifier,
    dateRangeMatchesExpected: input.expected === undefined ? null
      : startDate === input.expected.startDate && endDate === input.expected.endDate,
  };
}

export async function collectInputState(
  page: Page,
  expectedPasswordLength: number,
  expected?: ExpectedInputState,
): Promise<InputStateDiagnostics> {
  const values = await Promise.all([
    page.locator(KB_SELECTORS.accountNumber).inputValue().catch(() => ""),
    page.locator(KB_SELECTORS.birthDate).inputValue().catch(() => ""),
    Promise.all([KB_SELECTORS.startYear, KB_SELECTORS.startMonth, KB_SELECTORS.startDay]
      .map((selector) => page.locator(selector).inputValue().catch(() => ""))),
    Promise.all([KB_SELECTORS.endYear, KB_SELECTORS.endMonth, KB_SELECTORS.endDay]
      .map((selector) => page.locator(selector).inputValue().catch(() => ""))),
    page.locator(KB_SELECTORS.password).inputValue().then((value) => value.length).catch(() => -1),
    page.locator(KB_SELECTORS.birthDateMode).isChecked().catch(() => false),
    page.locator(KB_SELECTORS.submit).isEnabled().catch(() => false),
    page.locator("#IBF input[type='hidden']").evaluateAll((inputs) =>
      inputs.filter((input) => (input as HTMLInputElement).value !== "").length).catch(() => 0),
    page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "",
      id: (document.activeElement as HTMLElement | null)?.id ?? "",
    })).catch(() => ({ tag: "", id: "" })),
  ]);
  return summarizeInputValues({
    accountValue: values[0], userIdentifierValue: values[1], startParts: values[2], endParts: values[3],
    passwordLength: values[4], expectedPasswordLength, requiredRadioSelected: values[5],
    submitButtonEnabled: values[6], populatedHiddenInputCount: values[7],
    activeElementTag: values[8].tag, activeElementId: values[8].id,
    ...(expected === undefined ? {} : { expected }),
  });
}

export async function collectFormState(page: Page): Promise<FormStateDiagnostics> {
  return page.locator("#IBF").evaluate((formElement) => {
    const form = formElement as HTMLFormElement;
    const sanitize = (value: string): string => {
      const normalized = value.trim().replace(/_[A-Fa-f0-9]{10,}$/u, "_dynamic");
      return /^[A-Za-z가-힣_.:-][A-Za-z0-9가-힣_.:-]{0,79}$/u.test(normalized) && !/\d{8,}/u.test(normalized)
        ? normalized : "";
    };
    let action: DiagnosticUrl | null = null;
    try {
      const parsed = new URL(form.action, location.href);
      action = { origin: parsed.origin, pathname: parsed.pathname };
    } catch {
      action = null;
    }
    return {
      method: sanitize(form.method.toLowerCase()),
      target: sanitize(form.target),
      targetPresent: form.target !== "",
      action,
      hiddenInputs: Array.from(form.querySelectorAll<HTMLInputElement>("input[type='hidden']")).slice(0, 100).map((input) => ({
        name: sanitize(input.name),
        id: sanitize(input.id),
        valuePresent: input.value !== "",
      })),
    };
  }).catch(() => ({ method: "", target: "", targetPresent: false, action: null, hiddenInputs: [] }));
}

export function installSafePageDiagnostics(): void {
  type RuntimeState = PageRuntimeDiagnostics & { startedAt: number };
  const key = "__kbSafeDiagnosticsV1";
  const host = window as typeof window & { [name: string]: unknown };
  if (host[key] !== undefined) return;
  const state: RuntimeState = {
    startedAt: Date.now(), windowOpenEvents: [], mutations: [], uiEvents: [], functionEvents: [],
  };
  Object.defineProperty(host, key, { value: state, configurable: false, enumerable: false, writable: false });
  const identifier = (value: string): string => {
    const normalized = value.trim();
    return /^[A-Za-z가-힣_-][A-Za-z0-9가-힣_-]{0,63}$/u.test(normalized) && !/\d{8,}/u.test(normalized)
      ? normalized : "";
  };
  const describe = (element: Element, action: SafeDomMutation["action"]): SafeDomMutation => {
    const parent = element.parentElement;
    const style = element instanceof HTMLElement ? getComputedStyle(element) : null;
    return {
      action,
      atMs: Date.now() - state.startedAt,
      tag: element.tagName.toLowerCase(),
      id: identifier(element.id),
      classes: Array.from(element.classList).map(identifier).filter(Boolean).slice(0, 10),
      parentId: identifier(parent?.id ?? ""),
      parentClasses: Array.from(parent?.classList ?? []).map(identifier).filter(Boolean).slice(0, 10),
      hidden: element instanceof HTMLElement && (element.hidden || style?.display === "none" || style?.visibility === "hidden"),
      resultContainer: element.id === "b028770",
      transactionTable: element.matches("table.tType01") && element.closest("#b028770") !== null,
    };
  };
  const pushMutation = (element: Element, action: SafeDomMutation["action"]): void => {
    if (state.mutations.length < 300) state.mutations.push(describe(element, action));
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        const element = record.target instanceof Element ? record.target : null;
        if (element !== null && (element.id === "b028770" || element.matches("table.tType01"))) pushMutation(element, "changed");
        continue;
      }
      for (const [nodes, action] of [[record.addedNodes, "added"], [record.removedNodes, "removed"]] as const) {
        for (const node of Array.from(nodes)) {
          if (!(node instanceof Element)) continue;
          pushMutation(node, action);
          for (const nested of Array.from(node.querySelectorAll("#b028770, table.tType01"))) pushMutation(nested, action);
        }
      }
    }
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["id", "class", "hidden", "style"] });
  for (const type of ["mousedown", "mouseup", "click", "change", "blur", "submit"]) {
    document.addEventListener(type, (event) => {
      const element = event.target instanceof Element ? event.target : null;
      if (element === null || !element.matches("input, select, button, form")) return;
      if (state.uiEvents.length < 300) {
        state.uiEvents.push({
          atMs: Date.now() - state.startedAt,
          type,
          tag: element.tagName.toLowerCase(),
          id: identifier(element.id),
        });
      }
    }, true);
  }
  const originalOpen = window.open;
  window.open = function (...args: Parameters<typeof window.open>): ReturnType<typeof window.open> {
    const rawUrl = typeof args[0] === "string" ? args[0] : "";
    let sanitized: DiagnosticUrl | null = null;
    try {
      const parsed = new URL(rawUrl, location.href);
      sanitized = { origin: parsed.origin, pathname: parsed.pathname };
    } catch {
      sanitized = null;
    }
    const result = Reflect.apply(originalOpen, this, args);
    if (state.windowOpenEvents.length < 300) {
      state.windowOpenEvents.push({
        atMs: Date.now() - state.startedAt,
        url: sanitized,
        urlPresent: rawUrl !== "",
        targetPresent: typeof args[1] === "string" && args[1].length > 0,
        returnedNull: result === null,
      });
    }
    return result;
  };
}

export async function installSubmitFunctionTracing(frame: Frame): Promise<void> {
  await frame.evaluate((functionNames) => {
    type RuntimeState = PageRuntimeDiagnostics & { startedAt: number; wrappedFunctions?: string[] };
    const host = window as typeof window & Record<string, unknown> & { __kbSafeDiagnosticsV1?: RuntimeState };
    const state = host.__kbSafeDiagnosticsV1;
    if (state === undefined) return;
    state.functionEvents ??= [];
    state.wrappedFunctions ??= [];
    const returnKind = (value: unknown): SafeFunctionEvent["returnKind"] => {
      if (value === undefined) return "undefined";
      if (value === null) return "null";
      if (value === true) return "boolean-true";
      if (value === false) return "boolean-false";
      if (typeof (value as { then?: unknown })?.then === "function") return "promise";
      return "other";
    };
    const push = (event: Omit<SafeFunctionEvent, "atMs">): void => {
      if (state.functionEvents.length < 300) {
        state.functionEvents.push({ ...event, atMs: Date.now() - state.startedAt });
      }
    };
    for (const name of functionNames) {
      if (state.wrappedFunctions.includes(name)) continue;
      const original = host[name];
      if (typeof original !== "function") continue;
      const observed = new Proxy(original, {
        apply(target, thisArgument, argumentsList) {
          const argumentCount = argumentsList.length;
          push({ name, phase: "enter", argumentCount, returnKind: "none" });
          try {
            const result = Reflect.apply(target, thisArgument, argumentsList) as unknown;
            const kind = returnKind(result);
            push({ name, phase: "return", argumentCount, returnKind: kind });
            if (kind === "promise") {
              void Promise.resolve(result).then(
                () => push({ name, phase: "settled", argumentCount, returnKind: "none" }),
                () => push({ name, phase: "rejected", argumentCount, returnKind: "none" }),
              );
            }
            return result;
          } catch (error) {
            push({ name, phase: "throw", argumentCount, returnKind: "none" });
            throw error;
          }
        },
      });
      try {
        host[name] = observed;
        state.wrappedFunctions.push(name);
      } catch {
        // A non-writable global is simply not traceable; the original function remains untouched.
      }
    }
  }, [
    "uf_GoSubmit",
    "removeChar",
    "InputCheck",
    "Car_DateCheck",
    "JForm",
    "JText",
    "JValidate",
    "JDate",
    "JCheck",
    "step2_GetActionURL",
    "checkIndpAndGoNext",
    "CAR_doAjaxCC",
  ]);
}

export async function collectPageRuntimeDiagnostics(frame: Frame): Promise<PageRuntimeDiagnostics> {
  return frame.evaluate(() => {
    const state = (window as typeof window & { __kbSafeDiagnosticsV1?: PageRuntimeDiagnostics }).__kbSafeDiagnosticsV1;
    return state === undefined
      ? { windowOpenEvents: [], mutations: [], uiEvents: [], functionEvents: [] }
      : {
          windowOpenEvents: state.windowOpenEvents.slice(0, 300),
          mutations: state.mutations.slice(0, 300),
          uiEvents: state.uiEvents.slice(0, 300),
          functionEvents: (state.functionEvents ?? []).slice(0, 300),
        };
  }).catch(() => ({ windowOpenEvents: [], mutations: [], uiEvents: [], functionEvents: [] }));
}

export async function resetPageRuntimeDiagnostics(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const state = (window as typeof window & { __kbSafeDiagnosticsV1?: PageRuntimeDiagnostics }).__kbSafeDiagnosticsV1;
    if (state !== undefined) {
      state.windowOpenEvents.length = 0;
      state.mutations.length = 0;
      state.uiEvents.length = 0;
      state.functionEvents.length = 0;
    }
  }).catch(() => undefined);
}

export async function collectStorageKeyDiagnostics(frame: Frame): Promise<StorageKeyDiagnostics> {
  return frame.evaluate(() => {
    const sanitize = (value: string): string => {
      const normalized = value.trim();
      return /^[A-Za-z가-힣_.:-][A-Za-z0-9가-힣_.:-]{0,79}$/u.test(normalized) && !/\d{8,}/u.test(normalized)
        ? normalized : "";
    };
    return {
      localStorageKeys: Object.keys(localStorage).map(sanitize).filter(Boolean).slice(0, 100),
      sessionStorageKeys: Object.keys(sessionStorage).map(sanitize).filter(Boolean).slice(0, 100),
    };
  }).catch(() => ({ localStorageKeys: [], sessionStorageKeys: [] }));
}

function targetType(value: string): CdpTargetEvent["targetType"] {
  return value === "page" || value === "iframe" ? value : "other";
}

export async function createCdpTargetRecorder(browser: Browser): Promise<CdpTargetRecorder> {
  let session: CDPSession;
  try {
    session = await browser.newBrowserCDPSession();
  } catch {
    return { snapshot: () => ({ supported: false, events: [], immediatelyDestroyedCount: 0 }), dispose: () => Promise.resolve() };
  }
  const startedAt = Date.now();
  const events: CdpTargetEvent[] = [];
  const sequenceByTarget = new Map<string, number>();
  const createdAt = new Map<string, number>();
  let sequence = 0;
  let immediatelyDestroyedCount = 0;
  const push = (event: CdpTargetEvent["event"], info: { targetId: string; type?: string; openerId?: string; url?: string }): void => {
    let targetSequence = sequenceByTarget.get(info.targetId);
    if (targetSequence === undefined) {
      targetSequence = sequence;
      sequence += 1;
      sequenceByTarget.set(info.targetId, targetSequence);
    }
    const atMs = Date.now() - startedAt;
    if (event === "created") createdAt.set(info.targetId, atMs);
    if (event === "destroyed") {
      const created = createdAt.get(info.targetId);
      if (created !== undefined && atMs - created <= 1_000) immediatelyDestroyedCount += 1;
    }
    if (events.length < MAX_CDP_EVENTS) {
      events.push({
        sequence: targetSequence,
        event,
        targetType: targetType(info.type ?? "other"),
        openerPresent: (info.openerId ?? "") !== "",
        url: sanitizeDiagnosticUrl(info.url ?? "") ?? { origin: "unknown", pathname: "/" },
        atMs,
      });
    }
  };
  session.on("Target.targetCreated", (payload) => push("created", payload.targetInfo));
  session.on("Target.targetInfoChanged", (payload) => push("changed", payload.targetInfo));
  session.on("Target.targetDestroyed", (payload) => push("destroyed", { targetId: payload.targetId }));
  session.on("Target.attachedToTarget", (payload) => push("attached", payload.targetInfo));
  session.on("Target.detachedFromTarget", (payload) => push("detached", { targetId: payload.targetId ?? payload.sessionId }));
  await session.send("Target.setDiscoverTargets", { discover: true });
  await session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  return {
    snapshot: () => ({ supported: true, events: [...events], immediatelyDestroyedCount }),
    dispose: async () => session.detach().catch(() => undefined),
  };
}
