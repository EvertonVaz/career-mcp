# career-mcp

Servidor MCP que mantém LinkedIn, currículo e portfólio coerentes entre si, a
partir de um `career.yml` versionado em Git e do GitHub como feed de evidências.

Transporte **Streamable HTTP**, stateless. Roda no homelab atrás do Tailscale,
com TLS terminado no Traefik do Coolify.

## A regra que rege o projeto

`data/career.yml` é a única fonte de verdade. Tudo o mais é derivado e
descartável: `output/` se regenera, `cache/` se refaz com um sync, `history/`
guarda o que foi sobrescrito.

Nada entra sem procedência. Cada entidade carrega:

```yaml
provenance:
  verified: false          # false = sugestão; true = você conferiu
  source: manual           # manual | github | inferred
  source_ref: github:etovaz/career-mcp
  last_synced_at: 2026-09-12T11:00:00Z
```

O GitHub nunca escreve `problem`, `solution`, `result` nem bullet de
experiência — ele não sabe disso. O que ele oferece vira proposta com
`verified: false`, e só vira fato via `mark_verified`.

## Rodando local

```bash
npm install
cp .env.example .env          # preencha MCP_AUTH_TOKEN
npm run dev
```

Gere o token com `openssl rand -hex 32`.

```bash
npm test            # 352 testes
npm run typecheck
npm run build       # tsup -> dist/server.js
npm start
```

Um `data/career.yml` mínimo para começar:

```yaml
profile:
  name: Seu Nome
  headline: Desenvolvedor Backend
experiences:
  - id: acme-2023
    company: Acme
    role: Backend Dev
    start: 01/03/2023          # DD/MM/YYYY, entre aspas se o YAML reclamar
```

Datas são sempre `DD/MM/YYYY` em string. `end` ausente ou `null` significa
cargo atual.

## Variáveis de ambiente

| var | default | para quê |
|---|---|---|
| `MCP_PORT` | `3000` | porta HTTP interna |
| `MCP_HOST` | `0.0.0.0` | precisa ser `0.0.0.0` em container |
| `MCP_AUTH_TOKEN` | — | **obrigatória**; bearer token de `/mcp` |
| `GITHUB_TOKEN` | — | PAT; só as tools de GitHub precisam |
| `GITHUB_API_URL` | api.github.com | só para GitHub Enterprise |
| `CAREER_DATA_DIR` | `/app/data` | canônico |
| `CAREER_HISTORY_DIR` | `/app/history` | snapshots |
| `CAREER_OUTPUT_DIR` | `/app/output` | gerados |
| `CAREER_CACHE_DIR` | `/app/cache` | cache do GitHub |

O `.env` é lido nativamente pelo Node. No container ele não existe: o Coolify
injeta as vars direto.

## Rotas

| rota | auth | o que faz |
|---|---|---|
| `POST /mcp` | bearer | JSON-RPC do MCP |
| `GET /mcp` | bearer | 405 — sem SSE, o servidor é stateless |
| `DELETE /mcp` | bearer | no-op |
| `GET /health` | isenta | healthcheck do Coolify |

O token é comparado por SHA-256 com `timingSafeEqual`. O 401 é genérico e não
manda `WWW-Authenticate`.

## Resources

| uri | conteúdo |
|---|---|
| `career://profile` `experiences` `projects` `skills` `education` `certifications` `languages` | fatias do career.yml, já validadas |
| `github://repos` | último `sync_github` (cache) |
| `github://activity` | último relatório de atividade (cache) |
| `output://linkedin` `resume` `portfolio` | última geração |

## Tools

**Leitura** — `search_experiences`, `search_projects`, `search_skills`,
`validate_all`.

Busca ignora caixa e acento. `tech`/`stack` são AND: pedir dois traz só quem
tem os dois.

**Escrita** — `update_profile`, `add_experience`, `update_experience`, `delete_experience`,
`add_education`, `update_education`, `delete_education`,
`add_certification`, `update_certification`, `delete_certification`,
`add_language`, `update_language`, `delete_language`,
`add_project`, `update_project`, `delete_project`, `add_skill`,
`update_skill`, `mark_verified`.

