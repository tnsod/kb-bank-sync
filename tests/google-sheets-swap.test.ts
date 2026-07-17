import { beforeEach, describe, expect, it, vi } from "vitest";

const googleMocks = vi.hoisted(() => ({
  batchUpdate: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    sheets: () => ({
      spreadsheets: {
        batchUpdate: googleMocks.batchUpdate,
        developerMetadata: { search: vi.fn() },
        values: {},
      },
    }),
  },
}));

import { GoogleSheetsClient } from "../src/spreadsheet/google-sheets-client.js";

interface UpdateCellsRequest {
  updateCells: {
    range: Record<string, number>;
    rows: Array<{ values: unknown[] }>;
  };
}

interface CreateMetadataRequest {
  createDeveloperMetadata: { developerMetadata: Record<string, unknown> };
}

interface AtomicBatchBody {
  requests: [UpdateCellsRequest, UpdateCellsRequest, CreateMetadataRequest];
}

describe("Google Sheets B/G atomic update", () => {
  beforeEach(() => {
    googleMocks.batchUpdate.mockReset().mockResolvedValue({ data: {} });
  });

  it("sends both column swaps and version creation in one batchUpdate request", async () => {
    const client = new GoogleSheetsClient({} as never, "spreadsheet", "거래내역");
    await client.swapCounterpartyDescriptionColumns({
      sheetId: 7,
      rows: [
        [1, "349", "입금", "기관", 1000, 10000, "빛쌤", "증빙", "비고", "KB-1234", "collected", "key-a"],
        [2, "", "출금", "기관", -100, 9900, "적요", "증빙", "비고", "KB-1234", "collected", "key-b"],
      ],
      metadataKey: "kb_bank_sync_layout_mapping_version",
      metadataValue: "2",
      existingMetadataId: null,
    });

    expect(googleMocks.batchUpdate).toHaveBeenCalledOnce();
    const call = googleMocks.batchUpdate.mock.calls[0]?.[0] as unknown as { requestBody: AtomicBatchBody };
    const requestBody = call.requestBody;
    expect(requestBody.requests).toHaveLength(3);
    expect(requestBody.requests[0].updateCells.range).toMatchObject({
      sheetId: 7, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 2,
    });
    expect(requestBody.requests[0].updateCells.rows.map((row) => row.values)).toEqual([
      [{ userEnteredValue: { stringValue: "빛쌤" } }],
      [{ userEnteredValue: { stringValue: "적요" } }],
    ]);
    expect(requestBody.requests[1].updateCells.range).toMatchObject({ startColumnIndex: 6, endColumnIndex: 7 });
    expect(requestBody.requests[1].updateCells.rows.map((row) => row.values)).toEqual([
      [{ userEnteredValue: { stringValue: "349" } }],
      [{ userEnteredValue: { stringValue: "" } }],
    ]);
    expect(requestBody.requests[2].createDeveloperMetadata.developerMetadata).toMatchObject({
      metadataKey: "kb_bank_sync_layout_mapping_version", metadataValue: "2", visibility: "DOCUMENT", location: { sheetId: 7 },
    });
  });
});
