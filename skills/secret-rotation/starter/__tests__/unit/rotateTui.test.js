import { createStyle, stripAnsi, visibleLength, wrapText, box } from '../../scripts/lib/tui.mjs';

describe('createStyle', () => {
  test('adds colour codes when enabled and leaves text alone when not', () => {
    const on = createStyle(true);
    const off = createStyle(false);
    expect(on.green('ok')).toContain('\x1b[');
    expect(stripAnsi(on.green('ok'))).toBe('ok');
    expect(off.green('ok')).toBe('ok');
    expect(off.bold('x')).toBe('x');
  });
});

describe('stripAnsi and visibleLength', () => {
  test('ignore colour codes when measuring', () => {
    const text = createStyle(true).red('hello');
    expect(stripAnsi(text)).toBe('hello');
    expect(visibleLength(text)).toBe(5);
  });
});

describe('wrapText', () => {
  test('wraps at word boundaries', () => {
    expect(wrapText('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
  });

  test('breaks a word that is longer than the line', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  test('keeps the line breaks that are already there', () => {
    expect(wrapText('one\ntwo three', 20)).toEqual(['one', 'two three']);
  });

  test('returns one empty line for empty text', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });
});

describe('box', () => {
  const style = createStyle(false);

  test('draws lines that are all the same width', () => {
    const lines = box(
      {
        title: 'Title',
        lines: ['short', 'a much longer line of text that needs wrapping to fit'],
        width: 30,
      },
      style,
    );
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(visibleLength(line)).toBe(30);
  });

  test('shows the title in the top border', () => {
    const lines = box({ title: 'Plan', lines: ['x'], width: 30 }, style);
    expect(lines[0]).toContain('Plan');
  });

  test('has no colour codes when colour is off', () => {
    const lines = box({ title: 'T', lines: ['x'], width: 20 }, style);
    expect(lines.join('')).not.toContain('\x1b');
  });

  test('keeps the width right when the content is coloured', () => {
    const coloured = createStyle(true);
    const lines = box(
      { title: 'T', lines: [coloured.red('red text'), 'plain'], width: 24 },
      coloured,
    );
    for (const line of lines) expect(visibleLength(line)).toBe(24);
  });
});
