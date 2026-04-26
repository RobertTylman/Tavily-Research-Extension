/**
 * Chrome Extension Messaging Utilities
 *
 * Provides type-safe wrappers for Chrome extension message passing.
 * Handles communication between popup, content script, and background worker.
 */

import { ExtensionMessage, ResearchSettings } from '../lib/types';

const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  model: 'mini',
  citationFormat: 'numbered',
};

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
    const result = await chrome.storage.local.get('tavilyApiKey');
    return result.tavilyApiKey || null;
  },

  /**
   * Store the API key
   */
  async setApiKey(apiKey: string): Promise<void> {
    await chrome.storage.local.set({ tavilyApiKey: apiKey });
  },

  /**
   * Remove the stored API key
   */
  async removeApiKey(): Promise<void> {
    await chrome.storage.local.remove('tavilyApiKey');
  },

  /**
   * Check if an API key is stored
   */
  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return key !== null && key.length > 0;
  },

  /**
   * Get research settings
   */
  async getResearchSettings(): Promise<ResearchSettings> {
    const result = await chrome.storage.local.get('researchSettings');
    const saved = result.researchSettings as Partial<ResearchSettings> | undefined;
    return {
      ...DEFAULT_RESEARCH_SETTINGS,
      ...(saved || {}),
    };
  },

  /**
   * Store research settings
   */
  async setResearchSettings(settings: ResearchSettings): Promise<void> {
    await chrome.storage.local.set({ researchSettings: settings });
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
};
