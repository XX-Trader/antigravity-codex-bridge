'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startUsage, recordUsage, usageFields } = require('../src/usage.cjs');

test('new session, multiple events, review to execute and resume keep latest cumulative usage', () => {
  const state = startUsage({});
  recordUsage(state, 'thread-a', { input_tokens: 100, output_tokens: 3 }, true);
  recordUsage(state, 'thread-a', { input_tokens: 120, output_tokens: 4 });
  // Round-trip persistence, as on a worker restart after review or background wait.
  const resumed = startUsage({ thread_id: 'thread-a', usage_accounting: JSON.parse(JSON.stringify(state)) });
  recordUsage(resumed, 'thread-a', { input_tokens: 150, output_tokens: 5 });
  assert.deepEqual(usageFields(resumed).usage, { input_tokens: 150, output_tokens: 5 });
  assert.deepEqual(usageFields(resumed).usage_delta, { input_tokens: 150, output_tokens: 5 });
});

test('inherited session has unknown task delta and never sums historical snapshots', () => {
  const state = startUsage({ thread_id: 'inherited' });
  for (const input_tokens of [356187323, 361227928, 390632002]) recordUsage(state, 'inherited', { input_tokens });
  assert.equal(usageFields(state).usage.input_tokens, 390632002);
  assert.equal(usageFields(state).usage_delta, null);
  assert.equal(state.sessions.inherited.baseline, null);
});

test('separate thread snapshots are counted once each and raw inputs are untouched', () => {
  const state = startUsage({});
  const raw = { input_tokens: 20, cached_input_tokens: 10 };
  recordUsage(state, 'a', raw, true);
  recordUsage(state, 'b', { input_tokens: 30 }, true);
  recordUsage(state, 'a', { input_tokens: 25, cached_input_tokens: 12 });
  assert.equal(usageFields(state).usage.input_tokens, 55);
  assert.deepEqual(raw, { input_tokens: 20, cached_input_tokens: 10 });
});

test('failure without usage preserves snapshot; malformed numbers and missing identity stay explicit', () => {
  const state = startUsage({});
  recordUsage(state, 'a', { input_tokens: 20 }, true);
  recordUsage(state, 'a', undefined);
  recordUsage(state, 'a', { input_tokens: NaN, output_tokens: -1 });
  assert.equal(usageFields(state).usage.input_tokens, 20);
  recordUsage(state, null, { input_tokens: 40 });
  recordUsage(state, null, { input_tokens: 50 });
  assert.deepEqual(state.unattributed, { input_tokens: 50 });
  assert.equal(usageFields(state).usage_delta, null);
});

test('counter regression invalidates delta instead of inventing consumption', () => {
  const state = startUsage({});
  recordUsage(state, 'a', { input_tokens: 100 }, true);
  recordUsage(state, 'a', { input_tokens: 10 });
  assert.equal(state.sessions.a.counter_reset, true);
  assert.equal(usageFields(state).usage_delta, null);
  assert.equal(usageFields(state).usage.input_tokens, 10);
});

test('legacy aggregate is audit-only and is never used as a resume baseline', () => {
  const state = startUsage({ thread_id: 'a', usage: { input_tokens: 4502697969 } });
  recordUsage(state, 'a', { input_tokens: 390632002 });
  assert.equal(usageFields(state).usage.input_tokens, 390632002);
  assert.equal(state.legacy_usage.input_tokens, 4502697969);
  assert.equal(usageFields(state).usage_delta, null);
});
