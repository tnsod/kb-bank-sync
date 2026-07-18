import type {
  BrowserContext,
  ConsoleMessage,
  Dialog,
  Frame,
  Locator,
  Page,
  Request,
  Response,
} from "playwright";

import { KB_SELECTORS, LOOKUP_MESSAGE_PATTERNS } from "../config/selectors.js";
import type { ParserFailureDiagnostic } from "./kb-errors.js";
import {
  classifyResponseBody,
  collectFormState,
  collectInputState,
  collectPageRuntimeDiagnostics,
  collectStorageKeyDiagnostics,
  installSubmitFunctionTracing,
  sanitizeDiagnosticUrl,
  resetPageRuntimeDiagnostics,
  type CdpTargetDiagnostics,
  type InputStateDiagnostics,
  type ExpectedInputState,
  type FormStateDiagnostics,
  type PageRuntimeDiagnostics,
  type SafeResponseBodyDiagnostic,
} from "./deep-diagnostics.js";
import { PageStructureError } from "./kb-errors.js";

export interface SanitizedUrl {
  origin: string;
  pathname: string;
}

export interface SanitizedResponseMetadata extends SanitizedUrl {
  method: string;
  status: number;
  resourceType: string;
}

export interface SanitizedRequestFailure extends SanitizedUrl {
  method: string;
  resourceType: string;
  failureText: string | null;
}

export type DialogMessageCategory = "empty" | "authentication" | "validation" | "maintenance" | "unknown";

export interface SanitizedDialogEvent {
  type: string;
  messageCategory: DialogMessageCategory;
}

export interface SanitizedFrameEvent {
  event: "attached" | "navigated";
  name: string;
  origin: string;
  pathname: string;
  parentFramePresent: boolean;
}

export interface SanitizedConsoleEvent {
  type: string;
  category: "general" | "javascript-error" | "network" | "security" | "unknown";
}

export interface SafeTableInventory {
  rows: number;
  columns: number;
  headers: string[];
}

export interface SafeFrameInventory {
  pageIndex: number;
  frameIndex: number;
  name: string;
  url: SanitizedUrl;
  parentFramePresent: boolean;
  bodyPresent: boolean;
  elements: {
    divs: number;
    forms: number;
    tables: number;
    iframes: number;
    buttons: number;
    inputs: number;
  };
  ids: string[];
  classes: string[];
  inputs: Array<{ type: string; id: string }>;
  buttons: Array<{ type: string; id: string; label: string }>;
  tableShapes: SafeTableInventory[];
  iframeSources: Array<{ name: string; origin: string; pathname: string }>;
}

export interface SafePageInventory {
  pageIndex: number;
  url: SanitizedUrl;
  title: string;
  mainFrameUrl: SanitizedUrl;
  frameCount: number;
  childFrameCount: number;
  bodyPresent: boolean;
}

export interface SubmitButtonDiagnostics {
  selectorCount: number;
  visible: boolean;
  enabled: boolean;
  actionable: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  type: string;
  formPresent: boolean;
  formTargetPresent: boolean;
  buttonFormTarget: string;
  formTarget: string;
  formAction: SanitizedUrl | null;
  clickHandlerPresent: boolean;
  activeElementTagBefore: string;
  activeElementIdBefore: string;
}

export interface LookupSubmissionTarget {
  openerPage: Page;
  resultPage: Page;
  resultFrame: Frame;
  openedNewPage: boolean;
  resultPageIndex: number;
}

export type SubmitTransitionStatus =
  | "new_page"
  | "popup"
  | "same_page_navigation"
  | "frame_navigation"
  | "xhr_dom_update"
  | "dialog"
  | "no_transition_detected"
  | "transition_detected_result_unknown";

