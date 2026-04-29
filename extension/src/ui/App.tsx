/**
 * Main App Component
 *
 * Root component for the fact-checking extension popup.
 * Manages the overall verification flow and state.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Claim,
  ExtensionMessage,
  PageClaim,
  PageFactCheckProgress,
  ResearchSettings,
  ResearchStatus,
  Verdict,
  VerificationState,
} from '../lib/types';
import { sendToBackground, sendToContentScript, storage } from '../utils/messaging';
import { ApiKeyInput } from './components/ApiKeyInput';
import { ClaimCard } from './components/ClaimCard';
import { Header } from './components/Header';
import { getTierColor, getVerdictTier } from '../lib/verdictEngine';
import { Icons } from './icons';
import { CitationList } from './components/CitationList';

/**
 * Main application state
 */
const initialState: VerificationState = {
  status: 'idle',
  progress: 0,
  claims: [],
  verdicts: [],
};

type Theme = 'light' | 'dark';

interface PageCheckEntry {
  claim: PageClaim;
  verdict?: Verdict;
}

interface PageCheckState {
  status: 'idle' | 'running' | 'complete' | 'error';
  progress?: PageFactCheckProgress;
  entries: PageCheckEntry[];
  error?: string;
}

const initialPageCheck: PageCheckState = {
  status: 'idle',
  entries: [],
};

