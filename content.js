(() => {
  // Prevent duplicate injection on SPA reloads / extension reinjection
  if (window.__BW_POETRY_LOADED__) return;
  window.__BW_POETRY_LOADED__ = true;

  // Store original paragraph HTML off-DOM to avoid serializing it as an attribute.
  const paragraphOriginals = new WeakMap();

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

  const DEFAULTS = {
    enabled: true,
    poemWordsTarget: 18,
    mode: "smart_local",    // "smart_local" | "randomish"
    rerollSeed: 1
  };

  const STOPWORDS = new Set([
    "a","an","the","and","or","but","if","then","than","so","because","as","at","by","for","from","in","into",
    "of","on","onto","to","up","down","over","under","with","without","within","out","about","after","before",
    "between","during","through","against","among","is","are","was","were","be","been","being","it","its","it's",
    "this","that","these","those","i","you","he","she","they","we","me","him","her","them","us","my","your",
    "our","their","who","whom","which","what","when","where","why","how","not","no","nor","very","just","also",
    "can","could","may","might","will","would","shall","should","do","does","did","done","have","has","had"
  ]);

  const NEWS_JUNK = new Set([
    "updated","minutes","minute","hours","hour","show","more","live","latest","pinned",
    "subscribe","gift","article","listen","follow","share","full","highlights","approval"
  ]);

  const TITLE_WORDS = new Set([
    "president","chief","justice","judge","senator","governor","secretary","minister",
    "mr","mrs","ms","dr","professor"
  ]);

  // Words that earn a scoring bonus for creating poetic imagery or emotional weight
  const EVOCATIVE = new Set([
    // emotional states
    "grief","rage","shame","longing","dread","anguish","tender","fierce",
    "fragile","desperate","weary","breathless","furious","defiant","restless",
    "haunted","yearning","condemned","abandoned","exhausted","relentless",
    // sensory / physical
    "burning","hollow","trembling","silent","bitter","bleeding","drowning",
    "fading","shattering","pale","raw","sharp","numb","frozen","crumbling",
    "gleaming","blinding","aching","withering","smoldering","scarred",
    // nature / elemental
    "storm","shadow","stone","iron","glass","ash","dust","flood","tide",
    "wound","scar","bloom","decay","void","ember","smoke","bone","vein",
    "abyss","silence","ruins","fire","ice","rain","blood","ghost","earth",
    // conceptual weight
    "power","truth","freedom","prison","exile","memory","witness","voice",
    "dream","impossible","forbidden","forgotten","sacred","burden","fracture",
    "survival","resistance","collapse","reckoning","awakening","catastrophe",
    // strong action verbs
    "refuses","trembles","burns","survives","escapes","crumbles","endures",
    "suffers","demands","confronts","betrays","collapses","erupts","mourns",
    "defies","persists","emerges","strikes","bleeds","breaks","rises","falls",
    // original list
    "ashamed","authority","ruling","fear","quiet","burn","dark","light",
    "alone","broken","refuse","wait","hunger","mercy","steel","work","around"
  ]);

  // Journalistic attribution/scaffolding verbs that make bad poetry
  const JOURNALISTIC_VERBS = new Set([
    "said","says","wrote","joined","ruled","cited","stated","added","noted",
    "argued","claimed","announced","confirmed","replied","according","reported",
    "testified","acknowledged","responded","described","explained","indicated"
  ]);

  let bwState = {
    root: null,
    processedParagraphs: [],
    lastPoemText: "",
    lastSettings: null
  };

  // ---------------- storage ----------------
  function getSettings() {
    // try/catch: after an extension reload a stale content script's chrome.* throws
    return new Promise(resolve => {
      try { chrome.storage.sync.get(DEFAULTS, resolve); }
      catch { resolve(DEFAULTS); }
    });
  }

  function setSettings(partial) {
    return new Promise(resolve => {
      try { chrome.storage.sync.set(partial, resolve); }
      catch { resolve(); }
    });
  }

  // ---------------- seeded RNG ----------------
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function() {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  function mulberry32(a) {
    return function() {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seedMaterial) {
    const seedFn = xmur3(seedMaterial);
    return mulberry32(seedFn());
  }

  // ---------------- tokenization ----------------
  function tokenizeParts(text) {
    // words | numbers/hyphenated numbers | whitespace | punctuation/symbols
    return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:[-:/.]\d+)*|\s+|[^\sA-Za-z\d]/g) || [];
  }

  function isWordToken(tok) {
    return /^[A-Za-z]+(?:'[A-Za-z]+)?$/.test(tok);
  }

  function isWhitespaceToken(tok) {
    return /^\s+$/.test(tok);
  }

  function isNumberishToken(tok) {
    return /^\d+(?:[-:/.]\d+)*$/.test(tok);
  }

  function isPunctToken(tok) {
    return /^[^\w\s]+$/.test(tok);
  }

  function isCapitalized(tok) {
    return /^[A-Z][a-z]/.test(tok);
  }

  function lower(tok) {
    return tok.toLowerCase();
  }

  function isLikelyJunkWord(tok) {
    const w = lower(tok);
    return w.length <= 1 || NEWS_JUNK.has(w);
  }

  // ---------------- viewport visibility ----------------
  function intersectsViewport(el, minVisiblePx = 8) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;

    const xOverlap = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    const yOverlap = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    const visibleArea = xOverlap * yOverlap;

    return visibleArea >= minVisiblePx * minVisiblePx;
  }

  function isMeaningfullyVisibleParagraph(p) {
    if (!p || !intersectsViewport(p, 10)) return false;
    if (p.closest("nav, header, footer, aside")) return false;
    if (p.closest("[aria-label*='navigation' i]")) return false;

    const txt = (p.innerText || "").trim();
    if (txt.length < 35) return false;

    // Skip obvious byline/timestamp/action strips
    const low = txt.toLowerCase();
    if (
      low.includes("updated ") && (low.includes("minutes ago") || low.includes("hour ago") || low.includes("hours ago"))
    ) return false;
    if (/^by\s+[A-Z]/.test(txt)) return false;

    return true;
  }

  // ---------------- article root heuristics ----------------
  function looksLikeArticleContainer(el) {
    if (!el) return false;
    const ps = el.querySelectorAll("p");
    if (ps.length < 3) return false;
    const text = el.innerText || "";
    return text.length > 600;
  }

  function findArticleRoot() {
    const article = document.querySelector("article");
    if (looksLikeArticleContainer(article)) return article;

    const candidates = ["[role='main']", "main", ".article", ".article-body", ".story-body", ".content"]
      .map(sel => document.querySelector(sel))
      .filter(Boolean);

    for (const c of candidates) {
      if (looksLikeArticleContainer(c)) return c;
    }

    // fallback: best scoring container
    const blocks = Array.from(document.querySelectorAll("article, main, [role='main'], section, div"));
    let best = null;
    let bestScore = -Infinity;

    const loopVh = window.innerHeight || document.documentElement.clientHeight;
    for (const el of blocks.slice(0, 1200)) {
      const ps = el.querySelectorAll?.("p");
      if (!ps || ps.length < 3) continue;
      const textLen = (el.innerText || "").length;
      if (textLen < 500) continue;

      const rect = el.getBoundingClientRect?.();
      let viewportBonus = 0;
      if (rect) {
        if (rect.top < loopVh * 0.75 && rect.bottom > loopVh * 0.1) viewportBonus = 800;
      }

      const score = ps.length * 70 + Math.min(textLen, 10000) + viewportBonus;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best || document.body;
  }

  function getScopedParagraphs(root) {
    const allParagraphs = Array.from(root.querySelectorAll("p"));
    const visible = allParagraphs.filter(isMeaningfullyVisibleParagraph);

    if (visible.length >= 1) return visible.slice(0, 30);

    // fallback: near viewport if strict visible finds nothing
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const near = allParagraphs.filter(p => {
      const txt = (p.innerText || "").trim();
      if (txt.length < 35) return false;
      const rect = p.getBoundingClientRect();
      return rect.bottom > -vh * 0.25 && rect.top < vh * 1.25;
    });

    return near.slice(0, 30);
  }

  // ---------------- traversal ----------------
  function getParagraphTextNodes(p) {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("#bw-poem-chip")) return NodeFilter.FILTER_REJECT;
        if (parent.closest("script, style, noscript")) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // Returns a unified visible word stream in exact reading order
  function getVisibleWordStream(paragraphs) {
    const words = [];

    for (const p of paragraphs) {
      const nodes = getParagraphTextNodes(p);
      for (const node of nodes) {
        const parts = tokenizeParts(node.nodeValue || "");
        for (const tok of parts) {
          if (isWordToken(tok) || isNumberishToken(tok)) {
            words.push(tok);
          }
        }
      }
    }

    return words;
  }

  function getSentenceRuns(paragraphs) {
    const runs = [];
    let globalWordIndex = 0;

    for (const p of paragraphs) {
      const nodes = getParagraphTextNodes(p);
      let currentRun = [];
      let runStart = null;

      const flushRun = () => {
        if (runStart != null && currentRun.length >= 3) {
          runs.push({
            start: runStart,
            end: runStart + currentRun.length - 1,
            words: currentRun.slice()
          });
        }
        currentRun = [];
        runStart = null;
      };

      for (const node of nodes) {
        const parts = tokenizeParts(node.nodeValue || "");
        for (const tok of parts) {
          if (isWordToken(tok) || isNumberishToken(tok)) {
            if (runStart == null) runStart = globalWordIndex;
            currentRun.push(tok);
            globalWordIndex++;
            continue;
          }

          if (/[.!?;:]/.test(tok)) {
            flushRun();
          }
        }
      }

      flushRun();
    }

    return runs;
  }

  function getHeadlineWords() {
    const headlineEl =
      document.querySelector("h1") ||
      document.querySelector("[data-testid*='headline' i]") ||
      document.querySelector(".headline") ||
      document.querySelector("header h1");
    if (!headlineEl) return new Set();
    const txt = (headlineEl.innerText || "").trim();
    const out = new Set();
    for (const part of tokenizeParts(txt)) {
      if (isWordToken(part)) out.add(lower(part));
    }
    return out;
  }

  // ---------------- POS-lite / scoring helpers ----------------
  function pseudoPos(tok, idxInWindow = 0) {
    if (isNumberishToken(tok)) return "NUM";
    if (!isWordToken(tok)) return "PUNCT";

    const w = lower(tok);

    if (STOPWORDS.has(w)) {
      if (["and","or","but"].includes(w)) return "CONJ";
      if (["in","on","at","by","for","from","with","without","of","to","into","over","under","between","through"].includes(w)) return "PREP";
      if (["the","a","an","this","that","these","those"].includes(w)) return "DET";
      if (["is","are","was","were","be","been","being","do","does","did","have","has","had","will","would","can","could","should","may","might"].includes(w)) return "AUX";
      if (["who","which","what","when","where","why","how"].includes(w)) return "WH";
      return "FUNC";
    }

    if (/(ing|ed)$/.test(w)) return "VERB";
    if (/(tion|ment|ness|ity|ship|ism|ance|ence)$/.test(w)) return "NOUN";
    if (/(ous|ful|less|able|ible|al|ive|ic)$/.test(w)) return "ADJ";
    if (/(ly)$/.test(w)) return "ADV";
    if (isCapitalized(tok) && idxInWindow > 0) return "PROPN";

    return "CONTENT";
  }

  function transitionBonus(prevPos, pos) {
    // rough local grammatical plausibility (zhaovan-inspired philosophy, not copied)
    const table = {
      "DET>NOUN": 1.2, "DET>ADJ": 0.9,
      "ADJ>NOUN": 1.1, "ADJ>ADJ": 0.2,
      "NOUN>VERB": 0.8, "PROPN>VERB": 0.6,
      "VERB>DET": 0.7, "VERB>PREP": 0.6, "VERB>ADV": 0.3,
      "PREP>DET": 0.7, "PREP>NOUN": 0.5, "PREP>PROPN": 0.2,
      "CONJ>DET": 0.3, "CONJ>NOUN": 0.3, "CONJ>PROPN": 0.1,
      "AUX>VERB": 1.0, "AUX>ADJ": 0.5, "AUX>NOUN": 0.1,
      "WH>AUX": 0.7, "WH>VERB": 0.4, "WH>PROPN": -0.3
    };
    const key = `${prevPos}>${pos}`;
    return table[key] ?? 0;
  }

  function countConsecutiveProperNouns(slice) {
    let maxRun = 0, run = 0;
    for (let i = 0; i < slice.length; i++) {
      const t = slice[i];
      const isProp = isWordToken(t) && isCapitalized(t) && !STOPWORDS.has(lower(t));
      if (isProp) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
    return maxRun;
  }

  function headlineOverlapPenalty(slice, headlineWords) {
    if (!headlineWords || headlineWords.size === 0) return 0;
    let overlap = 0;
    for (const t of slice) {
      if (isWordToken(t) && headlineWords.has(lower(t))) overlap++;
    }
    return overlap * 0.55;
  }

  function titleAndBylinePenalty(slice) {
    let pen = 0;
    for (let i = 0; i < slice.length; i++) {
      const t = slice[i];
      if (!isWordToken(t)) continue;
      const w = lower(t);
      if (TITLE_WORDS.has(w)) pen += 1.2;
      if (w === "by") pen += 0.8;
      if (NEWS_JUNK.has(w)) pen += 1.0;
    }
    return pen;
  }

  function numericPenalty(slice) {
    let pen = 0;
    for (const t of slice) {
      if (isNumberishToken(t)) pen += 1.6;
    }
    // special vote/date/time patterns like "6-3"
    for (let i = 0; i < slice.length - 1; i++) {
      if (isNumberishToken(slice[i]) && isNumberishToken(slice[i + 1])) pen += 1.0;
    }
    return pen;
  }

  function contentWeight(tok) {
    if (!isWordToken(tok)) return -0.3;
    const w = lower(tok);
    if (isLikelyJunkWord(tok)) return -2.0;
    if (STOPWORDS.has(w)) return -0.2;
    let s = 1.0;
    if (tok.length >= 6) s += 0.4;
    if (tok.length >= 9) s += 0.2;
    if (/(ing|ed|tion|ment|ness|ity|ous|ive|al)$/.test(w)) s += 0.2;
    return s;
  }

  function lineBreakPenalty(slice) {
    const weakEdgeWords = new Set(["and","or","but","so","for","to","of","in","on","at","with","from","by","the","a","an"]);
    let penalty = 0;
    const first = lower(slice[0] || "");
    const last = lower(slice[slice.length - 1] || "");
    if (weakEdgeWords.has(first)) penalty += 1.0;
    if (weakEdgeWords.has(last)) penalty += 1.1;
    return penalty;
  }

  function phraseShapeScore(slice) {
    let score = 0;
    let hasVerb = false;
    let hasContent = false;
    let longImageWord = false;

    for (let i = 0; i < slice.length; i++) {
      const tok = slice[i];
      const pos = pseudoPos(tok, i);
      if (pos === "VERB" || pos === "AUX") hasVerb = true;
      if (["NOUN","CONTENT","ADJ","PROPN"].includes(pos)) hasContent = true;
      if (isWordToken(tok) && tok.length >= 5 && !STOPWORDS.has(lower(tok))) longImageWord = true;
    }

    if (hasVerb) score += 1.0;
    if (hasContent) score += 0.8;
    if (hasVerb && hasContent) score += 0.8;
    if (longImageWord) score += 0.4;

    return score;
  }

  function scoreWindow(words, start, len, headlineWords) {
    const slice = words.slice(start, start + len);
    if (!slice.length) return -999;

    let score = 0;
    let stopCount = 0, contentCount = 0, junkCount = 0, capsCount = 0;
    let repeatedPenalty = 0;
    let transitionScore = 0;
    let seen = new Set();

    for (let i = 0; i < slice.length; i++) {
      const tok = slice[i];
      const w = lower(tok);

      if (isWordToken(tok)) {
        if (STOPWORDS.has(w)) stopCount++;
        else contentCount++;

        if (isLikelyJunkWord(tok)) junkCount++;
        if (isCapitalized(tok)) capsCount++;

        if (seen.has(w)) repeatedPenalty += 1.0;
        seen.add(w);
      } else if (isNumberishToken(tok)) {
        // count as non-content for poetic purposes
      }

      score += contentWeight(tok);

      if (i > 0) {
        const prevPos = pseudoPos(slice[i - 1], i - 1);
        const pos = pseudoPos(tok, i);
        transitionScore += transitionBonus(prevPos, pos);
      }
    }

    score += transitionScore * 0.8;

    // phrase shape
    if (len >= 2 && len <= 6) score += 1.1;
    if (len === 1) score -= 1.0;
    if (len >= 8) score -= 1.2;
    if (len >= 3 && len <= 5) score += 0.8;

    // grammar glue
    score += Math.min(stopCount, 2) * 0.7;
    score -= Math.max(0, stopCount - 3) * 0.8;

    // anti-news penalties
    score -= junkCount * 1.5;
    score -= repeatedPenalty;
    score -= numericPenalty(slice);
    score -= titleAndBylinePenalty(slice);
    score -= headlineOverlapPenalty(slice, headlineWords);

    // proper noun chain / named-entity compression penalty (major)
    const maxPropRun = countConsecutiveProperNouns(slice);
    if (maxPropRun >= 2) score -= (maxPropRun - 1) * 2.4;
    if (capsCount >= 3) score -= (capsCount - 2) * 1.1;

    // penalize journalistic attribution / scaffolding verbs (each one hurts)
    const lowSlice = slice.map(lower);
    let scaffoldPenalty = 0;
    for (const w of lowSlice) {
      if (JOURNALISTIC_VERBS.has(w)) scaffoldPenalty += 1.0;
    }
    score -= scaffoldPenalty;

    // boost emotionally loaded / image-like words
    for (const t of slice) if (isWordToken(t) && EVOCATIVE.has(lower(t))) score += 0.9;

    // reward POS diversity within a window (varied parts of speech = richer phrase)
    const posTypes = new Set();
    for (let i = 0; i < slice.length; i++) {
      if (isWordToken(slice[i])) posTypes.add(pseudoPos(slice[i], i));
    }
    if (posTypes.size >= 3) score += 0.7;
    else if (posTypes.size === 2) score += 0.2;
    else if (posTypes.size === 1 && slice.length >= 3) score -= 0.5;

    // discourage starting with weak glue unless compact phrase
    const first = lower(slice[0]);
    if (["and","or","but","so","for","to","of","in","on","at","with","from"].includes(first)) score -= 0.4;

    // discourage windows ending on weak stopword
    const last = lower(slice[slice.length - 1]);
    if (STOPWORDS.has(last) && !["not","no"].includes(last)) score -= 0.5;

    score += phraseShapeScore(slice);
    score -= lineBreakPenalty(slice);

    return score;
  }

  function buildCandidateWindows(allWords, sentenceRuns, poemWordsTarget, headlineWords, rng) {
    const windows = [];
    const maxLen = Math.min(7, Math.max(4, poemWordsTarget));

    for (const run of sentenceRuns) {
      for (let localStart = 0; localStart < run.words.length; localStart++) {
        for (let len = 2; len <= maxLen; len++) {
          if (localStart + len > run.words.length) break;
          const base = scoreWindow(run.words, localStart, len, headlineWords);
          if (base <= 0.0) continue;

          const start = run.start + localStart;
          const end = start + len - 1;
          const sentenceCoverage = len / run.words.length;
          let score = base;

          if (sentenceCoverage > 0.8) score -= 1.2;
          if (sentenceCoverage >= 0.35 && sentenceCoverage <= 0.7) score += 0.6;

          const jitter = (rng() - 0.5) * 0.7;
          windows.push({
            start,
            end,
            len,
            score: score + jitter,
            sentenceStart: run.start,
            sentenceEnd: run.end
          });
        }
      }
    }

    return windows.sort((a, b) => b.score - a.score);
  }

  function windowsOverlap(a, b) {
    return !(a.end < b.start || a.start > b.end);
  }

  function windowsTooClose(a, b) {
    return Math.abs(a.start - b.end) <= 1 || Math.abs(b.start - a.end) <= 1;
  }

  function sameSentence(a, b) {
    return a.sentenceStart === b.sentenceStart && a.sentenceEnd === b.sentenceEnd;
  }

  // Words between two non-overlapping windows
  function gapBetweenWindows(a, b) {
    const earlier = a.end < b.start ? a : b;
    const later = earlier === a ? b : a;
    return later.start - earlier.end - 1;
  }

  // Build many candidates, then rank (best-of-N)
  function buildPoemCandidates(allWords, sentenceRuns, target, headlineWords, rng, mode) {
    const windows = buildCandidateWindows(allWords, sentenceRuns, target, headlineWords, rng);
    if (!windows.length) return [];

    const topPool = windows.slice(0, Math.min(160, windows.length));
    const candidates = [];
    const attempts = Math.min(70, 24 + Math.floor(topPool.length / 4));

    for (let a = 0; a < attempts; a++) {
      const shuffled = topPool
        .map(w => ({ w, k: rng() }))
        .sort((x, y) => x.k - y.k)
        .map(x => x.w);

      const chosen = [];
      let budget = Math.max(8, target);
      let localScore = 0;

      for (const w of shuffled) {
        if (budget <= 0) break;
        if (chosen.some(c => windowsOverlap(c, w))) continue;
        // allow two windows from the same sentence only if they're far apart (4+ word gap)
        if (chosen.some(c => sameSentence(c, w) && gapBetweenWindows(c, w) < 4)) continue;
        if (chosen.some(c => windowsTooClose(c, w))) continue;
        if (chosen.length > 0 && w.len > budget + 1) continue;

        // mode-dependent aggressiveness
        if (mode === "smart_local" && w.score < 1.8 && chosen.length >= 2) continue;

        chosen.push(w);
        budget -= w.len;
        localScore += w.score;
      }

      // fallback if too sparse
      if (chosen.length < 2) {
        for (const w of shuffled) {
          if (budget <= 0) break;
          if (chosen.some(c => windowsOverlap(c, w))) continue;
          if (chosen.some(c => sameSentence(c, w))) continue;
          chosen.push(w);
          budget -= w.len;
          localScore += w.score * 0.75;
          if (chosen.length >= 3) break;
        }
      }

      chosen.sort((x, y) => x.start - y.start);

      const wordCount = chosen.reduce((s, w) => s + w.len, 0);
      if (wordCount < 6) continue;

      // poem-level ranking (encourages compact, non-journalistic texture)
      let poemScore = localScore;
      poemScore += Math.min(chosen.length, 4) * 0.8; // line variety
      poemScore -= Math.max(0, chosen.length - 5) * 0.7;

      const selectedWords = [];
      for (const w of chosen) {
        for (let i = w.start; i <= w.end; i++) selectedWords.push(allWords[i]);
      }

      // poem-level anti-news penalties
      const propRun = countConsecutiveProperNouns(selectedWords);
      if (propRun >= 2) poemScore -= (propRun - 1) * 3.0;

      let totalNumbers = selectedWords.filter(isNumberishToken).length;
      poemScore -= totalNumbers * 1.6;

      let titleHits = selectedWords.filter(t => isWordToken(t) && TITLE_WORDS.has(lower(t))).length;
      poemScore -= titleHits * 1.6;

      let junkHits = selectedWords.filter(t => isWordToken(t) && NEWS_JUNK.has(lower(t))).length;
      poemScore -= junkHits * 1.8;

      // reward evocative density using the EVOCATIVE set
      let evocative = 0;
      for (const t of selectedWords) {
        if (isWordToken(t) && EVOCATIVE.has(lower(t))) evocative++;
        else if (isWordToken(t) && !STOPWORDS.has(lower(t)) && t.length >= 6) evocative += 0.4;
      }
      poemScore += Math.min(evocative, 8) * 0.4;

      // reward windows drawn from different sentences
      poemScore += new Set(chosen.map(w => `${w.sentenceStart}-${w.sentenceEnd}`)).size * 0.5;

      // reward poems that span a wider swath of the article (not clustered in one paragraph)
      const articleSpan = allWords.length > 1
        ? (chosen[chosen.length - 1].end - chosen[0].start) / allWords.length
        : 0;
      poemScore += articleSpan * 1.8;

      // penalize repeated content words across different windows
      const contentWordFreq = new Map();
      for (const t of selectedWords) {
        if (isWordToken(t) && !STOPWORDS.has(lower(t)) && !isLikelyJunkWord(t)) {
          const w = lower(t);
          contentWordFreq.set(w, (contentWordFreq.get(w) || 0) + 1);
        }
      }
      for (const freq of contentWordFreq.values()) {
        if (freq > 1) poemScore -= (freq - 1) * 1.5;
      }

      candidates.push({ windows: chosen, score: poemScore, wordCount });
    }

    // dedupe by signature
    const seen = new Set();
    const deduped = [];
    for (const c of candidates.sort((a, b) => b.score - a.score)) {
      const sig = c.windows.map(w => `${w.start}-${w.end}`).join("|");
      if (seen.has(sig)) continue;
      seen.add(sig);
      deduped.push(c);
      if (deduped.length >= 20) break;
    }

    return deduped;
  }

  function pickPoemWordPositions(allWords, sentenceRuns, settings) {
    const headlineWords = getHeadlineWords();
    const seedMaterial = [
      location.href,
      settings.poemWordsTarget,
      settings.mode,
      settings.rerollSeed,
      allWords.slice(0, 120).join(" ")
    ].join("||");

    const rng = makeRng(seedMaterial);

    let keep = new Set();
    let chosenWindows = [];

    // Manual mode: start fully blacked out, user clicks to build their own poem.
    if (settings.mode === "manual") {
      return { keepPositions: keep, windows: [] };
    }

    if (settings.mode === "randomish") {
      // seeded random-ish baseline (for comparison)
      const target = Math.max(8, settings.poemWordsTarget);
      let candidates = allWords
        .map((tok, idx) => ({ tok, idx }))
        .filter(({ tok }) => !isLikelyJunkWord(tok));

      candidates = candidates.map(c => {
        let s = 0;
        const tok = c.tok;
        const w = lower(tok);
        if (isWordToken(tok)) {
          s += STOPWORDS.has(w) ? 0.4 : 1.5;
          s += Math.min(tok.length, 10) * 0.08;
          if (isCapitalized(tok)) s -= 0.4; // anti-names
          if (TITLE_WORDS.has(w)) s -= 1.3;
          if (NEWS_JUNK.has(w)) s -= 1.5;
        } else if (isNumberishToken(tok)) {
          s -= 1.8;
        }
        s += (rng() - 0.5) * 0.9;
        return { ...c, score: s };
      }).sort((a, b) => b.score - a.score);

      for (const c of candidates) {
        if (keep.size >= target) break;
        if (keep.has(c.idx)) continue;
        // spacing preference
        const tooClose = [...keep].some(k => Math.abs(k - c.idx) <= 1);
        if (tooClose && rng() < 0.7) continue;
        keep.add(c.idx);
      }

      if (keep.size < 6) {
        for (let i = 0; i < allWords.length && keep.size < Math.min(8, target); i++) {
          if (!STOPWORDS.has(lower(allWords[i])) && !isLikelyJunkWord(allWords[i])) keep.add(i);
        }
      }

      return { keepPositions: keep, windows: [] };
    }

    // smart_local mode
    const built = buildPoemCandidates(allWords, sentenceRuns, settings.poemWordsTarget, headlineWords, rng, settings.mode);

    if (built.length) {
      // choose among top few with seeded variability
      const top = built.slice(0, Math.min(5, built.length));
      const weighted = top.map((c, i) => ({
        c,
        w: Math.max(0.01, c.score - (i * 0.15))
      }));

      const totalW = weighted.reduce((s, x) => s + x.w, 0);
      let roll = rng() * totalW;
      let selected = weighted[0].c;
      for (const x of weighted) {
        roll -= x.w;
        if (roll <= 0) {
          selected = x.c;
          break;
        }
      }

      chosenWindows = selected.windows;
      for (const w of chosenWindows) {
        for (let i = w.start; i <= w.end; i++) keep.add(i);
      }
    }

    // fallback
    if (keep.size === 0) {
      const target = Math.max(8, settings.poemWordsTarget);
      for (let i = 0; i < allWords.length && keep.size < target; i++) {
        const tok = allWords[i];
        if (isNumberishToken(tok)) continue;
        if (isLikelyJunkWord(tok)) continue;
        if (TITLE_WORDS.has(lower(tok))) continue;
        if (!STOPWORDS.has(lower(tok)) || (i > 0 && i < allWords.length - 1)) keep.add(i);
      }
    }

    return { keepPositions: keep, windows: chosenWindows };
  }

  function buildPoemText(allWords, keepPositions, windows = []) {
    if (windows && windows.length) {
      const lines = windows.map(w => allWords.slice(w.start, w.end + 1).join(" "));
      return lines.join("\n");
    }

    const kept = [];
    for (let i = 0; i < allWords.length; i++) {
      if (keepPositions.has(i)) kept.push(allWords[i]);
    }

    // cadence-ish lines
    const lines = [];
    let i = 0;
    while (i < kept.length) {
      const remaining = kept.length - i;
      let take = 4;
      if (remaining <= 3) take = remaining;
      else if (remaining === 5) take = 5;
      else if (remaining >= 7) take = (remaining % 2 === 0 ? 4 : 3);
      lines.push(kept.slice(i, i + take).join(" "));
      i += take;
    }
    return lines.join("\n");
  }

  // ---------------- UI chip ----------------
  const MODE_LABELS = { smart_local: "Smart", randomish: "Random", manual: "Manual" };

  function addPoemChip(poemText, settings) {
    removePoemChip();

    const chip = document.createElement("div");
    chip.id = "bw-poem-chip";

    const header = document.createElement("div");
    header.className = "bw-chip-header";

    const title = document.createElement("span");
    title.className = "bw-title";
    title.textContent = "Blackout Poem";

    const closeBtn = document.createElement("button");
    closeBtn.className = "bw-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Dismiss";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removePoemChip();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);

    const poemEl = document.createElement("div");
    poemEl.className = "bw-poem";
    poemEl.textContent = poemText;
    bwState.poemEl = poemEl;

    const sub = document.createElement("div");
    sub.className = "bw-sub";
    const modeLabel = MODE_LABELS[settings.mode] || settings.mode;

    const revealBtn = document.createElement("button");
    revealBtn.className = "bw-reveal-toggle";
    revealBtn.textContent = "show all";
    revealBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const revealed = document.body.classList.toggle("bw-revealed");
      revealBtn.textContent = revealed ? "hide all" : "show all";
    });

    sub.appendChild(document.createTextNode(`click words to redact \u2022 tap chip to reroll \u2022 `));
    sub.appendChild(revealBtn);

    chip.appendChild(header);
    chip.appendChild(poemEl);
    chip.appendChild(sub);

    chip.addEventListener("click", async (e) => {
      e.stopPropagation();
      const s = await getSettings();
      await setSettings({ rerollSeed: (Number(s.rerollSeed) || 0) + 1 });
    });

    document.documentElement.appendChild(chip);
  }

  function removePoemChip() {
    const el = document.getElementById("bw-poem-chip");
    if (el) el.remove();
    bwState.poemEl = null;
  }

  // ---------------- crawl mode (perspective scroll into the horizon) ----------------
  function getCrawlContent() {
    const h = document.querySelector("h1");
    const headline = (h ? h.innerText : document.title).trim();
    const root = findArticleRoot();
    const paras = Array.from(root.querySelectorAll("p"))
      .map(p => (p.innerText || "").trim())
      .filter(t => t.length > 40)
      .slice(0, 60);
    return { headline, paras };
  }

  function openCrawl() {
    if (document.getElementById("bw-crawl")) { closeCrawl(); return; }
    const { headline, paras } = getCrawlContent();

    const overlay = document.createElement("div");
    overlay.id = "bw-crawl";

    const stage = document.createElement("div");
    stage.className = "bw-crawl-stage";
    const content = document.createElement("div");
    content.className = "bw-crawl-content";

    if (headline) {
      const title = document.createElement("div");
      title.className = "bw-crawl-title";
      title.textContent = headline;
      content.appendChild(title);
    }
    for (const t of paras) {
      const p = document.createElement("p");
      p.textContent = t;
      content.appendChild(p);
    }

    stage.appendChild(content);
    overlay.appendChild(stage);

    const close = document.createElement("button");
    close.id = "bw-crawl-close";
    close.textContent = "✕";
    close.title = "Exit crawl";
    close.addEventListener("click", closeCrawl);
    overlay.appendChild(close);

    document.documentElement.appendChild(overlay);

    // scroll the whole thing up through the tilted plane, then loop
    const h = content.scrollHeight;
    content.animate(
      [{ transform: `translateY(${window.innerHeight}px)` }, { transform: `translateY(${-h}px)` }],
      { duration: (h + window.innerHeight) / 90 * 1000, iterations: Infinity, easing: "linear" }
    );
  }

  function closeCrawl() {
    document.getElementById("bw-crawl")?.remove();
  }

  // ---------------- marker kit (freehand blackout) ----------------
  // A canvas anchored over the whole page. Drag the marker across words/sentences
  // to black them out, like a real blackout-poem marker. Eraser + clear included.
  const marker = { canvas: null, ctx: null, bar: null, tool: "marker", drawing: false, last: null, color: "#000000", width: 24 };

  function docHeight() {
    const d = document.documentElement;
    // ponytail: cap at 30k px so the canvas can't eat unbounded memory on infinite-scroll pages
    return Math.min(30000, Math.max(d.scrollHeight, d.offsetHeight, window.innerHeight));
  }

  function markerPoint(e) {
    return { x: e.pageX, y: e.pageY };
  }

  function drawStroke(a, b) {
    const ctx = marker.ctx;
    ctx.globalCompositeOperation = marker.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = marker.color;
    ctx.lineWidth = marker.tool === "eraser" ? marker.width * 1.5 : marker.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Straight mode preview needs a snapshot to redraw against each move.
  function snapshotCanvas() {
    const s = document.createElement("canvas");
    s.width = marker.canvas.width;
    s.height = marker.canvas.height;
    s.getContext("2d").drawImage(marker.canvas, 0, 0);
    return s; // ponytail: full-size copy, transient per straight stroke
  }

  function restoreSnapshot() {
    marker.ctx.globalCompositeOperation = "source-over";
    marker.ctx.clearRect(0, 0, marker.canvas.width, marker.canvas.height);
    if (marker.snapshot) marker.ctx.drawImage(marker.snapshot, 0, 0);
  }

  // Snap a near-horizontal/vertical drag to a perfectly flat bar over the words.
  function snapEnd(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dy) <= Math.abs(dx) * 0.25) return { x: b.x, y: a.y };
    if (Math.abs(dx) <= Math.abs(dy) * 0.25) return { x: a.x, y: b.y };
    return b;
  }

  // Scissors cursor (blue rings + grey blades). `open` spreads the blades so we
  // can flip open/closed while tracing to look like it's snipping.
  function scissorsSVG(open) {
    const s = open ? 8 : 1.5;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="46" height="34" viewBox="0 0 46 34">
      <line x1="12" y1="17" x2="42" y2="${17 - s}" stroke="#a9adb2" stroke-width="4" stroke-linecap="round"/>
      <line x1="12" y1="17" x2="42" y2="${17 + s}" stroke="#c3c7cb" stroke-width="4" stroke-linecap="round"/>
      <circle cx="12" cy="17" r="2.4" fill="#6b7075"/>
      <circle cx="7" cy="9" r="5" fill="none" stroke="#3b82c4" stroke-width="3"/>
      <circle cx="7" cy="25" r="5" fill="none" stroke="#3b82c4" stroke-width="3"/>
    </svg>`;
  }

  function scissorsCursor(open) {
    return `url("data:image/svg+xml,${encodeURIComponent(scissorsSVG(open))}") 42 17, crosshair`;
  }

  function setTool(tool) {
    marker.tool = tool;
    // tool active => canvas captures pointer; "off" => page stays usable
    marker.canvas.style.pointerEvents = tool === "off" ? "none" : "auto";
    marker.canvas.style.cursor = tool === "scissors" ? scissorsCursor(true) : "";
    for (const btn of marker.bar.querySelectorAll("[data-tool]")) {
      btn.classList.toggle("bw-active", btn.dataset.tool === tool);
    }
  }

  function openMarkerKit() {
    if (marker.canvas) { closeMarkerKit(); return; }

    const canvas = document.createElement("canvas");
    canvas.id = "bw-marker-canvas";
    canvas.width = document.documentElement.scrollWidth;
    canvas.height = docHeight();
    marker.canvas = canvas;
    marker.ctx = canvas.getContext("2d");

    canvas.addEventListener("pointerdown", (e) => {
      if (marker.tool === "off") return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      marker.downPt = markerPoint(e);
      marker.downClient = { x: e.clientX, y: e.clientY };
      marker.moved = false;
      if (FX.has(marker.tool)) { marker.fx = true; marker.fxPrev = { x: e.clientX, y: e.clientY }; applyFxAt(e.clientX, e.clientY); return; }
      if (marker.tool === "scissors") { marker.selecting = true; marker.lasso = [marker.downPt]; marker.snapshot = snapshotCanvas(); return; }
      marker.drawing = true;
      marker.last = marker.downPt;
      if (marker.tool === "straight") { marker.straightStart = marker.downPt; marker.snapshot = snapshotCanvas(); }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!marker.downPt) return;
      if (marker.fx) {
        const dx = e.clientX - marker.fxPrev.x, dy = e.clientY - marker.fxPrev.y;
        applyFxAt(e.clientX, e.clientY, dx, dy);
        marker.fxPrev = { x: e.clientX, y: e.clientY };
        return;
      }
      const p = markerPoint(e);
      if (!marker.moved) {
        const dx = e.clientX - marker.downClient.x, dy = e.clientY - marker.downClient.y;
        if (dx * dx + dy * dy < 16) return; // still within tap threshold (<4px)
        marker.moved = true;
      }
      if (marker.selecting) {
        marker.lasso.push(p);
        restoreSnapshot(); drawLasso(marker.lasso);
        canvas.style.cursor = scissorsCursor((marker.lasso.length >> 1) % 2 === 0); // snip open/closed
        return;
      }
      if (marker.tool === "straight") { restoreSnapshot(); drawStroke(marker.straightStart, snapEnd(marker.straightStart, p)); return; }
      drawStroke(marker.last, p);
      marker.last = p;
    });

    // A tap (no drag) passes the click through to the page, so you can still
    // click words / links / the popup while a drawing tool is selected.
    function forwardTap(client) {
      canvas.style.pointerEvents = "none";
      const el = document.elementFromPoint(client.x, client.y);
      canvas.style.pointerEvents = marker.tool === "off" ? "none" : "auto";
      el?.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, view: window,
        clientX: client.x, clientY: client.y
      }));
    }

    const endStroke = (e) => {
      if (marker.fx) { marker.fx = false; marker.downPt = null; return; }
      const tap = marker.downPt && !marker.moved;
      const client = marker.downClient;
      if (marker.selecting) {
        restoreSnapshot(); // wipe the lasso preview
        if (marker.moved) finishLasso(marker.lasso);
      }
      else if (marker.drawing && marker.moved && marker.tool === "straight") {
        restoreSnapshot();
        drawStroke(marker.straightStart, snapEnd(marker.straightStart, markerPoint(e)));
      }
      marker.selecting = false;
      marker.drawing = false;
      marker.snapshot = null;
      marker.downPt = null;
      if (marker.tool === "scissors") canvas.style.cursor = scissorsCursor(true); // blades rest open
      if (tap) forwardTap(client);
    };
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);

    const bar = document.createElement("div");
    bar.id = "bw-marker-bar";
    bar.innerHTML = `
      <button data-tool="marker" title="Marker — messy freehand redaction">✏️ Marker</button>
      <button data-tool="straight" title="Straight bar — snaps flat over the words">📏 Straight</button>
      <button data-tool="eraser" title="Eraser">◻️ Eraser</button>
      <button data-tool="scissors" title="Lasso — trace around a face/head to cut it out">✂️ Cut</button>
      <button data-tool="melt" title="Heat gun — melt words into ink drips">🔥 Melt</button>
      <button data-tool="wave" title="Curve — bend the word into an arch">◠ Curve</button>
      <button data-tool="smear" title="Smear — smudge the ink">👆 Smear</button>
      <button data-tool="rough" title="Rough — shaky hand-cut edges">〰️ Rough</button>
      <button data-tool="warp" title="Warp — big smooth liquid waves">💧 Warp</button>
      <button data-tool="balloon" title="Balloon — inflate words">🎈 Balloon</button>
      <button data-tool="shatter" title="Break glass — shatter letters everywhere">💥 Shatter</button>
      <button data-tool="off" title="Read mode — click through">👁 Read</button>
      <input type="color" id="bw-color" value="${marker.color}" title="Marker color">
      <input type="range" id="bw-width" min="4" max="80" value="${marker.width}" title="Thickness — crank up for a paint roller">
      <button data-act="clear" title="Clear all marks">Clear</button>
      <button data-act="close" title="Close marker kit">✕</button>
    `;
    bar.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.tool) return setTool(t.dataset.tool);
      if (t.dataset.act === "clear") marker.ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (t.dataset.act === "close") closeMarkerKit();
    });
    bar.querySelector("#bw-color").addEventListener("input", (e) => { marker.color = e.target.value; });
    bar.querySelector("#bw-width").addEventListener("input", (e) => { marker.width = Number(e.target.value); });
    marker.bar = bar;

    document.documentElement.appendChild(canvas);
    document.documentElement.appendChild(bar);
    setTool("marker");
  }

  function closeMarkerKit() {
    marker.canvas?.remove();
    marker.bar?.remove();
    marker.marquee?.remove();
    for (const c of document.querySelectorAll(".bw-clip")) c.remove();
    marker.canvas = marker.ctx = marker.bar = marker.marquee = null;
    marker.drawing = marker.selecting = marker.fx = false;
  }

  // ---- destruction fx: melt / balloon / shatter words under the pointer ----
  const FX = new Set(["melt", "balloon", "shatter", "wave", "smear", "rough", "warp"]);

  // Wrap the whitespace-delimited word at a screen point in a span we can animate.
  function wordAt(cx, cy) {
    const range = document.caretRangeFromPoint?.(cx, cy);
    if (!range) return null;
    const node = range.startContainer;
    if (!node || node.nodeType !== 3 || !node.nodeValue) return null;
    const host = node.parentElement;
    if (!host || host.closest("#bw-marker-bar, #bw-poem-chip, .bw-clip")) return null;
    // already an fx word → return its wrapper so a second effect stacks on it
    const existing = host.closest(".bw-fx");
    if (existing) return existing;

    const text = node.nodeValue;
    let a = range.startOffset, b = a;
    while (a > 0 && /\S/.test(text[a - 1])) a--;
    while (b < text.length && /\S/.test(text[b])) b++;
    if (b <= a) return null;

    const r = document.createRange();
    r.setStart(node, a); r.setEnd(node, b);
    const span = document.createElement("span");
    span.className = "bw-fx";
    try { r.surroundContents(span); } catch { return null; }
    return span;
  }

  function shatterWord(span) {
    const text = span.textContent;
    span.textContent = "";
    span.classList.add("bw-shattered");
    for (const ch of text) {
      const shard = document.createElement("span");
      shard.className = "bw-shard";
      shard.textContent = ch === " " ? " " : ch;
      shard.style.setProperty("--dx", ((Math.random() - 0.5) * 220).toFixed(0) + "px");
      shard.style.setProperty("--dy", (Math.random() * 180 - 40).toFixed(0) + "px");
      shard.style.setProperty("--rot", ((Math.random() - 0.5) * 200).toFixed(0) + "deg");
      span.appendChild(shard);
    }
  }

  // Bend the word into an arch that follows the drag: down-drag arches down,
  // and a longer drag deepens the curve. Static once applied.
  function waveWord(span, dx = 0, dy = 0) {
    const chars = [...span.textContent];
    span.textContent = "";
    const n = chars.length;
    const dir = dy > 2 ? -1 : 1;                        // drag down = arch downward
    const amt = Math.min(0.9, 0.35 + Math.hypot(dx, dy) / 300);
    chars.forEach((ch, i) => {
      const s = document.createElement("span");
      s.className = "bw-wavechar";
      s.textContent = ch === " " ? " " : ch;
      const t = n > 1 ? i / (n - 1) : 0.5;      // 0..1 across the word
      const arch = 1 - Math.pow(2 * t - 1, 2);  // 0 at ends, 1 at middle
      s.style.setProperty("--ty", (-arch * amt * dir).toFixed(3) + "em");
      s.style.setProperty("--rot", ((2 * t - 1) * 18 * dir).toFixed(1) + "deg");
      span.appendChild(s);
    });
  }

  // Smudge the ink in the drag direction: trailing ghost copies of the real
  // letters, each dragged further, fainter, and blurrier — like pulled wet ink.
  function smearWord(span, dx = 0, dy = 0) {
    const ang = (dx === 0 && dy === 0) ? 0 : Math.atan2(dy, dx);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const text = span.textContent;
    span.textContent = "";
    const N = 7;
    for (let k = N; k >= 1; k--) {           // farthest/faintest first, so nearer ghosts stack on top
      const g = document.createElement("span");
      g.className = "bw-smudge";
      g.textContent = text;
      const dist = k * 5;
      g.style.transform = `translate(${(ux * dist).toFixed(1)}px, ${(uy * dist).toFixed(1)}px)`;
      g.style.opacity = (0.4 * (1 - k / (N + 1))).toFixed(2);
      g.style.filter = `blur(${(k * 0.6).toFixed(1)}px)`;
      span.appendChild(g);
    }
    const front = document.createElement("span");   // crisp original, keeps the word legible + holds layout width
    front.textContent = text;
    span.appendChild(front);
  }

  // Inject the SVG liquify filter once: blur → alpha-threshold (keeps the goo
  // crisp) → fractal-noise displacement. Same technique as classic melting text.
  function ensureGooFilter() {
    if (document.getElementById("bw-goo")) return;
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    holder.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0">
        <defs>
          <filter id="bw-goo" x="-60%" y="-40%" width="220%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b"/>
            <feColorMatrix in="b" type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" result="goo"/>
            <feTurbulence type="fractalNoise" baseFrequency="0.013" numOctaves="3" seed="2" result="n"/>
            <feDisplacementMap in="goo" in2="n" scale="24"/>
          </filter>
        </defs>
      </svg>`;
    document.documentElement.appendChild(holder);
  }

  // Melting = liquid displacement of the word (feTurbulence + feDisplacementMap).
  function meltWord(span) {
    ensureGooFilter();
    span.classList.add("bw-goo-melt");
  }

  // Rough = high-frequency, small-scale displacement → shaky hand-cut/woodcut edges.
  function ensureRoughFilter() {
    if (document.getElementById("bw-rough")) return;
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    holder.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0">
        <defs>
          <filter id="bw-rough" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" seed="5" result="n"/>
            <feDisplacementMap in="SourceGraphic" in2="n" scale="6"/>
          </filter>
        </defs>
      </svg>`;
    document.documentElement.appendChild(holder);
  }

  function roughWord(span) {
    ensureRoughFilter();
    span.classList.add("bw-rough");
  }

  // Warp = low-frequency, high-scale displacement → big smooth liquid waves
  // (pure displacement, no blur/threshold — the technique from the CodePen).
  function ensureWarpFilter() {
    if (document.getElementById("bw-warp")) return;
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    holder.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0">
        <defs>
          <filter id="bw-warp" x="-50%" y="-50%" width="200%" height="200%">
            <feTurbulence type="fractalNoise" baseFrequency="0.004" numOctaves="2" seed="2" result="n"/>
            <feDisplacementMap in="SourceGraphic" in2="n" scale="42"/>
          </filter>
        </defs>
      </svg>`;
    document.documentElement.appendChild(holder);
  }

  function warpWord(span) {
    ensureWarpFilter();
    span.classList.add("bw-warp");
  }

  function applyFxAt(cx, cy, dx = 0, dy = 0) {
    // drop the canvas out of hit-testing so caretRangeFromPoint sees the page text
    marker.canvas.style.pointerEvents = "none";
    const span = wordAt(cx, cy);
    marker.canvas.style.pointerEvents = marker.tool === "off" ? "none" : "auto";
    if (!span) return;

    // don't re-apply the same effect (a drag fires many times over one word)
    const applied = (span.dataset.bwFx || "").split(" ").filter(Boolean);
    if (applied.includes(marker.tool)) return;

    if (marker.tool === "melt") meltWord(span);
    else if (marker.tool === "balloon") span.classList.add("bw-balloon");
    else if (marker.tool === "shatter") shatterWord(span);
    else if (marker.tool === "wave") waveWord(span, dx, dy);
    else if (marker.tool === "smear") smearWord(span, dx, dy);
    else if (marker.tool === "rough") roughWord(span);
    else if (marker.tool === "warp") warpWord(span);

    span.dataset.bwFx = [...applied, marker.tool].join(" ");
  }

  // ---- lasso scissors: trace a shape and cut it out ----
  function drawLasso(points) {
    const ctx = marker.ctx;
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.stroke();
    ctx.setLineDash([]);
  }

  function lassoBounds(points) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const p of points) {
      l = Math.min(l, p.x); t = Math.min(t, p.y);
      r = Math.max(r, p.x); b = Math.max(b, p.y);
    }
    return { left: l, top: t, right: r, bottom: b, w: r - l, h: b - t };
  }

  function pageRect(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height,
             right: r.right + scrollX, bottom: r.bottom + scrollY };
  }

  function overlapArea(box, r) {
    const w = Math.min(box.right, r.right) - Math.max(box.left, r.left);
    const h = Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function finishLasso(points) {
    const bb = lassoBounds(points);
    if (bb.w < 8 || bb.h < 8 || points.length < 3) return;
    if (!clipShapeFromImage(points, bb)) clipFromText(bb);
  }

  // Where the image's natural pixels actually land on screen, accounting for
  // object-fit (cover/contain crop the natural image into the display box).
  // Assumes the default centered object-position.
  function imageContentMap(img) {
    const ir = pageRect(img);
    const nw = img.naturalWidth, nh = img.naturalHeight;
    let cw = ir.width, ch = ir.height, cx = ir.left, cy = ir.top;
    const fit = getComputedStyle(img).objectFit;
    if (fit === "cover" || fit === "contain") {
      const s = fit === "cover"
        ? Math.max(ir.width / nw, ir.height / nh)
        : Math.min(ir.width / nw, ir.height / nh);
      cw = nw * s; ch = nh * s;
      cx = ir.left + (ir.width - cw) / 2;
      cy = ir.top + (ir.height - ch) / 2;
    }
    return { cx, cy, k: nw / cw };  // k: page px -> natural px
  }

  // Crop the traced outline out of the image it covers most. Outside the path
  // is transparent, so it reads as a real magazine cutout of the face/head.
  function clipShapeFromImage(points, bb) {
    let best = null, bestArea = 0;
    for (const img of document.images) {
      if (!img.naturalWidth) continue;
      const area = overlapArea(bb, pageRect(img));
      if (area > bestArea) { bestArea = area; best = img; }
    }
    if (!best) return false;

    const m = imageContentMap(best);
    const w = Math.max(1, Math.round(bb.w)), h = Math.max(1, Math.round(bb.h));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");

    const path = new Path2D();
    points.forEach((p, i) => i ? path.lineTo(p.x - bb.left, p.y - bb.top) : path.moveTo(p.x - bb.left, p.y - bb.top));
    path.closePath();
    ctx.clip(path);

    try {
      ctx.drawImage(best,
        (bb.left - m.cx) * m.k, (bb.top - m.cy) * m.k, bb.w * m.k, bb.h * m.k,
        0, 0, bb.w, bb.h);
    } catch { return false; }

    addClip(canvas, bb.left, bb.top, true);
    return true;
  }

  function clipFromText(bb) {
    const sel = window.getSelection();
    let text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    if (!text) {
      marker.canvas.style.pointerEvents = "none";
      const el = document.elementFromPoint(
        (bb.left + bb.right) / 2 - scrollX, (bb.top + bb.bottom) / 2 - scrollY);
      marker.canvas.style.pointerEvents = "auto";
      text = el ? (el.innerText || "").trim().slice(0, 140) : "";
    }
    if (!text) return;
    const div = document.createElement("div");
    div.className = "bw-clip-text";
    div.textContent = text;
    addClip(div, bb.left, bb.top, false);
  }

  function addClip(inner, x, y, shaped) {
    const clip = document.createElement("div");
    clip.className = "bw-clip" + (shaped ? " bw-clip-shaped" : "");
    clip.style.left = x + "px";
    clip.style.top = y + "px";
    clip.style.transform = `rotate(${(Math.random() - 0.5) * 8}deg)`;

    const dup = document.createElement("button");
    dup.className = "bw-clip-dup"; dup.textContent = "⧉"; dup.title = "Duplicate";
    const del = document.createElement("button");
    del.className = "bw-clip-del"; del.textContent = "×"; del.title = "Remove";

    clip.append(inner, dup, del);
    wireClip(clip);
    document.documentElement.appendChild(clip);
    return clip;
  }

  function wireClip(clip) {
    makeClipDraggable(clip);
    const stop = (e) => e.stopPropagation();
    const del = clip.querySelector(".bw-clip-del");
    const dup = clip.querySelector(".bw-clip-dup");
    del.addEventListener("pointerdown", stop);
    del.addEventListener("click", (e) => { e.stopPropagation(); clip.remove(); });
    dup.addEventListener("pointerdown", stop);
    dup.addEventListener("click", (e) => { e.stopPropagation(); duplicateClip(clip); });
  }

  // cloneNode doesn't copy canvas pixels or listeners — redraw canvases, rewire.
  function duplicateClip(clip) {
    const copy = clip.cloneNode(true);
    const src = clip.querySelectorAll("canvas");
    const dst = copy.querySelectorAll("canvas");
    src.forEach((sc, i) => {
      dst[i].width = sc.width; dst[i].height = sc.height;
      dst[i].getContext("2d").drawImage(sc, 0, 0);
    });
    copy.style.left = (parseFloat(clip.style.left) + 22) + "px";
    copy.style.top = (parseFloat(clip.style.top) + 22) + "px";
    copy.style.transform = `rotate(${(Math.random() - 0.5) * 8}deg)`;
    wireClip(copy);
    document.documentElement.appendChild(copy);
  }

  function makeClipDraggable(clip) {
    let start = null;
    clip.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".bw-clip-del, .bw-clip-dup")) return;
      e.preventDefault(); e.stopPropagation();
      start = { mx: e.pageX, my: e.pageY, x: parseFloat(clip.style.left), y: parseFloat(clip.style.top) };
      clip.setPointerCapture(e.pointerId);
      clip.style.cursor = "grabbing";
    });
    clip.addEventListener("pointermove", (e) => {
      if (!start) return;
      clip.style.left = start.x + (e.pageX - start.mx) + "px";
      clip.style.top = start.y + (e.pageY - start.my) + "px";
    });
    const end = () => { start = null; clip.style.cursor = "grab"; };
    clip.addEventListener("pointerup", end);
    clip.addEventListener("pointercancel", end);
  }

  // Read the poem straight from the current DOM: runs of kept words become lines,
  // a hidden word or paragraph boundary ends a line. Reflects manual redactions.
  function readPoemFromDom() {
    const lines = [];
    let current = [];
    const flush = () => { if (current.length) { lines.push(current.join(" ")); current = []; } };
    for (const p of bwState.processedParagraphs) {
      for (const s of p.querySelectorAll("span.bw-keep, span.bw-hide")) {
        if (s.classList.contains("bw-keep")) current.push(s.textContent);
        else flush();
      }
      flush();
    }
    return lines.join("\n");
  }

  function refreshPoemChip() {
    if (bwState.poemEl) bwState.poemEl.textContent = readPoemFromDom();
  }

  // Click any word to toggle it in/out of the poem. Delegated, attached once.
  document.addEventListener("click", (e) => {
    const span = e.target.closest && e.target.closest("span.bw-keep, span.bw-hide");
    if (!span || span.closest("#bw-poem-chip")) return;
    span.classList.toggle("bw-keep");
    span.classList.toggle("bw-hide");
    refreshPoemChip();
  });

  // ---------------- render blackout ----------------
  function wrapTextNode(node, keepPositions, state) {
    const text = node.nodeValue;
    if (!text || !text.trim()) return;

    const parts = tokenizeParts(text);
    const frag = document.createDocumentFragment();

    for (const tok of parts) {
      if (isWhitespaceToken(tok)) {
        frag.appendChild(document.createTextNode(tok));
        continue;
      }

      if (isWordToken(tok) || isNumberishToken(tok)) {
        const span = document.createElement("span");
        span.textContent = tok;

        const idx = state.wordIndexGlobal;
        if (keepPositions.has(idx)) span.className = "bw-keep";
        else {
          span.className = "bw-hide";
          span.style.setProperty("--rot", (Math.random() * 7 - 3.5).toFixed(1) + "deg"); // hand-drawn tilt
        }

        frag.appendChild(span);
        state.wordIndexGlobal++;
        continue;
      }

      // punctuation stays as plain text so spacing/layout is preserved
      frag.appendChild(document.createTextNode(tok));
    }

    if (node.parentNode) node.parentNode.replaceChild(frag, node);
  }

  function applyBlackout(root, settings) {
    const paragraphs = getScopedParagraphs(root);
    if (!paragraphs.length) return;

    // Save originals once for only the paragraphs we mutate
    for (const p of paragraphs) {
      if (!paragraphOriginals.has(p)) paragraphOriginals.set(p, p.innerHTML);
      p.dataset.bwProcessed = "1";
    }

    const allWords = getVisibleWordStream(paragraphs);
    const sentenceRuns = getSentenceRuns(paragraphs);
    if (allWords.length < 10) return;
    if (!sentenceRuns.length) return;

    const { keepPositions, windows } = pickPoemWordPositions(allWords, sentenceRuns, settings);
    const poemText = buildPoemText(allWords, keepPositions, windows);

    addPoemChip(poemText, settings);

    const state = { wordIndexGlobal: 0 };
    for (const p of paragraphs) {
      const nodes = getParagraphTextNodes(p);
      for (const tn of nodes) wrapTextNode(tn, keepPositions, state);
    }

    bwState.processedParagraphs = paragraphs;
    bwState.lastPoemText = poemText;
    bwState.lastSettings = settings;
  }

  function removeBlackout(root) {
    removePoemChip();

    // restore any processed paragraphs under root
    const processed = root.querySelectorAll("p[data-bw-processed='1']");
    for (const p of processed) {
      if (paragraphOriginals.has(p)) {
        p.innerHTML = paragraphOriginals.get(p);
        paragraphOriginals.delete(p);
      }
      delete p.dataset.bwProcessed;
    }

    bwState.processedParagraphs = [];
  }

  let isSyncing = false;
  async function syncToSetting() {
    if (isSyncing) return;
    isSyncing = true;
    try {
      const settings = await getSettings();
      const root = findArticleRoot();
      if (!root) return;

      bwState.root = root;

      if (!settings.enabled) {
        removeBlackout(root);
        return;
      }

      removeBlackout(root); // always reset before reapplying
      applyBlackout(root, settings);
    } finally {
      isSyncing = false;
    }
  }

  // ---------------- reroll / popup messaging ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === "BW_REROLL") {
          const s = await getSettings();
          await setSettings({ rerollSeed: (Number(s.rerollSeed) || 0) + 1 });
          sendResponse({ ok: true });
          return;
        }

        if (msg?.type === "BW_SYNC_NOW") {
          await syncToSetting();
          sendResponse({ ok: true });
          return;
        }

        if (msg?.type === "BW_MARKER_TOGGLE") {
          openMarkerKit();
          sendResponse({ ok: true, open: !!marker.canvas });
          return;
        }

        if (msg?.type === "BW_CRAWL_TOGGLE") {
          openCrawl();
          sendResponse({ ok: true, open: !!document.getElementById("bw-crawl") });
          return;
        }

        if (msg?.type === "BW_SET_MODE") {
          await setSettings({ mode: msg.mode === "randomish" ? "randomish" : "smart_local" });
          sendResponse({ ok: true });
          return;
        }

        sendResponse({ ok: false, error: "unknown message" });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();

    return true; // async response
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (
      changes.enabled ||
      changes.poemWordsTarget ||
      changes.rerollSeed ||
      changes.mode
    ) {
      syncToSetting();
    }
  });

  // Reapply on resize (viewport dimensions changed, so paragraph visibility may shift).
  // Scroll is intentionally excluded — regenerating the poem mid-read is jarring.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      getSettings().then(s => { if (s.enabled) syncToSetting(); });
    }, 400);
  }, { passive: true });

  // Initial apply
  syncToSetting();
})();
