# ScepticAgent — CLAUDE.md

This file is the primary reference for AI assistants working on this codebase. Read it before making any changes.

## Maintenance rule

**After every change, update this file and README.md** to reflect what changed. If you add a feature, update the architecture section. If you change a prompt, update the prompts section. If you change permissions, update the manifest section. Outdated documentation is worse than none.

---

## Packaging

- Build zip: `zip -r scepticagent-extension.zip extension/ --exclude "*.DS_Store"`
- Never commit `*.zip` or `backend/venv/` — both are in `.gitignore`
- After manifest changes, always repackage before uploading to the Web Store

## Chrome Web Store gotchas

- Permission justifications are required for every entry in `permissions` and `host_permissions` — write them before submitting
- `manifest.description` max 132 chars — check with `echo -n "..." | wc -c`
- Privacy policy must be at a publicly reachable URL before submission; GitHub Pages works fine
- Icons required: 16px, 48px, 128px PNG in `extension/icons/`, referenced in both `icons` and `action.default_icon` in manifest

---

## Hard-won lessons — read before starting

These are non-obvious issues that cost many iterations to discover. Knowing them upfront will save significant time.

**1. Gemini CORS blocks `chrome-extension://` origins**
Service workers and content scripts (isolated world) both send `Origin: chrome-extension://[id]`, which Google's API CORS policy rejects. Anthropic explicitly opted into browser access via `anthropic-dangerous-direct-browser-access: true`; Google did not. Fix: proxy Gemini requests through the content script using `chrome.tabs.sendMessage` — the content script makes the fetch from the page's `http/https` origin, which Google accepts.

**2. Use `text/plain` + key in URL param for Gemini proxy**
Setting `Content-Type: application/json` or adding `x-goog-api-key` as a header triggers a CORS preflight OPTIONS request. Using `Content-Type: text/plain` with the key as a URL query parameter makes it a simple CORS request (no preflight). Google's API parses the JSON body regardless of Content-Type.

**3. Gemini `streamGenerateContent?alt=sse` fails from extension contexts**
Non-streaming `generateContent` is the only reliable path from a Chrome extension. Do not attempt SSE streaming with Gemini.

**4. `extractCompleteHighlights` needs a brace-depth scanner, not JSON.parse**
Calling `JSON.parse` on a partial streaming buffer fails. A character-by-character brace-depth scanner that tracks string/escape state correctly extracts complete `{"phrase":...}` objects from a mid-stream buffer.

**5. Use `listType` string, not `inList` boolean, in the markdown renderer**
A boolean can't distinguish `<ul>` from `<ol>`, causing wrong closing tags and broken numbered lists. Track `"ul"` / `"ol"` / `null` with a `closeList()` helper. Match list items against `trimmed` lines (not raw) to handle indented items.

**6. `return true` in `chrome.runtime.onMessage` must be at the right scope**
For async `sendResponse` to keep the channel open, `return true` must be reached for the specific message action that uses async response. Easy to break when adding a new handler to an existing listener.

**7. Git history with secrets is blocked by GitHub push protection**
If a secret (e.g. API key in `.env`) was committed in any ancestor commit, GitHub will reject the push even if it was removed in a later commit. Fix: `git checkout --orphan clean-branch` to create a fresh history with no secret-containing commits.

**8. Manifest `description` has a 132-character hard limit**
The Chrome Web Store rejects the zip at upload time. Check length upfront: `echo -n "your description" | wc -c`.

**9. `<all_urls>` host permission triggers an in-depth review warning**
Always scope `host_permissions` to the specific API domains needed. For this extension: `https://api.anthropic.com/*`, `https://api.openai.com/*`, `https://generativelanguage.googleapis.com/*`.

**10. Ad blockers can block extension API calls at the network level**
Both service worker and content script fetches return `TypeError: Failed to fetch` when an ad blocker or DNS filter blocks the target domain. No code change fixes this — the user must whitelist the domain. Diagnose by trying a simple GET to the domain root from a content script and reporting a clear error message if it fails.

---

## What this project is

A Chrome extension (Manifest V3) that analyses webpages using AI. It uses a multi-turn agentic loop for Claude and single-turn calls for OpenAI and Gemini. No backend server — all AI calls are made directly from the extension to the provider's API.

---

## File map

