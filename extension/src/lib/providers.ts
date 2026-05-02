import { extractPage as extractTavilyPage, ExtractOptions, ExtractedPage } from './extract';
import { judgeClaimWithEvidence } from './judge';
import {
  appendCitationsSection,
  buildConfidenceExplanation,
  buildFallbackVerdict,
  buildResearchPrompt,
  buildRetrievedEvidence,
  createCitation,
  PARALLEL_STRUCTURED_VERDICT_SCHEMA,
  sanitizeConfidence,
  sanitizeVerdictLabel,
  STRUCTURED_VERDICT_SCHEMA,
  StructuredVerdictPayload,
} from './researchShared';
import { researchClaim as researchTavilyClaim, ResearchOptions } from './tavily';
import {
  Citation,
  Claim,
  ExtractProviderKind,
  LLMProvider,
  ProviderKind,
  ProviderMode,
  ResearchProviderKind,
  ResearchSettings,
  ResearchStatus,
  Verdict,
} from './types';

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents';
const EXA_RESEARCH_URL = 'https://api.exa.ai/research/v1';

const BRAVE_CONTEXT_URL = 'https://api.search.brave.com/res/v1/llm/context';
const BRAVE_ANSWERS_URL = 'https://api.search.brave.com/res/v1/chat/completions';

const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';
const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';

const PARALLEL_RUNS_URL = 'https://api.parallel.ai/v1/tasks/runs';

const DEFAULT_EXA_NUM_RESULTS = 5;
const DEFAULT_FIRECRAWL_LIMIT = 5;
const DEFAULT_HTTP_USER_AGENT = 'FactCheckerExtension/1.0 (+https://github.com/RobertTylman/Fact-Checker)';

export interface ProviderExtractionResult {
  page: ExtractedPage;
  endpoint: string;
}

export interface ProviderResearchOptions {
  provider: ResearchProviderKind;
  providerMode: ProviderMode;
  apiKey: string;
  settings: ResearchSettings;
  llmApiKey?: string | null;
  llmProvider?: LLMProvider;
  onStatus?: (status: ResearchStatus) => void;
  signal?: AbortSignal;
}

export async function extractPageWithProvider(
  url: string,
  provider: ExtractProviderKind,
  apiKey: string,
  options: ExtractOptions = {}
): Promise<ProviderExtractionResult> {
  switch (provider) {
    case 'tavily':
      return {
        page: await extractTavilyPage(url, apiKey, options),
        endpoint: 'POST https://api.tavily.com/extract',
      };
    case 'exa':
      return {
        page: await extractExaPage(url, apiKey, options.signal),
        endpoint: 'POST https://api.exa.ai/contents',
      };
    case 'firecrawl':
      return {
        page: await extractFirecrawlPage(url, apiKey, options.signal),
        endpoint: 'POST https://api.firecrawl.dev/v2/scrape',
      };
    default:
      throw new ProviderError(`Unsupported extraction provider: ${provider}`, provider, 400);
  }
}

export async function researchClaimWithProvider(
  claim: Claim,
  options: ProviderResearchOptions
): Promise<Verdict> {
  switch (options.providerMode) {
    case 'tavily_research':
      return runTavilyResearch(claim, options);
    case 'exa_search_structured':
      return runExaSearchStructured(claim, options);
    case 'exa_research_async':
      return runExaResearchAsync(claim, options);
    case 'brave_context_plus_judge':
      return runBraveContextJudge(claim, options);
    case 'brave_answers_native':
      return runBraveAnswers(claim, options);
    case 'firecrawl_search_plus_judge':
      return runFirecrawlJudge(claim, options);
    case 'parallel_task_run':
      return runParallelTask(claim, options);
    default:
      throw new ProviderError(
        `Unsupported provider mode: ${options.providerMode}`,
        options.provider,
        400
      );
  }
}

async function runTavilyResearch(claim: Claim, options: ProviderResearchOptions): Promise<Verdict> {
  const verdict = await researchTavilyClaim(claim, options.apiKey, {
    model: options.settings.model,
    citationFormat: options.settings.citationFormat,
    onStatus: options.onStatus,
    signal: options.signal,
  } satisfies ResearchOptions);
  verdict.provider = 'tavily';
  verdict.providerMode = 'tavily_research';
  verdict.researchEndpoint = 'POST/GET https://api.tavily.com/research';
  verdict.retrievedEvidence = buildRetrievedEvidence(
    'tavily',
    'tavily_research',
    claim.text,
    (verdict.researchTimeSeconds || 0) * 1000,
    verdict.citations
  );
  verdict.citations = verdict.citations.map((citation, index) => ({
    ...citation,
    provider: 'tavily',
    rank: citation.rank ?? index + 1,
    context: citation.context ?? citation.snippet,
  }));
  return verdict;
}

