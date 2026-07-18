import { describe, test, expect } from "vitest";
import {
  buildVehicleSheetMatrix,
  DEFAULT_VALUATION_HEADERS,
  type VehicleSheetRow,
} from "./vehicleSheet";

// The importer (VehicleImportDialog.parseVehicleWorksheet) treats a sheet as
// double-header only when row 2 contains one of these names, then reads every
// non-empty row-2 cell as a finance-company valuation column. These tests lock
// the exported layout to that contract so an export round-trips on re-import.
const CORE_COLUMN_COUNT = 10;

const stockRow: VehicleSheetRow = {
  make: "Toyota",
  vin: "JTDKARFU7G3529873",
  color: "White",
  mileage: 45000,
  cost: 14000,
  model: "Camry",
  year: 2022,
  sellingPrice: 18000,
  sourceType: "STOCK",
  valuationsByCompany: { "بندار": 19000 },
};

const sourcedRow: VehicleSheetRow = {
  make: "BYD",
  vin: "LJ136HBDA4P123456",
  color: "Black",
  mileage: null,
  cost: 22000,
  model: "Dolphin",
  year: 2024,
  sellingPrice: 26000,
  sourceType: "SOURCED",
  sourcedFrom: "Gulf Motors",
};

describe("buildVehicleSheetMatrix", () => {
  test("always emits the default valuation headers as the double-header trigger", () => {
    const { rows } = buildVehicleSheetMatrix([], [stockRow]);
    const [, headerRow2] = rows;
    for (const header of DEFAULT_VALUATION_HEADERS) {
      expect(headerRow2).toContain(header);
    }
    // The trigger names live in row 2, after the core columns.
    expect(headerRow2[CORE_COLUMN_COUNT]).toBe(DEFAULT_VALUATION_HEADERS[0]);
  });

  test("embeds the model year inside the Model column the way the template encodes it", () => {
    const { rows } = buildVehicleSheetMatrix([], [stockRow]);
    const dataRow = rows[2];
    expect(dataRow[5]).toBe("Camry 2022");
  });

  test("writes the Source Type and Sourced From columns", () => {
    const { rows } = buildVehicleSheetMatrix([], [stockRow, sourcedRow]);
    const [, , stock, sourced] = rows;

    // Column 9 = Source Type, column 10 = Sourced From (0-indexed 8 / 9).
    expect(stock[8]).toBe("STOCK");
    expect(sourced[8]).toBe("SOURCED");
    expect(sourced[9]).toBe("Gulf Motors");
    // A sourced car must carry its supplier cost in the Cost column.
    expect(sourced[4]).toBe(22000);
  });

  test("appends org finance companies after the defaults without duplicating them", () => {
    const rowWithCustom: VehicleSheetRow = {
      ...stockRow,
      valuationsByCompany: { "بندار": 19000, "MyBank": 21000 },
    };
    // "بندار" is a default AND passed as an org company — it must appear once.
    const { rows, companyNames } = buildVehicleSheetMatrix(["بندار", "MyBank"], [rowWithCustom]);

    expect(companyNames).toEqual([...DEFAULT_VALUATION_HEADERS, "MyBank"]);

    const headerRow2 = rows[1];
    const myBankCol = headerRow2.indexOf("MyBank");
    expect(myBankCol).toBeGreaterThan(-1);
    expect(rows[2][myBankCol]).toBe(21000);
    // Default valuation still lands in its own column.
    const bandarCol = headerRow2.indexOf("بندار");
    expect(rows[2][bandarCol]).toBe(19000);
  });

  test("leaves KM blank for a car with no mileage", () => {
    const { rows } = buildVehicleSheetMatrix([], [sourcedRow]);
    expect(rows[2][3]).toBe("");
  });
});
