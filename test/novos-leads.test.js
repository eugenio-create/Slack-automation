'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { poll, channelName, resolveStage, formFields, formatMessage } = require('../lib/novos-leads');
const { createHandler } = require('../api/notificar-novos-leads');
const { createClients, IntegrationError } = require('../lib/novos-leads-clients');

const metadata = { NAME: { title: 'Nome' }, COMPANY_TITLE: { title: 'Empresa' },
  EMAIL: { title: 'Email' }, UF_EMAIL: { formLabel: 'email.lead' },
  UF_QTD: { formLabel: 'Quantidade de contas de WhatsApp em sua empresa' },
  UF_CASE: { formLabel: 'Caso(s) de Uso', items: [{ ID: '3', VALUE: 'Vendas' }] },
  UF_INTERNAL: { title: 'Anotação interna' } };

function fixture(options = {}) {
  const records = new Map();
  let locked = false, initialized = options.initialized ?? true, cursor = '0', tick = 100000;
  const calls = [];
  const leads = options.leads || [{ ID: '11', STATUS_ID: 'IN_PROCESS', ASSIGNED_BY_ID: '295',
    TITLE: 'Formulário CRM', COMPANY_ID: '44', UF_EMAIL: 'teste@example.com', UF_QTD: 7 }];
  const clients = {
    portal: 'https://example.bitrix24.com.br',
    fields: async () => metadata,
    stages: async () => [{ STATUS_ID: 'IN_PROCESS', NAME: '1º Contato em andamento' }],
    page: async (stage, after) => leads.filter(l => BigInt(l.ID) > BigInt(after) && l.STATUS_ID === stage).slice(0, options.pageSize || 50),
    lead: async id => ({ ...leads.find(l => l.ID === id) }),
    user: async id => ({ ID: id, NAME: 'Paulo Vitor', LAST_NAME: 'Santos' }),
    company: async () => ({ TITLE: 'Empresa vinculada' }),
    channels: async () => [{ id: 'C1', name: 'novosleads-paulo-vitor-santos', is_member: true }],
    post: async (...args) => { calls.push(args); return '123.456'; }
  };
  const store = {
    acquire: async () => { if (locked) return false; locked = true; return true; },
    renew: async () => {}, release: async () => { locked = false; },
    initialized: async () => initialized,
    initialize: async ids => { ids.forEach(id => records.set(id, { state: 'baseline' })); initialized = true; },
    cursor: async () => cursor, setCursor: async id => { cursor = id; },
    getMany: async ids => new Map(ids.map(id => [id, records.get(id)])),
    reserve: async (id, record) => { if (records.has(id)) return false; records.set(id, record); return true; },
    put: async (id, record) => { records.set(id, record); }, remove: async id => { records.delete(id); }
  };
  const run = extra => poll({ clients, store, stageId: 'IN_PROCESS', now: () => tick,
    sleep: async ms => { tick += ms; }, ...extra });
  return { clients, store, run, calls, records, leads, advance: ms => { tick += ms; } };
}

