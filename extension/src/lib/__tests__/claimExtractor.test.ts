import { describe, expect, it } from 'vitest';
import {
  classifyClaim,
  extractClaims,
  getFactualClaims,
  rephraseToNeutral,
} from '../claimExtractor';
import { Claim } from '../types';

describe('claimExtractor', () => {
  it('classifies factual, opinion, and prediction claims', () => {
    expect(classifyClaim('Water boils at 100 degrees Celsius.')).toBe('FACTUAL');
    expect(classifyClaim('I think this is the best coffee in town.')).toBe('OPINION');
    expect(classifyClaim('AI will become fully autonomous next year.')).toBe('PREDICTION');
  });

  it('rephrases attribution wrappers into neutral form', () => {
    expect(rephraseToNeutral('According to NASA, water exists as ice on Mars')).toBe(
      'Water exists as ice on Mars.'
    );
  });

  it('extracts atomic claims from long compound statements', () => {
    const text = 'The Eiffel Tower is in Paris and the Statue of Liberty is in New York City.';

    const claims = extractClaims(text);
    const originalClaims = claims.map((claim) => claim.originalText);

    expect(claims).toHaveLength(2);
    expect(originalClaims).toContain('The Eiffel Tower is in Paris');
    expect(originalClaims).toContain('the Statue of Liberty is in New York City.');
  });

  it('skips rhetorical questions and keeps factual claims', () => {
    const claims = extractClaims('Who cares? The moon is a natural satellite of Earth.');

    expect(claims).toHaveLength(1);
    expect(claims[0].originalText).toBe('The moon is a natural satellite of Earth.');
  });

  it('returns factual claims only from mixed classifications', () => {
    const claims: Claim[] = [
      {
        id: 'c1',
        text: 'Water boils at 100 degrees Celsius.',
        originalText: 'Water boils at 100 degrees Celsius.',
        classification: 'FACTUAL',
      },
      {
        id: 'c2',
        text: 'Pizza is the best food.',
        originalText: 'Pizza is the best food.',
        classification: 'OPINION',
      },
    ];

    expect(getFactualClaims(claims)).toEqual([claims[0]]);
  });
});
