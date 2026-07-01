"use client";

import ExcelJS from "exceljs";

export type SpreadsheetCell = string | number | boolean | Date | null;
export type SpreadsheetRows = SpreadsheetCell[][];

export interface TemplateOptions {
  fileName: string;
  sheetName: string;
  rows: SpreadsheetCell[][];
  columnWidth?: number;
  merges?: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
  rightAlignedCells?: Array<{ row: number; col: number }>;
}

function normalizeCellValue(value: ExcelJS.CellValue): SpreadsheetCell {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if ("text" in value && typeof value.text === "string") {
    return value.text;
  }
  if ("result" in value) {
    return normalizeCellValue(value.result as ExcelJS.CellValue);
  }
  if ("richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join("");
  }
  return String(value);
}

function parseCsvRows(text: string): SpreadsheetRows {
  const rows: SpreadsheetRows = [];
  let row: SpreadsheetCell[] = [];
  let cell = "";
  let inQuotes = false;
  let index = 0;
  const source = text.replace(/^\uFEFF/, "");

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        index += 2;
        continue;
      }
      inQuotes = !inQuotes;
      index += 1;
      continue;
    }

    if (!inQuotes && char === ",") {
      row.push(cell);
      cell = "";
      index += 1;
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && next === "\n") index += 2;
      else index += 1;
      continue;
    }

    cell += char;
    index += 1;
  }

  row.push(cell);
  if (row.length > 1 || String(row[0] ?? "").trim() !== "") {
    rows.push(row);
  }

  return rows;
}

export async function parseSpreadsheetFile(file: File): Promise<SpreadsheetRows> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".csv")) {
    return parseCsvRows(await file.text());
  }
  if (!lowerName.endsWith(".xlsx")) {
    throw new Error("Only .xlsx and .csv files are supported.");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const columnCount = worksheet.columnCount;
  const rows: SpreadsheetRows = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const worksheetRow = worksheet.getRow(rowNumber);
    const row: SpreadsheetCell[] = [];
    for (let colNumber = 1; colNumber <= columnCount; colNumber += 1) {
      row.push(normalizeCellValue(worksheetRow.getCell(colNumber).value));
    }
    rows.push(row);
  }
  return rows;
}

export async function downloadXlsxTemplate(options: TemplateOptions): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(options.sheetName);

  options.rows.forEach((row) => worksheet.addRow(row));
  worksheet.columns = (options.rows[0] ?? []).map(() => ({ width: options.columnWidth ?? 20 }));

  options.merges?.forEach((merge) => {
    worksheet.mergeCells(merge.startRow, merge.startCol, merge.endRow, merge.endCol);
  });
  options.rightAlignedCells?.forEach(({ row, col }) => {
    worksheet.getCell(row, col).alignment = { horizontal: "right", readingOrder: "rtl" };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = options.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
