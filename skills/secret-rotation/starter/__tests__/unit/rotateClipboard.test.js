import { copyToClipboard } from '../../scripts/lib/clipboard.mjs';

function fakeRun(available) {
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args.includes('--version') || args.includes('-version')) {
      return available.includes(command)
        ? { code: 0, stdout: 'x', stderr: '' }
        : { code: 127, stdout: '', stderr: 'missing' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  return run;
}

describe('copyToClipboard', () => {
  test('on Wayland it uses wl-copy with the sensitive hint and sends the text on stdin', async () => {
    const run = fakeRun(['wl-copy']);
    const result = await copyToClipboard('KEY=value-123\n', {
      run,
      env: { WAYLAND_DISPLAY: 'wayland-1' },
    });
    expect(result).toMatchObject({ ok: true, tool: 'wl-copy', hidden: true });
    const copy = run.calls.at(-1);
    expect(copy.command).toBe('wl-copy');
    expect(copy.args).toEqual(['--sensitive']);
    expect(copy.options.input).toBe('KEY=value-123\n');
    expect(JSON.stringify(run.calls.map((c) => c.args))).not.toContain('value-123');
  });

  test('falls back to xclip on X11 and says the history may keep it', async () => {
    const run = fakeRun(['xclip']);
    const result = await copyToClipboard('KEY=v\n', { run, env: { DISPLAY: ':0' } });
    expect(result).toMatchObject({ ok: true, tool: 'xclip', hidden: false });
    expect(run.calls.at(-1).args).toEqual(['-selection', 'clipboard']);
  });

  test('reports that nothing is available instead of failing', async () => {
    const run = fakeRun([]);
    const result = await copyToClipboard('KEY=v\n', {
      run,
      env: { WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' },
    });
    expect(result.ok).toBe(false);
  });

  test('does nothing for empty text', async () => {
    const run = fakeRun(['wl-copy']);
    expect((await copyToClipboard('', { run, env: { WAYLAND_DISPLAY: 'w' } })).ok).toBe(false);
    expect(run.calls).toEqual([]);
  });
});
