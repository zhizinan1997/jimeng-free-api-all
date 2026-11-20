import { describe, expect, mock, test } from 'bun:test';

const submissions = [];
let failure = 'captured-before-network';
let failedUpload;
let completedTask = false;
const polls = [];
mock.module('./core.ts', () => ({
  getCredit: async () => ({ totalCredit: 100 }), receiveCredit: async () => {},
  uploadFile: async (_token, path) => {
    if (path === failedUpload) throw new Error('synthetic-upload-failure');
    return { image_uri: `uploaded:${path}`, width: 720, height: 720 };
  },
  request: async (_method, path, _token, options) => {
    if (path === '/mweb/v1/aigc_draft/generate') {
      submissions.push({ ...options.data, maxRetries: options.maxRetries });
      if (completedTask) return { aigc_data: { history_record_id: 'synthetic-history-20s' } };
      throw new Error(failure);
    }
    if (path === '/mweb/v1/get_history_by_ids') {
      polls.push(options);
      return { 'synthetic-history-20s': { status: 50, item_list: [{ video: { url: 'https://example.com/generated-20s.mp4' } }] } };
    }
    // A dynamic model must retain the static adapter's duration declaration.
    return { models: [{ model_req_key: 'dreamina_seedance_45_pro', name: 'Seedance 2.5' }] };
  },
}));
mock.module('./auth.ts', () => ({
  PoolTaskReplay: class extends Error {},
  resolveAuthorization: async () => ({ token: 'synthetic-token' }),
  resolvePoolTaskCredential: async () => { throw new Error('Task recovery is verified separately'); },
  markCredentialFailure: () => {}, markCredentialSuccess: () => {},
}));
mock.module('../../lib/pool-task-recovery.ts', () => ({ recoverPoolTask: async () => { throw new Error('Task recovery is verified separately'); } }));
mock.module('../../lib/database.ts', () => ({ default: { recordCall: () => {}, saveMedia: () => {} } }));
const { resolveVideoModelConfig, getStaticModelConfigs, mergeModelConfigs } = await import('./models.ts');
const getStaticModelConfig = (id, type) => getStaticModelConfigs(type).find((model) => model.id === id);
const { generateVideo, generateVideoWithRetry } = await import('./videos.ts');
const { validateSeedance25Options } = await import('./seedance25-policy.ts');
const { default: routes } = await import('../routes/videos.ts');
const model = 'jimeng-video-seedance-2.5';
const omni = { duration: 20, resolution: '720p', functionMode: 'omni_reference', filePaths: ['https://example.com/image.png'] };

test('static and dynamic unified resolution preserve the 5..30 declaration', async () => {
  const expected = Array.from({ length: 26 }, (_, i) => i + 5);
  expect((await resolveVideoModelConfig(model)).supportedDurations).toEqual(expected);
  expect((await resolveVideoModelConfig(model, 'synthetic-token')).supportedDurations).toEqual(expected);
  const config = getStaticModelConfig(model, 'video');
  expect(mergeModelConfigs([config], [{ ...config, supportedDurations: undefined, defaultDuration: undefined }])[0].supportedDurations).toEqual(expected);
  const cloned = getStaticModelConfig(model, 'video');
  cloned.supportedDurations.pop();
  expect(getStaticModelConfig(model, 'video').supportedDurations).toHaveLength(26);
});

test('completion polls the original history with the same account cookie', async () => {
  completedTask = true;
  submissions.length = 0;
  polls.length = 0;
  try {
    expect(await generateVideoWithRetry(model, 'synthetic', omni, 'synthetic-token', 'sessionid=synthetic-token; device=synthetic')).toBe('https://example.com/generated-20s.mp4');
    expect(submissions).toHaveLength(1);
    expect(polls).toHaveLength(1);
    expect(polls[0].data.history_ids).toEqual(['synthetic-history-20s']);
    expect(polls[0].cookie).toBe('sessionid=synthetic-token; device=synthetic');
  } finally {
    completedTask = false;
  }
}, 10000);

test('generation builds an actual 20000ms upstream payload; retry never lowers explicit 20', async () => {
  submissions.length = 0;
  failure = '积分不足';
  await expect(generateVideoWithRetry(model, 'synthetic', omni, 'synthetic-token')).rejects.toThrow();
  failure = 'captured-before-network';
  expect(submissions).toHaveLength(1);
  const draft = JSON.parse(submissions[0].draft_content);
  const input = draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
  expect(input.duration_ms).toBe(20000);
  expect(input.resolution).toBe('720p');
  expect(submissions[0].extend.m_video_commerce_info.amount).toBe(20);
  expect(submissions[0].maxRetries).toBe(0);
});

test('frame uploads preserve order and a missing tail stops before submission', async () => {
  const filePaths = ['first.png', 'last.png'];
  submissions.length = 0;
  await expect(generateVideo(model, 'synthetic', { duration: 5, filePaths }, 'synthetic-token')).rejects.toThrow('captured-before-network');
  const input = JSON.parse(submissions[0].draft_content).component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
  expect(input.first_frame_image.image_uri).toBe('uploaded:first.png');
  expect(input.end_frame_image.image_uri).toBe('uploaded:last.png');
  submissions.length = 0;
  failedUpload = 'last.png';
  try {
    await expect(generateVideo(model, 'synthetic', { duration: 5, filePaths }, 'synthetic-token')).rejects.toThrow('尾帧上传失败');
    expect(submissions).toHaveLength(0);
  } finally {
    failedUpload = undefined;
  }
});

test('route accepts 20s image omni and reaches generation with the explicit value', async () => {
  submissions.length = 0;
  const request = { body: { model, prompt: 'synthetic', duration: 20, resolution: '720p', function_mode: 'omni_reference', file_paths: omni.filePaths }, headers: { authorization: 'Bearer synthetic' }, validate() { return this; } };
  await expect(routes.post['/generations'](request)).rejects.toThrow('captured-before-network');
  expect(submissions).toHaveLength(1);
  expect(JSON.parse(submissions[0].draft_content).component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0].duration_ms).toBe(20000);
  await expect(routes.post['/generations']({ ...request, body: { ...request.body, function_mode: undefined } })).rejects.toThrow('全能参考');
  expect(submissions).toHaveLength(1);
});

test('controller enforces mode/resolution/media limits even without route', async () => {
  const config = await resolveVideoModelConfig(model);
  for (const duration of [5, 10]) expect(() => validateSeedance25Options(config, { duration })).not.toThrow();
  for (const duration of [5, 20, 30]) expect(() => validateSeedance25Options(config, { ...omni, duration })).not.toThrow();
  for (const options of [{ duration: 20 }, { ...omni, duration: 31 }, { ...omni, duration: 4 }, { ...omni, resolution: '1080p' }, { ...omni, videoPaths: ['video'] }, { ...omni, audioPaths: ['audio'] }, { ...omni, filePaths: [] }]) {
    await expect(generateVideo(model, 'synthetic', options, 'synthetic-token')).rejects.toThrow('Seedance 2.5');
    await expect(generateVideoWithRetry(model, 'synthetic', options, 'synthetic-token')).rejects.toThrow('Seedance 2.5');
  }
});

test('other models retain their existing duration policy', async () => {
  expect((await resolveVideoModelConfig('jimeng-video-seedance-2.0')).supportedDurations).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  expect(() => validateSeedance25Options(getStaticModelConfig('jimeng-video-seedance-2.0', 'video'), { duration: 4, videoPaths: ['video'] })).not.toThrow();
});
