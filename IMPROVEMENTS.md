# Fact-Checker — Deep Analysis & Improvement Roadmap

This document is a code-level review of the current extension and a prioritized list of changes to improve **accuracy, professionalism, and real-world usefulness**. It is organized from "things that undermine the product's core promise" down to "nice-to-have expansions."

---

## 1. Executive Summary

The extension has a clean architectural skeleton (MV3 service worker, content script, typed React popup, well-separated `lib/` modules) and a sensible trust model (source weighting, epistemic humility caps, raw-content-only analysis, cached verdicts). However, the verification pipeline itself is built almost entirely on **regex heuristics and keyword scoring**, which is the single biggest gap between the README's "production-quality" framing and actual behavior. Most real-world claims will fall through the pattern cracks and land in `INSUFFICIENT_EVIDENCE`, or worse, produce false `SUPPORTS`/`CONTRADICTS` verdicts from spurious keyword matches.

The fixes below roughly split into three buckets:

- **Must-fix before any public release** — correctness bugs, misleading security claims, missing tests.
- **Quality-of-life** — UX polish, performance, engineering hygiene.
- **Expansion** — new inputs (PDFs, video), new backends (LLMs, multiple search providers), new surfaces (mobile, API).

---

## 2. What's Already Good

Worth preserving through any refactor:

- **Strict separation of concerns.** API key only ever lives in the service worker; popup and content script never touch it.
- **Multi-query search strategy** (neutral + fact-check-framed + negated) meaningfully reduces confirmation bias.
- **Tiered authority scoring** with explicit low-authority penalty list.
- **Epistemic humility defaults** — confidence capped at 0.9, `INSUFFICIENT_EVIDENCE` as the safe fallback, `MIN_SOURCES_FOR_VERDICT = 2`.
- **Source-diversity and recency warnings** surfaced in the UI, not hidden.
- **Cache layer** with normalization, expiry, and size cap.
- **Typed message protocol** (`ExtensionMessage` discriminated union) keeps popup↔worker communication safe.

Keep these as invariants.

---

## 3. Critical Issues (Correctness & Trust)

### 3.1 Stance detection is keyword-based and fragile
**Status:** ✅ Implemented April 19, 2026 (on-device NLI + optional LLM entailment + `(claim, url)` entailment cache + minimal deterministic fallback mode).

`verifier.ts` → `detectStance` and `detectSemanticMatch` rely on regexes over a fixed verb list ("founded", "acquired", "bombed", etc.). This breaks on:
- Paraphrases ("Meta was started by Zuckerberg" vs. pattern expecting "founded/created/established").
- Indirect speech ("sources close to the matter confirmed...").
- Any claim whose verb isn't in the list.
- Subject/object confusion — the pattern `([a-z\s\-']+) attacked ([a-z\s\-']+)` matches greedily and can flip actor/target.

**Fix:** introduce a real entailment step. Options, in order of cost:
1. **On-device NLI via `transformers.js`** (DistilBERT/MiniLM MNLI model, ~50–80 MB). Runs in the service worker via WASM; zero extra API cost.
2. **LLM-backed entailment** as an optional provider (Claude / GPT / local Ollama), switchable in settings. Send `{claim, snippet}` and ask for `SUPPORTS|CONTRADICTS|NEUTRAL` + one-sentence reasoning. Cache per `(claim, url)` pair.
3. Keep regex patterns only as a fast path for the highest-confidence, unambiguous forms — and require NLI agreement before trusting them.

### 3.2 Numeric contradiction detector produces false positives
`detectNumericContradiction` matches any number with a matching context type across the whole content string. "Trump is 78" in a source triggers `CONTRADICTS` for the claim "Trump is 30", which is correct — but "the tower cost 300 million" triggers `CONTRADICTS` for "the tower is 300m tall" if both get tagged as `amount`/`height` because contexts aren't anchored to the same entity.

**Fix:** require the number and its unit to appear in the same sentence as the claim's subject (use a window of ±15 tokens). Better yet, do this inside the NLI step above.

### 3.3 Compound-claim splitter breaks meaning
`splitIntoAtomicClaims` splits on `, and/but/or/yet/;`. That turns "Biden and Trump debated" into ["Biden", "Trump debated"] and mangles lists ("the US, UK, and France signed" → fragments).

**Fix:** only split when both sides parse as independent clauses (have their own subject+verb). A lightweight dependency parse (e.g., `compromise` or `wink-nlp`, both ~200 KB) gets this right without pulling in a full NLP stack.

