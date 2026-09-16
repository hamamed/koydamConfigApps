/**
 * A small RFC 4180 reader for the bulk import.
 *
 * Written here rather than pulled in: the import needs quotes, doubled quotes,
 * commas and newlines inside quotes, CRLF and a BOM — about sixty lines — and a
 * dependency for that is more to audit than the code itself.
 *
 * A malformed file throws with the line it broke on. Guessing where a stray
 * quote was meant to end would silently merge rows, and an import that
 * quietly shifts every clue by one question is worse than one that refuses.
 */

/** Rows of fields. Blank lines are skipped. */
export function parseCsv(text) {
  const input = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;     // inside a quoted field
  let wasQuoted = false;  // the current field was quoted and has closed
  let line = 1;

  const endField = () => {
    row.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    // A line with nothing on it is not a row of one empty field.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        wasQuoted = true;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }

    if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      endRow();
      line++;
    } else if (ch === '"') {
      if (field !== '' || wasQuoted) throw new Error(`Line ${line}: a quote in the middle of a field. Wrap the whole field in quotes and double any quote inside it.`);
      quoted = true;
    } else {
      if (wasQuoted) throw new Error(`Line ${line}: text after a closing quote. Wrap the whole field in quotes.`);
      field += ch;
    }
  }

  if (quoted) throw new Error(`Line ${line}: a quote is opened and never closed.`);
  if (field !== '' || wasQuoted || row.length) endRow();
  return rows;
}
