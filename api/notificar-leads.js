/**
 * ============================================================
 * BITRIX → SLACK — Notificação horária de leads "Por Recomendação"
 * ============================================================
 *
 * ARQUIVO: api/notificar-leads.js   |   DATA: 05/08/2026   |   VERSÃO: 1.2
 *
 * HISTÓRICO
 * ---------
 * v1.2 (05/08/2026):
 *   - Sub-linha "↳ Indicado por: <quem> — <e-mail>" em cada indicação,
 *     com SOURCE_DESCRIPTION (quem indicou) e UF_CRM_1784828550 (e-mail
 *     do indicador). Omitida quando ambos os campos estão vazios.
 * v1.1 (05/08/2026):
 *   - Cabeçalho da mensagem trocado (pedido do usuário): de
 *     '📋 Resumo: N novo(s) lead(s) "Por Recomendação" na última hora:'
 *     para 'Chegou N nova indicação:' / 'Chegaram N novas indicações:'.
 * v1.0 (05/08/2026):
 *   - Versão inicial. Endpoint chamado de hora em hora pelo cron do GitHub
 *     Actions (.github/workflows/notificar-leads.yml). Consulta os leads
 *     CRIADOS na última hora no Bitrix24 com a fonte configurada (padrão
 *     "RECOMMENDATION" = Por Recomendação) e posta um resumo no canal do
 *     Slack definido em SLACK_CANAL_NOTIFICACOES. Funcionalidade separada
 *     do fluxo de reações (api/slack-events.js) — coexistem no mesmo deploy,
 *     cada uma no seu canal.
 *
 * JANELA DE TEMPO (alinhada ao relógio)
 * -------------------------------------
 * Em vez de "últimos 60 min a partir de agora" (que com cron atrasado perde
 * ou duplica leads), reportamos a hora-relógio ANTERIOR completa:
 *   fim    = agora truncado para a hora cheia (UTC)
 *   inicio = fim - NOTIF_JANELA_MINUTOS
 * Um cron que dispara às 10:05 ou às 10:23 reporta o mesmo intervalo
 * [09:00, 10:00) — determinístico, sem duplicatas e sem buracos. Se um
 * disparo atrasar além da virada da hora seguinte (raro) ou for pulado,
 * aquela hora fica sem notificação (tradeoff aceito, ver README).
 * Para testes manuais: ?janelaTesteMinutos=N usa [agora - N, agora).
 *
 * VARIÁVEIS DE AMBIENTE
 * ---------------------
 * - NOTIF_SECRET             : segredo compartilhado (header x-notif-secret)
 * - SLACK_CANAL_NOTIFICACOES : ID do canal de notificações (ex: C0123ABCDEF)
 * - NOTIF_SOURCE_ID          : código(s) da fonte, vírgula-separados
 *                              (padrão "RECOMMENDATION")
 * - NOTIF_JANELA_MINUTOS     : tamanho da janela em minutos (padrão 60)
 * ============================================================
 */

const crypto = require('crypto');

const { enviarMensagemCanal } = require('../lib/slack');
const bitrix                  = require('../lib/bitrix');

/**
 * _verificarSecret(req)
 * v1.0 (05/08/2026): compara o header x-notif-secret com NOTIF_SECRET em
 * tempo constante (mesmo padrão de _verificarAssinaturaSlack). O segredo
 * NUNCA é aceito por query param (query aparece em logs).
 */
