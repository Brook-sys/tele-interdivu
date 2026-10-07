# Setup — build, run e deploy

## ⚠️ Requisito absoluto: contexto seguro (HTTPS ou localhost)

O Telegram Web A **não funciona via `http://IP-DA-REDE:8090`** — não é bug, é
política dos navegadores: fora de um *secure context* (HTTPS, `localhost` ou
`127.0.0.1`), o browser desliga `crypto.subtle` e `navigator.locks`. Sintomas
exatos (reproduzidos): tela "Your browser is not supported" (o `compatTest`
reporta `WebCrypto false` e `WebLocks false`, todo o resto `true`) e, se
bypassar com "I'm Feeling Lucky", o QR de login fica em loading infinito
(worker em loop: `Cannot read properties of undefined (reading 'digest')`).

Como acessar corretamente:

- **Tailscale (mais rápido se você já usa)**: no host com Tailscale,
  `tailscale serve --bg --https=443 http://localhost:8090` → acesse
  `https://<host>.<tailnet>.ts.net` (cert Let's Encrypt automático; habilite
  HTTPS/certs no admin do tailnet; o celular precisa do app Tailscale ativo).
- **Reverse proxy com domínio próprio** (Caddy/NPM/Traefik + Let's Encrypt)
  apontando para a porta 8090 — o caminho clássico do homelab.
- **Teste rápido sem nada disso** (do PC): `ssh -L 8090:localhost:8090 homelab`
  e acesse `http://localhost:8090` — localhost É contexto seguro.

Confirmação rápida no seu ambiente: DevTools → Console → `window.isSecureContext`.
`false` = é isso que está quebrando o acesso.

## Requisitos

- Node `^24.11` e npm `^11` (conforme `package.json` engines)
- Credenciais próprias: `TELEGRAM_API_ID` e `TELEGRAM_API_HASH` (https://my.telegram.org)
- Para PWA no celular: HTTPS com certificado válido no reverse proxy do homelab

## Desenvolvimento local

```bash
# 1. Arquivo .env na raiz (NÃO commitar):
#    TELEGRAM_API_ID=123456
#    TELEGRAM_API_HASH=abcdef...

# 2. Instalar dependências — IMPORTANTE: o npm 11 (que acompanha o Node 24)
#    quebra neste repo (bug com dependência git `emoji-data-ios`: conflito
#    `--before` x `min-release-age`). Usar npm 10 via npx (não toca no npm global):
npx -y npm@10.9.0 install

npx tsc                 # typecheck
npx eslint <arquivos>    # lint
npm run check:css        # stylelint
npm run test             # vitest (inclui testes do painel custom)
npm run dev              # servidor de desenvolvimento (localhost:1234)
```

Observação: o `npm install` com npm@10 pode sujar o `package-lock.json`
(campos `libc` que o npm 11 escreve). Restaurar com `git checkout package-lock.json`.

## Build de produção

```bash
npm run build:production   # gera dist/
```

Se falhar por memória (build do vite é pesado):

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm run build:production
```

## Credenciais (API ID/HASH) — injetadas em runtime

O app lê `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` de duas formas, em ordem de precedência:

1. **Runtime**: `window.__TELEGRAM_CREDS__` definido em `/config.js` — no Docker,
   o entrypoint gera esse arquivo a partir das variáveis de ambiente do container
2. **Build-time**: valores embutidos no bundle (dummy na imagem publicada)

A imagem do GHCR **não contém credenciais** — você as fornece ao rodar o container.
O fluxo verificado: `config.js` → main thread → `initialArgs` do `initApi` →
worker (GramJS/MTProto).

## Deploy via imagem GHCR (homelab)

```bash
# 1. Login no GHCR (uma vez por host) — PAT com escopo read:packages
docker login ghcr.io -u Brook-sys

# 2. Configurações no .env ao lado do docker-compose.yml:
#    TELEGRAM_API_ID=123456
#    TELEGRAM_API_HASH=abcdef...
#    PROXY_URL=socks5://usuario:senha@ip:porta   # Opcional (SOCKS5 ou HTTP CONNECT)

docker compose pull && docker compose up -d
```

A imagem é publicada por CI em todo push para `main`:
`ghcr.io/brook-sys/tele-interdivu` (tags `latest` e `sha`).

- **Volume persistente `/data`**: armazena o banco SQLite nativo da automação (`automation.db`), campanhas, logs e a sessão do robô para sobreviver a reboots e upgrades.
- **Suporte a Proxy (SOCKS5 / HTTP CONNECT)**: quando `PROXY_URL` está definido, **100% do tráfego MTProto** (tanto do navegador quanto da automação 24/7) é roteado pelo proxy com política **Fail-Closed** (se o proxy falhar, a conexão é recusada para evitar vazamento do seu IP residencial). As credenciais vêm **antes** do host (`http://usuario:senha@ip:porta`); um valor invertido (`http://ip:porta@usuario:senha`) é rejeitado já no boot com erro explícito no log do container.
- **Handoff exclusivo**: quando a automação inicia, o navegador cede a conexão e exibe o dashboard de telemetria; quando você pausa, o navegador retoma o chat normal sem precisar de login duplo nem novo QR code.

## Deploy via build local (alternativa)

```bash
export TELEGRAM_API_ID=123456
export TELEGRAM_API_HASH=abcdef...
docker compose up -d --build
```

Ambos os modos usam as mesmas env vars — no modo local elas também são passadas
como build-args (fallback de build-time) e como environment (override runtime).

- Imagem multi-stage: `node:24-alpine` (build) → `nginx:alpine` (serve estático + SPA fallback + healthcheck)
- Publica na porta **8090** — aponte o reverse proxy (Caddy/Traefik/NPM) com HTTPS válido

## Atualização do fork (rebase mensal)

Ver `docs/CUSTOMIZATIONS.md` — lista exata dos arquivos upstream tocados.

## Login

Primeiro acesso: login normal do Telegram com a conta pessoal (MTProto), igual ao
web.telegram.org. A sessão fica em IndexedDB do navegador.
