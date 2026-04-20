import {
  Claim,
  EntailmentResult,
  EntailmentSettings,
  EvidenceStance,
  TavilySearchResult,
} from './types';
import { detectStance, EvidenceClassificationOverride } from './verifier';
import { cacheEntailment, getCachedEntailment } from '../utils/cache';

let onDeviceClassifierPromise: Promise<ZeroShotClassifier> | null = null;

type ZeroShotClassifier = (
  sequence: string,
  labels: string[],
  options?: Record<string, unknown>
) => Promise<unknown>;

interface RawEntailmentPayload {
  stance: 'SUPPORTS' | 'CONTRADICTS' | 'NEUTRAL';
  reasoning: string;
  confidence?: number;
}

export async function buildEntailmentOverrides(
  claim: Claim,
  searchResults: TavilySearchResult[],
  settings: EntailmentSettings
): Promise<Map<string, EvidenceClassificationOverride>> {
  const overrides = new Map<string, EvidenceClassificationOverride>();

  for (const result of searchResults) {
    const primarySnippet = buildPrimarySnippet(claim.text, result);
    if (!primarySnippet) {
      continue;
    }
    const fallbackSnippet = buildFallbackSnippet(result);

    const cached = await getCachedEntailment(claim.text, result.url);
    if (cached && cached.provider !== 'heuristic_fallback') {
      overrides.set(result.url, toClassificationOverride(cached));
      continue;
    }

    const entailment = await runConfiguredEntailment(claim, primarySnippet, settings);
    let finalResult = resolveFinalStance(claim, primarySnippet, settings, entailment);

    if (shouldRetryWithFallbackSnippet(finalResult, primarySnippet, fallbackSnippet, settings)) {
      const fallbackEntailment = await runConfiguredEntailment(claim, fallbackSnippet, settings);
      const fallbackResult = resolveFinalStance(
        claim,
        fallbackSnippet,
        settings,
        fallbackEntailment
      );
      finalResult = chooseHigherSignalResult(finalResult, fallbackResult);
    }

    if (shouldCacheResult(finalResult, settings)) {
      await cacheEntailment(claim.text, result.url, finalResult);
    }
    overrides.set(result.url, toClassificationOverride(finalResult));
  }

  return overrides;
}

function resolveFinalStance(
  claim: Claim,
  snippet: string,
  settings: EntailmentSettings,
  entailment: EntailmentResult | null
): EntailmentResult {
  // Regex-only mode is an explicit opt-out.
  if (settings.provider === 'regex') {
    const stance = detectStance(claim, snippet);
    return {
      stance,
      confidence: 0.55,
      reasoning: 'Minimal deterministic fallback stance (explicit verdict/numeric checks only).',
      provider: 'regex_minimal',
    };
  }

  if (entailment) {
    return entailment;
  }

  // Provider failed/unavailable fallback.
  return {
    stance: detectStance(claim, snippet),
    confidence: 0.3,
    reasoning: 'NLI unavailable; used minimal deterministic fallback.',
    provider: 'heuristic_fallback',
  };
}

async function runConfiguredEntailment(
  claim: Claim,
  snippet: string,
  settings: EntailmentSettings
): Promise<EntailmentResult | null> {
  try {
    if (settings.provider === 'on_device_nli') {
      return await runOnDeviceNli(claim.text, snippet);
    }

    if (settings.provider === 'llm') {
      return await runLlmEntailment(claim.text, snippet, settings);
    }
  } catch (error) {
    console.warn('[Entailment] Provider failed:', error);
  }

  return null;
}

async function runOnDeviceNli(claim: string, snippet: string): Promise<EntailmentResult | null> {
  const classifier = await getOnDeviceClassifier();
  const labels = ['supports', 'contradicts', 'neutral'];

  const rawOutput = await classifier(snippet, labels, {
    hypothesis_template: `This evidence {} the claim: "${claim}"`,
    multi_label: false,
  });

  const top = parseZeroShotTopLabel(rawOutput);
  if (!top) {
    return null;
  }

  const stance = mapLabelToStance(top.label);
  return {
    stance,
    confidence: clamp(top.score, 0.05, 0.95),
    reasoning: `On-device MNLI prediction: ${top.label}.`,
    provider: 'on_device_nli',
  };
}

async function getOnDeviceClassifier(): Promise<ZeroShotClassifier> {
  if (!onDeviceClassifierPromise) {
    onDeviceClassifierPromise = (async () => {
      const mod = (await import('@xenova/transformers')) as {
        pipeline: (
          task: string,
          model: string,
          options?: Record<string, unknown>
        ) => Promise<ZeroShotClassifier>;
        env: {
          allowLocalModels?: boolean;
          useBrowserCache?: boolean;
        };
      };

      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = true;

      return mod.pipeline('zero-shot-classification', 'Xenova/distilbert-base-uncased-mnli', {
        quantized: true,
      });
    })();
  }

  return onDeviceClassifierPromise;
}

