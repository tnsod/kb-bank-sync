import { ConfigurationError } from "../bank/kb-errors.js";

export interface CliOptions {
  dryRun?: true;
  initializeSheet: boolean;
  migrateSheetLayout: boolean;
  swapCounterpartyDescription: boolean;
  captureSanitizedFixture: boolean;
  diagnoseSubmit: boolean;
  headed: boolean;
  pauseAfterSubmit: boolean;
  from?: string;
  to?: string;
}

function readValue(argumentsList: readonly string[], index: number, name: string): { value: string; consumed: number } {
  const argument = argumentsList[index];
  if (argument === undefined) throw new ConfigurationError(`--${name} 인수를 읽지 못했습니다`);
  const inlinePrefix = `--${name}=`;
  if (argument.startsWith(inlinePrefix)) {
    const value = argument.slice(inlinePrefix.length);
    if (value === "") throw new ConfigurationError(`--${name} 값이 비어 있습니다`);
    return { value, consumed: 1 };
  }
  const value = argumentsList[index + 1];
  if (value === undefined || value.startsWith("--")) throw new ConfigurationError(`--${name} 값이 필요합니다`);
  return { value, consumed: 2 };
}

export function parseCliOptions(argumentsList: readonly string[]): CliOptions {
  let dryRun: true | undefined;
  let initializeSheet = false;
  let migrateSheetLayout = false;
  let swapCounterpartyDescription = false;
  let from: string | undefined;
  let to: string | undefined;
  let captureSanitizedFixture = false;
  let diagnoseSubmit = false;
  let headed = false;
  let pauseAfterSubmit = false;
  for (let index = 0; index < argumentsList.length;) {
    const argument = argumentsList[index];
    if (argument === "--dry-run") {
      dryRun = true;
      index += 1;
      continue;
    }
    if (argument === "--initialize-sheet") {
      initializeSheet = true;
      index += 1;
      continue;
    }
    if (argument === "--migrate-sheet-layout") {
      migrateSheetLayout = true;
      index += 1;
      continue;
    }
    if (argument === "--swap-counterparty-description") {
      swapCounterpartyDescription = true;
      index += 1;
      continue;
    }
    if (argument === "--capture-sanitized-fixture") {
      captureSanitizedFixture = true;
      index += 1;
      continue;
    }
    if (argument === "--diagnose-submit") {
      diagnoseSubmit = true;
      index += 1;
      continue;
    }
    if (argument === "--headed") {
      headed = true;
      index += 1;
      continue;
    }
    if (argument === "--pause-after-submit") {
      pauseAfterSubmit = true;
      index += 1;
      continue;
    }
    if (argument === "--from" || argument?.startsWith("--from=") === true) {
      const parsed = readValue(argumentsList, index, "from");
      from = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (argument === "--to" || argument?.startsWith("--to=") === true) {
      const parsed = readValue(argumentsList, index, "to");
      to = parsed.value;
      index += parsed.consumed;
      continue;
    }
    throw new ConfigurationError(`지원하지 않는 명령행 인수입니다: ${argument ?? ""}`);
  }
  if (pauseAfterSubmit && !headed) {
    throw new ConfigurationError("--pause-after-submit은 --headed와 함께 사용해야 합니다");
  }
  if (initializeSheet && (from !== undefined || to !== undefined)) {
    throw new ConfigurationError("--initialize-sheet은 --from 또는 --to와 함께 사용할 수 없습니다");
  }
  if (initializeSheet && migrateSheetLayout) {
    throw new ConfigurationError("--initialize-sheet와 --migrate-sheet-layout은 함께 사용할 수 없습니다");
  }
  if (swapCounterpartyDescription && (initializeSheet || migrateSheetLayout || dryRun === true || from !== undefined || to !== undefined
    || headed || pauseAfterSubmit || diagnoseSubmit || captureSanitizedFixture)) {
    throw new ConfigurationError("--swap-counterparty-description은 다른 실행 또는 진단 옵션과 함께 사용할 수 없습니다");
  }
  if (migrateSheetLayout && (dryRun === true || from !== undefined || to !== undefined || headed || pauseAfterSubmit || diagnoseSubmit || captureSanitizedFixture)) {
    throw new ConfigurationError("--migrate-sheet-layout은 일반 동기화 또는 진단 옵션과 함께 사용할 수 없습니다");
  }
  return {
    ...(dryRun === undefined ? {} : { dryRun }),
    initializeSheet,
    migrateSheetLayout,
    swapCounterpartyDescription,
    captureSanitizedFixture,
    diagnoseSubmit,
    headed,
    pauseAfterSubmit,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}
