// Isolated upstream replacement for UI integration testing. Zero real network calls.
import fs from 'node:fs';
import path from 'node:path';

const CREDITS: Record<string, number> = {
  'virtual-alpha-250': 250,
  'virtual-alpha-dup': 260,
  'virtual-gamma-199': 199,
  'virtual-delta-300': 300,
  'virtual-zeta-240': 240,
  'virtual-zeta-dup': 240
};

const IDENTITIES: Record<string, { user_id: string; nickname: string; is_vip: boolean }> = {
  'virtual-alpha-250': { user_id: 'upstream-alpha-uid', nickname: '上游核验账号 Alpha', is_vip: false },
  'virtual-alpha-dup': { user_id: 'upstream-alpha-uid', nickname: '上游核验账号 Alpha', is_vip: false },
  'virtual-gamma-199': { user_id: 'upstream-gamma-uid', nickname: '上游核验账号 Gamma', is_vip: true },
  'virtual-delta-300': { user_id: 'upstream-delta-uid', nickname: '上游核验账号 Delta', is_vip: true },
  'virtual-zeta-240': { user_id: 'upstream-zeta-uid', nickname: '上游核验账号 Zeta', is_vip: false },
  'virtual-zeta-dup': { user_id: 'upstream-zeta-uid', nickname: '上游核验账号 Zeta', is_vip: false }
};

function isIdentityRefreshBlocked(sessionId: string): boolean {
  const root = process.env.UI_INTEGRATION_ROOT;
  if (!root) return false;
  const flagFile = path.join(root, 'fail-identity-sessions.json');
  if (!fs.existsSync(flagFile)) return false;
  try {
    const list = JSON.parse(fs.readFileSync(flagFile, 'utf8'));
    return Array.isArray(list) && list.includes(sessionId);
  } catch {
    return false;
  }
}

export async function getCredit(sessionId: string) {
  if (sessionId === 'virtual-beta-fail') {
    throw new Error('模拟上游余额接口异常');
  }
  const total = CREDITS[sessionId];
  if (typeof total !== 'number') {
    throw new Error(`ISOLATED_UPSTREAM_UNKNOWN_SESSION: ${sessionId}`);
  }
  return { giftCredit: total, purchaseCredit: 0, vipCredit: 0, totalCredit: total };
}

export async function getTokenLiveStatus(sessionId: string) {
  return { credit: await getCredit(sessionId), identity: IDENTITIES[sessionId] || null };
}

export async function request(_method: string, uri: string, sessionId: string) {
  if (uri.includes('/commerce/v1/benefits/user_credit')) {
    const credit = await getCredit(sessionId);
    return {
      credit: {
        gift_credit: credit.giftCredit,
        purchase_credit: credit.purchaseCredit,
        vip_credit: credit.vipCredit
      }
    };
  }
  if (uri.includes('/passport/account/info/v2')) {
    if (isIdentityRefreshBlocked(sessionId)) {
      throw new Error('ISOLATED_UPSTREAM_IDENTITY_TEMPORARY_ERROR');
    }
    const identity = IDENTITIES[sessionId];
    if (!identity) throw new Error(`ISOLATED_UPSTREAM_IDENTITY_UNKNOWN: ${sessionId}`);
    return { message: 'success', data: { ...identity, user_id_str: identity.user_id } };
  }
  throw new Error(`ISOLATED_UPSTREAM_UNSUPPORTED_URI: ${uri}`);
}

export function tokenSplit(value: string) {
  return value.replace(/^Bearer\s+/i, '').split(',').map((x) => x.trim()).filter(Boolean);
}

export async function receiveCredit() {
  throw new Error('ISOLATED_RECEIVE_CREDIT_DISABLED');
}

export async function uploadFile() {
  throw new Error('ISOLATED_UPLOAD_DISABLED');
}

export function generateCookie() {
  return '';
}

export const DEFAULT_ASSISTANT_ID = 'fixture-assistant';
