import os
import json
import re
import httpx
import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import AsyncGenerator

load_dotenv()

app = FastAPI(title="Research Assistant Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class AnalyzeRequest(BaseModel):
    url: str
    title: str
    content: str  # Clean page text from content script

class ChatRequest(BaseModel):
    url: str
    title: str
    content: str
    messages: list  # Conversation history [{role, content}]
    new_message: str

class HighlightsRequest(BaseModel):
    content: str        # Raw page text
    analysis: str = ""  # Optional — if empty, Claude analyzes the content directly

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

TOOLS = [
    {"type": "web_search_20250305", "name": "web_search"},
    {
        "name": "fetch_url",
        "description": (
            "Fetch the text content of a URL. Use this to read sources, "
            "studies, references, or articles mentioned in or related to the page."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The full URL to fetch"
                }
            },
            "required": ["url"]
        }
    }
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_async_client() -> anthropic.AsyncAnthropic:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key or api_key == "your_api_key_here":
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured in backend/.env")
    return anthropic.AsyncAnthropic(api_key=api_key)


async def fetch_url_content(url: str) -> str:
    """Fetch a URL and return cleaned text (max 4000 chars)."""
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; ResearchBot/1.0)"})
            r.raise_for_status()
            text = r.text
            # Strip HTML tags
            text = re.sub(r'<style[^>]*>[\s\S]*?</style>', ' ', text, flags=re.IGNORECASE)
            text = re.sub(r'<script[^>]*>[\s\S]*?</script>', ' ', text, flags=re.IGNORECASE)
            text = re.sub(r'<[^>]+>', ' ', text)
            text = re.sub(r'\s+', ' ', text).strip()
            return text[:4000]
    except Exception as e:
        return f"Could not fetch URL ({url}): {str(e)}"


def build_analysis_system(url: str, title: str, content: str) -> str:
    return f"""You are a critical research assistant with access to web search. You have been given the full text of a webpage and must analyze it thoroughly.

PAGE METADATA:
- URL: {url}
- Title: {title}

PAGE CONTENT:
{content[:10000]}

YOUR TASK:
Perform a comprehensive research analysis. Use web_search to:
1. Verify key factual claims made on the page
2. Check the credibility and bias of the source/author/publication
3. Find supporting evidence for the main arguments
4. Find opposing evidence or counter-arguments
5. Search for context about entities, studies, or statistics cited

Use fetch_url to read specific referenced articles or studies when relevant.

Write your final response using these exact markdown sections:

## Summary
A concise, neutral 2-3 sentence summary of what the page claims or argues.

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

Be specific, cite sources, and acknowledge when claims appear well-supported."""


def build_chat_system(url: str, title: str, content: str) -> str:
    return f"""You are a research assistant helping a user critically analyze a webpage. You have access to web search.

PAGE METADATA:
- URL: {url}
- Title: {title}

PAGE CONTENT:
{content[:10000]}

Answer the user's questions about this page. Use web_search when you need to verify claims, find context, or discover related information. Use fetch_url to read specific referenced articles if asked.

Be concise, cite sources, and help the user think critically."""


# ---------------------------------------------------------------------------
# Core agent loop
# ---------------------------------------------------------------------------

