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
import { extractPage, ExtractedPage } from '../lib/extract';
import { extractClaims, LLMError } from '../lib/llm';
import {
  checkRateLimit,
  recordRequest,
  getRemainingRequests,
  RateLimitError,
} from '../utils/rateLimiter';
import { storage } from '../utils/messaging';
import { getCachedVerdict, cacheVerification } from '../utils/cache';
import { Claim, ExtensionMessage, PageClaim, PageFactCheckProgress, Verdict } from '../lib/types';

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

    case 'SET_LLM_API_KEY':
      await storage.setLlmApiKey(message.provider, message.apiKey);
      return { success: true };

    case 'GET_LLM_API_KEY_STATUS': {
      const status = await storage.getLlmKeyStatus();
      return { status };
    }

    case 'FACT_CHECK_PAGE':
      // Kick off in background — popup subscribes to broadcast events.
      void factCheckCurrentPage();
      return { started: true };

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
    await storage.resetCreditsUsed();
    await storage.resetLlmTokensUsed();

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
        void storage.addCreditsUsed(1);

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
// PAGE FACT CHECKER PIPELINE
// ============================================================================

const RESEARCH_CONCURRENCY = 3;

async function factCheckCurrentPage(): Promise<void> {
  let activeTabId: number | undefined;

  try {
    await storage.resetCreditsUsed();
    await storage.resetLlmTokensUsed();

    const apiKey = await storage.getApiKey();
    if (!apiKey) {
      broadcastPageError('No Tavily API key configured. Add one in settings first.');
      return;
    }

    const settings = await storage.getResearchSettings();
    const llmKey = await storage.getLlmApiKey(settings.llmProvider);
    if (!llmKey) {
      broadcastPageError(
        `No ${settings.llmProvider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key configured. Add one in settings to use the page fact checker.`
      );
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.id) {
      broadcastPageError('Could not detect the active tab.');
      return;
    }
    activeTabId = tab.id;

    if (!/^https?:/i.test(tab.url)) {
      broadcastPageError('The current page is not a public web page (only http/https supported).');
      return;
    }

    // Clear any prior annotations before starting a new pass.
    sendToTab(activeTabId, { type: 'CLEAR_ANNOTATIONS' });

    broadcastPageProgress({
      stage: 'extracting',
      message: 'Tavily /extracting…',
    });

    let extracted: ExtractedPage;
    try {
      extracted = await extractPage(tab.url, apiKey);
    } catch (error) {
      console.warn(
        '[Background] Tavily extraction failed, falling back to local DOM extraction:',
        error
      );
      broadcastPageProgress({
        stage: 'extracting',
        message: 'Tavily extraction failed. Using local page content instead…',
      });

      const response = await sendToTab(activeTabId, { type: 'GET_ARTICLE_TEXT' });
      if (!response || !response.text) {
        throw error; // If even local extraction fails, rethrow the original error
      }

      extracted = {
        url: response.url || tab.url,
        title: response.title || tab.title || '',
        content: response.text,
      };
    }

    broadcastPageProgress({
      stage: 'identifying-claims',
      message: `Asking ${settings.llmProvider === 'anthropic' ? 'Claude' : 'GPT'} to find check-worthy claims…`,
    });

    const claims = await extractClaims(extracted.content, {
      provider: settings.llmProvider,
      apiKey: llmKey,
      maxClaims: settings.maxClaimsPerPage,
      onUsage: (tokens) => {
        void storage.addLlmTokensUsed(tokens);
      },
    });

    if (claims.length === 0) {
      broadcastPageProgress({
        stage: 'complete',
        message: 'No check-worthy factual claims found on this page.',
        claimsTotal: 0,
        claimsCompleted: 0,
      });
      broadcast({ type: 'FACT_CHECK_PAGE_DONE' });
      return;
    }

    broadcast({ type: 'FACT_CHECK_PAGE_CLAIMS', claims });
    broadcastPageProgress({
      stage: 'researching',
      message: `Researching ${claims.length} claim${claims.length === 1 ? '' : 's'}…`,
      claimsTotal: claims.length,
      claimsCompleted: 0,
    });

    let completed = 0;
    await runWithConcurrency(claims, RESEARCH_CONCURRENCY, async (pageClaim) => {
      const verdict = await researchSinglePageClaim(pageClaim, apiKey, settings);
      completed++;

      broadcast({ type: 'FACT_CHECK_PAGE_VERDICT', claim: pageClaim, verdict });
      if (activeTabId !== undefined) {
        sendToTab(activeTabId, { type: 'ANNOTATE_CLAIM', claim: pageClaim, verdict });
      }

      broadcastPageProgress({
        stage: 'researching',
        message: `Researched ${completed}/${claims.length} claim${claims.length === 1 ? '' : 's'}…`,
        claimsTotal: claims.length,
        claimsCompleted: completed,
      });
    });

    broadcastPageProgress({
      stage: 'complete',
      message: `Done — ${claims.length} claim${claims.length === 1 ? '' : 's'} checked.`,
      claimsTotal: claims.length,
      claimsCompleted: claims.length,
    });
    broadcast({ type: 'FACT_CHECK_PAGE_DONE' });
  } catch (error) {
    console.error('[Background] factCheckCurrentPage failed:', error);
    if (error instanceof TavilyError) {
      broadcastPageError(`Tavily error [${error.statusCode}]: ${error.message}`);
    } else if (error instanceof LLMError) {
      broadcastPageError(`LLM error (${error.provider}): ${error.message}`);
    } else {
      broadcastPageError(error instanceof Error ? error.message : 'Unknown error.');
    }
  }
}