export interface SubmitDiagnostics {
  pagesBefore: number;
  pagesAfter: number;
  framesBefore: number;
  framesAfter: number;
  originalPageUrlBefore: SanitizedUrl;
  originalPageUrlAfter: SanitizedUrl;
  originalPageTitleAfter: string;
  newPageDetected: boolean;
  popupDetected: boolean;
  dialogDetected: boolean;
  navigationDetected: boolean;
  frameNavigationDetected: boolean;
  attachedFrameCount: number;
  observedResponses: SanitizedResponseMetadata[];
  failedRequests: SanitizedRequestFailure[];
  activePageIndex: number;
  activePageUrl: SanitizedUrl;
  activePageTitle: string;
  openedNewPage: boolean;
  resultPageIndex: number | null;
  resultFrameIndex: number | null;
  resultUrl: SanitizedUrl | null;
  resultContainerDetected: boolean;
  knownResultSelectorMatches: Record<string, boolean>;
  parserFailure: ParserFailureDiagnostic | null;
  transitionStatus: SubmitTransitionStatus;
  dialogEvents: SanitizedDialogEvent[];
  frameEvents: SanitizedFrameEvent[];
  consoleEvents: SanitizedConsoleEvent[];
  pageErrorCount: number;
  crashDetected: boolean;
  relevantRequestCount: number;
  loadEventCount: number;
  domContentLoadedEventCount: number;
  button: SubmitButtonDiagnostics;
  pages: SafePageInventory[];
  frames: SafeFrameInventory[];
  inputStateBeforeSubmit: InputStateDiagnostics;
  inputStateAfterSubmit: InputStateDiagnostics;
  responseBodies: SafeResponseBodyDiagnostic[];
  responseResultDetected: boolean;
  runtime: Array<PageRuntimeDiagnostics & { pageIndex: number; frameIndex: number }>;
  cdpTargets: CdpTargetDiagnostics | null;
  browserState: {
    cookieCount: number;
    storage: Array<{ pageIndex: number; frameIndex: number; localStorageKeys: string[]; sessionStorageKeys: string[] }>;
  };
  formStateBeforeSubmit: FormStateDiagnostics;
  formStateAfterSubmit: FormStateDiagnostics;
}

export type DiagnosedLookupStatus = "success" | "empty" | "invalid_credentials" | "maintenance";

export interface LocatedResult {
  page: Page;
  frame: Frame;
  locator: Locator;
  status: DiagnosedLookupStatus;
  source: "known-result" | "known-error" | "heuristic-table" | "alert";
}

export interface SubmitObservation {
  diagnostics: SubmitDiagnostics;
  locatedResult: LocatedResult | null;
  target: LookupSubmissionTarget | null;
  resultResponseHtml: string | null;
  authenticationDialogDetected: boolean;
  unexpectedDialogDetected: boolean;
}

interface RecorderState {
  newPages: Set<Page>;
  popupPages: Set<Page>;
  dialogEvents: SanitizedDialogEvent[];
  frameEvents: SanitizedFrameEvent[];
  consoleEvents: SanitizedConsoleEvent[];
  observedResponses: SanitizedResponseMetadata[];
  failedRequests: SanitizedRequestFailure[];
  navigationDetected: boolean;
  frameNavigationDetected: boolean;
  relevantRequestCount: number;
  attachedFrameCount: number;
  pageErrorCount: number;
  crashDetected: boolean;
  loadEventCount: number;
  domContentLoadedEventCount: number;
  unexpectedDialogDetected: boolean;
  responseBodies: SafeResponseBodyDiagnostic[];
  responseAnalysisTasks: Promise<void>[];
  resultResponseHtml: string | null;
}

const MAX_EVENTS = 200;
const RESULT_DISCOVERY_TIMEOUT_MS = 45_000;
const EVENT_WINDOW_TIMEOUT_MS = 15_000;
const RELEVANT_RESOURCE_TYPES = new Set(["document", "xhr", "fetch"]);

export function sanitizeUrl(rawUrl: string): SanitizedUrl {
  try {
    const parsed = new URL(rawUrl);
    return { origin: parsed.origin, pathname: parsed.pathname };
  } catch {
    return { origin: "unknown", pathname: "/" };
  }
}

function sanitizeIdentifier(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z가-힣_-][A-Za-z0-9가-힣_-]{0,63}$/u.test(normalized) || /\d{8,}/u.test(normalized)) return "";
  return normalized;
}

function sanitizeTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized === "") return "";
  if (/\d{6,}|@/u.test(normalized)) return "[present]";
  return normalized.slice(0, 80);
}

function sanitizeFailureText(value: string | null): string | null {
  if (value === null) return null;
  return value.match(/(?:net::)?ERR_[A-Z0-9_]+/u)?.[0] ?? "unknown_failure";
}

function sanitizeButtonLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim().slice(0, 20);
  return /^(?:조회|확인|닫기|취소|다음|이전|더보기|검색|OK|Cancel|Next|Previous)$/iu.test(normalized) ? normalized : "";
}

function sanitizeHeader(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim().slice(0, 40);
  return /\d{6,}/u.test(normalized) ? "" : normalized;
}

function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

export function classifyDialogMessage(message: string): DialogMessageCategory {
  if (matchesAny(message, LOOKUP_MESSAGE_PATTERNS.empty)) return "empty";
  if (matchesAny(message, LOOKUP_MESSAGE_PATTERNS.invalidCredentials)) return "authentication";
  if (matchesAny(message, LOOKUP_MESSAGE_PATTERNS.maintenance)) return "maintenance";
  if (/(?:입력|선택|필수|확인|형식|조회기간)/u.test(message)) return "validation";
  return "unknown";
}

