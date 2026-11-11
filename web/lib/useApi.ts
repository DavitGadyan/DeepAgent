'use client';
import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { type ApiError, toApiError } from './api';

interface Settled<T> {
  key: string | null;
  data?: T;
  error: ApiError | null;
}

export interface ApiState<T> {
  /** The last successful response; kept while a newer request is in flight. */
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  /** Fetch again and show the loading state (retry buttons). */
  reload: () => void;
  /** Fetch again in the background, keeping what is on screen (polling). */
  refresh: () => void;
  /** Replace the data with a response a mutation already returned. */
  mutate: (data: T) => void;
}

/**
 * Loads `fetcher()` whenever `key` changes. `key` names the request (it should
 * contain every parameter the fetcher reads); `null` skips the request.
 */
export function useApi<T>(key: string | null, fetcher: () => Promise<T>): ApiState<T> {
  const [settled, setSettled] = useState<Settled<T>>({ key: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const load = useEffectEvent(fetcher);

  useEffect(() => {
    if (key === null) return;
    let stale = false;
    load().then(
      (data) => !stale && setSettled({ key, data, error: null }),
      (error: unknown) =>
        !stale && setSettled((prev) => ({ key, data: prev.data, error: toApiError(error) })),
    );
    return () => {
      stale = true;
    };
  }, [key, attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const reload = useCallback(() => {
    setSettled({ key: null, error: null });
    setAttempt((n) => n + 1);
  }, []);
  const mutate = useCallback(
    (data: T) => setSettled((prev) => ({ key: prev.key, data, error: null })),
    [],
  );

  const current = settled.key === key;
  return {
    data: settled.data,
    error: current ? settled.error : null,
    loading: key !== null && !current,
    reload,
    refresh,
    mutate,
  };
}
