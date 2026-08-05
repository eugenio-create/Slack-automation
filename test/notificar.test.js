/**
 * ============================================================
 * TESTES — _formatarMensagem (api/notificar-leads.js)
 * ============================================================
 * Rodar: node test/notificar.test.js
 * Node puro, sem framework — sai com código 1 se algo falhar.
 * ============================================================
 */

const { _formatarMensagem } = require('../api/notificar-leads');

let falhas = 0;
function verificar(descricao, condicao) {
  if (condicao) {
    console.log(`  ✅ ${descricao}`);
  } else {
    console.log(`  ❌ ${descricao}`);
    falhas++;
  }
}

// Sem BITRIX_WEBHOOK no ambiente de teste, montarLinkLead retorna '' e as
// linhas saem sem link — cenário coberto abaixo. Com a env definida, os
// títulos viram <url|rótulo>.
delete process.env.BITRIX_WEBHOOK;

console.log('— 1 lead (singular, sem link) —');
{
  const texto = _formatarMensagem([{
    ID: '101', TITLE: 'Acme Ltda', NAME: 'João', LAST_NAME: 'Silva',
    COMPANY_TITLE: 'Acme Ltda', DATE_CREATE: '2026-08-05T09:12:33-03:00',
    EMAIL: [{ VALUE: 'joao@acme.com', VALUE_TYPE: 'WORK' }],
    PHONE: [{ VALUE: '(21) 99999-9999', VALUE_TYPE: 'WORK' }]
  }]);
  verificar('usa singular "Chegou 1 nova indicação"', texto.includes('Chegou 1 nova indicação:'));
  verificar('mostra o título', texto.includes('Acme Ltda'));
  verificar('mostra o nome', texto.includes('João Silva'));
  verificar('mostra o e-mail real', texto.includes('joao@acme.com'));
  verificar('mostra o telefone', texto.includes('(21) 99999-9999'));
  verificar('mostra o horário do portal (09:12)', texto.includes('criado às 09:12'));
  verificar('sem BITRIX_WEBHOOK não gera link <url|...>', !texto.includes('<http'));
}

console.log('— plural —');
{
  const leads = [
    { ID: '1', TITLE: 'Empresa A', DATE_CREATE: '2026-08-05T10:00:00-03:00' },
    { ID: '2', TITLE: 'Empresa B', DATE_CREATE: '2026-08-05T10:30:00-03:00' }
  ];
  const texto = _formatarMensagem(leads);
  verificar('usa plural "Chegaram 2 novas indicações"', texto.includes('Chegaram 2 novas indicações:'));
  verificar('uma linha de bullet por lead', (texto.match(/^• /gm) || []).length === 2);
}

console.log('— e-mail placeholder nunca aparece —');
{
  const texto = _formatarMensagem([{
    ID: '3', TITLE: 'Beta SA', NAME: 'Ana', LAST_NAME: 'Souza',
    DATE_CREATE: '2026-08-05T11:05:00-03:00',
    EMAIL: [{ VALUE: 'ana123@naoexiste.com', VALUE_TYPE: 'WORK' }]
  }]);
  verificar('omite @naoexiste.com', !texto.includes('naoexiste.com'));
}

console.log('— lead sem nada além do ID —');
{
  const texto = _formatarMensagem([{ ID: '4' }]);
  verificar('cai no fallback "Lead 4"', texto.includes('Lead 4'));
}

console.log('— com BITRIX_WEBHOOK gera link —');
{
  process.env.BITRIX_WEBHOOK = 'https://portal.bitrix24.com.br/rest/89/token/';
  const texto = _formatarMensagem([{ ID: '5', TITLE: 'Gama ME', DATE_CREATE: '2026-08-05T12:00:00-03:00' }]);
  verificar('linha vira <url|rótulo>', texto.includes('<https://portal.bitrix24.com.br/crm/lead/details/5/|Gama ME>'));
  delete process.env.BITRIX_WEBHOOK;
}

if (falhas > 0) {
  console.log(`\n${falhas} teste(s) falharam.`);
  process.exit(1);
}
console.log('\nTodos os testes passaram.');
