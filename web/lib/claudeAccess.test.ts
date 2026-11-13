import { describe, expect, it } from 'vitest';
import { checkAccess } from './claudeAccess';
import type { ApplierStatus } from './types';

const status = (over: Partial<ApplierStatus>): ApplierStatus => ({
  api_key_set: false,
  logged_in: false,
  auth_method: '',
  subscription: '',
  updated_at: '2026-11-12T10:00:00Z',
  ...over,
});

describe('checkAccess', () => {
  it('says when the applier is not running', () => {
    expect(checkAccess('login', null)).toMatchObject({ ok: false });
    expect(checkAccess('login', null).message).toContain('make applier');
  });

  it('checks the login for Claude login', () => {
    expect(checkAccess('login', status({ api_key_set: true })).ok).toBe(false);
    expect(
      checkAccess(
        'login',
        status({ logged_in: true, auth_method: 'claude.ai', subscription: 'max' }),
      ),
    ).toEqual({ ok: true, message: 'Signed in with claude.ai (max plan).' });
  });

  it('checks the key for Console access', () => {
    expect(checkAccess('console', status({ logged_in: true })).ok).toBe(false);
    expect(checkAccess('console', status({ api_key_set: true })).ok).toBe(true);
  });
});
