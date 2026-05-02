import { Citation, Claim, LLMProvider, ProviderKind, ProviderMode, Verdict } from './types';
import {
  appendCitationsSection,
  buildConfidenceExplanation,
  buildFallbackVerdict,
  buildRetrievedEvidence,
  sanitizeConfidence,
  sanitizeVerdictLabel,
  StructuredVerdictPayload,
} from './researchShared';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

const MAX_CONTEXT_CHARS = 16_000;

export interface JudgeOptions {
  provider: LLMProvider;
  apiKey: string;
  claim: Claim;
  evidenceCitations: Citation[];
  evidenceQuery?: string;
  evidenceEndpoint?: string;
  evidenceProvider: ProviderKind;
  evidenceMode: ProviderMode;
  onUsage?: (tokens: number) => void;
}

export async function judgeClaimWithEvidence(options: JudgeOptions): Promise<Verdict> {
  const evidenceText = truncateEvidence(options.evidenceCitations);
  if (!evidenceText.trim()) {
    return buildFallbackVerdict(
      options.claim,
      options.evidenceProvider,
      options.evidenceMode,
      'No evidence was available for the judge model to evaluate.',
      options.evidenceCitations
    );
  }

  const prompt = buildJudgePrompt(options.claim, evidenceText);
  const raw =
    options.provider === 'anthropic'
      ? await callAnthropic(prompt, options)
      : await callOpenAI(prompt, options);

  const parsed = parseJudgeResponse(raw);
  const citations = options.evidenceCitations;
  const evidence = buildRetrievedEvidence(
    options.evidenceProvider,
    options.evidenceMode,
    options.evidenceQuery || options.claim.text,
    0,
    citations
  );

  return {
    claimId: options.claim.id,
    verdict: sanitizeVerdictLabel(parsed.verdict),
    confidence: sanitizeConfidence(parsed.confidence),
    explanation: parsed.explanation?.trim() || parsed.summary?.trim() || 'No explanation returned.',
    citations,
    warnings: parsed.warnings?.length ? parsed.warnings : undefined,
    confidenceExplanation: buildConfidenceExplanation(
      options.evidenceProvider,
      sanitizeConfidence(parsed.confidence),
      citations
    ),
    summary: parsed.summary?.trim() || undefined,
    report: appendCitationsSection(parsed.report?.trim() || parsed.explanation || '', citations),
    provider: options.evidenceProvider,
    providerMode: options.evidenceMode,
    retrievedEvidence: evidence,
    researchEndpoint: options.evidenceEndpoint,
  };
}

function buildJudgePrompt(claim: Claim, evidenceText: string): string {
  return [
    'You are a careful fact-checking judge.',
    'Given a claim and retrieved evidence passages with source URLs, decide whether the claim is SUPPORTED, FALSE, MISLEADING, or INSUFFICIENT_EVIDENCE.',
    'Only use the supplied evidence. If the evidence is weak, conflicting, or stale, lower confidence or choose INSUFFICIENT_EVIDENCE.',
    'Respond with valid JSON only:',
    '{"verdict":"SUPPORTED|FALSE|MISLEADING|INSUFFICIENT_EVIDENCE","confidence":0.0,"summary":"...","explanation":"...","report":"...","warnings":["..."]}',
    '',
    `Claim: "${claim.text}"`,
    claim.originalText !== claim.text ? `Original wording: "${claim.originalText}"` : '',
    '',
    'Evidence:',
    evidenceText,
  ]
    .filter(Boolean)
    .join('\n');
}

function truncateEvidence(citations: Citation[]): string {
  const blocks = citations.map((citation, index) => {
    const label = citation.title || citation.source;
    const body = citation.context || citation.snippet || '';
    return `[${index + 1}] ${label}\nURL: ${citation.url}\n${body}`;
  });
  const joined = blocks.join('\n\n');
  if (joined.length <= MAX_CONTEXT_CHARS) {
    return joined;
  }
  return joined.slice(0, MAX_CONTEXT_CHARS) + '\n\n[...truncated evidence...]';
}

async function callAnthropic(prompt: string, options: JudgeOptions): Promise<string> {
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
  });

  if (!response.ok) {
    const body = await safeReadText(response);
    throw new Error(`Anthropic judge failed: ${response.status} ${response.statusText} ${body}`);
  }

  const payload = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (options.onUsage && payload.usage) {
    options.onUsage((payload.usage.input_tokens || 0) + (payload.usage.output_tokens || 0));
  }
  const text = payload.content?.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('Anthropic judge returned no text content.');
  }
  return text;
}

async function callOpenAI(prompt: string, options: JudgeOptions): Promise<string> {
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
          content: 'You are a careful fact-checking assistant. Always respond with valid JSON only.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await safeReadText(response);
    throw new Error(`OpenAI judge failed: ${response.status} ${response.statusText} ${body}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  if (options.onUsage && payload.usage?.total_tokens) {
    options.onUsage(payload.usage.total_tokens);
  }
  const text = payload.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('OpenAI judge returned no message content.');
  }
  return text;
}

function parseJudgeResponse(raw: string): Partial<StructuredVerdictPayload> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;
  const parsed = JSON.parse(candidate) as Partial<StructuredVerdictPayload>;
  return parsed;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
