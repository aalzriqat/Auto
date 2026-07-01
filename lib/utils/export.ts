type CsvRow = Record<string, unknown>;

type NavigatorWithMsSaveBlob = Navigator & {
  msSaveBlob?: (blob: Blob, filename: string) => void;
};

const DANGEROUS_SPREADSHEET_CELL = /^[\s]*[=+\-@]/;

export function formatCSVCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let cell = value instanceof Date ? value.toLocaleString() : String(value);
  if (cell && (DANGEROUS_SPREADSHEET_CELL.test(cell) || cell.startsWith("\t") || cell.startsWith("\r"))) {
    cell = `'${cell}`;
  }

  if (cell.search(/("|,|\n|\r)/g) >= 0) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function toCSV(data: CsvRow[]): string {
  if (!data || !data.length) return "";

  const separator = ",";
  const keys = Object.keys(data[0]);

  return [
    keys.map(formatCSVCell).join(separator),
    ...data.map((row) => keys.map((key) => formatCSVCell(row[key])).join(separator)),
  ].join("\n");
}

export function downloadCSV(data: CsvRow[], filename: string) {
  if (!data || !data.length) return;

  const csvContent = toCSV(data);

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const browserNavigator = navigator as NavigatorWithMsSaveBlob;
  
  if (browserNavigator.msSaveBlob) { // IE 10+
    browserNavigator.msSaveBlob(blob, filename);
  } else {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
