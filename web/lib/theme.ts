'use client';
import { useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY } from './themeScript';

/** What the user chose. */
export type ThemePreference = 'light' | 'dark' | 'system';
/** What is on screen. */
export type Theme = 'light' | 'dark';

const CHANGE_EVENT = 'leadscout:theme';
const SYSTEM_DARK = '(prefers-color-scheme: dark)';

function readSavedPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

/**
 * The choice of this page load. Storage only persists it: when storage is
 * blocked the choice still holds (and keeps cycling) until a reload.
 */
let current: ThemePreference | undefined;

function readPreference(): ThemePreference {
  current ??= readSavedPreference();
  return current;
}

const readTheme = (): Theme =>
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

function show(preference: ThemePreference) {
  const systemDark = matchMedia(SYSTEM_DARK).matches;
  const dark = preference === 'dark' || (preference === 'system' && systemDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Saves the choice (when storage allows) and applies it to the page. */
export function setThemePreference(preference: ThemePreference) {
  current = preference;
  try {
    if (preference === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // storage unavailable: `current` keeps the choice for this page load
  }
  show(preference);
}

function subscribe(onChange: () => void) {
  const system = matchMedia(SYSTEM_DARK);
  const followSystem = () => readPreference() === 'system' && show('system');
  window.addEventListener(CHANGE_EVENT, onChange);
  system.addEventListener('change', followSystem);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    system.removeEventListener('change', followSystem);
  };
}

/** The user's choice; 'system' on the server and until hydration. */
export const useThemePreference = (): ThemePreference =>
  useSyncExternalStore(subscribe, readPreference, () => 'system');

/** The theme on screen, for libraries that need it as a value (React Flow). */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, readTheme, () => 'dark');
