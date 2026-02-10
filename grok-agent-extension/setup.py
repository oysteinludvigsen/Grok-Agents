#!/usr/bin/env python3
"""
Grok Agent — One-Command Setup

    python3 setup.py          # interactive (asks extension ID)
    python3 setup.py --auto   # fully automatic (wildcard origin)
    python3 setup.py --id <EXTENSION_ID>

Generates extension icons (pure Python, no dependencies) and installs the
native messaging host for every Chrome/Edge/Chromium installation it finds.
Works on macOS, Linux, and Windows.
"""

import argparse
import json
import math
import os
import platform
import struct
import subprocess
import sys
import zlib

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HOST_NAME = "com.grok.agent"
HOST_SCRIPT = os.path.join(SCRIPT_DIR, "native-host", "grok_agent_host.py")

# ── Pretty printing ──────────────────────────────────────────────────

CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"

# Disable colours when not a tty (e.g. piped to file)
if not sys.stdout.isatty():
    CYAN = GREEN = YELLOW = RED = BOLD = RESET = ""


def banner():
    print(f"""
{CYAN}{BOLD}╔══════════════════════════════════════════╗
║         Grok Agent  —  Setup             ║
╚══════════════════════════════════════════╝{RESET}
""")


def step(n, text):
    print(f"  {BOLD}[{n}]{RESET} {text}")


def ok(text):
    print(f"      {GREEN}✓{RESET} {text}")


def warn(text):
    print(f"      {YELLOW}!{RESET} {text}")


def fail(text):
    print(f"      {RED}✗{RESET} {text}")


# ══════════════════════════════════════════════════════════════════════
#  ICON GENERATION  (pure Python — no Pillow / no external deps)
# ══════════════════════════════════════════════════════════════════════

def _png_chunk(tag: bytes, data: bytes) -> bytes:
    c = tag + data
    return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)


def _make_png(width: int, height: int, rgba: bytes) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b""
    for y in range(height):
        raw += b"\x00"  # filter=None per row
        raw += rgba[y * width * 4 : (y + 1) * width * 4]
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(raw, 9))
        + _png_chunk(b"IEND", b"")
    )


def _lerp(a, b, t):
    return int(a + (b - a) * t)


