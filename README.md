# Slack → Bitrix Leads

**Versão 1.6 — 05/08/2026**

Automação que cria um lead no Bitrix24 a partir de uma reação com emoji numa mensagem do Slack, com checagem de duplicidade. O caminho principal é 100% determinístico (regex + similaridade de string); mensagens em texto livre podem ser estruturadas por um fallback opcional com Gemini. Roda em Vercel (plano gratuito).

A partir da v1.6, o mesmo deploy também envia uma **notificação de hora em hora** com os leads criados no Bitrix com origem "Por Recomendação", num **canal separado** do Slack (ver seção própria abaixo). As duas funcionalidades coexistem sem interferência: o fluxo de reações continua respondendo nas threads dos canais onde o bot estiver, e a notificação horária só escreve no canal configurado em `SLACK_CANAL_NOTIFICACOES`.

## Como funciona

1. Você preenche um formulário na thread do Slack (uma linha por campo) e reage à sua própria mensagem com um dos 3 emojis.
2. O emoji define o responsável do lead no Bitrix:
   - `1️⃣` → responsável **7**
   - `2️⃣` → responsável **68**
   - `3️⃣` → responsável **89**
3. A automação lê a mensagem, checa se o lead já existe (por e-mail/telefone e, como fallback, por similaridade de nome+empresa) e, se for novo, cria **Empresa → Contato → Lead** no Bitrix.
4. O lead entra na primeira etapa (`STATUS_ID = NEW`, "Novos Leads") com `SOURCE_ID = UC_EN7PZM` (código interno da fonte "CEO-Led Outbound").
5. A automação responde na thread confirmando (criado, já existe, ou possível duplicata).

## Formato do formulário

```
Nome: João Silva
Empresa: Acme Ltda
Email: joao@acme.com
Telefone: (21) 99999-9999
Origem: Indicação
Observação: Cliente quer proposta até sexta
```

`Nome` e `Empresa` são obrigatórios. `Email`, `Telefone`, `Origem` e `Observação` são opcionais. Rótulos aceitam variações (E-mail, Fone, Obs, Fonte, etc.), acentos e maiúsculas/minúsculas.

**E-mail ausente:** a partir da v1.5, se o lead não tiver e-mail, a automação gera um placeholder válido (`nome+id@naoexiste.com`) e cria o lead assim mesmo — o telefone serve de identificador. Esse placeholder **não** é gravado no campo EMAIL do Bitrix (o campo fica vazio); ele só evita recusar o lead. Útil para leads CEO-led que frequentemente chegam sem e-mail.

## Fallback com Gemini (opcional — texto livre)

A partir da v1.4, se a mensagem **não** estiver no formato do formulário, a automação tenta estruturá-la com o Google Gemini:

- Só é acionado quando o parser determinístico falha (mensagem já formatada nunca chama a IA — economiza cota e latência).
- O Gemini infere **nome, empresa, origem e observação**.
- **E-mail e telefone continuam sendo extraídos por regex** do texto original, não pela IA — são campos críticos que não podem sair errados.
- Se `GEMINI_API_KEY` não estiver configurada, o fallback fica desligado e só o formato "Campo: valor" é aceito (comportamento das versões anteriores).

Para habilitar: crie uma chave em https://aistudio.google.com/apikey (free tier serve) e configure `GEMINI_API_KEY` nas Environment Variables da Vercel. Opcionalmente, `GEMINI_MODEL` (padrão `gemini-2.0-flash`). Lembre-se de fazer **Redeploy** após adicionar a variável.

A partir da v1.5, e-mail é opcional em todos os caminhos: se a IA estruturar a mensagem mas o regex não achar um e-mail no texto, a automação gera um placeholder e cria o lead assim mesmo (usando o telefone como identificador).

## Estrutura

```
api/
  slack-events.js    Recebe reaction_added, valida assinatura, responde < 3s,
                     dispara o processamento assíncrono.
  process-lead.js    Lê a mensagem, parseia, checa duplicidade, cria no Bitrix,
                     responde na thread.
  notificar-leads.js Notificação horária: consulta leads "Por Recomendação"
                     criados na última hora e posta resumo no canal dedicado.
lib/
  slack.js           Buscar mensagem reagida, responder na thread e postar
                     mensagem direta em canal.
  parser.js          Parser do formulário (regex) + extração email/telefone.
  gemini.js          Fallback opcional: estrutura texto livre via Gemini.
  bitrix.js          Duplicidade (exata + fuzzy), criação Empresa/Contato/Lead,
                     listagem de leads recentes por fonte e link do lead.
.github/workflows/
  notificar-leads.yml  Cron horário (GitHub Actions) que chama o endpoint de
                       notificação.
test/
  parser-e-fuzzy.test.js  Testes locais (node test/parser-e-fuzzy.test.js).
  notificar.test.js       Testes da formatação do resumo horário.
```

## Passo a passo de deploy

### 1. Criar o Slack App
Em https://api.slack.com/apps → **Create New App** → From scratch.

**OAuth & Permissions** → Bot Token Scopes, adicione:
- `channels:history` (canais públicos) e/ou `groups:history` (canais privados)
- `reactions:read`
- `chat:write`

Instale o app no workspace e copie o **Bot User OAuth Token** (`xoxb-...`).

Em **Basic Information** → App Credentials, copie o **Signing Secret**.

