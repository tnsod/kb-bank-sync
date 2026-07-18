import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { TransactionParseError } from "../bank/kb-errors.js";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

const CONTROL_CHARACTERS = /\p{Cc}/gu;
const KOREA_TIMEZONE = "Asia/Seoul";
const DATE_TIME_FORMATS = [
  "YYYY-MM-DD HH:mm:ss",
  "YYYY.MM.DD HH:mm:ss",
  "YYYY/MM/DD HH:mm:ss",
  "YYYY-MM-DD HH:mm",
  "YYYY.MM.DD HH:mm",
  "YYYY/MM/DD HH:mm",
  "YYYYMMDD HHmmss",
] as const;

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
}

export function normalizeNullableText(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  return normalized === "" ? null : normalized;
}

export function normalizeMoney(value: string, options: { nullable?: boolean } = {}): number | null {
  const normalized = normalizeText(value);
  if (normalized === "" || normalized === "-") {
    return options.nullable === true ? null : 0;
  }

  let compact = normalized.replace(/[원,\s]/gu, "");
  let negative = false;
  if (/^\(.*\)$/u.test(compact)) {
    negative = true;
    compact = compact.slice(1, -1);
  }
  if (compact.endsWith("-") && !compact.startsWith("-")) {
    negative = true;
    compact = compact.slice(0, -1);
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(compact)) {
    throw new TransactionParseError("금액 문자열을 숫자로 변환할 수 없습니다", {
      parserErrorCode: options.nullable === true ? "INVALID_BALANCE" : "INVALID_AMOUNT",
      parserStage: options.nullable === true ? "balance_normalization" : "amount_normalization",
    });
  }

  const parsed = Number(compact);
  const result = negative ? -Math.abs(parsed) : parsed;
  if (!Number.isFinite(result)) {
    throw new TransactionParseError("금액이 유한한 숫자가 아닙니다", {
      parserErrorCode: options.nullable === true ? "INVALID_BALANCE" : "INVALID_AMOUNT",
      parserStage: options.nullable === true ? "balance_normalization" : "amount_normalization",
    });
  }
  return result;
}

export function normalizeOccurredAt(dateText: string, timeText: string): string {
  const date = normalizeText(dateText);
  const time = normalizeText(timeText) || "00:00:00";
  const combined = `${date} ${time}`;

  for (const format of DATE_TIME_FORMATS) {
    const strictParsed = dayjs(combined, format, true);
    if (strictParsed.isValid()) {
      const parsedInKorea = dayjs.tz(strictParsed.format("YYYY-MM-DD HH:mm:ss"), "YYYY-MM-DD HH:mm:ss", KOREA_TIMEZONE);
      return parsedInKorea.format("YYYY-MM-DDTHH:mm:ssZ");
    }
  }
  throw new TransactionParseError("거래 일시를 한국 시간대로 변환할 수 없습니다", {
    parserErrorCode: "INVALID_TRANSACTION_DATE",
    parserStage: "date_normalization",
  });
}

export function nowInKorea(): string {
  return dayjs().tz(KOREA_TIMEZONE).format("YYYY-MM-DDTHH:mm:ssZ");
}
