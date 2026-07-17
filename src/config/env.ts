import "dotenv/config";

import { z } from "zod";

import { ConfigurationError } from "../bank/kb-errors.js";
import { parseSpreadsheetId, stripOptionalQuotes } from "../spreadsheet/google-config.js";
import { SyncError } from "../sync/sync-errors.js";

const strictBoolean = (defaultValue: boolean) => z
  .enum(["true", "false"])
  .default(String(defaultValue) as "true" | "false")
  .transform((value) => value === "true");

const integerSetting = (defaultValue: number, minimum: number, maximum: number) => z
  .string()
  .default(String(defaultValue))
  .refine(
    (value) => /^\d+$/u.test(value) && Number(value) >= minimum && Number(value) <= maximum,
    `${minimum} 이상 ${maximum} 이하의 정수여야 합니다`,
  )
  .transform(Number);

const optionalString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const envSchema = z
  .object({
    KB_QUICK_LOOKUP_URL: z.string().url().refine(
      (value) => new URL(value).protocol === "https:",
      "HTTPS URL이어야 합니다",
    ),
    KB_ACCOUNT_NUMBER: z.string().regex(/^\d{10,16}$/, "하이픈 없는 숫자 10~16자리여야 합니다"),
    KB_BIRTH_DATE: z.string().regex(/^(\d{6}|\d{10})$/, "생년월일 6자리 또는 사업자번호 10자리여야 합니다"),
    KB_WEB_PASSWORD: z.string().regex(/^\d{4}$/, "빠른조회 계좌비밀번호는 숫자 4자리여야 합니다"),
    KB_LOOKUP_START_DATE: optionalString,
    KB_LOOKUP_END_DATE: optionalString,
    GOOGLE_SPREADSHEET_ID: z.string().trim().min(1, "필수 값입니다"),
    GOOGLE_SHEET_NAME: z.string().trim().min(1).default("거래내역"),
    GOOGLE_SERVICE_ACCOUNT_KEY_PATH: z.string().trim().min(1, "필수 값입니다"),
    SYNC_OVERLAP_DAYS: integerSetting(3, 0, 183),
    INITIAL_LOOKBACK_MONTHS: integerSetting(6, 1, 6),
    DRY_RUN: strictBoolean(true),
    ENABLE_SHEETS_WRITE: strictBoolean(false),
    ENABLE_DEEP_DIAGNOSTICS: strictBoolean(false),
    ENABLE_RESPONSE_MEMORY_INSPECTION: strictBoolean(false),
    ENABLE_SUBMIT_TRACING: strictBoolean(false),
    PLAYWRIGHT_BROWSER_MODE: z.enum(["default-headless", "new-headless", "headed"]),
    PLAYWRIGHT_SUBMIT_CLICK_MODE: z.enum(["locator", "mouse"]).default("locator"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    TZ: z.literal("Asia/Seoul").default("Asia/Seoul"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  });

export type AppConfig = z.infer<typeof envSchema>;
export type BankLookupConfig = AppConfig & {
  KB_LOOKUP_START_DATE: string;
  KB_LOOKUP_END_DATE: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const missingGoogle = ["GOOGLE_SPREADSHEET_ID", "GOOGLE_SERVICE_ACCOUNT_KEY_PATH"]
    .filter((name) => typeof environment[name] !== "string" || environment[name]?.trim() === "");
  if (missingGoogle.length > 0) {
    throw new SyncError("GOOGLE_ENV_MISSING", `필수 Google 환경변수가 없습니다: ${missingGoogle.join(", ")}`);
  }
  const spreadsheet = parseSpreadsheetId(environment.GOOGLE_SPREADSHEET_ID ?? "");
  const result = envSchema.safeParse({
    ...environment,
    GOOGLE_SPREADSHEET_ID: spreadsheet.id,
    GOOGLE_SERVICE_ACCOUNT_KEY_PATH: stripOptionalQuotes(environment.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? ""),
  });
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new ConfigurationError(`환경변수 검증 실패: ${fields}`);
  }
  return result.data;
}
