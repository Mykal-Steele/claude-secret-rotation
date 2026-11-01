import { chmodSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// KEY= then a double quoted value (it may span lines), a single quoted value, or
// a bare value up to the end of the line.
const linePattern = (key) =>
  new RegExp(
    `^${escapeRegExp(key)}=("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\r\\n]*)`,
    'gm',
  );

function unquote(raw) {
  if (raw.startsWith('"')) {
    return raw.slice(1, -1).replace(/\\(.)/g, (_match, char) => (char === 'n' ? '\n' : char));
  }
  if (raw.startsWith("'")) return raw.slice(1, -1);
  return raw.trim();
}

export function parseEnvValue(content, key) {
  const matches = [...content.matchAll(linePattern(key))];
  if (!matches.length) return undefined;
  return unquote(matches.at(-1)[1]);
}

export function renderEnvValue(value) {
  if (/[\s#"'`$]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}

export function countKey(content, key) {
  return [...content.matchAll(linePattern(key))].length;
}

const MARKER_LINE = /^# last rotated .*\r?\n$/;

const newlineOf = (content) => (content.includes('\r\n') ? '\r\n' : '\n');

// A rotated key gets a "# last rotated <time>" comment directly above it. An older
// marker on that spot is dropped first so they never pile up.
function dropMarkerAbove(before) {
  const lines = before.split(/(?<=\n)/);
  if (MARKER_LINE.test(lines.at(-1) ?? '')) lines.pop();
  return lines.join('');
}

export function formatStamp(date, offsetMinutes = -date.getTimezoneOffset()) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const pad = (number) => String(number).padStart(2, '0');
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// The time in the "last rotated" comment directly above the key that is in effect.
export function readRotationStamp(content, key) {
  const match = [...content.matchAll(linePattern(key))].at(-1);
  if (!match) return undefined;
  const above =
    content
      .slice(0, match.index)
      .split(/(?<=\n)/)
      .at(-1) ?? '';
  return above.match(/^# last rotated (.+?)\r?\n$/)?.[1];
}

export function parseStamp(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ([+-])(\d{2}):(\d{2})$/.exec(stamp ?? '');
  if (!match) return undefined;
  const [, year, month, day, hour, minute, sign, offsetHours, offsetMinutes] = match;
  const offset = (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes));
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) -
      offset * 60_000,
  );
}

// Every line that sets the key is rewritten, because the last one wins when the
// file is loaded and an older duplicate would otherwise hide the new value.
export function upsertEnvValue(content, key, value, { stamp } = {}) {
  const matches = [...content.matchAll(linePattern(key))];
  if (!matches.length) return { content, status: 'missing', occurrences: 0 };
  if (matches.every((match) => unquote(match[1]) === value)) {
    return { content, status: 'unchanged', occurrences: matches.length };
  }
  const rendered = renderEnvValue(value);
  const newline = newlineOf(content);
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    let before = content.slice(cursor, match.index);
    if (stamp) before = dropMarkerAbove(before);
    out += `${before}${stamp ? `# last rotated ${stamp}${newline}` : ''}${key}=${rendered}`;
    cursor = match.index + match[0].length;
  }
  return { content: out + content.slice(cursor), status: 'updated', occurrences: matches.length };
}

export function appendEnvValue(content, key, value, { stamp } = {}) {
  const newline = newlineOf(content);
  const base = content === '' || content.endsWith('\n') ? content : `${content}${newline}`;
  const marker = stamp ? `# last rotated ${stamp}${newline}` : '';
  return `${base}${marker}${key}=${renderEnvValue(value)}${newline}`;
}

// Writes next to the target and renames, so a crash never leaves a half written
// env file. An existing file keeps its mode, a new one is owner-only.
export function writeFileAtomic(filePath, content, { mode } = {}) {
  const finalMode = mode ?? (existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600);
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    chmodSync(temp, finalMode);
    renameSync(temp, filePath);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
}
