from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

VERDICTS = {"SUPPORTED", "FALSE", "MISLEADING", "INSUFFICIENT_EVIDENCE"}
EVAL_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = EVAL_ROOT.parent

TAVILY_RESEARCH_URL = "https://api.tavily.com/research"
EXA_SEARCH_URL = "https://api.exa.ai/search"
EXA_RESEARCH_URL = "https://api.exa.ai/research/v1"
BRAVE_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context"
BRAVE_ANSWERS_URL = "https://api.search.brave.com/res/v1/chat/completions"
FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search"
PARALLEL_RUNS_URL = "https://api.parallel.ai/v1/tasks/runs"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
OPENAI_JUDGE_MODEL = "gpt-5.5"

STRUCTURED_VERDICT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["verdict", "confidence", "summary", "explanation", "report"],
    "properties": {
        "verdict": {
            "type": "string",
            "enum": sorted(VERDICTS),
            "description": "Final verdict on the claim. SUPPORTED if strong evidence confirms it, FALSE if strong evidence contradicts it, MISLEADING if the claim is partly true but deceptive, INSUFFICIENT_EVIDENCE when reliable sources cannot settle it.",
        },
        "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "Calibrated confidence in the verdict between 0 and 1. Use lower values when evidence conflicts, is stale, or only partially supports the claim.",
        },
        "summary": {
            "type": "string",
            "description": "One or two sentence plain-English summary of the verdict for end users.",
        },
        "explanation": {
            "type": "string",
            "description": "Short paragraph explaining why the verdict was reached, referencing the strongest evidence.",
        },
        "report": {
            "type": "string",
            "description": "Concise fact-check report written in Markdown with inline numbered citations and caveats when relevant.",
        },
        "key_findings": {
            "type": "array",
            "items": {"type": "string"},
            "description": "3-5 bullet-style findings that back up the verdict.",
        },
        "warnings": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Important caveats a reader should know about.",
        },
    },
}

PARALLEL_STRUCTURED_VERDICT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["verdict", "confidence", "summary", "explanation", "report"],
    "properties": {
        "verdict": {
            "type": "string",
            "enum": sorted(VERDICTS),
            "description": "Final verdict on the claim. SUPPORTED if strong evidence confirms it, FALSE if strong evidence contradicts it, MISLEADING if the claim is partly true but deceptive, INSUFFICIENT_EVIDENCE when reliable sources cannot settle it.",
        },
        "confidence": {
            "type": "number",
            "description": "Calibrated confidence in the verdict between 0 and 1. Use lower values when evidence conflicts, is stale, or only partially supports the claim.",
        },
        "summary": {
            "type": "string",
            "description": "One or two sentence plain-English summary of the verdict for end users.",
        },
        "explanation": {
            "type": "string",
            "description": "Short paragraph explaining why the verdict was reached, referencing the strongest evidence.",
        },
        "report": {
            "type": "string",
            "description": "Concise fact-check report written in Markdown with inline numbered citations and caveats when relevant.",
        },
        "key_findings": {
            "type": "array",
            "items": {"type": "string"},
            "description": "3-5 bullet-style findings that back up the verdict.",
        },
        "warnings": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Important caveats a reader should know about.",
        },
    },
}

TAVILY_OUTPUT_SCHEMA: dict[str, Any] = {
    "required": STRUCTURED_VERDICT_SCHEMA["required"],
    "properties": STRUCTURED_VERDICT_SCHEMA["properties"],
}

DEFAULT_PROVIDER_MODES = [
    "tavily:tavily_research",
    "exa:exa_search_structured",
    "exa:exa_deep_research",
    "brave:brave_context_plus_judge",
    "firecrawl:firecrawl_search_plus_judge",
    "parallel:parallel_task_run",
]

SUPPORTED_PROVIDER_MODES = {
    "tavily": {"tavily_research"},
    "exa": {"exa_search_structured", "exa_deep_research", "exa_research_async"},
    "brave": {"brave_context_plus_judge", "brave_answers_native"},
    "firecrawl": {"firecrawl_search_plus_judge"},
    "parallel": {"parallel_task_run"},
}

DEFAULT_HTTP_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36 FactCheckerEval/1.0"
)

TAVILY_USD_PER_CREDIT = 0.008
FIRECRAWL_STANDARD_USD_PER_CREDIT = 83 / 100_000
EXA_DEEP_USD_PER_REQUEST_LOW = 12 / 1_000
EXA_DEEP_USD_PER_REQUEST_HIGH = 15 / 1_000
PARALLEL_BASE_USD_PER_REQUEST = 10 / 1_000
BRAVE_SEARCH_USD_PER_REQUEST = 5 / 1_000
BRAVE_ANSWERS_USD_PER_REQUEST = 4 / 1_000
BRAVE_ANSWERS_USD_PER_MILLION_INPUT_TOKENS = 5
BRAVE_ANSWERS_USD_PER_MILLION_OUTPUT_TOKENS = 5
OPENAI_GPT_5_5_USD_PER_MILLION_INPUT_TOKENS = 5
OPENAI_GPT_5_5_USD_PER_MILLION_CACHED_INPUT_TOKENS = 0.5
OPENAI_GPT_5_5_USD_PER_MILLION_OUTPUT_TOKENS = 30


@dataclass
class BenchmarkClaim:
    id: str
    claim: str
    reference_answer: str
    reference_verdict: str
    topic: str | None = None
    freshness_bucket: str | None = None


@dataclass
class HttpResult:
    status: int
    body: str
    json_data: Any | None


class BenchmarkError(RuntimeError):
    def __init__(self, provider: str, status_code: int, message: str, response_body: str = "") -> None:
        super().__init__(message)
        self.provider = provider
        self.status_code = status_code
        self.response_body = response_body


class VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style", "nav", "footer", "header", "noscript", "svg"}:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "nav", "footer", "header", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            text = clean_text(data, max_chars=1000)
            if text:
                self.parts.append(text)

    def text(self, max_chars: int = 6000) -> str:
        return clean_text(" ".join(self.parts), max_chars=max_chars)


@dataclass
class JudgeResult:
    structured: dict[str, Any]
    cost_payload: dict[str, Any]


