(() => {
  const ALLOWLIST = new Set([
    "nytimes.com",
    "wsj.com",
    "washingtonpost.com",
    "theguardian.com",
    "bbc.com",
    "cnn.com",
    "foxnews.com",
    "reuters.com",
    "apnews.com",
    "bloomberg.com",
    "ft.com",
    "economist.com",
    "newyorker.com",
    "theatlantic.com",
    "nbcnews.com",
    "cbsnews.com",
    "abcnews.go.com"
  ]);

  const hostname = window.location.hostname.replace(/^www\./, "");
  const isAllowed = [...ALLOWLIST].some(d => hostname === d || hostname.endsWith("." + d));
  if (!isAllowed) return;

  const DEFAULTS = { enabled: true, poemWordsTarget: 18 };

  const STOPWORDS = new Set([
    "a","an","the","and","or","but","if","then","than","so","because","as","at","by","for","from","in","into",
    "of","on","onto","to","up","down","over","under","with","without","within","out","about","after","before",
    "between","during","through","against","among","is","are","was","were","be","been","being","it","its","it's",
    "this","that","these","those","i","you","he","she","they","we","me","him","her","them","us","my","your",
    "our","their","who","whom","which","what","when","where","why","how","not","no","nor","very","just","also",
    "can","could","may","might","will","would","shall","should","do","does","did","done","have","has","had"
  ]);

  function getSettings() {
    return new Promise(resolve => chrome.storage.sync.get(DEFAULTS, resolve));
  }

  function tokenizeWords(text) {
    return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|[0-9]+|[^\sA-Za-z0-9]+/g) || [];
  }

  function isWordToken(tok) {
    return /^[A-Za-z]+(?:'[A-Za-z]+)?$/.test(tok);
  }

  function wordScore(tok) {
    const w = tok.toLowerCase();
    if (!isWordToken(tok)) return -999;
    if (STOPWORDS.has(w)) return -3;
    if (w.length <= 2) return -2;
    if (w.length >= 6) return 3;
    if (w.length >= 4) return 2;
    return 0;
  }

  function looksLikeArticleContainer(el) {
    if (!el) return false;
    const ps = el.querySelectorAll("p");
    if (ps.length < 4) return false;
    const text = el.innerText || "";
    return text.length > 1200;
  }

  function findArticleRoot() {
    const article = document.querySelector("article");
    if (looksLikeArticleContainer(article)) return article;

    const candidates = ["[role='main']", "main", ".article", ".article-body", ".story-body", ".content"]
      .map(sel => document.querySelector(sel))
      .filter(Boolean);

    for (const c of candidates) if (looksLikeArticleContainer(c)) return c;

    // fallback: best-scoring container
    const blocks = Array.from(document.querySelectorAll("main, [role='main'], body"))
      .flatMap(root => Array.from(root.querySelectorAll("div, section, article")))
      .slice(0, 800);

    let best = null, bestScore = 0;
    for (const el of blocks) {
      const ps = el.querySelectorAll("p");
      if (ps.length < 4) continue;
      const textLen = (el.innerText || "").length;
      const score = ps.length * 60 + Math.min(textLen, 8000);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function getScopedParagraphs(root) {
    const paragraphs = Array.from(root.querySelectorAll("p"))
      .filter(p => p.innerText && p.innerText.trim().length > 40);

    // cap for perf
    return paragraphs.slice(0, 30);
  }

  function getAllWordTokens(paragraphs) {
    const words = [];
    for (const p of paragraphs) {
      const tokens = tokenizeWords((p.innerText || "").trim());
      for (const t of tokens) if (isWordToken(t)) words.push(t);
    }
    return words;
  }

  function pickPoemWordPositions(allWordTokens, poemWordsTarget) {
    const candidates = [];
    for (let i = 0; i < allWordTokens.length; i++) {
      const tok = allWordTokens[i];
      const s = wordScore(tok);
      if (s > 0) candidates.push({ i, tok, s });
    }
    // if too few, relax
    if (candidates.length < poemWordsTarget) {
      for (let i = 0; i < allWordTokens.length; i++) {
        const tok = allWordTokens[i];
        const s = wordScore(tok);
        if (s === 0) candidates.push({ i, tok, s: 0.5 });
      }
    }

    const picked = new Set();
    let attempts = 0;

    while (picked.size < poemWordsTarget && attempts < poemWordsTarget * 80 && candidates.length) {
      attempts++;
      const weights = candidates.map(c => Math.max(0.2, c.s));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;

      let chosen = candidates[candidates.length - 1];
      for (let k = 0; k < candidates.length; k++) {
        r -= weights[k];
        if (r <= 0) { chosen = candidates[k]; break; }
      }

      // spacing preference
      if (picked.has(chosen.i)) continue;
      if (picked.has(chosen.i - 1) && Math.random() < 0.75) continue;
      if (picked.has(chosen.i + 1) && Math.random() < 0.75) continue;

      picked.add(chosen.i);
    }

    return picked;
  }

  function buildPoemText(allWordTokens, keepPositions) {
    const kept = [];
    for (let i = 0; i < allWordTokens.length; i++) {
      if (keepPositions.has(i)) kept.push(allWordTokens[i]);
    }
    const lines = [];
    for (let i = 0; i < kept.length; i += 5) lines.push(kept.slice(i, i + 5).join(" "));
    return lines.join("\n");
  }

  function addPoemChip(poemText) {
    removePoemChip();
    const chip = document.createElement("div");
    chip.id = "bw-poem-chip";
    chip.innerHTML = `<strong>blackout poem</strong><div class="bw-poem"></div>`;
    chip.querySelector(".bw-poem").textContent = poemText;
    chip.addEventListener("click", () => chip.remove());
    document.documentElement.appendChild(chip);
  }

  function removePoemChip() {
    const existing = document.getElementById("bw-poem-chip");
    if (existing) existing.remove();
  }

  function wrapTextNode(node, keepPositions, state) {
    const text = node.nodeValue;
    if (!text || !text.trim()) return;

    const tokens = tokenizeWords(text);
    const frag = document.createDocumentFragment();

    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];

      if (isWordToken(tok)) {
        const span = document.createElement("span");
        span.textContent = tok;

        const idx = state.wordIndexGlobal;
        if (keepPositions.has(idx)) span.className = "bw-keep";
        else span.className = "bw-hide";

        frag.appendChild(span);
        state.wordIndexGlobal++;
      } else {
        frag.appendChild(document.createTextNode(tok));
      }

      // restore spacing (simple)
      frag.appendChild(document.createTextNode(" "));
    }

    node.parentNode.replaceChild(frag, node);
  }

  function applyBlackout(root, settings) {
    const paragraphs = getScopedParagraphs(root);
    if (paragraphs.length < 4) return;

    // Save originals once
    for (const p of paragraphs) {
      if (!p.dataset.bwOrig) p.dataset.bwOrig = p.innerHTML;
      p.dataset.bwProcessed = "1";
    }

    const allWords = getAllWordTokens(paragraphs);
    if (allWords.length < 120) return;

    const keepPositions = pickPoemWordPositions(allWords, settings.poemWordsTarget);
    addPoemChip(buildPoemText(allWords, keepPositions));

    const state = { wordIndexGlobal: 0 };

    for (const p of paragraphs) {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest("#bw-poem-chip")) return NodeFilter.FILTER_REJECT;
          if (parent.closest("script, style, noscript")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      const nodes = [];
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
      for (const tn of nodes) wrapTextNode(tn, keepPositions, state);
    }
  }

  function removeBlackout(root) {
    removePoemChip();
    const processed = root.querySelectorAll("p[data-bw-processed='1']");
    for (const p of processed) {
      if (p.dataset.bwOrig) {
        p.innerHTML = p.dataset.bwOrig;
      }
      delete p.dataset.bwOrig;
      delete p.dataset.bwProcessed;
    }
  }

  async function syncToSetting() {
    const settings = await getSettings();
    const root = findArticleRoot();
    if (!root) return;

    if (settings.enabled) {
      // If it was already processed, remove then reapply to avoid double-wrapping
      removeBlackout(root);
      applyBlackout(root, settings);
    } else {
      removeBlackout(root);
    }
  }

  // React to popup changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.enabled || changes.poemWordsTarget) syncToSetting();
  });

  // Initial run
  syncToSetting();
})();
