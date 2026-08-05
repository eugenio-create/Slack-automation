/**
 * ============================================================
 * SLACK → BITRIX LEADS — Helper do Bitrix24
 * ============================================================
 *
 * ARQUIVO: lib/bitrix.js   |   DATA: 05/08/2026   |   VERSÃO: 1.3
 *
 * HISTÓRICO
 * ---------
 * v1.3 (05/08/2026):
 *   - listarLeadsRecentes passa a selecionar SOURCE_DESCRIPTION (quem
 *     indicou) e UF_CRM_1784828550 (e-mail do indicador), exibidos na
 *     notificação horária como "Indicado por: ...".
 * v1.2 (05/08/2026):
 *   - NOVO: listarLeadsRecentes({ inicioIso, fimIso, sourceIds }) — consulta
 *     leads criados numa janela de tempo filtrando por fonte (SOURCE_ID),
 *     usada pela notificação horária (api/notificar-leads.js). O filtro de
 *     data no servidor leva folga de 12h (MARGEM_TZ_MINUTOS) porque o Bitrix
 *     interpreta DATE_CREATE no fuso do portal; o corte exato é feito aqui no
 *     cliente comparando o DATE_CREATE retornado (ISO com offset).
 *   - NOVO: montarLinkLead(leadId) — movida de api/process-lead.js
 *     (_linkLeadBitrix) para cá, sem mudança de lógica, para ser reutilizada
 *     pela notificação horária.
 * v1.1 (21/07/2026):
 *   - CORRIGIDO: SOURCE_ID em criarLead() usava o rótulo visível
 *     "CEO-Led Outbound", mas o Bitrix espera o CÓDIGO INTERNO da fonte.
 *     Trocado para "UC_EN7PZM" (código real da fonte CEO-Led Outbound no
 *     portal). Centralizado na constante SOURCE_ID_CEO_LED para facilitar
 *     manutenção futura.
 * v1.0 (21/07/2026):
 *   - Versão inicial. Checagem de duplicidade em duas camadas:
 *       1) EXATA por e-mail/telefone via crm.duplicate.findbycomm (nativo);
 *       2) FUZZY por similaridade de nome+empresa (Dice coefficient em JS
 *          puro, sem dependências) contra os leads recentes, como fallback.
 *     Se nada casar, cria Empresa → Contato → Lead (nessa ordem), com o lead
 *     na PRIMEIRA ETAPA (STATUS_ID = "NEW") e SOURCE_ID fixo em
 *     "CEO-Led Outbound". Responsável (ASSIGNED_BY_ID) vem do emoji.
 *
 * CAMPOS FIXOS (conforme combinado)
 * ---------------------------------
 * - STATUS_ID  : "NEW"       (etapa "Novos Leads")
 * - SOURCE_ID  : "UC_EN7PZM" (código interno da fonte "CEO-Led Outbound";
 *                sempre, em todo lead criado por aqui)  // v1.1 (21/07/2026)
 *
 * VARIÁVEIS DE AMBIENTE
 * ---------------------
 * - BITRIX_WEBHOOK : URL base do webhook REST (termina com "/")
 * ============================================================
 */

// v1.0 (21/07/2026): limiar de similaridade para o fuzzy match. 0.85 = bem
// conservador (só marca duplicata quando nome+empresa são muito parecidos).
const LIMIAR_FUZZY = 0.85;

// v1.1 (21/07/2026): código INTERNO da fonte "CEO-Led Outbound" no Bitrix.
// SOURCE_ID espera o código (ex: UC_XXXX), não o rótulo visível. Se a fonte
// for recriada/renomeada no portal, atualize apenas aqui.
const SOURCE_ID_CEO_LED = 'UC_EN7PZM';

// v1.2 (05/08/2026): folga aplicada ao filtro de data no SERVIDOR ao listar
// leads recentes. O Bitrix interpreta o filtro de DATE_CREATE no fuso do
// portal (não em UTC), então pedimos 12h a mais e cortamos com precisão aqui
// no cliente. Só afeta o volume trazido, nunca o resultado final.
const MARGEM_TZ_MINUTOS = 720;

