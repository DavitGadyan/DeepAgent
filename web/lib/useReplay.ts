'use client';
import { useEffect, useEffectEvent, useState } from 'react';

/** Playback speed of the scrubber: one event per step. */
const STEP_MS = 90;

export interface Replay {
  /** True while the view follows the end of the log. */
  live: boolean;
  /** How many events, from the start of the log, the view shows. */
  position: number;
  playing: boolean;
  seek: (position: number) => void;
  togglePlay: () => void;
  goLive: () => void;
}

/** One playback step: the next event, or back to live (null) at the end of the log. */
export const stepCursor = (at: number | null, total: number): number | null =>
  at === null || at + 1 >= total ? null : at + 1;

/**
 * Cursor over an event log of `total` events. Live by default (the cursor
 * follows the end); seeking pins it, playing steps it forward and returns to
 * live once it catches up.
 */
export function useReplay(total: number): Replay {
  const [cursor, setCursor] = useState<number | null>(null);
  const [wantsPlay, setWantsPlay] = useState(false);
  const playing = wantsPlay && cursor !== null;
  // Reads the latest `total` without restarting the timer: during a burst of
  // events a restart on every event would keep the next step from ever firing.
  const step = useEffectEvent(() => setCursor((at) => stepCursor(at, total)));

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => step(), STEP_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  return {
    live: cursor === null,
    position: cursor === null ? total : Math.min(cursor, total),
    playing,
    seek: (position) => {
      setWantsPlay(false);
      setCursor(position >= total ? null : Math.max(0, position));
    },
    togglePlay: () => {
      if (cursor === null) setCursor(0);
      setWantsPlay(!playing);
    },
    goLive: () => {
      setWantsPlay(false);
      setCursor(null);
    },
  };
}

/** The current wall-clock time in epoch ms, refreshed every `intervalMs` while `enabled`. */
export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);

  return now;
}