def generate_icon(size: int) -> bytes:
    """Render an indigo rounded-rect icon with a '>_' terminal motif."""
    radius = max(1, int(size * 0.22))
    pixels = bytearray()

    # Precompute a tiny ">_" glyph on a boolean grid for sizes >= 48
    glyph = set()
    if size >= 48:
        # ">" character — three rows of a right-pointing chevron
        gh = max(5, size // 6)       # glyph height (pixels)
        gw = max(4, gh)              # glyph width
        ox = size // 2 - gw          # offset x (left-of-centre)
        oy = size // 2 - gh // 2     # offset y (vertically centred)
        for row in range(gh):
            # Chevron ">"
            t = row / max(1, gh - 1)
            col = int(gw * 0.5 * (1 - abs(2 * t - 1)))
            thick = max(1, size // 32)
            for dx in range(thick):
                glyph.add((ox + col + dx, oy + row))
            # Underscore "_"  (bottom quarter)
            if row >= gh - max(1, thick):
                for ux in range(gw):
                    glyph.add((ox + gw + 2 + ux, oy + row))

    for y in range(size):
        for x in range(size):
            # --- rounded-rect mask ---
            inside = True
            corners = [
                (radius, radius),
                (size - 1 - radius, radius),
                (radius, size - 1 - radius),
                (size - 1 - radius, size - 1 - radius),
            ]
            for cx, cy in corners:
                dx = min(x, size - 1 - x) if (
                    (x < radius or x > size - 1 - radius)
                    and (y < radius or y > size - 1 - radius)
                ) else radius
                if dx < radius:
                    # Check which corner
                    if x < radius and y < radius:
                        if (x - radius) ** 2 + (y - radius) ** 2 > radius ** 2:
                            inside = False
                    elif x > size - 1 - radius and y < radius:
                        if (x - (size - 1 - radius)) ** 2 + (y - radius) ** 2 > radius ** 2:
                            inside = False
                    elif x < radius and y > size - 1 - radius:
                        if (x - radius) ** 2 + (y - (size - 1 - radius)) ** 2 > radius ** 2:
                            inside = False
                    elif x > size - 1 - radius and y > size - 1 - radius:
                        if (x - (size - 1 - radius)) ** 2 + (y - (size - 1 - radius)) ** 2 > radius ** 2:
                            inside = False

            if not inside:
                pixels.extend((0, 0, 0, 0))
                continue

            # --- gradient background (#6366f1 → #4f46e5) ---
            t = (x + y) / (2 * size)
            r = _lerp(99, 79, t)
            g = _lerp(102, 70, t)
            b = _lerp(241, 229, t)

            # --- glyph overlay (white) ---
            if (x, y) in glyph:
                r, g, b = 255, 255, 255

            pixels.extend((r, g, b, 255))

    return _make_png(size, size, bytes(pixels))


def create_icons():
    """Write icon16.png, icon48.png, icon128.png into icons/."""
    icons_dir = os.path.join(SCRIPT_DIR, "icons")
    os.makedirs(icons_dir, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(icons_dir, f"icon{size}.png")
        data = generate_icon(size)
        with open(path, "wb") as f:
            f.write(data)
        ok(f"icons/icon{size}.png  ({len(data)} bytes)")


# ══════════════════════════════════════════════════════════════════════
#  NATIVE MESSAGING HOST INSTALLATION
# ══════════════════════════════════════════════════════════════════════

def _find_manifest_dirs():
    """Return a list of (browser_name, dir_path) tuples for NMH manifests."""
    system = platform.system()
    home = os.path.expanduser("~")
    candidates = []

    if system == "Darwin":
        base = os.path.join(home, "Library", "Application Support")
        candidates = [
            ("Chrome",   os.path.join(base, "Google", "Chrome", "NativeMessagingHosts")),
            ("Edge",     os.path.join(base, "Microsoft Edge", "NativeMessagingHosts")),
            ("Chromium", os.path.join(base, "Chromium", "NativeMessagingHosts")),
        ]
    elif system == "Linux":
        cfg = os.path.join(home, ".config")
        candidates = [
            ("Chrome",   os.path.join(cfg, "google-chrome", "NativeMessagingHosts")),
            ("Edge",     os.path.join(cfg, "microsoft-edge", "NativeMessagingHosts")),
            ("Chromium", os.path.join(cfg, "chromium", "NativeMessagingHosts")),
        ]
    elif system == "Windows":
        # On Windows the manifest path is stored in the registry, not in a
        # config dir.  We write the JSON next to the host script and then
        # register it via the registry in a separate step.
        candidates = []

    return candidates


def _windows_registry_install(manifest_path):
    """Register the NMH manifest in the Windows registry for Chrome & Edge."""
    try:
        import winreg
    except ImportError:
        warn("winreg not available — skipping Windows registry setup")
        return

    for sub in (
        rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}",
        rf"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}",
    ):
        try:
            key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, sub)
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)
            winreg.CloseKey(key)
            ok(f"Registry  HKCU\\{sub}")
        except OSError as e:
            fail(f"Registry  HKCU\\{sub}  ({e})")


def _create_bat_wrapper():
    """On Windows, Chrome requires a .bat/.exe — create a wrapper."""
    python_bin = sys.executable
    bat = os.path.join(SCRIPT_DIR, "native-host", "grok_agent_host.bat")
    with open(bat, "w", newline="\r\n") as f:
        f.write(f'@echo off\r\n"{python_bin}" "{HOST_SCRIPT}" %*\r\n')
    ok(f"Batch wrapper  {bat}")
    return bat


