/**
 * ============================================================
 * SLACK → BITRIX LEADS — Parser do formulário (sem IA)
 * ============================================================
 *
 * ARQUIVO: lib/parser.js   |   DATA: 21/07/2026   |   VERSÃO: 1.3
 *
 * HISTÓRICO
 * ---------
 * v1.3 (21/07/2026):
 *   - CORRIGIDO: telefone era cortado (ex.: "553299184" em vez de
 *     "5532991844445"). Causa: o Slack manda o número dentro de
 *     <tel:+55...%E2%80%91...|55 32 99184‑4445>, onde %E2%80%91 e o "‑" são
 *     hífen NÃO-QUEBRÁVEL Unicode (U+2011), não o hífen comum "-". O limpador
 *     de link pegava a parte "tel:" com o %E2%80%91 no meio e o regex parava
 *     nos dígitos antes do lixo; além disso o regex de telefone só reconhecia
 *     "-" ASCII.
 *   - _normalizarUnicodeTexto(): decodifica percent-encoding, troca hífens e
 *     espaços Unicode por ASCII. Aplicado antes de extrair telefone/e-mail.
 *   - _limparValorSlack(): para <tel:...|...> passa a preferir a parte DEPOIS
 *     do "|" (o texto legível que o usuário vê), normalmente mais limpa.
 * v1.2 (21/07/2026):
 *   - Email deixou de ser OBRIGATÓRIO. Agora só Nome e Empresa são exigidos.
 *     Quando o e-mail não vem no texto, o process-lead (v1.5) gera um
 *     placeholder válido (nome+id@naoexiste.com), no mesmo padrão do fluxo
 *     Apollo/Meetime de referência. Motivo: leads CEO-led frequentemente
 *     chegam sem e-mail, e o telefone serve como identificador.
 * v1.1 (21/07/2026):
 *   - Adicionada extrairEmailTelefone(texto): pega e-mail e telefone de um
 *     texto livre por regex (sem depender de rótulo "Campo:"). Usada no
 *     fluxo de fallback com Gemini (process-lead v1.4): o Gemini infere
 *     nome/empresa/origem/observação, mas e-mail e telefone — por serem
 *     críticos — continuam vindo do regex sobre o texto original.
 * v1.0 (21/07/2026):
 *   - Versão inicial. Parseia o formato combinado "campo: valor" (uma linha
 *     por campo), tolerante a acentos, maiúsculas/minúsculas e variações de
 *     rótulo. Sem IA — 100% regex/heurística, determinístico.
 *
 * FORMATO ESPERADO (uma linha por campo)
 * --------------------------------------
 *   Nome: João Silva
 *   Empresa: Acme Ltda
 *   Email: joao@acme.com
 *   Telefone: (21) 99999-9999
 *   Origem: Indicação
 *   Observação: Cliente quer proposta até sexta
 *
 * Nome e Empresa são obrigatórios. Email, Telefone, Origem e Observação são
 * opcionais — se o Email não vier, o process-lead gera um placeholder válido
 * (v1.5).  // v1.2 (21/07/2026): Email deixou de ser obrigatório.
 * ============================================================
 */

/**
 * _normalizarRotulo(s)
 * v1.0 (21/07/2026): baixa caixa, remove acentos e espaços das pontas —
 * usado para casar o rótulo do formulário independente de como foi digitado.
 */
