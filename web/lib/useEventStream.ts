'use client';
import { useEffect, useEffectEvent, useState } from 'react';
import { eventStreamUrl } from './api';
import type { LeadSummary, PipelineEvent } from './types';

export type StreamStatus = 'connecting' | 'open';

interface Handlers {
  /** Every event of every run, as it is recorded. */
  onEvent?: (event: PipelineEvent) => void;
  /** A lead's row in the leads table, each time it changes (and when it is new). */
  onLead?: (lead: LeadSummary) => void;
  /** The stream is open again after a drop: whatever was pushed meanwhile was missed. */
  onReconnect?: () => void;
}

/**
 * Subscribes to the orchestrator's Server-Sent Events for as long as the
 * component is mounted. The browser reconnects by itself after a drop; the
 * returned status says whether events can arrive right now.
 *
 * Pass a function to receive events only, or handlers for events and lead rows.
 */
export function useEventStream(
  handlers: Handlers | ((event: PipelineEvent) => void),
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const current = typeof handlers === 'function' ? { onEvent: handlers } : handlers;
  const onEvent = useEffectEvent((event: PipelineEvent) => current.onEvent?.(event));
  const onLead = useEffectEvent((lead: LeadSummary) => current.onLead?.(lead));
  const onReconnect = useEffectEvent(() => current.onReconnect?.());

  useEffect(() => {
    const stream = new EventSource(eventStreamUrl);
    let opened = false;
    stream.onopen = () => {
      if (opened) onReconnect();
      opened = true;
      setStatus('open');
    };
    stream.onerror = () => setStatus('connecting');
    stream.onmessage = (message: MessageEvent<string>) => {
      onEvent(JSON.parse(message.data) as PipelineEvent);
    };
    stream.addEventListener('lead', (message: MessageEvent<string>) => {
      onLead(JSON.parse(message.data) as LeadSummary);
    });
    return () => stream.close();
  }, []);

  return status;
}