async function extractExaPage(
  url: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<ExtractedPage> {
  const response = await fetch(EXA_CONTENTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'User-Agent': DEFAULT_HTTP_USER_AGENT,
    },
    body: JSON.stringify({
      urls: [url],
      text: {
        maxCharacters: 20000,
      },
    }),
    signal,
  });

  if (!response.ok) {
    throw await ProviderError.fromResponse(response, 'exa', 'Exa contents request failed');
  }

  const payload = (await response.json()) as {
    results?: Array<{ url: string; title?: string; text?: string }>;
  };
  const item = payload.results?.[0];
  const content = item?.text?.trim() || '';
  if (!item || !content) {
    throw new ProviderError('Exa returned no page content.', 'exa', 502);
  }
  return {
    url: item.url,
    title: item.title,
    content,
  };
}

async function extractFirecrawlPage(
  url: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<ExtractedPage> {
  const response = await fetch(FIRECRAWL_SCRAPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
    }),
    signal,
  });

  if (!response.ok) {
    throw await ProviderError.fromResponse(response, 'firecrawl', 'Firecrawl scrape failed');
  }

  const payload = (await response.json()) as {
    success?: boolean;
    data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string } };
  };
  const content = payload.data?.markdown?.trim() || '';
  if (!payload.success || !content) {
    throw new ProviderError('Firecrawl returned no page content.', 'firecrawl', 502);
  }
  return {
    url: payload.data?.metadata?.sourceURL || url,
    title: payload.data?.metadata?.title,
    content,
  };
}

async function runExaSearchStructured(
  claim: Claim,
  options: ProviderResearchOptions
): Promise<Verdict> {
  emitSyntheticStatus(options, 'submitting', 'Submitting structured search to Exa…', 0);
  const startedAt = Date.now();
  const response = await fetch(EXA_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
      'User-Agent': DEFAULT_HTTP_USER_AGENT,
    },
    body: JSON.stringify({
      query: claim.text,
      type: 'auto',
      numResults: DEFAULT_EXA_NUM_RESULTS,
      contents: { highlights: true },
      outputSchema: STRUCTURED_VERDICT_SCHEMA,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw await ProviderError.fromResponse(response, 'exa', 'Exa search failed');
  }
  emitSyntheticStatus(options, 'searching', 'Exa search completed. Parsing grounded output…', 1);

  const payload = (await response.json()) as {
    results?: Array<{
      title?: string;
      url: string;
      publishedDate?: string;
      highlights?: string[];
      text?: string;
    }>;
    output?: {
      content?: Partial<StructuredVerdictPayload>;
      grounding?: Array<{
        field?: string;
        citations?: Array<{ url: string; title?: string }>;
        confidence?: string;
      }>;
    };
  };

  const citations = collectExaCitations(payload.results || [], payload.output?.grounding || []);
  const structured = payload.output?.content;
  const latencyMs = Date.now() - startedAt;
  emitSyntheticStatus(options, 'finalizing', 'Exa verdict ready — normalizing citations…', 1);

  const evidence = buildRetrievedEvidence(
    'exa',
    'exa_search_structured',
    claim.text,
    latencyMs,
    citations
  );

  return {
    claimId: claim.id,
    verdict: sanitizeVerdictLabel(structured?.verdict),
    confidence: sanitizeConfidence(structured?.confidence),
    explanation:
      structured?.explanation?.trim() ||
      structured?.summary?.trim() ||
      'Exa returned no explanation for this claim.',
    citations,
    warnings: structured?.warnings?.length ? structured.warnings : undefined,
    confidenceExplanation: buildConfidenceExplanation(
      'exa',
      sanitizeConfidence(structured?.confidence),
      citations
    ),
    summary: structured?.summary?.trim() || undefined,
    report: appendCitationsSection(structured?.report?.trim() || structured?.summary || '', citations),
    researchTimeSeconds: Math.round(latencyMs / 1000),
    provider: 'exa',
    providerMode: 'exa_search_structured',
    retrievedEvidence: evidence,
    researchEndpoint: 'POST https://api.exa.ai/search',
  };
}

function collectExaCitations(
  results: Array<{ title?: string; url: string; publishedDate?: string; highlights?: string[]; text?: string }>,
  grounding: Array<{ citations?: Array<{ url: string; title?: string }> }>
): Citation[] {
  const resultMap = new Map(results.map((result) => [result.url, result] as const));
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const entry of grounding) {
    for (const source of entry.citations || []) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      const result = resultMap.get(source.url);
      citations.push(
        createCitation(
          {
            url: source.url,
            title: source.title || result?.title,
            snippet: result?.highlights?.[0] || result?.text || result?.title || source.title || source.url,
            publishedDate: result?.publishedDate || null,
            context: result?.highlights?.join('\n') || result?.text || result?.title || source.title,
          },
          'exa',
          citations.length + 1
        )
      );
    }
  }

  for (const result of results) {
    if (seen.has(result.url)) continue;
    citations.push(
      createCitation(
        {
          url: result.url,
          title: result.title,
          snippet: result.highlights?.[0] || result.text || result.title || result.url,
          publishedDate: result.publishedDate || null,
          context: result.highlights?.join('\n') || result.text || result.title || result.url,
        },
        'exa',
        citations.length + 1
      )
    );
  }
  return citations;
}