function _normalizarRotulo(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// v1.0 (21/07/2026): sinônimos aceitos por campo → chave canônica interna.
const MAPA_ROTULOS = {
  'nome':        'nome',
  'empresa':     'empresa',
  'email':       'email',
  'e-mail':      'email',
  'telefone':    'telefone',
  'tel':         'telefone',
  'fone':        'telefone',
  'celular':     'telefone',
  'origem':      'origem',
  'fonte':       'origem',
  'observacao':  'observacao',
  'observacoes': 'observacao',
  'obs':         'observacao',
  'nota':        'observacao',
  'notas':       'observacao'
};

/**
 * parseFormulario(texto)
 * v1.0 (21/07/2026): quebra o texto em linhas, casa cada linha no padrão
 * "rótulo: valor" e monta o objeto lead. Slack às vezes envolve links em
 * <mailto:...|...> ou <http...|...>; limpamos esses invólucros.
 *
 * Retorna { ok, campos, faltando } onde:
 *   - campos   : { nome, empresa, email, telefone, origem, observacao }
 *   - faltando : array com os obrigatórios ausentes ([] se completo)
 */
function parseFormulario(texto) {
  const campos = {
    nome: '', empresa: '', email: '',
    telefone: '', origem: '', observacao: ''
  };

  const linhas = String(texto || '').split(/\r?\n/);
  for (const linha of linhas) {
    const idx = linha.indexOf(':');
    if (idx < 0) continue;

    const rotuloBruto = linha.substring(0, idx);
    let valor         = linha.substring(idx + 1).trim();

    const chave = MAPA_ROTULOS[_normalizarRotulo(rotuloBruto)];
    if (!chave) continue;

    // v1.3 (21/07/2026): normaliza Unicode (hífen não-quebrável, %E2%80%91
    // etc.) antes de limpar o invólucro do Slack, para o telefone não sair
    // cortado também no formato "Telefone: <tel:...|...>".
    valor = _limparValorSlack(_normalizarUnicodeTexto(valor));
    if (valor) campos[chave] = valor;
  }

  const faltando = [];
  if (!campos.nome)    faltando.push('Nome');
  if (!campos.empresa) faltando.push('Empresa');
  // v1.2 (21/07/2026): Email removido dos obrigatórios — placeholder é gerado
  // no process-lead quando ausente.

  return { ok: faltando.length === 0, campos, faltando };
}

/**
 * _normalizarUnicodeTexto(valor)
 * v1.3 (21/07/2026): normaliza caracteres que quebravam a extração de
 * telefone. Decodifica percent-encoding (ex.: %E2%80%91 → o caractere real),
 * depois troca hífens Unicode (U+2010..U+2015, U+2212) pelo hífen ASCII "-" e
 * espaços especiais (NBSP, narrow no-break space) por espaço comum. Assim o
 * regex de telefone, que só entende "-" e espaço comuns, funciona.
 */
function _normalizarUnicodeTexto(valor) {
  let s = String(valor || '');
  // Decodifica %XX (ex.: %E2%80%91). Se vier malformado, ignora e segue.
  try { s = decodeURIComponent(s); } catch (e) { /* mantém original */ }
  return s
    .replace(/[\u2010-\u2015\u2212]/g, '-') // hífens/traços Unicode → "-"
    .replace(/[\u00A0\u202F\u2007]/g, ' ');  // espaços especiais → " "
}

/**
 * _limparValorSlack(valor)
 * v1.0 (21/07/2026): remove os invólucros de link do Slack. Ex.:
 *   <mailto:joao@acme.com|joao@acme.com>  → joao@acme.com
 *   <http://acme.com|acme.com>            → acme.com
 *   <tel:+5521999998888|+5521999998888>   → +5521999998888
 * v1.3 (21/07/2026): para <tel:...|texto> passou a preferir a parte DEPOIS do
 * "|" (o texto legível que o usuário digitou/vê), que costuma vir mais limpa
 * que a parte "tel:" (esta às vezes traz %E2%80%91 e afins). Para os demais
 * links (mailto/http) mantém a parte antes do "|", como antes.
 */
function _limparValorSlack(valor) {
  let s = String(valor || '');

  // <tel:PARTE_A|PARTE_B> → usa PARTE_B (texto legível) quando existir
  s = s.replace(/<tel:([^|>]*)(?:\|([^>]*))?>/g, (m, a, b) => (b && b.trim()) ? b : a);

  // <mailto:..|..> e <http(s)://..|..> → usa a primeira parte (o alvo)
  s = s.replace(/<(?:mailto:|https?:\/\/)([^|>]+)(?:\|[^>]*)?>/g, '$1');

  // Qualquer outro <..|..> genérico → primeira parte
  s = s.replace(/<([^|>]+)(?:\|[^>]*)?>/g, '$1');

  return s.trim();
}

/**
 * separarNome(nomeCompleto)
 * v1.0 (21/07/2026): divide "João Silva" em { first: 'João', last: 'Silva' }
 * para preencher NAME/LAST_NAME no Bitrix. Se houver só um token, last fica ''.
 */
function separarNome(nomeCompleto) {
  const partes = String(nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return { first: '', last: '' };
  return {
    first: partes[0],
    last:  partes.slice(1).join(' ')
  };
}

/**
 * extrairEmailTelefone(texto)
 * v1.1 (21/07/2026): extrai e-mail e telefone de um texto livre por regex.
 * v1.3 (21/07/2026): normaliza Unicode (hífens/espaços especiais e
 * percent-encoding) ANTES de casar, corrigindo números cortados que vinham
 * com hífen não-quebrável do Slack (ex.: 55 32 99184‑4445).
 *
 * - E-mail: primeiro que casar um padrão de e-mail simples.
 * - Telefone: primeiro bloco que pareça um número BR/internacional (aceita
 *   +, DDI, DDD, espaços, hífens e parênteses; exige ao menos 8 dígitos).
 *
 * Retorna { email, telefone } (strings vazias se não achar).
 */
function extrairEmailTelefone(texto) {
  // v1.3: normaliza Unicode primeiro, depois remove invólucros do Slack.
  const limpo = _limparValorSlack(_normalizarUnicodeTexto(String(texto || '')));

  // E-mail
  const emailMatch = limpo.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
  const email = emailMatch ? emailMatch[0].trim() : '';

  // Telefone: candidatos com dígitos, +, (), espaços e hífens.
  // v1.3: permite "+" também no meio (alguns formatos) e mantém exigência de
  // 8+ dígitos para evitar falsos positivos (horários, CEPs curtos etc.).
  let telefone = '';
  const candidatos = limpo.match(/\+?[\d][\d\s().+\-]{7,}\d/g) || [];
  for (const c of candidatos) {
    const soDigitos = c.replace(/\D/g, '');
    if (soDigitos.length >= 8) { telefone = c.trim(); break; }
  }

  return { email, telefone };
}

/**
 * gerarEmailPlaceholder(nome)
 * v1.2 (21/07/2026): gera um e-mail placeholder VÁLIDO para leads sem e-mail,
 * no mesmo padrão do fluxo Apollo/Meetime de referência: parte alfanumérica
 * do nome + sufixo aleatório curto + @naoexiste.com. Garante formato de
 * e-mail válido (não quebra validações), e o domínio @naoexiste.com sinaliza
 * claramente que é placeholder (o Bitrix não deve receber esse valor no campo
 * EMAIL — quem consome trata @naoexiste.com como "sem e-mail").
 */
function gerarEmailPlaceholder(nome) {
  const slug = String(nome || 'lead')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 30) || 'lead';
  const rid = Math.random().toString(36).substring(2, 8);
  return `${slug}${rid}@naoexiste.com`;
}

module.exports = { parseFormulario, separarNome, extrairEmailTelefone, gerarEmailPlaceholder };
