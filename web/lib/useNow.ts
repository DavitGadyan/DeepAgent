'use client';
import { useEffect, useState } from 'react';

/** The current time (ms), refreshed every `everyMs`: for "3 h ago" labels that stay true. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}
