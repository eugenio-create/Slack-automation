'use strict';

const { createHash, randomUUID } = require('node:crypto');

class IntegrationError extends Error {
  constructor(code, definitive = false) {
    super(code);
    this.code = code;
    this.definitive = definitive;
  }
}

// Never expose upstream bodies, webhook URLs or tokens in responses/logs.
async function requestJson(url, options, service, fetchImpl = fetch, deadline = Infinity) {
  const timeout = Math.min(4000, deadline - Date.now());
  if (timeout <= 0) throw new IntegrationError('time_budget');
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeout), redirect: 'error' });
  } catch {
    throw new IntegrationError(`${service}_transport`);
  }
  if (!response.ok) {
    throw new IntegrationError(`${service}_http_${response.status}`, response.status === 429);
  }
  try { return await response.json(); }
  catch { throw new IntegrationError(`${service}_invalid_json`); }
}

function createClients(env = process.env, fetchImpl = fetch) {
  const deadline = Date.now() + 50000;
  const base = new URL(env.BITRIX_WEBHOOK);
  if (base.protocol !== 'https:' || !base.pathname.includes('/rest/')) throw new Error('invalid_bitrix_url');
  base.pathname = base.pathname.replace(/\/?$/, '/');
  base.search = '';
  const redisUrl = new URL(env.UPSTASH_REDIS_REST_URL);
  if (redisUrl.protocol !== 'https:') throw new Error('invalid_redis_url');

  async function bitrix(method, params = {}) {
    const data = await requestJson(new URL(`${method}.json`, base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
    }, 'bitrix', fetchImpl, deadline);
    if (data.error || data.result === undefined) throw new IntegrationError('bitrix_api_error');
    return data;
  }

  async function slack(method, params) {
    const listChannels = method === 'conversations.list';
    const url = new URL(`https://slack.com/api/${method}`);
    if (listChannels) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== '') url.searchParams.set(key, String(value));
      }
    }
    const data = await requestJson(url, listChannels ? {
      method: 'GET', headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }
    } : {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(params)
    }, 'slack', fetchImpl, deadline);
    if (!data.ok) {
      const known = new Set(['ratelimited', 'not_in_channel', 'channel_not_found', 'is_archived',
        'missing_scope', 'invalid_auth', 'token_revoked', 'account_inactive', 'no_text', 'msg_too_long']);
      throw new IntegrationError(known.has(data.error) ? `slack_${data.error}` : 'slack_api_error', known.has(data.error));
    }
    return data;
  }

  return {
    portal: base.origin,
    async stages() { return (await bitrix('crm.status.list', { filter: { ENTITY_ID: 'STATUS' } })).result; },
    async fields() { return (await bitrix('crm.lead.fields')).result; },
    async page(stageId, after = '0') {
      const data = await bitrix('crm.lead.list', {
        filter: { '=STATUS_ID': stageId, '>ID': after }, order: { ID: 'ASC' },
        select: ['ID'], start: 0
      });
      if (!Array.isArray(data.result)) throw new IntegrationError('bitrix_invalid_leads');
      return data.result;
    },
    async lead(id) { return (await bitrix('crm.lead.get', { id })).result; },
    async company(id) { return (await bitrix('crm.company.get', { id })).result; },
    async user(id) {
      const users = (await bitrix('user.get', { ID: id })).result;
      const user = Array.isArray(users) && users.find(u => String(u.ID) === String(id));
      if (!user) throw new IntegrationError('responsible_not_found');
      return user;
    },
    async channels(checkBudget = () => {}) {
      const channels = [];
      const cursors = new Set();
      let cursor = '';
      do {
        checkBudget();
        const data = await slack('conversations.list', {
          types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor
        });
        channels.push(...(data.channels || []));
        cursor = data.response_metadata?.next_cursor || '';
        if (cursor && cursors.has(cursor)) throw new IntegrationError('slack_repeated_cursor');
        cursors.add(cursor);
      } while (cursor);
      return channels;
    },
    async post(channel, message, clientMsgId) {
      const result = await slack('chat.postMessage', {
        channel, ...message, client_msg_id: clientMsgId,
        unfurl_links: false, unfurl_media: false, parse: 'none', link_names: false
      });
      if (!result.ts) throw new IntegrationError('slack_missing_receipt');
      return result.ts;
    },
    async redis(command) {
      const data = await requestJson(redisUrl, {
        method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
      }, 'redis', fetchImpl, deadline);
      if (data.error || data.result === undefined) throw new IntegrationError('redis_api_error');
      return data.result;
    }
  };
}

function createStore(redis, portal, stageId) {
  const prefix = `novosleads:v1:${createHash('sha256').update(`${portal}/${stageId}`).digest('hex').slice(0, 24)}`;
  const token = randomUUID();
  const lock = `${prefix}:lock`;
  const records = `${prefix}:records`;
  const initialized = `${prefix}:initialized`;
  const cursor = `${prefix}:cursor`;
  const evalLocked = (script, keys, args = []) => redis(['EVAL',
    `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return redis.error_reply('lock_lost') end; ${script}`,
    keys.length + 1, lock, ...keys, token, ...args]);
  return {
    async acquire() { return (await redis(['SET', lock, token, 'NX', 'EX', 120])) === 'OK'; },
    async renew() { await evalLocked("return redis.call('EXPIRE',KEYS[1],120)", []); },
    async release() {
      await redis(['EVAL', "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0", 1, lock, token]);
    },
    async initialized() { return !!(await redis(['GET', initialized])); },
    async initialize(ids) {
      // Commit the entire baseline and marker atomically. A failed scan never suppresses new leads.
      await evalLocked("if redis.call('EXISTS',KEYS[3]) == 1 then return 0 end; for i=2,#ARGV do redis.call('HSETNX',KEYS[2],ARGV[i],'{\"state\":\"baseline\"}') end; redis.call('SET',KEYS[3],'1'); return 1", [records, initialized], ids);
    },
    async cursor() { return (await redis(['GET', cursor])) || '0'; },
    async setCursor(id) { await evalLocked("return redis.call('SET',KEYS[2],ARGV[2])", [cursor], [String(id)]); },
    async getMany(ids) {
      if (!ids.length) return new Map();
      const values = await redis(['HMGET', records, ...ids.map(String)]);
      return new Map(ids.map((id, i) => [String(id), values[i] ? JSON.parse(values[i]) : null]));
    },
    async reserve(id, record) {
      return (await evalLocked("return redis.call('HSETNX',KEYS[2],ARGV[2],ARGV[3])", [records], [String(id), JSON.stringify(record)])) === 1;
    },
    async put(id, record) { await evalLocked("return redis.call('HSET',KEYS[2],ARGV[2],ARGV[3])", [records], [String(id), JSON.stringify(record)]); },
    async remove(id) { await evalLocked("return redis.call('HDEL',KEYS[2],ARGV[2])", [records], [String(id)]); }
  };
}

module.exports = { createClients, createStore, IntegrationError };
