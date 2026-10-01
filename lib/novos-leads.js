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

// v1.2 (2026-09-30): 'Caso(s) de Uso' e 'Sou/Represento uma Empresa' removidos da lista padrão
// (não são mais exibidos no Slack; ver também HIDDEN_LABELS).
const DEFAULT_LABELS = [
  'nome.lead', 'email.lead', 'Work Email', 'Número de seu WhatsApp com ddd',
  'Quantidade de contas de WhatsApp em sua empresa', 'Quantidade de contas de WhatsApp em sua empresa(S)',
  'Quantidade de contas de WhatsApp a monitorar(FB)', 'Outros Casos de Uso',
  'O que você busca resolver com Zapper? - Facebook'
];
// v1.2 (2026-09-30): campos nunca exibidos, mesmo se listados em NOVOS_LEADS_FORM_FIELDS.
const HIDDEN_LABELS = ['Caso(s) de Uso', 'Sou/Represento uma Empresa'].map(normalize);
// v1.2 (2026-09-30): nome de exibição no Slack (chave = rótulo normalizado do Bitrix).
const LABEL_OVERRIDES = { [normalize('nome.lead')]: 'Nome do contato',
  // v1.3 (2026-10-01): email.lead só aparece quando o E-mail padrão está vazio, e com este rótulo.
  [normalize('email.lead')]: 'E-mail' };
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
// v1.1 (2026-09-30): mensagem reformatada em Block Kit (cabeçalho, campos em 2 colunas,
// uma linha por campo do formulário com rótulo em negrito). Como o negrito exige mrkdwn,
// todo valor vindo do formulário passa por escapeMrkdwn para nunca virar menção/link/formatação.
function escapeMrkdwn(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([*~`])/g, '$1​');
}
// v1.1 (2026-09-30): agrupa linhas inteiras em blocos <= max, sem partir um campo no meio
// (uma única linha maior que max é cortada).
function chunkLines(lines, max = 2800) {
  const chunks = [];
  let current = '';
  for (const line of lines.flatMap(l => l.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) || [''])) {
    if (current && current.length + line.length + 1 > max) { chunks.push(current); current = line; }
    else current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}
// v1.3 (2026-10-01): normalização de telefone brasileiro para links do WhatsApp.
// Baseada nos formatos reais do campo "Telefone de trabalho" (ex.: '11 99780-8847',
// '+55 (11) 99168-8497', '55+(22)99828-2407', '81.9.89237167', '556799455390',
// '011999999999', várias entradas na mesma célula). Retorna '55' + DDD + número, ou null.
// Números com '+' de outro país (+595, +57, +54...) não recebem link.
const BR_DDDS = new Set([11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
function isBrNational(digits) {
  if (!BR_DDDS.has(Number(digits.slice(0, 2)))) return false;
  if (digits.length === 11) return digits[2] === '9';
  if (digits.length === 10) return /[2-9]/.test(digits[2]);
  return false;
}
function normalizeBrPhone(raw) {
  for (const part of String(raw ?? '').split(/[,;/]|\bou\b/i)) {
    if (/e\+/i.test(part)) continue; // notação científica do Excel: dígitos perdidos
    const international = part.trim().startsWith('+');
    let digits = part.replace(/\D/g, '');
    if (!international) digits = digits.replace(/^0+/, '');
    if (international && !digits.startsWith('55')) continue;
    if (!international && isBrNational(digits)) return `55${digits}`;
    if ([12, 13].includes(digits.length) && digits.startsWith('55') && isBrNational(digits.slice(2))) return digits;
  }
  return null;
}
// v1.3 (2026-10-01): mensagem pré-preenchida do link "WhatsApp com template".
function firstName(value) {
  const word = String(value || '').trim().split(/\s+/)[0] || '';
  return word ? word[0].toLocaleUpperCase('pt-BR') + word.slice(1) : '';
}
function whatsappTemplate(contactFirst, sellerFirst) {
  return [
    contactFirst ? `Olá, ${contactFirst}!` : 'Olá!',
    `Aqui é o ${sellerFirst || 'time'} da Zapper.`,
    '',
    'Recebi seu contato em nosso site.',
    '',
    'Hoje qual desafio você está buscando resolver com a ajuda da Zapper?',
    'Fique à vontade pra enviar em áudio caso seja mais prático!'
  ].join('\n');
}
function fieldCode(metadata, label) {
  const target = normalize(label);
  return Object.keys(metadata).find(code => [metadata[code].title, metadata[code].formLabel, metadata[code].listLabel]
    .some(text => normalize(text) === target));
}
function whatsappLines({ lead, user, metadata }) {
  const whatsCode = fieldCode(metadata, 'Número de seu WhatsApp com ddd');
  const candidates = [whatsCode && lead[whatsCode], ...(Array.isArray(lead.PHONE) ? lead.PHONE : [lead.PHONE])]
    .map(v => valueText(v, whatsCode && v === lead[whatsCode] ? metadata[whatsCode] : {}));
  const phone = candidates.map(normalizeBrPhone).find(Boolean);
  if (!phone) return ['_Número de WhatsApp não reconhecido; links não gerados._'];
  const nameCode = fieldCode(metadata, 'nome.lead');
  const contact = firstName(valueText(nameCode && lead[nameCode]) || lead.NAME);
  const text = encodeURIComponent(whatsappTemplate(contact, firstName(user.NAME)));
  return [
    `*Link WhatsApp:* <https://wa.me/${phone}|wa.me/${phone}>`,
    `*Link WhatsApp com template:* <https://web.whatsapp.com/send?phone=${phone}&text=${text}|Abrir conversa com mensagem>`
  ];
}
function formatMessage({ lead, user, company, fields, metadata, portal }) {
  if (!/^\d+$/.test(String(lead.ID))) throw new Error('invalid_lead_id');
  const link = `${portal}/crm/lead/details/${lead.ID}/`;
  const rows = [];
  for (const code of fields) {
    const meta = metadata[code] || {};
    // v1.2 (2026-09-30): oculta campos indesejados e renomeia rótulos (ex.: nome.lead -> Nome do contato).
    if ([meta.title, meta.formLabel, meta.listLabel].some(t => HIDDEN_LABELS.includes(normalize(t)))) continue;
    // v1.3 (2026-10-01): e-mail aparece uma vez só; email.lead é usado apenas se o E-mail padrão estiver vazio.
    if (code !== 'EMAIL' && [meta.title, meta.formLabel, meta.listLabel].some(t => normalize(t) === 'email.lead')
      && valueText(lead.EMAIL).trim()) continue;
    const value = valueText(lead[code], metadata[code]);
    const label = meta.formLabel || meta.title || code;
    if (value.trim()) rows.push(`*${escapeMrkdwn(LABEL_OVERRIDES[normalize(label)] || label)}:* ${escapeMrkdwn(value)}`);
  }
  if (!lead.COMPANY_TITLE && company?.TITLE) rows.unshift(`*Empresa vinculada:* ${escapeMrkdwn(company.TITLE)}`);
  const fullName = [user.NAME, user.SECOND_NAME, user.LAST_NAME].filter(Boolean).join(' ');
  if (rows.join('\n').length > 28000) throw new Error('form_too_long');
  const title = String(lead.TITLE || '—');
  const formChunks = chunkLines(rows);
  return {
    text: `Novo lead #${lead.ID}: ${link}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Novo lead #${lead.ID}`, emoji: false } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Responsável*\n${escapeMrkdwn(fullName || '—').slice(0, 1900)}` },
        { type: 'mrkdwn', text: `*Título*\n${escapeMrkdwn(title).slice(0, 1900)}` }
      ] },
      { type: 'divider' },
      ...(formChunks.length
        ? formChunks.map((chunk, i) => ({ type: 'section', text: { type: 'mrkdwn',
          text: i === 0 ? `*Dados do formulário registrados no Bitrix*\n${chunk}` : chunk } }))
        : [{ type: 'section', text: { type: 'mrkdwn', text: '*Dados do formulário registrados no Bitrix*\n_Nenhum dado preenchido._' } }]),
      // v1.3 (2026-10-01): links do WhatsApp (número normalizado com 55) e mensagem pré-preenchida.
      { type: 'section', text: { type: 'mrkdwn', text: whatsappLines({ lead, user, metadata }).join('\n') } },
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

module.exports = { channelName, resolveStage, formFields, formatMessage, poll, valueText, normalizeBrPhone, whatsappTemplate };
