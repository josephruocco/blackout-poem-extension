const DEFAULTS = { enabled: true, intensity: 0.88, poemWordsTarget: 18 };

function $(id) { return document.getElementById(id); }

async function getSettings() {
  return new Promise(resolve => chrome.storage.sync.get(DEFAULTS, resolve));
}

async function setSettings(partial) {
  return new Promise(resolve => chrome.storage.sync.set(partial, resolve));
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.reload(tab.id);
}

(async function init() {
  const s = await getSettings();

  $("enabled").checked = s.enabled;

  $("poemWordsTarget").value = s.poemWordsTarget;
  $("poemWordsLabel").textContent = `Keep ~${s.poemWordsTarget} words visible as the poem`;

  $("enabled").addEventListener("change", async (e) => {
    await setSettings({ enabled: e.target.checked });
  });

  $("poemWordsTarget").addEventListener("input", async (e) => {
    const val = Number(e.target.value);
    $("poemWordsLabel").textContent = `Keep ~${val} words visible as the poem`;
    await setSettings({ poemWordsTarget: val });
  });

  $("refresh").addEventListener("click", refreshActiveTab);
})();
