// Terminal helpers with no dependencies: colour, boxes, a spinner and prompts.
// Colour turns off for NO_COLOR, a dumb terminal, or when output is not a terminal.
const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  inverse: [7, 27],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
};

export function createStyle(enabled) {
  const style = {};
  for (const [name, [open, close]] of Object.entries(CODES)) {
    style[name] = enabled ? (text) => `\x1b[${open}m${text}\x1b[${close}m` : (text) => String(text);
  }
  return style;
}

const detectColor = (env, stream) =>
  !env.NO_COLOR && env.TERM !== 'dumb' && (Boolean(env.FORCE_COLOR) || Boolean(stream.isTTY));

export const style = createStyle(detectColor(process.env, process.stdout));

export const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
export const visibleLength = (text) => [...stripAnsi(text)].length;

export function wrapText(text, width) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      let rest = word;
      while (visibleLength(rest) > width) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      if (!line) line = rest;
      else if (visibleLength(line) + 1 + visibleLength(rest) <= width) line += ` ${rest}`;
      else {
        out.push(line);
        line = rest;
      }
    }
    out.push(line);
  }
  return out;
}

export function box({ title = '', lines, width, tone = 'gray' }, s = style) {
  const inner = width - 4;
  const edge = s[tone] ?? ((text) => text);
  const label = visibleLength(title) > width - 6 ? `${title.slice(0, width - 7)}…` : title;
  const top = label
    ? `${edge('╭─')} ${s.bold(label)} ${edge(`${'─'.repeat(width - 5 - visibleLength(label))}╮`)}`
    : edge(`╭${'─'.repeat(width - 2)}╮`);
  const body = lines
    .flatMap((line) => wrapText(line, inner))
    .map(
      (line) =>
        `${edge('│')} ${line}${' '.repeat(Math.max(0, inner - visibleLength(line)))} ${edge('│')}`,
    );
  return [top, ...body, edge(`╰${'─'.repeat(width - 2)}╯`)];
}

export const termWidth = () => Math.max(50, Math.min(process.stdout.columns || 80, 100));
export const print = (text = '') => process.stdout.write(`${text}\n`);
export const printBox = (options) => print(box({ width: termWidth(), ...options }).join('\n'));

export const symbols = {
  ok: style.green('✔'),
  fail: style.red('✖'),
  warn: style.yellow('▲'),
  info: style.cyan('●'),
  skip: style.gray('○'),
  arrow: style.gray('→'),
};

export const heading = (text) =>
  print(
    `\n${style.bold(style.cyan(text))}\n${style.gray('─'.repeat(Math.min(termWidth(), visibleLength(text) + 4)))}`,
  );
export const line = (state, text) => print(`  ${symbols[state]} ${text}`);

export function spinner(text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const animated = Boolean(process.stdout.isTTY);
  let label = text;
  let index = 0;
  let timer;
  const clear = () => process.stdout.write('\r\x1b[2K');
  const draw = () => {
    clear();
    process.stdout.write(`  ${style.cyan(frames[index++ % frames.length])} ${label}`);
  };
  if (animated) {
    process.stdout.write('\x1b[?25l');
    draw();
    timer = setInterval(draw, 80);
  } else {
    print(`  … ${label}`);
  }
  const finish = (state, finalText) => {
    if (timer) clearInterval(timer);
    if (animated) {
      clear();
      process.stdout.write('\x1b[?25h');
    }
    line(state, finalText ?? label);
  };
  return {
    update(next) {
      label = next;
    },
    succeed: (finalText) => finish('ok', finalText),
    fail: (finalText) => finish('fail', finalText),
    warn: (finalText) => finish('warn', finalText),
    stop() {
      if (timer) clearInterval(timer);
      if (animated) {
        clear();
        process.stdout.write('\x1b[?25h');
      }
    },
  };
}

export class NoTerminalError extends Error {
  constructor() {
    super(
      'This step needs an interactive terminal. Run it directly in a terminal, not through a pipe.',
    );
  }
}

let interruptHandler;
export const onInterrupt = (fn) => {
  interruptHandler = fn;
};

