# ScepticAgent — CLAUDE.md

This file is the primary reference for AI assistants working on this codebase. Read it before making any changes.

## Maintenance rule

**After every change, update this file and README.md** to reflect what changed. If you add a feature, update the architecture section. If you change a prompt, update the prompts section. If you change permissions, update the manifest section.

---

## What this project is

A Chrome extension (Manifest V3) that analyses webpages using AI. Multi-turn agentic loop for Claude, single-turn for OpenAI and Gemini. No backend — all AI calls go directly from the extension to the provider API.

---

## File map

| File | What it does |
|------|-------------|
| `extension/manifest.json` | MV3 manifest. Permissions: `sidePanel`, `activeTab`, `tabs`, `storage`, `scripting`. Host permissions: Anthropic, OpenAI, Gemini API domains only. |
| `extension/background.js` | Service worker. All AI API calls, agent loops, streaming parsers, highlight extractor. |
| `extension/content.js` | Injected into pages. Extracts page text, applies highlight spans, handles Gemini CORS proxy. |
| `extension/sidepanel/app.js` | Side panel UI logic. Port communication, markdown renderer, highlight list, streaming state. |
| `extension/sidepanel/style.css` | All side panel styles. Dark theme. |
| `extension/options/app.js` | Settings page. API key storage/retrieval, provider tab switching. |
| `privacy.html` | Privacy policy. Hosted at https://maros112358.github.io/scepticagent/privacy.html |

---

## Hard-won lessons — read before starting

These are non-obvious issues that cost many iterations to discover.

**1. Gemini CORS blocks `chrome-extension://` origins**
Service workers send `Origin: chrome-extension://[id]`, which Google's CORS policy rejects. Fix: proxy Gemini requests through the content script via `chrome.tabs.sendMessage` — the content script fetches from the page's `http/https` origin.

**2. Use `text/plain` + key in URL param for Gemini proxy**
`Content-Type: application/json` or `x-goog-api-key` header triggers a CORS preflight. `Content-Type: text/plain` + key as URL query param makes it a simple request (no preflight). Google's API parses the JSON body regardless.

**3. Gemini `streamGenerateContent?alt=sse` fails from extension contexts**
Use non-streaming `generateContent` only.

**4. `extractCompleteHighlights` needs a brace-depth scanner, not JSON.parse**
`JSON.parse` fails on partial buffers. A character-by-character scanner correctly extracts complete `{"phrase":...}` objects mid-stream.

**5. `return true` in `chrome.runtime.onMessage` must be at the right scope**
For async `sendResponse` to keep the channel open, `return true` must be reached for the specific message action using it.

**6. Git history with secrets is blocked by GitHub push protection**
If a secret was committed in any ancestor commit, GitHub rejects the push. Fix: `git checkout --orphan clean-branch` to create a fresh history.

**7. Manifest `description` has a 132-character hard limit**
Check upfront: `echo -n "your description" | wc -c`.

**8. `<all_urls>` host permission triggers an in-depth review warning**
Scope `host_permissions` to specific API domains: `https://api.anthropic.com/*`, `https://api.openai.com/*`, `https://generativelanguage.googleapis.com/*`.

**9. Ad blockers can block extension API calls at the network level**
Both service worker and content script fetches return `TypeError: Failed to fetch` when an ad blocker blocks the domain. Diagnose by making a simple GET to the domain root from a content script and showing a clear error message.

---

## On-demand skills (load these when relevant)

Detailed reference material lives in `.claude/skills/` and loads automatically when relevant:

- **`scepticagent-architecture`** — communication flow, port messages, agent loop, streaming parser, provider routing, Gemini proxy, checklists for adding new providers and highlight categories
- **`scepticagent-prompts`** — all three prompt functions with line numbers, output sections, JSON schema
- **`scepticagent-styles`** — highlight category colours, markdown renderer details, CSS architecture
- **`scepticagent-publish`** — packaging command, Chrome Web Store checklist
