'use client';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { setThemePreference, type ThemePreference, useThemePreference } from '@/lib/theme';

const OPTIONS: Record<ThemePreference, { label: string; Icon: LucideIcon; next: ThemePreference }> =
  {
    system: { label: 'System', Icon: Monitor, next: 'light' },
    light: { label: 'Light', Icon: Sun, next: 'dark' },
    dark: { label: 'Dark', Icon: Moon, next: 'system' },
  };

/** One button that cycles system -> light -> dark; shows the current choice. */
export function ThemeToggle() {
  const preference = useThemePreference();
  const { label, Icon, next } = OPTIONS[preference];
  return (
    <button
      type="button"
      className="nav__link w-full cursor-pointer"
      onClick={() => setThemePreference(next)}
      aria-label={`Theme: ${label}. Switch to ${OPTIONS[next].label.toLowerCase()}.`}
      title={`Theme: ${label}`}
    >
      <Icon size={18} aria-hidden="true" />
      {label}
    </button>
  );
}
