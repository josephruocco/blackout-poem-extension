(() => {
  // Prevent duplicate injection on SPA reloads / extension reinjection
  if (window.__BW_POETRY_LOADED__) return;
  window.__BW_POETRY_LOADED__ = true;

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

  let bwState = {
    root: null,
    processedParagraphs: [],
    lastPoemText: "",
    lastSettings: null
  };

  // ---------------- storage ----------------
  function getSettings() {
    return new Promise(resolve => chrome.storage.sync.get(DEFAULTS, resolve));
  }

  function setSettings(partial) {
    return new Promise(resolve => chrome.storage.sync.set(partial, resolve));
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

    for (const el of blocks.slice(0, 1200)) {
      const ps = el.querySelectorAll?.("p");
      if (!ps || ps.length < 3) continue;
      const textLen = (el.innerText || "").length;
      if (textLen < 500) continue;

      const rect = el.getBoundingClientRect?.();
      let viewportBonus = 0;
      if (rect) {
        const vh = window.innerHeight || document.documentElement.clientHeight;
        if (rect.top < vh * 0.75 && rect.bottom > vh * 0.1) viewportBonus = 800;
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

    // penalize explicit legal/news scaffolding words
    const lowSlice = slice.map(lower);
    const scaffolding = ["president","justice","court","congress","approval","wrote","joined","said"];
    let scaffoldHits = 0;
    for (const w of lowSlice) if (scaffolding.includes(w)) scaffoldHits++;
    if (scaffoldHits >= 3) score -= (scaffoldHits - 2) * 1.1;

    // boost emotionally loaded / image-like words (simple heuristic)
    const evocativeRegex = /(defiant|ashamed|authority|ruling|shadow|strikes|work|around|fall|fear|quiet|burn|storm|glass|blood|ghost|dark|light|alone|broken|refuse|wait|hunger|mercy|steel|dust)/i;
    for (const t of slice) if (isWordToken(t) && evocativeRegex.test(t)) score += 0.8;

    // discourage starting with weak glue unless compact phrase
    const first = lower(slice[0]);
    if (["and","or","but","so","for","to","of","in","on","at","with","from"].includes(first)) score -= 0.4;

    // discourage windows ending on weak stopword
    const last = lower(slice[slice.length - 1]);
    if (STOPWORDS.has(last) && !["not","no"].includes(last)) score -= 0.5;

    return score;
  }

  function buildCandidateWindows(allWords, poemWordsTarget, headlineWords, rng) {
    const windows = [];
    const maxLen = Math.min(7, Math.max(4, poemWordsTarget));

    for (let i = 0; i < allWords.length; i++) {
      for (let len = 2; len <= maxLen; len++) {
        if (i + len > allWords.length) break;
        const base = scoreWindow(allWords, i, len, headlineWords);
        if (base <= 0.0) continue;

        // small seeded jitter for rerolls
        const jitter = (rng() - 0.5) * 0.6;
        windows.push({
          start: i,
          end: i + len - 1,
          len,
          score: base + jitter
        });
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

  // Build many candidates, then rank (best-of-N)
  function buildPoemCandidates(allWords, target, headlineWords, rng, mode) {
    const windows = buildCandidateWindows(allWords, target, headlineWords, rng);
    if (!windows.length) return [];

    const topPool = windows.slice(0, Math.min(200, windows.length));
    const candidates = [];
    const attempts = Math.min(60, 20 + Math.floor(topPool.length / 5));

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
        if (chosen.some(c => windowsTooClose(c, w))) continue;
        if (chosen.length > 0 && w.len > budget + 2) continue;

        // mode-dependent aggressiveness
        if (mode === "smart_local" && w.score < 1.4 && chosen.length >= 2) continue;

        chosen.push(w);
        budget -= w.len;
        localScore += w.score;
      }

      // fallback if too sparse
      if (chosen.length < 2) {
        for (const w of shuffled) {
          if (budget <= 0) break;
          if (chosen.some(c => windowsOverlap(c, w))) continue;
          chosen.push(w);
          budget -= w.len;
          localScore += w.score * 0.8;
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

      // reward evocative density
      let evocative = 0;
      for (const t of selectedWords) {
        if (isWordToken(t) && !STOPWORDS.has(lower(t)) && t.length >= 5) evocative++;
      }
      poemScore += Math.min(evocative, 8) * 0.3;

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

  function pickPoemWordPositions(allWords, settings) {
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
    const built = buildPoemCandidates(allWords, settings.poemWordsTarget, headlineWords, rng, settings.mode);

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
  function ensureStyles() {
    if (document.getElementById("bw-poem-style")) return;
    const style = document.createElement("style");
    style.id = "bw-poem-style";
    style.textContent = `
      .bw-hide {
        background: #000 !important;
        color: #000 !important;
        border-radius: 2px !important;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }
      .bw-keep {
        color: inherit !important;
        background: transparent !important;
      }
      #bw-poem-chip {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483647;
        max-width: min(420px, 42vw);
        background: rgba(20,20,20,0.95);
        color: #fff;
        border-radius: 12px;
        padding: 12px 14px;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        box-shadow: 0 8px 26px rgba(0,0,0,0.35);
        cursor: pointer;
        user-select: none;
        line-height: 1.35;
      }
      #bw-poem-chip .bw-title {
        font-size: 12px;
        letter-spacing: 0.12em;
        opacity: 0.85;
        font-weight: 800;
        margin-bottom: 6px;
      }
      #bw-poem-chip .bw-poem {
        white-space: pre-line;
        font-size: 15px;
      }
      #bw-poem-chip .bw-sub {
        margin-top: 8px;
        font-size: 11px;
        opacity: 0.7;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function addPoemChip(poemText, settings) {
    ensureStyles();
    removePoemChip();

    const chip = document.createElement("div");
    chip.id = "bw-poem-chip";
    chip.innerHTML = `
      <div class="bw-title">BLACKOUT POEM</div>
      <div class="bw-poem"></div>
      <div class="bw-sub">tap to reroll • mode: ${settings.mode}</div>
    `;
    chip.querySelector(".bw-poem").textContent = poemText;

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
  }

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
        else span.className = "bw-hide";

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
      if (!p.dataset.bwOrig) p.dataset.bwOrig = p.innerHTML;
      p.dataset.bwProcessed = "1";
    }

    const allWords = getVisibleWordStream(paragraphs);
    if (allWords.length < 10) return;

    const { keepPositions, windows } = pickPoemWordPositions(allWords, settings);
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
      if (p.dataset.bwOrig != null) p.innerHTML = p.dataset.bwOrig;
      delete p.dataset.bwOrig;
      delete p.dataset.bwProcessed;
    }

    bwState.processedParagraphs = [];
  }

  async function syncToSetting() {
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

  // Reapply on resize/scroll with light debounce so viewport-only stays true
  let viewportTimer = null;
  function debouncedViewportSync() {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      getSettings().then(s => {
        if (s.enabled) syncToSetting();
      });
    }, 220);
  }

  window.addEventListener("resize", debouncedViewportSync, { passive: true });
  window.addEventListener("scroll", debouncedViewportSync, { passive: true });

  // Initial apply
  syncToSetting();
})();
