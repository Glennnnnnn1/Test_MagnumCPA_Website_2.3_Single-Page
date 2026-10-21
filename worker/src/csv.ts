// CSV generation for the admin lead export. Pure module — unit-tested directly.
//
// Lead names and emails are attacker-controlled text that ends up opened in
// Excel on Glenn's machine, so this is a security boundary, not a formatting
// helper. Two things matter and both are easy to get wrong:
//   1. Formula injection — a cell starting with = + - @ is evaluated by Excel.
//   2. Encoding — without a UTF-8 BOM, Excel reads the file as the system
//      codepage and mangles any non-ASCII name.

// Characters Excel treats as the start of a formula.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

// Values that start with a trigger character but cannot form a dangerous
// formula: digits, spaces, and arithmetic/grouping punctuation only. This
// keeps E.164 phone numbers (+15555555555) and negative numbers readable
// instead of showing a stray apostrophe in every row. Every known injection
// payload needs something outside this set — letters for HYPERLINK/WEBSERVICE/
// cmd, or | ! ' for DDE — so excluding letters and those symbols is what makes
// the exemption safe.
const SAFE_NUMERICISH = /^[+-]?[\d\s().+-]+$/;

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);

  // Normalize line endings first so the quoting decision below sees them.
  s = s.replace(/\r\n/g, '\n');

  if (FORMULA_TRIGGER.test(s) && !SAFE_NUMERICISH.test(s)) {
    s = `'${s}`;
  }

  if (/[",\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines: string[] = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  // ﻿ = UTF-8 BOM; CRLF line endings per RFC 4180.
  return `﻿${lines.join('\r\n')}\r\n`;
}
