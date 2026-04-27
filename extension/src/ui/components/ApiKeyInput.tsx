/**
 * API Key Input Component
 *
 * Settings panel for:
 *   - Tavily API key (required)
 *   - LLM provider + API keys (Anthropic / OpenAI) used by the page fact checker
 *   - Tavily research model + citation format
 *   - Max claims per page (slider)
 *
 * Provider, slider, and dropdown changes auto-save so the user never has to
 * hit a separate "save" button to make their preference stick.
 */

import { useEffect, useRef, useState } from 'react';
import {
  LLMProvider,
  ResearchSettings,
  TavilyCitationFormat,
  TavilyResearchModel,
} from '../../lib/types';
import { MAX_CLAIMS_MAX, MAX_CLAIMS_MIN, sendToBackground, storage } from '../../utils/messaging';
import { Icons } from '../icons';

interface ApiKeyInputProps {
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onSaveResearchSettings: (settings: ResearchSettings) => Promise<void>;
}

const defaultSettings: ResearchSettings = {
  model: 'mini',
  citationFormat: 'numbered',
  llmProvider: 'anthropic',
  maxClaimsPerPage: 8,
};

export function ApiKeyInput({ onSaveApiKey, onSaveResearchSettings }: ApiKeyInputProps) {
  // Tavily key — single inline field. Shows the stored key (masked) and lets
  // the user paste a new one to replace it. The Save button only appears
  // once the value has actually changed.
  const [apiKey, setApiKey] = useState('');
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Settings (research model, citation format, llm provider, max claims)
  const [settings, setSettings] = useState<ResearchSettings>(defaultSettings);
  const settingsLoadedRef = useRef(false);

  // LLM keys — single inline field per provider, mirroring the Tavily key UX.
  const [storedLlmKeys, setStoredLlmKeys] = useState<Record<LLMProvider, string | null>>({
    anthropic: null,
    openai: null,
  });
  const [llmKeyInputs, setLlmKeyInputs] = useState<Record<LLMProvider, string>>({
    anthropic: '',
    openai: '',
  });
  const [showLlmKeyInput, setShowLlmKeyInput] = useState<Record<LLMProvider, boolean>>({
    anthropic: false,
    openai: false,
  });
  const [savingLlm, setSavingLlm] = useState<LLMProvider | null>(null);

  // Initial load
  useEffect(() => {
    storage.getApiKey().then((key) => {
      if (key) {
        setStoredKey(key);
        setApiKey(key);
      }
    });

    storage.getResearchSettings().then((loaded) => {
      setSettings(loaded);
      // Mark loaded AFTER state is set so the auto-save effect doesn't fire
      // for the initial load.
      settingsLoadedRef.current = true;
    });

    Promise.all([storage.getLlmApiKey('anthropic'), storage.getLlmApiKey('openai')]).then(
      ([anthropic, openai]) => {
        setStoredLlmKeys({ anthropic, openai });
        setLlmKeyInputs({ anthropic: anthropic ?? '', openai: openai ?? '' });
      }
    );
  }, []);

  // Auto-save research settings whenever they change after initial load.
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    void onSaveResearchSettings(settings);
  }, [settings, onSaveResearchSettings]);

  const handleApiKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed || trimmed === storedKey) return;

    setIsSaving(true);
    try {
      await onSaveApiKey(trimmed);
      setStoredKey(trimmed);
      setApiKey(trimmed);
    } finally {
      setIsSaving(false);
    }
  };

  const tavilyDirty = apiKey.trim().length > 0 && apiKey.trim() !== storedKey;

  const handleLlmKeySave = async (provider: LLMProvider) => {
    const value = llmKeyInputs[provider].trim();
    if (!value || value === storedLlmKeys[provider]) return;
    setSavingLlm(provider);
    try {
      await sendToBackground({ type: 'SET_LLM_API_KEY', provider, apiKey: value });
      setStoredLlmKeys((prev) => ({ ...prev, [provider]: value }));
      setLlmKeyInputs((prev) => ({ ...prev, [provider]: value }));
    } finally {
      setSavingLlm(null);
    }
  };

  const isLlmDirty = (provider: LLMProvider) => {
    const v = llmKeyInputs[provider].trim();
    return v.length > 0 && v !== storedLlmKeys[provider];
  };

  const providerLabel = (provider: LLMProvider) =>
    provider === 'anthropic' ? 'Anthropic' : 'OpenAI';

  return (
    <div className="api-key-section">
      <h2>Configure API Keys</h2>
      <p className="api-key-description">
        Tavily powers the research; the LLM provider you pick is used to identify check-worthy
        claims from the current webpage.
      </p>

      <form onSubmit={handleApiKeySubmit} className="api-key-form">
        <h3>Tavily API Key</h3>
        <div className="input-wrapper">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your Tavily API key"
            className="api-key-input"
            autoComplete="off"
          />
          <button
            type="button"
            className="toggle-visibility"
            onClick={() => setShowKey(!showKey)}
            title={showKey ? 'Hide key' : 'Show key'}
            aria-label={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? (
              <Icons.EyeOff width={18} height={18} />
            ) : (
              <Icons.Eye width={18} height={18} />
            )}
          </button>
        </div>
        {tavilyDirty && (
          <button type="submit" className="save-button" disabled={isSaving}>
            {isSaving ? 'Saving…' : storedKey ? 'Replace key' : 'Save key'}
          </button>
        )}
      </form>

      <div className="api-key-form">
        <h3>Page Fact Checker</h3>
        <p className="api-key-description">
          Pick the LLM that identifies check-worthy claims from the article. You only need a key for
          the provider you want to use. Settings save automatically.
        </p>

        <div className="provider-radio-group" role="radiogroup" aria-label="Preferred LLM provider">
          <label
            className={`provider-radio ${settings.llmProvider === 'anthropic' ? 'active' : ''}`}
          >
            <input
              type="radio"
              name="llm-provider"
              value="anthropic"
              checked={settings.llmProvider === 'anthropic'}
              onChange={() => setSettings((prev) => ({ ...prev, llmProvider: 'anthropic' }))}
            />
            <span className="provider-radio-name">Claude</span>
            {storedLlmKeys.anthropic && (
              <span
                className="key-check"
                title="API key configured"
                aria-label="API key configured"
              >
                ✓
              </span>
            )}
          </label>
          <label className={`provider-radio ${settings.llmProvider === 'openai' ? 'active' : ''}`}>
            <input
              type="radio"
              name="llm-provider"
              value="openai"
              checked={settings.llmProvider === 'openai'}
              onChange={() => setSettings((prev) => ({ ...prev, llmProvider: 'openai' }))}
            />
            <span className="provider-radio-name">GPT</span>
            {storedLlmKeys.openai && (
              <span
                className="key-check"
                title="API key configured"
                aria-label="API key configured"
              >
                ✓
              </span>
            )}
          </label>
        </div>

        {(() => {
          const provider = settings.llmProvider;
          const dirty = isLlmDirty(provider);
          return (
            <div key={provider} className="llm-key-block">
              <div className="llm-key-block-header">{providerLabel(provider)} key</div>
              <div className="llm-key-row">
                <div className="input-wrapper">
                  <input
                    type={showLlmKeyInput[provider] ? 'text' : 'password'}
                    value={llmKeyInputs[provider]}
                    onChange={(e) =>
                      setLlmKeyInputs((prev) => ({ ...prev, [provider]: e.target.value }))
                    }
                    placeholder={`Paste ${providerLabel(provider)} API key`}
                    className="api-key-input"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="toggle-visibility"
                    onClick={() =>
                      setShowLlmKeyInput((prev) => ({ ...prev, [provider]: !prev[provider] }))
                    }
                    aria-label={showLlmKeyInput[provider] ? 'Hide key' : 'Show key'}
                  >
                    {showLlmKeyInput[provider] ? (
                      <Icons.EyeOff width={18} height={18} />
                    ) : (
                      <Icons.Eye width={18} height={18} />
                    )}
                  </button>
                </div>
                {dirty && (
                  <button
                    type="button"
                    className="save-button save-button-secondary"
                    disabled={savingLlm === provider}
                    onClick={() => handleLlmKeySave(provider)}
                  >
                    {savingLlm === provider
                      ? 'Saving…'
                      : storedLlmKeys[provider]
                        ? 'Replace'
                        : 'Save'}
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        <div className="claims-slider">
          <div className="claims-slider-label">
            <span>Max claims per page</span>
            <span className="claims-slider-value">{settings.maxClaimsPerPage}</span>
          </div>
          <input
            type="range"
            min={MAX_CLAIMS_MIN}
            max={MAX_CLAIMS_MAX}
            step={1}
            value={settings.maxClaimsPerPage}
            onChange={(e) =>
              setSettings((prev) => ({ ...prev, maxClaimsPerPage: Number(e.target.value) }))
            }
            className="timeline-slider"
            aria-label="Max claims per page"
          />
          <div className="claims-slider-scale">
            <span>{MAX_CLAIMS_MIN}</span>
            <span>{MAX_CLAIMS_MAX}</span>
          </div>
        </div>

        <h3 style={{ marginTop: 12 }}>Tavily Research</h3>
        <div className="input-wrapper">
          <select
            className="api-key-input"
            value={settings.model}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                model: e.target.value as TavilyResearchModel,
              }))
            }
          >
            <option value="mini">Mini (fastest, cheapest)</option>
            <option value="auto">Auto</option>
            <option value="pro">Pro (deepest research)</option>
          </select>
        </div>

        <div className="input-wrapper">
          <select
            className="api-key-input"
            value={settings.citationFormat}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                citationFormat: e.target.value as TavilyCitationFormat,
              }))
            }
          >
            <option value="numbered">Numbered citations [1]</option>
            <option value="mla">MLA</option>
            <option value="apa">APA</option>
            <option value="chicago">Chicago</option>
          </select>
        </div>
      </div>

      <div className="security-note">
        <span className="security-icon">🔒</span>
        <span>All keys and settings are stored locally and never sent to our servers.</span>
      </div>

      <div
        style={{
          textAlign: 'right',
          marginTop: '12px',
          marginRight: '-8px',
          marginBottom: '-8px',
          fontSize: '11px',
          color: 'var(--text-secondary, #808080)',
        }}
      >
        <a
          href="https://roberttylman.github.io/portfolio-site/"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'inherit', textDecoration: 'underline' }}
        >
          {' '}
          Made by Robert Tylman
        </a>
      </div>
    </div>
  );
}
