import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import type { AppConfig, BankLookupConfig } from "../config/env.js";
import { KB_SELECTORS } from "../config/selectors.js";
import type { RawKbTransaction } from "../transaction/transaction.js";
import { retry } from "../utils/retry.js";
import { fillLookupForm } from "./kb-form.js";
import { enterPasswordWithKeypad } from "./kb-keypad.js";
import { parseKbTransactions, parseRawTransactionsWithDiagnostics, type TransactionRowDiagnostics } from "./kb-parser.js";
import { LookupTimeoutError, NetworkError, PageStructureError } from "./kb-errors.js";
import { captureSafeResultStructure, type SafeResultSnapshot } from "./result-diagnostics.js";
import { observeSubmitTransition, sanitizeUrl, type SubmitDiagnostics } from "./submit-diagnostics.js";
import { chromiumLaunchOptions, KB_BROWSER_CONTEXT_OPTIONS } from "./browser-mode.js";
import {
  createCdpTargetRecorder,
  installSafePageDiagnostics,
  type CdpTargetRecorder,
} from "./deep-diagnostics.js";

export type LookupStatus =
  | "success"
  | "empty"
  | "invalid_credentials"
  | "maintenance"
  | "result_page_unknown"
  | "no_submit_transition"
  | "page_structure_changed"
  | "timeout"
  | "unknown_error";

export interface KbLookupResult {
  status: LookupStatus;
  rawTransactions: RawKbTransaction[];
  currentUrl: string;
  screenTransactionCount: number;
  paginationDetected: boolean | null;
  pageCount: number;
  submitted: boolean;
  submitDiagnostics: SubmitDiagnostics | null;
  rowDiagnostics: TransactionRowDiagnostics | null;
}

export interface LookupHooks {
  onBeforeSubmit?: () => void | Promise<void>;
  onSubmitted?: () => void | Promise<void>;
  onSafeResultSnapshot?: (snapshot: SafeResultSnapshot) => void | Promise<void>;
  onSubmitDiagnostics?: (diagnostics: SubmitDiagnostics) => void | Promise<void>;
  onAfterSubmitObservation?: () => void | Promise<void>;
}

function safePageUrl(page: Page): string {
  const value = sanitizeUrl(page.url());
  return `${value.origin}${value.pathname}`;
}

interface LookupExecutionState {
  submitted: boolean;
}

const NAVIGATION_TIMEOUT_MS = 45_000;

