#!/usr/bin/env python3
"""
Grok Agent — One-Command Setup

    python3 setup.py                              # interactive
    python3 setup.py --auto                       # fully automatic
    python3 setup.py --dir ~/MyGrokAgent          # custom install path
    python3 setup.py --id <EXTENSION_ID>          # lock to one extension

Everything in one script: picks an install directory, copies the
extension files there, generates icons, and installs the native
messaging host for every Chrome / Edge / Chromium it finds.
Works on macOS, Linux, and Windows.  No external dependencies.
"""

import argparse
import json
import os
import platform
import shutil
import struct
import sys
import zlib

HOST_NAME = "com.grok.agent"

# Directory where this script lives (= the source tree)
SOURCE_DIR = os.path.dirname(os.path.abspath(__file__))

# Files that make up the browser extension (relative to SOURCE_DIR)
EXTENSION_FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "content.css",
    "popup.html",
    "popup.js",
    "popup.css",
    "welcome.html",
    "GROK_TEMPLATE_PROMPT.md",
    "readme.txt",
    "setup.py",
    os.path.join("native-host", "grok_agent_host.py"),
    os.path.join("native-host", "install.sh"),
    os.path.join("native-host", "install.ps1"),
]


# ══════════════════════════════════════════════════════════════════════
#  PRETTY PRINTING
# ══════════════════════════════════════════════════════════════════════

CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"

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
        raw += b"\x00"
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

    glyph = set()
    if size >= 48:
        gh = max(5, size // 6)
        gw = max(4, gh)
        ox = size // 2 - gw
        oy = size // 2 - gh // 2
        for row in range(gh):
            t = row / max(1, gh - 1)
            col = int(gw * 0.5 * (1 - abs(2 * t - 1)))
            thick = max(1, size // 32)
            for dx in range(thick):
                glyph.add((ox + col + dx, oy + row))
            if row >= gh - max(1, thick):
                for ux in range(gw):
                    glyph.add((ox + gw + 2 + ux, oy + row))

    for y in range(size):
        for x in range(size):
            inside = True
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

            t = (x + y) / (2 * size)
            r = _lerp(99, 79, t)
            g = _lerp(102, 70, t)
            b = _lerp(241, 229, t)

            if (x, y) in glyph:
                r, g, b = 255, 255, 255

            pixels.extend((r, g, b, 255))

    return _make_png(size, size, bytes(pixels))


def create_icons(install_dir):
    """Write icon PNGs into <install_dir>/icons/."""
    icons_dir = os.path.join(install_dir, "icons")
    os.makedirs(icons_dir, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(icons_dir, f"icon{size}.png")
        data = generate_icon(size)
        with open(path, "wb") as f:
            f.write(data)
        ok(f"icon{size}.png  ({len(data)} bytes)")


# ══════════════════════════════════════════════════════════════════════
#  FILE INSTALLATION
# ══════════════════════════════════════════════════════════════════════

def default_install_dir():
    """Return a platform-appropriate default install location."""
    system = platform.system()
    if system == "Windows":
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
        return os.path.join(base, "GrokAgent")
    return os.path.join(os.path.expanduser("~"), "GrokAgent")


def copy_extension_files(install_dir):
    """Copy all extension files from SOURCE_DIR to install_dir.

    If install_dir is already the source directory, skip the copy.
    """
    src = os.path.realpath(SOURCE_DIR)
    dst = os.path.realpath(install_dir)

    if src == dst:
        ok("Already running from install directory — no copy needed")
        return

    os.makedirs(install_dir, exist_ok=True)

    for relpath in EXTENSION_FILES:
        src_file = os.path.join(SOURCE_DIR, relpath)
        dst_file = os.path.join(install_dir, relpath)
        if not os.path.isfile(src_file):
            warn(f"Source file missing, skipped: {relpath}")
            continue
        os.makedirs(os.path.dirname(dst_file), exist_ok=True)
        shutil.copy2(src_file, dst_file)

    ok(f"Copied {len(EXTENSION_FILES)} files to {install_dir}")


# ══════════════════════════════════════════════════════════════════════
#  NATIVE MESSAGING HOST INSTALLATION
# ══════════════════════════════════════════════════════════════════════

def _find_manifest_dirs():
    system = platform.system()
    home = os.path.expanduser("~")

    if system == "Darwin":
        base = os.path.join(home, "Library", "Application Support")
        return [
            ("Chrome",   os.path.join(base, "Google", "Chrome", "NativeMessagingHosts")),
            ("Edge",     os.path.join(base, "Microsoft Edge", "NativeMessagingHosts")),
            ("Chromium", os.path.join(base, "Chromium", "NativeMessagingHosts")),
        ]
    if system == "Linux":
        cfg = os.path.join(home, ".config")
        return [
            ("Chrome",   os.path.join(cfg, "google-chrome", "NativeMessagingHosts")),
            ("Edge",     os.path.join(cfg, "microsoft-edge", "NativeMessagingHosts")),
            ("Chromium", os.path.join(cfg, "chromium", "NativeMessagingHosts")),
        ]
    return []


def _windows_registry_install(manifest_path):
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


def install_native_host(install_dir, allowed_origins):
    """Install NMH manifest pointing at <install_dir>/native-host/..."""
    system = platform.system()
    host_script = os.path.join(install_dir, "native-host", "grok_agent_host.py")

    # Unix: mark executable
    if system != "Windows":
        os.chmod(host_script, 0o755)
        host_path = host_script
    else:
        # Windows: Chrome requires a .bat wrapper
        python_bin = sys.executable
        bat = os.path.join(install_dir, "native-host", "grok_agent_host.bat")
        with open(bat, "w", newline="\r\n") as f:
            f.write(f'@echo off\r\n"{python_bin}" "{host_script}" %*\r\n')
        ok(f"Batch wrapper  {bat}")
        host_path = bat

    manifest_obj = {
        "name": HOST_NAME,
        "description": "Grok Agent Native Messaging Host",
        "path": host_path,
        "type": "stdio",
        "allowed_origins": allowed_origins,
    }
    manifest_json = json.dumps(manifest_obj, indent=2)

    if system == "Windows":
        mdir = os.path.join(install_dir, "native-host", "manifests")
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
#  MAIN
# ══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Grok Agent — one-command setup")
    parser.add_argument(
        "--dir", metavar="PATH",
        help="Install the extension to this directory (default: ~/GrokAgent)",
    )
    parser.add_argument(
        "--id", metavar="EXT_ID",
        help="Lock the native host to a specific Chrome extension ID",
    )
    parser.add_argument(
        "--auto", action="store_true",
        help="Non-interactive: use all defaults, no prompts",
    )
    args = parser.parse_args()

    banner()

    # ── Step 1: Python check ─────────────────────────────────────────
    step(1, "Checking Python version")
    major, minor = sys.version_info[:2]
    if major < 3 or (major == 3 and minor < 8):
        fail(f"Python 3.8+ required (found {major}.{minor})")
        sys.exit(1)
    ok(f"Python {major}.{minor}")
    print()

    # ── Step 2: Choose install directory ──────────────────────────────
    step(2, "Choosing install directory")
    default_dir = default_install_dir()

    if args.dir:
        install_dir = os.path.abspath(os.path.expanduser(args.dir))
    elif args.auto:
        install_dir = default_dir
    else:
        print()
        print(f"      The extension files will be copied to a permanent folder.")
        print(f"      Chrome / Edge will load the extension from this location.")
        print()
        answer = input(f"      Install directory [{BOLD}{default_dir}{RESET}]: ").strip()
        install_dir = os.path.abspath(os.path.expanduser(answer)) if answer else default_dir

    ok(f"{install_dir}")
    print()

    # ── Step 3: Copy / install files ─────────────────────────────────
    step(3, "Installing extension files")
    copy_extension_files(install_dir)
    print()

    # ── Step 4: Generate icons ───────────────────────────────────────
    step(4, "Generating extension icons")
    create_icons(install_dir)
    print()

    # ── Step 5: Allowed origins ──────────────────────────────────────
    step(5, "Configuring allowed origins")

    ext_id = args.id
    if not ext_id and not args.auto:
        print()
        print(f"      {BOLD}Tip:{RESET} If you already loaded the extension, paste its ID from")
        print(f"      chrome://extensions  or  edge://extensions.")
        print(f"      Press {BOLD}Enter{RESET} to skip (fine for personal use).")
        print()
        ext_id = input("      Extension ID (blank = allow all): ").strip()

    if ext_id:
        origins = [f"chrome-extension://{ext_id}/"]
        ok(f"Locked to extension {ext_id}")
    else:
        origins = ["chrome-extension://*/"]
        ok("Allowing all extension origins (re-run with --id <ID> to lock)")
    print()

    # ── Step 6: Install native messaging host ────────────────────────
    step(6, f"Installing native messaging host ({platform.system()})")
    install_native_host(install_dir, origins)
    print()

    # ── Done ─────────────────────────────────────────────────────────
    print(f"""
{GREEN}{BOLD}  Setup complete!{RESET}

  {BOLD}What to do now:{RESET}
    1. Open {BOLD}chrome://extensions{RESET} or {BOLD}edge://extensions{RESET}
    2. Enable {BOLD}Developer mode{RESET}  (toggle in the top-right)
    3. Click {BOLD}"Load unpacked"{RESET}  and select:

       {CYAN}{install_dir}{RESET}

    4. A welcome page opens automatically — verify the green dot
    5. Go to {BOLD}https://grok.com{RESET} and start using Agent Mode!

  To re-run setup later (e.g. to change the extension ID):
    python3 "{os.path.join(install_dir, 'setup.py')}"
""")


if __name__ == "__main__":
    main()
