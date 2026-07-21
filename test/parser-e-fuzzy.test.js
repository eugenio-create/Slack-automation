/**
 * ============================================================
 * SLACK → BITRIX LEADS — Testes (parser + fuzzy)
 * ARQUIVO: test/parser-e-fuzzy.test.js | DATA: 21/07/2026 | VERSÃO: 1.2
 * ============================================================
 * v1.2 (21/07/2026): + testes de gerarEmailPlaceholder e ajuste dos testes de
 *   obrigatórios (Email deixou de ser obrigatório).
 * v1.1 (21/07/2026): + testes de extrairEmailTelefone (regex do fallback) e
 *   _extrairJson (limpeza da resposta do Gemini). Continua sem rede.
 * v1.0 (21/07/2026): valida o parser do formulário e o coeficiente de Dice
 *   sem depender de rede (Slack/Bitrix). Rode: node test/parser-e-fuzzy.test.js
 */

const { parseFormulario, separarNome, extrairEmailTelefone, gerarEmailPlaceholder } = require('../lib/parser');
const { _diceCoefficient }             = require('../lib/bitrix');
const { _extrairJson }                 = require('../lib/gemini');

let falhas = 0;
function check(nome, cond) {
  if (cond) { console.log(`  ok  - ${nome}`); }
  else      { console.log(`  FAIL- ${nome}`); falhas++; }
}

console.log('== Parser: formulário completo ==');
const texto1 = [
  'Nome: João Silva',
  'Empresa: Acme Ltda',
  'Email: joao@acme.com',
  'Telefone: (21) 99999-9999',
  'Origem: Indicação',
  'Observação: Quer proposta até sexta'
].join('\n');
const r1 = parseFormulario(texto1);
check('reconhece ok', r1.ok === true);
check('nome',     r1.campos.nome === 'João Silva');
check('empresa',  r1.campos.empresa === 'Acme Ltda');
check('email',    r1.campos.email === 'joao@acme.com');
check('telefone', r1.campos.telefone === '(21) 99999-9999');
check('origem',   r1.campos.origem === 'Indicação');
check('obs',      r1.campos.observacao === 'Quer proposta até sexta');

console.log('== Parser: rótulos alternativos + link Slack ==');
const texto2 = [
  'nome: Maria Souza',
  'EMPRESA: Beta Corp',
  'E-mail: <mailto:maria@beta.com|maria@beta.com>',
  'Fone: +55 21 98888-7777'
].join('\n');
const r2 = parseFormulario(texto2);
check('ok sem opcionais faltando obrig.', r2.ok === true);
check('email limpo do mailto', r2.campos.email === 'maria@beta.com');
check('origem sinônimo Fone→telefone', r2.campos.telefone === '+55 21 98888-7777');

console.log('== Parser: faltando obrigatório (v1.2: email NÃO é mais obrigatório) ==');
const r3 = parseFormulario('Nome: Fulano\nTelefone: 123');
check('não ok (falta empresa)', r3.ok === false);
check('faltando só Empresa', r3.faltando.includes('Empresa') && !r3.faltando.includes('Email'));
const r3b = parseFormulario('Nome: Fulano\nEmpresa: Acme');
check('ok mesmo sem email', r3b.ok === true);

console.log('== separarNome ==');
check('dois nomes', JSON.stringify(separarNome('João Silva')) === JSON.stringify({first:'João', last:'Silva'}));
check('um nome',    JSON.stringify(separarNome('Madonna'))    === JSON.stringify({first:'Madonna', last:''}));
check('tres nomes', separarNome('Ana Paula Costa').last === 'Paula Costa');

console.log('== Dice coefficient ==');
check('idênticos = 1',        _diceCoefficient('Acme Ltda', 'Acme Ltda') === 1);
check('typo alto (>0.7)',     _diceCoefficient('Acme Ltda', 'Acme Lta') > 0.7);
check('diferentes baixo',     _diceCoefficient('Acme Ltda', 'Globex SA') < 0.3);
check('acento ignorado',      _diceCoefficient('João Silva', 'Joao Silva') > 0.9);

console.log('== extrairEmailTelefone (regex, usado no fallback Gemini) ==');
const et1 = extrairEmailTelefone('Contato: Gustavo (founder) — +55 32 99184-4445, email joao@acme.com');
check('email por regex', et1.email === 'joao@acme.com');
check('telefone por regex', et1.telefone.replace(/\D/g, '') === '5532991844445');
const et2 = extrairEmailTelefone('Sem contato aqui, só texto');
check('sem email retorna vazio', et2.email === '');
check('sem telefone retorna vazio', et2.telefone === '');
const et3 = extrairEmailTelefone('Mail: <mailto:maria@beta.com|maria@beta.com>');
check('email limpo de mailto do Slack', et3.email === 'maria@beta.com');

console.log('== _extrairJson (limpeza da resposta do Gemini) ==');
check('json puro',  JSON.stringify(_extrairJson('{"nome":"Ana"}')) === JSON.stringify({nome:'Ana'}));
check('json com cerca ```json', JSON.stringify(_extrairJson('```json\n{"nome":"Ana"}\n```')) === JSON.stringify({nome:'Ana'}));
check('json com texto ao redor', JSON.stringify(_extrairJson('Claro! {"nome":"Ana"} pronto')) === JSON.stringify({nome:'Ana'}));
check('lixo retorna null', _extrairJson('não é json') === null);

console.log('== gerarEmailPlaceholder (v1.5) ==');
const ph1 = gerarEmailPlaceholder('João Silva');
check('termina em @naoexiste.com', ph1.endsWith('@naoexiste.com'));
check('sem acento/espaço na parte local', /^[a-z0-9]+@naoexiste\.com$/.test(ph1));
check('começa com slug do nome', ph1.startsWith('joaosilva'));
check('nome vazio ainda gera válido', /^[a-z0-9]+@naoexiste\.com$/.test(gerarEmailPlaceholder('')));
check('dois placeholders diferem (sufixo aleatório)', gerarEmailPlaceholder('Ana') !== gerarEmailPlaceholder('Ana'));

console.log('');
if (falhas === 0) { console.log('TODOS OS TESTES PASSARAM ✅'); process.exit(0); }
else              { console.log(`${falhas} TESTE(S) FALHARAM ❌`); process.exit(1); }
