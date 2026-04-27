import { Verdict, VerdictLabel } from './types';

export type TrafficTier = 'green' | 'yellow' | 'red' | 'gray' | 'pending';

/**
 * Categorizes a verdict into one of four "traffic light" tiers based on the
 * label and confidence. Low-confidence results are demoted to yellow.
 */
export function getVerdictTier(verdict?: Verdict): TrafficTier {
  if (!verdict) return 'pending';
  if (verdict.verdict === 'INSUFFICIENT_EVIDENCE') return 'gray';
  if (verdict.verdict === 'MISLEADING') return 'yellow';

  // High confidence results get their primary color; low confidence goes yellow.
  if (verdict.verdict === 'FALSE') return verdict.confidence >= 0.5 ? 'red' : 'yellow';
  if (verdict.verdict === 'SUPPORTED') return verdict.confidence >= 0.5 ? 'green' : 'yellow';

  return 'gray';
}

/**
 * Returns the hex color for a given tier. Matches the CSS variables in styles.css.
 */
export function getTierColor(tier: TrafficTier): string {
  switch (tier) {
    case 'green':
      return '#4caf50';
    case 'red':
      return '#f44336';
    case 'yellow':
      return '#ffc107';
    case 'gray':
      return '#9e9e9e';
    default:
      return '#9e9e9e';
  }
}

export function getVerdictColor(verdict: VerdictLabel): string {
  switch (verdict) {
    case 'SUPPORTED':
      return '#4caf50';
    case 'FALSE':
      return '#f44336';
    case 'MISLEADING':
      return '#ffc107';
    case 'INSUFFICIENT_EVIDENCE':
    default:
      return '#9e9e9e';
  }
}

export function getVerdictShortLabel(verdict: VerdictLabel): string {
  switch (verdict) {
    case 'SUPPORTED':
      return 'True';
    case 'FALSE':
      return 'False';
    case 'MISLEADING':
      return 'Misleading';
    case 'INSUFFICIENT_EVIDENCE':
    default:
      return 'Unverified';
  }
}

export function getVerdictIcon(verdict: VerdictLabel): string {
  switch (verdict) {
    case 'SUPPORTED':
      return '✓';
    case 'FALSE':
      return '✗';
    case 'MISLEADING':
      return '⚠';
    case 'INSUFFICIENT_EVIDENCE':
    default:
      return '?';
  }
}