def load_dotenv_like(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, value = line.split("=", 1)
        elif ":" in line:
            key, value = line.split(":", 1)
        else:
            continue
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def build_ssl_context() -> ssl.SSLContext:
    cert_file = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    if cert_file:
        return ssl.create_default_context(cafile=cert_file)
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def sanitize_verdict(value: Any) -> str:
    if not isinstance(value, str):
        return "INSUFFICIENT_EVIDENCE"
    upper = "".join(ch if ch.isalpha() or ch == "_" else "_" for ch in value.upper())
    if upper in VERDICTS:
        return upper
    synonyms = {
        "TRUE": "SUPPORTED",
        "SUPPORT": "SUPPORTED",
        "CONFIRMED": "SUPPORTED",
        "DEBUNKED": "FALSE",
        "INCORRECT": "FALSE",
        "REFUTED": "FALSE",
        "PARTIALLY_TRUE": "MISLEADING",
        "MIXED": "MISLEADING",
    }
    return synonyms.get(upper, "INSUFFICIENT_EVIDENCE")


def sanitize_confidence(value: Any) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return 0.3
    normalized = float(value)
    if normalized > 1:
        normalized = normalized / 100.0
    return max(0.0, min(1.0, normalized))


def extract_source_name(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        return host or url
    except Exception:
        return url


def append_citations(report: str, citations: list[dict[str, Any]]) -> str:
    if not citations:
        return report
    lines = []
    for idx, citation in enumerate(citations, start=1):
        label = citation.get("title") or citation.get("source") or citation.get("url")
        lines.append(f"{idx}. [{label}]({citation.get('url', '')})")
    return f"{report}\n\n**Sources:**\n" + "\n".join(lines)


def clean_text(value: Any, max_chars: int = 6000) -> str:
    if not isinstance(value, str):
        return ""
    words = [
        word
        for word in value.replace("\x00", " ").split()
        if not word.startswith(("http://", "https://"))
    ]
    cleaned = " ".join(words)
    if not cleaned:
        return ""
    return cleaned[:max_chars]


def first_text(*values: Any, max_chars: int = 6000) -> str:
    for value in values:
        text = clean_text(value, max_chars=max_chars)
        if text:
            return text
    return ""


def extract_nested_text(
    value: Any,
    preferred_keys: tuple[str, ...] = (
        "markdown",
        "raw_content",
        "rawContent",
        "content",
        "text",
        "snippet",
        "description",
        "summary",
        "highlight",
        "highlights",
        "extract",
        "body",
    ),
    max_chars: int = 6000,
) -> str:
    chunks: list[str] = []

    def visit(item: Any, only_preferred: bool = True) -> None:
        if len("\n\n".join(chunks)) >= max_chars:
            return
        if isinstance(item, str):
            text = clean_text(item, max_chars=max_chars)
            if text and text not in chunks:
                chunks.append(text)
            return
        if isinstance(item, list):
            for child in item:
                visit(child, only_preferred=only_preferred)
            return
        if isinstance(item, dict):
            keys = preferred_keys if only_preferred else tuple(item.keys())
            for key in keys:
                if key in item:
                    visit(item[key], only_preferred=only_preferred)

    visit(value, only_preferred=True)
    if not chunks:
        visit(value, only_preferred=False)
    return "\n\n".join(chunks)[:max_chars]


def fetch_url_context(url: str, timeout: int = 12, max_chars: int = 6000) -> str:
    if not url.startswith(("http://", "https://")):
        return ""
    lowered = urllib.parse.urlparse(url).path.lower()
    if lowered.endswith((".pdf", ".png", ".jpg", ".jpeg", ".gif", ".zip")):
        return ""
    request = urllib.request.Request(
        url=url,
        headers={
            "User-Agent": DEFAULT_HTTP_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=build_ssl_context()) as response:
            content_type = response.headers.get("Content-Type", "")
            if "text" not in content_type and "html" not in content_type:
                return ""
            body = response.read(750_000).decode("utf-8", errors="replace")
    except Exception:
        return ""
    if "html" in content_type:
        parser = VisibleTextParser()
        try:
            parser.feed(body)
            return parser.text(max_chars=max_chars)
        except Exception:
            return clean_text(body, max_chars=max_chars)
    return clean_text(body, max_chars=max_chars)


def enrich_citations_with_url_context(
    citations: list[dict[str, Any]],
    max_fetches: int = 5,
    min_chars: int = 240,
) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    fetches = 0
    for citation in citations:
        item = dict(citation)
        context = first_text(item.get("context"), item.get("snippet"))
        if len(context) < min_chars or context == item.get("title") or context == item.get("url"):
            if fetches < max_fetches:
                fetched = fetch_url_context(str(item.get("url") or ""))
                fetches += 1
                if fetched:
                    item["context"] = fetched
                    item["snippet"] = fetched[:800]
        enriched.append(item)
    return enriched


def evidence_contexts(citations: list[dict[str, Any]], min_chars: int = 40) -> list[str]:
    contexts: list[str] = []
    seen: set[str] = set()
    for citation in citations:
        if not isinstance(citation, dict):
            continue
        text = first_text(citation.get("context"), citation.get("snippet"), citation.get("title"))
        if text and text == citation.get("title"):
            continue
        if len(text) < min_chars or text == citation.get("url"):
            continue
        if text in seen:
            continue
        seen.add(text)
        contexts.append(text)
    return contexts


def build_research_prompt(claim: str) -> str:
    return "\n".join(
        [
            "You are a careful fact-checking research agent. Investigate whether the claim below is true.",
            "",
            f'Claim: "{claim}"',
            "",
            "Search multiple reputable sources (prioritize government, academic, wire services, and major fact-checkers).",
            "Produce a short Markdown report with numbered inline citations, decide a verdict (SUPPORTED, FALSE, MISLEADING, or INSUFFICIENT_EVIDENCE), and give a calibrated confidence between 0 and 1.",
            "Never assert more certainty than the evidence supports.",
        ]
    )


def round_cost(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 6)


def build_cost_payload(
    unit_price: float | None,
    units: float = 1,
    unit_name: str = "request",
    low_unit_price: float | None = None,
    high_unit_price: float | None = None,
    method: str | None = None,
) -> dict[str, Any]:
    low_price = low_unit_price if low_unit_price is not None else unit_price
    high_price = high_unit_price if high_unit_price is not None else unit_price
    unit_price_midpoint = unit_price
    if unit_price_midpoint is None and low_price is not None and high_price is not None:
        unit_price_midpoint = (low_price + high_price) / 2
    return {
        "cost_units": units,
        "cost_unit_name": unit_name,
        "cost_unit_price": round_cost(unit_price_midpoint),
        "cost_unit_price_low": round_cost(low_price),
        "cost_unit_price_high": round_cost(high_price),
        "cost_estimate": round_cost(unit_price_midpoint * units) if unit_price_midpoint is not None else None,
        "cost_estimate_low": round_cost(low_price * units) if low_price is not None else None,
        "cost_estimate_high": round_cost(high_price * units) if high_price is not None else None,
        "cost_estimate_method": method,
    }


def compute_token_cost(
    input_tokens: int | float,
    output_tokens: int | float,
    input_rate_per_million: float,
    output_rate_per_million: float,
) -> float:
    return ((float(input_tokens) * input_rate_per_million) + (float(output_tokens) * output_rate_per_million)) / 1_000_000


def tavily_cost_payload(credits: float | None) -> dict[str, Any]:
    if credits is None:
        return {
            "cost_units": None,
            "cost_unit_name": "credit",
            "cost_unit_price": round_cost(TAVILY_USD_PER_CREDIT),
            "cost_unit_price_low": round_cost(TAVILY_USD_PER_CREDIT),
            "cost_unit_price_high": round_cost(TAVILY_USD_PER_CREDIT),
            "cost_estimate": None,
            "cost_estimate_low": None,
            "cost_estimate_high": None,
            "cost_estimate_method": "Tavily pay-as-you-go pricing is $0.008 per credit; exact request credits were not returned.",
        }
    return build_cost_payload(
        TAVILY_USD_PER_CREDIT,
        units=credits,
        unit_name="credit",
        method=f"Tavily pay-as-you-go pricing is $0.008 per credit; recorded {credits:g} credit(s).",
    )


def exa_deep_cost_payload() -> dict[str, Any]:
    return build_cost_payload(
        None,
        units=1,
        unit_name="request",
        low_unit_price=EXA_DEEP_USD_PER_REQUEST_LOW,
        high_unit_price=EXA_DEEP_USD_PER_REQUEST_HIGH,
        method="Exa Deep Search pricing is $12-$15 per 1k requests.",
    )


def brave_search_cost_payload() -> dict[str, Any]:
    return build_cost_payload(
        BRAVE_SEARCH_USD_PER_REQUEST,
        units=1,
        unit_name="request",
        method="Brave Search pricing is $5 per 1k requests.",
    )


def brave_answers_cost_payload(input_tokens: float = 0, output_tokens: float = 0) -> dict[str, Any]:
    request_cost = BRAVE_ANSWERS_USD_PER_REQUEST
    token_cost = compute_token_cost(
        input_tokens,
        output_tokens,
        BRAVE_ANSWERS_USD_PER_MILLION_INPUT_TOKENS,
        BRAVE_ANSWERS_USD_PER_MILLION_OUTPUT_TOKENS,
    )
    return build_cost_payload(
        request_cost + token_cost,
        units=1,
        unit_name="request",
        method="Brave Answers pricing is $4 per 1k requests plus $5 per million input/output tokens.",
    )


def firecrawl_cost_payload(credits: float) -> dict[str, Any]:
    return build_cost_payload(
        FIRECRAWL_STANDARD_USD_PER_CREDIT,
        units=credits,
        unit_name="credit",
        method="Firecrawl Standard plan pricing is $83/month for 100,000 credits.",
    )


def parallel_cost_payload() -> dict[str, Any]:
    return build_cost_payload(
        PARALLEL_BASE_USD_PER_REQUEST,
        units=1,
        unit_name="request",
        method="Parallel Task API uses processor=base; Chat Research Base pricing is $10 per 1k requests ($0.01/request).",
    )


def openai_judge_cost_payload(usage: dict[str, Any]) -> dict[str, Any]:
    prompt_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0
    prompt_token_details = usage.get("prompt_tokens_details") or {}
    cached_tokens = usage.get("cached_tokens", prompt_token_details.get("cached_tokens", 0)) or 0
    completion_tokens = usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0
    uncached_input_tokens = max(float(prompt_tokens) - float(cached_tokens), 0)
    cost = (
        uncached_input_tokens * OPENAI_GPT_5_5_USD_PER_MILLION_INPUT_TOKENS
        + float(cached_tokens) * OPENAI_GPT_5_5_USD_PER_MILLION_CACHED_INPUT_TOKENS
        + float(completion_tokens) * OPENAI_GPT_5_5_USD_PER_MILLION_OUTPUT_TOKENS
    ) / 1_000_000
    return build_cost_payload(
        cost if cost else None,
        units=1,
        unit_name="judge_call",
        method="OpenAI judge token cost uses GPT-5.5 pricing: $5/M input, $0.50/M cached input, $30/M output.",
    )


def merge_cost_payloads(*payloads: dict[str, Any]) -> dict[str, Any]:
    estimate = 0.0
    low = 0.0
    high = 0.0
    methods: list[str] = []
    seen_value = False
    for payload in payloads:
        if not payload:
            continue
        payload_estimate = payload.get("cost_estimate")
        payload_low = payload.get("cost_estimate_low", payload_estimate)
        payload_high = payload.get("cost_estimate_high", payload_estimate)
        if payload_estimate is not None:
            estimate += float(payload_estimate)
            seen_value = True
        if payload_low is not None:
            low += float(payload_low)
        if payload_high is not None:
            high += float(payload_high)
        method = payload.get("cost_estimate_method")
        if method:
            methods.append(str(method))
    if not seen_value and not methods:
        return build_cost_payload(None, unit_name="mixed")
    return {
        "cost_units": 1,
        "cost_unit_name": "mixed",
        "cost_unit_price": round_cost(estimate) if seen_value else None,
        "cost_unit_price_low": round_cost(low) if low else None,
        "cost_unit_price_high": round_cost(high) if high else None,
        "cost_estimate": round_cost(estimate) if seen_value else None,
        "cost_estimate_low": round_cost(low) if low else None,
        "cost_estimate_high": round_cost(high) if high else None,
        "cost_estimate_method": " + ".join(methods) if methods else None,
    }


def build_judge_prompt(claim: str, citations: list[dict[str, Any]]) -> str:
    evidence_blocks = []
    for idx, citation in enumerate(citations, start=1):
        label = citation.get("title") or citation.get("source") or citation.get("url")
        body = citation.get("context") or citation.get("snippet") or ""
        evidence_blocks.append(f"[{idx}] {label}\nURL: {citation.get('url', '')}\n{body}")
    evidence_text = "\n\n".join(evidence_blocks)
    if len(evidence_text) > 16000:
        evidence_text = evidence_text[:16000] + "\n\n[...truncated evidence...]"
    return "\n".join(
        [
            "You are a careful fact-checking judge.",
            "Given a claim and retrieved evidence passages with source URLs, decide whether the claim is SUPPORTED, FALSE, MISLEADING, or INSUFFICIENT_EVIDENCE.",
            "Only use the supplied evidence. If the evidence is weak, conflicting, or stale, lower confidence or choose INSUFFICIENT_EVIDENCE.",
            'Respond with valid JSON only: {"verdict":"SUPPORTED|FALSE|MISLEADING|INSUFFICIENT_EVIDENCE","confidence":0.0,"summary":"...","explanation":"...","report":"...","warnings":["..."]}',
            "",
            f'Claim: "{claim}"',
            "",
            "Evidence:",
            evidence_text,
        ]
    )


def create_citation(
    provider: str,
    url: str,
    title: str | None = None,
    snippet: str | None = None,
    source: str | None = None,
    published_date: str | None = None,
    favicon: str | None = None,
    context: str | None = None,
    rank: int | None = None,
) -> dict[str, Any]:
    safe_title = title or url
    safe_snippet = (snippet or safe_title).strip()
    return {
        "title": safe_title,
        "source": source or extract_source_name(url),
        "url": url,
        "snippet": safe_snippet,
        "publishedDate": published_date,
        "favicon": favicon,
        "provider": provider,
        "rank": rank,
        "context": context or safe_snippet,
    }


def parse_json_maybe(text: str) -> Any | None:
    stripped = text.strip()
    if not stripped:
        return None
    if stripped.startswith("```"):
        start = stripped.find("\n")
        end = stripped.rfind("```")
        if start != -1 and end > start:
            stripped = stripped[start:end].strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None


def request_json(
    method: str,
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any] | None = None,
    timeout: int = 60,
) -> HttpResult:
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url=url, method=method, headers=headers, data=data)
    if not request.has_header("User-agent"):
        request.add_header("User-Agent", DEFAULT_HTTP_USER_AGENT)
    ssl_context = build_ssl_context()
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=ssl_context) as response:
            body = response.read().decode("utf-8")
            return HttpResult(
                status=response.getcode(),
                body=body,
                json_data=parse_json_maybe(body),
            )
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return HttpResult(
            status=exc.code,
            body=body,
            json_data=parse_json_maybe(body),
        )
    except urllib.error.URLError as exc:
        raise BenchmarkError("network", 0, f"Network request failed: {exc.reason}") from exc


