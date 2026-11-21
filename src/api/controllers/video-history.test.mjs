import assert from 'node:assert/strict';
import test from 'node:test';

import { videoHistoryRecord } from './video-history.ts';

test('reads the keyed history shape returned by Jimeng', () => {
  const completed = { status: 50, item_list: [{ video: { transcoded_video: { origin: { video_url: 'https://example.com/generated.mp4' } } } }] };
  assert.equal(videoHistoryRecord({ '47583557761292': completed }, '47583557761292'), completed);
});

test('keeps compatibility with list history shapes', () => {
  const pending = { status: 20, item_list: [] };
  assert.equal(videoHistoryRecord({ history_list: [pending] }, 42), pending);
  assert.equal(videoHistoryRecord({ history_records: [pending] }, 42), pending);
  assert.equal(videoHistoryRecord({}, 42), undefined);
});
