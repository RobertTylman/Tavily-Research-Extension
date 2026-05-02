import { describe, expect, it } from 'vitest';
import {
  buildRetrievedEvidence,
  createCitation,
  sanitizeConfidence,
  sanitizeVerdictLabel,
} from './researchShared';

describe('researchShared', () => {
  it('normalizes verdict labels from loose provider output', () => {
    expect(sanitizeVerdictLabel('true')).toBe('SUPPORTED');
    expect(sanitizeVerdictLabel('debunked')).toBe('FALSE');
    expect(sanitizeVerdictLabel('partially true')).toBe('MISLEADING');
    expect(sanitizeVerdictLabel('unknown')).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('normalizes confidence values from 0-100 or 0-1 ranges', () => {
    expect(sanitizeConfidence(88)).toBeCloseTo(0.88);
    expect(sanitizeConfidence(0.42)).toBeCloseTo(0.42);
    expect(sanitizeConfidence(undefined)).toBeCloseTo(0.3);
  });

  it('creates provider-tagged citations and evidence contexts', () => {
    const citation = createCitation(
      {
        url: 'https://example.com/article',
        title: 'Example Article',
        snippet: 'Key evidence snippet.',
      },
      'exa',
      1
    );

    expect(citation.provider).toBe('exa');
    expect(citation.rank).toBe(1);

    const evidence = buildRetrievedEvidence('exa', 'exa_search_structured', 'test query', 1500, [
      citation,
    ]);

    expect(evidence.contexts).toEqual(['Key evidence snippet.']);
    expect(evidence.rawLatencyMs).toBe(1500);
  });
});
