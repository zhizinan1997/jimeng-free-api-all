import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { requestDisconnectSignal } from './request-disconnect.ts';

test('normal response finish removes listeners without cancelling', () => {
  const response = new EventEmitter();
  const signal = requestDisconnectSignal(response);
  response.writableFinished = true; response.emit('finish'); response.emit('close');
  assert.equal(signal.aborted, false);
  assert.equal(response.listenerCount('close') + response.listenerCount('finish'), 0);
});
test('client disconnect and already closed response both abort and release listeners', () => {
  for (const alreadyClosed of [false, true]) {
    const response = new EventEmitter(); response.destroyed = alreadyClosed;
    const signal = requestDisconnectSignal(response);
    if (!alreadyClosed) response.emit('close');
    assert.equal(signal.aborted, true);
    assert.equal(response.listenerCount('close') + response.listenerCount('finish'), 0);
  }
});
