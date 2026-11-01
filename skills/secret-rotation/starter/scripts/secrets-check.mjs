#!/usr/bin/env node
// Read-only check of every managed secret, safe to run any time:
//
//   npm run secrets:check           problems first, a one-line summary for what is fine
//   npm run secrets:check -- --all  list every line, including the fine ones
//
// Compares .env.production with Azure by hash, checks the GitHub secrets, logs in to
// Mongo, probes the site, and shows when each value was last rotated. Values are
// never printed. Exits 1 when something is wrong.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChecks } from './lib/checks.mjs';
import { createAzureAdapter, createGithubAdapter } from './lib/cloud.mjs';
import { parseStamp } from './lib/envfile.mjs';
import { stateDir } from './lib/safety.mjs';
import { CONFIG } from './secrets.config.mjs';
import { heading, line, print, printBox, spinner, style as c, symbols, table } from './lib/tui.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const showAll = process.argv.includes('--all');

const SECTIONS = {
  files: 'Local env files',
  permissions: 'File permissions',
  age: 'Age of the local values',
  azure: 'Azure compared with .env.production',
  github: 'GitHub secrets',
  mongo: 'MongoDB',
  health: 'Site health',
  backups: 'Saved old values',
};

const days = (when, parse) => {
  const date = parse(when);
  return date && !Number.isNaN(date.getTime())
    ? `${Math.floor((Date.now() - date.getTime()) / 86_400_000)}d ago`
    : undefined;
};

function overviewTable(overview) {
  const rows = overview.filter((row) => row.local || row.github || row.azure);
  heading('When each value was last rotated');
  if (!rows.length) {
    print(c.gray('  Nothing is recorded yet. The times appear after the next rotation.'));
    return;
  }
  const cell = (value, parse) =>
    value ? `${value.slice(0, 10)} ${c.gray(days(value, parse) ?? '')}` : c.gray('-');
  table([
    [c.bold('key'), c.bold('local file'), c.bold('github'), c.bold('azure')],
    ...rows.map((row) => [
      row.key,
      cell(row.local, parseStamp),
      cell(row.github, (v) => new Date(v)),
      cell(row.azure, (v) => new Date(v)),
    ]),
  ]);
}

const spin = spinner('Checking local files, Azure, GitHub, MongoDB and the site');
const { rows, overview } = await collectChecks({
  root: ROOT,
  stateDir: stateDir(process.env, os.homedir(), CONFIG.name),
  azure: CONFIG.azure ? createAzureAdapter() : null,
  github: CONFIG.github === false ? null : createGithubAdapter(),
});
spin.stop();

// Every loose env file gets the same advice, so it is shown once under the list.
function printPermissions(mine) {
  for (const row of mine) {
    line('warn', `${c.bold(row.label)}  ${c.gray(row.detail.match(/\(mode \d+\)/)?.[0] ?? '')}`);
  }
  print(c.gray(`    ${mine[0].detail.replace(/^.*?\)\.\s*/, '')}`));
}

for (const [section, title] of Object.entries(SECTIONS)) {
  const mine = rows.filter((row) => row.section === section);
  if (!mine.length) continue;
  heading(title);
  if (section === 'permissions') {
    printPermissions(mine);
    continue;
  }
  const good = mine.filter((row) => row.state === 'ok');
  if (!showAll && good.length > 1) line('ok', `${good.length} fine`);
  for (const row of mine) {
    if (row.state === 'ok' && !showAll && good.length > 1) continue;
    line(row.state, `${c.bold(row.label)}${row.detail ? `  ${c.gray(row.detail)}` : ''}`);
  }
}

overviewTable(overview);

const failures = rows.filter((row) => row.state === 'fail').length;
const warnings = rows.filter((row) => row.state === 'warn').length;
print('');
if (failures) {
  printBox({
    title: 'Needs attention',
    tone: 'red',
    lines: [
      `${symbols.fail} ${failures} problem(s)${warnings ? `, ${warnings} warning(s)` : ''}. The red lines above say what.`,
    ],
  });
} else if (warnings) {
  printBox({
    title: 'Works, with warnings',
    tone: 'yellow',
    lines: [`${symbols.warn} ${warnings} warning(s). Nothing is broken.`],
  });
} else {
  printBox({
    title: 'All good',
    tone: 'green',
    lines: ['Every value matches and the site is healthy.'],
  });
}
process.exit(failures ? 1 : 0);
