#!/usr/bin/env python3
"""Drives an interactive Node script in a pseudo terminal, for testing a wizard end to end.

    python3 tools/pty-drive.py scenario.json

A scenario is JSON:

    {
      "cwd": "/path/to/a/throwaway/repo",
      "args": ["scripts/rotate-secrets.mjs", "--dry-run"],
      "env": { "XDG_STATE_HOME": "/path/to/a/throwaway/state" },
      "timeout": 140,
      "steps": [
        ["enter continue", ["a", "\\u001b[B", " ", "\\r"]],
        ["Apply these changes?", ["y", "\\r"]]
      ]
    }

Each step waits until its first item appears in the output (colour codes ignored), then
types the keys in its second item, one at a time. Prints the screen as plain text and how
many steps ran. Keys: "\\r" enter, "\\u001b[A" and "\\u001b[B" arrows, "\\u007f" backspace.
Always set XDG_STATE_HOME to a throwaway folder so the run cannot touch real backups.
"""
import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def run(scenario):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(scenario["cwd"])
        os.environ["TERM"] = "xterm-256color"
        os.environ.update(scenario.get("env", {}))
        os.execvp("node", ["node"] + scenario["args"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 100, 0, 0))

    steps = scenario.get("steps", [])
    deadline = time.time() + scenario.get("timeout", 120)
    output = b""
    cursor = 0
    done = 0
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.3)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            output += data
        if done < len(steps):
            needle, keys = steps[done]
            if needle in ANSI.sub("", output[cursor:].decode(errors="replace")):
                time.sleep(0.4)
                for key in keys:
                    os.write(fd, key.encode())
                    time.sleep(0.12)
                cursor = len(output)
                done += 1
        finished, _ = os.waitpid(pid, os.WNOHANG)
        if finished:
            while True:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                output += data
            break
    try:
        os.kill(pid, 9)
    except OSError:
        pass
    return output.decode(errors="replace"), done, len(steps)


def plain(text):
    text = re.sub(r"\x1b\[\?25[lh]", "", text)
    text = text.replace("\x1b[2K", "")
    text = ANSI.sub("", text)
    return "\n".join(line.split("\r")[-1] for line in text.replace("\r\n", "\n").split("\n"))


if __name__ == "__main__":
    scenario = json.load(open(sys.argv[1]))
    screen, done, total = run(scenario)
    print(plain(screen))
    print(f"\n[steps completed: {done}/{total}]")
