/**
 * Content script — extracts clean page content and links.
 * Responds to messages from the side panel.
 */

if (window.__raContentLoaded) return;
window.__raContentLoaded = true;

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "extractContent") {
    sendResponse(extractPageContent());
  } else if (request.action === "geminiProxy") {
    // First test basic connectivity with a simple GET (no preflight, no body)
    fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(request.apiKey)}`)
      .then(async () => {
        // Domain reachable — now try the actual POST
        const urlWithKey = `${request.url}?key=${encodeURIComponent(request.apiKey)}`;
        return fetch(urlWithKey, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: request.body,
        });
      })
      .then(async (resp) => {
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          sendResponse({ ok: false, error: errData.error?.message || `HTTP ${resp.status}` });
        } else {
          const data = await resp.json();
          sendResponse({ ok: true, data });
        }
      })
      .catch((e) => {
        const msg = e.message === "Failed to fetch"
          ? "Cannot reach generativelanguage.googleapis.com — check if an ad blocker or firewall is blocking it"
          : e.message;
        sendResponse({ ok: false, error: msg });
      });
    return true; // keep channel open for async response
  } else if (request.action === "highlightPage") {
    applyHighlights(request.highlights, request.startIndex || 0);
    sendResponse({ ok: true });
  } else if (request.action === "addHighlight") {
    applyHighlights([request.highlight], request.index);
    sendResponse({ ok: true });
  } else if (request.action === "clearHighlights") {
    clearHighlights();
    sendResponse({ ok: true });
  } else if (request.action === "focusHighlight") {
    focusHighlight(request.index);
    sendResponse({ ok: true });
  } else if (request.action === "clearFocus") {
    clearFocus();
    sendResponse({ ok: true });
  }
  return true;
});

function extractPageContent() {
  // Try to find the most relevant content container
  const contentSelectors = [
    "article",
    "main",
    '[role="main"]',
    ".post-content",
    ".article-content",
    ".entry-content",
    ".content",
    "#content",
    ".post",
    ".article",
  ];

  let mainEl = null;

  // 1. Try known semantic selectors
  for (const sel of contentSelectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 200) {
      mainEl = el;
      break;
    }
  }

  // 2. Fallback: find the block element with the most text
  if (!mainEl) {
    let best = null;
    let bestLen = 0;
    document.querySelectorAll("div, section, main, article").forEach((el) => {
      // Skip tiny, hidden, or clearly structural elements
      if (el.offsetHeight === 0) return;
      const len = (el.innerText || "").trim().length;
      if (len > bestLen) { bestLen = len; best = el; }
    });
    mainEl = best || document.body;
  }

  // Clone so we can strip noise without affecting the page
  const clone = mainEl.cloneNode(true);

  // Remove noise elements
  const noiseSelectors = [
    "script",
    "style",
    "noscript",
    "nav",
    "header",
    "footer",
    "aside",
    ".sidebar",
    ".navigation",
    ".nav",
    ".menu",
    ".ad",
    ".ads",
    ".advertisement",
    ".cookie-banner",
    ".popup",
    "#comments",
    ".comments",
    '[aria-hidden="true"]',
    "[hidden]",
  ];
  clone.querySelectorAll(noiseSelectors.join(",")).forEach((el) => el.remove());

  // Get clean text
  let text = clone.innerText || clone.textContent || "";
  text = text.replace(/\t/g, " ").replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  // Extract meaningful links (skip nav/social/boilerplate)
  const links = [];
  const seen = new Set();
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href;
    const linkText = a.textContent.trim();
    if (
      href &&
      !href.startsWith("javascript:") &&
      !href.startsWith("#") &&
      !href.startsWith("mailto:") &&
      linkText &&
      linkText.length > 2 &&
      !seen.has(href)
    ) {
      seen.add(href);
      links.push({ url: href, text: linkText.substring(0, 100) });
    }
  });

  // Include top-level domain links (references/sources) in content context
  const referencesText =
    links.length > 0
      ? "\n\nPAGE LINKS:\n" +
        links
          .slice(0, 40)
          .map((l) => `- ${l.text}: ${l.url}`)
          .join("\n")
      : "";

  return {
    url: window.location.href,
    title: document.title,
    content: text.substring(0, 12000) + referencesText,
    linkCount: links.length,
  };
}

// ── Page highlighting ──────────────────────────────────────────────────────

const SKIP_TAGS = new Set(["script", "style", "noscript", "textarea", "input", "select", "code", "pre"]);

function applyHighlights(highlights, startIndex = 0) {
  ensureHighlightStyles();
  ensureTooltip();
  highlights.forEach((h, i) => {
    highlightPhrase(h.phrase, h.category, h.note, h.source || "", h.source_url || "", startIndex + i);
  });
}

function clearHighlights() {
  document.querySelectorAll(".ra-highlight").forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent));
  });
  // Merge adjacent text nodes left by the above
  document.body.normalize();
}

function highlightPhrase(phrase, category, note, source, sourceUrl, index) {
  if (!phrase || phrase.length < 4) return;

  // Collect all eligible text nodes and build a full-page text map
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    const tag = node.parentElement?.tagName?.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    if (node.parentElement?.closest(".ra-highlight")) continue;
    textNodes.push(node);
  }

  // Build concatenated text with per-node start offsets
  let fullText = "";
  const offsets = [];
  for (const tn of textNodes) {
    offsets.push({ node: tn, start: fullText.length });
    fullText += tn.textContent;
  }

  // Try exact case-insensitive match first, then whitespace-normalised fallback
  let matchIdx = fullText.toLowerCase().indexOf(phrase.toLowerCase());

  if (matchIdx === -1) {
    const normPhrase = phrase.replace(/\s+/g, " ").trim().toLowerCase();
    const normFull   = fullText.replace(/\s+/g, " ").toLowerCase();
    const normIdx    = normFull.indexOf(normPhrase);
    if (normIdx === -1) return;
    matchIdx = normToOrig(fullText, normIdx);
    if (matchIdx === -1) return;
  }

  // Find which text node owns matchIdx
  let target = null;
  for (let i = offsets.length - 1; i >= 0; i--) {
    if (offsets[i].start <= matchIdx) { target = offsets[i]; break; }
  }
  if (!target) return;

  const localIdx  = matchIdx - target.start;
  const nodeText  = target.node.textContent;
  const wrapLen   = Math.min(phrase.length, nodeText.length - localIdx);
  if (wrapLen <= 0) return;

  // Split the text node and inject the highlight span
  const before = nodeText.substring(0, localIdx);
  const match  = nodeText.substring(localIdx, localIdx + wrapLen);
  const after  = nodeText.substring(localIdx + wrapLen);

  const frag = document.createDocumentFragment();
  if (before) frag.appendChild(document.createTextNode(before));

  const span = document.createElement("span");
  span.className = `ra-highlight ra-hl-${category}`;
  span.textContent = match;
  span.dataset.raNote = note;
  span.dataset.raCategory = category;
  span.dataset.raIndex = index;
  if (source)    span.dataset.raSource = source;
  if (sourceUrl) span.dataset.raSourceUrl = sourceUrl;
  frag.appendChild(span);

  if (after) frag.appendChild(document.createTextNode(after));
  target.node.parentNode.replaceChild(frag, target.node);
}

// Map a position in whitespace-normalised text back to the original string
function normToOrig(original, normIdx) {
  let norm = 0;
  let prevSpace = false;
  for (let i = 0; i < original.length; i++) {
    if (norm === normIdx) return i;
    const sp = /\s/.test(original[i]);
    if (sp) { if (!prevSpace) norm++; prevSpace = true; }
    else    { norm++; prevSpace = false; }
  }
  return norm === normIdx ? original.length : -1;
}

function focusHighlight(index) {
  const el = document.querySelector(`.ra-highlight[data-ra-index="${index}"]`);
  if (!el) return;

  // Remove previous focus
  document.querySelectorAll(".ra-highlight.ra-focused").forEach(e => e.classList.remove("ra-focused"));
  el.classList.add("ra-focused");

  el.scrollIntoView({ behavior: "smooth", block: "center" });

  // Pin tooltip to element
  const tooltip = document.getElementById("ra-tooltip");
  if (!tooltip) return;

  const cat = el.dataset.raCategory || "";
  const LABELS = {
    misinformation: "⚠ Misinformation Risk",
    emotional:      "💬 Emotional Language",
    bias:           "⚖ Bias / Framing",
    supported:      "✓ Supported Claim",
    logical:        "⧖ Logic Flaw",
  };
  tooltip.querySelector(".ra-tt-label").className = `ra-tt-label ra-tt-${cat}`;
  tooltip.querySelector(".ra-tt-label").textContent = LABELS[cat] || cat;
  tooltip.querySelector(".ra-tt-note").textContent = el.dataset.raNote || "";

  const srcEl = tooltip.querySelector(".ra-tt-source");
  const srcName = el.dataset.raSource || "";
  const srcUrl  = el.dataset.raSourceUrl || "";
  if (srcName) {
    srcEl.textContent = srcName;
    srcEl.dataset.url = srcUrl || "";
    srcEl.style.pointerEvents = srcUrl ? "auto" : "none";
    srcEl.style.cursor = srcUrl ? "pointer" : "default";
    srcEl.style.display = "block";
  } else {
    srcEl.style.display = "none";
  }

  // Position below the element
  const rect = el.getBoundingClientRect();
  let x = rect.left;
  let y = rect.bottom + 8;
  if (y + 130 > window.innerHeight) y = rect.top - 130;
  if (x + 310 > window.innerWidth)  x = window.innerWidth - 314;
  tooltip.style.left = Math.max(4, x) + "px";
  tooltip.style.top  = Math.max(4, y) + "px";
  tooltip.style.display = "block";
  tooltip.style.pointerEvents = "auto";
}

function clearFocus() {
  document.querySelectorAll(".ra-highlight.ra-focused").forEach(e => e.classList.remove("ra-focused"));
  const tooltip = document.getElementById("ra-tooltip");
  if (tooltip) {
    tooltip.style.display = "none";
    tooltip.style.pointerEvents = "none";
  }
}

function ensureHighlightStyles() {
  if (document.getElementById("ra-highlight-styles")) return;

  const style = document.createElement("style");
  style.id = "ra-highlight-styles";
  style.textContent = `
    .ra-highlight {
      border-radius: 2px;
      cursor: pointer;
      transition: filter 0.12s, outline 0.12s;
    }
    .ra-highlight:hover { filter: brightness(0.8); }
    .ra-highlight.ra-focused {
      outline: 2px solid currentColor;
      outline-offset: 2px;
      animation: ra-focus-pulse 1.2s ease-in-out infinite;
    }
    @keyframes ra-focus-pulse {
      0%, 100% { outline-offset: 2px; }
      50%       { outline-offset: 4px; }
    }

    .ra-hl-misinformation { background: rgba(255,107,107,0.28); border-bottom: 2px solid #ff6b6b; }
    .ra-hl-emotional      { background: rgba(255,169,77,0.28);  border-bottom: 2px solid #ffa94d; }
    .ra-hl-bias           { background: rgba(255,212,59,0.22);  border-bottom: 2px solid #ffd43b; }
    .ra-hl-supported      { background: rgba(105,219,124,0.2);  border-bottom: 2px solid #69db7c; }
    .ra-hl-logical        { background: rgba(218,119,242,0.2);  border-bottom: 2px solid #da77f2; }

    #ra-tooltip {
      position: fixed;
      z-index: 2147483647;
      background: #1a1b1e;
      color: #c9d1d9;
      border: 1px solid #373a40;
      border-radius: 8px;
      padding: 9px 13px;
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 290px;
      line-height: 1.5;
      pointer-events: none;
      box-shadow: 0 6px 20px rgba(0,0,0,0.5);
      display: none;
    }
    #ra-tooltip .ra-tt-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 4px;
    }
    .ra-tt-misinformation { color: #ff6b6b; }
    .ra-tt-emotional      { color: #ffa94d; }
    .ra-tt-bias           { color: #ffd43b; }
    .ra-tt-supported      { color: #69db7c; }
    .ra-tt-logical        { color: #da77f2; }
    #ra-tooltip .ra-tt-source {
      display: none;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid #373a40;
      font-size: 11px;
      color: #4dabf7;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: auto;
      user-select: none;
    }
    #ra-tooltip .ra-tt-source:hover { text-decoration: underline; }
  `;
  document.head.appendChild(style);
}

function ensureTooltip() {
  if (document.getElementById("ra-tooltip")) return;

  const LABELS = {
    misinformation: "⚠ Misinformation Risk",
    emotional:      "💬 Emotional Language",
    bias:           "⚖ Bias / Framing",
    supported:      "✓ Supported Claim",
    logical:        "⧖ Logic Flaw",
  };

  const tooltip = document.createElement("div");
  tooltip.id = "ra-tooltip";
  tooltip.innerHTML = `
    <div class="ra-tt-label"></div>
    <div class="ra-tt-note"></div>
    <span class="ra-tt-source"></span>`;
  document.body.appendChild(tooltip);

  function populateAndPin(el) {
    const cat = el.dataset.raCategory || "";
    tooltip.querySelector(".ra-tt-label").className = `ra-tt-label ra-tt-${cat}`;
    tooltip.querySelector(".ra-tt-label").textContent = LABELS[cat] || cat;
    tooltip.querySelector(".ra-tt-note").textContent = el.dataset.raNote || "";

    const srcEl   = tooltip.querySelector(".ra-tt-source");
    const srcName = el.dataset.raSource || "";
    const srcUrl  = el.dataset.raSourceUrl || "";
    if (srcName) {
      srcEl.textContent = srcName;
      srcEl.href = srcUrl || "#";
      srcEl.style.pointerEvents = srcUrl ? "auto" : "none";
      srcEl.style.display = "block";
    } else {
      srcEl.style.display = "none";
    }

    tooltip.style.pointerEvents = "auto";
    tooltip.style.display = "block";

    // Pin below (or above) the element — never follows the mouse
    const rect = el.getBoundingClientRect();
    let x = rect.left;
    let y = rect.bottom + 8;
    if (y + 150 > window.innerHeight) y = rect.top - 150;
    if (x + 310 > window.innerWidth)  x = window.innerWidth - 314;
    tooltip.style.left = Math.max(4, x) + "px";
    tooltip.style.top  = Math.max(4, y) + "px";
  }


  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest(".ra-highlight");
    if (el) populateAndPin(el);
  });

  document.addEventListener("mouseout", (e) => {
    if (!e.target.closest(".ra-highlight")) return;
    // Don't hide when moving from highlight into the tooltip
    if (e.relatedTarget?.closest?.("#ra-tooltip")) return;
    tooltip.style.display = "none";
  });

  tooltip.addEventListener("mouseleave", (e) => {
    // Hide when leaving tooltip, unless moving back to a highlight
    if (!e.relatedTarget?.closest?.(".ra-highlight")) tooltip.style.display = "none";
  });
}
