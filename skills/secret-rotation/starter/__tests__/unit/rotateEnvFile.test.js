import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseEnvValue,
  renderEnvValue,
  upsertEnvValue,
  appendEnvValue,
  countKey,
  writeFileAtomic,
  formatStamp,
  parseStamp,
  readRotationStamp,
} from '../../scripts/lib/envfile.mjs';

describe('parseEnvValue', () => {
  test('reads a bare value', () => {
    expect(parseEnvValue('A=1\nB=two\n', 'B')).toBe('two');
  });

  test('returns an empty string for KEY= with nothing after it', () => {
    expect(parseEnvValue('A=\n', 'A')).toBe('');
  });

  test('returns undefined when the key is missing', () => {
    expect(parseEnvValue('A=1\n', 'B')).toBeUndefined();
  });

  test('does not match a key that only ends with the name', () => {
    expect(parseEnvValue('MY_KEY=1\n', 'KEY')).toBeUndefined();
  });

  test('ignores commented lines', () => {
    expect(parseEnvValue('# KEY=old\nKEY=new\n', 'KEY')).toBe('new');
    expect(parseEnvValue('# KEY=old\n', 'KEY')).toBeUndefined();
  });

  test('unescapes \\n, \\" and \\\\ inside double quotes', () => {
    expect(parseEnvValue('K="a\\nb \\"c\\" d\\\\e"\n', 'K')).toBe('a\nb "c" d\\e');
  });

  test('reads single quotes literally', () => {
    expect(parseEnvValue("K='a b'\n", 'K')).toBe('a b');
  });

  test('reads a double quoted value that spans lines', () => {
    expect(parseEnvValue('K="line1\nline2"\nX=1\n', 'K')).toBe('line1\nline2');
  });

  test('drops the carriage return in CRLF files', () => {
    expect(parseEnvValue('K=abc\r\nX=1\r\n', 'K')).toBe('abc');
  });

  test('uses the last line when a key appears twice, like dotenv', () => {
    expect(parseEnvValue('K=1\nK=2\n', 'K')).toBe('2');
  });
});

describe('renderEnvValue', () => {
  test('leaves a plain value bare', () => {
    expect(renderEnvValue('abc123')).toBe('abc123');
  });

  test('quotes values with spaces, hashes, quotes or dollar signs', () => {
    expect(renderEnvValue('a b')).toBe('"a b"');
    expect(renderEnvValue('a#b')).toBe('"a#b"');
    expect(renderEnvValue('a"b')).toBe('"a\\"b"');
    expect(renderEnvValue('a$b')).toBe('"a$b"');
  });

  test('writes a newline as \\n inside quotes', () => {
    expect(renderEnvValue('a\nb')).toBe('"a\\nb"');
  });

  test('round trips through parseEnvValue', () => {
    const values = [
      'plain',
      'with space',
      'qu"ote',
      "sin'gle",
      'multi\nline',
      'back\\slash',
      'dollar$sign',
      'a b\\c',
    ];
    for (const value of values) {
      expect(parseEnvValue(`K=${renderEnvValue(value)}\n`, 'K')).toBe(value);
    }
  });
});

describe('upsertEnvValue', () => {
  test('changes only the target line and keeps comments and other keys', () => {
    const result = upsertEnvValue('A=1\n# note\nB=2\nC=3\n', 'B', '9');
    expect(result.content).toBe('A=1\n# note\nB=9\nC=3\n');
    expect(result.status).toBe('updated');
    expect(result.occurrences).toBe(1);
  });

  test('reports unchanged when the value is already there', () => {
    const result = upsertEnvValue('A=1\n', 'A', '1');
    expect(result.status).toBe('unchanged');
    expect(result.content).toBe('A=1\n');
  });

  test('reports missing and leaves the content alone', () => {
    const result = upsertEnvValue('A=1\n', 'B', '2');
    expect(result.status).toBe('missing');
    expect(result.content).toBe('A=1\n');
  });

  test('writes $& and $1 literally', () => {
    const result = upsertEnvValue('K=old\n', 'K', 'a$&b$1');
    expect(parseEnvValue(result.content, 'K')).toBe('a$&b$1');
  });

  test('keeps CRLF line endings', () => {
    expect(upsertEnvValue('A=1\r\nB=2\r\n', 'B', '3').content).toBe('A=1\r\nB=3\r\n');
  });

  test('replaces a multi line quoted value completely', () => {
    expect(upsertEnvValue('K="a\nb"\nX=1\n', 'K', 'z').content).toBe('K=z\nX=1\n');
  });

  test('updates every duplicate line, because the last one wins when the file is loaded', () => {
    const result = upsertEnvValue('K=1\nK=2\n', 'K', '3');
    expect(result.content).toBe('K=3\nK=3\n');
    expect(result.occurrences).toBe(2);
  });

  test('compares against the effective (last) value for unchanged', () => {
    expect(upsertEnvValue('K=1\nK=2\n', 'K', '2').status).toBe('updated');
    expect(upsertEnvValue('K=2\nK=2\n', 'K', '2').status).toBe('unchanged');
  });
});

describe('appendEnvValue', () => {
  test('adds a newline first when the file does not end with one', () => {
    expect(appendEnvValue('A=1', 'K', 'v')).toBe('A=1\nK=v\n');
  });

  test('does not add a blank line when the file already ends with a newline', () => {
    expect(appendEnvValue('A=1\n', 'K', 'v')).toBe('A=1\nK=v\n');
  });

  test('works on an empty file and quotes when needed', () => {
    expect(appendEnvValue('', 'K', 'a b')).toBe('K="a b"\n');
  });
});

