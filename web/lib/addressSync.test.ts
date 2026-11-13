import { describe, expect, it } from 'vitest';
import { type AddressSync, startSync, syncAddress } from './addressSync';

/** Feeds renders (url, written) through `syncAddress`; returns the last result. */
function run(start: AddressSync, renders: [url: string, written: string][]) {
  let sync = start;
  let follow = false;
  for (const [url, written] of renders) {
    ({ next: sync, follow } = syncAddress(sync, url, written));
  }
  return { sync, follow };
}

describe('syncAddress', () => {
  it('changes nothing while the address and the state agree', () => {
    const start = startSync('found=7d', 'found=7d');
    const { next, follow } = syncAddress(start, 'found=7d', 'found=7d');
    expect(follow).toBe(false);
    expect(next).toBe(start);
  });

  it('ignores the echo of its own write', () => {
    const { sync, follow } = run(startSync('', ''), [
      ['', 'found=7d'], // the state changed; an effect writes the address
      ['found=7d', 'found=7d'], // the router reports it
    ]);
    expect(follow).toBe(false);
    expect(sync.pending).toEqual([]);
  });

  it('ignores a late echo after the state has moved on', () => {
    const { sync, follow } = run(startSync('', ''), [
      ['', 'q=a'],
      ['', 'q=ab'],
      ['q=a', 'q=ab'], // the first write comes back while the state is at the second
    ]);
    expect(follow).toBe(false);
    expect(sync.pending).toEqual(['q=ab']);
  });

  it('drops the writes the router skipped', () => {
    const { sync, follow } = run(startSync('', ''), [
      ['', 'q=a'],
      ['', 'q=ab'],
      ['q=ab', 'q=ab'],
    ]);
    expect(follow).toBe(false);
    expect(sync.pending).toEqual([]);
  });

  it('follows an address it did not write', () => {
    const { sync, follow } = run(startSync('found=7d', 'found=7d'), [['', 'found=7d']]);
    expect(follow).toBe(true);
    expect(sync).toEqual({ url: '', written: 'found=7d', pending: [] });
  });

  it('does not follow an address that only differs in form from the state', () => {
    // First render with a hand-typed address: the state stands for 'found=7d' either way.
    const start = startSync('sort=newest&found=7d', 'found=7d');
    const { follow } = run(start, [
      ['sort=newest&found=7d', 'found=7d'],
      ['found=7d', 'found=7d'],
    ]);
    expect(follow).toBe(false);
  });

  it('follows a link even while one of its own writes is pending', () => {
    const { follow } = run(startSync('', ''), [
      ['', 'q=a'],
      ['status=applied', 'q=a'],
    ]);
    expect(follow).toBe(true);
  });
});
