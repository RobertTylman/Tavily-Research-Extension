import { describe, expect, it } from 'vitest';
import {
  aggregateEvidence,
  calculateAuthority,
  detectStance,
  processSearchResults,
} from '../verifier';
import { Claim, Evidence, TavilySearchResult } from '../types';

const factualClaim: Claim = {
  id: 'claim_1',
  text: 'Meta was founded by Mark Zuckerberg.',
  originalText: 'Meta was founded by Mark Zuckerberg.',
  classification: 'FACTUAL',
};

describe('verifier', () => {
  it('returns INCONCLUSIVE for semantic-only matches without entailment provider', () => {
    const content = 'Meta was founded by Mark Zuckerberg in 2004.';

    expect(detectStance(factualClaim, content)).toBe('INCONCLUSIVE');
  });

  it('returns INCONCLUSIVE for negated claims without explicit deterministic signal', () => {
    const negatedClaim: Claim = {
      ...factualClaim,
      text: 'Meta was not founded by Mark Zuckerberg.',
      originalText: 'Meta was not founded by Mark Zuckerberg.',
    };
    const content = 'Meta was founded by Mark Zuckerberg in 2004.';

    expect(detectStance(negatedClaim, content)).toBe('INCONCLUSIVE');
  });

  it('does not perform directional semantic inference in deterministic fallback mode', () => {
    const claim: Claim = {
      id: 'claim_4',
      text: 'Israel attacked Iran.',
      originalText: 'Israel attacked Iran.',
      classification: 'FACTUAL',
    };

    expect(detectStance(claim, 'Iran attacked Israel during the conflict.')).toBe('INCONCLUSIVE');
    expect(detectStance(claim, 'Iran was attacked by Israel during the conflict.')).toBe(
      'INCONCLUSIVE'
    );
  });

  it('uses explicit fact-check verdict markers when present', () => {
    const claim: Claim = {
      id: 'claim_5',
      text: 'Meta was founded by Mark Zuckerberg.',
      originalText: 'Meta was founded by Mark Zuckerberg.',
      classification: 'FACTUAL',
    };

    const content = 'Fact-check verdict: false. Meta was founded by Mark Zuckerberg is inaccurate.';
    expect(detectStance(claim, content)).toBe('CONTRADICTS');
  });

  it('detects numeric contradiction for mismatched age claims', () => {
    const ageClaim: Claim = {
      id: 'claim_2',
      text: 'Donald Trump is 30 years old.',
      originalText: 'Donald Trump is 30 years old.',
      classification: 'FACTUAL',
    };
    const content = 'Donald Trump is 78 years old according to official records.';

    expect(detectStance(ageClaim, content)).toBe('CONTRADICTS');
  });

  it('scores authority by domain tiers and penalties', () => {
    expect(calculateAuthority('https://www.cdc.gov/news')).toBe(0.95);
    expect(calculateAuthority('https://www.reddit.com/r/news')).toBe(0.25);
  });

  it('aggregates weighted consensus scores from evidence stances', () => {
    const evidence: Evidence[] = [
      {
        source: 'CDC',
        url: 'https://cdc.gov/example',
        snippet: 'Supported',
        stance: 'SUPPORTS',
        authority: 0.95,
        publishedDate: null,
      },
      {
        source: 'Reuters',
        url: 'https://reuters.com/example',
        snippet: 'Supported',
        stance: 'SUPPORTS',
        authority: 0.85,
        publishedDate: null,
      },
      {
        source: 'Low Authority',
        url: 'https://example.com/example',
        snippet: 'Contradicted',
        stance: 'CONTRADICTS',
        authority: 0.4,
        publishedDate: null,
      },
    ];

    const aggregated = aggregateEvidence(evidence);

    expect(aggregated.supporting).toHaveLength(2);
    expect(aggregated.contradicting).toHaveLength(1);
    expect(aggregated.totalSources).toBe(3);
    expect(aggregated.consensusScore).toBeGreaterThan(0.6);
  });

  it('processes search results into stance buckets', () => {
    const claim: Claim = {
      id: 'claim_3',
      text: 'The Earth is round.',
      originalText: 'The Earth is round.',
      classification: 'FACTUAL',
    };

    const results: TavilySearchResult[] = [
      {
        title: 'Science source',
        url: 'https://science.org/earth',
        content: 'Rating: true. The Earth is round is correct.',
        raw_content: 'Rating: true. The Earth is round is correct.',
        score: 0.9,
      },
      {
        title: 'Debunk',
        url: 'https://example.com/flat-earth',
        content: 'Verdict: false. The Earth is round is debunked.',
        raw_content: 'Verdict: false. The Earth is round is debunked.',
        score: 0.6,
      },
    ];

    const aggregated = processSearchResults(claim, results);

    expect(aggregated.totalSources).toBe(2);
    expect(aggregated.supporting.length + aggregated.contradicting.length).toBeGreaterThan(0);
  });
});
