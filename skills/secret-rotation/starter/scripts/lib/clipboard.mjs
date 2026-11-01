import { defaultRun } from './cloud.mjs';

// Candidates in order of preference. Only wl-copy can tell clipboard managers not
// to keep what it copies, the others cannot, so `hidden` says whether to trust it.
const TOOLS = [
  {
    name: 'wl-copy',
    when: (env) => Boolean(env.WAYLAND_DISPLAY),
    probe: ['--version'],
    args: ['--sensitive'],
    hidden: true,
  },
  {
    name: 'xclip',
    when: (env) => Boolean(env.DISPLAY),
    probe: ['-version'],
    args: ['-selection', 'clipboard'],
    hidden: false,
  },
  {
    name: 'xsel',
    when: (env) => Boolean(env.DISPLAY),
    probe: ['--version'],
    args: ['--clipboard', '--input'],
    hidden: false,
  },
  {
    name: 'pbcopy',
    when: () => process.platform === 'darwin',
    probe: ['-help'],
    args: [],
    hidden: false,
  },
];

// The text goes in on stdin, never on the command line.
export async function copyToClipboard(text, { run = defaultRun, env = process.env } = {}) {
  if (!text) return { ok: false, reason: 'Nothing to copy.' };
  for (const tool of TOOLS) {
    if (!tool.when(env)) continue;
    const probe = await run(tool.name, tool.probe, { timeoutMs: 10_000 });
    if (probe.code === 127) continue;
    const result = await run(tool.name, tool.args, { input: text, timeoutMs: 10_000 });
    if (result.code === 0) return { ok: true, tool: tool.name, hidden: tool.hidden };
  }
  return { ok: false, reason: 'No clipboard tool was found (wl-copy, xclip, xsel).' };
}
