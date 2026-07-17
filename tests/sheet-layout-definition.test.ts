import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Google Sheets user layout definition", () => {
  it("defines the filter, frozen header, hidden J:L, banding, validation, and formats", async () => {
    const source = await readFile("src/spreadsheet/google-sheets-client.ts", "utf8");
    expect(source).toContain("frozenRowCount: 1");
    expect(source).toContain('dimension: "COLUMNS", startIndex: 9, endIndex: 12');
    expect(source).toContain("setBasicFilter");
    expect(source).toContain("addBanding");
    expect(source).toContain("setDataValidation");
    expect(source).toContain('type: "ONE_OF_LIST"');
    expect(source).toContain('pattern: "yyyy.mm.dd hh:mm:ss"');
    expect(source).toContain('pattern: "#,##0;[Red]-#,##0"');
    expect(source).toContain('value: "입금"');
    expect(source).toContain('value: "출금"');
    expect(source).toContain('value: "기타"');
    expect(source).toContain("[170, 170, 110, 170, 140, 150, 230, 150, 230]");
  });
});
