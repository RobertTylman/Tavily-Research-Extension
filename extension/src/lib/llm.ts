/**
 * LLM Client (Anthropic + OpenAI)
 *
 * Provider-agnostic claim extraction. Given the body of a webpage, ask an LLM
 * to identify the most check-worthy factual claims and return them in a
 * structured form: a self-contained restatement plus the verbatim sentence
 * from the article (so the content script can find it in the DOM).
 *
 * Two providers are supported so users can bring whichever API key they have:
 *   - Anthropic: Claude Haiku 4.5 (fast, cheap, strong at structured output)
 *   - OpenAI:    gpt-4o-mini (same niche)
 */

import { LLMProvider, PageClaim } from './types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

const MAX_ARTICLE_CHARS = 20_000;

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: LLMProvider,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export interface ExtractClaimsOptions {
  provider: LLMProvider;
  apiKey: string;
  maxClaims: number;
  signal?: AbortSignal;
  onUsage?: (tokens: number) => void;
}

/**
 * Ask an LLM to pull the most check-worthy claims out of an article.
 */
export async function extractClaims(
  articleText: string,
  options: ExtractClaimsOptions
): Promise<PageClaim[]> {
  const trimmed = truncateArticle(articleText);
  const prompt = buildPrompt(trimmed, options.maxClaims);

  const raw =
    options.provider === 'anthropic'
      ? await callAnthropic(prompt, options)
      : await callOpenAI(prompt, options);

  const parsed = parseLLMResponse(raw);
  return normalizeClaims(parsed, articleText, options.maxClaims);
}

// ============================================================================
// PROMPT
// ============================================================================

function buildPrompt(articleText: string, maxClaims: number): string {
  return [
    'You are a careful fact-checking assistant. Your job is to identify the most check-worthy factual claims in the article below.',
    '',
    'A check-worthy claim:',
    '- Contains specific, verifiable facts (numbers, dates, attributions, named events, quotes).',
    '- Could plausibly be wrong, exaggerated, or missing context.',
    '- Stands on its own — a reader can evaluate it without surrounding paragraphs.',
    '',
    'Skip:',
    '- Pure opinion, framing, or analysis ("this is alarming", "experts worry").',
    '- Trivially true or definitional statements.',
    '- Personal anecdotes with no verifiable detail.',
    '',
    `Return at most ${maxClaims} claims, ordered by importance (most check-worthy first). Fewer is fine if the article does not contain that many.`,
    '',
    'For each claim return TWO fields:',
    '  1. "claim_text": A self-contained restatement of the claim, suitable for sending to a research agent. Include any context required to evaluate it.',
    '  2. "original_sentence": The EXACT sentence from the article where the claim appears. Verbatim, including punctuation. Do not paraphrase. Pick the single sentence that best contains the claim. If the claim spans multiple sentences, pick the one with the most specific facts.',
    '',
    'Respond with ONLY valid JSON, no prose, no markdown fences:',
    '{ "claims": [ { "claim_text": "...", "original_sentence": "..." } ] }',
    '',
    'Article:',
    '"""',
    articleText,
    '"""',
  ].join('\n');
}

function truncateArticle(text: string): string {
  if (text.length <= MAX_ARTICLE_CHARS) return text;
  return text.slice(0, MAX_ARTICLE_CHARS) + '\n\n[...article truncated for length...]';
}

// ============================================================================
// PROVIDERS
// ============================================================================

async function callAnthropic(prompt: string, options: ExtractClaimsOptions): Promise<string> {
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await safeReadText(response);
    throw new LLMError(
      `Anthropic request failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`,
      'anthropic',
      response.status
    );
  }

  const payload = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  const text = payload.content?.find((b) => b.type === 'text')?.text;
  if (!text) {
    throw new LLMError('Anthropic returned no text content', 'anthropic');
  }

  if (options.onUsage && payload.usage) {
    options.onUsage((payload.usage.input_tokens || 0) + (payload.usage.output_tokens || 0));
  }

  return text;
}

async function callOpenAI(prompt: string, options: ExtractClaimsOptions): Promise<string> {
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a careful fact-checking assistant. Always respond with valid JSON only, no prose, no markdown.',
        },
        { role: 'user', content: prompt },
      ],
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await safeReadText(response);
    throw new LLMError(
      `OpenAI request failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`,
      'openai',
      response.status
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens: number };
  };
  const text = payload.choices?.[0]?.message?.content;
  if (!text) {
    throw new LLMError('OpenAI returned no message content', 'openai');
  }

  if (options.onUsage && payload.usage) {
    options.onUsage(payload.usage.total_tokens || 0);
  }

  return text;
}

// ============================================================================
// PARSING
// ============================================================================

interface RawClaim {
  claim_text?: unknown;
  original_sentence?: unknown;
}

function parseLLMResponse(raw: string): RawClaim[] {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new LLMError(`Could not parse LLM JSON output: ${(error as Error).message}`, 'anthropic');
  }

  if (parsed && typeof parsed === 'object' && 'claims' in parsed) {
    const claims = (parsed as { claims: unknown }).claims;
    if (Array.isArray(claims)) return claims as RawClaim[];
  }

  if (Array.isArray(parsed)) {
    return parsed as RawClaim[];
  }

  throw new LLMError('LLM JSON did not contain a "claims" array', 'anthropic');
}

function normalizeClaims(
  rawClaims: RawClaim[],
  articleText: string,
  maxClaims: number
): PageClaim[] {
  const normalizedArticle = normalizeWhitespace(articleText);
  const seen = new Set<string>();
  const out: PageClaim[] = [];

  for (const raw of rawClaims) {
    if (out.length >= maxClaims) break;

    const claimText = typeof raw.claim_text === 'string' ? raw.claim_text.trim() : '';
    const originalSentenceRaw =
      typeof raw.original_sentence === 'string' ? raw.original_sentence.trim() : '';

    if (claimText.length === 0 || originalSentenceRaw.length === 0) continue;

    const dedupKey = claimText.toLowerCase();
    if (seen.has(dedupKey)) continue;

    // If the LLM lightly paraphrased the sentence, try to recover a verbatim
    // version from the article so the content script can locate it in the DOM.
    const originalSentence = recoverVerbatimSentence(originalSentenceRaw, normalizedArticle);

    seen.add(dedupKey);
    out.push({
      id: `pclaim_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      text: claimText,
      originalSentence,
    });
  }

  return out;
}

function recoverVerbatimSentence(candidate: string, normalizedArticle: string): string {
  const normalizedCandidate = normalizeWhitespace(candidate);
  if (normalizedArticle.includes(normalizedCandidate)) {
    return normalizedCandidate;
  }
  // Fall back to the first long-enough substring from the candidate that does
  // appear verbatim — gives the DOM matcher a chance to find SOMETHING.
  const words = normalizedCandidate.split(' ');
  for (let len = words.length; len >= 6; len--) {
    for (let start = 0; start + len <= words.length; start++) {
      const slice = words.slice(start, start + len).join(' ');
      if (normalizedArticle.includes(slice)) {
        return slice;
      }
    }
  }
  return normalizedCandidate;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