async function runExaResearchAsync(
  claim: Claim,
  options: ProviderResearchOptions
): Promise<Verdict> {
  emitSyntheticStatus(options, 'submitting', 'Creating async Exa research task…', 0);
  const startedAt = Date.now();
  const createResponse = await fetch(EXA_RESEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
      'User-Agent': DEFAULT_HTTP_USER_AGENT,
    },
    body: JSON.stringify({
      instructions: buildResearchPrompt(claim),
      model: 'exa-research',
      outputSchema: STRUCTURED_VERDICT_SCHEMA,
    }),
    signal: options.signal,
  });

  if (!createResponse.ok) {
    throw await ProviderError.fromResponse(createResponse, 'exa', 'Exa async research create failed');
  }
  const created = (await createResponse.json()) as { researchId: string; status?: string };
  const pollUrl = `${EXA_RESEARCH_URL}/${encodeURIComponent(created.researchId)}`;

  while (true) {
    emitSyntheticStatus(options, 'analyzing', 'Polling Exa research task…', secondsSince(startedAt));
    await sleep(1000);
    const pollResponse = await fetch(pollUrl, {
      method: 'GET',
      headers: { 'x-api-key': options.apiKey, 'User-Agent': DEFAULT_HTTP_USER_AGENT },
      signal: options.signal,
    });
    if (!pollResponse.ok) {
      throw await ProviderError.fromResponse(pollResponse, 'exa', 'Exa async research poll failed');
    }
    const payload = (await pollResponse.json()) as {
      status: string;
      data?: Partial<StructuredVerdictPayload>;
      citations?: Record<string, Array<{ url: string; title?: string; snippet?: string }>>;
      error?: string;
    };
    if (payload.status === 'completed') {
      const citations = flattenExaResearchCitations(payload.citations || {});
      const evidence = buildRetrievedEvidence(
        'exa',
        'exa_research_async',
        claim.text,
        Date.now() - startedAt,
        citations
      );
      return {
        claimId: claim.id,
        verdict: sanitizeVerdictLabel(payload.data?.verdict),
        confidence: sanitizeConfidence(payload.data?.confidence),
        explanation:
          payload.data?.explanation?.trim() ||
          payload.data?.summary?.trim() ||
          'Exa returned no explanation for this claim.',
        citations,
        warnings: payload.data?.warnings?.length ? payload.data.warnings : undefined,
        confidenceExplanation: buildConfidenceExplanation(
          'exa',
          sanitizeConfidence(payload.data?.confidence),
          citations
        ),
        summary: payload.data?.summary?.trim() || undefined,
        report: appendCitationsSection(payload.data?.report?.trim() || payload.data?.summary || '', citations),
        researchTimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        provider: 'exa',
        providerMode: 'exa_research_async',
        retrievedEvidence: evidence,
        researchEndpoint: 'POST/GET https://api.exa.ai/research/v1',
      };
    }
    if (payload.status === 'failed' || payload.status === 'canceled') {
      throw new ProviderError(payload.error || 'Exa async research failed.', 'exa', 502);
    }
  }
}

