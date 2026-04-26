/**
 * API Key Input Component
 *
 * Secure input for Tavily API key configuration.
 */

import { useState, useEffect } from 'react';
import { ResearchSettings, TavilyCitationFormat, TavilyResearchModel } from '../../lib/types';
import { storage } from '../../utils/messaging';

interface ApiKeyInputProps {
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onSaveResearchSettings: (settings: ResearchSettings) => Promise<void>;
}

const defaultSettings: ResearchSettings = {
  model: 'mini',
  citationFormat: 'numbered',
};

export function ApiKeyInput({ onSaveApiKey, onSaveResearchSettings }: ApiKeyInputProps) {
  const [apiKey, setApiKey] = useState('');
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [showStoredKey, setShowStoredKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<ResearchSettings>(defaultSettings);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  useEffect(() => {
    storage.getApiKey().then((key: string | null) => {
      if (key) {
        setStoredKey(key);
      }
    });

    storage.getResearchSettings().then((loaded: ResearchSettings) => {
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
      await onSaveResearchSettings(settings);
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
      <p className="api-key-description">
        This extension uses the Tavily Research API for fact-checking.
      </p>

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
        <h3>Research Settings</h3>
        <p className="api-key-description">
          Choose the Tavily research model and citation format used when generating fact-check
          reports.
        </p>
        <div className="input-wrapper">
          <select
            className="api-key-input"
            value={settings.model}
            onChange={(e) =>
              setSettings((prev: ResearchSettings) => ({
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
              setSettings((prev: ResearchSettings) => ({
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

        <button type="submit" className="save-button" disabled={isSavingSettings}>
          {isSavingSettings ? 'Saving...' : 'Save Research Settings'}
        </button>
      </form>

      <div className="security-note">
        <span className="security-icon">🔒</span>
        <span>All keys and settings are stored locally and never sent to our servers.</span>
      </div>
    </div>
  );
}
