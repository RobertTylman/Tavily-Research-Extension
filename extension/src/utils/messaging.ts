/**
 * Chrome Extension Messaging Utilities
 *
 * Provides type-safe wrappers for Chrome extension message passing.
 * Handles communication between popup, content script, and background worker.
 */

import {
  ExtensionMessage,
  ExtractProviderKind,
  LLMProvider,
  ProviderApiKeys,
  ProviderKeyStatus,
  ProviderKind,
  ProviderMode,
  ResearchProviderKind,
  ResearchSettings,
} from '../lib/types';

const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  researchProvider: 'tavily',
  providerMode: 'tavily_research',
  pageExtractionProvider: 'tavily',
  model: 'mini',
  citationFormat: 'numbered',
  llmProvider: 'anthropic',
  maxClaimsPerPage: 8,
  showCreditUsage: true,
};

export const MAX_CLAIMS_MIN = 1;
export const MAX_CLAIMS_MAX = 15;

const LLM_KEY_STORAGE: Record<LLMProvider, string> = {
  anthropic: 'anthropicApiKey',
  openai: 'openaiApiKey',
};

const PROVIDER_KEY_STORAGE: Record<ProviderKind, keyof ProviderApiKeys> = {
  tavily: 'tavily',
  exa: 'exa',
  brave: 'brave',
  firecrawl: 'firecrawl',
  parallel: 'parallel',
};

export const DEFAULT_PROVIDER_MODE: Record<ResearchProviderKind, ProviderMode> = {
  tavily: 'tavily_research',
  exa: 'exa_search_structured',
  brave: 'brave_context_plus_judge',
  firecrawl: 'firecrawl_search_plus_judge',
  parallel: 'parallel_task_run',
};

export const EXTRACTION_PROVIDER_OPTIONS: ExtractProviderKind[] = ['tavily', 'exa', 'firecrawl'];
export const RESEARCH_PROVIDER_OPTIONS: ResearchProviderKind[] = [
  'tavily',
  'exa',
  'brave',
  'firecrawl',
  'parallel',
];

function normalizeResearchSettings(settings: ResearchSettings): ResearchSettings {
  const providerMode = isModeCompatible(settings.researchProvider, settings.providerMode)
    ? settings.providerMode
    : DEFAULT_PROVIDER_MODE[settings.researchProvider];

  return {
    ...settings,
    providerMode,
    pageExtractionProvider: EXTRACTION_PROVIDER_OPTIONS.includes(settings.pageExtractionProvider)
      ? settings.pageExtractionProvider
      : 'tavily',
    maxClaimsPerPage: Math.max(
      MAX_CLAIMS_MIN,
      Math.min(MAX_CLAIMS_MAX, Math.round(settings.maxClaimsPerPage))
    ),
  };
}

export function isModeCompatible(provider: ResearchProviderKind, mode: ProviderMode): boolean {
  switch (provider) {
    case 'tavily':
      return mode === 'tavily_research';
    case 'exa':
      return mode === 'exa_search_structured' || mode === 'exa_research_async';
    case 'brave':
      return mode === 'brave_context_plus_judge' || mode === 'brave_answers_native';
    case 'firecrawl':
      return mode === 'firecrawl_search_plus_judge';
    case 'parallel':
      return mode === 'parallel_task_run';
    default:
      return false;
  }
}

/**
 * Send a message to the background service worker
 *
 * @param message - The message to send
 * @returns Promise that resolves with the response
 */
export async function sendToBackground<T = unknown>(message: ExtensionMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response as T);
      }
    });
  });
}

/**
 * Send a message to the active tab's content script
 *
 * @param message - The message to send
 * @returns Promise that resolves with the response
 */
export async function sendToContentScript<T = unknown>(message: ExtensionMessage): Promise<T> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error('No active tab found');
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id!, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response as T);
      }
    });
  });
}

/**
 * Register a message handler in the background worker or content script
 *
 * @param handler - Function to handle incoming messages
 */
