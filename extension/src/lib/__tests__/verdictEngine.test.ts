import { describe, expect, it } from 'vitest';
import { generateVerdict } from '../verdictEngine';
import { AggregatedEvidence, Claim, Evidence } from '../types';

const claim: Claim = {
  id: 'claim_1',
  text: 'Water boils at 100 degrees Celsius.',
  originalText: 'Water boils at 100 degrees Celsius.',
  classification: 'FACTUAL',
};

function buildEvidence(stance: Evidence['stance'], authority = 0.85): Evidence {
  return {
    source: stance === 'SUPPORTS' ? 'Source Support' : 'Source Contradict',
    url: stance === 'SUPPORTS' ? 'https://science.org/support' : 'https://factcheck.org/contradict',
    snippet: 'Example snippet',
    stance,
    authority,
    publishedDate: null,
  };
}

function buildAggregatedEvidence(input: Partial<AggregatedEvidence>): AggregatedEvidence {
  return {
    supporting: [],
    contradicting: [],
    inconclusive: [],
    consensusScore: 0,
    totalSources: 0,
    ...input,
  };
}

describe('verdictEngine', () => {
  it('returns INSUFFICIENT_EVIDENCE below supported threshold boundary', () => {
    const evidence = buildAggregatedEvidence({
      supporting: [buildEvidence('SUPPORTS'), buildEvidence('SUPPORTS', 0.75)],
      consensusScore: 0.59,
      totalSources: 2,
    });

    const verdict = generateVerdict(claim, evidence);

    expect(verdict.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(verdict.confidence).toBeGreaterThan(0.1);
    expect(verdict.confidence).toBeLessThan(0.5);
  });

  it('returns SUPPORTED at supported threshold boundary', () => {
    const evidence = buildAggregatedEvidence({
      supporting: [buildEvidence('SUPPORTS'), buildEvidence('SUPPORTS', 0.75)],
      consensusScore: 0.6,
      totalSources: 2,
    });

    const verdict = generateVerdict(claim, evidence);

    expect(verdict.verdict).toBe('SUPPORTED');
    expect(verdict.confidence).toBeGreaterThan(0.6);
  });

  it('returns FALSE at false threshold boundary', () => {
    const evidence = buildAggregatedEvidence({
      contradicting: [buildEvidence('CONTRADICTS'), buildEvidence('CONTRADICTS', 0.75)],
      consensusScore: -0.6,
      totalSources: 2,
    });

    const verdict = generateVerdict(claim, evidence);

    expect(verdict.verdict).toBe('FALSE');
  });

  it('returns MISLEADING when support and contradiction are mixed', () => {
    const evidence = buildAggregatedEvidence({
      supporting: [buildEvidence('SUPPORTS')],
      contradicting: [buildEvidence('CONTRADICTS')],
      consensusScore: 0.1,
      totalSources: 2,
    });

    const verdict = generateVerdict(claim, evidence);

    expect(verdict.verdict).toBe('MISLEADING');
  });
});