async function researchSinglePageClaim(
  pageClaim: PageClaim,
  apiKey: string,
  settings: Awaited<ReturnType<typeof storage.getResearchSettings>>
): Promise<Verdict> {
  const claim: Claim = {
    id: pageClaim.id,
    text: pageClaim.text,
    originalText: pageClaim.originalSentence,
  };

  try {
    const cached = await getCachedVerdict(claim.text);
    if (cached) {
      return { ...cached.verdict, claimId: claim.id };
    }

    checkRateLimit();

    const verdict = await researchClaim(claim, apiKey, {
      model: settings.model,
      citationFormat: settings.citationFormat,
    });
    recordRequest();
    void storage.addCreditsUsed(1);

    const shouldCacheVerdict = !(
      verdict.verdict === 'INSUFFICIENT_EVIDENCE' && verdict.confidence <= 0.2
    );
    if (shouldCacheVerdict) {
      await cacheVerification(claim, verdict);
    }

    return verdict;
  } catch (error) {
    let explanation: string;
    if (error instanceof RateLimitError) {
      explanation = `Rate limited. Wait ${error.waitSeconds}s before re-running.`;
    } else if (error instanceof TavilyError) {
      explanation = `Research failed [${error.statusCode}]: ${error.message}`;
    } else {
      explanation = error instanceof Error ? error.message : 'Research failed.';
    }
    return {
      claimId: claim.id,
      verdict: 'INSUFFICIENT_EVIDENCE',
      confidence: 0,
      explanation,
      citations: [],
    };
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const advance = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        await worker(items[idx]);
      } catch (error) {
        console.error('[Background] research worker failed:', error);
      }
    }
  };
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    runners.push(advance());
  }
  await Promise.all(runners);
}

function broadcast(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may be closed — broadcasts are best-effort.
  });
}

function broadcastPageProgress(progress: PageFactCheckProgress): void {
  broadcast({ type: 'FACT_CHECK_PAGE_PROGRESS', progress });
}

function broadcastPageError(error: string): void {
  broadcast({ type: 'FACT_CHECK_PAGE_ERROR', error });
}

function sendToTab(tabId: number, message: ExtensionMessage): Promise<any> {
  return chrome.tabs.sendMessage(tabId, message).catch((err) => {
    console.warn('[Background] sendToTab failed:', err);
    return null;
  });
}

// ============================================================================
// STARTUP
// ============================================================================

console.log('[Background] Service worker started');
console.log(`[Background] Rate limit: ${getRemainingRequests()} requests remaining`);
