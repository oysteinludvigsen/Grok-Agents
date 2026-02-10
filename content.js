/**
 * Grok Agent — Content Script
 *
 * Injected into grok.com pages. Watches for Grok's responses containing
 * agent tool-call code blocks, executes them via the native host, and
 * injects results back into the conversation.
 *
 * Tool-call format (output by Grok):
 *
 *   ```agent-shell
 *   ls -la
 *   ```
 *
 *   ```agent-read
 *   /path/to/file
 *   ```
 *
 *   ```agent-write
 *   /path/to/file
 *   file contents here
 *   ```
 */

(() => {
  "use strict";

  const PROCESSED = "data-ga-processed";
  const DEBOUNCE_MS = 1_200;
  const INJECT_DELAY_MS = 400;
  const BETWEEN_BLOCKS_MS = 2_500;

  /* ---------------------------------------------------------------- */
  /*  Settings (synced from storage)                                   */
  /* ---------------------------------------------------------------- */

  let settings = {
    workingDir: "~/grok-workspace",
    shell: "auto",
    autoExecute: false,
    timeout: 30_000,
    maxOutputSize: 50_000,
  };

  chrome.runtime.sendMessage({ type: "getSettings" }, (res) => {
    if (res) {
      Object.assign(settings, res);
      updatePanelCwd();
      // Sync the auto-execute checkbox if the panel already exists
      const cb = document.getElementById("ga-auto-exec");
      if (cb) cb.checked = settings.autoExecute;
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in settings) settings[key] = newValue;
    }
    updatePanelCwd();
  });

  /* ================================================================ */
  /*  FLOATING PANEL                                                   */
  /* ================================================================ */

  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "grok-agent-panel";
    panel.innerHTML = `
      <div class="ga-header" id="ga-drag-handle">
        <span class="ga-indicator" id="ga-indicator"></span>
        <span class="ga-title">Grok Agent</span>
        <button class="ga-minimize" id="ga-min-btn" title="Minimize">\u2212</button>
      </div>
      <div class="ga-body" id="ga-body">
        <div class="ga-status" id="ga-status">Checking connection\u2026</div>
        <div class="ga-cwd" id="ga-cwd"></div>
        <label class="ga-toggle">
          <input type="checkbox" id="ga-auto-exec" />
          <span>Auto-execute</span>
        </label>
        <button id="ga-scan-btn" class="ga-btn">Scan &amp; Execute</button>
        <div id="ga-log" class="ga-log"></div>
      </div>`;
    document.body.appendChild(panel);

    // Minimize
    document.getElementById("ga-min-btn").addEventListener("click", () => {
      panel.classList.toggle("ga-minimized");
    });

    // Auto-execute toggle
    const autoBox = document.getElementById("ga-auto-exec");
    autoBox.checked = settings.autoExecute;
    autoBox.addEventListener("change", (e) => {
      settings.autoExecute = e.target.checked;
      chrome.runtime.sendMessage({
        type: "saveSettings",
        payload: { autoExecute: e.target.checked },
      });
    });

    // Manual scan
    document.getElementById("ga-scan-btn").addEventListener("click", scanAndExecute);

    // Dragging
    makeDraggable(panel, document.getElementById("ga-drag-handle"));

    // Initial status
    checkConnection();
    updatePanelCwd();
  }

  function makeDraggable(el, handle) {
    let startX, startY, startLeft, startTop;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      const onMove = (ev) => {
        el.style.left = `${startLeft + ev.clientX - startX}px`;
        el.style.top = `${startTop + ev.clientY - startY}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  async function checkConnection() {
    const indicator = document.getElementById("ga-indicator");
    const status = document.getElementById("ga-status");
    if (!indicator) return;
    try {
      const res = await sendMsg({ type: "ping" });
      if (res?.connected) {
        status.textContent = `Connected (v${res.version ?? "?"})`;
        indicator.className = "ga-indicator ga-connected";
      } else {
        status.textContent = `Disconnected: ${res?.stderr || "host not found"}`;
        indicator.className = "ga-indicator ga-disconnected";
      }
    } catch {
      status.textContent = "Disconnected";
      indicator.className = "ga-indicator ga-disconnected";
    }
  }

  function updatePanelCwd() {
    const el = document.getElementById("ga-cwd");
    if (el) el.textContent = `Working dir: ${settings.workingDir}`;
  }

  function appendLog(text, type = "info") {
    const log = document.getElementById("ga-log");
    if (!log) return;
    const entry = document.createElement("div");
    entry.className = `ga-log-entry ${type}`;
    entry.textContent = text;
    log.prepend(entry);
    while (log.children.length > 50) log.lastChild.remove();
  }

  /* ================================================================ */
  /*  AGENT BLOCK DETECTION                                            */
  /* ================================================================ */

  /**
   * Recognised language-tag values.  Maps tag → tool name.
   * Hyphens used (agent-shell, not agent:shell) to survive code-block
   * renderers that strip or split on colons.
   */
  const TAG_MAP = {
    "agent-shell": "shell",
    "agent-read":  "read",
    "agent-write": "write",
    // Legacy colon forms (in case renderer keeps them):
    "agent:shell": "shell",
    "agent:read":  "read",
    "agent:write": "write",
    // Bare "agent" defaults to shell:
    "agent":       "shell",
  };

  /** Try to parse a language tag string into { tool }.
   *  Returns null if the string is not an agent tag. */
  function parseLang(raw) {
    if (!raw) return null;
    const s = raw.trim().toLowerCase();
    if (TAG_MAP[s] !== undefined) return { tool: TAG_MAP[s] };
    // Prefix match for tags like "agent-shell" that might have trailing text
    for (const [tag, tool] of Object.entries(TAG_MAP)) {
      if (s.startsWith(tag)) return { tool };
    }
    return null;
  }

  /**
   * Scans the page for unprocessed agent code blocks.
   *
   * Uses multiple strategies to handle grok.com's DOM rendering:
   *   1. CSS class on <code> (language-agent-shell, etc.)
   *   2. Language label element near a <pre>/<code> block
   *   3. Any element whose text starts with "agent-shell" etc.
   *   4. Broad scan of all elements for smallest match
   *   5. Raw text fences in message containers
   */
  function findAgentBlocks() {
    const blocks = [];
    const seen = new Set();

    function add(element, tool, content) {
      if (!content) return;
      const key = `${tool}|${content}`;
      if (seen.has(key)) return;
      if (element.hasAttribute(PROCESSED)) return;
      seen.add(key);
      blocks.push({ element, tool, arg: null, content });
    }

    // ── Strategy 1: <code class="language-agent-*"> ─────────────────
    for (const el of document.querySelectorAll('code[class*="language-agent"]')) {
      if (el.hasAttribute(PROCESSED)) continue;
      const cls = [...el.classList].find((c) => c.startsWith("language-agent"));
      const parsed = parseLang(cls?.replace("language-", ""));
      if (!parsed) continue;
      add(el, parsed.tool, el.textContent.trim());
    }

    // ── Strategy 2: language label near <pre> / <code> ──────────────
    //    grok.com often renders: <div>...<span>agent-shell</span>...<pre><code>
    for (const pre of document.querySelectorAll("pre")) {
      if (pre.hasAttribute(PROCESSED)) continue;
      if (blocks.some((b) => pre.contains(b.element))) continue;

      const container = pre.parentElement;
      if (!container) continue;

      let parsed = null;
      for (const node of container.querySelectorAll("span, div, button, [class*='lang'], [class*='code'], [class*='header']")) {
        if (pre.contains(node)) continue;
        const txt = node.textContent.trim().toLowerCase();
        parsed = parseLang(txt);
        if (parsed) break;
      }
      if (!parsed) continue;

      const code = pre.querySelector("code") || pre;
      add(code, parsed.tool, code.textContent.trim());
    }

    // ── Strategy 3: text content of <pre>/<code> starting with agent- tag ──
    for (const el of document.querySelectorAll("pre code, pre, code")) {
      if (el.hasAttribute(PROCESSED)) continue;
      if (blocks.some((b) => b.element === el || el.contains(b.element))) continue;
      const text = el.textContent;
      const m = text.match(/^(agent[-:](shell|read|write))\s*\n([\s\S]+)$/);
      if (!m) continue;
      add(el, m[2], m[3].trim());
    }

    // ── Strategy 4: broad scan — any element whose trimmed text ─────
    //    starts with an agent tag followed by a newline.
    //    We pick the SMALLEST (most specific) matching element.
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.hasAttribute(PROCESSED)) return NodeFilter.FILTER_REJECT;
        if (blocks.some((b) => b.element === node)) return NodeFilter.FILTER_SKIP;
        const text = node.textContent;
        if (!text) return NodeFilter.FILTER_SKIP;
        const trimmed = text.trimStart();
        if (/^agent[-:](shell|read|write)\s*\n/i.test(trimmed)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) candidates.push(n);

    // Keep only leaf-most (smallest) matches — reject any ancestor of another candidate
    const leafCandidates = candidates.filter(
      (c) => !candidates.some((other) => other !== c && c.contains(other))
    );
    for (const el of leafCandidates) {
      if (el.hasAttribute(PROCESSED)) continue;
      if (blocks.some((b) => b.element === el)) continue;
      const text = el.textContent.trimStart();
      const m = text.match(/^agent[-:](shell|read|write)\s*\n([\s\S]+)$/i);
      if (!m) continue;
      add(el, m[1].toLowerCase(), m[2].trim());
    }

    // ── Strategy 5: raw text fences in message containers ───────────
    for (const msgEl of document.querySelectorAll(
      '[class*="message"], [class*="Message"], [data-message-author-role="assistant"], [data-testid*="message"]'
    )) {
      const raw = msgEl.textContent;
      const re = /```agent[-:](shell|read|write)\s*\n([\s\S]*?)```/gi;
      let match;
      while ((match = re.exec(raw)) !== null) {
        add(msgEl, match[1].toLowerCase(), match[2].trim());
      }
    }

    return blocks;
  }

  /* ================================================================ */
  /*  COMMAND EXECUTION                                                */
  /* ================================================================ */

  async function executeCommand(command, cwd) {
    appendLog(`$ ${command}`, "cmd");
    const result = await sendMsg({
      type: "exec",
      payload: {
        action: "exec",
        command,
        cwd: cwd || settings.workingDir,
        shell: settings.shell,
        timeout: settings.timeout,
      },
    });
    if (result?.error) {
      appendLog(`Error: ${result.stderr}`, "error");
    } else {
      const preview = (result.stdout || result.stderr || "").substring(0, 200);
      appendLog(
        `Exit ${result.exitCode}: ${preview}`,
        result.exitCode === 0 ? "success" : "error"
      );
    }
    return result;
  }

  /* ================================================================ */
  /*  SCAN & EXECUTE LOOP                                              */
  /* ================================================================ */

  let executing = false;

  async function scanAndExecute() {
    if (executing) {
      appendLog("Already executing, skipping scan", "info");
      return;
    }
    executing = true;
    try {
      const blocks = findAgentBlocks();
      if (blocks.length === 0) {
        appendLog("No new agent blocks found", "info");
        return;
      }
      appendLog(`Found ${blocks.length} agent block(s)`, "info");

      for (const block of blocks) {
        block.element.setAttribute(PROCESSED, "true");
        markBlock(block.element, "processing");

        if (!settings.autoExecute) {
          const ok = await confirmExecution(block);
          if (!ok) {
            markBlock(block.element, "skipped");
            appendLog(`Skipped: ${block.content.substring(0, 60)}`, "info");
            continue;
          }
        }

        let result;
        switch (block.tool) {
          case "shell":
            result = await executeCommand(block.content, block.arg);
            break;
          case "read":
            result = await executeCommand(`cat -- "${block.content}"`, block.arg);
            break;
          case "write": {
            // First line of content is the file path, rest is file body
            const nlIdx = block.content.indexOf("\n");
            const fp = nlIdx > -1 ? block.content.substring(0, nlIdx).trim() : null;
            const body = nlIdx > -1 ? block.content.substring(nlIdx + 1) : "";
            if (!fp) {
              result = { exitCode: 1, stdout: "", stderr: "No file path specified for write (first line must be the path)" };
              break;
            }
            const delim = "GROK_AGENT_EOF_" + Math.random().toString(36).slice(2, 8);
            result = await executeCommand(
              `cat << '${delim}' > "${fp}"\n${body}\n${delim}`,
              null
            );
            break;
          }
          default:
            result = { exitCode: 1, stdout: "", stderr: `Unknown tool: ${block.tool}` };
        }

        markBlock(block.element, result.exitCode === 0 ? "success" : "error");
        await injectResult(result);
        await delay(BETWEEN_BLOCKS_MS);
      }
    } finally {
      executing = false;
    }
  }

  /* ================================================================ */
  /*  RESULT INJECTION                                                 */
  /* ================================================================ */

  function formatResult(result) {
    const parts = [`Exit code: ${result.exitCode}`];
    if (result.stdout) {
      let s = result.stdout;
      if (s.length > settings.maxOutputSize)
        s = s.substring(0, settings.maxOutputSize) + "\n\u2026 [truncated]";
      parts.push(`STDOUT:\n${s}`);
    }
    if (result.stderr) {
      let s = result.stderr;
      if (s.length > settings.maxOutputSize)
        s = s.substring(0, settings.maxOutputSize) + "\n\u2026 [truncated]";
      parts.push(`STDERR:\n${s}`);
    }
    return "```agent-result\n" + parts.join("\n\n") + "\n```";
  }

  async function injectResult(result) {
    const input = findInput();
    if (!input) {
      appendLog("Cannot find chat input", "error");
      return;
    }
    const text = formatResult(result);
    await typeAndSend(input, text);
  }

  /* ================================================================ */
  /*  DOM INTERACTION HELPERS                                          */
  /* ================================================================ */

  function findInput() {
    const selectors = [
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="ask"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="Type"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      "textarea",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  function findSendButton() {
    for (const sel of [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[data-testid*="send"]',
      'button[type="submit"]',
    ]) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) return btn;
    }
    // Heuristic: look for enabled buttons near the input
    for (const btn of document.querySelectorAll("button")) {
      const svg = btn.querySelector("svg");
      if (svg && !btn.disabled && btn.closest("form, [class*='input'], [class*='Input']")) {
        return btn;
      }
    }
    return null;
  }

  async function typeAndSend(input, text) {
    input.focus();

    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      // React-compatible value setter
      const setter =
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set ??
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // contenteditable
      input.textContent = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }

    await delay(INJECT_DELAY_MS);

    const btn = findSendButton();
    if (btn) {
      btn.removeAttribute("disabled");
      btn.click();
    } else {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
    }
  }

  /* ================================================================ */
  /*  CONFIRMATION DIALOG                                              */
  /* ================================================================ */

  function confirmExecution(block) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "ga-confirm-overlay";
      overlay.innerHTML = `
        <div class="ga-confirm-dialog">
          <h3>Grok Agent \u2014 Execute command?</h3>
          <div class="ga-confirm-tool">Tool: <strong>${esc(block.tool)}</strong></div>
          ${block.arg ? `<div class="ga-confirm-arg">Path: ${esc(block.arg)}</div>` : ""}
          <pre class="ga-confirm-cmd">${esc(block.content)}</pre>
          <div class="ga-confirm-actions">
            <button class="ga-btn ga-btn-danger" id="ga-conf-no">Deny</button>
            <button class="ga-btn ga-btn-ok" id="ga-conf-yes">Execute</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      overlay.querySelector("#ga-conf-no").addEventListener("click", () => { overlay.remove(); resolve(false); });
      overlay.querySelector("#ga-conf-yes").addEventListener("click", () => { overlay.remove(); resolve(true); });

      // Allow Escape to cancel
      const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); resolve(false); document.removeEventListener("keydown", onKey); } };
      document.addEventListener("keydown", onKey);
    });
  }

  /* ================================================================ */
  /*  MUTATION OBSERVER — auto-detect new agent blocks                 */
  /* ================================================================ */

  function startObserver() {
    let timer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const blocks = findAgentBlocks();
        if (blocks.length === 0) return;
        if (settings.autoExecute) {
          scanAndExecute();
        } else {
          // Highlight pending blocks so the user notices them
          blocks.forEach((b) => {
            if (!b.element.hasAttribute(PROCESSED)) markBlock(b.element, "pending");
          });
          appendLog(`${blocks.length} pending block(s) — click Scan & Execute`, "info");
        }
      }, DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return observer;
  }

  /* ================================================================ */
  /*  UTILITIES                                                        */
  /* ================================================================ */

  function sendMsg(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function markBlock(el, state) {
    const target = el.closest("pre") ?? el;
    // Remove previous state classes
    target.classList.remove("ga-block-pending", "ga-block-processing", "ga-block-success", "ga-block-error", "ga-block-skipped");
    target.classList.add(`ga-block-${state}`);
  }

  /* ================================================================ */
  /*  INIT                                                             */
  /* ================================================================ */

  function init() {
    createPanel();
    startObserver();
    appendLog("Grok Agent initialized", "info");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