### 3.4 Classification patterns leak
- `OPINION_MARKERS` includes `/\b(best|worst|greatest)\b/i`, which flags "Mount Everest is the highest mountain" as opinion on the word "highest"… actually not, but "greatest living scientist" and "best-selling novel" get false-positive'd as opinion.
- `PREDICTION_MARKERS` contains `/\b(will|going to)\b.*\b(be|become|happen)\b/i` — flags past-tense historical narration ("Lincoln would become president" in a biography) as prediction.
- `FACTUAL_INDICATORS` is a grab-bag where simple "is/are" overrides more specific markers because it's checked after opinion/prediction.

**Fix:** invert the flow. Do cheap NLI-style classification with a small zero-shot model, or at minimum move to scored features (sum of signals with per-pattern weights) rather than first-match-wins.

### 3.5 Misleading security claim in README
The README states "API keys stored in `chrome.storage.local` with **encryption at rest**." `chrome.storage.local` is **not** encrypted — it's a LevelDB file under the user profile readable by any process running as the user. This is fine for an API key the user pasted in, but the documentation should not claim otherwise.

**Fix:** remove the encryption claim, or actually implement WebCrypto-based AES-GCM encryption with a key derived from a user passphrase (opt-in), and be explicit that the default storage is plaintext-on-disk.

### 3.6 Redundant API key transmission
`tavily.ts` sends the API key both as `Authorization: Bearer` header **and** in the JSON body as `api_key`. This doubles the attack surface if either the header or body leaks (e.g., into a log).

**Fix:** send it in exactly one place (header is preferred; Tavily accepts both).

### 3.7 Progress bar is fake
`App.tsx` sets progress 10 → 30 → 100 regardless of actual work. Users have no signal when verification is slow.

**Fix:** stream progress from the background worker via `chrome.runtime.sendMessage({type: 'VERIFICATION_PROGRESS', ...})` with real per-claim updates.

### 3.8 No cancellation / abort
Closing the popup does not cancel in-flight Tavily requests. Claims continue to drain the rate-limit budget.

**Fix:** wire an `AbortController` through `executeTavilySearch`; cancel when the popup port disconnects.

### 3.9 Rate limiter lives in service-worker memory only
`rateLimiter.ts` keeps `requests: number[]` in a module-level variable. MV3 service workers are **killed after ~30 s of idle**; the array resets. The real per-minute limit in the user's session is therefore unbounded.

**Fix:** persist the request timestamps to `chrome.storage.session` (or `.local` with TTL cleanup).

---

## 4. Functionality Improvements

### 4.1 Inline, on-page verification
Currently you must open the popup, paste or rely on selection, then click. Competing products highlight claims directly on the page.
- Render a floating "Verify selection" pill near the current selection (content script UI in a shadow-DOM root to avoid CSS collisions).
- Optional "scan article" mode: run extraction against `<article>` / `<main>` and annotate each paragraph with a badge.
- Link each badge to the popup for drill-down.

### 4.2 Parallel claim verification with concurrency cap
`verifyText` in `background/index.ts` is a sequential `for…of` loop. For 5 claims × 3 queries × ~1s each that's ~15s. Use a bounded `Promise.all` (e.g., `p-limit` style, concurrency 3) and stream results back as they arrive.

### 4.3 Streaming verdict display
Pair 4.2 with a message protocol where the popup receives `VERDICT_READY` events and updates the `ClaimCard` list incrementally, rather than waiting for the whole batch.

### 4.4 Verification history UI
The cache exists but is invisible to users. Add a "History" tab (reading from `getCachedVerifications`) with:
- Filter by verdict / date / source.
- Re-run verification on a historical claim (bypass cache).
- Per-entry delete + bulk clear.
- JSON/CSV export (the README promises this; no button exists).

### 4.5 Feedback loop on bad verdicts
A single "report this verdict" button on each `ClaimCard` that writes to a local ledger (and, opt-in, to a GitHub issue via pre-filled `gh` URL). Use this data yourself to tune the patterns and NLI prompts.

### 4.6 Source allow/block list
Let users pin sources they trust (`*.cdc.gov`) or mute (`example-tabloid.com`). Apply in `calculateAuthority` before tier lookup.

### 4.7 Multi-provider search
Tavily is a single point of failure and cost. Abstract `searchForEvidence` behind a `SearchProvider` interface and add:
- Brave Search API (free tier, privacy-friendly).
- Google Programmable Search (CSE).
- Bing Web Search.
- (Optional, local) SearxNG endpoint for privacy-first users.
Let the user pick one or blend results.