def clean_api_key(value: str | None) -> str:
    if not value:
        return ""
    cleaned = value.strip().strip('"').strip("'")
    if " #" in cleaned:
        cleaned = cleaned.split(" #", 1)[0].strip()
    return cleaned


def mask_key(value: str) -> str:
    if not value:
        return "missing"
    if len(value) <= 8:
        return "***"
    return f"{value[:4]}...{value[-4:]}"


def load_dataset(path: Path) -> list[BenchmarkClaim]:
    claims: list[BenchmarkClaim] = []
    with path.open() as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            claims.append(
                BenchmarkClaim(
                    id=row["id"],
                    claim=row["claim"],
                    reference_answer=row.get("reference_answer", ""),
                    reference_verdict=row.get("reference_verdict", "INSUFFICIENT_EVIDENCE"),
                    topic=row.get("topic"),
                    freshness_bucket=row.get("freshness_bucket"),
                )
            )
    return claims


def resolve_path(path_value: str) -> Path:
    candidate = Path(path_value)
    if candidate.is_absolute():
        return candidate
    if candidate.exists():
        return candidate
    cwd_candidate = Path.cwd() / candidate
    if cwd_candidate.parent.exists():
        return cwd_candidate
    return EVAL_ROOT / candidate


def detect_api_keys() -> dict[str, str]:
    dotenv_values = load_dotenv_like(REPO_ROOT / ".env")
    mapping = {
        "tavily": os.environ.get("TAVILY_API_KEY", "") or dotenv_values.get("TAVILY_API_KEY", "") or dotenv_values.get("tavily", ""),
        "exa": os.environ.get("EXA_API_KEY", "") or dotenv_values.get("EXA_API_KEY", "") or dotenv_values.get("exa", ""),
        "brave": os.environ.get("BRAVE_API_KEY", "") or dotenv_values.get("BRAVE_API_KEY", "") or dotenv_values.get("brave", ""),
        "firecrawl": os.environ.get("FIRECRAWL_API_KEY", "") or dotenv_values.get("FIRECRAWL_API_KEY", "") or dotenv_values.get("firecrawl", ""),
        "parallel": os.environ.get("PARALLEL_API_KEY", "") or dotenv_values.get("PARALLEL_API_KEY", "") or dotenv_values.get("parallel", ""),
        "openai": os.environ.get("OPENAI_API_KEY", "") or dotenv_values.get("OPENAI_API_KEY", "") or dotenv_values.get("openai", ""),
        "anthropic": os.environ.get("ANTHROPIC_API_KEY", "") or dotenv_values.get("ANTHROPIC_API_KEY", "") or dotenv_values.get("anthropic", ""),
    }
    return {provider: clean_api_key(value) for provider, value in mapping.items()}


