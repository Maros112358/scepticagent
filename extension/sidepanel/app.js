// ── State ──────────────────────────────────────────────────────────────────
let pageData = null;          // { url, title, content, linkCount }
let chatHistory = [];         // [{ role, content }]
let analysisText = "";        // Accumulated analysis text
let isBusy = false;

// ── Init ───────────────────────────────────────────────────────────────────
(async () => {
  // Load current tab info immediately
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      document.getElementById("page-title").textContent = tab.title || tab.url || "Unknown page";
    }
  } catch (_) {}

  // Check for active provider's API key
  const stored = await chrome.storage.local.get(["provider", "anthropicKey", "openaiKey", "geminiKey", "apiKey"]);
  const provider = stored.provider || "anthropic";
  const keyMap = { anthropic: stored.anthropicKey || stored.apiKey, openai: stored.openaiKey, gemini: stored.geminiKey };
  if (!keyMap[provider]) {
    showSetupScreen();
    return;
  }

  // Auto-start analysis as soon as the panel opens
  startAnalysis();
})();

function showSetupScreen() {
  document.getElementById("setup-screen").classList.remove("hidden");
  document.getElementById("tabs").classList.add("hidden");
  document.getElementById("tab-analysis").classList.add("hidden");
  document.getElementById("tab-chat").classList.add("hidden");
}

document.getElementById("setup-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// ── Settings button ────────────────────────────────────────────────────────
document.getElementById("settings-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
  });
});

// ── Start analysis ─────────────────────────────────────────────────────────
document.getElementById("start-btn").addEventListener("click", startAnalysis);
document.getElementById("restart-btn").addEventListener("click", () => {
  document.getElementById("analysis-result").classList.add("hidden");
  document.getElementById("analysis-empty").classList.remove("hidden");
  document.getElementById("hl-legend").classList.add("hidden");
  document.getElementById("clear-hl-btn").classList.add("hidden");
  document.getElementById("highlight-btn").classList.remove("hidden");
  analysisText = "";
  chatHistory = [];
  sendToContentScript({ action: "clearHighlights" });
});

document.getElementById("highlight-btn").addEventListener("click", highlightPage);
document.getElementById("share-btn").addEventListener("click", shareViaEmail);
document.getElementById("clear-hl-btn").addEventListener("click", () => {
  sendToContentScript({ action: "clearHighlights" });
  document.getElementById("hl-legend").classList.add("hidden");
  document.getElementById("clear-hl-btn").classList.add("hidden");
  document.getElementById("highlight-btn").classList.remove("hidden");
  document.getElementById("highlight-summary").classList.add("hidden");
  document.getElementById("highlight-list").classList.add("hidden");
});

async function startAnalysis() {
  if (isBusy) return;

  pageData = await extractCurrentPage();
  if (!pageData) return;

  document.getElementById("page-title").textContent = pageData.title;
  document.getElementById("analysis-empty").classList.add("hidden");
  document.getElementById("analysis-result").classList.remove("hidden");
  document.getElementById("analysis-content").innerHTML = "";
  document.getElementById("highlight-btn").classList.add("hidden");
  document.getElementById("clear-hl-btn").classList.add("hidden");
  document.getElementById("share-btn").classList.add("hidden");
  document.getElementById("hl-legend").classList.add("hidden");
  analysisText = "";
  chatHistory = [];

  setStatus("Extracting page content...");

  // Fire analysis streaming and quick highlights in parallel
  const highlightPromise = quickHighlightPage(pageData.content);

  await streamViaPort(
    "analyze",
    { url: pageData.url, title: pageData.title, content: pageData.content },
    (delta) => {
      analysisText += delta;
      // Skip preamble — only render once a markdown heading appears
      const firstHeading = analysisText.indexOf("\n##");
      const renderText = firstHeading !== -1 ? analysisText.slice(firstHeading + 1) : "";
      if (renderText) {
        document.getElementById("analysis-content").innerHTML = renderMarkdown(renderText);
        setupSectionCollapse();
      }
    },
    () => {
      if (analysisText) {
        document.getElementById("share-btn").classList.remove("hidden");
      }
    }
  );

  await highlightPromise;
}

