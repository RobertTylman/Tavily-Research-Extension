/**
 * Tavily Research API Wrapper
 *
 * Uses the `/research` endpoint to produce a short verification report for a
 * claim. The research agent runs multiple searches server-side, analyzes the
 * sources, and returns a structured verdict we can render directly.
 *
 * Flow:
 *   1. POST /research           → returns request_id (status: pending)
 *   2. GET  /research/{id}      → polled until status is completed or failed
 *   3. Parse content + sources  → convert to our Verdict + Citation types
 */

import {
  Claim,
  Citation,
  ResearchStage,
  ResearchStatus,
  TavilyCitationFormat,
  TavilyResearchModel,
  TavilyResearchRequest,
  TavilyResearchResult,
  TavilyResearchSource,
  TavilyResearchSubmission,
  TavilyStructuredVerdict,
  Verdict,
  VerdictLabel,
} from './types';

const TAVILY_RESEARCH_URL = 'https://api.tavily.com/research';

const DEFAULT_MODEL: TavilyResearchModel = 'mini';
const DEFAULT_CITATION_FORMAT: TavilyCitationFormat = 'numbered';

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// STRUCTURED OUTPUT SCHEMA
// ============================================================================

const VERDICT_ENUM: VerdictLabel[] = ['SUPPORTED', 'FALSE', 'MISLEADING', 'INSUFFICIENT_EVIDENCE'];

const STRUCTURED_OUTPUT_SCHEMA: Record<string, unknown> = {
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
        'Calibrated confidence in the verdict between 0 and 1. Use 1.0 for definitively proven facts and lower values when sources conflict or are ambiguous.',
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
      description:
        'Caveats a reader should know about, such as stale sources or one-sided coverage.',
    },
  },
};

// ============================================================================
// PUBLIC API
// ============================================================================

export interface ResearchOptions {
  model?: TavilyResearchModel;
  citationFormat?: TavilyCitationFormat;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Receives narrated progress events while the research task is in flight. */
  onStatus?: (status: ResearchStatus) => void;
}

/**
 * Run a full fact-check research task for a claim and return a Verdict.
 */
export async function researchClaim(
  claim: Claim,
  apiKey: string,
  options: ResearchOptions = {}
): Promise<Verdict> {
  const start = Date.now();
  emitStatus(options, {
    stage: 'submitting',
    message: 'Submitting research request to Tavily…',
    elapsedSeconds: 0,
  });

  const submission = await submitResearch(claim, apiKey, options);

  emitStatus(options, {
    stage: 'searching',
    message: 'Research agent accepted — beginning multi-source search…',
    elapsedSeconds: Math.round((Date.now() - start) / 1000),
  });

  const result = await waitForResearch(submission.request_id, apiKey, options, start);

  emitStatus(options, {
    stage: 'finalizing',
    message: 'Verdict ready — assembling citations…',
    elapsedSeconds: Math.round((Date.now() - start) / 1000),
  });

  return toVerdict(claim, result);
}

/**
 * Verify that an API key is valid by kicking off a cheap research task.
 * We submit a minimal prompt and only check that the POST is accepted.
 */
export async function verifyApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(TAVILY_RESEARCH_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        input: 'ping',
        model: 'mini',
      } satisfies TavilyResearchRequest),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// REQUEST SUBMISSION
// ============================================================================

async function submitResearch(
  claim: Claim,
  apiKey: string,
  options: ResearchOptions
): Promise<TavilyResearchSubmission> {
  const body: TavilyResearchRequest = {
    input: buildResearchPrompt(claim),
    model: options.model || DEFAULT_MODEL,
    citation_format: options.citationFormat || DEFAULT_CITATION_FORMAT,
    output_schema: STRUCTURED_OUTPUT_SCHEMA,
    stream: false,
  };

  const response = await fetch(TAVILY_RESEARCH_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    throw new TavilyError(
      `Tavily research submit failed: ${response.status} ${response.statusText}`,
      response.status,
      errorText
    );
  }

  return (await response.json()) as TavilyResearchSubmission;
}

async function waitForResearch(
  requestId: string,
  apiKey: string,
  options: ResearchOptions,
  startedAt: number
): Promise<TavilyResearchResult> {
  const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timeout = options.timeoutMs ?? POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  const url = `${TAVILY_RESEARCH_URL}/${encodeURIComponent(requestId)}`;
  let tick = 0;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new DOMException('Research polling aborted', 'AbortError');
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(apiKey),
      signal: options.signal,
    });

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    if (response.status === 202) {
      const narration = pickNarration(elapsedSec, tick++);
      emitStatus(options, {
        stage: narration.stage,
        message: narration.message,
        elapsedSeconds: elapsedSec,
      });
      await sleep(pollInterval);
      continue;
    }

    if (!response.ok) {
      const errorText = await safeReadText(response);
      throw new TavilyError(
        `Tavily research poll failed: ${response.status} ${response.statusText}`,
        response.status,
        errorText
      );
    }

    const payload = (await response.json()) as TavilyResearchResult;

    if (payload.status === 'completed') {
      return payload;
    }

    if (payload.status === 'failed') {
      throw new TavilyError(
        payload.error || 'Tavily research task failed',
        response.status,
        JSON.stringify(payload)
      );
    }

    const narration = pickNarration(elapsedSec, tick++);
    emitStatus(options, {
      stage: narration.stage,
      message: narration.message,
      elapsedSeconds: elapsedSec,
    });
    await sleep(pollInterval);
  }

  throw new TavilyError(
    `Tavily research task ${requestId} timed out after ${Math.round(timeout / 1000)}s`,
    408,
    ''
  );
}

