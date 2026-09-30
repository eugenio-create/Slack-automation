'use strict';

const { randomUUID } = require('node:crypto');

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function channelName(user) {
  const full = [user.NAME, user.SECOND_NAME, user.LAST_NAME].filter(Boolean).join(' ');
  const slug = normalize(full).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug || slug.length > 69) throw new Error('invalid_responsible_name');
  return `novosleads-${slug}`;
}
function resolveStage(stages, configuredId) {
  const candidates = stages.filter(s => configuredId
    ? String(s.STATUS_ID) === configuredId
    : ['1º contato pendente', '1º contato em andamento'].includes(normalize(s.NAME)));
  if (candidates.length !== 1) throw new Error('configure_NOVOS_LEADS_STATUS_ID');
  return String(candidates[0].STATUS_ID);
}

const DEFAULT_LABELS = [
  'nome.lead', 'email.lead', 'Work Email', 'Número de seu WhatsApp com ddd',
  'Quantidade de contas de WhatsApp em sua empresa', 'Quantidade de contas de WhatsApp em sua empresa(S)',
  'Quantidade de contas de WhatsApp a monitorar(FB)', 'Caso(s) de Uso', 'Outros Casos de Uso',
  'Sou/Represento uma Empresa', 'O que você busca resolver com Zapper? - Facebook'
];
const STANDARD_FIELDS = ['NAME', 'SECOND_NAME', 'LAST_NAME', 'COMPANY_TITLE', 'EMAIL', 'PHONE', 'WEB'];
function formFields(metadata, configured) {
  if (configured) {
    const codes = configured.split(',').map(v => v.trim()).filter(Boolean);
    if (!codes.length || codes.some(code => !metadata[code])) throw new Error('invalid_NOVOS_LEADS_FORM_FIELDS');
    return [...new Set(codes)];
  }
  const codes = STANDARD_FIELDS.filter(code => metadata[code]);
  for (const label of DEFAULT_LABELS) {
    const matches = Object.entries(metadata).filter(([, f]) =>
      [f.title, f.formLabel, f.listLabel].some(text => normalize(text) === normalize(label)));
    if (matches.length > 1) throw new Error('ambiguous_form_field_configure_codes');
    if (matches.length) codes.push(matches[0][0]);
  }
  return [...new Set(codes)];
}
function valueText(value, field = {}) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(v => valueText(v, field)).filter(Boolean).join(', ');
  if (typeof value === 'object') return valueText(value.VALUE ?? '', field);
  const item = (field.items || []).find(v => String(v.ID) === String(value));
  if (item) return String(item.VALUE);
  if (field.type === 'boolean') return ['1', 'Y', 'true'].includes(String(value)) ? 'Sim' : 'Não';
  return String(value);
}
function formatMessage({ lead, user, company, fields, metadata, portal }) {
  if (!/^\d+$/.test(String(lead.ID))) throw new Error('invalid_lead_id');
  const link = `${portal}/crm/lead/details/${lead.ID}/`;
  const rows = [];
  for (const code of fields) {
    const value = valueText(lead[code], metadata[code]);
    if (value.trim()) rows.push({ label: metadata[code]?.formLabel || metadata[code]?.title || code, value });
  }
  if (!lead.COMPANY_TITLE && company?.TITLE) rows.unshift({ label: 'Empresa vinculada', value: company.TITLE });
  const fullName = [user.NAME, user.SECOND_NAME, user.LAST_NAME].filter(Boolean).join(' ');
  const text = [`Novo lead #${lead.ID}`, `Título: ${lead.TITLE || ''}`, `Responsável: ${fullName}`,
    ...rows.map(({ label, value }) => `${label}: ${value}`)].join('\n');
  if (text.length > 28000) throw new Error('form_too_long');
  // Rich text keeps every field on its own line while treating form values as literal text.
  const formRows = rows.length ? rows : [{ label: 'Dados do formulário', value: 'Nenhum campo preenchido' }];
  return {
    text: `Novo lead #${lead.ID}: ${link}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Novo lead #${lead.ID}` } },
      { type: 'section', text: { type: 'plain_text', text: lead.TITLE || 'Sem título' } },
      { type: 'context', elements: [{ type: 'plain_text', text: `Responsável: ${fullName}` }] },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*Dados do formulário*' } },
      { type: 'rich_text', elements: formRows.map(({ label, value }) => ({
        type: 'rich_text_section', elements: [
          { type: 'text', text: `${label}: `, style: { bold: true } },
          { type: 'text', text: String(value) }
        ]
      })) },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Abrir lead no Bitrix' }, url: link, action_id: 'abrir_lead_bitrix' }] }
    ]
  };
}

