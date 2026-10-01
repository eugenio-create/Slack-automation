# Bitrix → Slack: novos leads por responsável

Endpoint: `POST /api/notificar-novos-leads` (também aceita GET).

Consulta os leads que estão na etapa de primeiro contato e publica uma mensagem
por lead no canal cujo nome corresponde ao responsável **atual**:

- Paulo Vitor Santos → `novosleads-paulo-vitor-santos`
- Marcos Hernandes → `novosleads-marcos-hernandes`

Usa nome, segundo nome e sobrenome do usuário Bitrix, sem acentos, em minúsculas,
com espaços/pontuação convertidos para hífen. A correspondência é exata; não
usa aproximação ou um canal genérico quando o canal correto não existe.

## Configuração e ativação

1. Reutilize `BITRIX_WEBHOOK` e `SLACK_BOT_TOKEN` já configurados na Vercel.
   O webhook precisa ler CRM e usuários (`user.get`).
2. O bot precisa de `chat:write`, `channels:read` e `groups:read` para listar
   canais públicos e privados. Deve estar convidado a cada canal `novosleads-*`.
   Mudanças de escopos podem exigir reinstalar o app por um administrador.
3. Configure um Redis persistente com API REST Upstash:
   `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.
   A integração da Vercel pode criar `KV_REST_API_URL` e `KV_REST_API_TOKEN`;
   esses nomes também são aceitos, sem copiar ou revelar os segredos.
   Não use armazenamento temporário da função nem política de expulsão dos recibos.
   Redis guarda apenas IDs, estado do envio, timestamp do Slack e identificador
   da tentativa; não guarda respostas do formulário, telefone ou e-mail.
4. Crie `NOVOS_LEADS_SECRET` (segredo novo, longo e aleatório), usado apenas no
   cabeçalho `x-notif-secret` ou `Authorization: Bearer ...`.
5. Etapa: configure `NOVOS_LEADS_STATUS_ID` com o código interno confirmado em
   `crm.status.list` (`ENTITY_ID=STATUS`). Sem essa variável, aceita uma única
   etapa com nome `1º contato pendente` **ou** `1º Contato em andamento`.
   Se ambas existirem, ou nenhuma existir, retorna erro e não envia nada.
6. Primeira execução: `NOVOS_LEADS_INITIAL_MODE=baseline` (padrão) registra os
   cartões que já estão na etapa sem enviar. Apenas os demais IDs serão avisados.
   Para enviar o estoque também, use `all` **antes da primeira execução**.
   Alterar para `all` posteriormente não apaga a baseline já registrada.
7. Configure `NOVOS_LEADS_ENABLED=true` e faça o deploy. Sem essa variável,
   a função permanece desativada. Faça primeiro a verificação sem envio abaixo.
8. Ative **um único** agendador a cada 60 segundos.

Nenhuma credencial deve ser colocada no GitHub, na URL ou em argumentos de linha
de comando. `.env.example` contém somente nomes e placeholders.

### Agendamento de um minuto

A Vercel Hobby não suporta cron nativo por minuto. O cron do GitHub Actions
também não atende a essa cadência. O fluxo horário existente não foi alterado.

**Agendador HTTP externo (por exemplo, cron-job.org):**

- URL: `https://slack-automation-vnr8-ashy.vercel.app/api/notificar-novos-leads`
- Método: `POST`; corpo vazio.
- Cabeçalho: `x-notif-secret`, com o mesmo valor de `NOVOS_LEADS_SECRET` na Vercel.
- Intervalo: todos os minutos, todos os dias, 24 horas.
- Use HTTPS e monitore respostas HTTP diferentes de 200. Se o agendador permitir,
  configure timeout de 60 segundos. Não habilite redirecionamento a outro host.

**Servidor sempre ligado, com Node 20.3+ ou 22:** configure `NOVOS_LEADS_URL` e
`NOVOS_LEADS_SECRET` no ambiente do serviço e execute:

```sh
node scripts/novos-leads-worker.js
```

O worker chama a URL a cada 60 segundos, sem sobreposição, e deve ser mantido
por um supervisor de serviços. Ele não é executado dentro da Vercel. O projeto
não ativa um servidor nem cria uma conta de agendador automaticamente.

**Vercel Pro:** também é possível configurar um cron `* * * * *` para essa rota
e definir `CRON_SECRET` igual a `NOVOS_LEADS_SECRET`. Essa opção não foi adicionada
ao `vercel.json`, pois impediria o deploy no plano Hobby atual descrito pelo projeto.

