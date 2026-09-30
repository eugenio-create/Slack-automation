'use strict';

const { timingSafeEqual, createHash } = require('node:crypto');
const { createClients, createStore } = require('../lib/novos-leads-clients');
const { resolveStage, poll } = require('../lib/novos-leads');

function authorized(req, expected) {
  const supplied = req.headers?.['x-notif-secret'] || String(req.headers?.authorization || '').replace(/^Bearer /, '');
  if (!expected || typeof supplied !== 'string' || !supplied) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(supplied));
}

function createHandler({ env = process.env, clientsFactory = createClients, storeFactory = createStore } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ ok: false, code: 'method_not_allowed' });
    if (!authorized(req, env.NOVOS_LEADS_SECRET)) return res.status(401).json({ ok: false, code: 'unauthorized' });
    if (env.NOVOS_LEADS_ENABLED !== 'true') return res.status(503).json({ ok: false, code: 'not_enabled' });
    const runtimeEnv = { ...env,
      UPSTASH_REDIS_REST_URL: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL,
      UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN };
    const missing = ['BITRIX_WEBHOOK', 'SLACK_BOT_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
      .filter(key => !runtimeEnv[key]);
    if (missing.length) return res.status(503).json({ ok: false, code: 'missing_configuration', missing });
    const mode = env.NOVOS_LEADS_INITIAL_MODE || 'baseline';
    if (!['baseline', 'all'].includes(mode)) return res.status(503).json({ ok: false, code: 'invalid_initial_mode' });
    try {
      const clients = clientsFactory(runtimeEnv);
      const stageId = resolveStage(await clients.stages(), env.NOVOS_LEADS_STATUS_ID);
      const store = storeFactory(clients.redis, clients.portal, stageId);
      const result = await poll({ clients, store, stageId, mode,
        configuredFields: env.NOVOS_LEADS_FORM_FIELDS, dryRun: req.query?.dryRun === '1' });
      // No form values or credentials in execution logs.
      console.log('[NOVOS_LEADS]', JSON.stringify(result));
      return res.status(result.ok ? 200 : 502).json({ ...result, stageId });
    } catch (error) {
      const known = /^(bitrix_|slack_|redis_|configure_|invalid_|ambiguous_|time_budget|form_too_long)/;
      const code = known.test(error.message) && /^[a-zA-Z0-9_]+$/.test(error.message) ? error.message : 'integration_error';
      console.error('[NOVOS_LEADS]', code);
      return res.status(502).json({ ok: false, code });
    }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
