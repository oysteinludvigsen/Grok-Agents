Grok Agent — Browser Extension for Agentic Grok Usage
=====================================================

Turn Grok (via your Supergrok subscription) into an agentic coding
assistant that can run shell commands on your local machine directly
from the grok.com chat interface.

Works on Chrome, Edge, and Chromium-based browsers (Manifest V3).


Prerequisites
-------------

  - Python 3.8+  (used by the native messaging host)
  - Google Chrome, Microsoft Edge, or Chromium
  - A Supergrok subscription (grok.com access)


Setup (one command)
-------------------

  1. Open a terminal and navigate to this folder:

       cd grok-agent-extension

  2. Run the setup script:

       python3 setup.py            # macOS / Linux
       python  setup.py            # Windows (PowerShell)

     This will:
       - Generate the extension icons
       - Install the native messaging host for every browser it finds
       - Print next steps

     Options:
       --auto          Fully automatic, no prompts
       --id EXT_ID     Lock the native host to a specific extension ID

  3. Load the extension in your browser:

       - Open  chrome://extensions  or  edge://extensions
       - Enable "Developer mode" (toggle, top-right corner)
       - Click "Load unpacked"
       - Select this folder (grok-agent-extension)

  4. A welcome page will open automatically. Click "Re-check" to verify
     the native host is connected (green dot = good).

  5. Open https://grok.com and paste the template prompt (see below).


Template Prompt
---------------

  A full prompt is provided in  GROK_TEMPLATE_PROMPT.md.

  Copy its entire contents and paste it as the first message in a new
  Grok conversation, or save it as a Grok template for quick reuse.

  This prompt teaches Grok the tool-call format:

    ```agent:shell
    <your command>
    ```

  The extension detects these blocks, executes the command locally, and
  feeds stdout/stderr back into the chat so Grok can continue working.


File Overview
-------------

  manifest.json              Manifest V3 extension manifest
  background.js              Service worker (bridges content ↔ native host)
  content.js                 Content script injected into grok.com
  content.css                Styles for the floating panel & dialogs
  popup.html / .js / .css    Extension popup (settings UI)
  welcome.html               Onboarding page shown on first install
  setup.py                   One-command installer (icons + native host)
  GROK_TEMPLATE_PROMPT.md    System prompt to paste into Grok

  native-host/
    grok_agent_host.py       Python native messaging host
    install.sh               Standalone macOS/Linux installer (alternative)
    install.ps1              Standalone Windows installer (alternative)


How It Works
------------

  1. You paste the template prompt into a Grok conversation.
  2. You give Grok a task (e.g. "set up a Node.js project").
  3. Grok outputs an  agent:shell  code block with a command.
  4. The content script detects the block and shows a confirmation dialog
     (unless auto-execute is enabled in settings).
  5. The command is sent to the Python native messaging host, which
     executes it in your configured working directory.
  6. stdout, stderr, and the exit code are formatted as an  agent:result
     block and injected back into the chat automatically.
  7. Grok reads the result and decides its next step — agentic loop.


Settings (extension popup)
--------------------------

  Working Directory     Where commands run (default: ~/grok-workspace)
  Shell                 auto / zsh / bash / powershell / pwsh
  Command Timeout       Max seconds per command (default: 30)
  Max Output Size       Truncate output beyond this (default: 50 000 chars)
  Auto-execute          Skip confirmation dialogs (use with caution)


Troubleshooting
---------------

  "Disconnected" in the welcome page or floating panel:
    - Make sure you ran  python3 setup.py  first.
    - Restart the browser after running setup.
    - Check that Python 3 is on your PATH.

  Commands time out immediately:
    - Increase the timeout in the extension popup.
    - Check that the configured shell exists on your system.

  Extension not injecting into grok.com:
    - Verify the extension is enabled in chrome://extensions.
    - Check that host_permissions include grok.com and x.com.
    - Reload the grok.com page after enabling the extension.

  To lock down the native host to your specific extension ID:
    - Find the ID in chrome://extensions (e.g. "abcdef1234567890")
    - Re-run:  python3 setup.py --id abcdef1234567890


Security Notes
--------------

  This extension executes arbitrary shell commands on your machine.

  - By default, every command requires explicit confirmation via a dialog.
  - Only enable auto-execute if you trust Grok's output completely.
  - The native host only accepts connections from chrome-extension://
    origins. Run setup.py --id <ID> to restrict it to your extension.
  - All executed commands are logged in the floating panel on grok.com.
