// Deliberately no network implementation or fallback to production upstream.
import crypto from 'node:crypto';
function fixture(): any { return (globalThis as any).__poolFixture; }
export async function getCredit(sessionId: string) {
  fixture().calls.push({ operation: 'credit', sessionId });
  const value = fixture().credits[sessionId];
  if (value instanceof Error) throw value;
  if (value === undefined) throw new Error('NO_ISOLATED_CREDIT_FIXTURE');
  return { giftCredit: value, purchaseCredit: 0, vipCredit: 0, totalCredit: value };
}
export async function request(method: string, uri: string, sessionId: string, options?: any) {
  fixture().calls.push({ operation: 'request', method, uri, sessionId, options });
  if (fixture().request) return fixture().request(method, uri, sessionId, options);
  if (uri === '/commerce/v1/benefits/user_credit') {
    const credit = await getCredit(sessionId);
    return { credit: { gift_credit: credit.giftCredit, purchase_credit: credit.purchaseCredit, vip_credit: credit.vipCredit } };
  }
  if (uri === '/passport/account/info/v2') {
    const uid = crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 12);
    return { user_info: { user_id: `fixture-uid-${uid}`, nickname: 'Fixture upstream', is_vip: true } };
  }
  throw new Error('NO_ISOLATED_REQUEST_FIXTURE: ' + uri);
}
export function tokenSplit(value: string) { return value.replace(/^Bearer\s+/i, '').split(',').map(x => x.trim()).filter(Boolean); }
export async function receiveCredit() { throw new Error('NO_ISOLATED_RECEIVE_FIXTURE'); }
export async function getTokenLiveStatus() { throw new Error('NO_ISOLATED_LIVE_STATUS_FIXTURE'); }
export async function uploadFile(...args: any[]) { return request('POST', '/fixture/upload', args[0], args); }
export const DEFAULT_ASSISTANT_ID = 'fixture-assistant';
