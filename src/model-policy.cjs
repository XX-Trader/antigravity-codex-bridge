'use strict';
const fs = require('node:fs');
const path = require('node:path');
const requiredTiers = ['simple', 'standard', 'complex'];
const tiers = [...requiredTiers, 'expert'];
class ModelPolicyError extends Error {
  constructor(message) { super('[CODEX_MODEL_CONFIGURATION] ' + message); this.code = 'MODEL_CONFIGURATION'; }
}
function selectedModel(value, aliases = {}) {
  const valid = model => typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model);
  if (!valid(value)) throw new Error('model must be a model ID or configured alias');
  const resolved = Object.hasOwn(aliases, value) ? aliases[value] : value;
  if (!valid(resolved)) throw new Error('Configured model alias must resolve to a model ID');
  return resolved;
}
function modelPolicy(env, aliases) {
  if (!env.CODEX_EXECUTOR_EXECUTION_MODELS) return {};
  let map;
  try { map = JSON.parse(env.CODEX_EXECUTOR_EXECUTION_MODELS); } catch { throw new ModelPolicyError('Execution models must be a JSON tier map'); }
  if (!map || Array.isArray(map) || typeof map !== 'object' || requiredTiers.some(k => !Object.hasOwn(map, k)) || Object.keys(map).some(k => !tiers.includes(k))) throw new ModelPolicyError('Configure simple, standard and complex execution tiers, with optional expert only');
  const execution_models = Object.fromEntries(tiers.filter(k => Object.hasOwn(map, k)).map(k => [k, selectedModel(map[k], aliases)]));
  if (env.CODEX_EXECUTOR_MODELS_CACHE && !path.isAbsolute(env.CODEX_EXECUTOR_MODELS_CACHE)) throw new ModelPolicyError('Local account model cache path must be absolute');
  return { execution_models, models_cache_file: env.CODEX_EXECUTOR_MODELS_CACHE || null };
}
function assertAvailable(settings, model) {
  if (!settings.models_cache_file) return;
  let cache;
  try { cache = JSON.parse(fs.readFileSync(settings.models_cache_file, 'utf8')); }
  catch { throw new ModelPolicyError('Cannot read the configured local account model cache; no model started'); }
  if (!Array.isArray(cache.models) || !cache.models.some(row => row.slug === model)) throw new ModelPolicyError(`Model ${model} is absent from the local account model cache; refresh account availability, do not substitute another model`);
}
function assertExecution(settings, model) {
  if (settings.execution_models && !Object.values(settings.execution_models).includes(model)) throw new ModelPolicyError(`Execution model ${model} is outside the configured execution tiers; use execution_tier=simple|standard|complex|expert`);
}
function executionRoute(input, settings, parent) {
  if (input.execution_tier !== undefined && !tiers.includes(input.execution_tier)) throw new ModelPolicyError('execution_tier must be simple, standard, complex or expert');
  const map = settings.execution_models;
  if (input.execution_tier && !map) throw new ModelPolicyError('No execution tier map is configured');
  if (input.execution_tier && !Object.hasOwn(map, input.execution_tier)) throw new ModelPolicyError(`Execution tier ${input.execution_tier} is not configured; do not substitute another tier`);
  const explicit = input.model !== undefined ? selectedModel(input.model, settings.model_aliases) : null;
  if (input.execution_tier && explicit && map[input.execution_tier] !== explicit) throw new ModelPolicyError('model conflicts with execution_tier');
  const model = (input.execution_tier && map[input.execution_tier]) || explicit || parent?.settings?.model || (map ? map.standard : settings.model);
  assertExecution(settings, model);
  const parentAllowed = parent?.settings?.model && (!map || Object.values(map).includes(parent.settings.model));
  if (map && parentAllowed && model !== parent.settings.model && !input.user_followup?.trim()) throw new ModelPolicyError('Changing the model of an existing matter requires the actual human instruction in user_followup; otherwise omit the tier and keep its model');
  return { model: model || null, tier: map ? tiers.find(k => map[k] === model) : null,
    source: input.execution_tier ? 'task_tier' : explicit ? 'compatible_model_parameter' : parent?.settings?.model ? 'session_inherited' : 'default_tier' };
}
function validateJobModels(job, settings) {
  if (!settings.execution_models) return;
  assertExecution(settings, job.settings.model);
  if (job.execution_route && job.execution_route.model !== job.settings.model) throw new ModelPolicyError('Saved execution model disagrees with its route');
  if (job.stage === 'review') {
    const category = job.review_route?.category;
    const expected = settings.review_models?.[category];
    if (!expected || job.review_route.model !== expected) throw new ModelPolicyError('Review model does not match the configured general/quant role');
    assertAvailable(settings, expected);
  } else if (!job.review_only) assertAvailable(settings, job.settings.model);
}
function unsupportedModel(error) {
  // CLI service errors only, before any tool execution; never match command stdout.
  let body;
  const at = typeof error === 'string' ? error.indexOf('{') : -1;
  try { body = JSON.parse(error.slice(at)); } catch { return false; }
  const detail = body.error || body;
  return detail.code === 'model_not_found' && /model.*not supported|model.*not found/i.test(detail.message || '');
}
module.exports = { ModelPolicyError, selectedModel, modelPolicy, executionRoute, assertAvailable, validateJobModels, unsupportedModel };
