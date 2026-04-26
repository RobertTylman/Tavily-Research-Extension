import { Icons } from '../icons';

interface HeaderProps {
  onSettingsClick: () => void;
  showBack?: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export function Header({ onSettingsClick, showBack, theme, onToggleTheme }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <div className="logo">
          <img src="/icons/icon48.png" width={24} height={24} alt="Logo" className="logo-icon" />
          <span className="logo-text">Tavily Research Assistant</span>
        </div>
      </div>
      <div className="header-actions">
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
