import { useEffect, useRef, useState } from 'react';
import {
  ExtractProviderKind,
  LLMProvider,
  ProviderKind,
  ProviderMode,
  ResearchSettings,
  TavilyCitationFormat,
  TavilyResearchModel,
} from '../../lib/types';
import {
  DEFAULT_PROVIDER_MODE,
  EXTRACTION_PROVIDER_OPTIONS,
  MAX_CLAIMS_MAX,
  MAX_CLAIMS_MIN,
  RESEARCH_PROVIDER_OPTIONS,
  sendToBackground,
  storage,
} from '../../utils/messaging';
import {
  buildEvaluationArtifactsFilename,
  clearEvaluationArtifacts,
  listEvaluationArtifacts,
  serializeEvaluationArtifacts,
} from '../../utils/evalArtifacts';
import { Icons } from '../icons';

interface ApiKeyInputProps {
  onSaveProviderKey: (provider: ProviderKind, apiKey: string) => Promise<void>;
  onSaveResearchSettings: (settings: ResearchSettings) => Promise<void>;
}

const defaultSettings: ResearchSettings = {
  researchProvider: 'tavily',
  providerMode: 'tavily_research',
  pageExtractionProvider: 'tavily',
  model: 'mini',
  citationFormat: 'numbered',
  llmProvider: 'anthropic',
  maxClaimsPerPage: 8,
  showCreditUsage: true,
};

const PROVIDERS: ProviderKind[] = ['tavily', 'exa', 'brave', 'firecrawl', 'parallel'];

const PROVIDER_LABELS: Record<ProviderKind, string> = {
  tavily: 'Tavily',
  exa: 'Exa',
  brave: 'Brave',
  firecrawl: 'Firecrawl',
  parallel: 'Parallel',
};

const PROVIDER_MODE_OPTIONS: Record<ProviderKind, Array<{ value: ProviderMode; label: string }>> = {
  tavily: [{ value: 'tavily_research', label: 'Native async research' }],
  exa: [
    { value: 'exa_search_structured', label: 'Structured search verdict' },
    { value: 'exa_research_async', label: 'Async research task' },
  ],
  brave: [
    { value: 'brave_context_plus_judge', label: 'LLM Context + shared judge' },
    { value: 'brave_answers_native', label: 'Native Answers API' },
  ],
  firecrawl: [{ value: 'firecrawl_search_plus_judge', label: 'Search + shared judge' }],
  parallel: [{ value: 'parallel_task_run', label: 'Task run verdict' }],
};