export default function App() {
  const [state, setState] = useState<VerificationState>(initialState);
  const [inputText, setInputText] = useState('');
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [latestStatus, setLatestStatus] = useState<ResearchStatus | null>(null);
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [pageCheck, setPageCheck] = useState<PageCheckState>(initialPageCheck);
  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);

  const [tavilyCredits, setTavilyCredits] = useState<number>(0);
  const [llmTokens, setLlmTokens] = useState<number>(0);
  const [showCreditUsage, setShowCreditUsage] = useState<boolean>(true);
  const [llmProvider, setLlmProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [summaryState, setSummaryState] = useState<'idle' | 'copied' | 'error'>('idle');

  // Theme state initialization
  const [theme, setTheme] = useState<Theme>(() => {
    // Check local storage
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('theme') as Theme;
      if (saved === 'dark' || saved === 'light') return saved;
    }
    // Fallback to system preference
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });

  // Apply theme effect
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    if (document.body) {
      document.body.setAttribute('data-theme', theme);
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  /**
   * PERSISTENCE: Save UI state to session storage whenever it changes.
   * This prevents the extension from resetting if the user clicks out.
   */
  useEffect(() => {
    if (hasApiKey === null) return; // Don't save initial state before load

    chrome.storage.session.set({
      lastUiState: {
        state,
        pageCheck,
        inputText,
        showSettings,
        expandedClaimId,
      },
    });
  }, [state, pageCheck, inputText, showSettings, expandedClaimId, hasApiKey]);

  const handleVerify = useCallback(
    async (text?: string) => {
      const textToVerify = text || inputText;

      if (!textToVerify.trim()) {
        setState((prev) => ({ ...prev, error: 'Please enter some text to verify' }));
        return;
      }

      setLatestStatus(null);
      setState({
        status: 'extracting',
        progress: 10,
        claims: [],
        verdicts: [],
      });

      try {
        // Send to background for verification
        setState((prev) => ({ ...prev, status: 'searching', progress: 30 }));

        const response = await sendToBackground<{
          claims: Claim[];
          verdicts: Verdict[];
          error?: string;
        }>({ type: 'VERIFY_TEXT', text: textToVerify });

        if (response.error) {
          setState({
            status: 'error',
            progress: 0,
            claims: [],
            verdicts: [],
            error: response.error,
          });
          return;
        }

        setState({
          status: 'complete',
          progress: 100,
          claims: response.claims,
          verdicts: response.verdicts,
        });
      } catch (error) {
        setState({
          status: 'error',
          progress: 0,
          claims: [],
          verdicts: [],
          error: error instanceof Error ? error.message : 'Verification failed',
        });
      }
    },
    [inputText]
  );

  const checkApiKey = useCallback(async () => {
    try {
      const response = await sendToBackground<{ hasKey: boolean }>({ type: 'GET_API_KEY' });
      setHasApiKey(response.hasKey);
      if (!response.hasKey) {
        setShowSettings(true);
      }
    } catch (error) {
      console.error('Failed to check API key:', error);
      setHasApiKey(false);
      setShowSettings(true);
    }
  }, []);

  const loadSelectedText = useCallback(async () => {
    try {
      const response = await sendToContentScript<{ text: string | null }>({
        type: 'GET_SELECTED_TEXT',
      });
      if (response.text) {
        setInputText(response.text);
      }
    } catch (error) {
      // Content script might not be loaded yet, ignore
      console.log('Could not get selected text:', error);
    }
  }, []);

  const checkForPendingVerification = useCallback(async () => {
    try {
      const result = await chrome.storage.session.get('pendingVerification');
      if (result.pendingVerification) {
        const { text, timestamp } = result.pendingVerification;
        // Only use if less than 30 seconds old
        if (Date.now() - timestamp < 30000) {
          setInputText(text);
          // Clear the pending verification
          await chrome.storage.session.remove('pendingVerification');
          // Auto-start verification
          handleVerify(text);
        }
      }
    } catch (error) {
      console.error('Failed to check pending verification:', error);
    }
  }, [handleVerify]);

  /**
   * MOUNT: load settings, pending verifications, and restored session state.
   */
  useEffect(() => {
    // 1. Initial configuration checks
    checkApiKey();
    checkForPendingVerification();

    // 2. Load saved session state
    chrome.storage.session.get('lastUiState').then((result) => {
      if (result.lastUiState) {
        const {
          state: savedState,
          pageCheck: savedPageCheck,
          inputText: savedInputText,
          showSettings: savedShowSettings,
          expandedClaimId: savedExpandedClaimId,
        } = result.lastUiState;

        if (savedState) setState(savedState);
        if (savedPageCheck) setPageCheck(savedPageCheck);
        if (savedInputText) setInputText(savedInputText);
        // Only restore settings view if we have an API key
        if (savedShowSettings !== undefined) setShowSettings(savedShowSettings);
        if (savedExpandedClaimId) setExpandedClaimId(savedExpandedClaimId);
      } else {
        // Only load selected text if we don't have a restored session
        loadSelectedText();
      }
    });

    // 3. Load initial usage counts
    chrome.storage.local
      .get(['creditsUsed', 'llmTokensUsed', 'researchSettings'])
      .then((result) => {
        setTavilyCredits(result.creditsUsed || 0);
        setLlmTokens(result.llmTokensUsed || 0);
        setShowCreditUsage(result.researchSettings?.showCreditUsage ?? true);
        setLlmProvider(result.researchSettings?.llmProvider ?? 'anthropic');
      });

    // 4. Listen for realtime usage updates
    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName === 'local') {
        if (changes.creditsUsed) {
          setTavilyCredits(changes.creditsUsed.newValue || 0);
        }
        if (changes.llmTokensUsed) {
          setLlmTokens(changes.llmTokensUsed.newValue || 0);
        }
        if (changes.researchSettings) {
          setShowCreditUsage(changes.researchSettings.newValue?.showCreditUsage ?? true);
          setLlmProvider(changes.researchSettings.newValue?.llmProvider ?? 'anthropic');
        }
      }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, [checkApiKey, checkForPendingVerification, loadSelectedText]);

  // Subscribe to live research status events from the background worker.
  useEffect(() => {
    const handler = (message: ExtensionMessage) => {
      if (message?.type === 'RESEARCH_STATUS') {
        setLatestStatus(message.status);
      } else if (message?.type === 'FACT_CHECK_PAGE_PROGRESS') {
        setPageCheck((prev) => ({
          ...prev,
          status: message.progress.stage === 'complete' ? prev.status : 'running',
          progress: message.progress,
        }));
      } else if (message?.type === 'FACT_CHECK_PAGE_CLAIMS') {
        setPageCheck((prev) => ({
          ...prev,
          status: 'running',
          entries: message.claims.map((claim) => ({ claim })),
        }));
      } else if (message?.type === 'FACT_CHECK_PAGE_VERDICT') {
        setPageCheck((prev) => ({
          ...prev,
          entries: prev.entries.map((entry) =>
            entry.claim.id === message.claim.id ? { ...entry, verdict: message.verdict } : entry
          ),
        }));
      } else if (message?.type === 'FACT_CHECK_PAGE_DONE') {
        setPageCheck((prev) => ({ ...prev, status: 'complete' }));
      } else if (message?.type === 'FACT_CHECK_PAGE_ERROR') {
        setPageCheck((prev) => ({
          ...prev,
          status: 'error',
          progress: undefined,
          error: message.error,
        }));
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const [researchStartTime, setResearchStartTime] = useState<number | null>(null);
  const [displayElapsed, setDisplayElapsed] = useState(0);

  /**
   * Continuous Monotonic Timer Effect:
   * Uses a local startTime reference to calculate elapsed time.
   * This ensures the timer never "jumps" or decreases, even if background
   * messages arrive slightly out of sync.
   */
  useEffect(() => {
    let interval: number;
    const isLoading =
      state.status === 'extracting' || state.status === 'searching' || state.status === 'analyzing';

    if (isLoading) {
      if (!researchStartTime) {
        setResearchStartTime(Date.now());
      }
      interval = window.setInterval(() => {
        if (researchStartTime) {
          setDisplayElapsed(Math.floor((Date.now() - researchStartTime) / 1000));
        }
      }, 100); // High-frequency check for 1s transitions
    } else {
      setResearchStartTime(null);
      setDisplayElapsed(0);
    }

    return () => window.clearInterval(interval);
  }, [state.status, researchStartTime]);

  /**
   * Handle API key save
   */
  const handleApiKeySave = async (apiKey: string) => {
    try {
      await sendToBackground({ type: 'SET_API_KEY', apiKey });
      setHasApiKey(true);
      setShowSettings(false);
    } catch (error) {
      console.error('Failed to save API key:', error);
    }
  };

  /**
   * Save Tavily research settings
   */
  const handleResearchSettingsSave = async (settings: ResearchSettings) => {
    try {
      await sendToBackground({ type: 'SET_RESEARCH_SETTINGS', settings });
    } catch (error) {
      console.error('Failed to save research settings:', error);
    }
  };

  /**
   * Get verdict for a specific claim
   */
  const getVerdictForClaim = (claimId: string): Verdict | undefined => {
    return state.verdicts.find((v) => v.claimId === claimId);
  };

  /**
   * Reset to initial state
   */
  const handleReset = () => {
    setState(initialState);
    setInputText('');
    setLatestStatus(null);
    setShareState('idle');
    void storage.resetCreditsUsed();
    void storage.resetLlmTokensUsed();
  };

  /**
   * Kick off the page-fact-checker pipeline in the background worker.
   */
  const handleFactCheckPage = async () => {
    setPageCheck({
      status: 'running',
      entries: [],
      progress: { stage: 'extracting', message: 'Starting…' },
    });
    try {
      await sendToBackground({ type: 'FACT_CHECK_PAGE' });
    } catch (error) {
      setPageCheck({
        status: 'error',
        entries: [],
        progress: undefined,
        error: error instanceof Error ? error.message : 'Failed to start page fact check.',
      });
    }
  };

  const handleToggleExpand = (id: string) => {
    setExpandedClaimId((prev) => (prev === id ? null : id));
  };

  const handleClearPageCheck = async () => {
    try {
      await sendToContentScript({ type: 'CLEAR_ANNOTATIONS' });
    } catch (error) {
      // Active tab may not have a content script — ignore.
      console.log('Could not clear annotations:', error);
    }
    setPageCheck(initialPageCheck);
    void storage.resetCreditsUsed();
    void storage.resetLlmTokensUsed();
  };

  /**
   * Copy a shareable summary of the results to the clipboard.
   * Falls back to navigator.share if clipboard is unavailable.
   */
  const handleShare = async () => {
    const text = formatShareText(state.claims, state.verdicts);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setShareState('copied');
      } else if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'Fact-Check Result', text });
        setShareState('copied');
      } else {
        throw new Error('No share or clipboard API available');
      }
    } catch (error) {
      console.error('Share failed:', error);
      setShareState('error');
    }
    setTimeout(() => setShareState('idle'), 2000);
  };

  /**
   * Copy a detailed research summary of all page claims to clipboard.
   */
  const handleCopySummary = async () => {
    const text = formatResearchSummary(pageCheck.entries);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setSummaryState('copied');
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch (error) {
      console.error('Summary copy failed:', error);
      setSummaryState('error');
    }
    setTimeout(() => setSummaryState('idle'), 2000);
  };

  // Show loading state while checking API key
  if (hasApiKey === null) {
    return (
      <div className="app">
        <Header
          onSettingsClick={() => setShowSettings(true)}
          theme={theme}
          onToggleTheme={toggleTheme}
          tavilyCredits={showCreditUsage ? tavilyCredits : undefined}
          llmTokens={showCreditUsage ? llmTokens : undefined}
          llmProvider={llmProvider}
        />
        <div className="loading">
          <div className="spinner" />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  // Show settings if no API key or settings requested
  if (showSettings) {
    return (
      <div className="app">
        <Header
          onSettingsClick={() => setShowSettings(false)}
          showBack={hasApiKey === true}
          theme={theme}
          onToggleTheme={toggleTheme}
          tavilyCredits={showCreditUsage ? tavilyCredits : undefined}
          llmTokens={showCreditUsage ? llmTokens : undefined}
          llmProvider={llmProvider}
        />
        <ApiKeyInput
          onSaveApiKey={handleApiKeySave}
          onSaveResearchSettings={handleResearchSettingsSave}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <Header
        onSettingsClick={() => setShowSettings(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        tavilyCredits={showCreditUsage ? tavilyCredits : undefined}
        llmTokens={showCreditUsage ? llmTokens : undefined}
        llmProvider={llmProvider}
      />

      {/* Input Section */}
      {state.status === 'idle' && pageCheck.status === 'idle' && (
        <div className="input-section">
          <textarea
            className="text-input"
            placeholder="Paste text to fact-check, or select text on a webpage and click the extension icon..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            rows={6}
          />
          <button
            className="verify-button"
            onClick={() => handleVerify()}
            disabled={!inputText.trim()}
          >
            Verify Claims
          </button>

          <div className="mode-divider">
            <span>or</span>
          </div>

          <button
            className="page-check-button"
            onClick={handleFactCheckPage}
            title="Run /extract on the current tab, identify claims, and annotate them inline"
          >
            <Icons.ShieldCheck className="page-check-icon" aria-hidden="true" />
            <span>Fact-Check This Page</span>
          </button>
          <p className="page-check-hint">
            Extracts the article you're reading, finds check-worthy claims, and shows traffic-light
            verdicts inline on the page.
          </p>
        </div>
      )}

      {/* Page Fact Checker view */}
      {pageCheck.status !== 'idle' && (
        <div className="results-section">
          <div className="results-header">
            <h2>Page Fact Check</h2>
            <div className="results-actions">
              {pageCheck.status === 'complete' && pageCheck.entries.length > 0 && (
                <button
                  className={`share-button ${summaryState !== 'idle' ? `share-button-${summaryState}` : ''}`}
                  onClick={handleCopySummary}
                  disabled={summaryState !== 'idle'}
                  title="Copy a formatted research summary of all claims"
                >
                  {summaryState === 'copied' ? '✓ Copied' : 'Copy Summary'}
                </button>
              )}
              <button className="new-check-button" onClick={handleClearPageCheck}>
                {pageCheck.status === 'running' ? 'Cancel' : 'Clear'}
              </button>
            </div>
          </div>

          {pageCheck.progress && (
            <div className="page-check-progress">
              <div className="loading-stage-label">
                {pageCheck.progress.stage.replace(/-/g, ' ')}
              </div>
              {pageCheck.status === 'running' && (
                <div className="loading-bar indeterminate" aria-label="Page fact check in progress">
                  <div className="loading-bar-track" />
                </div>
              )}
              <p className="loading-text">{pageCheck.progress.message}</p>
              {pageCheck.progress.claimsTotal != null && (
                <p className="loading-elapsed">
                  {pageCheck.progress.claimsCompleted ?? 0} / {pageCheck.progress.claimsTotal}{' '}
                  researched
                </p>
              )}
            </div>
          )}

          {pageCheck.status === 'error' && (
            <div className="error-section">
              <div className="error-icon">⚠️</div>
              <p className="error-message">{pageCheck.error}</p>
            </div>
          )}

          {pageCheck.entries.length > 0 && (
            <ul className="page-claim-list">
              {pageCheck.entries.map((entry) => {
                const isExpanded = expandedClaimId === entry.claim.id;
                return (
                  <li
                    key={entry.claim.id}
                    className={`page-claim-row ${isExpanded ? 'page-claim-row--expanded' : ''} ${entry.verdict ? 'page-claim-row--clickable' : ''}`}
                    onClick={() => entry.verdict && handleToggleExpand(entry.claim.id)}
                    role={entry.verdict ? 'button' : undefined}
                    tabIndex={entry.verdict ? 0 : undefined}
                  >
                    <div className="page-claim-summary">
                      <span
                        className={`page-claim-dot page-claim-dot--${getVerdictTier(entry.verdict)}`}
                        aria-hidden="true"
                      />
                      <div className="page-claim-text">
                        <div className="page-claim-headline">{entry.claim.text}</div>
                        {entry.verdict ? (
                          <div className="page-claim-meta">
                            {entry.verdict.verdict} · {Math.round(entry.verdict.confidence * 100)}%
                            <span className="expand-hint">
                              {isExpanded ? ' · Show less' : ' · Click to read more'}
                            </span>
                          </div>
                        ) : (
                          <div className="page-claim-meta page-claim-meta--pending">
                            Researching…
                          </div>
                        )}
                      </div>
                    </div>

                    {isExpanded && entry.verdict && (
                      <div
                        className="page-claim-details animate-expand"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="confidence-section">
                          <div className="confidence-label">
                            <span>Confidence</span>
                            <span className="confidence-value">
                              {Math.round(entry.verdict.confidence * 100)}%
                            </span>
                          </div>
                          <div className="confidence-bar">
                            <div
                              className="confidence-fill"
                              style={{
                                width: `${entry.verdict.confidence * 100}%`,
                                backgroundColor: getTierColor(getVerdictTier(entry.verdict)),
                                height: '100%',
                              }}
                            />
                          </div>
                        </div>

                        <div className="explanation">
                          <p>{entry.verdict.explanation}</p>
                        </div>

                        {entry.verdict.citations.length > 0 && (
                          <div className="citations-section">
                            <h4 className="citations-heading">Sources</h4>
                            <CitationList
                              citations={entry.verdict.citations}
                              claimText={entry.claim.text}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Loading State */}
      {(state.status === 'extracting' ||
        state.status === 'searching' ||
        state.status === 'analyzing') && (
        <div className="loading-section">
          <div className="loading-stage-label">
            {(latestStatus?.stage ?? 'submitting').replace(/^./, (c) => c.toUpperCase())}
          </div>
          <div className="loading-bar indeterminate" aria-label="Research in progress">
            <div className="loading-bar-track" />
          </div>
          <p className="loading-text" key={latestStatus?.message ?? 'init'}>
            {latestStatus?.message ?? 'Preparing research request…'}
          </p>
          <p className="loading-elapsed">{displayElapsed}s elapsed</p>
        </div>
      )}

      {/* Error State */}
      {state.status === 'error' && (
        <div className="error-section">
          <div className="error-icon">⚠️</div>
          <p className="error-message">{state.error}</p>
          <button className="retry-button" onClick={handleReset}>
            Try Again
          </button>
        </div>
      )}

      {/* Results Section */}
      {state.status === 'complete' && (
        <div className="results-section">
          <div className="results-header">
            <h2>Results</h2>
            <div className="results-actions">
              {state.claims.length > 0 && (
                <button
                  className={`share-button ${shareState !== 'idle' ? `share-button-${shareState}` : ''}`}
                  onClick={handleShare}
                  disabled={shareState !== 'idle'}
                  aria-live="polite"
                >
                  {shareState === 'copied'
                    ? '✓ Copied'
                    : shareState === 'error'
                      ? 'Failed'
                      : 'Share'}
                </button>
              )}
              <button className="new-check-button" onClick={handleReset}>
                New Check
              </button>
            </div>
          </div>

          {state.claims.length === 0 ? (
            <div className="no-claims">
              <p>No verifiable claims found in the text.</p>
            </div>
          ) : (
            <div className="claims-list">
              {state.claims.map((claim) => (
                <ClaimCard key={claim.id} claim={claim} verdict={getVerdictForClaim(claim.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatShareText(claims: Claim[], verdicts: Verdict[]): string {
  const lines: string[] = ['Fact-Check Result'];
  for (const claim of claims) {
    const verdict = verdicts.find((v) => v.claimId === claim.id);
    if (!verdict) continue;
    lines.push('', `Claim: "${claim.text}"`);
    lines.push(`Verdict: ${verdict.verdict} (${Math.round(verdict.confidence * 100)}% confidence)`);
    if (verdict.summary) {
      lines.push(`Summary: ${verdict.summary}`);
    } else if (verdict.explanation) {
      lines.push(`Summary: ${verdict.explanation}`);
    }
    if (verdict.citations.length > 0) {
      lines.push('Sources:');
      verdict.citations.forEach((c) => lines.push(`- ${c.title || c.url} (${c.url})`));
    }
  }
  lines.push('', '— Live Fact-Checking Assistant');
  return lines.join('\n');
}

function formatResearchSummary(entries: PageCheckEntry[]): string {
  const lines: string[] = ['Article Research Summary', ''];
  entries.forEach((entry, i) => {
    if (!entry.verdict) return;
    lines.push(`${i + 1}. Claim: "${entry.claim.text}"`);
    lines.push(
      `   Verdict: ${entry.verdict.verdict} (${Math.round(entry.verdict.confidence * 100)}% confidence)`
    );
    const explanation = entry.verdict.summary || entry.verdict.explanation;
    if (explanation) {
      lines.push(`   Analysis: ${explanation}`);
    }
    if (entry.verdict.citations.length > 0) {
      lines.push('   Sources:');
      entry.verdict.citations.forEach((c) => {
        lines.push(`   - ${c.title || c.url} (${c.url})`);
      });
    }
    lines.push('');
  });
  return lines.join('\n');
}