### 4.8 LLM-assisted synthesis (opt-in, BYO key)
Same abstraction as 4.7, but for an "explain + synthesize" step:
- Input: claim + top-N weighted evidence snippets.
- Output: structured `{stance, confidence, quote, reasoning}` per source + overall verdict.
- Back-end options: Anthropic, OpenAI, local Ollama.
Keep the deterministic heuristic pipeline as a fallback for users without an LLM key.

### 4.9 ClaimReview integration
Query Google's ClaimReview API (or scrape schema.org `ClaimReview` JSON-LD from fact-checker pages) before running searches. If PolitiFact/Snopes/etc. already have a verdict on this exact claim, surface it as the primary result with their rating, saving a search round-trip.

### 4.10 Per-source stance rationale
Each citation currently shows snippet + URL. Add: why this source was tagged SUPPORTS/CONTRADICTS, derived from the NLI step above. Users should be able to disagree with a single source's classification without throwing out the whole verdict.

### 4.11 Keyboard navigation & accessibility
- Add ARIA roles to verdict badges, live-region announcement when results arrive.
- Focus trap in the popup, `Esc` to close settings.
- Screen-reader labels on the eye-toggle and theme-toggle buttons (currently only emoji content).
- Respect `prefers-reduced-motion` on the spinner and progress bar.

### 4.12 Configurable thresholds
Expose in settings:
- Cache TTL (default 24h).
- Rate-limit ceiling.
- Min sources for verdict.
- Confidence cap.
Advanced users will want to tune; novices stay on defaults.

---

## 5. Professionalism & Engineering Hygiene

### 5.1 Zero tests
There is no test directory, no runner, no CI config. For a product whose value proposition is "trust us with your factual questions," this is the biggest professionalism gap.

**Minimum viable test set:**
- `claimExtractor.test.ts` — golden-file tests for extraction on a corpus of ~50 sample texts covering factual/opinion/prediction/ambiguous edges.
- `verifier.test.ts` — fixture-driven: given a claim + a set of canned search results, assert the expected stance, authority, and consensus score.
- `verdictEngine.test.ts` — threshold boundary cases (e.g., consensus = 0.59 → not SUPPORTED; 0.60 → SUPPORTED).
- `tavily.test.ts` — mock `fetch`, assert request shape and error handling paths.

Use `vitest` (already Vite-native). Add a GitHub Actions workflow running `tsc --noEmit`, `vitest`, and a build on every PR.

### 5.2 Lint & format
No ESLint, no Prettier. Add:
- `eslint` with `@typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-chrome-extension`.
- `prettier` with a minimal config.
- Husky + lint-staged pre-commit hook.

### 5.3 Cross-platform build
`postbuild` script uses `cp -r`, which fails on Windows. Replace with a Node-based copy (`fs.cp`) or the `cpy` CLI.

### 5.4 Version & changelog discipline
- Adopt SemVer; bump on every release.
- Add `CHANGELOG.md` (Keep-a-Changelog format).
- Add `CONTRIBUTING.md` with issue triage + PR process.
- Add `CODE_OF_CONDUCT.md` if you want external contributors.
- Add GitHub issue & PR templates.

### 5.5 Chrome Web Store readiness
- Package screenshots, store description, privacy policy (mandatory for a `storage`-using extension that touches external APIs with user data).
- Add a privacy policy in-repo and linked from `chrome://extensions`.
- Prepare the `.zip` pipeline as a GitHub Release asset (action: `cardinalby/webext-buildtools-chrome-crx-action`).

### 5.6 Telemetry (opt-in, local-first)
Without any metrics, you have no signal on which claim types fail most. Add:
- Local-only counters (verdict distribution, avg confidence, cache hit rate) visible in settings.
- Opt-in, anonymized, aggregate stats export (no claim text, no URLs) — off by default.

### 5.7 Dead code
- `contentScript.ts` has a `selectionchange` listener that only `console.log`s — either wire it into inline verification (see 4.1) or remove it.
- `verifyApiKey` in `tavily.ts` is defined but never called. Wire it to the ApiKeyInput submit handler so users get "Key validated" feedback.

### 5.8 Manifest hardening
- Add an explicit `content_security_policy.extension_pages` — lock down to `'self'` only, disallow `unsafe-eval`.
- Consider `optional_host_permissions` for the chosen search provider so the extension can request them only when needed.
- The content script runs on `<all_urls>` but only handles `GET_SELECTED_TEXT`. Inject on-demand via `chrome.scripting.executeScript` from the popup instead, reducing passive attack surface.

### 5.9 Proper build-time env
Introduce `.env` support via Vite's native env handling so things like `SEARCH_PROVIDER`, default thresholds, and feature flags aren't constants in source.

---

## 6. New Use Cases / Surface Expansion

