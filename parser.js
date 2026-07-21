/**
 * ============================================================
 * SLACK → BITRIX LEADS — Parser do formulário (sem IA)
 * ============================================================
 *
 * ARQUIVO: lib/parser.js   |   DATA: 21/07/2026   |   VERSÃO: 1.0
 *
 * HISTÓRICO
 * ---------
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
 * Nome, Empresa e Email são obrigatórios. Telefone, Origem e Observação
 * são opcionais.
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

    valor = _limparValorSlack(valor);
    if (valor) campos[chave] = valor;
  }

  const faltando = [];
  if (!campos.nome)    faltando.push('Nome');
  if (!campos.empresa) faltando.push('Empresa');
  if (!campos.email)   faltando.push('Email');

  return { ok: faltando.length === 0, campos, faltando };
}

/**
 * _limparValorSlack(valor)
 * v1.0 (21/07/2026): remove os invólucros de link do Slack. Ex.:
 *   <mailto:joao@acme.com|joao@acme.com>  → joao@acme.com
 *   <http://acme.com|acme.com>            → acme.com
 *   <tel:+5521999998888|+5521999998888>   → +5521999998888
 */
function _limparValorSlack(valor) {
  return String(valor || '')
    .replace(/<(?:mailto:|tel:|https?:\/\/)?([^|>]+)(?:\|[^>]*)?>/g, '$1')
    .trim();
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

module.exports = { parseFormulario, separarNome };