Referências: [limites do cron da Vercel](https://vercel.com/docs/cron-jobs/usage-and-pricing),
[eventos agendados do GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Mensagem e campos do formulário

A mensagem contém responsável, título, dados preenchidos e botão com o link
direto para `/crm/lead/details/ID/`. Valores do formulário são blocos de texto
simples: um texto como `<!channel>` não dispara uma menção.

Por padrão inclui os campos padrão de nome, empresa, e-mail, telefone e site,
mais os campos encontrados em `crm.lead.fields` pelos rótulos:

- `nome.lead` (exibido no Slack como "Nome do contato"), `email.lead` (só exibido, como "E-mail", quando o E-mail padrão está vazio), `Work Email`;
- `Número de seu WhatsApp com ddd`;
- as variantes de quantidade de contas de WhatsApp usadas pelo portal;
- `Outros Casos de Uso` (`Caso(s) de Uso` e `Sou/Represento uma Empresa` nunca são exibidos);
- `O que você busca resolver com Zapper? - Facebook`.

Abaixo dos dados vêm dois links do WhatsApp (v1.3, 2026-10-01): `wa.me/55...` e
`web.whatsapp.com/send` com a mensagem de primeiro contato já preenchida. O número vem
de `Número de seu WhatsApp com ddd` ou, na falta, de `Telefone de trabalho` (PHONE), e é
normalizado para `55` + DDD + número; números estrangeiros ou inválidos não geram link.

Campos vazios são omitidos; zero é preservado; opções de listas são exibidas pelo
rótulo quando o Bitrix fornece `items`. Se o nome da empresa estiver vazio,
consulta a empresa vinculada por ID (caso de leads repetidos).

Para cobrir outros campos do formulário, configure `NOVOS_LEADS_FORM_FIELDS`
com a lista completa de códigos, separados por vírgula, incluindo os campos padrão
desejados. Essa lista substitui a padrão. Códigos inexistentes e rótulos padrão
ambíguos causam erro para evitar confundir campos. Não se publica todo `UF_*`
indiscriminadamente, pois também contém campos internos que não vêm do formulário.

São os valores atualmente salvos no **lead**, não uma cópia imutável da submissão
original. Dados de contato antigo não substituem silenciosamente os campos do lead.
Verifique a cobertura dos campos reais na simulação antes de ativar o agendamento.

## Verificação sem envio

Com as variáveis configuradas, chame a mesma URL com `?dryRun=1` e o cabeçalho
de autenticação. A resposta traz IDs dos leads, responsáveis, canais resolvidos e
códigos dos campos. Não publica mensagens, não inicializa a baseline e não grava
recibos ou avança o cursor. Usa apenas uma trava temporária para evitar conflito.

Uma resposta `responsible_channel_missing_or_bot_not_member` exige conferir o
nome exato do canal e convidar o bot. O lead permanece elegível para outra tentativa.

## Entrega, falhas e limites

- Pagina por ID crescente e mantém cursor entre chamadas; não há corte fixo nos
  primeiros 50 leads. Ao terminar, reinicia a varredura para pegar entradas de
  leads antigos e novas tentativas.
- O filtro é a etapa atual, não a data de criação. Leads que saem da etapa antes
  da consulta não são avisados. Uma entrada e saída entre duas consultas de um
  minuto pode não ser vista; acompanhar todo evento exigiria webhook.
- Reconsulta o lead antes do envio. Se etapa ou responsável mudou durante a
  preparação, adia para a próxima varredura. Não há transação entre Bitrix e Slack;
  uma mudança no instante posterior à última leitura ainda pode ocorrer.
- Registro persistente por portal + etapa + ID do lead. Um lead entregue não é
  reenviado por alteração de campos, troca posterior de responsável ou reentrada.
- Trava distribuída e reserva atômica evitam duplicação em chamadas simultâneas.
- Erro definitivo de envio (por exemplo, rate limit) libera o lead para tentar
  novamente. Timeout ou resposta ambígua fica em `uncertain`; queda após publicar
  e antes de salvar o recibo fica em `sending`. Esses estados **não** são reenviados
  automaticamente, pois o Slack pode já ter aceitado a mensagem.
- Para resolver `sending`/`uncertain`: conferir o canal indicado no recibo e o
  `Novo lead #ID`. Se existe, atualizar o recibo para `sent` com o `ts`; se ficou
  comprovado que não existe, remover **somente esse ID** do hash de recibos para
  liberar nova tentativa. Nunca limpar todos os recibos para resolver um erro.
- O prefixo Redis é `novosleads:v1:` + primeiros 24 caracteres do SHA-256 de
  `portal/STATUS_ID`. O hash `:records` tem campo igual ao ID do lead.
- Não promete entrega exatamente uma vez em falhas ambíguas de rede; opta por
  bloquear e sinalizar a revisão em vez de duplicar silenciosamente.
- Respeita intervalo de pelo menos 1,1 segundo entre mensagens no mesmo canal.
  Volume alto ou integrações lentas pode exigir vários ciclos. Falhas retornam
  HTTP 502; integração desativada/incompleta retorna 503; segredo inválido, 401.
- A lista inicial `baseline` é registrada atomicamente só após varredura completa.
  Se houver volume tão alto que não caiba no orçamento da função, a inicialização
  falha sem enviar e precisa de janela maior/host apropriado.

## Testes

`npm test` inclui cenários de troca de responsável, etapa alterada, canal ausente,
baseline, paginação, deduplicação persistente, concorrência, rate limit, falha
ambígua, falha após envio, simulação e autenticação. São testes locais com APIs
simuladas; não publicam dados nem substituem a validação das credenciais reais.
