/**
 * Tells our own writes to the page address from someone else's.
 *
 * A page that keeps state in the query string writes the address itself and
 * the router reports each write back a moment later, possibly after the state
 * has moved on. Such an echo must be ignored; any other change of the address
 * (a link, the Back button) must be followed.
 */
export interface AddressSync {
  /** The query string the router last reported. */
  url: string;
  /** The query string the state stood for at that time. */
  written: string;
  /** Our writes the router has not reported back yet, oldest first. */
  pending: string[];
}

export const startSync = (url: string, written: string): AddressSync => ({
  url,
  written,
  pending: [],
});

/**
 * Call on every render with the router's query string (`url`) and the one the
 * state stands for (`written`, which an effect writes to the address).
 * `follow` is true when `url` is not ours and the state must be read from it.
 */
export function syncAddress(
  prev: AddressSync,
  url: string,
  written: string,
): { next: AddressSync; follow: boolean } {
  let pending = written === prev.written ? prev.pending : [...prev.pending, written];
  let follow = false;
  if (url !== prev.url) {
    const echo = pending.indexOf(url);
    // The router may skip writes that were replaced at once: drop those with the echo.
    if (echo >= 0) pending = pending.slice(echo + 1);
    else follow = url !== written;
  }
  if (follow || url === written) pending = [];
  const unchanged =
    url === prev.url && written === prev.written && pending.length === prev.pending.length;
  return { next: unchanged ? prev : { url, written, pending }, follow };
}
