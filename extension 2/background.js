const API_BASE        = "https://api.anthropic.com/v1";
const OPENAI_API_BASE = "https://api.openai.com/v1";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const TOOLS = [
  { type: "web_search_20250305", name: "web_search" },
  {
    name: "fetch_url",
    description: "Fetch the text content of a URL. Use this to read sources, studies, references, or articles mentioned in or related to the page.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to fetch" }
      },
      required: ["url"]
    }
  }
];

// ── Provider config ───────────────────────────────────────────────────────────
async function getProviderConfig() {
  const d = await chrome.storage.local.get([
    "provider", "anthropicKey", "anthropicModel",
    "openaiKey", "openaiModel", "geminiKey", "geminiModel", "apiKey"
  ]);
  const provider = d.provider || "anthropic";
  const keyMap = {
    anthropic: (d.anthropicKey || d.apiKey || "").trim(),
    openai:    (d.openaiKey || "").trim(),
    gemini:    (d.geminiKey || "").trim(),
  };
  const modelMap = {
    anthropic: d.anthropicModel || "claude-opus-4-6",
    openai:    d.openaiModel    || "gpt-4o",
    gemini:    d.geminiModel    || "gemini-2.5-flash",
  };
  return { provider, apiKey: keyMap[provider], model: modelMap[provider] };
}

// ── Init ─────────────────────────────────────────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);


// ── Port-based agent communication ───────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agent") return;

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async (msg) => {
    const config = await getProviderConfig();
    if (!config.apiKey) {
      port.postMessage({ type: "error", message: "API key not set. Click ⚙ Settings to configure." });
      return;
    }

    try {
      if (msg.type === "analyze")         await handleAnalyze(port, config, msg, controller.signal);
      else if (msg.type === "chat")       await handleChat(port, config, msg, controller.signal);
      else if (msg.type === "highlights") await handleHighlights(port, config, msg, controller.signal);
    } catch (e) {
      if (e.name !== "AbortError") {
        port.postMessage({ type: "error", message: `[${config.provider}/${config.model}] ${e.name}: ${e.message}` });
      }
    }
  });
});

// ── Handlers ─────────────────────────────────────────────────────────────────
const ANALYZE_PROMPT = "Please analyze this webpage thoroughly. Search the web to verify claims and find supporting and opposing perspectives.";

async function handleAnalyze(port, config, msg, signal) {
  const system = buildAnalysisSystem(msg.url, msg.title, msg.content);
  if (config.provider === "anthropic") {
    await runAgentLoop(port, config.apiKey, system, [{ role: "user", content: ANALYZE_PROMPT }], signal, config.model);
  } else if (config.provider === "openai") {
    await runOpenAIStream(port, config.apiKey, config.model, system, [{ role: "user", content: ANALYZE_PROMPT }], signal);
  } else if (config.provider === "gemini") {
    await runGeminiStream(port, config.apiKey, config.model, system, [{ role: "user", parts: [{ text: ANALYZE_PROMPT }] }], signal);
  }
}

async function handleChat(port, config, msg, signal) {
  const system = buildChatSystem(msg.url, msg.title, msg.content);
  if (config.provider === "anthropic") {
    const messages = [
      ...msg.messages.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: msg.new_message }
    ];
    await runAgentLoop(port, config.apiKey, system, messages, signal, config.model);
  } else if (config.provider === "openai") {
    const messages = [
      ...msg.messages.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: msg.new_message }
    ];
    await runOpenAIStream(port, config.apiKey, config.model, system, messages, signal);
  } else if (config.provider === "gemini") {
    const contents = [
      ...msg.messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      { role: "user", parts: [{ text: msg.new_message }] }
    ];
    await runGeminiStream(port, config.apiKey, config.model, system, contents, signal);
  }
}

