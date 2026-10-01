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
  // v1.2 (2026-09-30): 'Caso(s) de Uso' não é mais selecionado automaticamente.
  assert.deepEqual(formFields(metadata), ['NAME', 'COMPANY_TITLE', 'EMAIL', 'UF_EMAIL', 'UF_QTD']);
  assert.deepEqual(formFields(metadata, 'NAME,UF_QTD'), ['NAME', 'UF_QTD']);
  assert.throws(() => formFields(metadata, 'MISSING'), /invalid/);
});
// v1.1 (2026-09-30): teste atualizado para o layout Block Kit (mrkdwn com valores escapados).
test('mensagem preserva dados numéricos zero, lista e empresa vinculada com valores escapados', () => {
  const message = formatMessage({ lead: { ID: '1', NAME: '<!channel>', UF_QTD: 0, UF_CASE: ['3'] },
    user: { NAME: 'Paulo' }, company: { TITLE: 'Acme' }, fields: formFields(metadata), metadata, portal: 'https://example.com' });
  // v1.2 (2026-09-30): UF_CASE ('Caso(s) de Uso') não é mais exibido; removida a expectativa de /Vendas/.
  const sections = message.blocks.filter(b => b.type === 'section');
  const text = sections.map(b => b.text?.text || b.fields.map(f => f.text).join('\n')).join('\n');
  assert.equal(message.blocks[0].type, 'header');
  assert.match(text, /\*Empresa vinculada:\* Acme/);
  assert.match(text, /empresa:\* 0/);
  assert.doesNotMatch(text, /Vendas/);
  assert.match(text, /&lt;!channel&gt;/);
  assert.ok(!text.includes('<!channel>'));
  assert.equal(message.blocks.at(-1).elements[0].url, 'https://example.com/crm/lead/details/1/');
});
// v1.2 (2026-09-30): renomeia nome.lead e oculta campos, inclusive quando listados explicitamente.
test('nome.lead vira "Nome do contato" e campos ocultos não são exibidos', () => {
  const meta = { UF_NOME: { formLabel: 'nome.lead' }, UF_CASE: metadata.UF_CASE,
    UF_EMP: { formLabel: 'Sou/Represento uma Empresa' } };
  const message = formatMessage({ lead: { ID: '3', UF_NOME: 'Ana', UF_CASE: ['3'], UF_EMP: 'Sim' },
    user: { NAME: 'Paulo' }, fields: ['UF_NOME', 'UF_CASE', 'UF_EMP'], metadata: meta, portal: 'https://example.com' });
  const text = message.blocks.filter(b => b.type === 'section' && b.text).map(b => b.text.text).join('\n');
  assert.match(text, /\*Nome do contato:\* Ana/);
  assert.doesNotMatch(text, /nome\.lead|Caso\(s\)|Sou\/Represento|Vendas/);
});
test('formulário longo é fatiado por linhas inteiras e respeita o limite de 3000 do Slack', () => {
  const big = { ...metadata };
  const codes = Array.from({ length: 60 }, (_, i) => `UF_${i}`);
  codes.forEach(c => { big[c] = { title: `Campo ${c}` }; });
  const lead = { ID: '2', TITLE: 'T', ...Object.fromEntries(codes.map(c => [c, 'x'.repeat(200)])) };
  const message = formatMessage({ lead, user: { NAME: 'Paulo' }, fields: codes, metadata: big, portal: 'https://example.com' });
  const texts = message.blocks.filter(b => b.text && b.type === 'section').map(b => b.text.text);
  assert.ok(texts.length > 1);
  assert.ok(texts.every(t => t.length <= 3000));
  assert.ok(texts.join('\n').split('\n').filter(l => l.startsWith('*Campo')).every(l => l.endsWith('x'.repeat(200))));
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

// v1.3 (2026-10-01): normalização de telefone e links do WhatsApp; e-mail exibido uma vez só.
const { normalizeBrPhone, whatsappTemplate } = require('../lib/novos-leads');
test('normaliza telefones brasileiros reais e recusa estrangeiros e lixo', () => {
  const valid = { '11 99780-8847': '5511997808847', '+55 11 99168-8497': '5511991688497',
    '55+(22)99828-2407': '5522998282407', '81.9.89237167': '5581989237167', '5588981504269': '5588981504269',
    '556799455390': '556799455390', '5195585592': '555195585592', '55996268714': '5555996268714',
    '(99)991357990': '5599991357990', '021984277054': '5521984277054', '91.988.483.164': '5591988483164',
    '11 9xxx, +55 11 99168-8497': '5511991688497', '22999919994': '5522999919994' };
  for (const [raw, expected] of Object.entries(valid)) assert.equal(normalizeBrPhone(raw), expected, raw);
  for (const raw of ['Oi', '52', '5,51199E+12', '+595981312252', '+0992113081', '66599635002', '68065298',
    'https://www.linkedin.com/in/x/', '', null]) assert.equal(normalizeBrPhone(raw), null, String(raw));
});
test('mensagem traz links do WhatsApp com template e e-mail sem duplicar', () => {
  const meta = { EMAIL: { title: 'E-mail' }, UF_EMAIL: { formLabel: 'email.lead' },
    UF_NOME: { formLabel: 'nome.lead' }, UF_WHATS: { formLabel: 'Número de seu WhatsApp com ddd' } };
  const lead = { ID: '25359', EMAIL: [{ VALUE: 'bruno@example.com' }], UF_EMAIL: 'bruno@example.com',
    UF_NOME: 'bruno teste', UF_WHATS: '(22) 99991-9994' };
  const message = formatMessage({ lead, user: { NAME: 'Gabriella', LAST_NAME: 'Salles' },
    fields: ['EMAIL', 'UF_EMAIL', 'UF_NOME', 'UF_WHATS'], metadata: meta, portal: 'https://example.com' });
  const text = message.blocks.filter(b => b.type === 'section' && b.text).map(b => b.text.text).join('\n');
  assert.equal(text.match(/bruno@example\.com/g).length, 1);
  assert.doesNotMatch(text, /email\.lead/);
  // v1.4 (2026-10-01): o campo do WhatsApp não é exibido, mas alimenta os links.
  assert.doesNotMatch(text, /Número de seu WhatsApp/);
  assert.match(text, /<https:\/\/wa\.me\/5522999919994\|wa\.me\/5522999919994>/);
  const url = text.match(/<(https:\/\/web\.whatsapp\.com\/send\?[^|>]+)\|/)[1];
  const params = new URL(url).searchParams;
  assert.equal(params.get('phone'), '5522999919994');
  assert.equal(params.get('text'), whatsappTemplate('Bruno', 'Gabriella'));
  assert.equal(params.get('text'), 'Olá, Bruno!\nAqui é o Gabriella da Zapper.\n\nRecebi seu contato em nosso site.\n\n'
    + 'Hoje qual desafio você está buscando resolver com a ajuda da Zapper?\nFique à vontade pra enviar em áudio caso seja mais prático!');
});
test('sem E-mail padrão, email.lead aparece como E-mail; número inválido não gera link', () => {
  const meta = { EMAIL: { title: 'E-mail' }, UF_EMAIL: { formLabel: 'email.lead' } };
  const message = formatMessage({ lead: { ID: '1', UF_EMAIL: 'a@b.com', PHONE: [{ VALUE: 'Oi' }] },
    user: { NAME: 'Paulo' }, fields: ['EMAIL', 'UF_EMAIL'], metadata: meta, portal: 'https://example.com' });
  const text = message.blocks.filter(b => b.type === 'section' && b.text).map(b => b.text.text).join('\n');
  assert.match(text, /\*E-mail:\* a@b\.com/);
  assert.match(text, /não reconhecido/);
  assert.doesNotMatch(text, /wa\.me/);
});
