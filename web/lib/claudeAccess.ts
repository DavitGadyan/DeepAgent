import type { ApplierStatus, ClaudeAccess } from './types';

export interface AccessCheck {
  ok: boolean;
  message: string;
}

/** Whether the chosen sign-in will work, from what the applier last reported. */
export function checkAccess(access: ClaudeAccess, status: ApplierStatus | null): AccessCheck {
  if (!status) {
    return { ok: false, message: 'Applier not running. Start it with `make applier` to check.' };
  }
  if (access === 'console') {
    return status.api_key_set
      ? {
          ok: true,
          message: 'ANTHROPIC_API_KEY found. Sessions are billed to your Console account.',
        }
      : {
          ok: false,
          message: 'ANTHROPIC_API_KEY not set. Add it to .env; no restart is needed.',
        };
  }
  if (!status.logged_in) {
    return { ok: false, message: 'Claude Code is not signed in. Run `claude auth login`.' };
  }
  const plan = status.subscription ? ` (${status.subscription} plan)` : '';
  return { ok: true, message: `Signed in with ${status.auth_method || 'your account'}${plan}.` };
}
