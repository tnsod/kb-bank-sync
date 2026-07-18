import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import type { Logger } from "pino";

import type { CliOptions } from "../config/cli.js";
import type { AppConfig } from "../config/env.js";
import type { LookupHooks } from "./kb-client.js";
import type { SafeResultSnapshot } from "./result-diagnostics.js";
import type { SubmitDiagnostics } from "./submit-diagnostics.js";

async function ensureOutputDirectory(): Promise<string> {
  const outputDirectory = path.resolve("output");
  await mkdir(outputDirectory, { recursive: true });
  return outputDirectory;
}

async function writeSanitizedSnapshot(snapshot: SafeResultSnapshot): Promise<void> {
  const outputDirectory = await ensureOutputDirectory();
  const { sanitizedHtml, ...structure } = snapshot;
  const fixtureName = snapshot.emptyDetected ? "kb-result-empty.html" : "kb-result-success.html";
  await Promise.all([
    writeFile(path.join(outputDirectory, fixtureName), `${sanitizedHtml}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(path.join(outputDirectory, "result-structure.json"), `${JSON.stringify(structure, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
  ]);
}

async function writeSubmitDiagnostics(diagnostics: SubmitDiagnostics): Promise<void> {
  const outputDirectory = await ensureOutputDirectory();
  await writeFile(path.join(outputDirectory, "submit-diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600,
  });
}

async function pauseUntilUserExit(): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await terminal.question("진단 화면 확인 후 Enter를 누르면 브라우저를 종료합니다. 민감정보를 복사하지 마십시오.\n");
  } finally {
    terminal.close();
  }
}

export function createLookupHooks(config: AppConfig, cli: CliOptions, logger: Logger): LookupHooks {
  return {
    onBeforeSubmit: () => logger.info({ stage: "lookup-submit", keypadValidated: true, enteredLengthValidated: true }),
    onDiagnosticFailure: (failure) => logger.warn({
      event: "diagnostic_write_failed",
      diagnostic: failure.hook,
      diagnosticPath: failure.hook === "submit_diagnostics"
        ? "output/submit-diagnostics.json"
        : "output/result-structure.json",
      errorCode: failure.errorCode,
      errorType: failure.errorType,
    }, "Optional diagnostic output could not be written"),
    ...(cli.captureSanitizedFixture ? { onSafeResultSnapshot: writeSanitizedSnapshot } : {}),
    ...((cli.diagnoseSubmit || config.ENABLE_SUBMIT_TRACING) ? { onSubmitDiagnostics: writeSubmitDiagnostics } : {}),
    ...(cli.pauseAfterSubmit ? { onAfterSubmitObservation: pauseUntilUserExit } : {}),
  };
}
