# Fact-Checker Research Assistant
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-grey)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-grey)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-grey)
![React](https://img.shields.io/badge/React-18-grey)

The most successful tools are the ones that feel effortless. There’s no better place to do research than directly in your browser, one click away.

> **Note:** This project started as a Tavily-focused extension and now includes
> a multi-provider evaluation harness for Tavily, Exa, Brave, Firecrawl, and
> Parallel, plus offline reporting under `eval/`.

## [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/research-assistant/hjadgacmfondhchpdfhgdpfjiapdfege?authuser=0&hl=en)


<p align="center">
  <img src="assets/screenshot2.png" width="32%" />
  <img src="assets/screenshot3.png" width="32%" />
  <img src="assets/screenshot1.png" width="32%" />
</p>

 **Project Idea:**
Lightweight Chrome Extension that fact-checks selected text in-browser and a
Python evaluation workspace that benchmarks multiple research providers against
the same normalized verdict contract.

## How To Use:

1. You paste text into the popup, or right-click → **Search Selection**, or hit
   `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS) with text highlighted.
2. The background service worker submits that text verbatim to Tavily's
   `/research` endpoint and polls until the research task completes.
3. Tavily runs multi-source web search, weighs the evidence, and returns a
   structured verdict — label, confidence, summary, explanation, and a list of
   cited sources.
4. The popup renders the verdict with citations and a copy-to-clipboard share
   button. Live status updates and an elapsed-time counter run while the
   research is in flight.

## Features

- **Paste, select, or shortcut entry** — three ways to send text in
- **Live progress** — stage label, indeterminate progress bar, ticking elapsed
  timer, and streaming status messages from the background worker
- **Tavily research models** — pick `mini`, `auto`, or `pro` per your latency
  vs. depth tradeoff
- **Citation formats** — numbered, MLA, APA, or Chicago, selected in settings
- **Verdict caching** — repeated checks of the same claim return cached results
  immediately; cached entries are keyed by claim text
- **Rate limiting** — 10 requests/minute guardrail to protect API quota
- **Local-only key storage** — your Tavily API key lives in
  `chrome.storage.local`, never leaves the browser
- **Light/dark theme** — warm cream-and-peach light theme, deep navy dark
  theme; toggleable in the header and persisted to `localStorage`
- **Share** — one-click copy of a plain-text summary of the result

## Verdict labels

| Verdict                   | Meaning                                 | Color     |
| ------------------------- | --------------------------------------- | --------- |
| **SUPPORTED**             | Strong evidence confirms the claim      | 🟢 Green  |
| **FALSE**                 | Strong evidence contradicts the claim   | 🔴 Red    |
| **MISLEADING**            | Contains truth but deceptive overall    | 🟠 Orange |
| **INSUFFICIENT_EVIDENCE** | Not enough reliable sources to conclude | ⚪ Gray   |

Tavily returns the verdict label, a 0–1 confidence score, a one-sentence
summary, a longer explanation, and a markdown report containing inline
citations.

## How It Works

The extension uses a multi-stage pipeline to verify information, leveraging LLMs for identification and Tavily for deep web research.

### Step 1: Content Extraction (`/extract`)
When you click **"Fact-Check This Page"**, the extension sends the current URL to Tavily's `/extract` endpoint. This allows the system to:
*   Bypass the complex DOM of the local page and work with a clean, Markdown-formatted version of the article.
*   Strip away "noise" like navigation bars, advertisements, and footers that can confuse AI models.
*   Ensure the fact-checking logic is focused only on the core substance of the article.

### Step 2: Claim Identification (LLM)
The "cleaned" text is sent to your selected LLM provider (Claude or GPT-4o-mini). The model acts as a "Gatekeeper" to find **check-worthy claims**. 
*   It looks for specific, verifiable facts (numbers, dates, names).
*   It ignores opinions, analysis, and trivial truths.
*   It transforms vague sentences into **self-contained research queries** so they can be verified independently of the original context.

### Step 3: Deep Research (`/research`)
Each identified claim is sent to Tavily’s `/research` endpoint. This is the "Truth Engine" of the extension:
*   **Multi-Source Search:** The research agent performs multiple targeted web searches across reputable sources (news wire services, academic databases, and government reports).
*   **Information Synthesis:** It cross-references these sources to find points of agreement or contradiction.
*   **Structured Verdict:** Instead of just returning search results, it returns a structured JSON object containing a definitive verdict, a calibrated confidence score (0-100%), a detailed explanation, and a full Markdown report with inline citations.

---

## Architecture

```
extension/
├── src/
│   ├── background/
│   │   └── index.ts        # Service worker: routes messages, owns research call
│   ├── content/
│   │   └── contentScript.ts # Reads selected text from the active tab
│   ├── lib/
│   │   ├── tavily.ts       # /research submit + poll + structured-output parser
│   │   ├── verdictEngine.ts# Verdict label → color/icon helpers
│   │   └── types.ts        # Shared TS types
│   ├── ui/
│   │   ├── App.tsx         # Popup root, state machine
│   │   ├── components/     # Header, ClaimCard, VerdictBadge, CitationList,
│   │   │                   # ApiKeyInput
│   │   ├── icons.tsx       # SVG icon set
│   │   └── styles.css      # Theme tokens + component CSS
│   └── utils/
│       ├── messaging.ts    # chrome.runtime helpers + storage wrapper
│       ├── cache.ts        # Verdict cache in chrome.storage
│       └── rateLimiter.ts  # In-memory token bucket
├── public/
│   ├── manifest.json
│   └── icons/
└── dist/                   # Build output (loaded as unpacked extension)
```

## Getting started

### Prerequisites

- Node.js 18+
- A Tavily API key — [tavily.com](https://tavily.com)

### Install

```bash
git clone https://github.com/RobertTylman/Live-Fact-Checking-Assistant.git
cd Live-Fact-Checking-Assistant/extension
npm install
npm run build
```

### Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/dist` folder

### Configure

1. Click the extension icon (or press `Cmd+Shift+F` / `Ctrl+Shift+F`)
2. Open settings (gear icon, top right)
3. Paste your Tavily API key and save
4. Pick a research model and citation format

The popup is now ready. Type or paste text and hit **Search**, or highlight
text on any page and use the keyboard shortcut or context menu.

## Development

```bash
npm run build       # typecheck + vite build + postbuild copy
```

## Evaluation

The repo includes a Python evaluation workspace under [`eval/`](./eval/README.md).
It does three separate jobs:

- `run_benchmark.py` runs the same benchmark claims across multiple provider modes and writes normalized JSON artifacts.
- `evaluate_results.py` aggregates those artifacts into CSV summaries such as provider accuracy, latency, confusion matrices, and error breakdowns.
- `render_report.py` turns the summary CSVs into plots and a Markdown report.

Setup, API key configuration, benchmark commands, Ragas scoring, and report
rendering instructions live in [`eval/README.md`](./eval/README.md).

### Current evaluation outputs

The current checked-in static evaluation outputs live under:

- `eval/results/live/summary/report.md`
- `eval/results/live/summary/plots/`
- `eval/notebooks/results_overview.ipynb`

### Evaluation charts

#### Citation Count Distribution

Shows how many cited sources each provider returned per benchmark run. This is
useful for spotting providers that ground answers with richer source sets versus
providers that return sparse or missing evidence.

![Citation Count Distribution](eval/results/live/summary/plots/citation_histogram.png)

#### Latency By Provider Mode

Compares average response time by provider mode, with spread across the sampled
claims. Lower latency matters for an in-browser assistant because the user is
waiting in the popup while research completes.

![Latency By Provider Mode](eval/results/live/summary/plots/latency_distribution.png)

#### Mean Ragas Metrics

Summarizes Ragas scores for retrieved-context quality, answer faithfulness, and
answer relevancy. This helps separate fast providers from providers that also
produce evidence that is useful for downstream evaluation.

![Mean Ragas Metrics By Provider Mode](eval/results/live/summary/plots/ragas_means.png)

#### Unit Price

Shows the normalized request or credit price used by the benchmark cost model.
This chart is meant for provider-level cost comparison, not exact monthly spend. Numbers may vary based on query complexity.

![Unit Price By Provider Mode](eval/results/live/summary/plots/unit_price.png)

### For the full evaluation with generated reports and references, see [`eval/results/live/summary/report.md`](eval/results/live/summary/report.md).

### Provider choice

This extension uses Tavily because it offers the best overall combination for
the product: low latency, predictable cost, easy-to-understand documentation,
and a generous free tier for early usage and testing. Other providers are
legitimate competition, especially Parallel for deeper research-style tasks, but
Tavily remains a strong fit for a browser extension where speed, source-backed
answers, and simple integration matter most.

## Security

- Provider API keys used by the extension are read only by the background service worker and are never exposed to page context or content scripts.
- Extension keys and provider preferences are stored in `chrome.storage.local` on the user's machine.
- Eval keys loaded from environment variables or `.env` are used only by the Python benchmark scripts.
- Rate limiting (10 requests/minute) is enforced before any outbound call.
- No analytics, no telemetry, no third-party trackers.

## License

MIT

#### Built by [Robert Tylman](https://roberttylman.github.io/portfolio-site/)