// v1.2 (05/08/2026): teto de páginas na listagem de leads recentes
// (crm.lead.list pagina de 50 em 50 → 5 páginas = 250 leads por janela).
const MAX_PAGINAS_LISTAGEM = 5;

/**
 * _bitrixCall(metodo, params)
 * v1.0 (21/07/2026): wrapper genérico para chamar o REST do Bitrix via webhook.
 * Retorna o JSON parseado ou lança erro em falha de rede.
 */
async function _bitrixCall(metodo, params) {
  const base = process.env.BITRIX_WEBHOOK;
  if (!base) throw new Error('BITRIX_WEBHOOK não configurado');

  const url = `${base}${metodo}.json`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params || {})
  });
  return resp.json();
}

/**
 * _normalizarTexto(s)
 * v1.0 (21/07/2026): baixa caixa, remove acentos e colapsa espaços — base
 * para a comparação fuzzy de nome e empresa.
 */
function _normalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * _diceCoefficient(a, b)
 * v1.0 (21/07/2026): similaridade de Sørensen–Dice por bigramas, em JS puro
 * (sem dependências). Retorna 0..1. Boa para nomes/empresas com pequenas
 * variações de digitação. Escolhido por ser simples e robusto a typos.
 */
function _diceCoefficient(a, b) {
  a = _normalizarTexto(a);
  b = _normalizarTexto(b);
  if (!a || !b) return 0;
  if (a === b)  return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (str) => {
    const m = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str.substring(i, i + 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };

  const ba = bigrams(a);
  const bb = bigrams(b);
  let intersecao = 0;
  let totalA = 0;
  ba.forEach((qtd) => (totalA += qtd));
  let totalB = 0;
  bb.forEach((qtd) => (totalB += qtd));

  ba.forEach((qtd, bg) => {
    const outro = bb.get(bg) || 0;
    intersecao += Math.min(qtd, outro);
  });

  return (2 * intersecao) / (totalA + totalB);
}

/**
 * checarDuplicataExata(email, telefone)
 * v1.0 (21/07/2026): usa crm.duplicate.findbycomm (método nativo do Bitrix
 * para achar duplicatas por meio de comunicação). Consulta EMAIL e depois
 * PHONE. Retorna { encontrado, leadId } — leadId é o primeiro ID de LEAD
 * retornado, se houver.
 */
async function checarDuplicataExata(email, telefone) {
  // ── EMAIL ──
  if (email && !email.includes('@naoexiste.com')) {
    try {
      const r = await _bitrixCall('crm.duplicate.findbycomm', {
        type:   'EMAIL',
        values: [email],
        entity_type: 'LEAD'
      });
      const ids = r && r.result && r.result.LEAD;
      if (Array.isArray(ids) && ids.length) {
        return { encontrado: true, leadId: ids[0], via: 'email' };
      }
    } catch (e) { /* segue para telefone */ }
  }

  // ── TELEFONE ──
  if (telefone) {
    try {
      const r = await _bitrixCall('crm.duplicate.findbycomm', {
        type:   'PHONE',
        values: [telefone],
        entity_type: 'LEAD'
      });
      const ids = r && r.result && r.result.LEAD;
      if (Array.isArray(ids) && ids.length) {
        return { encontrado: true, leadId: ids[0], via: 'telefone' };
      }
    } catch (e) { /* nada encontrado */ }
  }

  return { encontrado: false, leadId: null, via: null };
}

/**
 * checarDuplicataFuzzy(nome, empresa)
 * v1.0 (21/07/2026): fallback quando a checagem exata não achou nada. Puxa
 * um lote de leads recentes (crm.lead.list) e compara nome+empresa por
 * similaridade Dice. Se a maior similaridade combinada passar do LIMIAR_FUZZY,
 * considera duplicata. Retorna { encontrado, leadId, score }.
 *
 * OBS: crm.lead.list retorna no máximo 50 por página. Aqui checamos as 50
 * mais recentes (suficiente para o volume de um fluxo CEO-led outbound
 * manual); dá para paginar depois se o volume crescer.
 */
async function checarDuplicataFuzzy(nome, empresa) {
  try {
    const r = await _bitrixCall('crm.lead.list', {
      order:  { ID: 'DESC' },
      select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'COMPANY_TITLE'],
      start:  0
    });
    const leads = (r && r.result) || [];

    let melhor = { score: 0, leadId: null };
    for (const lead of leads) {
      const nomeLead = `${lead.NAME || ''} ${lead.LAST_NAME || ''}`.trim() || lead.TITLE || '';
      const empresaLead = lead.COMPANY_TITLE || lead.TITLE || '';

      const simNome    = _diceCoefficient(nome, nomeLead);
      const simEmpresa = _diceCoefficient(empresa, empresaLead);

      // Combinação: exige que AMBOS sejam altos (média ponderada leve p/ empresa).
      const score = (simNome * 0.5) + (simEmpresa * 0.5);
      if (score > melhor.score) {
        melhor = { score, leadId: lead.ID };
      }
    }

    if (melhor.score >= LIMIAR_FUZZY) {
      return { encontrado: true, leadId: melhor.leadId, score: melhor.score };
    }
    return { encontrado: false, leadId: null, score: melhor.score };
  } catch (e) {
    // Em caso de erro na busca, não bloqueia a criação (fail-open).
    return { encontrado: false, leadId: null, score: 0, erro: String(e) };
  }
}

