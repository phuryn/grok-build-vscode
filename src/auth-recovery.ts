export interface AuthRecoveryState {
  activeSessionId?: string;
  authRecoveryTried: boolean;
}

/**
 * Claim the one process recovery for one session's current failure
 * streak. The returned id is the history that the owning process must reload.
 */
export function beginAuthRecovery(state: AuthRecoveryState): string | undefined {
  if (!state.activeSessionId || state.authRecoveryTried) return undefined;
  state.authRecoveryTried = true;
  return state.activeSessionId;
}

/** Detect the observed credential-selection trap from initialize metadata,
 *  rather than waiting for a backend error whose prose happens to mention it. */
export function oauthShadowsXaiApiKey(defaultAuthMethodId: unknown, env: NodeJS.ProcessEnv): boolean {
  return defaultAuthMethodId === "cached_token" && !!env.XAI_API_KEY?.trim();
}
