'use client';
import { useEffect, useEffectEvent, useState } from 'react';
import { eventStreamUrl } from './api';
import type { PipelineEvent } from './types';

export type StreamStatus = 'connecting' | 'open';

/**
 * Subscribes to the orchestrator's Server-Sent Events for as long as the
 * component is mounted. The browser reconnects by itself after a drop; the
 * returned status says whether events can arrive right now.
 */
export function useEventStream(onEvent: (event: PipelineEvent) => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handle = useEffectEvent(onEvent);

  useEffect(() => {
    const stream = new EventSource(eventStreamUrl);
    stream.onopen = () => setStatus('open');
    stream.onerror = () => setStatus('connecting');
    stream.onmessage = (message: MessageEvent<string>) => {
      handle(JSON.parse(message.data) as PipelineEvent);
    };
    return () => stream.close();
  }, []);

  return status;
}