// ============================================================================
// LIVE NARRATION
// ============================================================================

interface NarrationPhase {
  until: number;
  stage: ResearchStage;
  messages: string[];
}

const NARRATION_PHASES: NarrationPhase[] = [
  {
    until: 6,
    stage: 'searching',
    messages: [
      'Querying reputable news and reference sources…',
      'Dispatching multi-source web searches…',
      'Pulling primary documents and reports…',
    ],
  },
  {
    until: 18,
    stage: 'searching',
    messages: [
      'Gathering evidence from wire services and fact-checkers…',
      'Reviewing top-ranked search results…',
      'Collecting article snippets and citations…',
    ],
  },
  {
    until: 40,
    stage: 'analyzing',
    messages: [
      'Reading retrieved articles in depth…',
      'Extracting passages relevant to the claim…',
      'Cross-referencing facts across sources…',
      'Comparing publication dates and authority…',
    ],
  },
  {
    until: 80,
    stage: 'synthesizing',
    messages: [
      'Weighing evidence for and against the claim…',
      'Drafting a verdict with calibrated confidence…',
      'Composing the citation-rich report…',
      'Cross-checking the explanation against sources…',
    ],
  },
  {
    until: Number.POSITIVE_INFINITY,
    stage: 'finalizing',
    messages: ['Finalizing report and citations…', 'Almost done — wrapping up the verdict…'],
  },
];

function pickNarration(
  elapsedSec: number,
  tickIndex: number
): { stage: ResearchStage; message: string } {
  const phase =
    NARRATION_PHASES.find((p) => elapsedSec < p.until) ??
    NARRATION_PHASES[NARRATION_PHASES.length - 1];
  const message = phase.messages[tickIndex % phase.messages.length];
  return { stage: phase.stage, message };
}

function emitStatus(options: ResearchOptions, status: ResearchStatus): void {
  if (!options.onStatus) return;
  try {
    options.onStatus(status);
  } catch (error) {
    console.warn('[Tavily] onStatus handler threw:', error);
  }
}

// ============================================================================
// RESULT → VERDICT
// ============================================================================

function toVerdict(claim: Claim, result: TavilyResearchResult): Verdict {
  const structured = parseStructuredContent(result.content);
  const sources = result.sources || [];

  const citations: Citation[] = sources.map((source) => toCitation(source));

  const verdictLabel = sanitizeVerdictLabel(structured?.verdict);
  const confidence = sanitizeConfidence(structured?.confidence);
  const summary = structured?.summary?.trim() || '';
  const explanation =
    structured?.explanation?.trim() ||
    summary ||
    'The Tavily research agent could not produce an explanation for this claim.';
  const report = buildReportMarkdown(structured, result.content, citations);

  return {
    claimId: claim.id,
    verdict: verdictLabel,
    confidence,
    explanation,
    citations,
    summary: summary || undefined,
    report,
    warnings:
      structured?.warnings && structured.warnings.length > 0 ? structured.warnings : undefined,
    confidenceExplanation: buildConfidenceExplanation(structured, citations),
    researchTimeSeconds: result.response_time,
  };
}

function toCitation(source: TavilyResearchSource): Citation {
  const url = source.url;
  const title = source.title || source.url;
  return {
    title,
    url,
    source: extractSourceName(url),
    snippet: source.snippet?.trim() || title,
    publishedDate: source.published_date || null,
    authority: undefined,
    favicon: source.favicon,
  };
}

function parseStructuredContent(
  content: TavilyResearchResult['content']
): Partial<TavilyStructuredVerdict> | null {
  if (!content) {
    return null;
  }

  if (typeof content === 'object') {
    return content as Partial<TavilyStructuredVerdict>;
  }

  if (typeof content !== 'string') {
    return null;
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;

  try {
    const parsed = JSON.parse(candidate) as Partial<TavilyStructuredVerdict>;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // fall through - treat as plain markdown report
  }

  return null;
}

function buildReportMarkdown(
  structured: Partial<TavilyStructuredVerdict> | null,
  rawContent: TavilyResearchResult['content'],
  citations: Citation[]
): string {
  if (structured?.report && structured.report.trim().length > 0) {
    return appendCitationsSection(structured.report.trim(), citations);
  }

  if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
    return appendCitationsSection(rawContent.trim(), citations);
  }

  if (structured?.summary || structured?.explanation) {
    const parts: string[] = [];
    if (structured.summary) {
      parts.push(`**Summary:** ${structured.summary}`);
    }
    if (structured.explanation) {
      parts.push(structured.explanation);
    }
    if (structured.key_findings && structured.key_findings.length > 0) {
      parts.push('**Key findings:**');
      for (const finding of structured.key_findings) {
        parts.push(`- ${finding}`);
      }
    }
    return appendCitationsSection(parts.join('\n\n'), citations);
  }

  return appendCitationsSection(
    'The research agent returned no narrative report for this claim.',
    citations
  );
}

