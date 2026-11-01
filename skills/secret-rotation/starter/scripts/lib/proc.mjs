import { spawn } from 'node:child_process';

// Runs a program without a shell, so nothing typed or pasted can be read as a
// command. It never throws: the caller gets { code, stdout, stderr }, with 127 for
// a missing program and 124 for a timeout.
export function createRunner({ baseEnv = process.env } = {}) {
  return function run(
    command,
    args = [],
    { input, timeoutMs = 120_000, inherit = false, env = {} } = {},
  ) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      let child;
      try {
        child = spawn(command, args, {
          env: { ...baseEnv, ...env },
          stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } catch (error) {
        finish({ code: 1, stdout, stderr: error.message });
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('error', (error) => {
        finish({
          code: error.code === 'ENOENT' ? 127 : 1,
          stdout,
          stderr:
            error.code === 'ENOENT' ? `${command} is not installed or not on PATH.` : error.message,
        });
      });
      child.on('close', (code) => {
        if (timedOut) {
          finish({
            code: 124,
            stdout,
            stderr: `${command} timed out after ${Math.round(timeoutMs / 1000)}s.`,
          });
        } else {
          finish({ code: code ?? 1, stdout, stderr });
        }
      });

      if (!inherit) {
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
    });
  };
}
