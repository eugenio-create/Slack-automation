/**
 * ============================================================
 * SLACK → BITRIX LEADS — Processamento assíncrono do lead
 * ============================================================
 *
 * ARQUIVO: api/process-lead.js   |   DATA: 21/07/2026   |   VERSÃO: 1.3
 *
 * HISTÓRICO
 * ---------
 * v1.3 (21/07/2026):
 *   - CORRIGIDO: o ack-antecipado da v1.2 (res.json antes do await) fazia a
 *     Vercel encerrar a função cedo — o log mostrou process-lead retornando
 *     em ~105ms com "No outgoing requests", ou seja, morrendo antes de
 *     chamar Slack/Bitrix. Revertido: agora processa TODO o trabalho e
 *     responde só no fim. O limite de 3s do Slack continua protegido pelo
 *     timeout de 2,5s no slack-events (v1.2), que aborta a espera do disparo
 *     sem matar esta função (são requisições HTTP independentes).
 * v1.2 (21/07/2026):
 *   - (Substituída pela v1.3.) Tentava responder 200 imediatamente (ack) e
 *     processar depois; não funcionou no runtime da Vercel.
 * v1.1 (21/07/2026):
 *   - Nenhuma mudança de lógica aqui. A mensagem de confirmação na thread
 *     segue mostrando o rótulo legível "CEO-Led Outbound" para o usuário;
 *     o código interno (UC_EN7PZM) enviado ao Bitrix passou a ser tratado
 *     em lib/bitrix.js v1.1.
 * v1.0 (21/07/2026):
 *   - Versão inicial. Chamada em segundo plano por api/slack-events.js.
 *     Orquestra o fluxo completo: busca a mensagem reagida no Slack →
 *     parseia o formulário → gera placeholder de e-mail se faltar →
 *     checa duplicidade (exata, depois fuzzy) → cria Empresa/Contato/Lead
 *     no Bitrix (primeira etapa, SOURCE_ID "CEO-Led Outbound") → responde
 *     na thread do Slack com o resultado.
 *
 * FLUXO
 * -----
 * 1. Recebe { channel, ts, reaction, assignedById } do slack-events.
 * 2. Busca o texto da mensagem reagida.
 * 3. Parseia o formulário (Nome/Empresa/Email obrigatórios).
 * 4. Se faltar obrigatório → avisa na thread e encerra.
 * 5. Checa duplicidade exata (email/telefone) → depois fuzzy (nome+empresa).
 * 6. Se duplicata → avisa na thread com link do lead existente e encerra.
 * 7. Senão → cria Empresa → Contato → Lead e confirma na thread.
 * ============================================================
 */

const { buscarMensagemReagida, responderNaThread } = require('../lib/slack');
const { parseFormulario, separarNome }             = require('../lib/parser');
const bitrix                                        = require('../lib/bitrix');

/**
 * _linkLeadBitrix(leadId)
 * v1.0 (21/07/2026): monta a URL amigável do lead no portal Bitrix a partir
 * da base do webhook (extrai o domínio do portal). Usada nas mensagens de
 * feedback na thread.
 */
function _linkLeadBitrix(leadId) {
  const base = process.env.BITRIX_WEBHOOK || '';
  // BITRIX_WEBHOOK ~ https://portal.bitrix24.com.br/rest/89/token/
  const m = base.match(/^(https?:\/\/[^/]+)/);
  const portal = m ? m[1] : '';
  if (!portal || !leadId) return '';
  return `${portal}/crm/lead/details/${leadId}/`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body
      ? req.body
      : JSON.parse(req.body || '{}');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { channel, ts, assignedById } = body;
  if (!channel || !ts || !assignedById) {
    return res.status(400).json({ error: 'Parâmetros ausentes (channel, ts, assignedById)' });
  }

  // v1.3 (21/07/2026): REVERTIDO o padrão ack-antecipado da v1.2. Na Vercel,
  // chamar res.json() antes de terminar o await encerrava a função cedo
  // (visto no log: process-lead retornava em ~105ms com "No outgoing
  // requests" — morria antes de chamar Slack/Bitrix). Agora fazemos TODO o
  // trabalho e respondemos só no fim. O limite de 3s do Slack já está
  // protegido pelo timeout de 2,5s no slack-events (v1.2), então a duração
  // desta função não afeta o Slack.
  try {
    await _processarLead(body);
    return res.status(200).json({ ok: true });
  } catch (e) {
    try {
      await responderNaThread(channel, ts,
        `❌ Erro inesperado ao processar o lead. Tente reagir novamente.`);
    } catch (_) { /* silencioso */ }
    return res.status(200).json({ ok: false, erro: String(e) });
  }
};