def provider_mode_needs_judge(mode: str) -> bool:
    return mode in {"brave_context_plus_judge", "firecrawl_search_plus_judge"}


def provider_mode_specs(requested: list[str], keys: dict[str, str], judge_provider: str) -> list[tuple[str, str]]:
    specs: list[tuple[str, str]] = []
    for item in requested:
        if ":" not in item:
            raise ValueError(f"Provider mode must be provider:mode, got {item!r}")
        provider, mode = item.split(":", 1)
        if mode not in SUPPORTED_PROVIDER_MODES.get(provider, set()):
            raise ValueError(f"Unsupported provider mode: {provider}:{mode}")
        requires_judge = provider_mode_needs_judge(mode)
        if not keys.get(provider):
            continue
        if requires_judge and not keys.get(judge_provider):
            continue
        specs.append((provider, mode))
    return specs


def skipped_provider_modes(requested: list[str], keys: dict[str, str], judge_provider: str) -> list[str]:
    skipped: list[str] = []
    for item in requested:
        provider, mode = item.split(":", 1)
        if not keys.get(provider):
            skipped.append(f"{item} (missing {provider.upper()}_API_KEY)")
        elif provider_mode_needs_judge(mode) and not keys.get(judge_provider):
            skipped.append(f"{item} (missing {judge_provider.upper()}_API_KEY judge)")
    return skipped