async function runLlmEntailment(
  claim: string,
  snippet: string,
  settings: EntailmentSettings
): Promise<EntailmentResult | null> {
  if (settings.llmProvider === 'openai') {
    return runOpenAiEntailment(claim, snippet, settings);
  }

  if (settings.llmProvider === 'anthropic') {
    return runAnthropicEntailment(claim, snippet, settings);
  }

  if (settings.llmProvider === 'ollama') {
    return runOllamaEntailment(claim, snippet, settings);
  }

  return null;
}

async function runOpenAiEntailment(
  claim: string,
  snippet: string,
  settings: EntailmentSettings
): Promise<EntailmentResult | null> {
  if (!settings.llmApiKey) {
    return null;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.llmApiKey}`,
    },
    body: JSON.stringify({
      model: settings.llmModel || 'gpt-4.1-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are an entailment classifier. Return strict JSON only with keys: stance, reasoning, confidence.',
        },
        {
          role: 'user',
          content: buildLlmPrompt(claim, snippet),
        },
      ],
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const contentText = data.choices?.[0]?.message?.content || '';
  return parseLlmPayload(contentText, 'llm_openai');
}

async function runAnthropicEntailment(
  claim: string,
  snippet: string,
  settings: EntailmentSettings
): Promise<EntailmentResult | null> {
  if (!settings.llmApiKey) {
    return null;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.llmApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: settings.llmModel || 'claude-3-5-haiku-latest',
      max_tokens: 180,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: buildLlmPrompt(claim, snippet),
        },
      ],
      system:
        'Return strict JSON only with keys: stance, reasoning, confidence. stance must be SUPPORTS, CONTRADICTS, or NEUTRAL.',
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const contentText = data.content?.find((item) => item.type === 'text')?.text || '';
  return parseLlmPayload(contentText, 'llm_anthropic');
}

async function runOllamaEntailment(
  claim: string,
  snippet: string,
  settings: EntailmentSettings
): Promise<EntailmentResult | null> {
  const baseUrl = (settings.ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.llmModel || 'llama3.1',
      stream: false,
      format: 'json',
      prompt: buildLlmPrompt(claim, snippet),
      options: {
        temperature: 0,
      },
    }),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { response?: string };
  return parseLlmPayload(data.response || '', 'llm_ollama');
}

function buildLlmPrompt(claim: string, snippet: string): string {
  return [
    'Classify whether the evidence snippet supports or contradicts the claim.',
    'Output JSON only with keys: stance, reasoning, confidence.',
    'Allowed stance values: SUPPORTS, CONTRADICTS, NEUTRAL.',
    `Claim: ${claim}`,
    `Evidence snippet: ${snippet}`,
  ].join('\n');
}

function parseLlmPayload(text: string, provider: string): EntailmentResult | null {
  const payload = extractJsonPayload(text);
  if (!payload) {
    return null;
  }

  const stance = mapLabelToStance(payload.stance);
  return {
    stance,
    confidence: clamp(payload.confidence ?? 0.65, 0.05, 0.95),
    reasoning: payload.reasoning || 'No reasoning provided by model.',
    provider,
  };
}

function parseZeroShotTopLabel(output: unknown): { label: string; score: number } | null {
  if (!output) {
    return null;
  }

  const arrayOutput = Array.isArray(output) ? output[0] : output;
  const labels = (arrayOutput as { labels?: string[] }).labels || [];
  const scores = (arrayOutput as { scores?: number[] }).scores || [];
  if (!labels.length || !scores.length || labels.length !== scores.length) {
    return null;
  }

  let maxIndex = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if (scores[i] > scores[maxIndex]) {
      maxIndex = i;
    }
  }

  return { label: labels[maxIndex], score: scores[maxIndex] };
}

function extractJsonPayload(text: string): RawEntailmentPayload | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || trimmed;

  try {
    const parsed = JSON.parse(candidate) as Partial<RawEntailmentPayload>;
    const stance = normalizePayloadStance(parsed.stance);
    if (!stance) {
      return null;
    }

    return {
      stance,
      reasoning: (parsed.reasoning || '').toString().trim(),
      confidence:
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? parsed.confidence
          : undefined,
    };
  } catch {
    return null;
  }
}

function normalizePayloadStance(value: string | undefined): RawEntailmentPayload['stance'] | null {
  if (!value) {
    return null;
  }

  const upper = value.toUpperCase();
  if (upper === 'SUPPORTS') {
    return 'SUPPORTS';
  }
  if (upper === 'CONTRADICTS') {
    return 'CONTRADICTS';
  }
  if (upper === 'NEUTRAL') {
    return 'NEUTRAL';
  }
  return null;
}

function mapLabelToStance(label: string): EvidenceStance {
  const normalized = label.toLowerCase();
  if (normalized.includes('contradict')) {
    return 'CONTRADICTS';
  }
  if (normalized.includes('support')) {
    return 'SUPPORTS';
  }
  if (normalized === 'supports') {
    return 'SUPPORTS';
  }
  if (normalized === 'contradicts') {
    return 'CONTRADICTS';
  }
  return 'INCONCLUSIVE';
}

function toClassificationOverride(result: EntailmentResult): EvidenceClassificationOverride {
  return {
    stance: result.stance,
    confidence: result.confidence,
    reasoning: result.reasoning,
    provider: result.provider,
  };
}

function buildPrimarySnippet(claimText: string, result: TavilySearchResult): string {
  const focusedRaw = extractFocusedRawSnippet(claimText, result.raw_content || '');
  if (focusedRaw) {
    return focusedRaw;
  }

  return normalizeWhitespace((result.content || '').slice(0, 1200));
}

function buildFallbackSnippet(result: TavilySearchResult): string {
  return normalizeWhitespace((result.content || '').slice(0, 1200));
}

function extractFocusedRawSnippet(claimText: string, rawContent: string): string {
  const normalizedRaw = normalizeWhitespace(rawContent).slice(0, 7000);
  if (!normalizedRaw) {
    return '';
  }

  const sentences = normalizedRaw
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 30);

  if (sentences.length === 0) {
    return normalizedRaw.slice(0, 1200);
  }

  const claimKeywords = extractSignalKeywords(claimText);
  if (claimKeywords.length === 0) {
    return sentences.slice(0, 3).join(' ').slice(0, 1200);
  }

  const ranked = sentences
    .map((sentence) => ({
      sentence,
      score: keywordOverlapScore(claimKeywords, sentence),
    }))
    .sort((a, b) => b.score - a.score);

  const focused = ranked
    .filter((item) => item.score >= 0.2)
    .slice(0, 4)
    .map((item) => item.sentence);

  if (focused.length === 0) {
    return sentences.slice(0, 3).join(' ').slice(0, 1200);
  }

  return normalizeWhitespace(focused.join(' ')).slice(0, 1400);
}

function extractSignalKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function keywordOverlapScore(claimKeywords: string[], sentence: string): number {
  if (claimKeywords.length === 0) {
    return 0;
  }

  const lowerSentence = sentence.toLowerCase();
  let matches = 0;
  for (const keyword of claimKeywords) {
    if (lowerSentence.includes(keyword)) {
      matches += 1;
    }
  }

  return matches / claimKeywords.length;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function shouldRetryWithFallbackSnippet(
  result: EntailmentResult,
  primarySnippet: string,
  fallbackSnippet: string,
  settings: EntailmentSettings
): boolean {
  if (settings.provider === 'regex') {
    return false;
  }
  if (!fallbackSnippet) {
    return false;
  }
  if (fallbackSnippet === primarySnippet) {
    return false;
  }
  return result.stance === 'INCONCLUSIVE' && result.confidence < 0.65;
}

function chooseHigherSignalResult(
  primary: EntailmentResult,
  secondary: EntailmentResult
): EntailmentResult {
  if (primary.provider === 'heuristic_fallback' && secondary.provider !== 'heuristic_fallback') {
    return secondary;
  }
  if (secondary.provider === 'heuristic_fallback' && primary.provider !== 'heuristic_fallback') {
    return primary;
  }

  if (primary.stance === 'INCONCLUSIVE' && secondary.stance !== 'INCONCLUSIVE') {
    return secondary;
  }
  if (secondary.stance === 'INCONCLUSIVE' && primary.stance !== 'INCONCLUSIVE') {
    return primary;
  }

  return secondary.confidence > primary.confidence ? secondary : primary;
}

function shouldCacheResult(result: EntailmentResult, settings: EntailmentSettings): boolean {
  if (settings.provider === 'regex') {
    return true;
  }
  if (result.provider === 'heuristic_fallback') {
    return false;
  }
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'shall',
  'can',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'that',
  'which',
  'who',
  'whom',
  'this',
  'these',
  'those',
  'it',
  'and',
  'but',
  'or',
  'not',
  'no',
  'yes',
  'all',
  'each',
  'every',
]);