function buildHighlightsPrompt(withSearch) {
  return `${withSearch
    ? `STEP 1 — Research: Use web_search to find specific article URLs for the key claims (2–3 searches max).\nSTEP 2 — Output: Respond with ONLY the JSON below.\n`
    : `Respond with ONLY the JSON below.\n`}
Rules:
- Each phrase must appear EXACTLY (verbatim) in the PAGE CONTENT
- Phrases must be 8–180 characters long
- Prefer specific, distinctive phrases over generic ones
- Maximum 25 highlights total

Categories:
- "supported": a claim confirmed as well-supported
- "misinformation": false, misleading, or critically lacking context
- "bias": biased framing, selective emphasis, or loaded language
- "emotional": fear appeal, outrage bait, or us-vs-them language
- "logical": internal contradiction, non-sequitur, or false dichotomy

For "note": concise explanation (max 90 chars).
For "source": publication name. Empty string if none.
For "source_url": ${withSearch
    ? "full URL to a specific article found via web_search. Never invent URLs. Empty string if none found."
    : "leave empty string — no web search available."}
For "summary": exactly two sentences — what the article is about, then how emotional/factual/biased/misinforming it is.
For "category_summaries": one sentence per category that has highlights.

IMPORTANT JSON rules:
- Do NOT select phrases containing quote characters (" ' „ " " « »)
- Do NOT use markdown code fences
- Escape any backslashes in values

Respond with ONLY a valid JSON object:
{"summary":"...","category_summaries":{"misinformation":"...","emotional":"..."},"highlights":[{"phrase":"...","category":"...","note":"...","source":"...","source_url":"..."}]}`;
}