function readKeys(handler) {
  const { stdin } = process;
  if (!stdin.isTTY) throw new NoTerminalError();
  return new Promise((resolve) => {
    const finish = (value) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(value);
    };
    const onData = (chunk) => {
      if (chunk === '\x03') {
        stdin.setRawMode(false);
        process.stdout.write('\x1b[?25h\n');
        if (interruptHandler) interruptHandler();
        process.exit(130);
      }
      handler(chunk, finish);
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

// One line of input. With mask on it shows * per character, so a pasted secret
// never appears but you can see that something arrived.
export function readLine(prompt, { mask = false } = {}) {
  process.stdout.write(prompt);
  let value = '';
  return readKeys((chunk, finish) => {
    for (const char of chunk) {
      if (char === '\r' || char === '\n') {
        process.stdout.write('\n');
        return finish(value);
      }
      if (char === '\x1b') return;
      if (char === '\x7f' || char === '\b') {
        if (value) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (char >= ' ') {
        value += char;
        process.stdout.write(mask ? '*' : char);
      }
    }
  });
}

export async function confirm(question, { defaultYes = false } = {}) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await readLine(`  ${question} ${style.gray(`[${hint}]`)} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

// Single key choice, for example [r]etry / [s]kip / [c]ontinue.
export function choose(question, choices) {
  const keys = choices.map((choice) => choice.key);
  const menu = choices
    .map((choice) => `${style.bold(`[${choice.key}]`)} ${choice.label}`)
    .join('   ');
  process.stdout.write(`  ${question}\n  ${menu} `);
  return readKeys((chunk, finish) => {
    const key = chunk.toLowerCase();
    if (keys.includes(key)) {
      process.stdout.write(`${key}\n`);
      finish(key);
    }
  });
}

// Checklist: arrows move, space toggles, a toggles all, enter confirms.
export async function multiSelect(title, options) {
  const chosen = new Set(options.filter((option) => option.checked).map((option) => option.id));
  let cursor = 0;
  let drawn = 0;
  const render = () => {
    if (drawn) process.stdout.write(`\x1b[${drawn}A`);
    const rows = options.map((option, i) => {
      const box = chosen.has(option.id) ? style.green('◉') : style.gray('○');
      const pointer = i === cursor ? style.cyan('›') : ' ';
      const label = i === cursor ? style.bold(option.label) : option.label;
      const hint = option.hint ? style.gray(`  ${option.hint}`) : '';
      const warn = option.warn ? style.red(`  ${option.warn}`) : '';
      return `\x1b[2K  ${pointer} ${box} ${label}${hint}${warn}`;
    });
    rows.push(`\x1b[2K${style.gray('  ↑↓ move   space toggle   a all or none   enter continue')}`);
    process.stdout.write(`${rows.join('\n')}\n`);
    drawn = rows.length;
  };
  print(`  ${style.bold(title)}`);
  process.stdout.write('\x1b[?25l');
  render();
  const result = await readKeys((chunk, finish) => {
    if (chunk === '\x1b[A') cursor = (cursor + options.length - 1) % options.length;
    else if (chunk === '\x1b[B') cursor = (cursor + 1) % options.length;
    else if (chunk === ' ') {
      const id = options[cursor].id;
      if (chosen.has(id)) chosen.delete(id);
      else chosen.add(id);
    } else if (chunk === 'a') {
      if (chosen.size === options.length) chosen.clear();
      else options.forEach((option) => chosen.add(option.id));
    } else if (chunk === '\r' || chunk === '\n') return finish([...chosen]);
    else return;
    render();
  });
  process.stdout.write('\x1b[?25h');
  return result;
}

export function table(rows) {
  const widths = rows[0].map((_cell, col) =>
    Math.max(...rows.map((row) => visibleLength(row[col] ?? ''))),
  );
  for (const row of rows) {
    print(
      `  ${row.map((cell, col) => `${cell}${' '.repeat(widths[col] - visibleLength(cell))}`).join('  ')}`.trimEnd(),
    );
  }
}

process.on('exit', () => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
});
