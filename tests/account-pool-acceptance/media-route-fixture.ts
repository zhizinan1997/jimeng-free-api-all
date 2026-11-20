import { beginPoolSubmission, currentPoolTask } from '../../src/lib/pool-task-context.ts';
function submit(kind: string, args: any[]) {
  const context = currentPoolTask();
  (globalThis as any).__poolFixture.calls.push({ operation: 'submit', kind, args, accountId: context?.accountId });
  beginPoolSubmission('fixture-submit-id');
  throw new Error('fixture upstream submission response lost');
}
export const DEFAULT_MODEL = 'fixture-model';
export const generateImagesWithRetry = (...args: any[]) => submit('image', args);
export const generateVideoWithRetry = (...args: any[]) => submit('video', args);
export const generateAudio = (...args: any[]) => submit('audio', args);
export const createAgentTextCompletion = (...args: any[]) => submit('text', args);
export const createCompletion = (...args: any[]) => submit('compat-chat', args);
export const createCompletionStream = (...args: any[]) => submit('compat-stream', args);
export const queryAudioStatus = () => { throw new Error('NO_AUDIO_QUERY_FIXTURE'); };
export const rememberAudioTaskCredential = () => { throw new Error('NO_AUDIO_REMEMBER_FIXTURE'); };
export const resolveAudioTaskCredential = () => { throw new Error('NO_AUDIO_CREDENTIAL_FIXTURE'); };
export const waitForAudioCompletion = () => { throw new Error('NO_AUDIO_WAIT_FIXTURE'); };