function classifyConsole(message: ConsoleMessage): SanitizedConsoleEvent {
  const text = message.text();
  const type = message.type();
  if (type === "error") return { type, category: "javascript-error" };
  if (/(?:CSP|mixed content|certificate|security)/iu.test(text)) return { type, category: "security" };
  if (/(?:network|fetch|xhr|ERR_)/iu.test(text)) return { type, category: "network" };
  return { type, category: type === "log" || type === "info" ? "general" : "unknown" };
}

function sanitizeFrameEvent(event: "attached" | "navigated", frame: Frame): SanitizedFrameEvent {
  return {
    event,
    name: sanitizeIdentifier(frame.name()),
    ...sanitizeUrl(frame.url()),
    parentFramePresent: frame.parentFrame() !== null,
  };
}

export function createSanitizedResponseMetadata(input: {
  method: string;
  status: number;
  resourceType: string;
  url: string;
}): SanitizedResponseMetadata {
  return {
    method: input.method,
    status: input.status,
    resourceType: input.resourceType,
    ...sanitizeUrl(input.url),
  };
}

export function createSanitizedRequestFailure(input: {
  method: string;
  resourceType: string;
  url: string;
  failureText: string | null;
}): SanitizedRequestFailure {
  return {
    method: input.method,
    resourceType: input.resourceType,
    ...sanitizeUrl(input.url),
    failureText: sanitizeFailureText(input.failureText),
  };
}

function responseMetadata(response: Response): SanitizedResponseMetadata {
  const request = response.request();
  return createSanitizedResponseMetadata({
    method: request.method(), status: response.status(), resourceType: request.resourceType(), url: response.url(),
  });
}

function failedRequestMetadata(request: Request): SanitizedRequestFailure {
  return createSanitizedRequestFailure({
    method: request.method(), resourceType: request.resourceType(), url: request.url(),
    failureText: request.failure()?.errorText ?? null,
  });
}

async function inspectResponseBodyInMemory(response: Response, expectedOrigin: string, state: RecorderState): Promise<void> {
  const request = response.request();
  if (!RELEVANT_RESOURCE_TYPES.has(request.resourceType())) return;
  const url = sanitizeDiagnosticUrl(response.url());
  if (url === null || url.origin !== expectedOrigin) return;
  try {
    const contentType = await response.headerValue("content-type") ?? "";
    let body = await response.text();
    const classified = classifyResponseBody(body, contentType);
    if (state.responseBodies.length < MAX_EVENTS) {
      state.responseBodies.push({
        method: request.method(),
        status: response.status(),
        resourceType: request.resourceType(),
        origin: url.origin,
        pathname: url.pathname,
        ...classified.classification,
      });
    }
    if (state.resultResponseHtml === null && classified.resultHtml !== null) {
      state.resultResponseHtml = classified.resultHtml;
    }
    body = "";
  } catch {
    // Body access can fail after a navigation; sanitized metadata remains available.
  }
}

export function sanitizeDialogEvent(type: string, message: string): SanitizedDialogEvent {
  return { type, messageCategory: classifyDialogMessage(message) };
}

export function isUnexpectedDialogType(type: string): boolean {
  return type !== "alert";
}

export async function executeAfterArming<T>(arm: () => void, click: () => Promise<T>): Promise<T> {
  arm();
  return click();
}

function createRecorderState(): RecorderState {
  return {
    newPages: new Set(),
    popupPages: new Set(),
    dialogEvents: [],
    frameEvents: [],
    consoleEvents: [],
    observedResponses: [],
    failedRequests: [],
    navigationDetected: false,
    frameNavigationDetected: false,
    relevantRequestCount: 0,
    attachedFrameCount: 0,
    pageErrorCount: 0,
    crashDetected: false,
    loadEventCount: 0,
    domContentLoadedEventCount: 0,
    unexpectedDialogDetected: false,
    responseBodies: [],
    responseAnalysisTasks: [],
    resultResponseHtml: null,
  };
}

function pushBounded<T>(values: T[], value: T): void {
  if (values.length < MAX_EVENTS) values.push(value);
}

export function classifySubmitTransition(input: {
  newPageDetected: boolean;
  popupDetected: boolean;
  dialogDetected: boolean;
  navigationDetected: boolean;
  frameNavigationDetected: boolean;
  relevantRequestCount: number;
  domChanged: boolean;
}): SubmitTransitionStatus {
  if (input.popupDetected) return "popup";
  if (input.newPageDetected) return "new_page";
  if (input.dialogDetected) return "dialog";
  if (input.navigationDetected) return "same_page_navigation";
  if (input.frameNavigationDetected) return "frame_navigation";
  if (input.relevantRequestCount > 0 || input.domChanged) return "xhr_dom_update";
  return "no_transition_detected";
}