function flattenExaResearchCitations(
  citationsByField: Record<string, Array<{ url: string; title?: string; snippet?: string }>>
): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  Object.values(citationsByField).forEach((items) => {
    items.forEach((item) => {
      if (seen.has(item.url)) return;
      seen.add(item.url);
      citations.push(
        createCitation(
          {
            url: item.url,
            title: item.title,
            snippet: item.snippet || item.title || item.url,
            context: item.snippet || item.title || item.url,
          },
          'exa',
          citations.length + 1
        )
      );
    });
  });
  return citations;
}

async function runBraveContextJudge(
  claim: Claim,
  options: ProviderResearchOptions
): Promise<Verdict> {
  ensureJudgeCredentials(options, 'Brave LLM Context');
  emitSyntheticStatus(options, 'submitting', 'Requesting Brave LLM Context…', 0);
  const startedAt = Date.now();
  const response = await fetch(BRAVE_CONTEXT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Subscription-Token': options.apiKey,
    },
    body: JSON.stringify({
      q: claim.text,
      country: 'US',
      search_lang: 'en',
      count: 10,
      maximum_number_of_urls: 8,
      maximum_number_of_tokens: 6000,
      enable_source_metadata: true,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await ProviderError.fromResponse(response, 'brave', 'Brave LLM Context request failed');
  }
  emitSyntheticStatus(options, 'searching', 'Brave context ready — sending evidence to judge…', 1);

  const payload = (await response.json()) as {
    grounding?: Record<string, unknown>;
    sources?: Record<
      string,
      { title?: string; description?: string; site_name?: string; favicon?: string; snippet?: string }
    >;
  };

  const citations = collectBraveContextCitations(payload);
  const verdict = await judgeClaimWithEvidence({
    provider: options.llmProvider!,
    apiKey: options.llmApiKey!,
    claim,
    evidenceCitations: citations,
    evidenceQuery: claim.text,
    evidenceEndpoint: 'POST https://api.search.brave.com/res/v1/llm/context',
    evidenceProvider: 'brave',
    evidenceMode: 'brave_context_plus_judge',
    onUsage: () => undefined,
  });
  verdict.retrievedEvidence = buildRetrievedEvidence(
    'brave',
    'brave_context_plus_judge',
    claim.text,
    Date.now() - startedAt,
    citations
  );
  verdict.researchTimeSeconds = Math.round((Date.now() - startedAt) / 1000);
  return verdict;
}

function collectBraveContextCitations(payload: {
  grounding?: Record<string, unknown>;
  sources?: Record<string, { title?: string; description?: string; site_name?: string; favicon?: string; snippet?: string }>;
}): Citation[] {
  const sources = payload.sources || {};
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const groundingBlocks = Object.values(payload.grounding || {}).flatMap((value) =>
    Array.isArray(value) ? value : [value]
  );

  for (const block of groundingBlocks) {
    const record = block as { url?: string; text?: string; content?: string; snippet?: string; source_url?: string };
    const url = record.url || record.source_url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const sourceMeta = sources[url];
    citations.push(
      createCitation(
        {
          url,
          title: sourceMeta?.title,
          source: sourceMeta?.site_name,
          snippet: record.snippet || record.text || record.content || sourceMeta?.snippet || sourceMeta?.description || url,
          favicon: sourceMeta?.favicon,
          context: record.text || record.content || sourceMeta?.snippet || sourceMeta?.description || url,
        },
        'brave',
        citations.length + 1
      )
    );
  }

  Object.entries(sources).forEach(([url, sourceMeta]) => {
    if (seen.has(url)) return;
    citations.push(
      createCitation(
        {
          url,
          title: sourceMeta.title,
          source: sourceMeta.site_name,
          snippet: sourceMeta.snippet || sourceMeta.description || sourceMeta.title || url,
          favicon: sourceMeta.favicon,
          context: sourceMeta.snippet || sourceMeta.description || sourceMeta.title || url,
        },
        'brave',
        citations.length + 1
      )
    );
  });

  return citations;
}

async function runBraveAnswers(
  claim: Claim,
  options: ProviderResearchOptions
): Promise<Verdict> {
  emitSyntheticStatus(options, 'submitting', 'Requesting Brave Answers…', 0);
  const startedAt = Date.now();
  const response = await fetch(BRAVE_ANSWERS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Subscription-Token': options.apiKey,
    },
    body: JSON.stringify({
      model: 'brave',
      stream: false,
      messages: [{ role: 'user', content: buildResearchPrompt(claim) }],
      web_search_options: {
        country: 'us',
        language: 'en',
        enable_citations: true,
        enable_research: true,
      },
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await ProviderError.fromResponse(response, 'brave', 'Brave Answers request failed');
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: Record<string, number>;
  };
  const content = payload.choices?.[0]?.message?.content || '';
  const citations = parseBraveAnswerCitations(content);
  const cleanContent = content.replace(/<citation>[\s\S]*?<\/citation>/g, '').trim();
  const verdict = buildFallbackVerdict(
    claim,
    'brave',
    'brave_answers_native',
    cleanContent || 'Brave Answers returned no content.',
    citations,
    buildRetrievedEvidence('brave', 'brave_answers_native', claim.text, Date.now() - startedAt, citations)
  );
  verdict.summary = cleanContent.split('\n')[0] || undefined;
  verdict.report = appendCitationsSection(cleanContent, citations);
  verdict.researchEndpoint = 'POST https://api.search.brave.com/res/v1/chat/completions';
  verdict.researchTimeSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (payload.usage?.['X-Request-Total-Cost']) {
    verdict.confidenceExplanation = `${verdict.confidenceExplanation} Estimated cost ${payload.usage['X-Request-Total-Cost']}.`;
  }
  return verdict;
}

function parseBraveAnswerCitations(content: string): Citation[] {
  const matches = Array.from(content.matchAll(/<citation>([\s\S]*?)<\/citation>/g));
  return matches.flatMap((match, index) => {
    try {
      const data = JSON.parse(match[1]) as {
        url: string;
        snippet?: string;
        favicon?: string;
      };
      return [
        createCitation(
          {
            url: data.url,
            snippet: data.snippet || data.url,
            favicon: data.favicon,
            context: data.snippet || data.url,
          },
          'brave',
          index + 1
        ),
      ];
    } catch {
      return [];
    }
  });
}

async function runFirecrawlJudge(
  claim: Claim,
  options: ProviderResearchOptions
): Promise<Verdict> {
  ensureJudgeCredentials(options, 'Firecrawl search');
  emitSyntheticStatus(options, 'submitting', 'Searching Firecrawl and scraping top results…', 0);
  const startedAt = Date.now();
  const response = await fetch(FIRECRAWL_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      query: claim.text,
      limit: DEFAULT_FIRECRAWL_LIMIT,
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
      },
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await ProviderError.fromResponse(response, 'firecrawl', 'Firecrawl search failed');
  }
  const payload = (await response.json()) as {
    success?: boolean;
    data?: Array<{
      url: string;
      title?: string;
      description?: string;
      markdown?: string;
      metadata?: { title?: string };
    }>;
  };
  const citations = (payload.data || []).map((item, index) =>
    createCitation(
      {
        url: item.url,
        title: item.title || item.metadata?.title,
        snippet: item.description || item.markdown || item.title || item.url,
        context: item.markdown || item.description || item.title || item.url,
      },
      'firecrawl',
      index + 1
    )
  );
  const verdict = await judgeClaimWithEvidence({
    provider: options.llmProvider!,
    apiKey: options.llmApiKey!,
    claim,
    evidenceCitations: citations,
    evidenceQuery: claim.text,
    evidenceEndpoint: 'POST https://api.firecrawl.dev/v2/search',
    evidenceProvider: 'firecrawl',
    evidenceMode: 'firecrawl_search_plus_judge',
  });
  verdict.retrievedEvidence = buildRetrievedEvidence(
    'firecrawl',
    'firecrawl_search_plus_judge',
    claim.text,
    Date.now() - startedAt,
    citations
  );
  verdict.researchTimeSeconds = Math.round((Date.now() - startedAt) / 1000);
  return verdict;
}

async function runParallelTask(claim: Claim, options: ProviderResearchOptions): Promise<Verdict> {
  emitSyntheticStatus(options, 'submitting', 'Creating Parallel task run…', 0);
  const startedAt = Date.now();
  const createResponse = await fetch(PARALLEL_RUNS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.apiKey,
    },
    body: JSON.stringify({
      input: buildResearchPrompt(claim),
      processor: 'base',
      task_spec: {
        output_schema: {
          type: 'json',
          json_schema: PARALLEL_STRUCTURED_VERDICT_SCHEMA,
        },
      },
    }),
    signal: options.signal,
  });
  if (!createResponse.ok) {
    throw await ProviderError.fromResponse(createResponse, 'parallel', 'Parallel task create failed');
  }
  const created = (await createResponse.json()) as { run_id?: string; runId?: string; status?: string };
  const runId = created.run_id || created.runId;
  if (!runId) {
    throw new ProviderError('Parallel task run returned no run ID.', 'parallel', 502);
  }

  while (true) {
    emitSyntheticStatus(options, 'analyzing', 'Polling Parallel run status…', secondsSince(startedAt));
    await sleep(1000);
    const statusResponse = await fetch(`${PARALLEL_RUNS_URL}/${encodeURIComponent(runId)}`, {
      method: 'GET',
      headers: { 'x-api-key': options.apiKey },
      signal: options.signal,
    });
    if (!statusResponse.ok) {
      throw await ProviderError.fromResponse(statusResponse, 'parallel', 'Parallel status poll failed');
    }
    const statusPayload = (await statusResponse.json()) as {
      status?: string;
      errors?: Array<{ message?: string }>;
    };
    if (statusPayload.status === 'completed') {
      break;
    }
    if (statusPayload.status === 'failed') {
      throw new ProviderError(
        statusPayload.errors?.[0]?.message || 'Parallel task run failed.',
        'parallel',
        502
      );
    }
  }

  const resultResponse = await fetch(`${PARALLEL_RUNS_URL}/${encodeURIComponent(runId)}/result`, {
    method: 'GET',
    headers: { 'x-api-key': options.apiKey },
    signal: options.signal,
  });
  if (!resultResponse.ok) {
    throw await ProviderError.fromResponse(resultResponse, 'parallel', 'Parallel result fetch failed');
  }
  const payload = (await resultResponse.json()) as {
    output?: {
      basis?: Array<{ url?: string; title?: string; snippet?: string; text?: string }>;
      type?: string;
      content?: Partial<StructuredVerdictPayload>;
    };
  };
  const citations = (payload.output?.basis || []).map((item, index) =>
    createCitation(
      {
        url: item.url || `parallel-basis-${index + 1}`,
        title: item.title,
        snippet: item.snippet || item.text || item.title || item.url || `Parallel basis ${index + 1}`,
        context: item.text || item.snippet || item.title || item.url || `Parallel basis ${index + 1}`,
      },
      'parallel',
      index + 1
    )
  );
  const structured = payload.output?.content;
  const verdict: Verdict = {
    claimId: claim.id,
    verdict: sanitizeVerdictLabel(structured?.verdict),
    confidence: sanitizeConfidence(structured?.confidence),
    explanation:
      structured?.explanation?.trim() ||
      structured?.summary?.trim() ||
      'Parallel returned no explanation for this claim.',
    citations,
    warnings: structured?.warnings?.length ? structured.warnings : undefined,
    confidenceExplanation: buildConfidenceExplanation(
      'parallel',
      sanitizeConfidence(structured?.confidence),
      citations
    ),
    summary: structured?.summary?.trim() || undefined,
    report: appendCitationsSection(structured?.report?.trim() || structured?.summary || '', citations),
    researchTimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    provider: 'parallel',
    providerMode: 'parallel_task_run',
    retrievedEvidence: buildRetrievedEvidence(
      'parallel',
      'parallel_task_run',
      claim.text,
      Date.now() - startedAt,
      citations
    ),
    researchEndpoint: 'POST/GET https://api.parallel.ai/v1/tasks/runs',
  };
  return verdict;
}

