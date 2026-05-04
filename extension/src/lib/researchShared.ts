import {
  Citation,
  Claim,
  ProviderKind,
  ProviderMode,
  RetrievedEvidence,
  Verdict,
  VerdictLabel,
} from './types';
import { extractSourceName } from './tavily';

export const VERDICT_ENUM: VerdictLabel[] = [
  'SUPPORTED',
  'FALSE',
  'MISLEADING',
  'INSUFFICIENT_EVIDENCE',
];

export const STRUCTURED_VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['verdict', 'confidence', 'summary', 'explanation', 'report'],
  properties: {
    verdict: {
      type: 'string',
      enum: VERDICT_ENUM,
      description:
        'Final verdict on the claim. SUPPORTED if strong evidence confirms it, FALSE if strong evidence contradicts it, MISLEADING if the claim is partly true but deceptive, INSUFFICIENT_EVIDENCE when reliable sources cannot settle it.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Calibrated confidence in the verdict between 0 and 1. Use lower values when evidence conflicts, is stale, or only partially supports the claim.',
    },
    summary: {
      type: 'string',
      description: 'One or two sentence plain-English summary of the verdict for end users.',
    },
    explanation: {
      type: 'string',
      description:
        'Short paragraph (2-4 sentences) explaining why the verdict was reached, referencing the strongest evidence.',
    },
    report: {
      type: 'string',
      description:
        'Concise fact-check report written in Markdown. Include an Executive Summary, the most important supporting or contradicting evidence with inline numbered citations like [1], and a brief caveats section when relevant.',
    },
    key_findings: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 bullet-style findings that back up the verdict.',
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Important caveats a reader should know about.',
    },
  },
};

export const PARALLEL_STRUCTURED_VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['verdict', 'confidence', 'summary', 'explanation', 'report'],
  properties: {
    verdict: STRUCTURED_VERDICT_SCHEMA.properties
      ? (STRUCTURED_VERDICT_SCHEMA.properties as Record<string, unknown>).verdict
      : {
          type: 'string',
          enum: VERDICT_ENUM,
        },
    confidence: {
      type: 'number',
      description:
        'Calibrated confidence in the verdict between 0 and 1. Use lower values when evidence conflicts, is stale, or only partially supports the claim.',
    },
    summary: {
      type: 'string',
      description: 'One or two sentence plain-English summary of the verdict for end users.',
    },
    explanation: {
      type: 'string',
      description:
        'Short paragraph (2-4 sentences) explaining why the verdict was reached, referencing the strongest evidence.',
    },
    report: {
      type: 'string',
      description:
        'Concise fact-check report written in Markdown. Include the most important supporting or contradicting evidence with inline numbered citations.',
    },
    key_findings: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 bullet-style findings that back up the verdict.',
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Important caveats a reader should know about.',
    },
  },
};

export interface StructuredVerdictPayload {
  verdict: VerdictLabel;
  confidence: number;
  summary: string;
  explanation: string;
  report: string;
  key_findings?: string[];
  warnings?: string[];
}

export function buildResearchPrompt(claim: Claim): string {
  return [
    'You are a careful fact-checking research agent. Investigate whether the claim below is true.',
    '',
    `Claim: "${claim.text}"`,
    claim.originalText !== claim.text ? `Original wording: "${claim.originalText}"` : '',
    '',
    'Search multiple reputable sources (prioritize government, academic, wire services, and major fact-checkers).',
    'Produce a short Markdown report with numbered inline citations, decide a verdict (SUPPORTED, FALSE, MISLEADING, or INSUFFICIENT_EVIDENCE), and give a calibrated confidence between 0 and 1.',
    'Never assert more certainty than the evidence supports.',
  ]
    .filter((line) => line.length > 0 || line === '')
    .join('\n');
}

export function sanitizeVerdictLabel(value: unknown): VerdictLabel {
  if (typeof value !== 'string') {
    return 'INSUFFICIENT_EVIDENCE';
  }
  const upper = value.toUpperCase().replace(/[^A-Z_]/g, '_');
  if ((VERDICT_ENUM as string[]).includes(upper)) {
    return upper as VerdictLabel;
  }
  if (upper === 'TRUE' || upper === 'SUPPORT' || upper === 'CONFIRMED') {
    return 'SUPPORTED';
  }
  if (upper === 'DEBUNKED' || upper === 'INCORRECT' || upper === 'REFUTED') {
    return 'FALSE';
  }
  if (upper === 'PARTIALLY_TRUE' || upper === 'MIXED') {
    return 'MISLEADING';
  }
  return 'INSUFFICIENT_EVIDENCE';
}

export function sanitizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0.3;
  }
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

export function appendCitationsSection(markdown: string, citations: Citation[]): string {
  if (citations.length === 0) {
    return markdown;
  }
  const lines = citations.map((citation, index) => {
    const label = citation.title || citation.source;
    return `${index + 1}. [${label}](${citation.url})`;
  });
  return `${markdown}\n\n**Sources:**\n${lines.join('\n')}`;
}

export function buildConfidenceExplanation(
  provider: ProviderKind,
  confidence: number,
  citations: Citation[]
): string {
  const confidencePct = Math.round(confidence * 100);
  return `Confidence ${confidencePct}% — ${provider} synthesized ${citations.length} source${
    citations.length === 1 ? '' : 's'
  }.`;
}

export function createCitation(
  input: Partial<Citation> & { url: string },
  provider: ProviderKind,
  rank?: number
): Citation {
  const title = input.title || input.url;
  const snippet = input.snippet?.trim() || title;
  return {
    title,
    url: input.url,
    source: input.source || extractSourceName(input.url),
    snippet,
    publishedDate: input.publishedDate ?? null,
    authority: input.authority,
    stance: input.stance,
    reasoning: input.reasoning,
    entailmentProvider: input.entailmentProvider,
    favicon: input.favicon,
    provider,
    rank,
    context: input.context ?? snippet,
  };
}

export function buildRetrievedEvidence(
  provider: ProviderKind,
  mode: ProviderMode,
  query: string,
  latencyMs: number,
  citations: Citation[],
  contexts?: string[]
): RetrievedEvidence {
  return {
    query,
    contexts:
      contexts && contexts.length > 0
        ? contexts
        : citations.map((citation) => citation.context || citation.snippet),
    citations,
    rawLatencyMs: latencyMs,
    provider,
    mode,
  };
}

export function buildFallbackVerdict(
  claim: Claim,
  provider: ProviderKind,
  mode: ProviderMode,
  message: string,
  citations: Citation[] = [],
  evidence?: RetrievedEvidence
): Verdict {
  return {
    claimId: claim.id,
    verdict: 'INSUFFICIENT_EVIDENCE',
    confidence: 0,
    explanation: message,
    citations,
    provider,
    providerMode: mode,
    retrievedEvidence: evidence,
    confidenceExplanation: buildConfidenceExplanation(provider, 0, citations),
  };
}