export function finalizeTransitionStatus(base: SubmitTransitionStatus, resultFound: boolean): SubmitTransitionStatus {
  return !resultFound && base !== "no_transition_detected" ? "transition_detected_result_unknown" : base;
}

export function deduplicateByIdentity<T extends object>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export async function waitForResultPageReadiness(page: Page, timeoutMs = 10_000): Promise<void> {
  if (page.url() !== "about:blank") return;
  await Promise.race([
    page.waitForURL((url) => url.toString() !== "about:blank", { timeout: timeoutMs }),
    page.locator(KB_SELECTORS.resultComponent).waitFor({ state: "attached", timeout: timeoutMs }),
  ]).catch(() => undefined);
}

async function inspectSubmitButton(submit: Locator): Promise<SubmitButtonDiagnostics> {
  const [selectorCount, visible, enabled, actionable, boundingBox] = await Promise.all([
    submit.count().catch(() => 0),
    submit.isVisible().catch(() => false),
    submit.isEnabled().catch(() => false),
    submit.click({ trial: true }).then(() => true).catch(() => false),
    submit.boundingBox().catch(() => null),
  ]);
  const attributes = await submit.evaluate((element) => {
    const input = element as HTMLInputElement;
    const form = input.form;
    return {
      type: input.type || element.getAttribute("type") || "",
      formPresent: form !== null,
      buttonFormTarget: input.formTarget ?? "",
      formTarget: form?.target ?? "",
      formTargetPresent: (form?.target ?? "") !== "",
      formAction: form?.action ?? "",
      clickHandlerPresent: element.hasAttribute("onclick") || typeof (element as HTMLElement).onclick === "function",
      activeElementTagBefore: document.activeElement?.tagName ?? "",
      activeElementIdBefore: (document.activeElement as HTMLElement | null)?.id ?? "",
    };
  });
  return {
    selectorCount,
    visible,
    enabled,
    actionable,
    boundingBox,
    type: attributes.type.slice(0, 20),
    formPresent: attributes.formPresent,
    formTargetPresent: attributes.formTargetPresent,
    buttonFormTarget: sanitizeIdentifier(attributes.buttonFormTarget),
    formTarget: sanitizeIdentifier(attributes.formTarget),
    formAction: attributes.formAction === "" ? null : sanitizeUrl(attributes.formAction),
    clickHandlerPresent: attributes.clickHandlerPresent,
    activeElementTagBefore: sanitizeIdentifier(attributes.activeElementTagBefore.toLowerCase()),
    activeElementIdBefore: sanitizeIdentifier(attributes.activeElementIdBefore),
  };
}

async function safeStructuralFingerprint(page: Page): Promise<string> {
  return page.locator("body").evaluate((body) => {
    const counts = ["div", "form", "table", "iframe", "button", "input"].map((selector) => body.querySelectorAll(selector).length);
    return counts.join(":");
  }).catch(() => "no-body");
}

async function safeFrameInventory(frame: Frame, pageIndex: number, frameIndex: number): Promise<SafeFrameInventory> {
  const base = {
    pageIndex,
    frameIndex,
    name: sanitizeIdentifier(frame.name()),
    url: sanitizeUrl(frame.url()),
    parentFramePresent: frame.parentFrame() !== null,
  };
  const body = frame.locator("body");
  if (await body.count().catch(() => 0) === 0) {
    return {
      ...base,
      bodyPresent: false,
      elements: { divs: 0, forms: 0, tables: 0, iframes: 0, buttons: 0, inputs: 0 },
      ids: [], classes: [], inputs: [], buttons: [], tableShapes: [], iframeSources: [],
    };
  }
  const inventory = await body.evaluate((root) => {
    const elements = Array.from(root.querySelectorAll("*"));
    const tables = Array.from(root.querySelectorAll("table"));
    return {
      elements: {
        divs: root.querySelectorAll("div").length,
        forms: root.querySelectorAll("form").length,
        tables: tables.length,
        iframes: root.querySelectorAll("iframe").length,
        buttons: root.querySelectorAll("button, input[type='button'], input[type='submit']").length,
        inputs: root.querySelectorAll("input").length,
      },
      ids: elements.map((element) => element.id).filter(Boolean),
      classes: elements.flatMap((element) => Array.from(element.classList)),
      inputs: Array.from(root.querySelectorAll("input")).map((input) => ({ type: input.type, id: input.id })),
      buttons: Array.from(root.querySelectorAll("button, input[type='button'], input[type='submit']")).map((element) => ({
        type: element.getAttribute("type") ?? "",
        id: element.id,
        label: element instanceof HTMLInputElement ? element.value : element.textContent ?? "",
      })),
      tableShapes: tables.map((table) => ({
        rows: table.querySelectorAll("tr").length,
        columns: table.querySelector("tr")?.querySelectorAll(":scope > th, :scope > td").length ?? 0,
        headers: Array.from(table.querySelectorAll("th")).map((header) => header.textContent ?? ""),
      })),
      iframes: Array.from(root.querySelectorAll("iframe")).map((iframe) => ({ name: iframe.name, src: iframe.src })),
    };
  });
  return {
    ...base,
    bodyPresent: true,
    elements: inventory.elements,
    ids: [...new Set(inventory.ids.map(sanitizeIdentifier).filter(Boolean))].slice(0, 100),
    classes: [...new Set(inventory.classes.map(sanitizeIdentifier).filter(Boolean))].slice(0, 100),
    inputs: inventory.inputs.slice(0, 50).map((input) => ({ type: input.type.slice(0, 20), id: sanitizeIdentifier(input.id) })),
    buttons: inventory.buttons.slice(0, 50).map((button) => ({
      type: button.type.slice(0, 20), id: sanitizeIdentifier(button.id), label: sanitizeButtonLabel(button.label),
    })),
    tableShapes: inventory.tableShapes.slice(0, 20).map((table) => ({
      rows: table.rows,
      columns: table.columns,
      headers: table.headers.map(sanitizeHeader).filter(Boolean).slice(0, 20),
    })),
    iframeSources: inventory.iframes.slice(0, 20).map((iframe) => ({
      name: sanitizeIdentifier(iframe.name),
      ...sanitizeUrl(iframe.src),
    })),
  };
}