async function clickSubmitButton(page: Page, submit: Locator, mode: AppConfig["PLAYWRIGHT_SUBMIT_CLICK_MODE"]): Promise<void> {
  if (mode === "locator") {
    await submit.click();
    return;
  }
  await submit.scrollIntoViewIfNeeded();
  const box = await submit.boundingBox();
  if (box === null || box.width <= 0 || box.height <= 0) {
    throw new PageStructureError("조회 버튼의 실제 mouse click 영역을 확인하지 못했습니다");
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function performLookup(
  page: Page,
  config: BankLookupConfig,
  hooks: LookupHooks = {},
  executionState: LookupExecutionState = { submitted: false },
  suppliedContext?: BrowserContext,
  cdpRecorder?: CdpTargetRecorder,
): Promise<KbLookupResult> {
  try {
    await retry(
      () => page.goto(config.KB_QUICK_LOOKUP_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
      {
        attempts: 2,
        initialDelayMs: 500,
        shouldRetry: (error) => error instanceof Error && /net::|timeout/iu.test(error.message),
      },
    );
  } catch (error) {
    throw new NetworkError(undefined, { cause: error });
  }
  await fillLookupForm(page, config);
  await enterPasswordWithKeypad(page, config.KB_WEB_PASSWORD);

  const submit = page.locator(KB_SELECTORS.submit);
  if (await submit.count() !== 1) {
    throw new PageStructureError("조회 버튼을 고유하게 식별하지 못했습니다");
  }
  await hooks.onBeforeSubmit?.();
  const context = suppliedContext ?? page.context();
  const observation = await observeSubmitTransition(context, page, submit, async () => {
    await clickSubmitButton(page, submit, config.PLAYWRIGHT_SUBMIT_CLICK_MODE);
    executionState.submitted = true;
    await hooks.onSubmitted?.();
  }, 45_000, {
    accountNumber: config.KB_ACCOUNT_NUMBER,
    userIdentifier: config.KB_BIRTH_DATE,
    startDate: config.KB_LOOKUP_START_DATE,
    endDate: config.KB_LOOKUP_END_DATE,
  }, {
    inspectResponseMemory: config.ENABLE_RESPONSE_MEMORY_INSPECTION,
    enableSubmitTracing: config.ENABLE_SUBMIT_TRACING,
  });
  observation.diagnostics.cdpTargets = cdpRecorder?.snapshot() ?? null;
  await hooks.onSubmitDiagnostics?.(observation.diagnostics);
  await hooks.onAfterSubmitObservation?.();
  const safeCurrentUrl = `${observation.diagnostics.activePageUrl.origin}${observation.diagnostics.activePageUrl.pathname}`;

  if (observation.authenticationDialogDetected) {
    return {
      status: "invalid_credentials",
      rawTransactions: [],
      currentUrl: safeCurrentUrl,
      screenTransactionCount: 0,
      paginationDetected: null,
      pageCount: 1,
      submitted: executionState.submitted,
      submitDiagnostics: observation.diagnostics,
      rowDiagnostics: null,
    };
  }
  if (observation.unexpectedDialogDetected) {
    return {
      status: "result_page_unknown", rawTransactions: [], currentUrl: safeCurrentUrl,
      screenTransactionCount: 0, paginationDetected: null, pageCount: 1,
      submitted: executionState.submitted, submitDiagnostics: observation.diagnostics,
      rowDiagnostics: null,
    };
  }
  const located = observation.locatedResult;
  if (located === null && observation.resultResponseHtml !== null) {
    const responseDiagnostic = observation.diagnostics.responseBodies.find((response) =>
      response.containsResultContainer && response.containsTransactionTable);
    if (responseDiagnostic?.paginationPatternDetected === true) {
      return {
        status: "page_structure_changed", rawTransactions: [], currentUrl: safeCurrentUrl,
        screenTransactionCount: 0, paginationDetected: true, pageCount: 1,
        submitted: executionState.submitted, submitDiagnostics: observation.diagnostics,
        rowDiagnostics: null,
      };
    }
    try {
      const parsed = parseRawTransactionsWithDiagnostics(observation.resultResponseHtml);
      return {
        status: parsed.transactions.length === 0 ? "empty" : "success",
        rawTransactions: parsed.transactions,
        currentUrl: safeCurrentUrl,
        screenTransactionCount: parsed.transactions.length,
        paginationDetected: false,
        pageCount: 1,
        submitted: executionState.submitted,
        submitDiagnostics: observation.diagnostics,
        rowDiagnostics: parsed.rowDiagnostics,
      };
    } catch {
      return {
        status: "page_structure_changed", rawTransactions: [], currentUrl: safeCurrentUrl,
        screenTransactionCount: 0, paginationDetected: null, pageCount: 1,
        submitted: executionState.submitted, submitDiagnostics: observation.diagnostics,
        rowDiagnostics: null,
      };
    }
  }
  if (located === null) {
    if (observation.diagnostics.responseBodies.some((response) => response.containsAuthenticationError)) {
      return {
        status: "invalid_credentials", rawTransactions: [], currentUrl: safeCurrentUrl,
        screenTransactionCount: 0, paginationDetected: null, pageCount: 1,
        submitted: executionState.submitted, submitDiagnostics: observation.diagnostics,
        rowDiagnostics: null,
      };
    }
    if (observation.diagnostics.responseBodies.some((response) => response.containsMaintenanceMessage)) {
      return {
        status: "maintenance", rawTransactions: [], currentUrl: safeCurrentUrl,
        screenTransactionCount: 0, paginationDetected: null, pageCount: 1,
        submitted: executionState.submitted, submitDiagnostics: observation.diagnostics,
        rowDiagnostics: null,
      };
    }
    return {
      status: observation.diagnostics.transitionStatus === "no_transition_detected"
        ? "no_submit_transition" : "result_page_unknown",
      rawTransactions: [], currentUrl: safeCurrentUrl, screenTransactionCount: 0,
      paginationDetected: null, pageCount: 1, submitted: executionState.submitted,
      submitDiagnostics: observation.diagnostics,
      rowDiagnostics: null,
    };
  }
  if (located.status !== "success") {
    if (located.status === "empty") {
      const emptySnapshot = await captureSafeResultStructure(located.locator);
      await hooks.onSafeResultSnapshot?.(emptySnapshot);
    }
    return {
      status: located.status,
      rawTransactions: [], currentUrl: safeCurrentUrl, screenTransactionCount: 0,
      paginationDetected: null, pageCount: 1, submitted: executionState.submitted,
      submitDiagnostics: observation.diagnostics,
      rowDiagnostics: null,
    };
  }
  const target = observation.target;
  if (target === null) {
    return {
      status: "result_page_unknown", rawTransactions: [], currentUrl: safeCurrentUrl,
      screenTransactionCount: 0, paginationDetected: null, pageCount: 1,
      submitted: executionState.submitted, submitDiagnostics: observation.diagnostics,
      rowDiagnostics: null,
    };
  }
  const resultComponent = located.source === "known-result"
    ? target.resultFrame.locator(KB_SELECTORS.resultComponent)
    : located.locator;
  const snapshot = await captureSafeResultStructure(resultComponent);
  await hooks.onSafeResultSnapshot?.(snapshot);
  if (snapshot.transactionTableIndex === null || snapshot.screenTransactionCount === null || snapshot.paginationDetected) {
    return {
      status: "page_structure_changed",
      rawTransactions: [],
      currentUrl: safeCurrentUrl,
      screenTransactionCount: snapshot.screenTransactionCount ?? 0,
      paginationDetected: snapshot.paginationDetected,
      pageCount: 1,
      submitted: executionState.submitted,
      submitDiagnostics: observation.diagnostics,
      rowDiagnostics: null,
    };
  }
  try {
    const parsed = located.source === "known-result"
      ? await parseKbTransactions(target.resultFrame, { expectedTransactionCount: snapshot.screenTransactionCount })
      : parseRawTransactionsWithDiagnostics(await resultComponent.evaluate((element) => element.outerHTML), {
          expectedTransactionCount: snapshot.screenTransactionCount,
        });
    const rawTransactions = parsed.transactions;
    return {
      status: rawTransactions.length === 0 ? "empty" : "success",
      rawTransactions,
      currentUrl: safeCurrentUrl,
      screenTransactionCount: snapshot.screenTransactionCount,
      paginationDetected: false,
      pageCount: 1,
      submitted: executionState.submitted,
      submitDiagnostics: observation.diagnostics,
      rowDiagnostics: parsed.rowDiagnostics,
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        status: "page_structure_changed",
        rawTransactions: [],
        currentUrl: safeCurrentUrl,
        screenTransactionCount: snapshot.screenTransactionCount,
        paginationDetected: snapshot.paginationDetected,
        pageCount: 1,
        submitted: executionState.submitted,
        submitDiagnostics: observation.diagnostics,
        rowDiagnostics: null,
      };
    }
    throw error;
  }
}

export async function runKbLookup(config: BankLookupConfig, hooks: LookupHooks = {}): Promise<KbLookupResult> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let cdpRecorder: CdpTargetRecorder | undefined;
  try {
    browser = await chromium.launch(chromiumLaunchOptions(config.PLAYWRIGHT_BROWSER_MODE));
    if (config.ENABLE_DEEP_DIAGNOSTICS) cdpRecorder = await createCdpTargetRecorder(browser);
    context = await browser.newContext(KB_BROWSER_CONTEXT_OPTIONS);
    if (config.ENABLE_DEEP_DIAGNOSTICS || config.ENABLE_SUBMIT_TRACING) {
      await context.addInitScript(installSafePageDiagnostics);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const executionState: LookupExecutionState = { submitted: false };
    try {
      return await performLookup(page, config, hooks, executionState, context, cdpRecorder);
    } catch (error) {
      if (error instanceof LookupTimeoutError) {
        return {
          status: "timeout",
          rawTransactions: [],
          currentUrl: safePageUrl(page),
          screenTransactionCount: 0,
          paginationDetected: null,
          pageCount: executionState.submitted ? 1 : 0,
          submitted: executionState.submitted,
          submitDiagnostics: null,
          rowDiagnostics: null,
        };
      }
      if (error instanceof PageStructureError) {
        return {
          status: "page_structure_changed",
          rawTransactions: [],
          currentUrl: safePageUrl(page),
          screenTransactionCount: 0,
          paginationDetected: null,
          pageCount: executionState.submitted ? 1 : 0,
          submitted: executionState.submitted,
          submitDiagnostics: null,
          rowDiagnostics: null,
        };
      }
      throw error;
    }
  } finally {
    await cdpRecorder?.dispose().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
