import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSearchQueries, searchForEvidence, verifyApiKey } from '../tavily';
import { Claim, TavilySearchResponse } from '../types';

const claim: Claim = {
  id: 'claim_1',
  text: 'The Earth is round.',
  originalText: 'The Earth is round.',
  classification: 'FACTUAL',
};

function jsonResponse(payload: TavilySearchResponse, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('tavily', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('builds neutral, fact-check, and negated query variants', () => {
    const queries = generateSearchQueries(claim);

    expect(queries[0]).toBe('The Earth is round.');
    expect(queries[1]).toBe('fact check: The Earth is round');
    expect(queries[2]).toBe('The Earth is not round.');
  });

  it('deduplicates URLs across query responses and sends auth header', async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          query: claim.text,
          results: [
            {
              title: 'Result',
              url: 'https://example.com/source',
              content: 'Content',
              raw_content: 'Content',
              score: 0.9,
            },
          ],
        })
      )
    );
    vi.stubGlobal('fetch', mockFetch);

    const results = await searchForEvidence(claim, 'test-key');

    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const secondArg = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = secondArg.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(typeof secondArg.body).toBe('string');
  });

  it('continues processing when an individual query fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ query: 'q1', results: [] }, 500))
      .mockResolvedValueOnce(
        jsonResponse({
          query: 'q2',
          results: [
            {
              title: 'Good result',
              url: 'https://science.org/good',
              content: 'Good content',
              score: 0.9,
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          query: 'q3',
          results: [],
        })
      );
    vi.stubGlobal('fetch', mockFetch);

    const results = await searchForEvidence(claim, 'test-key');

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://science.org/good');
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('returns false when API key verification request throws', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(verifyApiKey('bad-key')).resolves.toBe(false);
  });
});