export function onMessage(
  handler: (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => boolean | void
): void {
  chrome.runtime.onMessage.addListener(handler);
}

/**
 * Storage utilities for API key management
 */
export const storage = {
  /**
   * Get the stored API key
   */
  async getApiKey(): Promise<string | null> {
    return this.getProviderKey('tavily');
  },

  /**
   * Store the API key
   */
  async setApiKey(apiKey: string): Promise<void> {
    await this.setProviderKey('tavily', apiKey);
  },

  /**
   * Remove the stored API key
   */
  async removeApiKey(): Promise<void> {
    await this.removeProviderKey('tavily');
  },

  /**
   * Check if an API key is stored
   */
  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return key !== null && key.length > 0;
  },

  async getProviderKeys(): Promise<ProviderApiKeys> {
    const result = await chrome.storage.local.get('providerKeys');
    const saved = result.providerKeys as ProviderApiKeys | undefined;
    return saved || {};
  },

  async getProviderKey(provider: ProviderKind): Promise<string | null> {
    const keys = await this.getProviderKeys();
    const value = keys[PROVIDER_KEY_STORAGE[provider]];
    return typeof value === 'string' && value.length > 0 ? value : null;
  },

  async setProviderKey(provider: ProviderKind, apiKey: string): Promise<void> {
    const keys = await this.getProviderKeys();
    await chrome.storage.local.set({
      providerKeys: {
        ...keys,
        [PROVIDER_KEY_STORAGE[provider]]: apiKey,
      },
    });
  },

  async removeProviderKey(provider: ProviderKind): Promise<void> {
    const keys = await this.getProviderKeys();
    const next = { ...keys };
    delete next[PROVIDER_KEY_STORAGE[provider]];
    await chrome.storage.local.set({ providerKeys: next });
  },

  async getProviderKeyStatus(): Promise<ProviderKeyStatus> {
    const keys = await this.getProviderKeys();
    return {
      tavily: typeof keys.tavily === 'string' && keys.tavily.length > 0,
      exa: typeof keys.exa === 'string' && keys.exa.length > 0,
      brave: typeof keys.brave === 'string' && keys.brave.length > 0,
      firecrawl: typeof keys.firecrawl === 'string' && keys.firecrawl.length > 0,
      parallel: typeof keys.parallel === 'string' && keys.parallel.length > 0,
    };
  },

  /**
   * Get research settings
   */
  async getResearchSettings(): Promise<ResearchSettings> {
    const result = await chrome.storage.local.get('researchSettings');
    const saved = result.researchSettings as Partial<ResearchSettings> | undefined;
    return normalizeResearchSettings({
      ...DEFAULT_RESEARCH_SETTINGS,
      ...(saved || {}),
    } as ResearchSettings);
  },

  /**
   * Store research settings
   */
  async setResearchSettings(settings: ResearchSettings): Promise<void> {
    const clamped = normalizeResearchSettings(settings);
    await chrome.storage.local.set({ researchSettings: clamped });
  },

  async getLlmApiKey(provider: LLMProvider): Promise<string | null> {
    const key = LLM_KEY_STORAGE[provider];
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  },

  async setLlmApiKey(provider: LLMProvider, apiKey: string): Promise<void> {
    await chrome.storage.local.set({ [LLM_KEY_STORAGE[provider]]: apiKey });
  },

  async removeLlmApiKey(provider: LLMProvider): Promise<void> {
    await chrome.storage.local.remove(LLM_KEY_STORAGE[provider]);
  },

  async getLlmKeyStatus(): Promise<{ anthropic: boolean; openai: boolean }> {
    const [anthropic, openai] = await Promise.all([
      this.getLlmApiKey('anthropic'),
      this.getLlmApiKey('openai'),
    ]);
    return {
      anthropic: anthropic !== null,
      openai: openai !== null,
    };
  },

  /**
   * Read the running estimate of Tavily credits consumed by this extension.
   */
  async getCreditsUsed(): Promise<number> {
    const result = await chrome.storage.local.get('creditsUsed');
    const value = result.creditsUsed;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  },

  /**
   * Add to the credit counter and return the new total.
   */
  async addCreditsUsed(amount: number): Promise<number> {
    const current = await this.getCreditsUsed();
    const next = current + Math.max(0, Math.round(amount));
    await chrome.storage.local.set({ creditsUsed: next });
    return next;
  },

  /**
   * Reset the credit counter back to zero.
   */
  async resetCreditsUsed(): Promise<void> {
    await chrome.storage.local.set({ creditsUsed: 0 });
  },

  /**
   * Read the running estimate of LLM tokens consumed.
   */
  async getLlmTokensUsed(): Promise<number> {
    const result = await chrome.storage.local.get('llmTokensUsed');
    const value = result.llmTokensUsed;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  },

  /**
   * Add to the LLM token counter and return the new total.
   */
  async addLlmTokensUsed(amount: number): Promise<number> {
    const current = await this.getLlmTokensUsed();
    const next = current + Math.max(0, Math.round(amount));
    await chrome.storage.local.set({ llmTokensUsed: next });
    return next;
  },

  /**
   * Reset the LLM token counter back to zero.
   */
  async resetLlmTokensUsed(): Promise<void> {
    await chrome.storage.local.set({ llmTokensUsed: 0 });
  },
};
