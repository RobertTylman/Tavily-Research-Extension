import { Icons } from '../icons';
import { NumberTicker } from './NumberTicker';

interface HeaderProps {
  onSettingsClick: () => void;
  showBack?: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  tavilyCredits?: number;
  llmTokens?: number;
  llmProvider?: 'anthropic' | 'openai';
}

export function Header({
  onSettingsClick,
  showBack,
  theme,
  onToggleTheme,
  tavilyCredits,
  llmTokens,
  llmProvider,
}: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <div className="logo">
          <Icons.NotebookPen width={28} height={28} className="logo-icon" />
          <span className="logo-text">Research Assistant</span>
        </div>
      </div>
      <div className="header-actions">
        {(tavilyCredits !== undefined || llmTokens !== undefined) && (
          <div className="header-usage" title="API usage">
            {tavilyCredits !== undefined && (
              <span className="usage-stat">
                Tavily: <NumberTicker value={tavilyCredits} />
              </span>
            )}
            {llmTokens !== undefined && (
              <span className="usage-stat">
                {llmProvider === 'openai' ? 'GPT' : llmProvider === 'anthropic' ? 'Claude' : 'LLM'}:{' '}
                <NumberTicker value={llmTokens} />
              </span>
            )}
          </div>
        )}
        <button
          className="theme-toggle"
          onClick={onToggleTheme}
          title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          {theme === 'light' ? (
            <Icons.Moon width={20} height={20} />
          ) : (
            <Icons.Sun width={20} height={20} />
          )}
        </button>
        <button
          className="settings-button"
          onClick={onSettingsClick}
          title={showBack ? 'Back' : 'Settings'}
          aria-label={showBack ? 'Go back' : 'Open settings'}
        >
          {showBack ? (
            <Icons.Back width={20} height={20} />
          ) : (
            <Icons.Settings width={20} height={20} />
          )}
        </button>
      </div>
    </header>
  );
}