| File | What it does |
|------|-------------|
| `extension/manifest.json` | MV3 manifest. Permissions: `sidePanel`, `activeTab`, `tabs`, `storage`, `scripting`. Host permissions: Anthropic, OpenAI, Gemini API domains only. |
| `extension/background.js` | Service worker. All AI API calls, agent loops, streaming parsers, highlight extractor. |
| `extension/content.js` | Injected into pages. Extracts page text, applies highlight spans, handles Gemini CORS proxy. |
| `extension/sidepanel/app.js` | Side panel UI logic. Port communication, markdown renderer, highlight list, streaming state. |
| `extension/sidepanel/style.css` | All side panel styles. Dark theme. CSS variables for colors. |
| `extension/sidepanel/index.html` | Side panel HTML shell. |
| `extension/options/app.js` | Settings page. API key storage/retrieval, provider tab switching. |
| `extension/options/index.html` | Settings page HTML. Three provider tabs (Anthropic, OpenAI, Gemini). |
| `privacy.html` | Privacy policy. Hosted at https://maros112358.github.io/scepticagent/privacy.html |

---

## Architecture

### Communication flow

```
Side Panel (app.js)
  │  chrome.runtime.connect("agent") — one port per request
  ▼
Service Worker (background.js)
  │  fetch() to provider API
  ▼
AI Provider (Anthropic / OpenAI / Gemini)
```

The side panel opens a port for each operation (analyze, chat, highlights). The service worker streams messages back over the port. When the port disconnects, the stream is considered done.

### Port message types

```
{ type: "status", message: string }          — progress label
{ type: "tool_call", name, label }           — tool being invoked
{ type: "text_delta", text: string }         — streamed text chunk
{ type: "highlight_item", highlight, index } — one highlight (real-time)
{ type: "highlights_result", summary, categorySummaries } — final metadata
{ type: "done" }                             — stream complete
{ type: "error", message: string }           — error, stops streaming
```

### Parallel execution

When a page opens, `startAnalysis()` fires two port connections simultaneously via `Promise.all`:
1. `streamViaPort("analyze", ...)` — full analysis with agent loop
2. `quickHighlightPage(content)` — fast highlight scan

### Agent loop (Claude only)

`runAgentLoop` / `runHighlightsAgentLoop` in `background.js`:
- Up to 12 iterations (4 for highlights)
- Stop reasons: `end_turn` (break), `pause_turn` (continue — server-side web_search running), `tool_use` (run `fetch_url`, re-submit)
- Tools: `web_search_20250305` (server-side, Anthropic-hosted), `fetch_url` (client-side, implemented as `fetchUrl()`)

### Streaming parser

`parseAgentStream(response, port, onTextDelta?)`:
- Reads Anthropic SSE stream
- Accumulates `text_delta` into `blocks[idx].text`
- Accumulates `input_json_delta` into `inputAccum[idx]` for tool_use inputs
- Optional `onTextDelta` callback intercepts text chunks (used by highlights to extract JSON objects in real-time)

### Real-time highlight extraction

`extractCompleteHighlights(buffer, fromPos)`:
- Brace-depth scanner over the accumulated streaming text buffer
- Finds complete `{"phrase":...}` JSON objects without waiting for the full response
- Returns `{ highlights, nextPos }` — caller advances `fromPos` to avoid re-scanning

### Provider routing

`getProviderConfig()` reads `provider`, `${p}Key`, `${p}Model` from `chrome.storage.local`.

Every handler branches on `config.provider`:
- `"anthropic"` → full agent loop with tools
- `"openai"` → `runOpenAIStream` — SSE streaming, no tools
- `"gemini"` → `runGeminiStream` + `geminiProxyFetch` — non-streaming, proxied through content script

### Gemini CORS proxy

Chrome extension service workers send `Origin: chrome-extension://[id]` which Google's CORS policy rejects. Fix: `geminiProxyFetch()` sends the request to the active tab's content script via `chrome.tabs.sendMessage`. The content script makes the fetch from the page's `http/https` origin, which Google accepts.

---

## Prompts

All prompts are in `background.js`:

### `buildAnalysisSystem(url, title, content)` — lines 658–705
System prompt for the full analysis agent. Instructs Claude to use `web_search` to verify claims, check source credibility, find supporting/opposing evidence, and identify bias and emotional language. Specifies exact markdown output sections:
- `## Key Claims`
- `## References & Sources`
- `## Supporting Evidence`
- `## Opposing Perspectives`
- `## Bias & Framing`
- `## Emotional Language`
- `## Misinformation Risks`
- `## Overall Assessment`

