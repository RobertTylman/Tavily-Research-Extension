/**
 * Background Service Worker
 *
 * Drives the fact-check pipeline. The heavy lifting (multi-source search,
 * report generation, verdict, confidence) is delegated to provider adapters;
 * this worker orchestrates provider selection, claim extraction, caching, and
 * evaluation artifact logging.
 *
 * Security:
 * - API key is stored in chrome.storage.local.
 * - All research API calls happen in this worker, never in page context.
 */

import { TavilyError } from '../lib/tavily';
import { ExtractedPage } from '../lib/extract';
import { extractClaims, LLMError } from '../lib/llm';
import {
  extractPageWithProvider,
  ProviderError,
  researchClaimWithProvider,
} from '../lib/providers';
import {
  checkRateLimit,
  recordRequest,
  getRemainingRequests,
  RateLimitError,
} from '../utils/rateLimiter';
import { storage } from '../utils/messaging';
import { getCachedVerdict, cacheVerification } from '../utils/cache';
import { logEvaluationArtifact } from '../utils/evalArtifacts';
import {
  Claim,
  ExtensionMessage,
  PageClaim,
  PageFactCheckProgress,
  ResearchProviderKind,
  Verdict,
} from '../lib/types';

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
      const settings = await storage.getResearchSettings();
      const activeProviderKey = await storage.getProviderKey(settings.researchProvider);
      const hasKey = typeof activeProviderKey === 'string' && activeProviderKey.length > 0;
      return { hasKey };
    }

    case 'SET_PROVIDER_API_KEY':
      await storage.setProviderKey(message.provider, message.apiKey);
      return { success: true };

    case 'GET_PROVIDER_KEY_STATUS': {
      const status = await storage.getProviderKeyStatus();
      return { status };
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

    const researchSettings = await storage.getResearchSettings();
    const apiKey = await storage.getProviderKey(researchSettings.researchProvider);
    if (!apiKey) {
      return {
        claims: [],
        verdicts: [],
        error: `No ${humanizeProvider(researchSettings.researchProvider)} API key configured. Please add one in settings.`,
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

    const claim: Claim = {
      id: `claim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      text: trimmed,
      originalText: trimmed,
    };
    const allClaims: Claim[] = [claim];

    const verdicts: Verdict[] = [];

    for (const claim of allClaims) {
      try {
        const cached = await getCachedVerdict(
          claim.text,
          researchSettings.researchProvider,
          researchSettings.providerMode
        );
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

        const llmKey = requiresJudge(researchSettings.researchProvider, researchSettings.providerMode)
          ? await storage.getLlmApiKey(researchSettings.llmProvider)
          : null;
        if (requiresJudge(researchSettings.researchProvider, researchSettings.providerMode) && !llmKey) {
          throw new Error(
            `${humanizeProvider(researchSettings.researchProvider)} requires an ${researchSettings.llmProvider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key for the shared verdict judge.`
          );
        }

        const verdict = await researchClaimWithProvider(claim, {
          provider: researchSettings.researchProvider,
          providerMode: researchSettings.providerMode,
          apiKey,
          settings: researchSettings,
          llmApiKey: llmKey,
          llmProvider: researchSettings.llmProvider,
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
        await logEvaluationArtifact(claim, verdict, 'success');

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
        } else if (error instanceof TavilyError || error instanceof ProviderError) {
          console.error(
            '[Background] Provider research error:',
            error.statusCode,
            error.message,
            'responseBody' in error ? error.responseBody : ''
          );
          const baseExplanation = error.isAuthError()
            ? 'API authentication failed. Please check the configured provider key.'
            : ('isTimeout' in error && typeof error.isTimeout === 'function' && error.isTimeout())
              ? 'Research task timed out before finishing. Please try again in a moment.'
              : 'Research failed.';
          const detail = `[${error.statusCode}] ${error.message}${
            'responseBody' in error && error.responseBody
              ? ` — ${error.responseBody.slice(0, 500)}`
              : ''
          }`;
          const fallbackVerdict: Verdict = {
            claimId: claim.id,
            verdict: 'INSUFFICIENT_EVIDENCE',
            confidence: 0,
            explanation: `${baseExplanation} ${detail}`,
            citations: [],
            provider: researchSettings.researchProvider,
            providerMode: researchSettings.providerMode,
          };
          verdicts.push(fallbackVerdict);
          await logEvaluationArtifact(claim, fallbackVerdict, 'error', {
            error_type: error.name,
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

    const settings = await storage.getResearchSettings();
    const extractApiKey = await storage.getProviderKey(settings.pageExtractionProvider);
    if (!extractApiKey) {
      broadcastPageError(
        `No ${humanizeProvider(settings.pageExtractionProvider)} API key configured. Add one in settings first.`
      );
      return;
    }

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
      const extraction = await extractPageWithProvider(
        tab.url,
        settings.pageExtractionProvider,
        extractApiKey
      );
      extracted = extraction.page;
    } catch (error) {
      console.warn(
        '[Background] Provider extraction failed, falling back to local DOM extraction:',
        error
      );
      broadcastPageProgress({
        stage: 'extracting',
        message: 'Provider extraction failed. Using local page content instead…',
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
      const verdict = await researchSinglePageClaim(pageClaim, settings);
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
    if (error instanceof TavilyError || error instanceof ProviderError) {
      const provider =
        'provider' in error && typeof error.provider === 'string' ? error.provider : 'tavily';
      broadcastPageError(
        `${humanizeProvider(provider)} error [${error.statusCode}]: ${error.message}`
      );
    } else if (error instanceof LLMError) {
      broadcastPageError(`LLM error (${error.provider}): ${error.message}`);
    } else {
      broadcastPageError(error instanceof Error ? error.message : 'Unknown error.');
    }
  }
}

async function researchSinglePageClaim(
  pageClaim: PageClaim,
  settings: Awaited<ReturnType<typeof storage.getResearchSettings>>
): Promise<Verdict> {
  const claim: Claim = {
    id: pageClaim.id,
    text: pageClaim.text,
    originalText: pageClaim.originalSentence,
  };

  try {
    const cached = await getCachedVerdict(claim.text, settings.researchProvider, settings.providerMode);
    if (cached) {
      return { ...cached.verdict, claimId: claim.id };
    }

    checkRateLimit();

    const providerKey = await storage.getProviderKey(settings.researchProvider);
    if (!providerKey) {
      throw new Error(`No ${humanizeProvider(settings.researchProvider)} API key configured.`);
    }
    const llmKey = requiresJudge(settings.researchProvider, settings.providerMode)
      ? await storage.getLlmApiKey(settings.llmProvider)
      : null;
    if (requiresJudge(settings.researchProvider, settings.providerMode) && !llmKey) {
      throw new Error(
        `${humanizeProvider(settings.researchProvider)} requires an ${settings.llmProvider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key for the shared verdict judge.`
      );
    }

    const verdict = await researchClaimWithProvider(claim, {
      provider: settings.researchProvider,
      providerMode: settings.providerMode,
      apiKey: providerKey,
      settings,
      llmApiKey: llmKey,
      llmProvider: settings.llmProvider,
    });
    recordRequest();
    void storage.addCreditsUsed(1);
    await logEvaluationArtifact(claim, verdict, 'success');

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
    } else if (error instanceof TavilyError || error instanceof ProviderError) {
      explanation = `Research failed [${error.statusCode}]: ${error.message}`;
    } else {
      explanation = error instanceof Error ? error.message : 'Research failed.';
    }
    const failureVerdict: Verdict = {
      claimId: claim.id,
      verdict: 'INSUFFICIENT_EVIDENCE',
      confidence: 0,
      explanation,
      citations: [],
      provider: settings.researchProvider,
      providerMode: settings.providerMode,
    };
    await logEvaluationArtifact(claim, failureVerdict, 'error', {
      error_type: error instanceof Error ? error.name : 'UnknownError',
    });
    return failureVerdict;
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

function humanizeProvider(provider: ResearchProviderKind): string {
  switch (provider) {
    case 'exa':
      return 'Exa';
    case 'brave':
      return 'Brave';
    case 'firecrawl':
      return 'Firecrawl';
    case 'parallel':
      return 'Parallel';
    case 'tavily':
    default:
      return 'Tavily';
  }
}

function requiresJudge(provider: ResearchProviderKind, mode: string): boolean {
  return (
    provider === 'brave' && mode === 'brave_context_plus_judge' ||
    provider === 'firecrawl'
  );
}
