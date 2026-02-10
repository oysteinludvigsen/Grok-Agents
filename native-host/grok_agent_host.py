#!/usr/bin/env python3
"""
Grok Agent — Native Messaging Host

Receives JSON commands from the browser extension over stdin (Chrome native
messaging protocol), executes them in a local shell, and returns the results
over stdout.

Protocol: each message is prefixed with a 4-byte native-order uint32 length.
"""

import json
import os
import platform
import struct
import subprocess
import sys

VERSION = "1.0.0"


# ── IO ────────────────────────────────────────────────────────────────

def read_message():
    """Read one native-messaging message from stdin."""
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("=I", raw)[0]
    if length == 0:
        return None
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    """Write one native-messaging message to stdout."""
    encoded = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


# ── Helpers ───────────────────────────────────────────────────────────

def resolve_path(p):
    """Expand ~ and environment variables."""
    return os.path.expandvars(os.path.expanduser(p))


def detect_shell(requested="auto"):
    """Return the shell binary to use."""
    if requested and requested != "auto":
        return requested
    if platform.system() == "Windows":
        return "powershell"
    for sh in ("/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash"):
        if os.path.isfile(sh):
            return sh
    return "/bin/sh"


# ── Command execution ─────────────────────────────────────────────────

def execute(command, cwd=None, shell="auto", timeout=30):
    """Run *command* in the chosen shell and return structured output."""
    cwd = resolve_path(cwd) if cwd else os.path.expanduser("~")
    os.makedirs(cwd, exist_ok=True)

    shell_bin = detect_shell(shell)
    system = platform.system()

    if system == "Windows" and shell_bin in ("powershell", "pwsh"):
        args = [shell_bin, "-NoProfile", "-NonInteractive", "-Command", command]
    else:
        args = [shell_bin, "-l", "-c", command]

    env = {**os.environ, "TERM": "dumb", "NO_COLOR": "1"}

    try:
        proc = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        return {
            "exitCode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    except subprocess.TimeoutExpired:
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": f"Command timed out after {timeout}s",
        }
    except FileNotFoundError:
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": f"Shell not found: {shell_bin}",
        }
    except Exception as exc:
        return {
            "exitCode": -1,
            "stdout": "",
            "stderr": str(exc),
        }


# ── Message handler ───────────────────────────────────────────────────

def handle(msg):
    action = msg.get("action")

    if action == "ping":
        return {
            "connected": True,
            "version": VERSION,
            "platform": platform.system(),
            "shell": detect_shell("auto"),
        }

    if action == "exec":
        timeout_ms = msg.get("timeout", 30_000)
        timeout_s = min(timeout_ms / 1000, 600)  # cap at 10 min
        return execute(
            command=msg.get("command", ""),
            cwd=msg.get("cwd"),
            shell=msg.get("shell", "auto"),
            timeout=timeout_s,
        )

    return {"exitCode": -1, "stdout": "", "stderr": f"Unknown action: {action}"}


# ── Main loop ─────────────────────────────────────────────────────────

def main():
    while True:
        msg = read_message()
        if msg is None:
            break
        response = handle(msg)
        send_message(response)


if __name__ == "__main__":
    main()
