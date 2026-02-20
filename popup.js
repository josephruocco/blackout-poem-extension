const DEFAULTS = {
  enabled: true,
  poemWordsTarget: 18,
  mode: "smart_local",
  rerollSeed: 1
};

function $(id) {
  return document.getElementById(id);
}

async function getSettings() {
  return new Promise(resolve => chrome.storage.sync.get(DEFAULTS, resolve));
}

async function setSettings(partial) {
  return new Promise(resolve => chrome.storage.sync.set(partial, resolve));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id) return { ok: false, error: "No active tab" };

  try {
    const res = await chrome.tabs.sendMessage(tab.id, message);
    return res || { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function renderStatus(text, isError = false) {
  const el = $("status");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "#b00020" : "";
}

(async function init() {
  const s = await getSettings();

  // Enable toggle
  $("enabled").checked = !!s.enabled;

  // Word target slider
  $("poemWordsTarget").value = Number(s.poemWordsTarget || 18);
  $("poemWordsLabel").textContent = `Keep ~${$("poemWordsTarget").value} words visible as the poem`;

  // Mode
  if ($("modeSmart")) $("modeSmart").checked = (s.mode || "smart_local") === "smart_local";
  if ($("modeRandom")) $("modeRandom").checked = (s.mode || "smart_local") === "randomish";

  $("enabled").addEventListener("change", async (e) => {
    await setSettings({ enabled: !!e.target.checked });
    const res = await sendToActiveTab({ type: "BW_SYNC_NOW" });
    if (!res?.ok) renderStatus(`Could not apply: ${res?.error || "unknown error"}`, true);
    else renderStatus("Applied");
  });

  $("poemWordsTarget").addEventListener("input", async (e) => {
    const val = Number(e.target.value);
    $("poemWordsLabel").textContent = `Keep ~${val} words visible as the poem`;
    await setSettings({ poemWordsTarget: val });
    // no forced message; content script listens to storage changes
    renderStatus("Updated");
  });

  if ($("modeSmart")) {
    $("modeSmart").addEventListener("change", async (e) => {
      if (!e.target.checked) return;
      await setSettings({ mode: "smart_local" });
      const res = await sendToActiveTab({ type: "BW_SYNC_NOW" });
      if (!res?.ok) renderStatus(`Mode apply failed: ${res?.error || "unknown error"}`, true);
      else renderStatus("Smart mode");
    });
  }

  if ($("modeRandom")) {
    $("modeRandom").addEventListener("change", async (e) => {
      if (!e.target.checked) return;
      await setSettings({ mode: "randomish" });
      const res = await sendToActiveTab({ type: "BW_SYNC_NOW" });
      if (!res?.ok) renderStatus(`Mode apply failed: ${res?.error || "unknown error"}`, true);
      else renderStatus("Random-ish mode");
    });
  }

  $("reroll").addEventListener("click", async () => {
    const res = await sendToActiveTab({ type: "BW_REROLL" });
    if (!res?.ok) {
      renderStatus("Reroll failed. Try reloading once.", true);
      return;
    }
    renderStatus("Rerolled");
  });

  $("refresh").addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (tab?.id) {
      chrome.tabs.reload(tab.id);
      renderStatus("Reloading tab...");
    } else {
      renderStatus("No active tab", true);
    }
  });
})();
