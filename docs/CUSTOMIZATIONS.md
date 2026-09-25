# Manifest de customizações (arquivos upstream tocados)

Disciplina de fork: toda mudança em arquivo upstream é listada aqui, para facilitar
rebase mensal sobre `upstream/master` (fork pinado na tag `air_v2.11.5`).

## Arquivos upstream modificados (18 — diff verificado via `git diff --name-only`)

| # | Arquivo | Tipo de mudança | Motivo |
|---|---|---|---|
| 1 | `src/types/index.ts` | Enum `LeftColumnContent` += `PromoPanel`, `PromoManage` | Novos conteúdos da sidebar |
| 2 | `src/components/left/LeftColumn.tsx` | Enum `ContentType` += `PromoPanel`/`PromoManage`; 2 cases no `switch (contentKey)`; 2 cases em `renderContent`; 2 imports | Renderizar os novos conteúdos |
| 3 | `src/components/common/MainMenuDropdown.tsx` | 2 handlers + 2 props | Entrada pelo menu hamburger |
| 4 | `src/components/left/main/LeftSideMenuItems.tsx` | 2 OwnProps + destructure + separadores + 2 `MenuItem` | Itens permanentes "Divulgação" e "Gerenciar Grupos" |
| 5 | `src/global/types/globalState.ts` | + import + slice `promo: PromoState` | Estado global custom |
| 6 | `src/global/initialState.ts` | + `promo: { byUserId: {} }`; `cacheVersion` 5 → 6 | Boot do slice + bump de cache |
| 7 | `src/global/cache.ts` | `'promo'` no `pick` do `reduceGlobal`; prefill + bloco de migração `cacheVersion < 6` | Persistência IndexedDB |
| 8 | `src/global/types/actions.ts` | + import `PromoSettings` + 3 assinaturas | Tipagem das ações |
| 9 | `src/global/actions/all.ts` | + `import './api/promo'` + `import './ui/promo'` | Registro das ações |
| 10 | `src/global/actions/apiUpdaters/messages.ts` | 1 import + 1 linha no `case 'newMessage'` | Capturar `lastOwnMessageAt` |
| 11 | `src/assets/localization/fallback.strings` | + 29 chaves `Promo*` (PT-BR) | Strings da UI |
| 12 | `src/types/language.d.ts` | Regenerado por `npm run lang:ts` | Tipagem das chaves |
| 13 | `index.html` | + `<script vite-ignore src="./config.js">` antes do bundle | Override de credenciais em runtime |
| 14 | `src/config.ts` | + `declare global` + leitura de `window.__TELEGRAM_CREDS__` (com guard p/ workers) | Credenciais sobrescrevíveis em runtime |
| 15 | `src/api/types/misc.ts` | `ApiInitialArgs` += `apiId?`/`apiHash?` | Passar credenciais ao worker |
| 16 | `src/api/gramjs/methods/client.ts` | Destructure com default `apiId = TELEGRAM_API_ID` + uso no `TelegramClient` | Worker usa credenciais recebidas |
| 17 | `src/global/actions/api/initial.ts` | + 2 imports + `apiId`/`apiHash` no payload do `initApi` | Main thread entrega o override ao worker |
| 18 | `.gitignore` | + `!.github/workflows/ghcr.yml` (exceção ao ignore de workflows) | Versionar o workflow de CI/GHCR |

Observações de rebase: o `package-lock.json` NÃO deve ser alterado (instalação com
`npm@10` pode sujá-lo — restaurar com `git checkout package-lock.json`). O `dist/`
é versionado pelo upstream; builds locais o sujam — restaurar com
`git checkout -- dist && git clean -fqd dist` (o build real acontece dentro do Docker).

## Arquivos novos (sem conflito com upstream)

```
src/global/types/promo.ts                       tipos + DEFAULT_PROMO_SETTINGS
src/global/reducers/promo.ts                   recordPromoOutgoing / recordPromoFullInfoFetch / updatePromoSettings
src/global/selectors/promo.ts                  seletores (sem alocação)
src/global/actions/api/promo.ts                 requestPromoStatuses (fila serial c/ backoff) + setPromoChatsVisibility
src/global/actions/ui/promo.ts                  setPromoSettings
src/hooks/usePromoServerNow.ts                  ticker compartilhado de 1s
src/util/promo/classifyChat.ts [+test]          classificador puro (árvore de decisão)
src/util/promo/buildSections.ts [+test]        agrupamento/sort das 3 seções fixas
src/util/promo/countdownFormat.ts [+test]       formatador compacto de countdown
src/util/promo/settingsSerialization.ts [+test] export/import JSON validado
src/components/left/promo/*.tsx + *.module.scss painel, settings, linha, gerenciar (8 arquivos)
src/config.test.ts                              testes do override de credenciais
public/config.js                                ponto de override runtime (vazio por padrão)
.github/workflows/ghcr.yml                      CI (tsc+vitest) + build/push da imagem no GHCR
deploy/nginx.conf                               servidor estático (SPA fallback, cache, SW no-cache)
deploy/docker-entrypoint.d/99-runtime-config.sh gera config.js a partir das env vars no boot
docs/                                           ARCHITECTURE / CUSTOMIZATIONS / QUESTIONS / SETUP
Dockerfile / docker-compose.yml / .dockerignore infra
tests/init.ts                                   setup do vitest (gitignored, local)
```

## Estratégia de rebase

```bash
git fetch upstream
git rebase upstream/master custom   # resolver apenas nos 12 arquivos da tabela acima
npx tsc && APP_ENV=test npx vitest run && npm run build:production
git checkout -- dist && git clean -fqd dist
```

Recomendação: rebasar mensalmente; o upstream refatora `folderManager`/cache com frequência.