async function quickHighlightPage(content) {
  document.getElementById("scan-strip").classList.remove("hidden");
  document.getElementById("highlight-list").innerHTML = "";
  const collectedHighlights = [];

  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: "agent" });

    port.onMessage.addListener(async (event) => {
      try {
        if (event.type === "highlight_item") {
          const h = event.highlight;
          const i = event.index;
          collectedHighlights.push(h);
          sendToContentScript({ action: "addHighlight", highlight: h, index: i });
          appendHighlightListItem(h, i);
          if (collectedHighlights.length === 1) {
            document.getElementById("hl-legend").classList.remove("hidden");
            document.getElementById("clear-hl-btn").classList.remove("hidden");
            document.getElementById("highlight-list").classList.remove("hidden");
          }
        } else if (event.type === "highlights_result") {
          document.getElementById("scan-strip").classList.add("hidden");
          if (collectedHighlights.length > 0) {
            renderHighlightSummary(event.summary || "", event.categorySummaries || {}, collectedHighlights);
          }
        } else if (event.type === "error") {
          console.error("[RA] highlights error:", event.message);
          showError(`Highlights: ${event.message}`);
          document.getElementById("scan-strip").classList.add("hidden");
        }
      } catch (e) {
        console.error("[RA] highlights handler threw:", e);
      }
    });

    port.onDisconnect.addListener(() => {
      document.getElementById("scan-strip").classList.add("hidden");
      resolve();
    });
    port.postMessage({ type: "highlights", content, analysis: "" });
  });
}

// ── Chat ───────────────────────────────────────────────────────────────────
document.getElementById("chat-send-btn").addEventListener("click", sendChat);
document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

async function sendChat() {
  const input = document.getElementById("chat-input");
  const msg = input.value.trim();
  if (!msg || isBusy) return;

  if (!pageData) {
    pageData = await extractCurrentPage();
    if (!pageData) return;
  }

  input.value = "";
  appendChatMsg("user", msg);

  const assistantEl = appendChatMsg("assistant", "");

  await streamViaPort(
    "chat",
    {
      url: pageData.url,
      title: pageData.title,
      content: pageData.content,
      messages: chatHistory,
      new_message: msg,
    },
    (delta) => {
      assistantEl._text = (assistantEl._text || "") + delta;
      assistantEl.innerHTML = renderMarkdown(assistantEl._text);
      // Scroll chat to bottom
      const msgs = document.getElementById("chat-messages");
      msgs.scrollTop = msgs.scrollHeight;
    }
  );

  // Save to history
  chatHistory.push({ role: "user", content: msg });
  chatHistory.push({ role: "assistant", content: assistantEl._text || "" });
}

function appendChatMsg(role, text) {
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  if (text) el.innerHTML = role === "assistant" ? renderMarkdown(text) : escapeHtml(text);
  document.getElementById("chat-messages").appendChild(el);

  // Hide empty state if present
  document.getElementById("chat-empty").classList.add("hidden");

  const msgs = document.getElementById("chat-messages");
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}