### 6.1 Social-media overlays
Content-script rules for X/Twitter, Facebook, LinkedIn, YouTube comments, Reddit, Bluesky, Threads, TikTok captions:
- Auto-highlight claim-like statements in timeline posts.
- Hover-to-verify badge.
- Batched verification over an entire thread.

### 6.2 Long-form article mode
"Scan this article" button that runs the full pipeline on `<article>` and produces:
- A summary bar (X true, Y false, Z unverified).
- Inline margin annotations per paragraph.
- A shareable report.

### 6.3 PDFs and images
- PDF: use `pdf.js` to extract text from the active tab if it's a `.pdf` URL.
- Images: optional OCR via `tesseract.js` for screenshots of claims (common on social media).

### 6.4 Video / audio transcripts
- YouTube: pull the caption track via the existing `timedtext` endpoint; let users verify claims as they watch.
- Podcasts / any HTML5 `<video>`: integrate with Whisper-on-device (webgpu) for transcript generation, then fact-check.

### 6.5 Cross-browser builds
- Firefox MV3 parity (swap `chrome.*` for `browser.*` via `webextension-polyfill`).
- Edge is a free port once Firefox works.
- Safari Web Extension via Xcode wrapper (harder; optional).

### 6.6 Public API / CLI
Expose the verification pipeline as:
- A standalone `npm` package (`@fact-checker/core`) so anyone can embed it.
- A CLI (`fact-check "The Earth is flat"`) for power users and CI-style factual checks in long-form writing workflows.
- A small hosted HTTP endpoint for integrations (Slack bot, Discord bot, Zapier).

### 6.7 Shareable verdict permalinks
Generate a URL that re-renders a stored verdict (claim + citations + confidence) so users can share it. Options:
- Client-only: base64-encode the verdict payload into the fragment (`#v=...`).
- Server-backed: tiny Cloudflare Worker that stores `{id → verdict}` with TTL.

### 6.8 Multilingual support
All classification patterns are English-only. For i18n:
- Localize UI strings (`react-i18next`).
- Make claim extractor pluggable per language; start with Spanish/French/German (high-value, large regex sets are still feasible), offload to LLM for long tail.

### 6.9 Classroom / research mode
- Batch import a list of claims (CSV) → run all → export results with citations.
- "Show your work" mode that records every query, every source, every stance decision (already mostly in `CachedVerification.searchQueries` — just needs a UI).
- Educator-friendly deterministic mode that disables LLM synthesis for reproducibility.

### 6.10 Integration hooks
- Obsidian plugin that fact-checks selected note text.
- VS Code extension for technical writers.
- Docs comment action (Google Docs, Notion) via their respective extension APIs.

---

## 7. Suggested Prioritization

Ship in this order if resources are limited:

| Order | Item | Rationale |
|------:|------|-----------|
| 1 | ✅ 5.1 tests + 5.2 lint + 5.3 cross-platform build *(completed April 19, 2026)* | Foundation. Every later change is safer. |
| 2 | 3.5 misleading encryption claim + 3.6 dual API-key send | Trust fixes, ~1 hour of work. |
| 3 | 3.9 persisted rate limiter + 3.8 cancellation | Correctness under real usage. |
| 4 | 3.1 NLI replacement (on-device first) | Single biggest accuracy win. |
| 5 | 4.2 + 4.3 parallel & streaming | Biggest perceived-speed win. |
| 6 | 4.1 inline on-page verification | Biggest UX leap; makes the extension feel alive. |
| 7 | 4.4 history UI + 4.5 feedback loop | Closes the trust loop with users and gives you tuning data. |
| 8 | 5.5 Chrome Web Store submission | Once 1–7 ship, distribute. |
| 9 | 6.1 social-media overlays + 6.2 article mode | Biggest use-case expansion once the core is trustworthy. |
| 10 | Everything else | Long-tail expansion. |

---

## 8. Out-of-Scope / Explicit Non-Goals

Worth naming so they don't creep in:

- **Automated crawling / background scanning.** Keep verification user-initiated to respect battery, bandwidth, and privacy.
- **Building a proprietary claims database.** The project's value is the pipeline and transparency, not hoarding verdicts.
- **Political "bias scoring" of sources.** Authority tiers are defensible; subjective bias labels are a rabbit hole and a liability.
- **Real-time streaming fact-check of live TV / speeches.** Fun demo, not a shippable product for this team size.

---

*Generated from a static read of the codebase at `main` (commit `ec2d9cf`). No runtime profiling has been done; some performance claims are read-from-code estimates. Re-check against live builds before quoting numbers.*