function appendCitationsSection(markdown: string, citations: Citation[]): string {
  if (citations.length === 0) {
    return markdown;
  }
  const lines = citations.map((citation, index) => {
    const label = citation.title || citation.source;
    return `${index + 1}. [${label}](${citation.url})`;
  });
  return `${markdown}\n\n**Sources:**\n${lines.join('\n')}`;
}

function buildConfidenceExplanation(
  structured: Partial<TavilyStructuredVerdict> | null,
  citations: Citation[]
): string {
  const confidencePct =
    typeof structured?.confidence === 'number'
      ? Math.round(sanitizeConfidence(structured.confidence) * 100)
      : null;

  if (confidencePct === null) {
    return `Based on ${citations.length} source${citations.length === 1 ? '' : 's'} gathered by the Tavily research agent.`;
  }

  return `Confidence ${confidencePct}% — Tavily research agent synthesized ${citations.length} source${
    citations.length === 1 ? '' : 's'
  }.`;
}

function sanitizeVerdictLabel(value: unknown): VerdictLabel {
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

function sanitizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0.3;
  }
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1.0, normalized));
}

function buildResearchPrompt(claim: Claim): string {
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

// ============================================================================
// HELPERS
// ============================================================================

function buildHeaders(apiKey: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// ERRORS
// ============================================================================

export class TavilyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = 'TavilyError';
  }

  isRateLimited(): boolean {
    return this.statusCode === 429;
  }

  isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  isTimeout(): boolean {
    return this.statusCode === 408;
  }
}

// ============================================================================
// SOURCE METADATA EXTRACTION
// ============================================================================

/**
 * Extract the source name from a URL (e.g. https://www.nytimes.com/... → "New York Times").
 */
export function extractSourceName(url: string): string {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/^www\./, '');

    const sourceMap: Record<string, string> = {
      // Major newspapers
      'nytimes.com': 'New York Times',
      'washingtonpost.com': 'Washington Post',
      'wsj.com': 'Wall Street Journal',
      'latimes.com': 'Los Angeles Times',
      'chicagotribune.com': 'Chicago Tribune',
      'bostonglobe.com': 'Boston Globe',
      'usatoday.com': 'USA Today',
      // Wire services
      'reuters.com': 'Reuters',
      'apnews.com': 'Associated Press',
      'afp.com': 'AFP',
      // Broadcast
      'cnn.com': 'CNN',
      'bbc.com': 'BBC',
      'bbc.co.uk': 'BBC',
      'nbcnews.com': 'NBC News',
      'cbsnews.com': 'CBS News',
      'abcnews.go.com': 'ABC News',
      'npr.org': 'NPR',
      'pbs.org': 'PBS',
      // International
      'theguardian.com': 'The Guardian',
      'economist.com': 'The Economist',
      'ft.com': 'Financial Times',
      'aljazeera.com': 'Al Jazeera',
      'dw.com': 'Deutsche Welle',
      'france24.com': 'France 24',
      'cbc.ca': 'CBC',
      'abc.net.au': 'ABC Australia',
      'scmp.com': 'South China Morning Post',
      // Fact-checkers
      'snopes.com': 'Snopes',
      'politifact.com': 'PolitiFact',
      'factcheck.org': 'FactCheck.org',
      'fullfact.org': 'Full Fact',
      // Reference
      'wikipedia.org': 'Wikipedia',
      'en.wikipedia.org': 'Wikipedia',
      'britannica.com': 'Britannica',
      // Magazines
      'time.com': 'TIME',
      'theatlantic.com': 'The Atlantic',
      'newyorker.com': 'The New Yorker',
      'newsweek.com': 'Newsweek',
      'forbes.com': 'Forbes',
      // Business
      'bloomberg.com': 'Bloomberg',
      'businessinsider.com': 'Business Insider',
      'fortune.com': 'Fortune',
      // Politics
      'politico.com': 'Politico',
      'thehill.com': 'The Hill',
      'axios.com': 'Axios',
      // Tech
      'wired.com': 'Wired',
      'theverge.com': 'The Verge',
      'arstechnica.com': 'Ars Technica',
      'techcrunch.com': 'TechCrunch',
      // Science/Health
      'nature.com': 'Nature',
      'science.org': 'Science',
      'who.int': 'WHO',
      'cdc.gov': 'CDC',
      'nih.gov': 'NIH',
      'webmd.com': 'WebMD',
      'mayoclinic.org': 'Mayo Clinic',
    };

    if (sourceMap[hostname]) {
      return sourceMap[hostname];
    }

    const baseDomain = hostname.split('.').slice(-2).join('.');
    if (sourceMap[baseDomain]) {
      return sourceMap[baseDomain];
    }

    return hostname
      .split('.')[0]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return 'Unknown Source';
  }
}
