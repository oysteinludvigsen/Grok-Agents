/**
 * Grok Agent — Popup Script
 */

const $ = (sel) => document.querySelector(sel);

const FIELDS = {
  workingDir:   "#working-dir",
  shell:        "#shell-select",
  timeout:      "#timeout",
  maxOutputSize:"#max-output",
  autoExecute:  "#auto-execute",
};

/* ---- Load saved settings ---- */

chrome.storage.local.get(
  ["workingDir", "shell", "timeout", "maxOutputSize", "autoExecute"],
  (s) => {
    if (s.workingDir)    $(FIELDS.workingDir).value   = s.workingDir;
    if (s.shell)         $(FIELDS.shell).value        = s.shell;
    if (s.timeout)       $(FIELDS.timeout).value      = s.timeout / 1000;
    if (s.maxOutputSize) $(FIELDS.maxOutputSize).value = s.maxOutputSize;
    if (s.autoExecute != null) $(FIELDS.autoExecute).checked = s.autoExecute;
  }
);

/* ---- Save settings ---- */

$("#save-btn").addEventListener("click", () => {
  const payload = {
    workingDir:   $(FIELDS.workingDir).value.trim() || "~/grok-workspace",
    shell:        $(FIELDS.shell).value,
    timeout:      parseInt($(FIELDS.timeout).value, 10) * 1000,
    maxOutputSize:parseInt($(FIELDS.maxOutputSize).value, 10),
    autoExecute:  $(FIELDS.autoExecute).checked,
  };
  chrome.storage.local.set(payload, () => showMsg("Settings saved.", "success"));
});

/* ---- Test connection ---- */

$("#test-btn").addEventListener("click", async () => {
  showMsg("Testing\u2026", "info");
  try {
    const res = await chrome.runtime.sendMessage({ type: "ping" });
    if (res?.connected) {
      showMsg(`Connected \u2014 host v${res.version ?? "?"}, shell: ${res.shell ?? "?"}`, "success");
      setStatus(true);
    } else {
      showMsg(`Failed: ${res?.stderr || res?.error || "unknown"}`, "error");
      setStatus(false);
    }
  } catch (err) {
    showMsg(`Error: ${err.message}`, "error");
    setStatus(false);
  }
});

/* ---- Initial connection check ---- */

chrome.runtime.sendMessage({ type: "ping" }, (res) => {
  setStatus(!!res?.connected);
  $("#status-text").textContent = res?.connected ? "Connected" : "Disconnected";
});

/* ---- Helpers ---- */

function showMsg(text, type) {
  const el = $("#message");
  el.textContent = text;
  el.className = `message ${type}`;
}

function setStatus(ok) {
  $("#status-dot").style.background = ok ? "#4ade80" : "#f87171";
  $("#status-text").textContent     = ok ? "Connected" : "Disconnected";
}
