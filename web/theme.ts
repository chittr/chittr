/** A saved colour scheme choice; `system` follows the operating system setting. */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const themeChoices: readonly ThemeChoice[] = ['system', 'light', 'dark'];

const cookie = 'chittr-theme';

/** The choice `public/theme.js` applied from the cookie before first paint. */
export function currentTheme(): ThemeChoice {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

/**
 * Applies and saves a choice. Each launch binds a new loopback port, and origin storage
 * is per port, so the choice lives in a cookie: cookies are scoped to the host, not the
 * port. The cookie holds only the choice; room access never reads cookies.
 */
export function saveTheme(choice: ThemeChoice): void {
  if (choice === 'system') {
    delete document.documentElement.dataset.theme;
    document.cookie = `${cookie}=; path=/; max-age=0; samesite=strict`;
  } else {
    document.documentElement.dataset.theme = choice;
    // 400 days is the longest lifetime browsers keep.
    document.cookie = `${cookie}=${choice}; path=/; max-age=34560000; samesite=strict`;
  }
}
