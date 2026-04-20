/**
 * Caching Utilities
 *
 * Stores verified claims to avoid redundant API calls
 * and provide verification history.
 */

import { Claim, EntailmentResult, Verdict } from '../lib/types';

export interface CachedVerification {
  claim: Claim;
  verdict: Verdict;
  timestamp: number;
  searchQueries: string[];
}

interface CacheData {
  verifications: CachedVerification[];
  maxAge: number; // Cache expiry in milliseconds (default 24 hours)
}

const CACHE_KEY = 'factCheckerCache';
const ENTAILMENT_CACHE_KEY = 'factCheckerEntailmentCache';
const DEFAULT_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 100; // Maximum cached verifications
const MAX_ENTAILMENT_CACHE_SIZE = 500;

interface CachedEntailment {
  claimKey: string;
  url: string;
  result: EntailmentResult;
  timestamp: number;
}

interface EntailmentCacheData {
  entries: CachedEntailment[];
  maxAge: number;
}

/**
 * Get all cached verifications
 */
export async function getCachedVerifications(): Promise<CachedVerification[]> {
  const result = await chrome.storage.local.get(CACHE_KEY);
  const cache: CacheData = result[CACHE_KEY] || { verifications: [], maxAge: DEFAULT_MAX_AGE };

  // Filter out expired entries
  const now = Date.now();
  return cache.verifications.filter((v) => now - v.timestamp < cache.maxAge);
}

/**
 * Check if a claim has been verified recently
 */
export async function getCachedVerdict(claimText: string): Promise<CachedVerification | null> {
  const verifications = await getCachedVerifications();
  const normalizedClaim = normalizeClaimText(claimText);

  // Find matching claim in cache
  const match = verifications.find(
    (v) =>
      normalizeClaimText(v.claim.text) === normalizedClaim ||
      normalizeClaimText(v.claim.originalText) === normalizedClaim
  );

  return match || null;
}

/**
 * Store a verification result in cache
 */
export async function cacheVerification(
  claim: Claim,
  verdict: Verdict,
  searchQueries: string[]
): Promise<void> {
  const verifications = await getCachedVerifications();

  const newEntry: CachedVerification = {
    claim,
    verdict,
    timestamp: Date.now(),
    searchQueries,
  };

  // Remove any existing entry for same claim
  const normalizedClaim = normalizeClaimText(claim.text);
  const filtered = verifications.filter(
    (v) => normalizeClaimText(v.claim.text) !== normalizedClaim
  );

  // Add new entry at the beginning
  filtered.unshift(newEntry);

  // Limit cache size
  const trimmed = filtered.slice(0, MAX_CACHE_SIZE);

  await chrome.storage.local.set({
    [CACHE_KEY]: {
      verifications: trimmed,
      maxAge: DEFAULT_MAX_AGE,
    },
  });
}

/**
 * Clear all cached verifications
 */
export async function clearCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY);
}

/**
 * Get verification history (for display in UI)
 */
export async function getVerificationHistory(limit = 20): Promise<CachedVerification[]> {
  const verifications = await getCachedVerifications();
  return verifications.slice(0, limit);
}

/**
 * Normalize claim text for comparison
 * Handles minor variations in wording
 */
function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

function buildEntailmentKey(claimText: string): string {
  return normalizeClaimText(claimText);
}

export async function getCachedEntailment(
  claimText: string,
  url: string
): Promise<EntailmentResult | null> {
  const result = await chrome.storage.local.get(ENTAILMENT_CACHE_KEY);
  const cache: EntailmentCacheData = result[ENTAILMENT_CACHE_KEY] || {
    entries: [],
    maxAge: DEFAULT_MAX_AGE,
  };

  const now = Date.now();
  const claimKey = buildEntailmentKey(claimText);
  const match = cache.entries.find(
    (entry) =>
      entry.claimKey === claimKey && entry.url === url && now - entry.timestamp < cache.maxAge
  );

  return match ? match.result : null;
}

export async function cacheEntailment(
  claimText: string,
  url: string,
  result: EntailmentResult
): Promise<void> {
  const response = await chrome.storage.local.get(ENTAILMENT_CACHE_KEY);
  const cache: EntailmentCacheData = response[ENTAILMENT_CACHE_KEY] || {
    entries: [],
    maxAge: DEFAULT_MAX_AGE,
  };

  const claimKey = buildEntailmentKey(claimText);
  const filtered = cache.entries.filter(
    (entry) => !(entry.claimKey === claimKey && entry.url === url)
  );

  filtered.unshift({
    claimKey,
    url,
    result,
    timestamp: Date.now(),
  });

  await chrome.storage.local.set({
    [ENTAILMENT_CACHE_KEY]: {
      entries: filtered.slice(0, MAX_ENTAILMENT_CACHE_SIZE),
      maxAge: cache.maxAge || DEFAULT_MAX_AGE,
    },
  });
}
