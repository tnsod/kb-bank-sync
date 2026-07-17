import { pino, type DestinationStream, type Logger } from "pino";

import type { AppConfig } from "../config/env.js";

export function createLogger(
  config: Pick<AppConfig, "LOG_LEVEL">,
  destination: DestinationStream = pino.destination(2),
): Logger {
  return pino(
    {
      level: config.LOG_LEVEL,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "password",
          "webPassword",
          "KB_WEB_PASSWORD",
          "accountNumber",
          "KB_ACCOUNT_NUMBER",
          "birthDate",
          "KB_BIRTH_DATE",
          "transactions",
          "rawTransactions",
        ],
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}