describe('countKey', () => {
  test('counts the lines that set a key', () => {
    expect(countKey('K=1\n# K=2\nOTHER_K=3\nK=4\n', 'K')).toBe(2);
    expect(countKey('A=1\n', 'K')).toBe(0);
  });
});

describe('writeFileAtomic', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'envfile-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('replaces the content and leaves no temp file behind', () => {
    const file = path.join(dir, '.env');
    writeFileSync(file, 'old');
    writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['.env']);
  });

  test('keeps the mode of an existing file', () => {
    const file = path.join(dir, '.env');
    writeFileSync(file, 'old');
    chmodSync(file, 0o640);
    writeFileAtomic(file, 'new');
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  test('creates a new file readable only by the owner', () => {
    const file = path.join(dir, 'fresh');
    writeFileAtomic(file, 'secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('last rotated marker', () => {
  const stamp = '2026-11-01 09:46 +07:00';

  test('upsert puts a marker comment directly above the changed key', () => {
    const result = upsertEnvValue('A=1\nB=2\n', 'B', '3', { stamp });
    expect(result.content).toBe(`A=1\n# last rotated ${stamp}\nB=3\n`);
  });

  test('keeps an ordinary comment above the key and puts the marker between', () => {
    const result = upsertEnvValue('# note\nB=2\n', 'B', '3', { stamp });
    expect(result.content).toBe(`# note\n# last rotated ${stamp}\nB=3\n`);
  });

  test('replaces an earlier marker instead of stacking another one', () => {
    const first = upsertEnvValue('B=2\n', 'B', '3', { stamp: '2026-10-01 08:00 +07:00' }).content;
    const second = upsertEnvValue(first, 'B', '4', { stamp }).content;
    expect(second).toBe(`# last rotated ${stamp}\nB=4\n`);
  });

  test('marks every duplicate line', () => {
    const result = upsertEnvValue('K=1\nK=2\n', 'K', '3', { stamp });
    expect(result.content).toBe(`# last rotated ${stamp}\nK=3\n# last rotated ${stamp}\nK=3\n`);
  });

  test('does not touch the file when the value is unchanged', () => {
    const content = '# last rotated 2026-10-01 08:00 +07:00\nB=2\n';
    const result = upsertEnvValue(content, 'B', '2', { stamp });
    expect(result.status).toBe('unchanged');
    expect(result.content).toBe(content);
  });

  test('uses CRLF line endings in a CRLF file', () => {
    const result = upsertEnvValue('A=1\r\nB=2\r\n', 'B', '3', { stamp });
    expect(result.content).toBe(`A=1\r\n# last rotated ${stamp}\r\nB=3\r\n`);
  });

  test('appendEnvValue adds the marker above the new line', () => {
    expect(appendEnvValue('A=1\n', 'K', 'v', { stamp })).toBe(
      `A=1\n# last rotated ${stamp}\nK=v\n`,
    );
  });

  test('the marker does not change what the file means', () => {
    const content = upsertEnvValue('B=2\n', 'B', 'x y', { stamp }).content;
    expect(parseEnvValue(content, 'B')).toBe('x y');
  });
});

describe('formatStamp', () => {
  const date = new Date('2026-11-01T02:46:30Z');

  test('writes date, minutes and the offset', () => {
    expect(formatStamp(date, 420)).toBe('2026-11-01 09:46 +07:00');
  });

  test('handles negative and zero offsets', () => {
    expect(formatStamp(date, -300)).toBe('2026-10-31 21:46 -05:00');
    expect(formatStamp(date, 0)).toBe('2026-11-01 02:46 +00:00');
  });

  test('handles an offset with minutes', () => {
    expect(formatStamp(date, 390)).toBe('2026-11-01 09:16 +06:30');
  });
});

describe('readRotationStamp', () => {
  test('returns the time written above a key', () => {
    expect(readRotationStamp('# last rotated 2026-11-01 09:46 +07:00\nB=2\n', 'B')).toBe(
      '2026-11-01 09:46 +07:00',
    );
  });

  test('is undefined when the key has no marker', () => {
    expect(readRotationStamp('A=1\nB=2\n', 'B')).toBeUndefined();
  });

  test('is undefined when the marker is not directly above the key', () => {
    expect(
      readRotationStamp('# last rotated 2026-11-01 09:46 +07:00\n\nB=2\n', 'B'),
    ).toBeUndefined();
  });

  test('reads the marker above the last duplicate, the one that is in effect', () => {
    const content =
      '# last rotated 2026-10-01 08:00 +07:00\nK=1\n# last rotated 2026-11-01 09:46 +07:00\nK=2\n';
    expect(readRotationStamp(content, 'K')).toBe('2026-11-01 09:46 +07:00');
  });

  test('works in a CRLF file', () => {
    expect(readRotationStamp('# last rotated 2026-11-01 09:46 +07:00\r\nB=2\r\n', 'B')).toBe(
      '2026-11-01 09:46 +07:00',
    );
  });

  test('is undefined for a missing key', () => {
    expect(readRotationStamp('A=1\n', 'B')).toBeUndefined();
  });
});

describe('parseStamp', () => {
  test('turns a stamp back into the moment it describes', () => {
    expect(parseStamp('2026-11-01 09:46 +07:00').toISOString()).toBe('2026-11-01T02:46:00.000Z');
    expect(parseStamp('2026-10-31 21:46 -05:00').toISOString()).toBe('2026-11-01T02:46:00.000Z');
  });

  test('round trips with formatStamp', () => {
    const date = new Date('2026-11-01T02:46:00Z');
    expect(parseStamp(formatStamp(date, 390)).getTime()).toBe(date.getTime());
  });

  test('returns undefined for text that is not a stamp', () => {
    expect(parseStamp('yesterday')).toBeUndefined();
    expect(parseStamp(undefined)).toBeUndefined();
  });
});