/**
 * criarEmpresa(campos, assignedById)
 * v1.0 (21/07/2026): cria a entidade Empresa e retorna o ID (ou null).
 */
async function criarEmpresa(campos, assignedById) {
  if (!campos.empresa) return null;
  try {
    const fields = { TITLE: campos.empresa };
    if (assignedById) fields.ASSIGNED_BY_ID = assignedById;

    const r = await _bitrixCall('crm.company.add', { fields });
    return (r && r.result) || null;
  } catch (e) {
    return null;
  }
}

/**
 * criarContato(campos, companyId, assignedById)
 * v1.0 (21/07/2026): cria a entidade Contato vinculada à empresa e retorna o
 * ID (ou null). E-mail placeholder (@naoexiste.com) não é gravado.
 */
async function criarContato(campos, companyId, assignedById) {
  try {
    const nome = campos._nomeSep || { first: campos.nome, last: '' };
    const fields = {
      NAME:      nome.first || '',
      LAST_NAME: nome.last  || ''
    };
    if (companyId)     fields.COMPANY_ID     = companyId;
    if (assignedById)  fields.ASSIGNED_BY_ID = assignedById;
    if (campos.email && !campos.email.includes('@naoexiste.com')) {
      fields.EMAIL = [{ VALUE: campos.email, VALUE_TYPE: 'WORK' }];
    }
    if (campos.telefone) {
      fields.PHONE = [{ VALUE: campos.telefone, VALUE_TYPE: 'WORK' }];
    }

    const r = await _bitrixCall('crm.contact.add', { fields });
    return (r && r.result) || null;
  } catch (e) {
    return null;
  }
}

/**
 * criarLead(campos, companyId, contactId, assignedById)
 * v1.0 (21/07/2026): cria o Lead na PRIMEIRA ETAPA (STATUS_ID="NEW") com
 * SOURCE_ID fixo "CEO-Led Outbound". Vincula empresa/contato e responsável.
 * Retorna o ID do lead (ou null).
 */
async function criarLead(campos, companyId, contactId, assignedById) {
  const nome = campos._nomeSep || { first: campos.nome, last: '' };

  // v1.0 (21/07/2026): monta comentário com Origem e Observação do formulário.
  const comentario = [
    campos.origem     ? `Origem informada: ${campos.origem}` : '',
    campos.observacao ? `Observação: ${campos.observacao}`   : ''
  ].filter(Boolean).join('\n');

  const fields = {
    TITLE:              campos.empresa || `${nome.first} ${nome.last}`.trim(),
    NAME:               nome.first || '',
    LAST_NAME:          nome.last  || '',
    COMPANY_TITLE:      campos.empresa || '',
    STATUS_ID:          'NEW',                 // v1.0: primeira etapa "Novos Leads"
    SOURCE_ID:          SOURCE_ID_CEO_LED,     // v1.1: código interno UC_EN7PZM (era rótulo em v1.0)
    COMMENTS:           comentario
  };
  if (companyId)    fields.COMPANY_ID     = companyId;
  if (contactId)    fields.CONTACT_ID     = contactId;
  if (assignedById) fields.ASSIGNED_BY_ID = assignedById;
  if (campos.email && !campos.email.includes('@naoexiste.com')) {
    fields.EMAIL = [{ VALUE: campos.email, VALUE_TYPE: 'WORK' }];
  }
  if (campos.telefone) {
    fields.PHONE = [{ VALUE: campos.telefone, VALUE_TYPE: 'WORK' }];
  }

  try {
    const r = await _bitrixCall('crm.lead.add', { fields });
    return (r && r.result) || null;
  } catch (e) {
    return null;
  }
}