export function ApiKeyInput({ onSaveProviderKey, onSaveResearchSettings }: ApiKeyInputProps) {
  const [settings, setSettings] = useState<ResearchSettings>(defaultSettings);
  const settingsLoadedRef = useRef(false);

  const [storedProviderKeys, setStoredProviderKeys] = useState<Record<ProviderKind, string | null>>({
    tavily: null,
    exa: null,
    brave: null,
    firecrawl: null,
    parallel: null,
  });
  const [providerKeyInputs, setProviderKeyInputs] = useState<Record<ProviderKind, string>>({
    tavily: '',
    exa: '',
    brave: '',
    firecrawl: '',
    parallel: '',
  });
  const [showProviderKeyInput, setShowProviderKeyInput] = useState<Record<ProviderKind, boolean>>({
    tavily: false,
    exa: false,
    brave: false,
    firecrawl: false,
    parallel: false,
  });
  const [savingProvider, setSavingProvider] = useState<ProviderKind | null>(null);

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
  const [artifactCount, setArtifactCount] = useState(0);
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [clearState, setClearState] = useState<'idle' | 'clearing' | 'done' | 'error'>('idle');

  useEffect(() => {
    storage.getResearchSettings().then((loaded) => {
      setSettings(loaded);
      settingsLoadedRef.current = true;
    });

    Promise.all(PROVIDERS.map((provider) => storage.getProviderKey(provider))).then((values) => {
      const stored = {
        tavily: values[0],
        exa: values[1],
        brave: values[2],
        firecrawl: values[3],
        parallel: values[4],
      };
      setStoredProviderKeys(stored);
      setProviderKeyInputs({
        tavily: values[0] ?? '',
        exa: values[1] ?? '',
        brave: values[2] ?? '',
        firecrawl: values[3] ?? '',
        parallel: values[4] ?? '',
      });
    });

    Promise.all([storage.getLlmApiKey('anthropic'), storage.getLlmApiKey('openai')]).then(
      ([anthropic, openai]) => {
        setStoredLlmKeys({ anthropic, openai });
        setLlmKeyInputs({ anthropic: anthropic ?? '', openai: openai ?? '' });
      }
    );

    listEvaluationArtifacts()
      .then((artifacts) => setArtifactCount(artifacts.length))
      .catch((error) => {
        console.error('Failed to load evaluation artifacts:', error);
      });
  }, []);

  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    void onSaveResearchSettings(settings);
  }, [settings, onSaveResearchSettings]);

  const handleProviderKeySave = async (provider: ProviderKind) => {
    const trimmed = providerKeyInputs[provider].trim();
    if (!trimmed || trimmed === storedProviderKeys[provider]) return;
    setSavingProvider(provider);
    try {
      await onSaveProviderKey(provider, trimmed);
      setStoredProviderKeys((prev) => ({ ...prev, [provider]: trimmed }));
      setProviderKeyInputs((prev) => ({ ...prev, [provider]: trimmed }));
    } finally {
      setSavingProvider(null);
    }
  };

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

  const providerModeOptions = PROVIDER_MODE_OPTIONS[settings.researchProvider];

  const handleExportArtifacts = async () => {
    setExportState('exporting');
    try {
      const artifacts = await listEvaluationArtifacts();
      setArtifactCount(artifacts.length);
      if (artifacts.length === 0) {
        throw new Error('No evaluation artifacts available to export.');
      }

      const blob = new Blob([serializeEvaluationArtifacts(artifacts)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = buildEvaluationArtifactsFilename();
      link.click();
      URL.revokeObjectURL(url);
      setExportState('done');
    } catch (error) {
      console.error('Failed to export evaluation artifacts:', error);
      setExportState('error');
    }
    window.setTimeout(() => setExportState('idle'), 2500);
  };

  const handleClearArtifacts = async () => {
    setClearState('clearing');
    try {
      await clearEvaluationArtifacts();
      setArtifactCount(0);
      setClearState('done');
    } catch (error) {
      console.error('Failed to clear evaluation artifacts:', error);
      setClearState('error');
    }
    window.setTimeout(() => setClearState('idle'), 2500);
  };

  return (
    <div className="api-key-section">
      <div className="input-wrapper" style={{ marginBottom: '16px' }}>
        <label className="provider-radio" style={{ padding: '8px 12px', width: '100%' }}>
          <input
            type="checkbox"
            checked={settings.showCreditUsage ?? true}
            onChange={(e) =>
              setSettings((prev) => ({ ...prev, showCreditUsage: e.target.checked }))
            }
          />
          <span className="provider-radio-name" style={{ marginLeft: '8px' }}>
            Monitor API credit use in header
          </span>
        </label>
      </div>

      <h2>Provider Settings</h2>

      <p className="api-key-description">
        Research provider controls claim verification. Page extraction provider controls how the
        active tab is cleaned before claim extraction. Anthropic or OpenAI keys power claim
        extraction and shared judging where needed.
      </p>

      <div className="api-key-form">
        <h3>Routing</h3>

        <div className="input-wrapper">
          <select
            className="api-key-input"
            value={settings.researchProvider}
            onChange={(e) => {
              const provider = e.target.value as ProviderKind;
              setSettings((prev) => ({
                ...prev,
                researchProvider: provider,
                providerMode: DEFAULT_PROVIDER_MODE[provider],
              }));
            }}
          >
            {RESEARCH_PROVIDER_OPTIONS.map((provider) => (
              <option key={provider} value={provider}>
                Research provider: {PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </div>

        <div className="input-wrapper">
          <select
            className="api-key-input"
            value={settings.providerMode}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                providerMode: e.target.value as ProviderMode,
              }))
            }
          >
            {providerModeOptions.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>

        <div className="input-wrapper">
          <select
            className="api-key-input"
            value={settings.pageExtractionProvider}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                pageExtractionProvider: e.target.value as ExtractProviderKind,
              }))
            }
          >
            {EXTRACTION_PROVIDER_OPTIONS.map((provider) => (
              <option key={provider} value={provider}>
                Page extraction: {PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="api-key-form">
        <h3>Provider API Keys</h3>
        {PROVIDERS.map((provider) => {
          const dirty =
            providerKeyInputs[provider].trim().length > 0 &&
            providerKeyInputs[provider].trim() !== storedProviderKeys[provider];
          return (
            <div key={provider} className="llm-key-block">
              <div className="llm-key-block-header">
                {PROVIDER_LABELS[provider]} key
                {storedProviderKeys[provider] && (
                  <span className="key-check" title="API key configured" aria-label="API key configured">
                    ✓
                  </span>
                )}
              </div>
              <div className="llm-key-row">
                <div className="input-wrapper">
                  <input
                    type={showProviderKeyInput[provider] ? 'text' : 'password'}
                    value={providerKeyInputs[provider]}
                    onChange={(e) =>
                      setProviderKeyInputs((prev) => ({ ...prev, [provider]: e.target.value }))
                    }
                    placeholder={`Paste ${PROVIDER_LABELS[provider]} API key`}
                    className="api-key-input"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="toggle-visibility"
                    onClick={() =>
                      setShowProviderKeyInput((prev) => ({
                        ...prev,
                        [provider]: !prev[provider],
                      }))
                    }
                    aria-label={showProviderKeyInput[provider] ? 'Hide key' : 'Show key'}
                  >
                    {showProviderKeyInput[provider] ? (
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
                    disabled={savingProvider === provider}
                    onClick={() => handleProviderKeySave(provider)}
                  >
                    {savingProvider === provider
                      ? 'Saving…'
                      : storedProviderKeys[provider]
                        ? 'Replace'
                        : 'Save'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="api-key-form">
        <h3>Page Fact Checker</h3>
        <p className="api-key-description">
          Pick the LLM that identifies check-worthy claims and powers the shared verdict judge for
          Brave LLM Context and Firecrawl modes.
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
              <span className="key-check" title="API key configured" aria-label="API key configured">
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
              <span className="key-check" title="API key configured" aria-label="API key configured">
                ✓
              </span>
            )}
          </label>
        </div>

        {(['anthropic', 'openai'] as LLMProvider[]).map((provider) => {
          const dirty =
            llmKeyInputs[provider].trim().length > 0 &&
            llmKeyInputs[provider].trim() !== storedLlmKeys[provider];
          const label = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
          return (
            <div key={provider} className="llm-key-block">
              <div className="llm-key-block-header">{label} key</div>
              <div className="llm-key-row">
                <div className="input-wrapper">
                  <input
                    type={showLlmKeyInput[provider] ? 'text' : 'password'}
                    value={llmKeyInputs[provider]}
                    onChange={(e) =>
                      setLlmKeyInputs((prev) => ({ ...prev, [provider]: e.target.value }))
                    }
                    placeholder={`Paste ${label} API key`}
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
        })}

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

        {settings.researchProvider === 'tavily' && (
          <>
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
          </>
        )}
      </div>

      <div className="api-key-form">
        <h3>Evaluation Artifacts</h3>
        <p className="api-key-description">
          Export stored benchmark runs for offline comparison across provider modes in the `eval/`
          workspace.
        </p>
        <p className="api-key-description" style={{ marginTop: '-4px' }}>
          Stored artifacts: {artifactCount}
        </p>
        <div className="llm-key-row">
          <button
            type="button"
            className="save-button"
            disabled={exportState === 'exporting'}
            onClick={() => void handleExportArtifacts()}
          >
            {exportState === 'exporting'
              ? 'Exporting…'
              : exportState === 'done'
                ? 'Exported'
                : exportState === 'error'
                  ? 'Export failed'
                  : 'Export artifacts'}
          </button>
          <button
            type="button"
            className="save-button save-button-secondary"
            disabled={clearState === 'clearing' || artifactCount === 0}
            onClick={() => void handleClearArtifacts()}
          >
            {clearState === 'clearing'
              ? 'Clearing…'
              : clearState === 'done'
                ? 'Cleared'
                : clearState === 'error'
                  ? 'Clear failed'
                  : 'Clear artifacts'}
          </button>
        </div>
      </div>

      <div className="security-note">
        <span className="security-icon">🔒</span>
        <span>All keys and settings are stored locally and never sent to servers.</span>
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
