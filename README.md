# Live Fact-Checking Chrome Extension

A production-quality Chrome extension that extracts verifiable claims from user-selected text, verifies them using Tavily's web search API, and returns transparent verdicts with citations.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)
![React](https://img.shields.io/badge/React-18-blue)

## Features

- **Text Selection or Paste** - Highlight text on any webpage or paste directly into the extension
- **Keyboard Shortcut** - Use `Ctrl+Shift+F` (or `Cmd+Shift+F` on Mac) to quickly verify selected text
- **Automatic Claim Extraction** - Splits compound sentences into atomic, verifiable claims
- **Smart Classification** - Categorizes claims as FACTUAL, OPINION, PREDICTION, or AMBIGUOUS
- **Verification Caching** - Caches verified claims to save API calls and provide instant results
- **Multi-Query Search** - Uses neutral, fact-check, and negated queries to avoid confirmation bias
- **Evidence Aggregation** - Weighs sources by authority, recency, and consensus
- **Source Diversity Checks** - Warns if sources lack diversity or high-authority domains
- **Transparent Verdicts** - Every verdict includes confidence scores, explanations, and cited sources
- **Dark Mode** - Automatically adapts to your system's color scheme
- **Data Export** - Export your verification history to JSON for analysis
- **Hybrid Entailment Layer** - NLI/LLM-first stance classification with a minimal deterministic fallback
- **On-Device NLI** - Optional `transformers.js` MNLI model in the service worker (no per-call API cost; first run downloads model files)
- **LLM Entailment Providers** - Optional OpenAI, Anthropic, or local Ollama stance classification
- **Automated Tests** - Vitest coverage for claim extraction, verifier logic, verdict thresholds, and Tavily request handling
- **Lint + Format Tooling** - ESLint and Prettier integrated into local scripts and pre-commit hooks
- **Cross-Platform Build** - Postbuild asset copy now uses a Node script (`fs.cp`) instead of shell-specific `cp`
- **CI Pipeline** - GitHub Actions runs typecheck, lint, tests, and build on every push/PR

## Architecture

```
extension/
├── src/
│   ├── background/        # Service worker (API calls, orchestration)
│   ├── content/           # Content script (text selection)
│   ├── ui/                # React popup components
│   ├── lib/               # Core logic modules
│   │   ├── types.ts       # TypeScript definitions
│   │   ├── claimExtractor.ts
│   │   ├── tavily.ts
│   │   ├── verifier.ts
│   │   ├── entailment.ts
│   │   └── verdictEngine.ts
│   └── utils/             # Helpers (messaging, rate limiting, cache)
├── public/
│   ├── manifest.json
│   └── icons/
└── dist/                  # Build output
```

## Claim Classification

| Type | Description | Example |
|------|-------------|---------|
| **FACTUAL** | Objective, verifiable with public sources | "The Eiffel Tower is 330 meters tall" |
| **OPINION** | Subjective, reflects personal views | "The best coffee is from Ethiopia" |
| **PREDICTION** | Future-oriented, cannot verify yet | "AI will replace 50% of jobs by 2030" |
| **AMBIGUOUS** | Lacks context or too vague | "It happened last week" |

## Verdict Labels

| Verdict | Meaning | Color |
|---------|---------|-------|
| **SUPPORTED** | Strong evidence confirms the claim | 🟢 Green |
| **FALSE** | Strong evidence contradicts the claim | 🔴 Red |
| **MISLEADING** | Contains truth but deceptive overall | 🟠 Orange |
| **INSUFFICIENT_EVIDENCE** | Not enough reliable sources | ⚪ Gray |

## Getting Started

### Prerequisites

- Node.js 18+
- A Tavily API key (free tier available)
- Optional: OpenAI/Anthropic API key or local Ollama for LLM entailment mode

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/Fact-Checker.git
   cd Fact-Checker/extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run build
   ```

4. Load in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `extension/dist` folder

5. Configure API Key:
   - Click the extension icon or use `Cmd+Shift+F`
   - Enter your Tavily API key in settings
   - (Optional) Choose entailment provider: `On-device NLI` (default), `LLM`, or `Regex`
   - If using `LLM`, set provider (`OpenAI`, `Anthropic`, or `Ollama`) and model/key in settings
   - Your key is stored locally and never sent to external servers

### Development

Run in watch mode for development:
```bash
npm run dev
```

Quality commands:
```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

## Security Model

- **API keys never touch client-side code** - All Tavily API calls go through the background service worker
- **Local storage only** - Tavily key and entailment settings/LLM key are stored in `chrome.storage.local` on the user's machine
- **Per-source entailment cache** - Entailment outputs are cached by `(claim, url)` to reduce repeated inference calls
- **Rate limiting** - 10 requests per minute to protect API quota
- **No external tracking** - No analytics or telemetry

## Design Philosophy

This extension is built with trust and transparency as core values:

1. **Source Transparency** - We ignore Tavily's generated answers and only use raw source content
2. **Epistemic Humility** - Confidence is capped at 90%; we prefer "Insufficient Evidence" over guessing
3. **Conservative Thresholds** - Strong consensus required for definitive verdicts
4. **Authority Weighting** - Government, academic, and fact-check sources weighted higher
5. **Entailment-First Stance** - Semantic stance is classified by NLI/LLM with conservative deterministic fallback

## Verification Pipeline

```mermaid
graph LR
    A[User Input] --> B[Claim Extraction]
    B --> C[Classification]
    C --> D{FACTUAL?}
    D -->|Yes| E[Check Cache]
    D -->|No| F[Skip Verification]
    E -->|Hit| G[Return Cached Verdict]
    E -->|Miss| H[Multi-Query Search]
    H --> I[Entailment Classification<br/>On-device NLI or LLM]
    I --> J[Evidence Aggregation]
    J --> K[Source Analysis]
    K --> L[Verdict Generation]
    L --> M[Cache & Display Results]
```

## API Reference

### Claim Extraction

```typescript
import { extractClaims, getFactualClaims } from './lib/claimExtractor';

const claims = extractClaims("The Earth is round and I think it's beautiful.");
// Returns 2 claims: one FACTUAL, one OPINION

const factual = getFactualClaims(claims);
// Returns only FACTUAL claims for verification
```

### Evidence Classification

```typescript
import { processSearchResults } from './lib/verifier';
import { buildEntailmentOverrides } from './lib/entailment';

const overrides = await buildEntailmentOverrides(claim, searchResults, settings);
const evidence = processSearchResults(claim, searchResults, overrides);
// Returns AggregatedEvidence with supporting/contradicting/inconclusive arrays
```

### Verdict Generation

```typescript
import { generateVerdict, getVerdictColor } from './lib/verdictEngine';

const verdict = generateVerdict(claim, evidence);
// Returns { verdict, confidence, explanation, citations, warnings }
```

## Testing

Run the automated suite:

```bash
npm run test
```

The suite currently covers:
- claim extraction behavior and classification boundaries
- evidence stance/authority/aggregation logic
- verdict threshold boundaries (`0.59` vs `0.60`, etc.)
- Tavily request shape, deduplication, and error handling

Manual smoke tests with sample claims:

✅ **True claims:**
- "The Great Wall of China is over 13,000 miles long"
- "Water freezes at 0 degrees Celsius"

❌ **False claims:**
- "The human body has 300 bones"
- "Mount Everest is located in Switzerland"

⚠️ **Opinion claims (won't verify):**
- "Pizza is the best food ever"
- "Summer is the best season"

## License

MIT

## Acknowledgments

- [Tavily](https://tavily.com) for the search API
- Built with React, TypeScript, and Vite
