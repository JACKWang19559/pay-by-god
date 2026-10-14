import { redactResult } from './errors.js';

export function csvCell(value) {
  const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Spreadsheet applications interpret formula prefixes even in quoted CSV cells.
  const safe = /^(?:[\t\r\n]|\s*[=+@\-])/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function extractRows(result) {
  if (Array.isArray(result)) return result;
  if (result !== null && typeof result === 'object') {
    for (const name of ['items', 'jobs', 'results', 'favorites', 'chats', 'messages', 'cities', 'data']) {
      if (Array.isArray(result[name])) return result[name];
    }
  }
  return undefined;
}

function records(rows) {
  return rows.map((row) => row !== null && typeof row === 'object' && !Array.isArray(row) ? row : { value: row });
}

export function renderCsv(result) {
  const rows = records(extractRows(result) ?? [result]);
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(','))].join('\r\n') + '\r\n';
}

function displayWidth(text) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (/\p{Mark}/u.test(character)) continue;
    width += code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300) ? 2 : 1;
  }
  return width;
}

function cell(value) {
  return (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function truncate(text, maxWidth = 64) {
  if (displayWidth(text) <= maxWidth) return text;
  let output = '';
  for (const character of text) {
    if (displayWidth(output + character) > maxWidth - 1) break;
    output += character;
  }
  return output + '…';
}

function renderTable(rows) {
  if (!rows.length) return '没有结果。\n';
  const data = records(rows);
  const columns = [...new Set(data.flatMap((row) => Object.keys(row)))];
  const values = [columns, ...data.map((row) => columns.map((key) => cell(row[key])))].map((row) => row.map((value) => truncate(value)));
  const widths = columns.map((_, index) => Math.max(...values.map((row) => displayWidth(row[index]))));
  const lines = values.map((row) => row.map((value, index) => value + ' '.repeat(widths[index] - displayWidth(value))).join('  ').trimEnd());
  lines.splice(1, 0, widths.map((width) => '-'.repeat(width)).join('  '));
  return lines.join('\n') + '\n';
}

export function renderOutput(rawResult, { format = 'table' } = {}) {
  const result = redactResult(rawResult);
  if (format === 'json') return JSON.stringify(result ?? null, null, 2) + '\n';
  if (format === 'csv') return renderCsv(result);
  if (typeof result === 'string') return result + '\n';
  const rows = extractRows(result);
  if (rows) {
    const metadata = Array.isArray(result) ? {} : Object.fromEntries(Object.entries(result).filter(([key]) => !['items', 'jobs', 'results', 'favorites', 'chats', 'messages', 'cities', 'data'].includes(key)));
    return renderTable(rows) + (Object.keys(metadata).length ? '\n' + JSON.stringify(metadata, null, 2) + '\n' : '');
  }
  return JSON.stringify(result ?? null, null, 2) + '\n';
}
