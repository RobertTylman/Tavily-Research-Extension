/**
 * API Key Input Component
 *
 * Secure input for Tavily API key configuration.
 */

import { useState, useEffect } from 'react';
import { EntailmentSettings } from '../../lib/types';
import { storage } from '../../utils/messaging';

interface ApiKeyInputProps {
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onSaveEntailmentSettings: (settings: EntailmentSettings) => Promise<void>;
}

const defaultSettings: EntailmentSettings = {
  provider: 'on_device_nli',
  llmProvider: 'openai',
  llmModel: 'gpt-4.1-mini',
  ollamaBaseUrl: 'http://localhost:11434',
};

export function ApiKeyInput({ onSaveApiKey, onSaveEntailmentSettings }: ApiKeyInputProps) {
  const [apiKey, setApiKey] = useState('');
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [showStoredKey, setShowStoredKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<EntailmentSettings>(defaultSettings);
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // Load stored API key on mount
  useEffect(() => {
    storage.getApiKey().then((key: string | null) => {
      if (key) {
        setStoredKey(key);
      }
    });

    storage.getEntailmentSettings().then((loaded) => {
      setSettings(loaded);
    });
  }, []);

  const handleApiKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;

    setIsSaving(true);
    try {
      await onSaveApiKey(apiKey.trim());
      setStoredKey(apiKey.trim());
      setApiKey('');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSettingsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingSettings(true);
    try {
      await onSaveEntailmentSettings(settings);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const maskKey = (key: string) => {
    if (key.length <= 8) return '••••••••';
    return key.slice(0, 4) + '••••••••' + key.slice(-4);
  };

  return (
    <div className="api-key-section">
      <h2>Configure API Key</h2>
      <p className="api-key-description">This extension uses the Tavily API for web search.</p>

      {storedKey && (
        <div className="stored-key-section">
          <h3>Current API Key</h3>
          <div className="stored-key-display">
            <code className="stored-key">{showStoredKey ? storedKey : maskKey(storedKey)}</code>
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => setShowStoredKey(!showStoredKey)}
              title={showStoredKey ? 'Hide key' : 'Show key'}
            >
              {showStoredKey ? '👁️' : '👁️‍🗨️'}
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleApiKeySubmit} className="api-key-form">
        <h3>{storedKey ? 'Update API Key' : 'Enter API Key'}</h3>
        <div className="input-wrapper">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={storedKey ? 'Enter new API key' : 'Enter your Tavily API key'}
            className="api-key-input"
            autoComplete="off"
          />
          <button
            type="button"
            className="toggle-visibility"
            onClick={() => setShowKey(!showKey)}
            title={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? '👁️' : '👁️‍🗨️'}
          </button>
        </div>

        <button type="submit" className="save-button" disabled={!apiKey.trim() || isSaving}>
          {isSaving ? 'Saving...' : storedKey ? 'Update API Key' : 'Save API Key'}
        </button>
      </form>

      <form onSubmit={handleSettingsSubmit} className="api-key-form">
        <h3>Entailment Provider</h3>
        <p className="api-key-description">
          Choose how evidence stance is classified. On-device NLI and LLM providers are the primary
          stance engines; regex mode is a minimal fallback.
        </p>
        <div className="input-wrapper">
          <select
            className="api-key-input"
            value={settings.provider}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                provider: e.target.value as EntailmentSettings['provider'],
              }))
            }
          >
            <option value="on_device_nli">On-device NLI (transformers.js)</option>
            <option value="llm">LLM-backed entailment</option>
            <option value="regex">Regex heuristics only (fallback)</option>
          </select>
        </div>

        {settings.provider === 'llm' && (
          <>
            <div className="input-wrapper">
              <select
                className="api-key-input"
                value={settings.llmProvider}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    llmProvider: e.target.value as EntailmentSettings['llmProvider'],
                  }))
                }
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama (local)</option>
              </select>
            </div>

            {settings.llmProvider !== 'ollama' && (
              <div className="input-wrapper">
                <input
                  type={showLlmKey ? 'text' : 'password'}
                  value={settings.llmApiKey || ''}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmApiKey: e.target.value }))}
                  placeholder="Enter LLM API key"
                  className="api-key-input"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowLlmKey(!showLlmKey)}
                  title={showLlmKey ? 'Hide key' : 'Show key'}
                >
                  {showLlmKey ? '👁️' : '👁️‍🗨️'}
                </button>
              </div>
            )}

            <div className="input-wrapper">
              <input
                type="text"
                value={settings.llmModel || ''}
                onChange={(e) => setSettings((prev) => ({ ...prev, llmModel: e.target.value }))}
                placeholder={
                  settings.llmProvider === 'ollama' ? 'Ollama model (e.g. llama3.1)' : 'Model name'
                }
                className="api-key-input"
              />
            </div>

            {settings.llmProvider === 'ollama' && (
              <div className="input-wrapper">
                <input
                  type="text"
                  value={settings.ollamaBaseUrl || ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      ollamaBaseUrl: e.target.value,
                    }))
                  }
                  placeholder="Ollama base URL (e.g. http://localhost:11434)"
                  className="api-key-input"
                />
              </div>
            )}
          </>
        )}

        <button type="submit" className="save-button" disabled={isSavingSettings}>
          {isSavingSettings ? 'Saving...' : 'Save Entailment Settings'}
        </button>
      </form>

      <div className="security-note">
        <span className="security-icon">🔒</span>
        <span>All keys and settings are stored locally and never sent to our servers.</span>
      </div>
    </div>
  );
}
