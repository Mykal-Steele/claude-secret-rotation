import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReader, fileKeyOf } from '../../scripts/lib/current.mjs';

describe('createReader', () => {
  let root;
  const secrets = {
    A: { files: ['.env.development', '.env.production'] },
    B: { files: ['infra/x.env'], fileKeys: { 'infra/x.env': 'B_RENAMED' } },
    C: { files: ['.env.development'] },
    D: { files: ['.env.production', 'infra/x.env'], fileKeys: { 'infra/x.env': 'D_OTHER' } },
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'reader-'));
    mkdirSync(path.join(root, 'infra'));
    writeFileSync(path.join(root, '.env.development'), 'A=dev-a\nC=dev-c\n');
    writeFileSync(path.join(root, '.env.production'), 'A=prod-a\nD=\n');
    writeFileSync(path.join(root, 'infra/x.env'), 'B_RENAMED=infra-b\nD_OTHER=infra-d\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const reader = () => createReader({ root, secrets, productionFile: '.env.production' });

  test('prefers the production file', () => {
    expect(reader().read('A')).toBe('prod-a');
  });

  test('falls back to another file when production does not have a value', () => {
    expect(reader().read('C')).toBe('dev-c');
    expect(reader().read('D')).toBe('infra-d');
  });

  test('reads a key under the name a file uses for it', () => {
    expect(reader().read('B')).toBe('infra-b');
  });

  test('is undefined when no file has it', () => {
    expect(reader().read('MISSING')).toBeUndefined();
  });

  test('skips a listed file that does not exist', () => {
    rmSync(path.join(root, '.env.development'));
    expect(reader().read('C')).toBeUndefined();
  });

  test('readFile returns the text of a file or undefined', () => {
    expect(reader().readFile('.env.development')).toBe('A=dev-a\nC=dev-c\n');
    expect(reader().readFile('nope')).toBeUndefined();
  });
});

describe('fileKeyOf', () => {
  test('gives the name a file uses, or the key itself', () => {
    const spec = { fileKeys: { 'infra/x.env': 'B_RENAMED' } };
    expect(fileKeyOf(spec, 'B', 'infra/x.env')).toBe('B_RENAMED');
    expect(fileKeyOf(spec, 'B', '.env')).toBe('B');
    expect(fileKeyOf({}, 'B', '.env')).toBe('B');
  });
});
