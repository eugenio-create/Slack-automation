/**
 * ============================================================
 * SLACK → BITRIX LEADS — Receptor de eventos do Slack
 * ============================================================
 *
 * ARQUIVO: api/slack-events.js   |   DATA: 21/07/2026   |   VERSÃO: 1.2
 *
 * HISTÓRICO
 * ---------
 * v1.2 (21/07/2026):
 *   - CORRIGIDO: o disparo para /api/process-lead era fire-and-forget
 *     (fetch sem await). Na Vercel, ao retornar o 200 a função encerra e
 *     MATA a requisição em andamento antes de ela sair — resultado: o
 *     process-lead nunca era invocado ("No outgoing requests" no log).
 *   - Agora o disparo é AGUARDADO (await) com um timeout curto (2,5s via
 *     AbortController) para garantir que a requisição seja efetivamente
 *     enviada, sem arriscar estourar o limite de 3s do Slack. Só esperamos
 *     o process-lead ACEITAR o trabalho (ele responde cedo, ver v1.2 de
 *     process-lead.js), não concluí-lo — o processamento pesado continua na
 *     segunda função, dentro do timeout dela.
 * v1.1 (21/07/2026):
 *   - Sem mudanças neste arquivo (correção foi em lib/bitrix.js).
 * v1.0 (21/07/2026):
 *   - Versão inicial. Endpoint que recebe o evento `reaction_added` do
 *     Slack (Events API), responde em < 3s (exigência do Slack) e dispara
 *     o processamento pesado de forma assíncrona (fire-and-forget) para a
 *     function api/process-lead.js, evitando o timeout de 10s do plano
 *     gratuito da Vercel.
 *
 * O QUE FAZ
 * ---------
 * 1. Verifica a assinatura do Slack (Signing Secret) — segurança.
 * 2. Responde ao url_verification challenge (setup do Slack App).
 * 3. Filtra apenas os 3 emojis de gatilho (1️⃣, 2️⃣, 3️⃣).
 * 4. Dispara api/process-lead.js sem esperar a resposta e retorna 200
 *    imediatamente ao Slack.
 *
 * VARIÁVEIS DE AMBIENTE (Vercel → Settings → Environment Variables)
 * -----------------------------------------------------------------
 * - SLACK_SIGNING_SECRET : Signing Secret do Slack App (Basic Information)
 * - SLACK_BOT_TOKEN      : Bot User OAuth Token (xoxb-...)
 * - BITRIX_WEBHOOK       : URL base do webhook REST do Bitrix24
 * - SELF_BASE_URL        : URL pública deste deploy (ex: https://seu-app.vercel.app)
 *                          usada para a function chamar a si mesma (process-lead)
 * ============================================================
 */

const crypto = require('crypto');

// v1.0 (21/07/2026): Mapa emoji → ID do responsável no Bitrix (ASSIGNED_BY_ID).
// Slack envia o nome do emoji sem os dois-pontos: "one", "two", "three".
const EMOJI_RESPONSAVEL = {
  'one':   7,    // 1️⃣ → responsável 7
  'two':   68,   // 2️⃣ → responsável 68
  'three': 89    // 3️⃣ → responsável 89
};

/**
 * Verifica a assinatura do Slack para garantir que a requisição é legítima.
 * v1.0 (21/07/2026): implementa o esquema v0 de assinatura do Slack.
 * Rejeita requisições com mais de 5 min (proteção contra replay).
 */
function _verificarAssinaturaSlack(req, rawBody) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig  = req.headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;

  // Proteção contra replay: rejeita requisições com mais de 5 minutos
  const cincoMin = 60 * 5;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > cincoMin) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  const esperado = `v0=${hmac}`;

  // timingSafeEqual exige buffers do mesmo tamanho
  const a = Buffer.from(esperado);
  const b = Buffer.from(slackSig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Lê o corpo bruto da requisição (necessário para a verificação de assinatura,
 * que precisa do body exatamente como enviado, antes de qualquer parse).
 * v1.0 (21/07/2026): Vercel não expõe o raw body por padrão quando o
 * Content-Type é JSON, então lemos o stream manualmente.
 */
function _lerRawBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await _lerRawBody(req);

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // ── url_verification: handshake inicial do Slack ao configurar o endpoint ──
  // v1.0 (21/07/2026): esse desafio NÃO é assinado da mesma forma; respondemos
  // direto com o challenge.
  if (payload.type === 'url_verification') {
    return res.status(200).json({ challenge: payload.challenge });
  }

  // ── Verificação de assinatura (todos os demais eventos) ──
  if (!_verificarAssinaturaSlack(req, rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = payload.event || {};

  // Só nos interessa reaction_added
  if (payload.type !== 'event_callback' || event.type !== 'reaction_added') {
    return res.status(200).json({ ok: true, ignored: 'not a reaction_added' });
  }

  // v1.0 (21/07/2026): filtra apenas os 3 emojis mapeados. Slack pode enviar
  // variações com skin tone (ex: "one::skin-tone-2") — normalizamos pegando
  // só a parte antes de "::".
  const reactionRaw = String(event.reaction || '');
  const reaction    = reactionRaw.split('::')[0];
  const assignedById = EMOJI_RESPONSAVEL[reaction];

  if (!assignedById) {
    return res.status(200).json({ ok: true, ignored: `emoji ${reaction} não mapeado` });
  }

  // ── Dispara o processamento pesado e AGUARDA o envio ──
  // v1.2 (21/07/2026): antes era fire-and-forget (sem await), o que fazia a
  // Vercel matar a requisição ao encerrar a função. Agora aguardamos o
  // disparo sair, com timeout de 2,5s (AbortController) para não estourar o
  // limite de 3s do Slack. O process-lead responde cedo (ack) e segue
  // processando — ver process-lead.js v1.2.
  const baseUrl = process.env.SELF_BASE_URL || `https://${req.headers.host}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(`${baseUrl}/api/process-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel:      event.item && event.item.channel,
        ts:           event.item && event.item.ts,
        reaction:     reaction,
        assignedById: assignedById,
        reactingUser: event.user
      }),
      signal: ctrl.signal
    });
  } catch (e) {
    // Se abortou por timeout, o process-lead provavelmente já recebeu o
    // trabalho e está processando — respondemos 200 ao Slack de qualquer forma
    // para evitar reenvio automático do evento.
  } finally {
    clearTimeout(timer);
  }

  return res.status(200).json({ ok: true });
};
