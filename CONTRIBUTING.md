# Contributing to ScepticAgent

## Getting started

1. Fork the repo and clone it locally
2. Load the extension in Chrome:
   - Go to `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** → select the `extension/` folder
3. After any change to `background.js`, click the **reload** button on `chrome://extensions`
4. After changes to sidepanel or content scripts, close and reopen the side panel

No build step — the extension is plain JavaScript.

## Project structure

| File | Responsibility |
|------|---------------|
| `extension/background.js` | Service worker. All AI API calls, agent loops, streaming parsers. |
| `extension/content.js` | Page extraction, highlight injection, Gemini CORS proxy. |
| `extension/sidepanel/app.js` | UI logic — port communication, markdown rendering, highlight list. |
| `extension/sidepanel/style.css` | All sidepanel styles. |
| `extension/options/app.js` | API key management, provider switching. |

## Key concepts

### Port-based streaming
The side panel opens a `chrome.runtime.connect("agent")` port to the service worker. Messages flow over this port as the AI streams:
- `{ type: "status", message }` — progress updates
- `{ type: "text_delta", text }` — streamed text chunk
- `{ type: "tool_call", name, label }` — tool being called
- `{ type: "highlight_item", highlight, index }` — individual highlight (real-time)
- `{ type: "highlights_result", summary, categorySummaries }` — final highlights metadata
- `{ type: "done" }` — stream complete
- `{ type: "error", message }` — error

### Agent loop (Claude)
`runAgentLoop` in `background.js` iterates up to 12 times. On each iteration it calls the Anthropic API with streaming, parses the SSE response via `parseAgentStream`, and handles `tool_use` (runs `fetch_url`) and `pause_turn` (server-side `web_search` still running).

### Real-time highlights
`extractCompleteHighlights(buffer, fromPos)` is a brace-depth scanner that extracts complete `{"phrase":...}` JSON objects from a streaming text buffer without waiting for the full response.

### Gemini CORS proxy
Service workers from `chrome-extension://` origins are blocked by Google's CORS policy. Gemini requests are sent to the content script via `chrome.tabs.sendMessage`, which makes the fetch from the page's `http/https` origin context.

### Provider routing
`getProviderConfig()` reads `provider`, `*Key`, and `*Model` from `chrome.storage.local`. Every handler (`handleAnalyze`, `handleChat`, `handleHighlights`) branches on `config.provider` to call the right implementation.

## Adding a new AI provider

1. Add the API base URL constant in `background.js`
2. Add the provider to `getProviderConfig()`
3. Implement `runXxxStream(port, apiKey, model, systemText, messages, signal)` — must post `text_delta`, `status`, and `done` messages to the port
4. Branch on the new provider in `handleAnalyze`, `handleChat`, and `handleHighlights`
5. Add provider tab, model dropdown, and key input to `options/index.html` and `options/app.js`
6. Add the API domain to `host_permissions` in `manifest.json`

## Adding a new highlight category

1. Add the category name and CSS color to `content.js` — `LABELS` object and `.ra-hl-{category}` CSS rule
2. Add it to `CAT_META` in `sidepanel/app.js`
3. Add the CSS classes `.scan-pill.{category}`, `.hl-dot.{category}`, `.hl-item-dot.{category}`, `.summary-bullet-{category}` in `sidepanel/style.css`
4. Add the scan pill and legend entry in `sidepanel/index.html`
5. Update the category descriptions in `buildHighlightsPrompt()` in `background.js`

## Prompts

All prompts live in `background.js`:

| Function | Used for |
|----------|----------|
| `buildAnalysisSystem(url, title, content)` | Full page analysis with web search |
| `buildChatSystem(url, title, content)` | Chat follow-up questions |
| `buildHighlightsPrompt(withSearch)` | Highlight extraction (with or without web search) |

## Pull request guidelines

- Keep PRs focused — one feature or fix per PR
- Test with at least two providers before submitting
- If you change permissions in `manifest.json`, explain why in the PR description
- If you change a prompt, include before/after and a sample output showing the difference
- Update `README.md` and `CLAUDE.md` to reflect any architectural or feature changes

## Reporting bugs

Open a GitHub issue with:
- Chrome version
- Which AI provider was active
- The error message shown (or the service worker console output from `chrome://extensions`)
- The URL of the page you were analysing (if not sensitive)