// ── Core streaming via background port ─────────────────────────────────────
function streamViaPort(msgType, body, onDelta, onDone) {
  return new Promise((resolve) => {
    setBusy(true);
    setToolStrip(false);

    const port = chrome.runtime.connect({ name: "agent" });

    port.onMessage.addListener((event) => {
      handleEvent(event, onDelta);
      if (event.type === "done") {
        if (onDone) onDone();
        port.disconnect();
      } else if (event.type === "error") {
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      setBusy(false);
      setStatus(null);
      setToolStrip(false);
      resolve();
    });

    port.postMessage({ type: msgType, ...body });
  });
}

function handleEvent(event, onDelta) {
  switch (event.type) {
    case "status":
      setStatus(event.message);
      break;
    case "tool_call":
      setToolStrip(true, event.label || event.name);
      break;
    case "text_delta":
      setToolStrip(false);
      onDelta(event.text);
      break;
    case "done":
      setToolStrip(false);
      setStatus(null);
      break;
    case "error":
      showError(event.message);
      break;
  }
}

// ── Page extraction ────────────────────────────────────────────────────────
async function extractCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { showError("No active tab found."); return null; }

    const url = tab.url || "";
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      showError("Navigate to a webpage first — this extension can't run on browser pages.");
      return null;
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action: "extractContent" });
    if (!response) { showError("Could not extract page content."); return null; }
    return response;
  } catch (err) {
    showError(`Page extraction failed: ${err.message}`);
    return null;
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function setBusy(busy) {
  isBusy = busy;
  document.getElementById("start-btn").disabled = busy;
  document.getElementById("chat-send-btn").disabled = busy;
  document.getElementById("chat-input").disabled = busy;
}

function setStatus(message) {
  const bar = document.getElementById("status-bar");
  if (message) {
    bar.classList.remove("hidden");
    document.getElementById("status-text").textContent = message;
  } else {
    bar.classList.add("hidden");
  }
}

function setToolStrip(visible, label = "") {
  const strip = document.getElementById("tool-strip");
  if (visible) {
    strip.classList.remove("hidden");
    document.getElementById("tool-label").textContent = label;
    const isSearch = label.toLowerCase().includes("search");
    document.getElementById("tool-icon").textContent = isSearch ? "🔍" : "🌐";
  } else {
    strip.classList.add("hidden");
  }
}

function showError(msg) {
  const bar = document.getElementById("error-bar");
  document.getElementById("error-text").textContent = msg;
  bar.classList.remove("hidden");
}

document.getElementById("error-close").addEventListener("click", () => {
  document.getElementById("error-bar").classList.add("hidden");
});

// ── Section collapse for analysis headings ─────────────────────────────────
function setupSectionCollapse() {
  document.querySelectorAll("#analysis-content h2").forEach((h2) => {
    if (h2._collapseSet) return;
    h2._collapseSet = true;
    h2.addEventListener("click", () => {
      const body = h2.nextElementSibling;
      if (!body || !body.classList.contains("section-body")) return;
      const collapsed = body.classList.toggle("collapsed");
      h2.classList.toggle("collapsed", collapsed);
    });
  });
}

// ── Markdown renderer ──────────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";

  // Escape HTML
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks (```...```)
  html = html.replace(/```[\s\S]*?```/g, (m) => {
    const inner = m.slice(3, -3).replace(/^\w+\n/, "");
    return `<pre><code>${inner}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_\n]+)_/g, "<em>$1</em>");

  // Links
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Process line by line for structure
  const lines = html.split("\n");
  const out = [];
  let listType = null; // "ul" or "ol"
  let sectionOpen = false;

  function closeList() {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // h2 — collapsible sections
    const h2 = trimmed.match(/^## (.+)$/);
    if (h2) {
      closeList();
      if (sectionOpen) out.push("</div>");
      out.push(`<h2>${h2[1]}</h2><div class="section-body">`);
      sectionOpen = true;
      continue;
    }

    // h3
    const h3 = trimmed.match(/^### (.+)$/);
    if (h3) {
      closeList();
      out.push(`<h3>${h3[1]}</h3>`);
      continue;
    }

    // h1
    const h1 = trimmed.match(/^# (.+)$/);
    if (h1) {
      closeList();
      out.push(`<h1>${h1[1]}</h1>`);
      continue;
    }

    // Bullet list (trim to handle indented items)
    const bullet = trimmed.match(/^[*\-] (.+)$/);
    if (bullet) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }

    // Numbered list (trim to handle indented items)
    const numbered = trimmed.match(/^\d+\. (.+)$/);
    if (numbered) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${numbered[1]}</li>`);
      continue;
    }

    // Blank line
    if (trimmed === "") {
      closeList();
      out.push("<br>");
      continue;
    }

    // Regular paragraph line
    if (!listType) out.push(`<p>${line}</p>`);
  }

  closeList();
  if (sectionOpen) out.push("</div>");

  return out.join("\n");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Highlight summary ──────────────────────────────────────────────────────
const CAT_META = {
  misinformation: { icon: "⚠", label: "Misinformation", color: "#ff6b6b" },
  emotional:      { icon: "💬", label: "Emotional",      color: "#ffa94d" },
  bias:           { icon: "⚖", label: "Bias",            color: "#ffd43b" },
  supported:      { icon: "✓",  label: "Supported",       color: "#69db7c" },
  logical:        { icon: "⧖", label: "Logic Flaw",      color: "#da77f2" },
};