async function safePageInventory(page: Page, pageIndex: number): Promise<SafePageInventory> {
  const frames = page.frames();
  return {
    pageIndex,
    url: sanitizeUrl(page.url()),
    title: sanitizeTitle(await page.title().catch(() => "")),
    mainFrameUrl: sanitizeUrl(page.mainFrame().url()),
    frameCount: frames.length,
    childFrameCount: Math.max(0, frames.length - 1),
    bodyPresent: await page.locator("body").count().then((count) => count > 0).catch(() => false),
  };
}

async function candidateTable(frame: Frame): Promise<Locator | null> {
  const tables = frame.locator("table:visible");
  const count = Math.min(await tables.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const table = tables.nth(index);
    const candidate = await table.evaluate((element) => {
      const header = Array.from(element.querySelectorAll("th")).map((cell) => cell.textContent ?? "").join(" ");
      const bodyRows = element.querySelectorAll("tbody tr").length || Math.max(0, element.querySelectorAll("tr").length - 1);
      const text = element.textContent ?? "";
      const headerEvidence = /(?:거래|일자|일시|날짜)/u.test(header) &&
        /(?:적요|내용|기재)/u.test(header) && /(?:입금|맡기신|받으신)/u.test(header) && /(?:출금|찾으신|지급)/u.test(header);
      const dateEvidence = /\d{4}[./-]\d{2}[./-]\d{2}/u.test(text);
      const amountEvidence = /-?\d{1,3}(?:,\d{3})*(?:\s*원)?/u.test(text);
      return headerEvidence && bodyRows > 0 && dateEvidence && amountEvidence;
    }).catch(() => false);
    if (candidate) return table;
  }
  return null;
}

async function inspectFrameForResult(frame: Frame): Promise<{ located: Omit<LocatedResult, "page" | "frame"> | null; matches: Record<string, boolean> }> {
  const matches: Record<string, boolean> = {};
  const errorVisible = await frame.locator(KB_SELECTORS.errorRegion).isVisible().catch(() => false);
  matches.errorRegion = errorVisible;
  if (errorVisible) {
    const message = await frame.locator(KB_SELECTORS.errorMessage).innerText().catch(() => "");
    if (matchesAny(message, LOOKUP_MESSAGE_PATTERNS.invalidCredentials)) {
      return { located: { locator: frame.locator(KB_SELECTORS.errorRegion), status: "invalid_credentials", source: "known-error" }, matches };
    }
    if (matchesAny(message, LOOKUP_MESSAGE_PATTERNS.maintenance)) {
      return { located: { locator: frame.locator(KB_SELECTORS.errorRegion), status: "maintenance", source: "known-error" }, matches };
    }
    return { located: null, matches };
  }

  for (let index = 0; index < KB_SELECTORS.resultComponentAlternates.length; index += 1) {
    const selector = KB_SELECTORS.resultComponentAlternates[index];
    if (selector === undefined) continue;
    const result = frame.locator(selector);
    const resultVisible = await result.isVisible().catch(() => false);
    matches[`resultComponent${index}`] = resultVisible;
    if (resultVisible) {
      const text = await result.innerText().catch(() => "");
      return {
        located: { locator: result, status: matchesAny(text, LOOKUP_MESSAGE_PATTERNS.empty) ? "empty" : "success", source: "known-result" },
        matches,
      };
    }
  }

  const alert = frame.locator("[role='alert']:visible").first();
  const alertVisible = await alert.isVisible().catch(() => false);
  matches.alert = alertVisible;
  if (alertVisible) {
    const message = await alert.innerText().catch(() => "");
    const category = classifyDialogMessage(message);
    if (category === "authentication" || category === "maintenance" || category === "empty") {
      const status: DiagnosedLookupStatus = category === "authentication"
        ? "invalid_credentials" : category === "maintenance" ? "maintenance" : "empty";
      return { located: { locator: alert, status, source: "alert" }, matches };
    }
  }

  const table = await candidateTable(frame);
  matches.heuristicTransactionTable = table !== null;
  return { located: table === null ? null : { locator: table, status: "success", source: "heuristic-table" }, matches };
}

