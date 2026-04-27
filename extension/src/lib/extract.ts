/**
 * Tavily Extract API Wrapper
 *
 * POST https://api.tavily.com/extract
 *
 * Pulls clean article text out of a single URL. Used by the Page Fact Checker
 * mode to get the body of the page the user is currently reading without the
 * boilerplate (nav, ads, footers).
 */

import { TavilyError } from './tavily';

const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';

export interface ExtractOptions {
  signal?: AbortSignal;
  /** "basic" is fast and cheap, "advanced" handles JS-heavy pages. */
  extractDepth?: 'basic' | 'advanced';
}

export interface ExtractedPage {
  url: string;
  title?: string;
  content: string;
}

interface TavilyExtractResultItem {
  url: string;
  raw_content?: string;
  content?: string;
  title?: string;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResultItem[];
  failed_results?: Array<{ url: string; error?: string }>;
}

export async function extractPage(
  url: string,
  apiKey: string,
  options: ExtractOptions = {}
): Promise<ExtractedPage> {
  const response = await fetch(TAVILY_EXTRACT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      urls: [url],
      extract_depth: options.extractDepth ?? 'basic',
      format: 'text',
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    throw new TavilyError(
      `Tavily extract failed: ${response.status} ${response.statusText}`,
      response.status,
      errorText
    );
  }

  const payload = (await response.json()) as TavilyExtractResponse;
  const result = payload.results?.[0];

  if (!result) {
    const failure = payload.failed_results?.[0];
    throw new TavilyError(
      `Tavily extract returned no content${failure?.error ? `: ${failure.error}` : ''}`,
      502,
      JSON.stringify(payload)
    );
  }

  const content = (result.raw_content ?? result.content ?? '').trim();
  if (content.length === 0) {
    throw new TavilyError(
      'Tavily extract returned empty content for this page',
      502,
      JSON.stringify(payload)
    );
  }

  return {
    url: result.url,
    title: result.title,
    content,
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
