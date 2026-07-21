# Slack → Bitrix Leads

**Versão 1.5 — 21/07/2026**

Automação que cria um lead no Bitrix24 a partir de uma reação com emoji numa mensagem do Slack, com checagem de duplicidade. O caminho principal é 100% determinístico (regex + similaridade de string); mensagens em texto livre podem ser estruturadas por um fallback opcional com Gemini. Roda em Vercel (plano gratuito).

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
  slack-events.js   Recebe reaction_added, valida assinatura, responde < 3s,
                    dispara o processamento assíncrono.
  process-lead.js   Lê a mensagem, parseia, checa duplicidade, cria no Bitrix,
                    responde na thread.
lib/
  slack.js          Buscar mensagem reagida + postar resposta na thread.
  parser.js         Parser do formulário (regex) + extração email/telefone.
  gemini.js         Fallback opcional: estrutura texto livre via Gemini.
  bitrix.js         Duplicidade (exata + fuzzy) e criação Empresa/Contato/Lead.
test/
  parser-e-fuzzy.test.js  Testes locais (node test/parser-e-fuzzy.test.js).
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

## Ajustes de duplicidade

- **Exata**: usa `crm.duplicate.findbycomm` (e-mail, depois telefone).
- **Fuzzy** (fallback): compara nome+empresa contra os leads mais recentes com o coeficiente de Sørensen–Dice. Limiar em `lib/bitrix.js` → `LIMIAR_FUZZY` (padrão `0.85`). Aumente para ser mais permissivo (menos bloqueios), diminua para pegar mais possíveis duplicatas.
- No match fuzzy, a automação **não cria** o lead automaticamente — apenas avisa na thread, deixando a decisão com você (evita bloquear leads legítimos por engano).

## Notas de segurança

- A assinatura de todas as requisições do Slack é verificada (HMAC v0) com proteção contra replay (5 min).
- Segredos ficam só nas Environment Variables da Vercel, nunca no código.
- E-mails placeholder (`@naoexiste.com`) não são gravados no campo EMAIL do Bitrix.
