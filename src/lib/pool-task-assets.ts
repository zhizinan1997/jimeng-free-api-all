import { AudioTaskBindings } from './audio-task-bindings.ts';
import type { TaskContext } from './pool-task-context.ts';
let bindings: AudioTaskBindings;
const store = () => bindings ??= new AudioTaskBindings(process.env.DB_PATH || './data/jimeng.db');

export function rememberUploadAsset(vid: string, durationMs: number, credential: any) {
  store().remember([`asset:${vid}`], { ...credential, durationMs });
}
/** Only identities are stored here. A owns every task, reservation and settlement. */
export function proveUploadAssets(context: TaskContext, tokens: string[], validate: (key: string) => boolean,
  readAccount: (id: string) => { sessionId: string; credential: string }): string | undefined {
  const ids = new Set<string>();
  function visit(value: any) {
    if (typeof value === 'string' && /^v0[0-9a-z]{20,}$/i.test(value.trim())) ids.add(value.trim());
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  const body = (context as any).requestBody || {};
  for (const field of ['audio_paths', 'audio_urls', 'audios', 'references', 'video_paths']) visit(body[field]);
  let accountId: string | undefined;
  context.assets = new Map();
  for (const id of ids) {
    const proof = store().resolve(`asset:${id}`, tokens, validate, readAccount);
    if (!proof.accountId || (accountId && proof.accountId !== accountId)) throw new Error('参考素材不属于同一个号池账号');
    accountId = proof.accountId;
    context.assets.set(id, { durationMs: proof.durationMs || 0 });
  }
  return accountId;
}
