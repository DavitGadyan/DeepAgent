/** Shared by the server layout (inline script) and the client theme hooks. */

export const THEME_STORAGE_KEY = 'leadscout-theme';

/**
 * Runs in <head> before first paint: resolves the saved preference (or the
 * system setting) to 'light' | 'dark' and puts it on <html data-theme>, so the
 * page never flashes in the wrong theme. Storage can throw (private mode,
 * blocked site data); the system setting is the fallback.
 */
export const THEME_INIT_SCRIPT = `(function () {
  var saved = null;
  try { saved = localStorage.getItem('${THEME_STORAGE_KEY}'); } catch (e) {}
  var systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = saved === 'dark' || (saved !== 'light' && systemDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();`;
