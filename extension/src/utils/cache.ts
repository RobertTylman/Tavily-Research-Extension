/**
 * Caching Utilities
 *
 * Stores recent research verdicts keyed by normalized claim text so repeated
 * fact-checks don't trigger another Tavily research run.
 */

import { Claim, ProviderKind, ProviderMode, Verdict } from '../lib/types';

export interface CachedVerification {
  claim: Claim;
  verdict: Verdict;
  timestamp: number;
  provider?: ProviderKind;
  providerMode?: ProviderMode;
}

interface CacheData {
  verifications: CachedVerification[];
  maxAge: number;
}

const CACHE_KEY = 'factCheckerCache';
const DEFAULT_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 100;

/**
 * Get all cached verifications (expired entries filtered out).
 */
export async function getCachedVerifications(): Promise<CachedVerification[]> {
  const result = await chrome.storage.local.get(CACHE_KEY);
  const cache: CacheData = result[CACHE_KEY] || { verifications: [], maxAge: DEFAULT_MAX_AGE };

  const now = Date.now();
  return cache.verifications.filter((v) => now - v.timestamp < cache.maxAge);
}

/**
 * Check if a claim has been verified recently.
 */
export async function getCachedVerdict(
  claimText: string,
  provider?: ProviderKind,
  providerMode?: ProviderMode
): Promise<CachedVerification | null> {
  const verifications = await getCachedVerifications();
  const normalizedClaim = normalizeClaimText(claimText);

  const match = verifications.find(
    (v) =>
      (provider ? v.provider === provider : true) &&
      (providerMode ? v.providerMode === providerMode : true) &&
      (normalizeClaimText(v.claim.text) === normalizedClaim ||
        normalizeClaimText(v.claim.originalText) === normalizedClaim)
  );

  return match || null;
}

/**
 * Store a verification result in cache.
 */
export async function cacheVerification(claim: Claim, verdict: Verdict): Promise<void> {
  const verifications = await getCachedVerifications();

  const newEntry: CachedVerification = {
    claim,
    verdict,
    timestamp: Date.now(),
    provider: verdict.provider,
    providerMode: verdict.providerMode,
  };

  const normalizedClaim = normalizeClaimText(claim.text);
  const filtered = verifications.filter(
    (v) =>
      !(
        normalizeClaimText(v.claim.text) === normalizedClaim &&
        v.provider === verdict.provider &&
        v.providerMode === verdict.providerMode
      )
  );

  filtered.unshift(newEntry);

  const trimmed = filtered.slice(0, MAX_CACHE_SIZE);

  await chrome.storage.local.set({
    [CACHE_KEY]: {
      verifications: trimmed,
      maxAge: DEFAULT_MAX_AGE,
    },
  });
}

/**
 * Clear all cached verifications.
 */
export async function clearCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY);
}

/**
 * Get verification history (for display in UI).
 */
export async function getVerificationHistory(limit = 20): Promise<CachedVerification[]> {
  const verifications = await getCachedVerifications();
  return verifications.slice(0, limit);
}

function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
