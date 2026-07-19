import { describe, test, expect } from "vitest";
import {
  buildVehicleSheetMatrix,
  DEFAULT_VALUATION_HEADERS,
  type VehicleSheetRow,
} from "./vehicleSheet";

// The template is a single header row: the core columns followed by one column
// per finance-program valuation. The importer treats any header after the core
// columns as a valuation, so these tests lock that layout in place so an export
// round-trips on re-import.
const CORE_COLUMN_COUNT = 9;

const stockRow: VehicleSheetRow = {
  make: "Toyota",
  vin: "",
  color: "White",
  mileage: 45000,
  cost: 14000,
  sellingPrice: 18000,
  model: "Camry",
  year: 2022,
  sourceType: "STOCK",
  valuationsByCompany: { [DEFAULT_VALUATION_HEADERS[0]]: 19000 },
};

const sourcedRow: VehicleSheetRow = {
  make: "BYD",
  vin: "LJ136HBDA4P123456",
  color: "Black",
  mileage: null,
  cost: 22000,
  sellingPrice: 26000,
  model: "Dolphin",
  year: 2024,
  sourceType: "SOURCED",
  sourcedFrom: "Gulf Motors",
};

describe("buildVehicleSheetMatrix", () => {
  test("emits a single header row with the default valuation columns after the core columns", () => {
    const { rows } = buildVehicleSheetMatrix([], [stockRow]);
    const [headerRow] = rows;
    for (const header of DEFAULT_VALUATION_HEADERS) {
      expect(headerRow).toContain(header);
    }
    // First valuation column sits immediately after the core columns.
    expect(headerRow[CORE_COLUMN_COUNT]).toBe(DEFAULT_VALUATION_HEADERS[0]);
    // Data starts on the second row (no second header row).
    expect(rows.length).toBe(2);
  });

  test("embeds the model year inside the Model column the way the template encodes it", () => {
    const { rows } = buildVehicleSheetMatrix([], [stockRow]);
    const dataRow = rows[1];
    expect(dataRow[6]).toBe("Camry 2022");
  });

  test("writes Cost and Selling Price as distinct adjacent columns", () => {
    const { rows } = buildVehicleSheetMatrix([], [stockRow]);
    const [headerRow, dataRow] = rows;
    expect(headerRow[4]).toBe("Cost");
    expect(headerRow[5]).toBe("Selling Price");
    expect(dataRow[4]).toBe(14000);
    expect(dataRow[5]).toBe(18000);
  });

  test("writes the Source Type and Sourced From columns right after Model", () => {
    const { rows } = buildVehicleSheetMatrix([], [stockRow, sourcedRow]);
    const [, stock, sourced] = rows;

    // Column 8 = Source Type, column 9 = Sourced From (0-indexed 7 / 8).
    expect(stock[7]).toBe("STOCK");
    expect(sourced[7]).toBe("SOURCED");
    expect(sourced[8]).toBe("Gulf Motors");
    // A sourced car must carry its supplier cost in the Cost column.
    expect(sourced[4]).toBe(22000);
  });

  test("appends org finance companies after the defaults without duplicating them", () => {
    const rowWithCustom: VehicleSheetRow = {
      ...stockRow,
      valuationsByCompany: { [DEFAULT_VALUATION_HEADERS[0]]: 19000, "MyBank": 21000 },
    };
    // The first default is passed as an org company too — it must appear once.
    const { rows, companyNames } = buildVehicleSheetMatrix(
      [DEFAULT_VALUATION_HEADERS[0], "MyBank"],
      [rowWithCustom]
    );

    expect(companyNames).toEqual([...DEFAULT_VALUATION_HEADERS, "MyBank"]);

    const headerRow = rows[0];
    const myBankCol = headerRow.indexOf("MyBank");
    expect(myBankCol).toBeGreaterThan(-1);
    expect(rows[1][myBankCol]).toBe(21000);
    // Default valuation still lands in its own column.
    const defaultCol = headerRow.indexOf(DEFAULT_VALUATION_HEADERS[0]);
    expect(rows[1][defaultCol]).toBe(19000);
  });

  test("leaves KM blank for a car with no mileage", () => {
    const { rows } = buildVehicleSheetMatrix([], [sourcedRow]);
    expect(rows[1][3]).toBe("");
  });
});
