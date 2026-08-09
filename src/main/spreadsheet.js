'use strict';

// O24/raw-data: deterministic spreadsheet rendering — the model authors DATA
// (JSON sheets), the framework renders the file. v1 emits Excel 2003
// SpreadsheetML (.xls, single XML file, multi-sheet, zero dependencies) —
// Excel, Numbers, and LibreOffice all open it. A native .xlsx (zip) writer is
// the v2 upgrade; the model-facing contract will not change.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cell = (v) => {
  const isNum = typeof v === 'number' && Number.isFinite(v);
  return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${esc(v)}</Data></Cell>`;
};

const SHEET_NAME_BAD = /[\\/?*[\]:]/g;

/**
 * Render {sheets:[{name, rows:[[...]]}]} (or a bare rows array) to
 * SpreadsheetML. Tolerant of model-shaped input: strings that look like
 * numbers stay strings — only real JSON numbers become Number cells.
 * @returns {string} XML document text
 */
function sheetsToXml(input) {
  let sheets = Array.isArray(input) ? [{ name: 'Data', rows: input }] : (input && input.sheets) || [];
  sheets = sheets
    .filter((s) => s && Array.isArray(s.rows) && s.rows.length)
    .map((s, i) => ({
      name: (String(s.name || `Sheet${i + 1}`).replace(SHEET_NAME_BAD, ' ').trim() || `Sheet${i + 1}`).slice(0, 31),
      rows: s.rows
    }));
  if (!sheets.length) throw new Error('spreadsheet: no sheets with rows');
  const body = sheets.map((s) =>
    `<Worksheet ss:Name="${esc(s.name)}"><Table>` +
    s.rows.map((r) => `<Row>${(Array.isArray(r) ? r : [r]).map(cell).join('')}</Row>`).join('') +
    `</Table></Worksheet>`).join('');
  return '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    body + '</Workbook>';
}

module.exports = { sheetsToXml };