/**
 * montarLinkLead(leadId)
 * v1.2 (05/08/2026): monta a URL amigável do lead no portal Bitrix a partir
 * da base do webhook (extrai o domínio do portal). Movida de
 * api/process-lead.js (_linkLeadBitrix), sem mudança de lógica.
 */
function montarLinkLead(leadId) {
  const base = process.env.BITRIX_WEBHOOK || '';
  // BITRIX_WEBHOOK ~ https://portal.bitrix24.com.br/rest/89/token/
  const m = base.match(/^(https?:\/\/[^/]+)/);
  const portal = m ? m[1] : '';
  if (!portal || !leadId) return '';
  return `${portal}/crm/lead/details/${leadId}/`;
}

/**
 * listarLeadsRecentes({ inicioIso, fimIso, sourceIds })
 * v1.2 (05/08/2026): lista os leads CRIADOS na janela [inicioIso, fimIso)
 * cuja fonte (SOURCE_ID) esteja em sourceIds. Usada pela notificação horária.
 *
 * Estratégia em duas camadas por causa do fuso do portal (ver
 * MARGEM_TZ_MINUTOS): o servidor filtra com folga de 12h e o corte exato é
 * feito aqui comparando o DATE_CREATE retornado (ISO com offset, que o
 * new Date() parseia corretamente).
 *
 * Retorna { ok, leads, erro } — leads ordenados por DATE_CREATE crescente.
 * Fail-soft: erro de rede/API nunca lança, devolve { ok: false, leads: [] }.
 */
async function listarLeadsRecentes({ inicioIso, fimIso, sourceIds }) {
  try {
    const inicioMs = new Date(inicioIso).getTime();
    const fimMs    = new Date(fimIso).getTime();
    const desdeComFolga = new Date(inicioMs - MARGEM_TZ_MINUTOS * 60000).toISOString();

    const filter = { '>=DATE_CREATE': desdeComFolga };
    if (Array.isArray(sourceIds) && sourceIds.length) {
      filter.SOURCE_ID = sourceIds; // array = operador IN no Bitrix
    }

    const todos = [];
    let start = 0;
    for (let pagina = 0; pagina < MAX_PAGINAS_LISTAGEM; pagina++) {
      const r = await _bitrixCall('crm.lead.list', {
        order:  { ID: 'DESC' },
        filter,
        select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'COMPANY_TITLE',
                 'DATE_CREATE', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'EMAIL', 'PHONE',
                 // v1.3 (05/08/2026): quem indicou + e-mail do indicador
                 // (campos UF_* só vêm quando pedidos explicitamente).
                 'SOURCE_DESCRIPTION', 'UF_CRM_1784828550'],
        start
      });
      todos.push(...((r && r.result) || []));
      if (r && typeof r.next === 'number') {
        start = r.next;
      } else {
        break;
      }
    }

    // Corte exato da janela no cliente: inicio <= DATE_CREATE < fim.
    const leads = todos.filter((lead) => {
      const criadoMs = new Date(lead.DATE_CREATE || 0).getTime();
      return criadoMs >= inicioMs && criadoMs < fimMs;
    });
    leads.sort((a, b) => new Date(a.DATE_CREATE) - new Date(b.DATE_CREATE));

    return { ok: true, leads, erro: '' };
  } catch (e) {
    return { ok: false, leads: [], erro: String(e) };
  }
}

module.exports = {
  checarDuplicataExata,
  checarDuplicataFuzzy,
  criarEmpresa,
  criarContato,
  criarLead,
  montarLinkLead,
  listarLeadsRecentes,
  _diceCoefficient // exportado para testes
};
