// Just enough CSV (RFC 4180) for the app's own export format.

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

// A spreadsheet runs a cell that starts with one of these as a formula, so a
// description like `=HYPERLINK(...)` typed by one member would run for
// whoever opens the export. A leading apostrophe makes it text. Numbers are
// left alone so a negative amount stays a number.
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?\d+(\.\d+)?$/;

function cell(value: string): string {
  const safe = FORMULA_START.test(value) && !NUMBER.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

// Undoes that apostrophe when a file made by toCsv is read back.
export function plainText(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

// Rows of cells. Blank lines are dropped. Null when a quote is never closed.
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const endRow = () => {
    row.push(value);
    value = "";
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch !== '"') value += ch;
      else if (body[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && value === "") quoted = true;
    else if (ch === ",") {
      row.push(value);
      value = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      endRow();
    } else value += ch;
  }
  if (quoted) return null;
  if (value !== "" || row.length > 0) endRow();
  return rows;
}