export async function findResultAcrossPages(pages: readonly Page[], preferredPages: readonly Page[]): Promise<{
  located: LocatedResult | null;
  matches: Record<string, boolean>;
}> {
  const orderedPages = deduplicateByIdentity([...preferredPages, ...pages]);
  const matches: Record<string, boolean> = {};
  for (const page of orderedPages) {
    const pageIndex = pages.indexOf(page);
    const frames = page.frames();
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex];
      if (frame === undefined) continue;
      const inspected = await inspectFrameForResult(frame);
      for (const [name, matched] of Object.entries(inspected.matches)) {
        matches[`page${pageIndex}.frame${frameIndex}.${name}`] = matched;
      }
      if (inspected.located !== null) return { located: { page, frame, ...inspected.located }, matches };
    }
  }
  return { located: null, matches };
}

export function createLookupSubmissionTarget(
  openerPage: Page,
  pages: readonly Page[],
  locatedResult: LocatedResult | null,
): LookupSubmissionTarget | null {
  if (locatedResult === null) return null;
  const resultPageIndex = pages.indexOf(locatedResult.page);
  if (resultPageIndex < 0) {
    throw new PageStructureError("감지한 결과 Page가 BrowserContext Page 목록에 없습니다");
  }
  return {
    openerPage,
    resultPage: locatedResult.page,
    resultFrame: locatedResult.frame,
    openedNewPage: locatedResult.page !== openerPage,
    resultPageIndex,
  };
}

function attachPageListeners(page: Page, originalPage: Page, state: RecorderState, armed: () => boolean): void {
  page.on("popup", (popup) => {
    if (!armed()) return;
    state.popupPages.add(popup);
    state.newPages.add(popup);
  });
  page.on("dialog", (dialog: Dialog) => {
    if (!armed()) return;
    const event = sanitizeDialogEvent(dialog.type(), dialog.message());
    pushBounded(state.dialogEvents, event);
    if (!isUnexpectedDialogType(dialog.type())) {
      void dialog.dismiss().catch(() => undefined);
    } else {
      state.unexpectedDialogDetected = true;
      void dialog.dismiss().catch(() => undefined);
    }
  });
  page.on("frameattached", (frame) => {
    if (!armed()) return;
    state.attachedFrameCount += 1;
    pushBounded(state.frameEvents, sanitizeFrameEvent("attached", frame));
  });
  page.on("framenavigated", (frame) => {
    if (!armed()) return;
    if (frame === page.mainFrame() && page === originalPage) state.navigationDetected = true;
    else state.frameNavigationDetected = true;
    pushBounded(state.frameEvents, sanitizeFrameEvent("navigated", frame));
  });
  page.on("console", (message) => {
    if (armed()) pushBounded(state.consoleEvents, classifyConsole(message));
  });
  page.on("pageerror", () => {
    if (armed()) state.pageErrorCount += 1;
  });
  page.on("crash", () => {
    if (armed()) state.crashDetected = true;
  });
  page.on("load", () => {
    if (armed()) state.loadEventCount += 1;
  });
  page.on("domcontentloaded", () => {
    if (armed()) state.domContentLoadedEventCount += 1;
  });
}

function chooseActivePage(pages: readonly Page[], originalPage: Page, state: RecorderState, result: LocatedResult | null): Page {
  const popup = [...state.popupPages].at(-1);
  if (popup !== undefined) return popup;
  const newPage = [...state.newPages].at(-1);
  if (newPage !== undefined) return newPage;
  if (result !== null) return result.page;
  return originalPage;
}

