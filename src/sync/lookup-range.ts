import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import { ConfigurationError } from "../bank/kb-errors.js";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

export interface LookupRange {
  startDate: string;
  endDate: string;
  minimumAllowedDate: string;
  todayKst: string;
}

export interface LookupRangeOptions {
  latestOccurredAt: string | null;
  overlapDays: number;
  initialLookbackMonths: number;
  from?: string;
  to?: string;
  now?: string | Date;
}

function parseDate(value: string, field: string) {
  const parsed = dayjs(value, "YYYY-MM-DD", true);
  if (!parsed.isValid()) throw new ConfigurationError(`${field}은 YYYY-MM-DD 형식의 유효한 날짜여야 합니다`);
  return parsed;
}

export function calculateLookupRange(options: LookupRangeOptions): LookupRange {
  const now = options.now === undefined ? dayjs() : dayjs(options.now);
  if (!now.isValid()) throw new ConfigurationError("실행 시각이 유효하지 않습니다");
  const todayKst = now.tz("Asia/Seoul").format("YYYY-MM-DD");
  const today = parseDate(todayKst, "실행 당일");
  const minimum = today.subtract(options.initialLookbackMonths, "month");

  let calculatedStart = minimum;
  if (options.latestOccurredAt !== null) {
    const latest = dayjs(options.latestOccurredAt);
    if (!latest.isValid()) throw new ConfigurationError("시트 최신 거래일이 유효하지 않습니다");
    const requested = parseDate(latest.tz("Asia/Seoul").format("YYYY-MM-DD"), "최신 거래일")
      .subtract(options.overlapDays, "day");
    calculatedStart = requested.isBefore(minimum, "day") ? minimum : requested;
  }

  const start = options.from === undefined ? calculatedStart : parseDate(options.from, "조회 시작일");
  const end = options.to === undefined ? today : parseDate(options.to, "조회 종료일");
  if (start.isAfter(end, "day")) throw new ConfigurationError("조회 시작일은 종료일보다 늦을 수 없습니다");
  if (end.isAfter(today, "day")) throw new ConfigurationError(`조회 종료일은 실행 당일 KST(${todayKst})보다 미래일 수 없습니다`);
  if (start.isBefore(minimum, "day")) {
    throw new ConfigurationError(`조회 시작일은 실행 당일 KST 기준 허용 하한(${minimum.format("YYYY-MM-DD")})보다 이를 수 없습니다`);
  }
  return {
    startDate: start.format("YYYY-MM-DD"),
    endDate: end.format("YYYY-MM-DD"),
    minimumAllowedDate: minimum.format("YYYY-MM-DD"),
    todayKst,
  };
}
