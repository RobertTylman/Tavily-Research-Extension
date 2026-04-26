/**
 * Background Service Worker
 *
 * Drives the fact-check pipeline. The heavy lifting (multi-source search,
 * report generation, verdict, confidence) is delegated to Tavily's `/research`
 * endpoint; this worker only has to extract claims and fan research tasks out
 * per claim.
 *
 * Security:
 * - API key is stored in chrome.storage.local.
 * - All research API calls happen in this worker, never in page context.
 */

import { researchClaim, TavilyError } from '../lib/tavily';
import {
  checkRateLimit,
  recordRequest,
  getRemainingRequests,
  RateLimitError,
} from '../utils/rateLimiter';
import { storage } from '../utils/messaging';
import { getCachedVerdict, cacheVerification } from '../utils/cache';
import { Claim, Verdict, ExtensionMessage } from '../lib/types';

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error('Background worker error:', error);
      sendResponse({ error: error.message });
    });

  return true;
});

async function handleMessage(
  message: ExtensionMessage,
  _sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (message.type) {
    case 'VERIFY_TEXT':
      return await verifyText(message.text);

    case 'SET_API_KEY':
      await storage.setApiKey(message.apiKey);
      return { success: true };

    case 'GET_API_KEY': {
      const hasKey = await storage.hasApiKey();
      return { hasKey };
    }

    case 'GET_RESEARCH_SETTINGS': {
      const settings = await storage.getResearchSettings();
      return { settings };
    }

    case 'SET_RESEARCH_SETTINGS':
      await storage.setResearchSettings(message.settings);
      return { success: true };

    default:
      return { error: 'Unknown message type' };
  }
}

// ============================================================================
// VERIFICATION PIPELINE
// ============================================================================

async function verifyText(text: string): Promise<{
  claims: Claim[];
  verdicts: Verdict[];
  error?: string;
}> {
  try {
    const apiKey = await storage.getApiKey();
    if (!apiKey) {
      return {
        claims: [],
        verdicts: [],
        error: 'No API key configured. Please add your Tavily API key in settings.',
      };
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return {
        claims: [],
        verdicts: [],
        error: 'Please enter some text to fact-check.',
      };
    }

    const researchSettings = await storage.getResearchSettings();

    const claim: Claim = {
      id: `claim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      text: trimmed,
      originalText: trimmed,
    };
    const allClaims: Claim[] = [claim];

    const verdicts: Verdict[] = [];

    for (const claim of allClaims) {
      try {
        const cached = await getCachedVerdict(claim.text);
        if (cached) {
          console.log(`[Background] Cache hit for claim: "${claim.text.substring(0, 50)}..."`);
          verdicts.push({
            ...cached.verdict,
            claimId: claim.id,
          });
          continue;
        }

        checkRateLimit();

        console.log(`[Background] Researching claim: "${claim.text.substring(0, 50)}..."`);

        const verdict = await researchClaim(claim, apiKey, {
          model: researchSettings.model,
          citationFormat: researchSettings.citationFormat,
          onStatus: (status) => {
            chrome.runtime
              .sendMessage({
                type: 'RESEARCH_STATUS',
                claimId: claim.id,
                status,
              })
              .catch(() => {
                // Popup is closed — broadcasts have no listener; safe to ignore.
              });
          },
        });
        recordRequest();

        verdicts.push(verdict);

        const shouldCacheVerdict = !(
          verdict.verdict === 'INSUFFICIENT_EVIDENCE' && verdict.confidence <= 0.2
        );
        if (shouldCacheVerdict) {
          await cacheVerification(claim, verdict);
        }

        console.log(`[Background] Verdict: ${verdict.verdict} (${verdict.confidence})`);
      } catch (error) {
        if (error instanceof RateLimitError) {
          console.warn('[Background] Rate limited, skipping remaining claims');
          verdicts.push({
            claimId: claim.id,
            verdict: 'INSUFFICIENT_EVIDENCE',
            confidence: 0,
            explanation: `Rate limited. Please wait ${error.waitSeconds} seconds before trying again.`,
            citations: [],
          });
        } else if (error instanceof TavilyError) {
          console.error(
            '[Background] Tavily research error:',
            error.statusCode,
            error.message,
            error.responseBody
          );
          const baseExplanation = error.isAuthError()
            ? 'API authentication failed. Please check your Tavily API key.'
            : error.isTimeout()
              ? 'Research task timed out before finishing. Please try again in a moment.'
              : 'Research failed.';
          const detail = `[${error.statusCode}] ${error.message}${
            error.responseBody ? ` — ${error.responseBody.slice(0, 500)}` : ''
          }`;
          verdicts.push({
            claimId: claim.id,
            verdict: 'INSUFFICIENT_EVIDENCE',
            confidence: 0,
            explanation: `${baseExplanation} ${detail}`,
            citations: [],
          });
        } else {
          throw error;
        }
      }
    }

    return {
      claims: allClaims,
      verdicts,
    };
  } catch (error) {
    console.error('[Background] Verification failed:', error);
    return {
      claims: [],
      verdicts: [],
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

// ============================================================================
// CONTEXT MENU
// ============================================================================

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'fact-check-selection',
    title: 'Search Selection',
    contexts: ['selection'],
  });

  console.log('[Background] Extension installed, context menu created');
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'fact-check-selection' && info.selectionText) {
    console.log(
      '[Background] Context menu clicked, selected text:',
      info.selectionText.substring(0, 50)
    );

    await chrome.storage.session.set({
      pendingVerification: {
        text: info.selectionText,
        tabId: tab?.id,
        timestamp: Date.now(),
      },
    });

    try {
      await chrome.action.openPopup();
      console.log('[Background] Popup opened successfully');
    } catch (error) {
      console.log('[Background] Could not open popup programmatically:', error);
      chrome.windows.create({
        url: chrome.runtime.getURL('popup.html'),
        type: 'popup',
        width: 400,
        height: 600,
        focused: true,
      });
    }
  }
});

// ============================================================================
// STARTUP
// ============================================================================

console.log('[Background] Service worker started');
console.log(`[Background] Rate limit: ${getRemainingRequests()} requests remaining`);