export async function observeSubmitTransition(
  context: BrowserContext,
  originalPage: Page,
  submit: Locator,
  click: () => Promise<void>,
  timeoutMs = RESULT_DISCOVERY_TIMEOUT_MS,
  expectedInput?: ExpectedInputState,
  options: { inspectResponseMemory?: boolean; enableSubmitTracing?: boolean } = {},
): Promise<SubmitObservation> {
  const pagesBefore = context.pages();
  const framesBeforeCount = pagesBefore.reduce((total, page) => total + page.frames().length, 0);
  const originalUrlBefore = sanitizeUrl(originalPage.url());
  const inputStateBeforeSubmit = await collectInputState(originalPage, 4, expectedInput);
  const fingerprintBefore = await safeStructuralFingerprint(originalPage);
  const button = await inspectSubmitButton(submit);
  if (!button.visible || !button.enabled || !button.actionable) {
    throw new PageStructureError("조회 버튼이 안전하게 클릭 가능한 상태가 아닙니다");
  }
  const formStateBeforeSubmit = await collectFormState(originalPage);
  await Promise.allSettled(pagesBefore.flatMap((page) => page.frames().map(resetPageRuntimeDiagnostics)));
  if (options.enableSubmitTracing === true) await installSubmitFunctionTracing(originalPage.mainFrame());
  const state = createRecorderState();
  let armed = false;
  const isArmed = (): boolean => armed;
  const attachedPages = new WeakSet<Page>();
  const readinessWaits = new WeakMap<Page, Promise<void>>();
  const attach = (page: Page): void => {
    if (attachedPages.has(page)) return;
    attachedPages.add(page);
    attachPageListeners(page, originalPage, state, isArmed);
  };
  const recordNewPage = (page: Page, popup: boolean): Page => {
    state.newPages.add(page);
    if (popup) state.popupPages.add(page);
    attach(page);
    if (!readinessWaits.has(page)) {
      readinessWaits.set(page, waitForResultPageReadiness(page));
    }
    return page;
  };
  pagesBefore.forEach(attach);
  context.on("page", (page) => {
    if (!armed) return;
    recordNewPage(page, false);
  });
  context.on("request", (request) => {
    if (armed && RELEVANT_RESOURCE_TYPES.has(request.resourceType())) state.relevantRequestCount += 1;
  });
  context.on("response", (response) => {
    if (!armed) return;
    const resourceType = response.request().resourceType();
    if (RELEVANT_RESOURCE_TYPES.has(resourceType) || response.status() >= 300) {
      pushBounded(state.observedResponses, responseMetadata(response));
    }
    if (options.inspectResponseMemory === true) {
      state.responseAnalysisTasks.push(inspectResponseBodyInMemory(response, originalUrlBefore.origin, state));
    }
  });
  context.on("requestfailed", (request) => {
    if (armed) pushBounded(state.failedRequests, failedRequestMetadata(request));
  });

  // These waits are armed before the click so very fast transitions cannot be missed.
  const newPagePromise = context.waitForEvent("page", { timeout: EVENT_WINDOW_TIMEOUT_MS })
    .then((page) => recordNewPage(page, false)).catch(() => null);
  const popupPromise = originalPage.waitForEvent("popup", { timeout: EVENT_WINDOW_TIMEOUT_MS })
    .then((page) => recordNewPage(page, true)).catch(() => null);
  const navigationPromise = originalPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: EVENT_WINDOW_TIMEOUT_MS }).catch(() => null);
  await executeAfterArming(() => {
    armed = true;
  }, click);

  const deadline = Date.now() + timeoutMs;
  let locatedResult: LocatedResult | null = null;
  let knownResultSelectorMatches: Record<string, boolean> = {};
  while (Date.now() < deadline) {
    const pages = deduplicateByIdentity([...context.pages(), ...state.newPages, ...state.popupPages]);
    const found = await findResultAcrossPages(pages, [...state.popupPages, ...state.newPages]);
    knownResultSelectorMatches = { ...knownResultSelectorMatches, ...found.matches };
    if (found.located !== null) {
      locatedResult = found.located;
      break;
    }
    if (state.resultResponseHtml !== null) break;
    if (state.dialogEvents.some((event) => ["authentication", "maintenance", "empty"].includes(event.messageCategory))) break;
    await originalPage.waitForTimeout(250).catch(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
  }

  await Promise.allSettled(state.responseAnalysisTasks);

  const [newPageWait, popupWait, navigationWait] = await Promise.all([newPagePromise, popupPromise, navigationPromise]);
  if (newPageWait !== null) recordNewPage(newPageWait, false);
  if (popupWait !== null) recordNewPage(popupWait, true);
  if (navigationWait !== null) state.navigationDetected = true;
  await Promise.allSettled(state.responseAnalysisTasks);
  const pagesAfter = deduplicateByIdentity([...context.pages(), ...state.newPages, ...state.popupPages]);
  const uniqueNewPages = deduplicateByIdentity([...state.newPages, ...state.popupPages]);
  const activePage = chooseActivePage(pagesAfter, originalPage, state, locatedResult);
  await activePage.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  const fingerprintAfter = await safeStructuralFingerprint(originalPage);
  const pageInventories = await Promise.all(pagesAfter.map((page, index) => safePageInventory(page, index)));
  const frameInventories = (await Promise.all(pagesAfter.flatMap((page, pageIndex) =>
    page.frames().map((frame, frameIndex) => safeFrameInventory(frame, pageIndex, frameIndex))))).flat();
  const activePageIndex = Math.max(0, pagesAfter.indexOf(activePage));
  const target = createLookupSubmissionTarget(originalPage, pagesAfter, locatedResult);
  const resultFrameIndex = target === null ? null : target.resultPage.frames().indexOf(target.resultFrame);
  const originalTitleAfter = sanitizeTitle(await originalPage.title().catch(() => ""));
  const activeTitle = sanitizeTitle(await activePage.title().catch(() => ""));
  const inputStateAfterSubmit = await collectInputState(originalPage, 4, expectedInput);
  const formStateAfterSubmit = await collectFormState(originalPage);
  const runtime = (await Promise.all(pagesAfter.flatMap((page, pageIndex) =>
    page.frames().map(async (frame, frameIndex) => ({
      pageIndex,
      frameIndex,
      ...await collectPageRuntimeDiagnostics(frame),
    }))))).flat();
  const storage = (await Promise.all(pagesAfter.flatMap((page, pageIndex) =>
    page.frames().map(async (frame, frameIndex) => ({
      pageIndex,
      frameIndex,
      ...await collectStorageKeyDiagnostics(frame),
    }))))).flat();
  const cookieCount = (await context.cookies().catch(() => [])).length;
  const baseTransition = classifySubmitTransition({
    newPageDetected: uniqueNewPages.length > 0,
    popupDetected: state.popupPages.size > 0,
    dialogDetected: state.dialogEvents.length > 0,
    navigationDetected: state.navigationDetected,
    frameNavigationDetected: state.frameNavigationDetected || state.attachedFrameCount > 0,
    relevantRequestCount: state.relevantRequestCount,
    domChanged: fingerprintBefore !== fingerprintAfter,
  });
  const transitionStatus = finalizeTransitionStatus(baseTransition, locatedResult !== null || state.resultResponseHtml !== null);

  return {
    locatedResult,
    authenticationDialogDetected: state.dialogEvents.some((event) => event.messageCategory === "authentication"),
    unexpectedDialogDetected: state.unexpectedDialogDetected,
    diagnostics: {
      pagesBefore: pagesBefore.length,
      pagesAfter: pagesAfter.length,
      framesBefore: framesBeforeCount,
      framesAfter: pagesAfter.reduce((total, page) => total + page.frames().length, 0),
      originalPageUrlBefore: originalUrlBefore,
      originalPageUrlAfter: sanitizeUrl(originalPage.url()),
      originalPageTitleAfter: originalTitleAfter,
      newPageDetected: uniqueNewPages.length > 0,
      popupDetected: state.popupPages.size > 0,
      dialogDetected: state.dialogEvents.length > 0,
      navigationDetected: state.navigationDetected,
      frameNavigationDetected: state.frameNavigationDetected,
      attachedFrameCount: state.attachedFrameCount,
      observedResponses: state.observedResponses,
      failedRequests: state.failedRequests,
      activePageIndex,
      activePageUrl: sanitizeUrl(activePage.url()),
      activePageTitle: activeTitle,
      openedNewPage: target?.openedNewPage ?? (uniqueNewPages.length > 0),
      resultPageIndex: target?.resultPageIndex ?? null,
      resultFrameIndex,
      resultUrl: target === null ? null : sanitizeUrl(target.resultPage.url()),
      resultContainerDetected: locatedResult?.source === "known-result",
      knownResultSelectorMatches,
      parserFailure: null,
      transitionStatus,
      dialogEvents: state.dialogEvents,
      frameEvents: state.frameEvents,
      consoleEvents: state.consoleEvents,
      pageErrorCount: state.pageErrorCount,
      crashDetected: state.crashDetected,
      relevantRequestCount: state.relevantRequestCount,
      loadEventCount: state.loadEventCount,
      domContentLoadedEventCount: state.domContentLoadedEventCount,
      button,
      pages: pageInventories,
      frames: frameInventories,
      inputStateBeforeSubmit,
      inputStateAfterSubmit,
      responseBodies: state.responseBodies,
      responseResultDetected: state.resultResponseHtml !== null,
      runtime,
      cdpTargets: null,
      browserState: { cookieCount, storage },
      formStateBeforeSubmit,
      formStateAfterSubmit,
    },
    target,
    resultResponseHtml: state.resultResponseHtml,
  };
}
