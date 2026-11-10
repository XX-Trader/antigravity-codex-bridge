'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelPolicy, executionRoute, validateJobModels } = require('../src/model-policy.cjs');
const aliases = { reviewer: 'review-model', worker: 'work-model' };
const env = { CODEX_EXECUTOR_REVIEW_ONLY_MODELS: '["reviewer","review-model"]', CODEX_EXECUTOR_EXECUTION_MODELS: '{"simple":"worker","standard":"worker","complex":"worker","expert":"reviewer"}' };
function settings(extra = {}) { return { ...modelPolicy(env, aliases), model_aliases: aliases, model: 'work-model', review_models: { general: 'review-model' }, ...extra }; }
test('review-only list resolves aliases, deduplicates and validates JSON', () => {
  assert.deepEqual(modelPolicy(env, aliases).review_only_models, ['review-model']);
  assert.deepEqual(modelPolicy({}, aliases).review_only_models, []);
  assert.throws(() => modelPolicy({ CODEX_EXECUTOR_REVIEW_ONLY_MODELS: '{}' }, aliases), /JSON array/);
  assert.throws(() => modelPolicy({ CODEX_EXECUTOR_REVIEW_ONLY_MODELS: '[null]' }, aliases), /model ID/);
});
test('explicit, tier and inherited review-only models cannot execute', () => {
  const policy = settings();
  assert.throws(() => executionRoute({ model: 'reviewer' }, policy), /review-only/);
  assert.throws(() => executionRoute({ execution_tier: 'expert' }, policy), /review-only/);
  const parent = { settings: { model: 'review-model' } };
  assert.throws(() => executionRoute({}, policy, parent), /review-only/);
  assert.throws(() => executionRoute({ model: 'worker' }, policy, parent), /user_followup/);
  assert.equal(executionRoute({ model: 'worker', user_followup: '请改用执行模型' }, policy, parent).model, 'work-model');
});
test('review-only parent model does not become an execution model', () => {
  const parent = { review_only: true, settings: { model: 'review-model' } };
  const route = executionRoute({}, settings(), parent);
  assert.equal(route.model, 'work-model');
  assert.equal(route.source, 'default_tier');
});
test('no execution map still enforces review-only policy', () => {
  const policy = { ...modelPolicy({ CODEX_EXECUTOR_REVIEW_ONLY_MODELS: '["reviewer"]' }, aliases), model_aliases: aliases, model: 'work-model' };
  assert.throws(() => executionRoute({ model: 'reviewer' }, policy), /review-only/);
  assert.throws(() => executionRoute({}, policy, { settings: { model: 'review-model' } }), /review-only/);
  assert.throws(() => validateJobModels({ stage: 'execute', settings: { model: 'review-model' } }, policy), /review-only/);
});
test('persisted jobs are checked at execution, while valid review route is allowed', () => {
  const policy = settings();
  const job = { stage: 'review', review_only: true, settings: { model: 'review-model' }, review_route: { category: 'general', model: 'review-model' } };
  assert.doesNotThrow(() => validateJobModels(job, policy));
  assert.throws(() => validateJobModels({ ...job, stage: 'execute', review_only: false }, policy), /review-only/);
  assert.throws(() => validateJobModels({ ...job, review_route: { category: 'general', model: 'other' } }, policy), /Review model/);
});
