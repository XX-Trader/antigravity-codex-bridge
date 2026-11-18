'use strict';

// CLI usage is a cumulative session snapshot, including history on resume.
// Keep one latest snapshot per native thread; never sum attempts of that thread.
function snapshot(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, n]) => Number.isSafeInteger(n) && n >= 0));
}
function startUsage(job) {
  if (job.usage_accounting?.version === 1) return structuredClone(job.usage_accounting);
  const state = { version: 1, scope: 'session_cumulative', sessions: {}, inherited_thread: job.thread_id || null };
  // Old attempts lack thread identity. Do not silently infer a baseline or trust
  // their historically summed job.usage. Retain that value for audit only.
  if (job.usage) state.legacy_usage = job.usage;
  return state;
}
function recordUsage(state, thread, value, freshThread = false) {
  const latest = snapshot(value);
  if (!Object.keys(latest).length) return state;
  if (!thread) { state.unattributed = latest; return state; }
  const prior = Object.hasOwn(state.sessions, thread) ? state.sessions[thread] : null;
  const regressed = prior && Object.entries(latest).some(([k, n]) => prior.latest[k] !== undefined && n < prior.latest[k]);
  Object.defineProperty(state.sessions, thread, { enumerable: true, configurable: true, writable: true, value: {
    latest,
    baseline: regressed ? null : prior ? prior.baseline : freshThread ? {} : null,
    ...(regressed || prior?.counter_reset ? { counter_reset: true } : {})
  } });
  return state;
}
function usageFields(state) {
  const usage = {}, delta = {};
  const rows = Object.values(state.sessions);
  let known = rows.length > 0 && !state.unattributed && !state.legacy_usage;
  for (const row of rows) {
    if (row.baseline === null || row.counter_reset) known = false;
    for (const [k, n] of Object.entries(row.latest)) {
      usage[k] = (usage[k] || 0) + n;
      delta[k] = (delta[k] || 0) + n - (row.baseline?.[k] || 0);
    }
  }
  // Missing thread identity remains explicitly unattributed, not an invented
  // independent session to be added on every retry.
  return { usage_accounting: state, usage_scope: rows.length ? state.scope : state.legacy_usage ? 'legacy_unverified' : 'unattributed', usage_delta: known ? delta : null,
    ...(Object.keys(usage).length ? { usage } : {}) };
}
module.exports = { startUsage, recordUsage, usageFields };