function ensureJudgeCredentials(options: ProviderResearchOptions, serviceName: string): void {
  if (!options.llmProvider || !options.llmApiKey) {
    throw new ProviderError(
      `${serviceName} requires an Anthropic or OpenAI API key for the shared verdict judge.`,
      options.provider,
      400
    );
  }
}

function emitSyntheticStatus(
  options: ProviderResearchOptions,
  stage: ResearchStatus['stage'],
  message: string,
  elapsedSeconds: number
): void {
  if (!options.onStatus) return;
  options.onStatus({ stage, message, elapsedSeconds });
}

function secondsSince(startedAt: number): number {
  return Math.max(1, Math.round((Date.now() - startedAt) / 1000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderKind,
    public readonly statusCode: number,
    public readonly responseBody = ''
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  static async fromResponse(
    response: Response,
    provider: ProviderKind,
    prefix: string
  ): Promise<ProviderError> {
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    return new ProviderError(
      `${prefix}: ${response.status} ${response.statusText}`,
      provider,
      response.status,
      body
    );
  }

  isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  isRateLimited(): boolean {
    return this.statusCode === 429;
  }

  isTimeout(): boolean {
    return this.statusCode === 408;
  }

  isPlanUnavailable(): boolean {
    return this.responseBody.includes('OPTION_NOT_IN_PLAN');
  }
}
