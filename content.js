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

  // Load settings directly from storage (no roundtrip through background.js,
  // which may still be waking up in MV3).
  chrome.storage.local.get(Object.keys(settings), (stored) => {
    if (stored) Object.assign(settings, stored);
    updatePanelCwd();
    const cb = document.getElementById("ga-auto-exec");
    if (cb) cb.checked = settings.autoExecute;
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
      chrome.storage.local.set({ autoExecute: e.target.checked });
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
    "agent:shell": "shell",
    "agent:read":  "read",
    "agent:write": "write",
    "agent":       "shell",
  };
  const AGENT_TAG_SET = new Set(Object.keys(TAG_MAP));

  /** Try to parse a language tag string into { tool }.
   *  Returns null if the string is not an agent tag. */
  function parseLang(raw) {
    if (!raw) return null;
    const s = raw.trim().toLowerCase();
    if (TAG_MAP[s] !== undefined) return { tool: TAG_MAP[s] };
    for (const [tag, tool] of Object.entries(TAG_MAP)) {
      if (s.startsWith(tag)) return { tool };
    }
    return null;
  }

  /**
   * Scans the page for unprocessed agent code blocks.
   *
   * Primary strategy (label-first):
   *   grok.com renders code blocks with the language label ("agent-shell")
   *   and the code content ("pwd && ls") in SEPARATE DOM elements.
   *   We find label elements first, then walk up the DOM to locate the
   *   associated code content in a sibling branch.
   *
   * Fallback strategies for other renderers:
   *   - CSS class "language-agent-*" on <code>
   *   - Text starting with "agent-shell\n" in <pre>/<code>
   *   - Raw ```agent-shell ...``` fences in message containers
   */
  /**
   * Describe an element briefly for debug logging.
   */
  function describeEl(el) {
    if (!el) return "(null)";
    const tag = el.tagName?.toLowerCase() ?? "?";
    const cls = el.className ? `.${[...el.classList].join(".")}` : "";
    const id = el.id ? `#${el.id}` : "";
    return `<${tag}${id}${cls}>`;
  }

  function findAgentBlocks(debug = false) {
    const blocks = [];
    const seen = new Set();
    const log = debug ? (...a) => appendLog(a.join(" "), "info") : () => {};

    function add(element, tool, content) {
      if (!content) return;
      const key = `${tool}|${content}`;
      if (seen.has(key)) return;
      if (element.hasAttribute(PROCESSED)) return;
      seen.add(key);
      blocks.push({ element, tool, arg: null, content });
    }

    // ── Primary: Label-first detection ──────────────────────────────
    //
    // grok.com renders code blocks with the language label ("agent-shell")
    // and code content in SEPARATE DOM elements.  We find the label first,
    // then walk up the DOM to locate the code content in a sibling branch.

    // Step 1: find ALL elements on the page that contain the text "agent-"
    //         and are small enough to be a label (not a huge container).
    const labelEls = [];
    const allEls = document.querySelectorAll("*");
    for (const el of allEls) {
      // Skip our own panel
      if (el.closest("#grok-agent-panel")) continue;
      const t = el.textContent;
      if (!t) continue;
      const trimmed = t.trim().toLowerCase();
      // Match exact agent tags
      if (AGENT_TAG_SET.has(trimmed) && trimmed.length < 30) {
        // Ensure it's a leaf-ish label: no large sub-trees
        if (!el.querySelector("pre, code, textarea, table")) {
          labelEls.push(el);
        }
      }
    }

    // Deduplicate: keep only the innermost (smallest) elements
    const leafLabels = labelEls.filter(
      (el) => !labelEls.some((other) => other !== el && el.contains(other))
    );

    if (debug) {
      log(`[diag] Found ${leafLabels.length} label element(s) matching agent tags`);
      for (const el of leafLabels) {
        const chain = [];
        let p = el;
        for (let i = 0; i < 6 && p; i++) { chain.push(describeEl(p)); p = p.parentElement; }
        log(`[diag] label: ${describeEl(el)} text="${el.textContent.trim()}" chain=${chain.join(" > ")}`);
        // Show siblings
        const parent = el.parentElement;
        if (parent) {
          log(`[diag]   parent ${describeEl(parent)} has ${parent.children.length} children:`);
          for (let i = 0; i < Math.min(parent.children.length, 8); i++) {
            const c = parent.children[i];
            const txt = c.textContent.trim().substring(0, 80);
            log(`[diag]   [${i}] ${describeEl(c)} text="${txt}"`);
          }
        }
      }
    }

    for (const labelEl of leafLabels) {
      if (labelEl.hasAttribute(PROCESSED)) continue;
      const parsed = parseLang(labelEl.textContent.trim());
      if (!parsed) continue;

      // Walk up level by level looking for code content
      let codeText = null;
      let codeEl = null;
      let searchRoot = labelEl.parentElement;

      for (let depth = 0; depth < 6 && searchRoot && !codeEl; depth++) {
        if (debug) log(`[diag] depth=${depth} searchRoot=${describeEl(searchRoot)} children=${searchRoot.children.length}`);

        for (const child of searchRoot.children) {
          if (child === labelEl || child.contains(labelEl)) continue;
          if (child.hasAttribute(PROCESSED)) continue;

          // Try standard code elements inside this child first
          const innerCode =
            child.querySelector("pre code") ||
            child.querySelector("pre") ||
            child.querySelector("code") ||
            child.querySelector('[class*="code"]');
          if (innerCode) {
            const t = innerCode.textContent.trim();
            if (debug) log(`[diag]   innerCode ${describeEl(innerCode)} text="${t.substring(0, 60)}"`);
            if (t && !AGENT_TAG_SET.has(t.toLowerCase())) {
              codeText = t;
              codeEl = innerCode;
              break;
            }
          }

          // Fallback: the child itself holds the code as plain text
          const ct = child.textContent.trim();
          if (!ct || ct.length < 1) continue;
          if (ct.toLowerCase() === "copy") continue;
          if (AGENT_TAG_SET.has(ct.toLowerCase())) continue;
          if (child.tagName === "BUTTON") continue;
          if (child.children.length === 1 && child.children[0].tagName === "BUTTON") continue;

          if (debug) log(`[diag]   plain-text candidate ${describeEl(child)} text="${ct.substring(0, 60)}"`);

          codeText = ct;
          codeEl = child;
          break;
        }

        searchRoot = searchRoot.parentElement;
      }

      if (codeText && codeEl) {
        if (debug) log(`[diag] MATCHED: tool=${parsed.tool} code="${codeText.substring(0, 60)}"`);
        add(codeEl, parsed.tool, codeText);
      } else if (debug) {
        log(`[diag] NO CODE FOUND for label "${labelEl.textContent.trim()}"`);
      }
    }

    // ── Fallback 1: <code class="language-agent-*"> ─────────────────
    for (const el of document.querySelectorAll('code[class*="language-agent"]')) {
      if (el.hasAttribute(PROCESSED)) continue;
      const cls = [...el.classList].find((c) => c.startsWith("language-agent"));
      const parsed = parseLang(cls?.replace("language-", ""));
      if (!parsed) continue;
      add(el, parsed.tool, el.textContent.trim());
    }

    // ── Fallback 2: text in <pre>/<code> starting with agent tag ────
    for (const el of document.querySelectorAll("pre code, pre, code")) {
      if (el.hasAttribute(PROCESSED)) continue;
      if (blocks.some((b) => b.element === el || el.contains(b.element))) continue;
      const text = el.textContent;
      const m = text.match(/^(agent[-:](shell|read|write))\s*\n([\s\S]+)$/);
      if (!m) continue;
      add(el, m[2], m[3].trim());
    }

    // ── Fallback 3: raw text fences in message containers ───────────
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
      let blocks = findAgentBlocks();
      if (blocks.length === 0) {
        appendLog("No blocks found — running diagnostics…", "info");
        blocks = findAgentBlocks(true);   // re-run with debug logging
        if (blocks.length === 0) {
          appendLog("No new agent blocks found", "info");
          return;
        }
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