### 2. Deploy na Vercel
- Suba este projeto num repositório (GitHub) e importe na Vercel, **ou** rode `vercel` pela CLI.
- Em **Settings → Environment Variables**, configure (veja `.env.example`):
  - `SLACK_SIGNING_SECRET`
  - `SLACK_BOT_TOKEN`
  - `BITRIX_WEBHOOK` (termina com `/`)
  - `SELF_BASE_URL` (a URL do próprio deploy, ex.: `https://slack-bitrix-leads.vercel.app`)
- Faça o deploy. Anote a URL pública.

### 3. Ligar os eventos do Slack
No Slack App → **Event Subscriptions** → Enable.
- **Request URL**: `https://SEU-APP.vercel.app/api/slack-events`
  (o Slack fará o handshake `url_verification` automaticamente — o endpoint já responde ao challenge).
- Em **Subscribe to bot events**, adicione `reaction_added`.
- Salve.

### 4. Adicionar o bot ao canal
Convide o bot para o canal onde os leads são trazidos: `/invite @seu-bot`.
(Sem isso, o bot não consegue ler a mensagem nem responder na thread.)

### 5. Testar
Poste uma mensagem no formato do formulário e reaja com `1️⃣`, `2️⃣` ou `3️⃣`.
A automação deve responder na thread em alguns segundos.

## Notificação horária de leads (Por Recomendação)

De hora em hora, um workflow do GitHub Actions chama `/api/notificar-leads`, que consulta no Bitrix os leads **criados na última hora** com a fonte configurada (padrão: `RECOMMENDATION`, "Por Recomendação") e posta um resumo num canal dedicado do Slack — **diferente** do canal onde o fluxo de reações opera. Se não houver nenhum lead na janela, nada é postado (evita ruído de 24 mensagens/dia).

A janela é **alinhada ao relógio**: cada execução reporta a hora-relógio anterior completa (ex.: a execução das 10:05 reporta `[09:00, 10:00)`). Assim, atrasos de alguns minutos no cron do GitHub não perdem nem duplicam leads. Tradeoff aceito: se uma execução atrasar além da virada da hora seguinte ou for pulada, aquela hora fica sem notificação.

### Configurar

**1. Variáveis de ambiente na Vercel** (Settings → Environment Variables + Redeploy):

| Variável | Obrigatória | Descrição |
|---|---|---|
| `SLACK_CANAL_NOTIFICACOES` | Sim | ID do canal de notificações (ex.: `C0123ABCDEF`). Pegue em: detalhes do canal no Slack → "Channel ID". |
| `NOTIF_SECRET` | Sim | Segredo compartilhado que protege o endpoint (gere um valor longo e aleatório). |
| `NOTIF_SOURCE_ID` | Não | Código(s) interno(s) da fonte, separados por vírgula. Padrão: `RECOMMENDATION`. |
| `NOTIF_JANELA_MINUTOS` | Não | Tamanho da janela em minutos. Padrão: `60`. |

**2. Secret no GitHub** (repo → Settings → Secrets and variables → Actions):
- `NOTIF_SECRET`: mesmo valor configurado na Vercel

A URL do deploy fica fixa no próprio workflow (`.github/workflows/notificar-leads.yml`, env `NOTIF_URL`) — ela não é sensível, pois o endpoint é protegido pelo segredo. Se a URL do deploy mudar, atualize lá. Sem o secret `NOTIF_SECRET`, o workflow falha logo no primeiro passo com mensagem explicando o que criar.

**3. Convidar o bot para o canal de notificações**: `/invite @seu-bot` no canal. Sem isso, o envio falha com `not_in_channel`.

### Verificar o código da fonte

Se as notificações não trouxerem os leads esperados, confirme o código interno da fonte "Por Recomendação" no seu portal:

```
curl -s "SEU_BITRIX_WEBHOOK/crm.status.list.json?filter[ENTITY_ID]=SOURCE"
```

Procure o item com `NAME = "Por Recomendação"` e use o `STATUS_ID` dele em `NOTIF_SOURCE_ID`.

### Testar manualmente

```
# Sem o header → deve retornar 401
curl -X POST "https://seu-app.vercel.app/api/notificar-leads"

# Janela larga de teste (últimos 7 dias) → posta resumo com leads antigos
curl -X POST "https://seu-app.vercel.app/api/notificar-leads?janelaTesteMinutos=10080" \
  -H "x-notif-secret: SEU_SEGREDO"
```

Também dá para disparar o workflow manualmente: GitHub → Actions → "Notificação horária de leads" → Run workflow. Os logs da função ficam em Vercel → Logs.

## Ajustes de duplicidade

- **Exata**: usa `crm.duplicate.findbycomm` (e-mail, depois telefone).
- **Fuzzy** (fallback): compara nome+empresa contra os leads mais recentes com o coeficiente de Sørensen–Dice. Limiar em `lib/bitrix.js` → `LIMIAR_FUZZY` (padrão `0.85`). Aumente para ser mais permissivo (menos bloqueios), diminua para pegar mais possíveis duplicatas.
- No match fuzzy, a automação **não cria** o lead automaticamente — apenas avisa na thread, deixando a decisão com você (evita bloquear leads legítimos por engano).

## Notas de segurança

- A assinatura de todas as requisições do Slack é verificada (HMAC v0) com proteção contra replay (5 min).
- Segredos ficam só nas Environment Variables da Vercel, nunca no código.
- E-mails placeholder (`@naoexiste.com`) não são gravados no campo EMAIL do Bitrix.
