# ScepticAgent

A Chrome extension that helps you critically analyse any webpage using AI. Verify claims, detect bias and misinformation, highlight emotional language, and chat about the content — all powered by your own API key.

## Features

- **Deep analysis** — the AI searches the web to verify claims, find supporting and opposing evidence, assess source credibility, and identify bias and emotional language
- **Real-time highlights** — verbatim phrases on the page are highlighted by category (misinformation, bias, emotional language, supported claims, logic flaws) as they are detected
- **Chat** — ask follow-up questions about the page; the AI uses web search to answer
- **Multi-provider** — works with Anthropic Claude, OpenAI ChatGPT, or Google Gemini; choose and switch in settings
- **Private** — your API keys are stored locally on your device only; no data is sent to any server other than your chosen AI provider

## Installation

### From the Chrome Web Store
Search for **ScepticAgent** and click Install.

### Manual (developer)
1. Clone this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `extension/` folder

## Setup

1. Click the ScepticAgent icon in the Chrome toolbar to open the side panel
2. Click **⚙ Settings** and add your API key for your preferred provider:
   - [Anthropic](https://console.anthropic.com/settings/keys) — Claude models
   - [OpenAI](https://platform.openai.com/api-keys) — GPT models
   - [Google](https://aistudio.google.com/app/apikey) — Gemini models
3. Navigate to any webpage and the analysis starts automatically

## Project Structure

```
extension/
├── manifest.json          # MV3 manifest — permissions, entry points
├── background.js          # Service worker — AI API calls, agent loops
├── content.js             # Content script — page extraction, highlights, Gemini proxy
├── icons/                 # Extension icons (16, 48, 128px)
├── sidepanel/
│   ├── index.html         # Side panel UI
│   ├── app.js             # Side panel logic — streaming, rendering, highlights
│   └── style.css          # Side panel styles
└── options/
    ├── index.html         # Settings page UI
    └── app.js             # Settings page logic — API key management
privacy.html               # Privacy policy (hosted via GitHub Pages)
```

## Architecture

All AI calls are made directly from the extension to the provider's API — there is no backend server.

```
Side Panel (app.js)
    │  chrome.runtime.connect("agent")
    ▼
Service Worker (background.js)
    │  fetch()
    ▼
AI Provider API  (Anthropic / OpenAI / Gemini)
```

**Agent loop (Claude only):** The service worker runs a multi-turn loop (up to 12 iterations) that allows Claude to call `web_search` and `fetch_url` tools, process results, and continue until it reaches `end_turn`.

**Highlights:** Run in parallel with the analysis via a second port connection. A brace-depth parser (`extractCompleteHighlights`) scans the streaming buffer and emits complete `{"phrase":...}` JSON objects to the page in real time.

**Gemini proxy:** Because Chrome extension service workers are blocked by Google's CORS policy, Gemini API calls are proxied through the content script, which runs in the page's `http/https` origin context.

## Supported Models

| Provider  | Models |
|-----------|--------|
| Anthropic | Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5 |
| OpenAI    | GPT-4o, GPT-4o mini, o1-mini |
| Google    | Gemini 2.5 Flash, Gemini 2.5 Pro, Gemini 2.5 Flash-Lite |

## Privacy

See [privacy policy](https://maros112358.github.io/scepticagent/privacy.html). The short version: the extension developer receives no data. Page content and chat messages are sent directly from your browser to your chosen AI provider.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
