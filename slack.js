/**
 * ============================================================
 * SLACK → BITRIX LEADS — Helpers do Slack
 * ============================================================
 *
 * ARQUIVO: lib/slack.js   |   DATA: 21/07/2026   |   VERSÃO: 1.0
 *
 * HISTÓRICO
 * ---------
 * v1.0 (21/07/2026):
 *   - Versão inicial. Funções para buscar o texto da mensagem que recebeu a
 *     reação (conversations.history com latest/oldest apontando para o ts
 *     exato) e para postar uma resposta na thread (chat.postMessage).
 * ============================================================
 */

const SLACK_API = 'https://slack.com/api';

/**
 * buscarMensagemReagida(channel, ts)
 * v1.0 (21/07/2026): retorna o texto da mensagem específica que recebeu a
 * reação. Usa conversations.history com inclusive=true e latest=oldest=ts
 * para trazer exatamente 1 mensagem (a do timestamp reagido).
 * Retorna { texto, ok, erro }.
 */
async function buscarMensagemReagida(channel, ts) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, erro: 'SLACK_BOT_TOKEN ausente', texto: '' };

  const params = new URLSearchParams({
    channel:   channel,
    latest:    ts,
    oldest:    ts,
    inclusive: 'true',
    limit:     '1'
  });

  try {
    const resp = await fetch(`${SLACK_API}/conversations.history?${params}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!data.ok) {
      return { ok: false, erro: data.error || 'erro desconhecido', texto: '' };
    }
    const msg = (data.messages || [])[0];
    return { ok: true, texto: (msg && msg.text) || '', erro: '' };
  } catch (err) {
    return { ok: false, erro: String(err), texto: '' };
  }
}

/**
 * responderNaThread(channel, threadTs, texto)
 * v1.0 (21/07/2026): posta uma mensagem como resposta na thread da mensagem
 * reagida (thread_ts = ts da mensagem original), para dar feedback de que o
 * lead foi criado (ou já existia) no Bitrix.
 */
async function responderNaThread(channel, threadTs, texto) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, erro: 'SLACK_BOT_TOKEN ausente' };

  try {
    const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        channel:   channel,
        thread_ts: threadTs,
        text:      texto
      })
    });
    const data = await resp.json();
    return { ok: !!data.ok, erro: data.error || '' };
  } catch (err) {
    return { ok: false, erro: String(err) };
  }
}

module.exports = { buscarMensagemReagida, responderNaThread };