/**
 * _processarLead(body)
 * v1.2 (21/07/2026): corpo original do handler (busca mensagem → parseia →
 * checa duplicidade → cria no Bitrix → responde na thread), extraído para
 * função própria.
 * v1.3 (21/07/2026): passou a ser aguardado ANTES de responder (ver acima).
 */
async function _processarLead(body) {
  const { channel, ts, assignedById } = body;

  // ── 1. Busca a mensagem reagida ──
  const msg = await buscarMensagemReagida(channel, ts);
  if (!msg.ok) {
    // Não dá para responder na thread sem saber o canal? Temos o canal — avisa.
    await responderNaThread(channel, ts,
      `⚠️ Não consegui ler a mensagem para criar o lead (${msg.erro}).`);
    return;
  }

  // ── 2. Parseia o formulário ──
  const { ok, campos, faltando } = parseFormulario(msg.texto);
  if (!ok) {
    await responderNaThread(channel, ts,
      `⚠️ Não criei o lead: faltou preencher ${faltando.join(', ')}. ` +
      `Use o formato "Campo: valor" (Nome, Empresa e Email são obrigatórios).`);
    return;
  }

  // v1.0 (21/07/2026): se e-mail veio vazio (não deveria, é obrigatório, mas
  // defesa extra), gera placeholder para não perder o lead.
  if (!campos.email) {
    const slug = `${campos.nome}${Date.now()}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    campos.email = `${slug}@naoexiste.com`;
  }

  // Pré-separa o nome (usado por contato e lead)
  campos._nomeSep = separarNome(campos.nome);

  // ── 3. Checagem de duplicidade: EXATA primeiro ──
  const exata = await bitrix.checarDuplicataExata(campos.email, campos.telefone);
  if (exata.encontrado) {
    const link = _linkLeadBitrix(exata.leadId);
    await responderNaThread(channel, ts,
      `ℹ️ Lead já existe no Bitrix (match ${exata.via}). ` +
      `ID ${exata.leadId}${link ? ` — ${link}` : ''}. Não criei duplicata.`);
    return; // v1.2: sem res aqui — _processarLead é chamada após o ack
  }

  // ── 4. Checagem FUZZY como fallback ──
  const fuzzy = await bitrix.checarDuplicataFuzzy(campos.nome, campos.empresa);
  if (fuzzy.encontrado) {
    const link = _linkLeadBitrix(fuzzy.leadId);
    await responderNaThread(channel, ts,
      `ℹ️ Possível lead duplicado (similaridade ${(fuzzy.score * 100).toFixed(0)}%). ` +
      `Parecido com o lead ID ${fuzzy.leadId}${link ? ` — ${link}` : ''}. ` +
      `Não criei automaticamente para evitar duplicata — crie manualmente se for outro.`);
    return; // v1.2: sem res aqui
  }

  // ── 5. Cria Empresa → Contato → Lead ──
  const companyId = await bitrix.criarEmpresa(campos, assignedById);
  const contactId = await bitrix.criarContato(campos, companyId, assignedById);
  const leadId    = await bitrix.criarLead(campos, companyId, contactId, assignedById);

  if (!leadId) {
    await responderNaThread(channel, ts,
      `❌ Falha ao criar o lead no Bitrix. Verifique os dados e tente reagir novamente.`);
    return; // v1.2: sem res aqui
  }

  const link = _linkLeadBitrix(leadId);
  await responderNaThread(channel, ts,
    `✅ Lead criado no Bitrix (etapa Novos Leads) — ID ${leadId}` +
    `${link ? ` — ${link}` : ''}. Responsável: ${assignedById}. Fonte: CEO-Led Outbound.`);

  // v1.2: fim de _processarLead — sem retorno de res (o ack já foi enviado)
}