def judge_with_evidence(
    claim: str,
    citations: list[dict[str, Any]],
    judge_provider: str,
    judge_key: str,
) -> JudgeResult:
    prompt = build_judge_prompt(claim, citations)
    if judge_provider == "openai":
        result = request_json(
            "POST",
            OPENAI_URL,
            {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {judge_key}",
            },
            payload={
                "model": OPENAI_JUDGE_MODEL,
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a careful fact-checking assistant. Always respond with valid JSON only.",
                    },
                    {"role": "user", "content": prompt},
                ],
            },
            timeout=120,
        )
        if result.status >= 400:
            raise BenchmarkError("judge", result.status, "OpenAI judge failed", result.body)
        usage = (result.json_data or {}).get("usage") or {}
        content = (
            ((result.json_data or {}).get("choices") or [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        cost_payload = openai_judge_cost_payload(usage)
    else:
        result = request_json(
            "POST",
            ANTHROPIC_URL,
            {
                "Content-Type": "application/json",
                "x-api-key": judge_key,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-direct-browser-access": "true",
            },
            payload={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 2048,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=120,
        )
        if result.status >= 400:
            raise BenchmarkError("judge", result.status, "Anthropic judge failed", result.body)
        blocks = (result.json_data or {}).get("content") or []
        content = next((block.get("text", "") for block in blocks if block.get("type") == "text"), "")
        cost_payload = build_cost_payload(
            None,
            unit_name="judge_call",
            method="Anthropic judge cost not configured; no Anthropic pricing was provided for this benchmark.",
        )
    parsed = parse_json_maybe(content)
    if not isinstance(parsed, dict):
        raise BenchmarkError("judge", 502, "Judge returned unparsable JSON", content)
    return JudgeResult(
        structured=parsed,
        cost_payload=cost_payload,
    )


def run_tavily_research(claim: BenchmarkClaim, api_key: str) -> dict[str, Any]:
    started = time.time()
    create = request_json(
        "POST",
        TAVILY_RESEARCH_URL,
        {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        payload={
            "input": build_research_prompt(claim.claim),
            "model": "mini",
            "citation_format": "numbered",
            "output_schema": TAVILY_OUTPUT_SCHEMA,
            "stream": False,
        },
        timeout=120,
    )
    if create.status >= 400:
        raise BenchmarkError("tavily", create.status, "Tavily research submit failed", create.body)
    request_id = (create.json_data or {}).get("request_id")
    if not request_id:
        raise BenchmarkError("tavily", 502, "Tavily did not return a request_id", create.body)

    deadline = time.time() + 300
    result_payload: dict[str, Any] | None = None
    while time.time() < deadline:
        poll = request_json(
            "GET",
            f"{TAVILY_RESEARCH_URL}/{urllib.parse.quote(str(request_id))}",
            {"Authorization": f"Bearer {api_key}"},
            timeout=120,
        )
        if poll.status == 202:
            time.sleep(1)
            continue
        if poll.status >= 400:
            raise BenchmarkError("tavily", poll.status, "Tavily research poll failed", poll.body)
        payload = poll.json_data or {}
        if payload.get("status") == "completed":
            result_payload = payload
            break
        if payload.get("status") == "failed":
            raise BenchmarkError("tavily", 502, payload.get("error") or "Tavily task failed", poll.body)
        time.sleep(1)
    if result_payload is None:
        raise BenchmarkError("tavily", 408, "Tavily research timed out")

    create_payload = create.json_data if isinstance(create.json_data, dict) else {}
    usage = result_payload.get("usage") or create_payload.get("usage") or {}
    credits = None
    if isinstance(usage, dict) and isinstance(usage.get("credits"), (int, float)):
        credits = float(usage["credits"])
    structured = result_payload.get("content")
    if not isinstance(structured, dict):
        structured = parse_json_maybe(result_payload.get("content", "") or "") or {}
    citations = [
        create_citation(
            "tavily",
            source.get("url", ""),
            title=source.get("title"),
            snippet=first_text(source.get("snippet"), source.get("description"), source.get("title"), source.get("url")),
            context=extract_nested_text(source)
            or first_text(source.get("snippet"), source.get("description"), source.get("title"), source.get("url")),
            published_date=source.get("published_date"),
            favicon=source.get("favicon"),
        )
        for source in (result_payload.get("sources") or [])
        if isinstance(source, dict) and source.get("url")
    ]
    citations = enrich_citations_with_url_context(citations, max_fetches=5)
    latency_ms = int((time.time() - started) * 1000)
    report = append_citations(
        (structured.get("report") or structured.get("summary") or structured.get("explanation") or "").strip()
        or "No narrative report returned.",
        citations,
    )
    return {
        "provider": "tavily",
        "provider_mode": "tavily_research",
        "research_endpoint": "POST/GET https://api.tavily.com/research",
        "retrieved_contexts": evidence_contexts(citations),
        "response": {
            "verdict": sanitize_verdict(structured.get("verdict")),
            "summary": structured.get("summary"),
            "explanation": structured.get("explanation") or structured.get("summary") or "No explanation returned.",
            "confidence": sanitize_confidence(structured.get("confidence")),
            "report": report,
        },
        "citations": citations,
        "latency_ms": latency_ms,
        **tavily_cost_payload(credits),
        "status": "success",
    }


def run_exa_search_structured(claim: BenchmarkClaim, api_key: str) -> dict[str, Any]:
    started = time.time()
    result = request_json(
        "POST",
        EXA_SEARCH_URL,
        {"Content-Type": "application/json", "x-api-key": api_key},
        payload={
            "query": claim.claim,
            "type": "auto",
            "numResults": 5,
            "contents": {"highlights": True},
            "outputSchema": STRUCTURED_VERDICT_SCHEMA,
        },
        timeout=120,
    )
    if result.status >= 400:
        raise BenchmarkError("exa", result.status, "Exa search failed", result.body)
    payload = result.json_data or {}
    results = payload.get("results") or []
    grounding = ((payload.get("output") or {}).get("grounding") or [])
    structured = ((payload.get("output") or {}).get("content") or {})
    seen: set[str] = set()
    citations: list[dict[str, Any]] = []
    result_map = {item.get("url"): item for item in results if isinstance(item, dict)}
    for entry in grounding:
        for source in (entry.get("citations") or []):
            url = source.get("url")
            if not url or url in seen:
                continue
            seen.add(url)
            result_item = result_map.get(url, {})
            citations.append(
                create_citation(
                    "exa",
                    url,
                    title=source.get("title") or result_item.get("title"),
                    snippet=(result_item.get("highlights") or [None])[0] or result_item.get("text") or result_item.get("title") or url,
                    published_date=result_item.get("publishedDate"),
                    context="\n".join(result_item.get("highlights") or []) or result_item.get("text") or result_item.get("title") or url,
                    rank=len(citations) + 1,
                )
            )
    for item in results:
        url = item.get("url")
        if not url or url in seen:
            continue
        citations.append(
            create_citation(
                "exa",
                url,
                title=item.get("title"),
                snippet=(item.get("highlights") or [None])[0] or item.get("text") or item.get("title") or url,
                published_date=item.get("publishedDate"),
                context="\n".join(item.get("highlights") or []) or item.get("text") or item.get("title") or url,
                rank=len(citations) + 1,
            )
        )
    latency_ms = int((time.time() - started) * 1000)
    report = append_citations((structured.get("report") or structured.get("summary") or "").strip(), citations)
    return {
        "provider": "exa",
        "provider_mode": "exa_search_structured",
        "research_endpoint": "POST https://api.exa.ai/search",
        "retrieved_contexts": evidence_contexts(citations),
        "response": {
            "verdict": sanitize_verdict(structured.get("verdict")),
            "summary": structured.get("summary"),
            "explanation": structured.get("explanation") or structured.get("summary") or "No explanation returned.",
            "confidence": sanitize_confidence(structured.get("confidence")),
            "report": report or "No report returned.",
        },
        "citations": citations,
        "latency_ms": latency_ms,
        **exa_deep_cost_payload(),
        "status": "success",
    }


def run_exa_deep_research(claim: BenchmarkClaim, api_key: str) -> dict[str, Any]:
    started = time.time()
    result = request_json(
        "POST",
        EXA_SEARCH_URL,
        {"Content-Type": "application/json", "x-api-key": api_key},
        payload={
            "query": build_research_prompt(claim.claim),
            "type": "deep-reasoning",
            "numResults": 10,
            "systemPrompt": "Prefer official, primary, and recently updated sources. Return a careful fact-check verdict.",
            "contents": {"highlights": {"maxCharacters": 4000}},
            "outputSchema": STRUCTURED_VERDICT_SCHEMA,
        },
        timeout=180,
    )
    if result.status >= 400:
        raise BenchmarkError("exa", result.status, "Exa deep-reasoning search failed", result.body)
    payload = result.json_data or {}
    results = payload.get("results") or []
    output = payload.get("output") or {}
    structured = output.get("content") or {}
    grounding = output.get("grounding") or []
    if not isinstance(structured, dict):
        structured = parse_json_maybe(str(structured)) or {}

    seen: set[str] = set()
    citations: list[dict[str, Any]] = []
    result_map = {item.get("url"): item for item in results if isinstance(item, dict)}
    for entry in grounding:
        for source in (entry.get("citations") or []):
            url = source.get("url")
            if not url or url in seen:
                continue
            seen.add(url)
            result_item = result_map.get(url, {})
            highlights = result_item.get("highlights") or []
            citations.append(
                create_citation(
                    "exa",
                    url,
                    title=source.get("title") or result_item.get("title"),
                    snippet=(highlights or [None])[0] or result_item.get("text") or result_item.get("title") or url,
                    published_date=result_item.get("publishedDate"),
                    context="\n".join(highlights) or result_item.get("text") or result_item.get("title") or url,
                    rank=len(citations) + 1,
                )
            )
    for item in results:
        url = item.get("url")
        if not url or url in seen:
            continue
        highlights = item.get("highlights") or []
        citations.append(
            create_citation(
                "exa",
                url,
                title=item.get("title"),
                snippet=(highlights or [None])[0] or item.get("text") or item.get("title") or url,
                published_date=item.get("publishedDate"),
                context="\n".join(highlights) or item.get("text") or item.get("title") or url,
                rank=len(citations) + 1,
            )
        )
    latency_ms = int((time.time() - started) * 1000)
    return {
        "provider": "exa",
        "provider_mode": "exa_deep_research",
        "research_endpoint": "POST https://api.exa.ai/search type=deep-reasoning",
        "retrieved_contexts": evidence_contexts(citations),
        "response": {
            "verdict": sanitize_verdict(structured.get("verdict")),
            "summary": structured.get("summary"),
            "explanation": structured.get("explanation") or structured.get("summary") or "No explanation returned.",
            "confidence": sanitize_confidence(structured.get("confidence")),
            "report": append_citations((structured.get("report") or structured.get("summary") or "").strip() or "No report returned.", citations),
        },
        "citations": citations,
        "latency_ms": latency_ms,
        **exa_deep_cost_payload(),
        "status": "success",
    }


def run_exa_research_async(claim: BenchmarkClaim, api_key: str) -> dict[str, Any]:
    started = time.time()
    create = request_json(
        "POST",
        EXA_RESEARCH_URL,
        {"Content-Type": "application/json", "x-api-key": api_key},
        payload={
            "instructions": build_research_prompt(claim.claim),
            "model": "exa-research",
            "outputSchema": STRUCTURED_VERDICT_SCHEMA,
        },
        timeout=120,
    )
    if create.status >= 400:
        raise BenchmarkError("exa", create.status, "Exa async research create failed", create.body)
    research_id = (create.json_data or {}).get("researchId")
    if not research_id:
        raise BenchmarkError("exa", 502, "Exa async research did not return a researchId", create.body)
    payload: dict[str, Any] | None = None
    deadline = time.time() + 300
    while time.time() < deadline:
        poll = request_json(
            "GET",
            f"{EXA_RESEARCH_URL}/{urllib.parse.quote(str(research_id))}",
            {"x-api-key": api_key},
            timeout=120,
        )
        if poll.status >= 400:
            raise BenchmarkError("exa", poll.status, "Exa async research poll failed", poll.body)
        payload = poll.json_data or {}
        if payload.get("status") == "completed":
            break
        if payload.get("status") in {"failed", "canceled"}:
            raise BenchmarkError("exa", 502, payload.get("error") or "Exa async research failed", poll.body)
        time.sleep(1)
    if not payload or payload.get("status") != "completed":
        raise BenchmarkError("exa", 408, "Exa async research timed out")
    citations: list[dict[str, Any]] = []
    seen: set[str] = set()
    for items in (payload.get("citations") or {}).values():
        for item in items or []:
            url = item.get("url")
            if not url or url in seen:
                continue
            seen.add(url)
            citations.append(
                create_citation(
                    "exa",
                    url,
                    title=item.get("title"),
                    snippet=item.get("snippet") or item.get("title") or url,
                    context=item.get("snippet") or item.get("title") or url,
                    rank=len(citations) + 1,
                )
            )
    structured = payload.get("data") or {}
    latency_ms = int((time.time() - started) * 1000)
    return {
        "provider": "exa",
        "provider_mode": "exa_research_async",
        "research_endpoint": "POST/GET https://api.exa.ai/research/v1",
        "retrieved_contexts": evidence_contexts(citations),
        "response": {
            "verdict": sanitize_verdict(structured.get("verdict")),
            "summary": structured.get("summary"),
            "explanation": structured.get("explanation") or structured.get("summary") or "No explanation returned.",
            "confidence": sanitize_confidence(structured.get("confidence")),
            "report": append_citations((structured.get("report") or structured.get("summary") or "").strip() or "No report returned.", citations),
        },
        "citations": citations,
        "latency_ms": latency_ms,
        **exa_deep_cost_payload(),
        "status": "success",
    }


def run_brave_context_plus_judge(
    claim: BenchmarkClaim, api_key: str, judge_provider: str, judge_key: str
) -> dict[str, Any]:
    started = time.time()
    result = request_json(
        "POST",
        BRAVE_CONTEXT_URL,
        {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Subscription-Token": api_key,
        },
        payload={
            "q": claim.claim,
            "country": "US",
            "search_lang": "en",
            "count": 10,
            "maximum_number_of_urls": 8,
            "maximum_number_of_tokens": 6000,
            "enable_source_metadata": True,
        },
        timeout=120,
    )
    if result.status >= 400:
        raise BenchmarkError("brave", result.status, "Brave LLM Context request failed", result.body)
    payload = result.json_data or {}
    sources = payload.get("sources") or {}
    seen: set[str] = set()
    citations: list[dict[str, Any]] = []
    grounding_values = []
    for value in (payload.get("grounding") or {}).values():
        grounding_values.extend(value if isinstance(value, list) else [value])
    for record in grounding_values:
        if isinstance(record, str):
            record = {"text": record}
        if not isinstance(record, dict):
            continue
        url = record.get("url") or record.get("source_url") or record.get("sourceUrl")
        if not url or url in seen:
            continue
        seen.add(url)
        meta = sources.get(url) or {}
        context = (
            extract_nested_text(record)
            or extract_nested_text(meta)
            or first_text(meta.get("snippet"), meta.get("description"), meta.get("title"), url)
        )
        citations.append(
            create_citation(
                "brave",
                url,
                title=meta.get("title"),
                snippet=first_text(record.get("snippet"), record.get("text"), record.get("content"), meta.get("snippet"), meta.get("description"), meta.get("title"), url),
                source=meta.get("site_name"),
                favicon=meta.get("favicon"),
                context=context,
                rank=len(citations) + 1,
            )
        )
    for url, meta in sources.items():
        if url in seen:
            continue
        context = extract_nested_text(meta) or first_text(meta.get("snippet"), meta.get("description"), meta.get("title"), url)
        citations.append(
            create_citation(
                "brave",
                url,
                title=meta.get("title"),
                snippet=first_text(meta.get("snippet"), meta.get("description"), meta.get("title"), url),
                source=meta.get("site_name"),
                favicon=meta.get("favicon"),
                context=context,
                rank=len(citations) + 1,
            )
        )
    citations = enrich_citations_with_url_context(citations, max_fetches=5)
    judged = judge_with_evidence(claim.claim, citations, judge_provider, judge_key)
    latency_ms = int((time.time() - started) * 1000)
    total_cost = merge_cost_payloads(
        brave_search_cost_payload(),
        judged.cost_payload,
    )
    return {
        "provider": "brave",
        "provider_mode": "brave_context_plus_judge",
        "research_endpoint": "POST https://api.search.brave.com/res/v1/llm/context",
        "retrieved_contexts": evidence_contexts(citations),
        "response": {
            "verdict": sanitize_verdict(judged.structured.get("verdict")),
            "summary": judged.structured.get("summary"),
            "explanation": judged.structured.get("explanation") or judged.structured.get("summary") or "No explanation returned.",
            "confidence": sanitize_confidence(judged.structured.get("confidence")),
            "report": append_citations((judged.structured.get("report") or judged.structured.get("summary") or "").strip() or "No report returned.", citations),
        },
        "citations": citations,
        "latency_ms": latency_ms,
        **total_cost,
        "status": "success",
    }


def parse_brave_answer_citations(content: str) -> list[dict[str, Any]]:
    citations: list[dict[str, Any]] = []
    marker_start = "<citation>"
    marker_end = "</citation>"
    idx = 0
    while True:
        start = content.find(marker_start, idx)
        if start == -1:
            break
        end = content.find(marker_end, start)
        if end == -1:
            break
        raw = content[start + len(marker_start) : end]
        parsed = parse_json_maybe(raw)
        if isinstance(parsed, dict) and parsed.get("url"):
            citations.append(
                create_citation(
                    "brave",
                    parsed["url"],
                    snippet=parsed.get("snippet") or parsed["url"],
                    favicon=parsed.get("favicon"),
                    context=parsed.get("snippet") or parsed["url"],
                    rank=len(citations) + 1,
                )
            )
        idx = end + len(marker_end)
    return citations


def run_brave_answers_native(claim: BenchmarkClaim, api_key: str) -> dict[str, Any]:
    started = time.time()
    result = request_json(
        "POST",
        BRAVE_ANSWERS_URL,
        {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Subscription-Token": api_key,
        },
        payload={
            "model": "brave",
            "stream": False,
            "messages": [{"role": "user", "content": build_research_prompt(claim.claim)}],
            "web_search_options": {
                "country": "us",
                "language": "en",
                "enable_citations": True,
                "enable_research": True,
            },
        },
        timeout=120,
    )
    if result.status >= 400:
        raise BenchmarkError("brave", result.status, "Brave Answers request failed", result.body)
    content = (
        ((result.json_data or {}).get("choices") or [{}])[0].get("message", {}).get("content", "")
    )
    usage = (result.json_data or {}).get("usage") or {}
    citations = parse_brave_answer_citations(content)
    clean_content = content
    while "<citation>" in clean_content and "</citation>" in clean_content:
        start = clean_content.find("<citation>")
        end = clean_content.find("</citation>", start)
        if end == -1:
            break
        clean_content = clean_content[:start] + clean_content[end + len("</citation>") :]
    clean_content = clean_content.strip()
    latency_ms = int((time.time() - started) * 1000)
    input_tokens = usage.get("input_tokens", usage.get("prompt_tokens", 0)) or 0
    output_tokens = usage.get("output_tokens", usage.get("completion_tokens", 0)) or 0
    brave_answers_cost = brave_answers_cost_payload(input_tokens, output_tokens)
    return {
        "provider": "brave",
        "provider_mode": "brave_answers_native",
        "research_endpoint": "POST https://api.search.brave.com/res/v1/chat/completions",
        "retrieved_contexts": evidence_contexts(citations),
        "response": {
            "verdict": "INSUFFICIENT_EVIDENCE",
            "summary": clean_content.splitlines()[0] if clean_content else None,
            "explanation": clean_content or "Brave Answers returned no content.",
            "confidence": 0.2,
            "report": append_citations(clean_content or "Brave Answers returned no content.", citations),
        },
        "citations": citations,
        "latency_ms": latency_ms,
        **brave_answers_cost,
        "status": "success",
    }


def run_firecrawl_search_plus_judge(
    claim: BenchmarkClaim, api_key: str, judge_provider: str, judge_key: str
) -> dict[str, Any]:
    started = time.time()
    result = request_json(
        "POST",
        FIRECRAWL_SEARCH_URL,
        {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        payload={
            "query": claim.claim,
            "limit": 5,
            "scrapeOptions": {"formats": ["markdown"], "onlyMainContent": True},
        },
        timeout=180,
    )
    if result.status >= 400:
        raise BenchmarkError("firecrawl", result.status, "Firecrawl search failed", result.body)
    data = (result.json_data or {}).get("data") or []
    citations = [
        create_citation(
            "firecrawl",
            item.get("url"),
            title=item.get("title") or (item.get("metadata") or {}).get("title"),
            snippet=first_text(item.get("description"), item.get("markdown"), item.get("title"), item.get("url")),
            context=extract_nested_text(item) or first_text(item.get("description"), item.get("title"), item.get("url")),
            rank=index + 1,
        )
        for index, item in enumerate(data)
        if isinstance(item, dict) and item.get("url")
    ]
    citations = enrich_citations_with_url_context(citations, max_fetches=5)
    judged = judge_with_evidence(claim.claim, citations, judge_provider, judge_key)
    latency_ms = int((time.time() - started) * 1000)
    total_cost = merge_cost_payloads(
        firecrawl_cost_payload(credits=7),
        judged.cost_payload,
    )
    return {
        "provider": "firecrawl",
        "provider_mode": "firecrawl_search_plus_judge",
        "research_endpoint": "POST https://api.firecrawl.dev/v2/search",
        "retrieved_contexts": evidence_contexts(citations),
        "response": {
            "verdict": sanitize_verdict(judged.structured.get("verdict")),
            "summary": judged.structured.get("summary"),
            "explanation": judged.structured.get("explanation") or judged.structured.get("summary") or "No explanation returned.",
            "confidence": sanitize_confidence(judged.structured.get("confidence")),
            "report": append_citations((judged.structured.get("report") or judged.structured.get("summary") or "").strip() or "No report returned.", citations),
        },
        "citations": citations,
        "latency_ms": latency_ms,
        **total_cost,
        "status": "success",
    }


def run_parallel_task_run(claim: BenchmarkClaim, api_key: str) -> dict[str, Any]:
    started = time.time()
    create = request_json(
        "POST",
        PARALLEL_RUNS_URL,
        {"Content-Type": "application/json", "x-api-key": api_key},
        payload={
            "input": build_research_prompt(claim.claim),
            "processor": "base",
            "task_spec": {
                "output_schema": {
                    "type": "json",
                    "json_schema": PARALLEL_STRUCTURED_VERDICT_SCHEMA,
                }
            },
        },
        timeout=120,
    )
    if create.status >= 400:
        raise BenchmarkError("parallel", create.status, "Parallel task create failed", create.body)
    payload = create.json_data or {}
    run_id = payload.get("run_id") or payload.get("runId")
    if not run_id:
        raise BenchmarkError("parallel", 502, "Parallel task run returned no run_id", create.body)
    deadline = time.time() + 300
    while time.time() < deadline:
        status = request_json(
            "GET",
            f"{PARALLEL_RUNS_URL}/{urllib.parse.quote(str(run_id))}",
            {"x-api-key": api_key},
            timeout=120,
        )
        if status.status >= 400:
            raise BenchmarkError("parallel", status.status, "Parallel status poll failed", status.body)
        status_payload = status.json_data or {}
        if status_payload.get("status") == "completed":
            break
        if status_payload.get("status") == "failed":
            errors = status_payload.get("errors") or []
            message = errors[0].get("message") if errors and isinstance(errors[0], dict) else "Parallel task run failed"
            raise BenchmarkError("parallel", 502, message, status.body)
        time.sleep(1)
    result = request_json(
        "GET",
        f"{PARALLEL_RUNS_URL}/{urllib.parse.quote(str(run_id))}/result",
        {"x-api-key": api_key},
        timeout=120,
    )
    if result.status >= 400:
        raise BenchmarkError("parallel", result.status, "Parallel result fetch failed", result.body)
    output = ((result.json_data or {}).get("output") or {})
    citations = [
        create_citation(
            "parallel",
            item.get("url") or f"parallel-basis-{index + 1}",
            title=item.get("title"),
            snippet=first_text(item.get("snippet"), item.get("text"), item.get("title"), item.get("url"), f"Parallel basis {index + 1}"),
            context=extract_nested_text(item) or first_text(item.get("snippet"), item.get("text"), item.get("title"), item.get("url"), f"Parallel basis {index + 1}"),
            rank=index + 1,
        )
        for index, item in enumerate(output.get("basis") or [])
        if isinstance(item, dict)
    ]
    citations = enrich_citations_with_url_context(citations, max_fetches=5)
    structured = output.get("content") or {}
    latency_ms = int((time.time() - started) * 1000)
    return {
        "provider": "parallel",
        "provider_mode": "parallel_task_run",
        "research_endpoint": "POST/GET https://api.parallel.ai/v1/tasks/runs",
        "retrieved_contexts": evidence_contexts(citations),
        "response": {
            "verdict": sanitize_verdict(structured.get("verdict")),
            "summary": structured.get("summary"),
            "explanation": structured.get("explanation") or structured.get("summary") or "No explanation returned.",
            "confidence": sanitize_confidence(structured.get("confidence")),
            "report": append_citations((structured.get("report") or structured.get("summary") or "").strip() or "No report returned.", citations),
        },
        "citations": citations,
        "latency_ms": latency_ms,
        **parallel_cost_payload(),
        "status": "success",
    }


def run_provider_mode(
    claim: BenchmarkClaim,
    provider: str,
    mode: str,
    keys: dict[str, str],
    judge_provider: str,
) -> dict[str, Any]:
    if provider == "tavily" and mode == "tavily_research":
        return run_tavily_research(claim, keys["tavily"])
    if provider == "exa" and mode == "exa_search_structured":
        return run_exa_search_structured(claim, keys["exa"])
    if provider == "exa" and mode == "exa_deep_research":
        return run_exa_deep_research(claim, keys["exa"])
    if provider == "exa" and mode == "exa_research_async":
        return run_exa_research_async(claim, keys["exa"])
    if provider == "brave" and mode == "brave_context_plus_judge":
        return run_brave_context_plus_judge(claim, keys["brave"], judge_provider, keys[judge_provider])
    if provider == "brave" and mode == "brave_answers_native":
        return run_brave_answers_native(claim, keys["brave"])
    if provider == "firecrawl" and mode == "firecrawl_search_plus_judge":
        return run_firecrawl_search_plus_judge(claim, keys["firecrawl"], judge_provider, keys[judge_provider])
    if provider == "parallel" and mode == "parallel_task_run":
        return run_parallel_task_run(claim, keys["parallel"])
    raise RuntimeError(f"Unsupported provider mode: {provider}:{mode}")


def make_artifact(
    claim: BenchmarkClaim,
    provider_payload: dict[str, Any],
    run_label: str,
    artifact_index: int,
    error: BenchmarkError | None = None,
) -> dict[str, Any]:
    timestamp = datetime.now(timezone.utc).isoformat()
    artifact = {
        "id": f"{run_label}_{claim.id}_{provider_payload['provider']}_{provider_payload['provider_mode']}_{artifact_index:04d}",
        "timestamp": timestamp,
        "claim": {
            "id": claim.id,
            "text": claim.claim,
            "originalText": claim.claim,
        },
        "provider": provider_payload["provider"],
        "provider_mode": provider_payload["provider_mode"],
        "research_endpoint": provider_payload.get("research_endpoint"),
        "retrieved_contexts": provider_payload.get("retrieved_contexts", []),
        "response": provider_payload.get("response", {}),
        "citations": provider_payload.get("citations", []),
        "reference_answer": claim.reference_answer,
        "reference_verdict": claim.reference_verdict,
        "topic": claim.topic,
        "freshness_bucket": claim.freshness_bucket,
        "latency_ms": provider_payload.get("latency_ms", 0),
        "status": provider_payload.get("status", "success"),
        "error_type": provider_payload.get("error_type"),
        "cost_units": provider_payload.get("cost_units"),
        "cost_unit_name": provider_payload.get("cost_unit_name"),
        "cost_unit_price": provider_payload.get("cost_unit_price"),
        "cost_unit_price_low": provider_payload.get("cost_unit_price_low"),
        "cost_unit_price_high": provider_payload.get("cost_unit_price_high"),
        "cost_estimate": provider_payload.get("cost_estimate"),
        "cost_estimate_low": provider_payload.get("cost_estimate_low"),
        "cost_estimate_high": provider_payload.get("cost_estimate_high"),
        "cost_estimate_method": provider_payload.get("cost_estimate_method"),
    }
    if error is not None:
        artifact["status"] = "error"
        artifact["error_type"] = error.__class__.__name__
        artifact["response"] = {
            "verdict": "INSUFFICIENT_EVIDENCE",
            "summary": None,
            "explanation": f"[{error.status_code}] {error}"
            + (f" — {error.response_body[:1000]}" if error.response_body else ""),
            "confidence": 0,
            "report": f"Benchmark run failed for {provider_payload['provider']}:{provider_payload['provider_mode']}.",
        }
        artifact["citations"] = []
        artifact["retrieved_contexts"] = []
    return artifact


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the benchmark dataset across provider modes.")
    parser.add_argument(
        "--dataset",
        default="datasets/benchmark_claims.jsonl",
        help="Benchmark dataset JSONL path.",
    )
    parser.add_argument(
        "--output-file",
        default="results/live/benchmark_run.json",
        help="Artifact JSON file to write.",
    )
    parser.add_argument(
        "--providers",
        nargs="*",
        default=DEFAULT_PROVIDER_MODES,
        help="Provider mode specs like tavily:tavily_research exa:exa_search_structured.",
    )
    parser.add_argument(
        "--judge-provider",
        choices=["openai", "anthropic"],
        default="openai",
        help="Judge LLM used for provider modes that retrieve evidence then normalize via a shared judge.",
    )
    parser.add_argument(
        "--max-claims",
        type=int,
        default=0,
        help="Limit the number of benchmark claims. 0 means all claims.",
    )
    parser.add_argument(
        "--sleep-seconds",
        type=float,
        default=0.0,
        help="Optional pause between benchmark requests.",
    )
    parser.add_argument(
        "--fail-fast",
        action="store_true",
        help="Stop immediately on the first provider failure.",
    )
    parser.add_argument(
        "--list-provider-modes",
        action="store_true",
        help="Print supported provider modes and detected key status, then exit.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset_path = resolve_path(args.dataset)
    output_path = resolve_path(args.output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    claims = load_dataset(dataset_path)
    if args.max_claims > 0:
        claims = claims[: args.max_claims]
    keys = detect_api_keys()
    if args.list_provider_modes:
        print("Supported provider modes:")
        for provider, modes in sorted(SUPPORTED_PROVIDER_MODES.items()):
            key_state = mask_key(keys.get(provider, ""))
            print(f"- {provider} key={key_state}")
            for mode in sorted(modes):
                suffix = f" (requires {args.judge_provider} judge key too)" if provider_mode_needs_judge(mode) else ""
                print(f"  - {provider}:{mode}{suffix}")
        print(f"- openai judge key={mask_key(keys.get('openai', ''))}")
        print(f"- anthropic judge key={mask_key(keys.get('anthropic', ''))}")
        return

    specs = provider_mode_specs(args.providers, keys, args.judge_provider)
    if not specs:
        skipped = "\n".join(f"- {item}" for item in skipped_provider_modes(args.providers, keys, args.judge_provider))
        raise RuntimeError(
            "No runnable provider modes were selected. Check your API keys and --providers list."
            + (f"\nSkipped:\n{skipped}" if skipped else "")
        )
    if any(provider_mode_needs_judge(mode) for _, mode in specs) and not keys.get(args.judge_provider):
        raise RuntimeError(
            f"{args.judge_provider.upper()}_API_KEY is required for the selected judge-based provider modes."
        )

    run_label = datetime.now(timezone.utc).strftime("benchmark_%Y%m%dT%H%M%SZ")
    artifacts: list[dict[str, Any]] = []
    artifact_index = 1

    print(f"Loaded {len(claims)} benchmark claims from {dataset_path}")
    skipped = skipped_provider_modes(args.providers, keys, args.judge_provider)
    if skipped:
        print("Skipped provider modes:")
        for item in skipped:
            print(f"- {item}")
    print("Running provider modes:")
    for provider, mode in specs:
        print(f"- {provider}:{mode} key={mask_key(keys.get(provider, ''))}")

    for claim in claims:
        print(f"Claim {claim.id}: {claim.claim}")
        for provider, mode in specs:
            print(f"  -> {provider}:{mode}")
            base_payload = {
                "provider": provider,
                "provider_mode": mode,
                "response": {},
                "citations": [],
                "retrieved_contexts": [],
                "latency_ms": 0,
                "status": "error",
            }
            try:
                payload = run_provider_mode(claim, provider, mode, keys, args.judge_provider)
                artifacts.append(make_artifact(claim, payload, run_label, artifact_index))
                verdict = ((payload.get("response") or {}).get("verdict")) or "UNKNOWN"
                print(f"     success: {verdict}")
            except BenchmarkError as exc:
                artifacts.append(make_artifact(claim, base_payload, run_label, artifact_index, error=exc))
                print(f"     error [{exc.status_code}]: {exc}")
                if args.fail_fast:
                    output_path.write_text(json.dumps(artifacts, indent=2))
                    raise
            artifact_index += 1
            if args.sleep_seconds > 0:
                time.sleep(args.sleep_seconds)

    output_path.write_text(json.dumps(artifacts, indent=2))
    success_count = sum(1 for artifact in artifacts if artifact.get("status") == "success")
    auth_error_count = sum(
        1
        for artifact in artifacts
        if artifact.get("status") == "error"
        and "[401]" in (((artifact.get("response") or {}).get("explanation")) or "")
    )
    print(f"Wrote {len(artifacts)} artifacts to {output_path}")
    print(f"Successful runs: {success_count}/{len(artifacts)}")
    if auth_error_count:
        print(f"Authentication failures: {auth_error_count}. Check that those provider keys are current and belong to the right API product.", file=sys.stderr)


if __name__ == "__main__":
    main()