async def run_agent(
    client: anthropic.AsyncAnthropic,
    system: str,
    initial_messages: list,
) -> AsyncGenerator[str, None]:
    """
    Run a Claude agentic loop with web_search + fetch_url tools.
    Yields SSE-formatted data strings.
    """

    def sse(data: dict) -> str:
        return f"data: {json.dumps(data)}\n\n"

    messages = list(initial_messages)
    container_id = None  # tracks container from web_search dynamic filtering

    for iteration in range(12):
        label = "Analyzing..." if iteration == 0 else f"Continuing research (step {iteration + 1})..."
        yield sse({"type": "status", "message": label})

        text_started = False
        # Container may come in message_start event (streaming doesn't expose it
        # on get_final_message), so capture it during event iteration.
        container_id_this_call = None

        try:
            stream_kwargs = dict(
                model="claude-opus-4-6",
                max_tokens=8000,
                thinking={"type": "adaptive"},
                system=[{
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"}
                }],
                tools=TOOLS,
                messages=messages,
            )
            if container_id:
                stream_kwargs["container"] = container_id

            async with client.messages.stream(**stream_kwargs) as stream:
                async for event in stream:
                    etype = event.type

                    # Capture container_id from message_start (only place it's
                    # reliably available in the streaming response)
                    if etype == "message_start":
                        msg = getattr(event, "message", None)
                        if msg:
                            c = getattr(msg, "container", None)
                            if not c:
                                c = (getattr(msg, "model_extra", None) or {}).get("container")
                            if c:
                                cid = c.get("id") if isinstance(c, dict) else getattr(c, "id", None)
                                if cid:
                                    container_id_this_call = cid

                    elif etype == "content_block_start":
                        cb = event.content_block
                        if cb.type == "server_tool_use":
                            yield sse({"type": "tool_call", "name": "web_search", "label": "Searching the web..."})
                        elif cb.type == "tool_use":
                            url_hint = ""
                            try:
                                url_hint = cb.input.get("url", "")[:60] if hasattr(cb, "input") and cb.input else ""
                            except Exception:
                                pass
                            yield sse({"type": "tool_call", "name": "fetch_url", "label": f"Fetching URL{': ' + url_hint if url_hint else ''}..."})
                        elif cb.type == "web_search_tool_result":
                            yield sse({"type": "status", "message": "Processing search results..."})
                        elif cb.type == "text" and not text_started:
                            text_started = True
                            yield sse({"type": "status", "message": "Writing analysis..."})

                    elif etype == "content_block_delta":
                        delta = event.delta
                        if delta.type == "text_delta":
                            yield sse({"type": "text_delta", "text": delta.text})

                final = await stream.get_final_message()

                # Fallback: try to read container from final message in case the
                # SDK does populate it after all events are consumed
                if not container_id_this_call:
                    c = getattr(final, "container", None)
                    if not c:
                        c = (getattr(final, "model_extra", None) or {}).get("container")
                    if c:
                        cid = c.get("id") if isinstance(c, dict) else getattr(c, "id", None)
                        if cid:
                            container_id_this_call = cid

        except anthropic.AuthenticationError:
            yield sse({"type": "error", "message": "Invalid API key. Check your ANTHROPIC_API_KEY in backend/.env"})
            return
        except anthropic.RateLimitError:
            yield sse({"type": "error", "message": "Rate limit hit. Please wait a moment and try again."})
            return
        except Exception as e:
            yield sse({"type": "error", "message": f"API error: {str(e)}"})
            return

        if container_id_this_call:
            container_id = container_id_this_call

        # Append assistant turn to history
        messages.append({"role": "assistant", "content": final.content})

        stop = final.stop_reason

        if stop == "end_turn":
            break

        elif stop == "pause_turn":
            # Server-side tool loop hit iteration limit — re-send to continue
            continue

        elif stop == "tool_use":
            # Process our custom fetch_url tool
            tool_results = []
            for block in final.content:
                if getattr(block, "type", None) == "tool_use" and block.name == "fetch_url":
                    url_to_fetch = block.input.get("url", "") if block.input else ""
                    yield sse({"type": "status", "message": f"Fetching: {url_to_fetch[:80]}"})
                    fetched = await fetch_url_content(url_to_fetch)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": fetched,
                    })

            if tool_results:
                messages.append({"role": "user", "content": tool_results})
            else:
                # tool_use stop but no custom tools found — shouldn't happen, but break
                break

        else:
            # max_tokens or unexpected stop reason
            break

    yield sse({"type": "done"})


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/analyze")
async def analyze(request: AnalyzeRequest):
    client = get_async_client()
    system = build_analysis_system(request.url, request.title, request.content)
    messages = [{
        "role": "user",
        "content": "Please analyze this webpage thoroughly. Search the web to verify claims and find supporting and opposing perspectives."
    }]

    async def generate():
        async for chunk in run_agent(client, system, messages):
            yield chunk

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/chat")
async def chat(request: ChatRequest):
    client = get_async_client()
    system = build_chat_system(request.url, request.title, request.content)

    messages = [{"role": m["role"], "content": m["content"]} for m in request.messages]
    messages.append({"role": "user", "content": request.new_message})

    async def generate():
        async for chunk in run_agent(client, system, messages):
            yield chunk

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/highlights")
async def highlights(request: HighlightsRequest):
    """
    Extract specific verbatim phrases from the page that correspond to findings
    in the analysis. Returns structured JSON for the content script to annotate.
    """
    client = get_async_client()

    if request.analysis.strip():
        context = f"\nANALYSIS:\n{request.analysis[:4000]}\n\nYour job: extract verbatim phrases from the PAGE CONTENT that correspond to specific findings in the analysis."
    else:
        context = "\nYour job: analyze the content directly and extract verbatim phrases that represent key claims, biases, emotional language, or potential misinformation."

    prompt = f"""You are given a webpage's text content.{context}

PAGE CONTENT:
{request.content[:8000]}

Rules:
- Each phrase must appear EXACTLY (verbatim) in the page content above
- Phrases must be 8–180 characters long
- Prefer specific, distinctive phrases over generic ones
- Maximum 25 highlights total
- Spread across all categories where evidence exists

Categories:
- "claim": a key factual claim or central argument
- "supported": a claim that your web research confirmed is well-supported
- "misinformation": a claim that is false, misleading, or critically lacking context
- "bias": biased framing, selective emphasis, or loaded language
- "emotional": emotional manipulation, fear appeal, outrage bait, or us-vs-them language

For "note": write a concise explanation (max 90 chars) — what is the issue or why it matters.
For "source": name of the source that supports or contradicts this highlight (e.g. "Reuters", "WHO", "Nature study"). Leave empty string if none found.
For "source_url": full URL of that source if mentioned in the analysis. Leave empty string if none."""

    response = await client.messages.create(
        model="claude-opus-4-6",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "highlights": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "phrase":     {"type": "string"},
                                    "category":   {"type": "string"},
                                    "note":       {"type": "string"},
                                    "source":     {"type": "string"},
                                    "source_url": {"type": "string"}
                                },
                                "required": ["phrase", "category", "note", "source", "source_url"],
                                "additionalProperties": False
                            }
                        }
                    },
                    "required": ["highlights"],
                    "additionalProperties": False
                }
            }
        }
    )

    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)


@app.get("/health")
async def health():
    return {"status": "ok"}