def install_native_host(allowed_origins):
    """Install the NMH manifest on the current platform."""
    system = platform.system()

    # Ensure the host script is executable (Unix)
    if system != "Windows":
        os.chmod(HOST_SCRIPT, 0o755)

    # Determine executable path for manifest
    if system == "Windows":
        host_path = _create_bat_wrapper()
    else:
        host_path = HOST_SCRIPT

    manifest_obj = {
        "name": HOST_NAME,
        "description": "Grok Agent Native Messaging Host",
        "path": host_path,
        "type": "stdio",
        "allowed_origins": allowed_origins,
    }
    manifest_json = json.dumps(manifest_obj, indent=2)

    if system == "Windows":
        # Write manifest next to host, register in registry
        mdir = os.path.join(SCRIPT_DIR, "native-host", "manifests")
        os.makedirs(mdir, exist_ok=True)
        mpath = os.path.join(mdir, f"{HOST_NAME}.json")
        with open(mpath, "w") as f:
            f.write(manifest_json)
        ok(f"Manifest  {mpath}")
        _windows_registry_install(mpath)
    else:
        dirs = _find_manifest_dirs()
        if not dirs:
            fail("No supported browser config directories found")
            return
        for browser, dirpath in dirs:
            os.makedirs(dirpath, exist_ok=True)
            mpath = os.path.join(dirpath, f"{HOST_NAME}.json")
            with open(mpath, "w") as f:
                f.write(manifest_json)
            ok(f"{browser:10s}  {mpath}")


# ══════════════════════════════════════════════════════════════════════
#  PYTHON VERSION CHECK
# ══════════════════════════════════════════════════════════════════════

def check_python():
    major, minor = sys.version_info[:2]
    if major < 3 or (major == 3 and minor < 8):
        fail(f"Python 3.8+ required (found {major}.{minor})")
        sys.exit(1)
    ok(f"Python {major}.{minor}")


# ══════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Grok Agent — one-command setup",
    )
    parser.add_argument(
        "--id",
        metavar="EXT_ID",
        help="Chrome extension ID (locks the native host to that extension)",
    )
    parser.add_argument(
        "--auto",
        action="store_true",
        help="Non-interactive mode: allow all extension origins",
    )
    args = parser.parse_args()

    banner()

    # ── Step 1: Python check ─────────────────────────────────────────
    step(1, "Checking Python version")
    check_python()
    print()

    # ── Step 2: Generate icons ───────────────────────────────────────
    step(2, "Generating extension icons")
    create_icons()
    print()

    # ── Step 3: Determine allowed origins ────────────────────────────
    step(3, "Configuring allowed origins")

    ext_id = args.id
    if not ext_id and not args.auto:
        print()
        print(f"      {BOLD}Tip:{RESET} If you've already loaded the extension, paste its ID")
        print(f"      from  chrome://extensions  or  edge://extensions.")
        print(f"      Press {BOLD}Enter{RESET} to allow all origins (fine for personal use).")
        print()
        ext_id = input("      Extension ID (blank = allow all): ").strip()

    if ext_id:
        origins = [f"chrome-extension://{ext_id}/"]
        ok(f"Locked to extension {ext_id}")
    else:
        origins = ["chrome-extension://*/"]
        ok("Allowing all extension origins (re-run with --id <ID> to lock)")
    print()

    # ── Step 4: Install native messaging host ────────────────────────
    step(4, f"Installing native messaging host ({platform.system()})")
    install_native_host(origins)
    print()

    # ── Done ─────────────────────────────────────────────────────────
    print(f"""
{GREEN}{BOLD}  Setup complete!{RESET}

  {BOLD}Next steps:{RESET}
    1. Open {BOLD}chrome://extensions{RESET} or {BOLD}edge://extensions{RESET}
    2. Enable {BOLD}Developer mode{RESET} (toggle in top-right)
    3. Click {BOLD}Load unpacked{RESET} → select this folder:
       {CYAN}{SCRIPT_DIR}{RESET}
    4. A welcome page will open with further instructions
    5. Open {BOLD}https://grok.com{RESET} and start using Agent Mode!
""")


if __name__ == "__main__":
    main()