function renderHighlightSummary(summary, categorySummaries, highlights) {
  const el = document.getElementById("highlight-summary");

  // Category order
  const order = ["misinformation", "emotional", "bias", "supported", "logical"];
  const present = order.filter(c => categorySummaries[c]);

  const bullets = present.map(cat => {
    const m = CAT_META[cat] || { icon: "", label: cat, color: "#ccc" };
    return `<li class="summary-bullet summary-bullet-${cat}">
      <span class="summary-bullet-icon" style="color:${m.color}">${m.icon} ${m.label}</span>
      <span class="summary-bullet-text">${escapeHtml(categorySummaries[cat])}</span>
    </li>`;
  }).join("");

  el.innerHTML = `
    ${summary ? `<p class="summary-text">${escapeHtml(summary)}</p>` : ""}
    ${bullets ? `<ul class="summary-bullets">${bullets}</ul>` : ""}`;

  el.classList.remove("hidden");
}

// ── Highlight list ─────────────────────────────────────────────────────────
function appendHighlightListItem(h, i) {
  const list = document.getElementById("highlight-list");
  const item = document.createElement("div");
  item.className = "hl-item";
  item.dataset.index = i;
  item.innerHTML = `
    <span class="hl-item-dot ${h.category}"></span>
    <span class="hl-item-phrase">${escapeHtml(h.phrase.length > 70 ? h.phrase.slice(0, 70) + "…" : h.phrase)}</span>
  `;
  item.addEventListener("mouseenter", () => {
    sendToContentScript({ action: "focusHighlight", index: i });
  });
  item.addEventListener("mouseleave", () => {
    sendToContentScript({ action: "clearFocus" });
  });
  list.appendChild(item);
}

function renderHighlightList(highlights) {
  document.getElementById("highlight-list").innerHTML = "";
  highlights.forEach((h, i) => appendHighlightListItem(h, i));
  document.getElementById("highlight-list").classList.remove("hidden");
}

// ── Page highlighting ──────────────────────────────────────────────────────

async function highlightPage() {
  if (!analysisText || !pageData) {
    showError("Run the analysis first before highlighting.");
    return;
  }

  const btn = document.getElementById("highlight-btn");
  btn.disabled = true;
  btn.textContent = "Extracting phrases...";
  setStatus("Finding phrases to highlight...");

  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: "agent" });
    const collectedHighlights = [];
    document.getElementById("highlight-list").innerHTML = "";

    port.onMessage.addListener(async (event) => {
      if (event.type === "highlight_item") {
        const h = event.highlight;
        const i = event.index;
        collectedHighlights.push(h);
        sendToContentScript({ action: "addHighlight", highlight: h, index: i });
        appendHighlightListItem(h, i);
        if (collectedHighlights.length === 1) {
          document.getElementById("hl-legend").classList.remove("hidden");
          document.getElementById("clear-hl-btn").classList.remove("hidden");
          document.getElementById("highlight-list").classList.remove("hidden");
          btn.classList.add("hidden");
        }
      } else if (event.type === "highlights_result") {
        if (collectedHighlights.length === 0) {
          showError("No exact phrases could be matched on this page.");
        } else {
          renderHighlightSummary(event.summary || "", event.categorySummaries || {}, collectedHighlights);
        }
        port.disconnect();
      } else if (event.type === "error") {
        showError(`Highlight failed: ${event.message}`);
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      btn.disabled = false;
      btn.textContent = "✦ Highlight Page";
      setStatus(null);
      resolve();
    });

    port.postMessage({ type: "highlights", content: pageData.content, analysis: analysisText });
  });
}

// ── Share via email ─────────────────────────────────────────────────────────
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, "")        // headings
    .replace(/\*\*(.+?)\*\*/g, "$1")    // bold
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")    // italic
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → label only
    .replace(/^[*\-]\s+/gm, "• ")       // bullet lists
    .replace(/^\d+\.\s+/gm, "")         // numbered lists
    .replace(/\n{3,}/g, "\n\n")         // collapse excess blank lines
    .trim();
}

function shareViaEmail() {
  if (!analysisText || !pageData) return;

  const subject = `ScepticAgent analysis: ${pageData.title}`;
  const body = `${stripMarkdown(analysisText)}\n\n---\nOriginal page: ${pageData.url}`;

  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(mailto, "_self");
}

async function sendToContentScript(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    console.warn("sendToContentScript failed:", err.message);
  }
}