async function handleHighlights(port, config, msg, signal) {
  const { content, analysis } = msg;
  const hasAnalysis = analysis?.trim();

  // Non-Claude providers use simple JSON prompt (no agent loop)
  if (config.provider !== "anthropic") {
    await handleHighlightsSimple(port, config, content, signal);
    return;
  }

  // Real-time highlight emitter — extracts complete objects from streaming text
  let hlCount = 0;
  let hlSearchPos = 0;
  let hlAccText = "";
  const hlEmitter = (chunk) => {
    hlAccText += chunk;
    const { highlights: newHl, nextPos } = extractCompleteHighlights(hlAccText, hlSearchPos);
    hlSearchPos = nextPos;
    for (const h of newHl) {
      port.postMessage({ type: "highlight_item", highlight: h, index: hlCount++ });
    }
  };

  let finalText;
  if (hasAnalysis) {
    // Manual "Highlight Page" — use agent loop with web search for real URLs
    const system = `You are a fact-checking assistant with web_search access.

PAGE CONTENT:
${content.slice(0, 8000)}

EXISTING ANALYSIS (contains already-verified URLs — prefer these):
${analysis.slice(0, 4000)}`;

    const userPrompt = buildHighlightsPrompt(true);
    finalText = await runHighlightsAgentLoop(port, config.apiKey, system, userPrompt, signal, hlEmitter, config.model);
  } else {
    // Parallel auto-run — fast streaming, no web search
    port.postMessage({ type: "status", message: "Scanning page..." });
    const prompt = `You are given a webpage's text content.\nYour job: analyze the content directly and extract verbatim phrases.

PAGE CONTENT:
${content.slice(0, 8000)}

${buildHighlightsPrompt(false)}`;

    const response = await fetch(`${API_BASE}/messages`, {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4000,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      port.postMessage({ type: "error", message: err.error?.message || `HTTP ${response.status}` });
      return;
    }
    const { blocks } = await parseAgentStream(response, port, hlEmitter);
    finalText = blocks.find(b => b?.type === "text")?.text || "";
  }

  // Parse summary + category_summaries from the full response text
  let summary = "";
  let categorySummaries = {};
  try {
    const match = finalText.match(/\{[\s\S]*\}/);
    if (match) {
      const cleaned = match[0]
        .replace(/[\u201C\u201D\u201E\u201F\u2018\u2019\u00AB\u00BB]/g, "'");
      const parsed = JSON.parse(cleaned);
      summary           = parsed.summary            || "";
      categorySummaries = parsed.category_summaries || {};
    }
  } catch (e) {
    console.warn("[RA] highlights summary parse failed:", e.message);
  }
  port.postMessage({ type: "highlights_result", summary, categorySummaries });
}

// Agent loop variant for highlights — streams text, emits highlight_item in real-time
async function runHighlightsAgentLoop(port, apiKey, system, userPrompt, signal, onTextDelta, model) {
  model = model || "claude-opus-4-6";
  const messages = [{ role: "user", content: userPrompt }];
  let finalText = "";

  for (let iter = 0; iter < 4; iter++) {
    port.postMessage({
      type: "status",
      message: iter === 0 ? "Researching claims..." : `Verifying sources (step ${iter + 1})...`
    });

    const response = await fetch(`${API_BASE}/messages`, {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      port.postMessage({ type: "error", message: err.error?.message || `HTTP ${response.status}` });
      return finalText;
    }

    const { blocks, stopReason } = await parseAgentStream(response, port, onTextDelta);
    messages.push({ role: "assistant", content: blocks.filter(Boolean) });

    for (const b of blocks) {
      if (b?.type === "text") finalText += b.text || "";
    }

    if (stopReason === "end_turn") {
      break;
    } else if (stopReason === "pause_turn") {
      continue;
    } else if (stopReason === "tool_use") {
      const toolResults = [];
      for (const block of blocks) {
        if (block?.type === "tool_use" && block.name === "fetch_url") {
          const url = block.input?.url || "";
          port.postMessage({ type: "status", message: `Fetching: ${url.slice(0, 80)}` });
          const fetchedContent = await fetchUrl(url);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: fetchedContent });
        }
      }
      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return finalText;
}

// ── Agent loop ────────────────────────────────────────────────────────────────
async function runAgentLoop(port, apiKey, system, initialMessages, signal, model) {
  model = model || "claude-opus-4-6";
  const messages = [...initialMessages];

  for (let iter = 0; iter < 12; iter++) {
    port.postMessage({
      type: "status",
      message: iter === 0 ? "Analyzing..." : `Continuing research (step ${iter + 1})...`
    });

    const response = await fetch(`${API_BASE}/messages`, {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err.error?.message || `HTTP ${response.status}`;
      console.error("[RA] API error:", response.status, msg);
      port.postMessage({ type: "error", message: `API error ${response.status}: ${msg}` });
      return;
    }

    const { blocks, stopReason } = await parseAgentStream(response, port);
    messages.push({ role: "assistant", content: blocks.filter(Boolean) });

    if (stopReason === "end_turn") {
      break;
    } else if (stopReason === "pause_turn") {
      continue; // server-side web_search still running — re-submit
    } else if (stopReason === "tool_use") {
      const toolResults = [];
      for (const block of blocks) {
        if (block?.type === "tool_use" && block.name === "fetch_url") {
          const url = block.input?.url || "";
          port.postMessage({ type: "status", message: `Fetching: ${url.slice(0, 80)}` });
          const content = await fetchUrl(url);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
        }
      }
      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      } else {
        break;
      }
    } else {
      break;
    }
  }

  port.postMessage({ type: "done" });
}

// ── Highlight object extractor ────────────────────────────────────────────────
// Scans accumulated text buffer for complete {"phrase":...} objects, returns them
// and the next position to search from (so we don't re-scan old text).
function extractCompleteHighlights(buffer, fromPos) {
  const results = [];
  let pos = fromPos;
  while (true) {
    const start = buffer.indexOf('{"phrase":', pos);
    if (start === -1) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < buffer.length; i++) {
      const c = buffer[i];
      if (esc)              { esc = false; continue; }
      if (c === "\\" && inStr) { esc = true; continue; }
      if (c === '"')        { inStr = !inStr; continue; }
      if (inStr)            continue;
      if (c === "{")        depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) break; // incomplete — wait for more data
    try {
      const cleaned = buffer.slice(start, end + 1)
        .replace(/[\u201C\u201D\u201E\u201F\u2018\u2019\u00AB\u00BB]/g, "'");
      const obj = JSON.parse(cleaned);
      if (obj.phrase && obj.category) results.push(obj);
    } catch (_) {}
    pos = end + 1;
  }
  return { highlights: results, nextPos: pos };
}

// ── SSE stream parser ─────────────────────────────────────────────────────────
async function parseAgentStream(response, port, onTextDelta) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const blocks = [];
  const inputAccum = {}; // index → accumulated partial JSON for tool_use inputs
  let stopReason = null;
  let textStarted = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;

      let ev;
      try { ev = JSON.parse(raw); } catch (_) { continue; }

      if (ev.type === "content_block_start") {
        const cb = ev.content_block;
        const idx = ev.index;
        blocks[idx] = { ...cb };

        if (cb.type === "tool_use") {
          inputAccum[idx] = "";
          port.postMessage({ type: "tool_call", name: "fetch_url", label: "Fetching URL..." });
        } else if (cb.type === "server_tool_use") {
          port.postMessage({ type: "tool_call", name: "web_search", label: "Searching the web..." });
        } else if (cb.type === "web_search_tool_result") {
          port.postMessage({ type: "status", message: "Processing search results..." });
        } else if (cb.type === "text" && !textStarted) {
          textStarted = true;
          port.postMessage({ type: "status", message: "Writing analysis..." });
        }

      } else if (ev.type === "content_block_delta") {
        const idx = ev.index;
        const delta = ev.delta;

        if (delta.type === "text_delta") {
          if (blocks[idx]) blocks[idx].text = (blocks[idx].text || "") + delta.text;
          if (onTextDelta) onTextDelta(delta.text);
          else port.postMessage({ type: "text_delta", text: delta.text });
        } else if (delta.type === "input_json_delta") {
          inputAccum[idx] = (inputAccum[idx] || "") + delta.partial_json;
        } else if (delta.type === "thinking_delta") {
          if (blocks[idx]) blocks[idx].thinking = (blocks[idx].thinking || "") + delta.thinking;
        }

      } else if (ev.type === "content_block_stop") {
        const idx = ev.index;
        if (inputAccum[idx] !== undefined && blocks[idx]) {
          try { blocks[idx].input = JSON.parse(inputAccum[idx]); } catch (_) { blocks[idx].input = {}; }
        }

      } else if (ev.type === "message_delta") {
        stopReason = ev.delta?.stop_reason;
      }
    }
  }

  return { blocks, stopReason };
}

