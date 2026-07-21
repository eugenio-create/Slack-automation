/**
 * ============================================================
 * SLACK → BITRIX LEADS — Helper do Gemini (fallback de parsing)
 * ============================================================
 *
 * ARQUIVO: lib/gemini.js   |   DATA: 21/07/2026   |   VERSÃO: 1.1
 *
 * HISTÓRICO
 * ---------
 * v1.1 (21/07/2026):
 *   - Adicionados console.log de diagnóstico (chave presente?, modelo, status
 *     HTTP da resposta) para permitir depurar pelos logs da Vercel por que o
 *     fallback não está sendo aplicado.
 * v1.0 (21/07/2026):
 *   - Versão inicial. Usado APENAS como fallback quando o parser
 *     determinístico (lib/parser.js) não encontra os campos obrigatórios
 *     numa mensagem de texto livre. Chama o endpoint generateContent do
 *     Gemini pedindo JSON estruturado. E-mail e telefone NÃO dependem daqui
 *     — continuam sendo extraídos por regex no process-lead (v1.4), pois são
 *     campos críticos que não podem sair errados.
 *
 * VARIÁVEIS DE AMBIENTE
 * ---------------------
 * - GEMINI_API_KEY : chave da API do Google AI Studio (free tier ok)
 *                    Criar em https://aistudio.google.com/apikey
 *
 * NOTAS
 * -----
 * - Modelo padrão: gemini-2.0-flash (rápido e barato/gratuito). Trocável
 *   pela env GEMINI_MODEL, se quiser.
 * - A resposta do Gemini às vezes vem envolvida em ```json ... ``` ou com
 *   texto extra — _extrairJson() limpa isso antes do parse.
 * - É best-effort: qualquer falha (sem chave, erro de rede, JSON inválido)
 *   retorna { ok: false }, e o process-lead cai no comportamento anterior
 *   (aviso "faltou preencher").
 * ============================================================
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * _extrairJson(texto)
 * v1.0 (21/07/2026): extrai o primeiro objeto JSON de uma string, removendo
 * cercas de código markdown (```json ... ```) e texto ao redor. Retorna o
 * objeto parseado ou null.
 */
function _extrairJson(texto) {
  if (!texto) return null;
  let s = String(texto).trim();

  // Remove cercas ```json ... ``` ou ``` ... ```
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Se ainda houver texto ao redor, isola do primeiro { ao último }
  const ini = s.indexOf('{');
  const fim = s.lastIndexOf('}');
  if (ini >= 0 && fim > ini) s = s.substring(ini, fim + 1);

  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/**
 * extrairCamposViaGemini(textoLivre)
 * v1.0 (21/07/2026): envia o texto livre ao Gemini e pede os campos do lead
 * em JSON. Retorna { ok, campos } onde campos = { nome, empresa, origem,
 * observacao }. NÃO retorna email/telefone (esses vêm do regex no
 * process-lead — decisão de projeto para não depender da IA em campos
 * críticos). Em qualquer falha, retorna { ok: false }.
 */
async function extrairCamposViaGemini(textoLivre) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('[gemini.js] GEMINI_API_KEY ausente — pulando.');
    return { ok: false, erro: 'GEMINI_API_KEY ausente' };
  }
  if (!textoLivre || !textoLivre.trim()) return { ok: false, erro: 'texto vazio' };

  const modelo = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  console.log('[gemini.js] chamando modelo', modelo);

  // v1.0 (21/07/2026): prompt fixo. Pede SÓ JSON, sem markdown, com os campos
  // que a IA deve inferir. E-mail/telefone deixados de fora de propósito.
  const prompt = [
    'Você extrai dados de leads de vendas a partir de texto livre em português.',
    'Leia a mensagem abaixo e responda APENAS com um objeto JSON válido, sem',
    'markdown, sem cercas de código, sem texto antes ou depois.',
    'Formato exato: {"nome":"","empresa":"","origem":"","observacao":""}',
    '- nome: nome da pessoa de contato (não o da empresa). Se não houver, "".',
    '- empresa: nome da empresa/organização. Se não houver, "".',
    '- origem: como o lead chegou (indicação, evento, quem apresentou etc). Se não houver, "".',
    '- observacao: qualquer contexto relevante (necessidade, status, classificação,',
    '  cargo, condições comerciais). Concatene em uma frase. Se não houver, "".',
    'Não invente dados que não estão no texto.',
    '',
    'Mensagem:',
    '"""',
    textoLivre,
    '"""'
  ].join('\n');

  const url = `${GEMINI_BASE}/${modelo}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,          // baixa: mais determinístico
          maxOutputTokens: 512,
          responseMimeType: 'application/json' // pede JSON puro quando suportado
        }
      })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.log('[gemini.js] HTTP', resp.status, txt.substring(0, 300));
      return { ok: false, erro: `Gemini status ${resp.status}: ${txt.substring(0, 200)}` };
    }

    const data = await resp.json();
    // Caminho padrão da resposta: candidates[0].content.parts[0].text
    const texto =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    const obj = _extrairJson(texto);
    if (!obj) return { ok: false, erro: 'resposta do Gemini não é JSON válido' };

    return {
      ok: true,
      campos: {
        nome:       String(obj.nome       || '').trim(),
        empresa:    String(obj.empresa    || '').trim(),
        origem:     String(obj.origem     || '').trim(),
        observacao: String(obj.observacao || '').trim()
      }
    };
  } catch (err) {
    return { ok: false, erro: String(err) };
  }
}

module.exports = { extrairCamposViaGemini, _extrairJson };
