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
    expect(source).toContain('pattern: "yyyy-MM-dd HH:mm:ss"');
    expect(source).toContain('endColumnIndex: 12');
    expect(source).toContain('range: bodyRange(0, 12)');
    expect(source).toContain('foregroundColorStyle: { rgbColor: { red: 0, green: 0, blue: 0 } }');
    expect(source).toContain('bold: false, italic: false, strikethrough: false, underline: false');
    expect(source).toContain('range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 }');
    expect(source).toContain('foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } }');
    expect(source).toContain('pattern: "#,##0;-#,##0"');
    expect(source).not.toContain("[Red]");
    expect(source).toContain('value: "입금"');
    expect(source).toContain('value: "출금"');
    expect(source).toContain('value: "기타"');
    expect(source).toContain("deleteConditionalFormatRule");
    expect(source).toContain("managedConditionalRulesAreExact");
    expect(source).toContain("range.endRowIndex === sheet.properties?.gridProperties?.rowCount");
    expect(source).toContain("conditionalFormatRuleCount: conditionalFormats.length");
    expect(source).toContain('range: bodyRange(9, 10)');
    expect(source).toContain('range: bodyRange(10, 11)');
    expect(source).toContain('range: bodyRange(11, 12)');
    expect(source).toContain('type: "TEXT", pattern: "@"');
    expect(source).toContain('insertDataOption: "OVERWRITE"');
    expect(source).not.toContain('insertDataOption: "INSERT_ROWS"');
    expect(source).toContain("[170, 170, 110, 170, 140, 150, 230, 150, 230]");
  });
});
