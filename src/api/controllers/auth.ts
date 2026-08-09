import _ from "lodash";

import { tokenSplit } from "@/api/controllers/core.ts";
import accountPool from "@/lib/account-pool.ts";
import db, { touchApiKey } from "@/lib/database.ts";

export interface ResolvedCredential {
  token: string;
  accountId?: string;
  managedKey?: string;
}

/** Resolve either a native Jimeng session token or a dashboard-managed API key. */
export function isManagedApiKey(value: string): boolean {
  return /^jm_[A-Za-z0-9_-]{20,}$/.test(value);
}

export async function resolveAuthorization(authorization: string): Promise<ResolvedCredential> {
  const tokens = tokenSplit(authorization);
  if (tokens.length === 0) throw new Error("Authorization token is empty");

  const managedKey = tokens.find((token) => db.validateApiKey(token).valid);
  const looksLikeManagedKey = tokens.find(isManagedApiKey);
  if (managedKey) {
    const selected = accountPool.select("round_robin");
    touchApiKey(managedKey);
    return {
      token: selected.sessionId,
      accountId: selected.account.id,
      managedKey,
    };
  }

  if (looksLikeManagedKey) {
    throw new Error("API key is invalid or disabled");
  }

  return { token: _.sample(tokens) as string };
}

export function markCredentialSuccess(credential: ResolvedCredential): void {
  if (credential.accountId) accountPool.markSuccess(credential.accountId);
}

export function markCredentialFailure(credential: ResolvedCredential, cooldownMs?: number): void {
  if (credential.accountId) accountPool.markFailure(credential.accountId, cooldownMs);
}