async function poll({ clients, store, stageId, mode = 'baseline', configuredFields, now = Date.now,
  budgetMs = 40000, dryRun = false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = now() + budgetMs;
  const result = { ok: true, sent: 0, alreadyProcessed: 0, deferred: 0, uncertain: 0, errors: [] };
  const checkBudget = (reserveMs = 8000) => { if (now() >= deadline - reserveMs) throw new Error('time_budget'); };
  if (!(await store.acquire())) return { ok: true, busy: true };
  try {
    const initialized = await store.initialized();
    if (!initialized && mode === 'baseline' && !dryRun) {
      const ids = [];
      let after = '0';
      while (true) {
        checkBudget();
        const page = await clients.page(stageId, after);
        if (!page.length) break;
        for (const lead of page) ids.push(String(lead.ID));
        const next = String(page[page.length - 1].ID);
        if (BigInt(next) <= BigInt(after)) throw new Error('invalid_pagination');
        after = next;
      }
      await store.initialize(ids);
      return { ok: true, initialized: true, baseline: ids.length, sent: 0 };
    }
    if (!initialized && !dryRun) await store.initialize([]);
    const metadata = await clients.fields();
    const fields = formFields(metadata, configuredFields);
    const channels = await clients.channels(checkBudget);
    const destinations = new Map();
    for (const channel of channels) {
      if (channel.is_archived || !channel.is_member || !channel.name?.startsWith('novosleads-')) continue;
      if (destinations.has(channel.name)) throw new Error('ambiguous_channel');
      destinations.set(channel.name, channel.id);
    }
    let after = dryRun ? '0' : await store.cursor();
    const initialCursor = after;
    const channelTimes = new Map();
    while (now() < deadline - 22000) {
      const page = await clients.page(stageId, after);
      if (!page.length) {
        if (!dryRun && initialCursor !== '0') await store.setCursor('0');
        result.completedScan = true;
        break;
      }
      const records = await store.getMany(page.map(item => String(item.ID)));
      for (const item of page) {
        if (now() >= deadline - 22000) {
          if (!dryRun) await store.setCursor(after);
          return { ...result, continuedNextMinute: true };
        }
        const id = String(item.ID);
        if (BigInt(id) <= BigInt(after)) throw new Error('invalid_pagination');
        try {
          const record = records.get(id);
          if (record) {
            if (['sending', 'uncertain'].includes(record.state)) {
              result.uncertain++;
              result.errors.push({ leadId: id, code: 'delivery_requires_review' });
              result.ok = false;
            } else result.alreadyProcessed++;
          } else {
            const lead = await clients.lead(id);
            if (String(lead.STATUS_ID) !== stageId) { result.deferred++; }
            else {
              const user = await clients.user(lead.ASSIGNED_BY_ID);
              const channel = destinations.get(channelName(user));
              if (!channel) throw new Error('responsible_channel_missing_or_bot_not_member');
              const company = !lead.COMPANY_TITLE && Number(lead.COMPANY_ID) > 0 ? await clients.company(lead.COMPANY_ID) : null;
              const current = await clients.lead(id);
              if (String(current.STATUS_ID) !== stageId || String(current.ASSIGNED_BY_ID) !== String(lead.ASSIGNED_BY_ID)
                || String(current.COMPANY_ID || '') !== String(lead.COMPANY_ID || '')) {
                result.deferred++;
              } else {
                const message = formatMessage({ lead: current, user, company, fields, metadata, portal: clients.portal });
                if (dryRun) {
                  result.deferred++;
                  (result.preview ||= []).push({ leadId: id, ownerId: String(user.ID), channel: channelName(user), fieldCodes: fields });
                }
                else {
                  const wait = (channelTimes.get(channel) || 0) + 1100 - now();
                  if (wait > 0) await sleep(wait);
                  // Stop before reserving if there is insufficient time for post + durable receipt.
                  checkBudget(18000);
                  await store.renew();
                  const delivery = { state: 'sending', channel, ownerId: String(current.ASSIGNED_BY_ID),
                    clientMsgId: randomUUID(), attemptedAt: new Date(now()).toISOString() };
                  if (await store.reserve(id, delivery)) {
                    let ts;
                    try {
                      ts = await clients.post(channel, message, delivery.clientMsgId);
                    } catch (error) {
                      if (error.definitive) await store.remove(id);
                      else await store.put(id, { ...delivery, state: 'uncertain' });
                      throw error;
                    }
                    // If this write fails, 'sending' remains and prevents blind duplicate delivery.
                    await store.put(id, { ...delivery, state: 'sent', ts });
                    channelTimes.set(channel, now());
                    result.sent++;
                  }
                }
              }
            }
          }
        } catch (error) {
          result.ok = false;
          const allowed = /^[a-zA-Z0-9_]+$/;
          result.errors.push({ leadId: id, code: allowed.test(error.message) ? error.message : 'integration_error' });
          if (error.message.startsWith('redis_') || error.message === 'time_budget') throw error;
        }
        after = id;
      }
    }
    if (!result.completedScan && !dryRun) await store.setCursor(after);
    return { ...result, dryRun, continuedNextMinute: !result.completedScan };
  } finally {
    await store.release();
  }
}

module.exports = { channelName, resolveStage, formFields, formatMessage, poll, valueText };
