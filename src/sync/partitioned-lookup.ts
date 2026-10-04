import dayjs from "dayjs";
import type { Logger } from "pino";

import { runKbLookup, type KbLookupResult, type LookupHooks } from "../bank/kb-client.js";
import type { BankLookupConfig } from "../config/env.js";

export interface LookupPartition {
  startDate: string;
  endDate: string;
  result: KbLookupResult;
}

export async function runPartitionedLookup(
  config: BankLookupConfig,
  lookup: typeof runKbLookup = runKbLookup,
  hooks?: LookupHooks,
  logger?: Logger,
): Promise<LookupPartition[]> {
  const result = await lookup(config, hooks);
  const startDate = config.KB_LOOKUP_START_DATE;
  const endDate = config.KB_LOOKUP_END_DATE;
  // Only an explicitly detected paginated result allows a smaller read query.
  // Authentication, unknown DOM and a paginated single day still fail closed.
  if (result.status !== "page_structure_changed" || result.paginationDetected !== true || startDate === endDate) {
    return [{ startDate, endDate, result }];
  }
  logger?.info({ event: "lookup_range_partitioned", startDate, endDate }, "Paginated lookup split into smaller date ranges");
  const start = dayjs(startDate);
  const middle = start.add(Math.floor(dayjs(endDate).diff(start, "day") / 2), "day");
  const first = await runPartitionedLookup({
    ...config, KB_LOOKUP_END_DATE: middle.format("YYYY-MM-DD"),
  }, lookup, hooks, logger);
  if (first.some((partition) => !["success", "empty"].includes(partition.result.status))) return first;
  const second = await runPartitionedLookup({
    ...config, KB_LOOKUP_START_DATE: middle.add(1, "day").format("YYYY-MM-DD"),
  }, lookup, hooks, logger);
  return [...first, ...second];
}