function _verificarSecret(req) {
  const esperado = process.env.NOTIF_SECRET;
  const recebido = req.headers['x-notif-secret'];
  if (!esperado || !recebido) return false;

  // timingSafeEqual exige buffers do mesmo tamanho
  const a = Buffer.from(String(esperado));
  const b = Buffer.from(String(recebido));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * _formatarMensagem(leads)
 * v1.0 (05/08/2026): monta o texto do resumo (PT-BR, texto puro com links
 * no formato <url|rótulo> do Slack). Função pura, exportada para testes.
 * - Horário exibido: DATE_CREATE.slice(11, 16) — o Bitrix retorna ISO com
 *   offset no fuso do portal, então HH:MM já está no horário local do CRM.
 * - E-mail placeholder (@naoexiste.com) nunca é exibido (convenção do repo).
 */
function _formatarMensagem(leads) {
  const n = leads.length;
  // v1.1 (05/08/2026): cabeçalho no formato pedido pelo usuário
  // ("Chegou/Chegaram X nova(s) indicação(ões):"), sem emoji.
  const linhas = [n === 1
    ? `Chegou ${n} nova indicação:`
    : `Chegaram ${n} novas indicações:`];

  for (const lead of leads) {
    const titulo  = lead.TITLE || `${lead.NAME || ''} ${lead.LAST_NAME || ''}`.trim() || `Lead ${lead.ID}`;
    const link    = bitrix.montarLinkLead(lead.ID);
    const nome    = `${lead.NAME || ''} ${lead.LAST_NAME || ''}`.trim();
    const empresa = lead.COMPANY_TITLE || '';
    const hora    = String(lead.DATE_CREATE || '').slice(11, 16);

    // EMAIL/PHONE vêm como arrays [{ VALUE, VALUE_TYPE }] no crm.lead.list.
    const email = Array.isArray(lead.EMAIL) && lead.EMAIL[0] && lead.EMAIL[0].VALUE ? lead.EMAIL[0].VALUE : '';
    const fone  = Array.isArray(lead.PHONE) && lead.PHONE[0] && lead.PHONE[0].VALUE ? lead.PHONE[0].VALUE : '';

    const partes = [link ? `<${link}|${titulo}>` : titulo];
    if (nome && nome !== titulo)  partes.push(nome);
    if (empresa && empresa !== titulo) partes.push(`(${empresa})`);
    if (email && !email.includes('@naoexiste.com')) partes.push(email);
    if (fone) partes.push(fone);
    if (hora) partes.push(`criado às ${hora}`);

    linhas.push(`• ${partes.join(' — ')}`);

    // v1.2 (05/08/2026): sub-linha "Indicado por" — quem indicou vem de
    // SOURCE_DESCRIPTION e o e-mail do indicador do campo customizado
    // UF_CRM_1784828550. Omitida por completo quando ambos estão vazios.
    const indicadoPor   = String(lead.SOURCE_DESCRIPTION || '').trim();
    const emailIndicador = String(lead.UF_CRM_1784828550 || '').trim();
    const indicacao = [indicadoPor, emailIndicador]
      .filter((v) => v && !v.includes('@naoexiste.com'))
      .join(' — ');
    if (indicacao) {
      linhas.push(`   ↳ Indicado por: ${indicacao}`);
    }
  }

  return linhas.join('\n');
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Segurança: nunca rodar sem segredo configurado ──
  if (!process.env.NOTIF_SECRET) {
    return res.status(500).json({ ok: false, erro: 'NOTIF_SECRET não configurado' });
  }
  if (!_verificarSecret(req)) {
    return res.status(401).json({ ok: false, erro: 'Segredo inválido' });
  }

  const canal = process.env.SLACK_CANAL_NOTIFICACOES;
  if (!canal) {
    return res.status(500).json({ ok: false, erro: 'SLACK_CANAL_NOTIFICACOES não configurado' });
  }

  // ── 2. Janela de tempo ──
  const janelaMin = Number(process.env.NOTIF_JANELA_MINUTOS) || 60;
  const janelaTeste = Number((req.query || {}).janelaTesteMinutos) || 0;

  let inicio, fim;
  if (janelaTeste > 0) {
    // Override de teste: [agora - N, agora)
    fim    = new Date();
    inicio = new Date(fim.getTime() - janelaTeste * 60000);
  } else {
    // Padrão: hora-relógio anterior completa (ver cabeçalho)
    fim    = new Date(Math.floor(Date.now() / 3600000) * 3600000);
    inicio = new Date(fim.getTime() - janelaMin * 60000);
  }

  // ── 3. Fontes a filtrar ──
  const sourceIds = (process.env.NOTIF_SOURCE_ID || 'RECOMMENDATION')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // ── 4. Consulta no Bitrix ──
  const r = await bitrix.listarLeadsRecentes({
    inicioIso: inicio.toISOString(),
    fimIso:    fim.toISOString(),
    sourceIds
  });
  if (!r.ok) {
    console.log('[NOTIF] erro ao listar leads no Bitrix:', r.erro);
    return res.status(200).json({ ok: false, erro: r.erro });
  }

  console.log(`[NOTIF] janela ${inicio.toISOString()} → ${fim.toISOString()}, fontes ${sourceIds.join(',')}: ${r.leads.length} lead(s)`);

  // ── 5. Zero leads → silêncio (24 execuções/dia; "nenhum lead" vira ruído) ──
  if (r.leads.length === 0) {
    return res.status(200).json({ ok: true, total: 0, enviado: false });
  }

  // ── 6. Formata e posta no canal ──
  const texto = _formatarMensagem(r.leads);
  const envio = await enviarMensagemCanal(canal, texto);
  if (!envio.ok) {
    // Erro típico: "not_in_channel" = bot não foi convidado (/invite) ao canal.
    console.log('[NOTIF] falha ao postar no Slack:', envio.erro);
    return res.status(200).json({ ok: false, total: r.leads.length, enviado: false, erro: envio.erro });
  }

  return res.status(200).json({ ok: true, total: r.leads.length, enviado: true });
};

// Exportada para testes (padrão _diceCoefficient em lib/bitrix.js).
module.exports._formatarMensagem = _formatarMensagem;