### `buildChatSystem(url, title, content)` — lines 707–720
System prompt for chat. Shorter. Instructs the agent to answer questions about the page using web search and cite sources as inline markdown links.

### `buildHighlightsPrompt(withSearch)` — lines 108–140
User prompt for highlight extraction. Two modes:
- `withSearch: true` — includes a STEP 1 (web_search for URLs) / STEP 2 (output JSON) structure
- `withSearch: false` — responds with JSON only, `source_url` left empty

Output JSON schema:
```json
{
  "summary": "two sentences",
  "category_summaries": { "misinformation": "...", "emotional": "...", ... },
  "highlights": [
    { "phrase": "verbatim text", "category": "misinformation|emotional|bias|supported|logical", "note": "max 90 chars", "source": "publication name", "source_url": "https://..." }
  ]
}
```

---

## Highlight categories

| Category | Color | Meaning |
|----------|-------|---------|
| `misinformation` | `#ff6b6b` (red) | False, misleading, or lacking critical context |
| `emotional` | `#ffa94d` (orange) | Fear appeals, outrage bait, us-vs-them language |
| `bias` | `#ffd43b` (yellow) | Biased framing, selective emphasis, loaded language |
| `supported` | `#69db7c` (green) | Well-supported, verified claim |
| `logical` | `#da77f2` (purple) | Internal contradiction, non-sequitur, false dichotomy |

---

## Markdown renderer

Custom renderer in `sidepanel/app.js` (`renderMarkdown`). Handles:
- `##` headings → collapsible `<h2>` + `<div class="section-body">`
- `###` headings → `<h3>`
- `- ` / `* ` bullet lists → `<ul><li>`
- `1. ` numbered lists → `<ol><li>`
- `**bold**`, `*italic*`, `` `code` ``, ` ```code blocks``` `
- `[text](url)` links → `<a target="_blank">`
- Blank lines → `<br>`

Uses `listType` string (`"ul"` / `"ol"` / `null`) + `closeList()` to correctly open/close list tags. Matches on `trimmed` lines to handle indented list items.

---

## Settings storage keys

| Key | Type | Description |
|-----|------|-------------|
| `provider` | `"anthropic"` \| `"openai"` \| `"gemini"` | Active provider |
| `anthropicKey` | string | Anthropic API key |
| `anthropicModel` | string | e.g. `"claude-opus-4-6"` |
| `openaiKey` | string | OpenAI API key |
| `openaiModel` | string | e.g. `"gpt-4o"` |
| `geminiKey` | string | Google Gemini API key |
| `geminiModel` | string | e.g. `"gemini-2.5-flash"` |
| `apiKey` | string | Legacy Anthropic key field (still read for backwards compat) |

---

## Known limitations

- **Gemini has no streaming** — `generateContent` (non-streaming) is used because `streamGenerateContent` failed from the extension context. The full response arrives at once.
- **Gemini has no tool use** — no web search or URL fetching for Gemini analysis.
- **OpenAI has no tool use** — same limitation; single-turn only.
- **Highlights are Claude-only for agent loop** — non-Claude providers use `handleHighlightsSimple` (single-turn, no web search, no real URLs in `source_url`).
- **Content limit** — page content is truncated to 8000–10000 characters before sending to the AI.

---

## Adding a new provider — checklist

- [ ] Add `const XXX_API_BASE` in `background.js`
- [ ] Add to `getProviderConfig()` key/model maps
- [ ] Implement `runXxxStream(port, apiKey, model, systemText, messages, signal)`
- [ ] Branch in `handleAnalyze`, `handleChat`, `handleHighlights`
- [ ] Add provider tab to `options/index.html` and logic to `options/app.js`
- [ ] Add API domain to `host_permissions` in `manifest.json`
- [ ] Update this file and `README.md`

## Adding a new highlight category — checklist

- [ ] Add to `LABELS` and CSS in `content.js`
- [ ] Add to `CAT_META` in `sidepanel/app.js`
- [ ] Add CSS classes in `sidepanel/style.css`
- [ ] Add scan pill and legend entry in `sidepanel/index.html`
- [ ] Add to `buildHighlightsPrompt()` in `background.js`
- [ ] Update the categories table in this file and `README.md`