Todas param no diff sem `confirm: true`. Com confirm, tiram snapshot em
`history/` antes de gravar. Patch substitui array inteiro, não mescla.
Remover algo que uma skill cita como evidência é recusado.

`update_profile` é a única que cria o `career.yml` quando ele não existe
(exige `name` e `headline`) — é o primeiro passo num data dir vazio.

**GitHub** — `sync_github`, `import_github_repo`,
`suggest_skills_from_github`, `suggest_experience_from_activity`.

`sync_github` propõe repos que ainda não são projeto; os que já existem viram
`divergences[]`, sem proposta de escrita — o texto que você escreveu vale mais
que o metadado do repo. `import_github_repo` é o caminho explícito para
sobrescrever, mostrando antes o que muda.

**Geração** — `generate_linkedin`, `generate_resume`, `generate_portfolio`,
`diff_channels`, `tailor_for_job`.

Geração não pede confirm: `output/` é descartável. `diff_channels` marca cada
canal como `missing`, `stale` ou `current` — os três saem da mesma fonte,
então o que desencontra é arquivo gerado antes de uma edição.

## Prompts

- `criar-perfil` — guia inicial: coleta o profile e cria o `career.yml`
- `atualizar-linkedin-com-github` — sync, revisão, aprovação, geração
- `tailor-resume` (arg: `vaga`) — extrai requisitos, cruza com o career.yml
- `auditoria-trimestral` — valida, cobra o que falta, confirma pendências

## Deploy no Coolify

Build pelo `Dockerfile` da raiz: multi-stage, runtime `node:25-alpine`,
usuário não-root, healthcheck em `/health`.

Storages a montar:

```
./data:/app/data
./history:/app/history
./output:/app/output
./cache:/app/cache
```

Variáveis: `MCP_AUTH_TOKEN`, `GITHUB_TOKEN` e os `CAREER_*` se quiser mudar os
paths.

TLS fica no Traefik do Coolify, com Let's Encrypt por DNS challenge no
Cloudflare. O app serve HTTP puro — não configure TLS aqui.

Acesso só pela Tailscale; o domínio aponta para o IP da tailnet.

## Estrutura

```
src/
  server.ts              bootstrap
  config.ts              env -> Config (sem efeito colateral no import)
  http/                  app express, auth, transport
  mcp/
    resources/           career, github, output
    tools/               read, write, github, generators, tailor, validate
    prompts/             os três roteiros
    server.ts            factory do McpServer (uma por requisição)
  lib/
    schema.ts            Zod + integridade referencial
    loader.ts            load/save com write atômico
    history.ts           snapshot + diff estrutural
    github.ts            wrapper Octokit
    coherence.ts         staleness dos canais
  templates/             linkedin, resume, portfolio
  test/                  harness MCP e GitHub falso
```

## Notas de implementação

**Stateless de verdade.** Cada `POST /mcp` cria um `McpServer` e um transport
novos e lê o YAML do disco. Reaproveitar instância entre transports
concorrentes causa colisão de request id.

**Diff por id, não por índice.** Remover a primeira de duas experiências por
índice reportaria "a primeira virou a segunda" e "a segunda sumiu" — descrição
falsa do que aconteceu. Entidades casam por `id` (ou `name`, em skills e
languages); reordenar vira `moved`. Arrays de string seguem por índice, que é
o certo para bullet.

**Write atômico.** `writeFile` em temp no mesmo diretório, `fsync`, `rename`.
Nunca existe um `career.yml` parcial em disco.

**Validação acontece no preview.** Se ela só rodasse no save, o preview diria
"ok" e o `confirm` estouraria depois.

**Testes batem em HTTP real.** O harness sobe o servidor numa porta efêmera e
conecta o client oficial do SDK; as tools de GitHub rodam contra um servidor
local que imita a API, com paginação por header `Link`. Sem mock de Octokit.