// ── fetch_url tool ────────────────────────────────────────────────────────────
async function fetchUrl(url) {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ResearchBot/1.0)" }
    });
    const text = await resp.text();
    const stripped = text
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, 4000);
  } catch (e) {
    return `Could not fetch URL (${url}): ${e.message}`;
  }
}

// ── System prompts ────────────────────────────────────────────────────────────
// ── OpenAI streaming ──────────────────────────────────────────────────────────
async function runOpenAIStream(port, apiKey, model, systemText, messages, signal) {
  port.postMessage({ type: "status", message: "Analyzing..." });

  const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "system", content: systemText }, ...messages],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    port.postMessage({ type: "error", message: err.error?.message || `HTTP ${response.status}` });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let started = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      let ev; try { ev = JSON.parse(raw); } catch (_) { continue; }
      const text = ev.choices?.[0]?.delta?.content;
      if (text) {
        if (!started) { started = true; port.postMessage({ type: "status", message: "Writing analysis..." }); }
        port.postMessage({ type: "text_delta", text });
      }
    }
  }
  port.postMessage({ type: "done" });
}

// ── Gemini proxy fetch (via content script to bypass CORS) ───────────────────
async function geminiProxyFetch(model, apiKey, body) {
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab for Gemini request");

  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); } catch (_) {}

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { action: "geminiProxy", url, apiKey, body: JSON.stringify(body) }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp?.ok) return reject(new Error(resp?.error || "Gemini proxy failed"));
      resolve(resp.data);
    });
  });
}

// ── Gemini (non-streaming generateContent) ────────────────────────────────────
async function runGeminiStream(port, apiKey, model, systemText, contents, signal) {
  port.postMessage({ type: "status", message: "Analyzing..." });

  let data;
  try {
    data = await geminiProxyFetch(model, apiKey, {
      contents,
      systemInstruction: { parts: [{ text: systemText }] },
    });
  } catch (e) {
    port.postMessage({ type: "error", message: `Gemini: ${e.message}` });
    return;
  }

  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  if (text) {
    port.postMessage({ type: "status", message: "Writing analysis..." });
    port.postMessage({ type: "text_delta", text });
  }
  port.postMessage({ type: "done" });
}

