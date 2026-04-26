/**
 * Verdict display helpers.
 *
 * The actual verdict is produced by the Tavily research agent and returned
 * directly from `researchClaim` in `tavily.ts`. This module only contains
 * presentation helpers used by UI components.
 */

import { VerdictLabel } from './types';

export function getVerdictColor(verdict: VerdictLabel): string {
  switch (verdict) {
    case 'SUPPORTED':
      return '#22c55e';
    case 'FALSE':
      return '#ef4444';
    case 'MISLEADING':
      return '#f97316';
    case 'INSUFFICIENT_EVIDENCE':
    default:
      return '#6b7280';
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
