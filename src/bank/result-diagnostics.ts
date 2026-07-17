import type { Locator } from "playwright";

export interface SafeTableStructure {
  index: number;
  classes: string[];
  headers: string[];
  visibleRowCount: number;
  sampleCellCounts: number[];
  transactionCandidate: boolean;
  detailRowCount: number;
}

export interface SafeResultSnapshot {
  tables: SafeTableStructure[];
  transactionTableIndex: number | null;
  screenTransactionCount: number | null;
  paginationDetected: boolean;
  nextButtonDetected: boolean;
  moreButtonDetected: boolean;
  emptyDetected: boolean;
  sanitizedHtml: string;
}

/**
 * Captures structure only. Real transaction cell text and element attributes never
 * leave the browser context; fixture rows are replaced with synthetic values.
 */
export async function captureSafeResultStructure(result: Locator): Promise<SafeResultSnapshot> {
  return result.evaluate((root): SafeResultSnapshot => {
    const normalize = (value: string): string => Array.from(value)
      .map((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127 ? " " : character;
      })
      .join("").replace(/\s+/gu, " ").trim();
    const safeClasses = (element: Element): string[] => Array.from(element.classList)
      .filter((value) => /^[A-Za-z_-][A-Za-z0-9_-]{0,39}$/u.test(value) && !/\d{6,}/u.test(value))
      .slice(0, 8);
    const isVisibleRow = (row: Element): boolean => {
      const style = row.getAttribute("style") ?? "";
      const className = row.getAttribute("class") ?? "";
      return !row.hasAttribute("hidden") && row.getAttribute("aria-hidden") !== "true" &&
        !/display\s*:\s*none/iu.test(style) &&
        !/(?:^|\s)(?:hidden|template|sample)(?:\s|$)/iu.test(className);
    };
    const safeHeader = (value: string): string => {
      const compact = normalize(value).slice(0, 40);
      return /\d{6,}/u.test(compact) ? "" : compact;
    };
    const isTransactionHeader = (headers: readonly string[]): boolean => {
      const joined = headers.join("|");
      return /(?:\uAC70\uB798|\uB0A0\uC9DC|\uC77C\uC2DC)/u.test(joined) &&
        /(?:\uC801\uC694|\uB0B4\uC6A9|\uAE30\uC7AC)/u.test(joined) &&
        /(?:\uCD9C\uAE08|\uCC3E\uC73C\uC2E0|\uC9C0\uAE09)/u.test(joined) &&
        /(?:\uC785\uAE08|\uB9E1\uAE30\uC2E0|\uBC1B\uC73C\uC2E0)/u.test(joined);
    };
    const isExplicitEmptyText = (value: string): boolean => /(?:거래\s*내역이|조회된\s*내역이|조회\s*결과가|조회하실\s*내역이)\s*없/iu.test(normalize(value));
    const placeholderFor = (header: string, rowIndex: number): string => {
      if (/(?:\uC77C\uC2DC|\uB0A0\uC9DC|\uAC70\uB798\uC77C)/u.test(header)) return "2026-07-15";
      if (/\uC2DC\uAC04/u.test(header)) return "14:30";
      if (/(?:\uAD6C\uBD84|\uC720\uD615)/u.test(header)) return rowIndex % 2 === 0 ? "\uC785\uAE08" : "\uCD9C\uAE08";
      if (/(?:\uC801\uC694|\uB0B4\uC6A9|\uAE30\uC7AC)/u.test(header)) return rowIndex % 2 === 0 ? "\uD14C\uC2A4\uD2B8\uC785\uAE08" : "\uD14C\uC2A4\uD2B8\uCD9C\uAE08";
      if (/\uBA54\uBAA8/u.test(header)) return "\uD14C\uC2A4\uD2B8\uBA54\uBAA8";
      if (/(?:\uCD9C\uAE08|\uCC3E\uC73C\uC2E0|\uC9C0\uAE09)/u.test(header)) return rowIndex % 2 === 0 ? "" : "5000";
      if (/(?:\uC785\uAE08|\uB9E1\uAE30\uC2E0|\uBC1B\uC73C\uC2E0)/u.test(header)) return rowIndex % 2 === 0 ? "10000" : "";
      if (/\uC794\uC561/u.test(header)) return "50000";
      if (/(?:\uCDE8\uAE09\uC810|\uAC70\uB798\uC810|\uC9C0\uC810)/u.test(header)) return "\uD14C\uC2A4\uD2B8\uC9C0\uC810";
      return "\uD14C\uC2A4\uD2B8";
    };
    const escapeHtml = (value: string): string => value
      .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

    const tables = [
      ...(root.matches("table") ? [root as HTMLTableElement] : []),
      ...Array.from(root.querySelectorAll("table")),
    ];
    const structures: SafeTableStructure[] = tables.map((table, index) => {
      const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
      const headers = headerRow === null
        ? []
        : Array.from(headerRow.querySelectorAll(":scope > th, :scope > td")).map((cell) => safeHeader(cell.textContent ?? ""));
      const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
      const allRows = (bodyRows.length > 0 ? bodyRows : Array.from(table.querySelectorAll("tr")))
        .filter((row) => row !== headerRow && isVisibleRow(row) && !isExplicitEmptyText(row.textContent ?? ""));
      const transactionCandidate = isTransactionHeader(headers);
      const rows = transactionCandidate
        ? allRows.filter((row) => row.querySelectorAll(":scope > td").length === headers.length)
        : allRows;
      return {
        index,
        classes: safeClasses(table),
        headers,
        visibleRowCount: rows.length,
        sampleCellCounts: allRows.slice(0, 5).map((row) => row.querySelectorAll(":scope > td").length),
        transactionCandidate,
        detailRowCount: transactionCandidate ? allRows.length - rows.length : 0,
      };
    });
    const candidates = structures.filter((table) => table.transactionCandidate);
    const transactionTable = candidates.length === 1 ? candidates[0] : undefined;
    const emptyDetected = isExplicitEmptyText(root.textContent ?? "");

    const controls = Array.from(root.querySelectorAll("button, a, input[type='button'], input[type='submit']"));
    const controlLabel = (element: Element): string => normalize(
      element.getAttribute("aria-label") ?? element.getAttribute("title") ??
      (element instanceof HTMLInputElement ? element.value : element.textContent ?? ""),
    ).slice(0, 30);
    const nextButtonDetected = controls.some((element) => /^(?:\uB2E4\uC74C|next|>|\u203A)$/iu.test(controlLabel(element)));
    const moreButtonDetected = controls.some((element) => /(?:\uB354\uBCF4\uAE30|more)/iu.test(controlLabel(element)));
    const paginationDetected = nextButtonDetected || moreButtonDetected ||
      root.querySelector("[class*='paging' i], [class*='pagination' i], [aria-label*='page' i]") !== null;

    const sanitizedTables = structures.map((structure) => {
      const table = tables[structure.index];
      if (table === undefined) return "";
      const classAttribute = structure.classes.length === 0 ? "" : ` class="${structure.classes.map(escapeHtml).join(" ")}"`;
      const headers = structure.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
      const sourceRows = Array.from(table.querySelectorAll("tbody tr"));
      let visibleRows = (sourceRows.length > 0 ? sourceRows : Array.from(table.querySelectorAll("tr")))
        .filter((row) => row !== (table.querySelector("thead tr") ?? table.querySelector("tr")) &&
          isVisibleRow(row) && !isExplicitEmptyText(row.textContent ?? ""));
      if (structure.transactionCandidate) {
        visibleRows = visibleRows.filter((row) => row.querySelectorAll(":scope > td").length === structure.headers.length);
      }
      visibleRows = visibleRows.slice(0, 2);
      if (structure.transactionCandidate && emptyDetected) {
        return `<table${classAttribute}><thead><tr>${headers}</tr></thead><tbody><tr><td colspan="${Math.max(1, structure.headers.length)}">조회하실 내역이 없습니다.</td></tr></tbody></table>`;
      }
      const sampleCount = Math.min(2, Math.max(0, visibleRows.length));
      const rows = Array.from({ length: sampleCount }, (_, rowIndex) => {
        const sourceCellCount = visibleRows[rowIndex]?.querySelectorAll(":scope > td").length ?? structure.headers.length;
        const cells = Array.from({ length: sourceCellCount }, (_unused, cellIndex) =>
          `<td>${escapeHtml(placeholderFor(structure.headers[cellIndex] ?? "", rowIndex))}</td>`).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      return `<table${classAttribute}><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    }).join("");

    return {
      tables: structures,
      transactionTableIndex: transactionTable?.index ?? null,
      screenTransactionCount: transactionTable?.visibleRowCount ?? null,
      paginationDetected,
      nextButtonDetected,
      moreButtonDetected,
      emptyDetected,
      sanitizedHtml: `<section data-fixture="${emptyDetected ? "kb-result-empty" : "kb-result-success"}">${sanitizedTables}</section>`,
    };
  });
}
