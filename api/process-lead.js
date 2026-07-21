/**
 * ============================================================
 * SLACK → BITRIX LEADS — Processamento assíncrono do lead
 * ============================================================
 *
 * ARQUIVO: api/process-lead.js   |   DATA: 21/07/2026   |   VERSÃO: 1.6
 *
 * HISTÓRICO
 * ---------
 * v1.6 (21/07/2026):
 *   - DIAGNÓSTICO: adicionados console.log em todo o fluxo do fallback Gemini
 *     (chave presente?, resultado da extração, motivo da falha). Antes, quando
 *     o Gemini era pulado ou falhava, o motivo era engolido e o usuário só via
 *     "faltou Nome, Empresa" — sem pista nos logs. Agora o motivo aparece nos
 *     logs da Vercel para depuração.
 * v1.5 (21/07/2026):
 *   - Email deixou de ser obrigatório em TODOS os caminhos (determinístico e
 *     fallback Gemini). Quando ausente, gera placeholder válido via
 *     parser.gerarEmailPlaceholder() (nome+id@naoexiste.com). O lead nunca é
 *     recusado só por falta de e-mail — o telefone serve de identificador e o
 *     Bitrix ignora e-mails @naoexiste.com no campo EMAIL.
 * v1.4 (21/07/2026):
 *   - NOVO: fallback opcional com Gemini para mensagens em texto livre.
 *     Quando o parser determinístico não encontra os obrigatórios, o texto é
 *     enviado ao Gemini (lib/gemini.js), que infere nome/empresa/origem/
 *     observação. E-mail e telefone — por serem críticos — NÃO vêm da IA:
 *     são extraídos por regex do texto original (parser.extrairEmailTelefone).
 *     O caminho feliz (mensagem já no formato do formulário) continua 100%
 *     sem IA. Se GEMINI_API_KEY não estiver configurada ou o Gemini falhar,
 *     o comportamento é o mesmo da v1.3 (aviso "faltou preencher").
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

const { buscarMensagemReagida, responderNaThread }        = require('../lib/slack');
const { parseFormulario, separarNome, extrairEmailTelefone, gerarEmailPlaceholder } = require('../lib/parser');
const { extrairCamposViaGemini }                          = require('../lib/gemini');
const bitrix                                              = require('../lib/bitrix');

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

  // ── 2. Parseia o formulário (determinístico primeiro) ──
  let { ok, campos, faltando } = parseFormulario(msg.texto);

  // v1.4 (21/07/2026): FALLBACK com Gemini. Se o parser determinístico não
  // achou os obrigatórios, a mensagem pode ser texto livre. Tentamos extrair
  // via Gemini (nome/empresa/origem/observação) e, para os campos CRÍTICOS,
  // pegamos e-mail e telefone por regex sobre o texto original (não confiamos
  // na IA nesses). Só entra aqui quando o caminho determinístico falha — o
  // caminho feliz continua 100% sem IA. Se o Gemini não estiver configurado
  // (sem GEMINI_API_KEY) ou falhar, cai no aviso original mais abaixo.
  if (!ok) {
    // v1.6 (21/07/2026): logs de diagnóstico. Antes, quando o Gemini falhava
    // ou era pulado, o motivo era engolido silenciosamente — impossível
    // depurar pelos logs da Vercel. Agora logamos cada etapa.
    console.log('[GEMINI] parser determinístico falhou, tentando fallback. Texto:', JSON.stringify(msg.texto).substring(0, 300));
    console.log('[GEMINI] GEMINI_API_KEY presente?', !!process.env.GEMINI_API_KEY);

    const g = await extrairCamposViaGemini(msg.texto);
    console.log('[GEMINI] resultado:', JSON.stringify(g).substring(0, 500));

    if (g.ok) {
      const et = extrairEmailTelefone(msg.texto); // e-mail/telefone por regex
      const mesclado = {
        nome:       g.campos.nome       || '',
        empresa:    g.campos.empresa    || '',
        email:      et.email            || '',
        telefone:   et.telefone         || '',
        origem:     g.campos.origem     || '',
        observacao: g.campos.observacao || ''
      };
      // v1.5 (21/07/2026): Email não é mais obrigatório — só Nome e Empresa.
      // Se o regex não achou e-mail, segue mesmo assim; o placeholder é
      // gerado logo abaixo.
      const faltandoG = [];
      if (!mesclado.nome)    faltandoG.push('Nome');
      if (!mesclado.empresa) faltandoG.push('Empresa');

      if (faltandoG.length === 0) {
        ok = true; campos = mesclado; faltando = [];
        console.log('[GEMINI] extração OK:', JSON.stringify(mesclado).substring(0, 400));
      } else {
        faltando = faltandoG;
        console.log('[GEMINI] extraiu mas faltou:', faltandoG.join(', '));
      }
    } else {
      // v1.6: expõe o motivo da falha do Gemini na thread e no log, em vez de
      // só dizer "faltou Nome, Empresa".
      console.log('[GEMINI] fallback não aplicado. Motivo:', g.erro || 'desconhecido');
    }
  }

  if (!ok) {
    await responderNaThread(channel, ts,
      `⚠️ Não criei o lead: faltou ${faltando.join(', ')}. ` +
      `Você pode usar o formato "Campo: valor" (Nome e Empresa obrigatórios) ` +
      `ou escrever livre incluindo pelo menos nome e empresa.`);
    return;
  }

  // v1.5 (21/07/2026): e-mail é OPCIONAL. Quando ausente, gera placeholder
  // válido (nome+id@naoexiste.com) para não perder o lead. O Bitrix não recebe
  // esse valor no campo EMAIL (lib/bitrix.js ignora @naoexiste.com); o telefone
  // serve de identificador.
  if (!campos.email) {
    campos.email = gerarEmailPlaceholder(campos.nome);
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