test('correlaciona o nome completo, acentos e espaços com o canal exato', () => {
  assert.equal(channelName({ NAME: ' Paulo Vítor ', LAST_NAME: 'Santos' }), 'novosleads-paulo-vitor-santos');
  assert.equal(channelName({ NAME: 'Marcos', LAST_NAME: 'Hernandes' }), 'novosleads-marcos-hernandes');
  assert.throws(() => channelName({}), /invalid_responsible/);
});
test('descobre a etapa pelo nome e recusa ambiguidade em vez de adivinhar', () => {
  const stages = [{ STATUS_ID: 'X', NAME: '1º Contato em andamento' }, { STATUS_ID: 'Y', NAME: '1º contato pendente' }];
  assert.throws(() => resolveStage(stages), /configure/);
  assert.equal(resolveStage(stages, 'Y'), 'Y');
  assert.equal(resolveStage(stages.slice(0, 1)), 'X');
});
test('campos do formulário são explícitos; não inclui campos internos automaticamente', () => {
  assert.deepEqual(formFields(metadata), ['NAME', 'COMPANY_TITLE', 'EMAIL', 'UF_EMAIL', 'UF_QTD', 'UF_CASE']);
  assert.deepEqual(formFields(metadata, 'NAME,UF_QTD'), ['NAME', 'UF_QTD']);
  assert.throws(() => formFields(metadata, 'MISSING'), /invalid/);
});
test('mensagem preserva dados numéricos zero, lista e empresa vinculada em plain_text', () => {
  const message = formatMessage({ lead: { ID: '1', NAME: '<!channel>', UF_QTD: 0, UF_CASE: ['3'] },
    user: { NAME: 'Paulo' }, company: { TITLE: 'Acme' }, fields: formFields(metadata), metadata, portal: 'https://example.com' });
  const text = message.blocks.filter(b => b.type === 'section').map(b => b.text.text).join('');
  assert.match(text, /Empresa vinculada: Acme/);
  assert.match(text, /empresa: 0/);
  assert.match(text, /Vendas/);
  assert.ok(message.blocks.filter(b => b.type === 'section').every(b => b.text.type === 'plain_text'));
  assert.equal(message.blocks.at(-1).elements[0].url, 'https://example.com/crm/lead/details/1/');
});
test('envia uma vez, persiste recibo e não repete em novas execuções', async () => {
  const f = fixture();
  assert.equal((await f.run()).sent, 1);
  assert.equal((await f.run()).sent, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.records.get('11').state, 'sent');
  assert.equal(f.records.get('11').ts, '123.456');
});
test('busca o responsável atual, não o da listagem', async () => {
  const f = fixture();
  f.clients.user = async () => ({ ID: '593', NAME: 'Marcos', LAST_NAME: 'Hernandes' });
  f.leads[0].ASSIGNED_BY_ID = '593';
  f.clients.channels = async () => [{ id: 'C2', name: 'novosleads-marcos-hernandes', is_member: true }];
  await f.run();
  assert.equal(f.calls[0][0], 'C2');
});
test('se responsável mudar durante a consulta, adia sem marcar como enviado', async () => {
  const f = fixture(); let reads = 0;
  f.clients.lead = async () => ({ ...f.leads[0], ASSIGNED_BY_ID: ++reads === 1 ? '295' : '593' });
  assert.equal((await f.run()).deferred, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.records.size, 0);
});
test('não envia lead que saiu da etapa antes do envio', async () => {
  const f = fixture();
  f.clients.lead = async () => ({ ...f.leads[0], STATUS_ID: 'JUNK' });
  await f.run(); assert.equal(f.calls.length, 0);
});
test('canal ausente não perde o lead; tenta em uma próxima varredura', async () => {
  const f = fixture(); const normal = f.clients.channels;
  f.clients.channels = async () => [];
  assert.equal((await f.run()).ok, false); assert.equal(f.records.size, 0);
  f.clients.channels = normal;
  assert.equal((await f.run()).sent, 1);
});
test('bootstrap baseline não envia estoque; novas entradas são enviadas', async () => {
  const f = fixture({ initialized: false });
  assert.equal((await f.run()).baseline, 1); assert.equal(f.calls.length, 0);
  f.leads.push({ ...f.leads[0], ID: '12' });
  assert.equal((await f.run()).sent, 1); assert.match(f.calls[0][1].text, /#12/);
});
test('bootstrap all inclui estoque existente', async () => {
  const f = fixture({ initialized: false }); assert.equal((await f.run({ mode: 'all' })).sent, 1);
});
test('falha de paginação no bootstrap não grava baseline parcial', async () => {
  const f = fixture({ initialized: false }); let n = 0;
  f.clients.page = async () => { if (++n === 1) return f.leads; throw new Error('bitrix_api_error'); };
  await assert.rejects(f.run(), /bitrix/); assert.equal(await f.store.initialized(), false);
  assert.equal(f.records.size, 0);
});
test('pagina todos os resultados e respeita o intervalo por canal', async () => {
  const f = fixture({ pageSize: 1, leads: ['1', '2', '3'].map(ID => ({ ID, STATUS_ID: 'IN_PROCESS', ASSIGNED_BY_ID: '295' })) });
  assert.equal((await f.run()).sent, 3); assert.equal(f.calls.length, 3);
});
test('execuções concorrentes não duplicam', async () => {
  const f = fixture();
  const results = await Promise.all([f.run(), f.run()]);
  assert.equal(f.calls.length, 1); assert.ok(results.some(r => r.busy));
});
test('erro definitivo do Slack permite nova tentativa', async () => {
  const f = fixture(); const post = f.clients.post;
  f.clients.post = async () => { throw new IntegrationError('slack_http_429', true); };
  assert.equal((await f.run()).ok, false); assert.equal(f.records.size, 0);
  f.clients.post = post; assert.equal((await f.run()).sent, 1);
});
test('resposta ambígua do Slack não é reenviada automaticamente', async () => {
  const f = fixture(); let attempts = 0;
  f.clients.post = async () => { attempts++; throw new IntegrationError('slack_transport'); };
  await f.run(); assert.equal(f.records.get('11').state, 'uncertain');
  assert.equal((await f.run()).uncertain, 1); assert.equal(attempts, 1);
});
test('falha no recibo persistente após sucesso não causa duplicação', async () => {
  const f = fixture(); const put = f.store.put;
  f.store.put = async () => { throw new Error('redis_api_error'); };
  await assert.rejects(f.run(), /redis/);
  f.store.put = put; await f.run(); assert.equal(f.calls.length, 1);
  assert.equal(f.records.get('11').state, 'sending');
});
test('dry run valida canais e campos sem enviar, iniciar baseline ou marcar leads', async () => {
  const f = fixture({ initialized: false }); const result = await f.run({ dryRun: true });
  assert.equal(result.preview[0].channel, 'novosleads-paulo-vitor-santos');
  assert.equal(f.calls.length, 0); assert.equal(f.records.size, 0);
  assert.equal(await f.store.initialized(), false);
});
test('continua do cursor quando acaba o tempo', async () => {
  const f = fixture({ leads: ['1','2'].map(ID => ({ ID, STATUS_ID: 'IN_PROCESS', ASSIGNED_BY_ID: '295' })) });
  const post = f.clients.post;
  f.clients.post = async (...args) => { f.advance(20000); return post(...args); };
  assert.equal((await f.run()).sent, 1); assert.equal(await f.store.cursor(), '1');
  assert.equal((await f.run()).sent, 1); assert.equal(f.calls.length, 2);
});

function response() {
  return { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
test('endpoint recusa chamada sem segredo e fica desativado por padrão', async () => {
  const handler = createHandler({ env: { NOVOS_LEADS_SECRET: 'secret' } });
  const a = response(); await handler({ method: 'POST', headers: {} }, a); assert.equal(a.code, 401);
  const b = response(); await handler({ method: 'POST', headers: { 'x-notif-secret': 'secret' } }, b); assert.equal(b.code, 503);
});
test('endpoint responde erro HTTP em falha operacional, sem dados do formulário', async () => {
  const f = fixture(); f.clients.channels = async () => [];
  const env = Object.fromEntries(['BITRIX_WEBHOOK','SLACK_BOT_TOKEN','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN'].map(k => [k, 'configured']));
  const handler = createHandler({ env: { ...env, NOVOS_LEADS_SECRET: 'secret', NOVOS_LEADS_ENABLED: 'true' },
    clientsFactory: () => f.clients, storeFactory: () => f.store });
  const res = response(); await handler({ method: 'POST', headers: { 'x-notif-secret': 'secret' } }, res);
  assert.equal(res.code, 502); assert.ok(!JSON.stringify(res.body).includes('teste@example.com'));
});
test('cliente pagina canais mesmo quando uma página está vazia', async () => {
  const requests = [];
  const fakeFetch = async (url, opts) => {
    requests.push({ url: new URL(url), opts });
    return { ok: true, json: async () => requests.length === 1
      ? { ok: true, channels: [], response_metadata: { next_cursor: 'next' } }
      : { ok: true, channels: [{ id: 'C1' }], response_metadata: { next_cursor: '' } } };
  };
  const clients = createClients({ BITRIX_WEBHOOK: 'https://example.com/rest/1/secret/', UPSTASH_REDIS_REST_URL: 'https://redis.example.com', SLACK_BOT_TOKEN: 'test-token' }, fakeFetch);
  assert.equal((await clients.channels()).length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].opts.method, 'GET');
  assert.equal(requests[0].opts.body, undefined);
  assert.equal(requests[0].opts.headers.Authorization, 'Bearer test-token');
  assert.equal(requests[0].url.searchParams.get('cursor'), null);
  assert.equal(requests[1].url.searchParams.get('cursor'), 'next');
  assert.equal(requests[1].url.searchParams.get('types'), 'public_channel,private_channel');
});
