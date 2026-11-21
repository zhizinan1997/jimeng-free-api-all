const ACCOUNT_INFO_SOURCE = '/passport/account/info/v2';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function userId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed && trimmed !== '0' ? trimmed : null;
  }
  // JSON numbers outside the safe range may already be rounded. Never use them
  // to group accounts; the passport endpoint also supplies user_id_str.
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value) : null;
}

/** Normalize only account-info fields needed by the pool; discard other PII and credentials. */
export function parseJimengAccountInfo(value: unknown) {
  let payload = record(value) || {};
  // Passport uses { message: 'success', data: {...} }, unlike mweb's ret envelope.
  // core.request intentionally leaves non-ret responses wrapped.
  if ('message' in payload) {
    if (payload.message !== 'success') throw new Error('上游账号身份接口返回失败');
    payload = record(payload.data) || {};
  }
  const source = record(payload.user_info) || record(payload.user) || record(payload.account) || payload;
  const id = userId(source.user_id_str) ?? userId(source.user_id) ?? userId(source.uid) ?? userId(source.id);
  const name = source.screen_name ?? source.nickname ?? source.name;
  const membership = {
    isVip: source.is_vip ?? source.isVip ?? source.vip_status ?? null,
    vipExpireAt: source.vip_expire_time ?? source.vipExpireTime ?? source.vip_expire_at ?? null,
    membershipType: source.membership_type ?? source.membershipType ?? null
  };
  return {
    membership: Object.values(membership).some(v => v !== null) ? membership : 'unknown',
    upstreamIdentity: {
      verified: id !== null,
      userId: id,
      displayName: typeof name === 'string' && name.trim() ? name : null,
      source: ACCOUNT_INFO_SOURCE
    }
  };
}
