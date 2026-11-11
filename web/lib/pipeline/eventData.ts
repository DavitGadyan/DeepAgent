/** Typed reads of the loosely typed `Event.data` payload. */
import type { PipelineEvent } from '@/lib/types';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The fit score carried by a scorer `item.finished` event, if any. */
export function eventScore(event: PipelineEvent): number | null {
  const score = event.data.score;
  if (typeof score === 'number') return score;
  if (score && typeof score === 'object' && 'score' in score && typeof score.score === 'number') {
    return score.score;
  }
  return null;
}

/** Why an item was dropped, failed or is waiting; '' for other events. */
export function eventNote(event: PipelineEvent): string {
  switch (event.type) {
    case 'item.dropped':
    case 'item.waiting':
      return text(event.data.reason);
    case 'item.failed':
    case 'source.failed':
      return text(event.data.error);
    case 'source.finished':
      return typeof event.data.count === 'number' ? `${event.data.count} postings` : '';
    default:
      return '';
  }
}

/** What the event is about: the item's title, or the source name for source.* events. */
export const eventSubject = (event: PipelineEvent): string =>
  event.title || text(event.data.source);