// ── Simple highlights for non-Claude providers ────────────────────────────────
async function handleHighlightsSimple(port, config, content, signal) {
  port.postMessage({ type: "status", message: "Scanning page..." });

  // Real-time emitter
  let hlCount = 0, hlSearchPos = 0, hlAccText = "";
  const hlEmitter = (chunk) => {
    hlAccText += chunk;
    const { highlights: newHl, nextPos } = extractCompleteHighlights(hlAccText, hlSearchPos);
    hlSearchPos = nextPos;
    for (const h of newHl) port.postMessage({ type: "highlight_item", highlight: h, index: hlCount++ });
  };

  const prompt = `You are given a webpage's text content. Analyze it and extract verbatim phrases.

PAGE CONTENT:
${content.slice(0, 8000)}

${buildHighlightsPrompt(false)}`;

  let finalText = "";

  if (config.provider === "openai") {
    const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, stream: true, messages: [{ role: "user", content: prompt }] }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      port.postMessage({ type: "error", message: err.error?.message || `HTTP ${response.status}` });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        let ev; try { ev = JSON.parse(raw); } catch (_) { continue; }
        const text = ev.choices?.[0]?.delta?.content;
        if (text) { hlEmitter(text); finalText += text; }
      }
    }
  } else if (config.provider === "gemini") {
    let data;
    try {
      data = await geminiProxyFetch(config.model, config.apiKey, {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
    } catch (e) {
      port.postMessage({ type: "error", message: `Gemini: ${e.message}` });
      return;
    }
    finalText = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    hlEmitter(finalText);
  }

  let summary = "", categorySummaries = {};
  try {
    const match = finalText.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0].replace(/[\u201C\u201D\u201E\u201F\u2018\u2019\u00AB\u00BB]/g, "'"));
      summary = parsed.summary || "";
      categorySummaries = parsed.category_summaries || {};
    }
  } catch (_) {}
  port.postMessage({ type: "highlights_result", summary, categorySummaries });
}

// ── System prompts ────────────────────────────────────────────────────────────
function buildAnalysisSystem(url, title, content) {
  return `You are a critical research assistant with access to web search. You have been given the full text of a webpage and must analyze it thoroughly.

PAGE METADATA:
- URL: ${url}
- Title: ${title}

PAGE CONTENT:
${content.slice(0, 10000)}

YOUR TASK:
Perform a comprehensive research analysis. Use web_search to:
1. Verify key factual claims made on the page
2. Check the credibility and bias of the source/author/publication
3. Find supporting evidence for the main arguments
4. Find opposing evidence or counter-arguments
5. Search for context about entities, studies, or statistics cited

Use fetch_url to read specific referenced articles or studies when relevant.

Write your final response using these exact markdown sections:

## Key Claims
Bullet list of the most important factual claims or arguments.

## References & Sources
Analysis of sources cited on the page — are they primary, peer-reviewed, credible? Any broken or suspicious links?

## Supporting Evidence
Evidence and sources you found that support the main claims.

## Opposing Perspectives
Sources or evidence that challenge, contradict, or add important nuance to the claims.

## Bias & Framing
Identify framing choices, selective emphasis, loaded language, or ideological lean.

## Emotional Language
Flag emotionally charged phrases, fear appeals, outrage bait, us-vs-them framing, or other manipulation tactics with direct quotes.

## Misinformation Risks
Claims that appear false, unverifiable, misleading, or critically lacking context. Explain each risk.

## Overall Assessment
A short verdict: How reliable and balanced is this content? What should a critical reader watch out for? Rate overall trustworthiness (Low / Medium / High) with justification.

Be specific and always cite sources as markdown links — e.g. [Reuters](https://reuters.com/...) — inline where you mention them. Every factual claim you verify or contradict must have at least one linked source.`;
}

function buildChatSystem(url, title, content) {
  return `You are a research assistant helping a user critically analyze a webpage. You have access to web search.

PAGE METADATA:
- URL: ${url}
- Title: ${title}

PAGE CONTENT:
${content.slice(0, 10000)}

Answer the user's questions about this page. Use web_search when you need to verify claims, find context, or discover related information. Use fetch_url to read specific referenced articles if asked.

Be concise and always cite sources as markdown links — e.g. [Reuters](https://reuters.com/...) — inline where you mention them.`;
}
