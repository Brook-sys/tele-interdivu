# Dúvidas e observações pendentes (revisar com o usuário)

Decisões técnicas tomadas autonomamente durante a implementação, que merecem
confirmação ou atenção do usuário. Cada item explica o que foi feito e o impacto.

## Bloqueios do ambiente desta máquina

1. ~~**Docker não está instalado nesta máquina.**~~ O deploy é via **GitHub Actions**
   (workflow `.github/workflows/ghcr.yml`): CI roda typecheck+vitest e publica a
   imagem no GHCR a cada push em `main`. A imagem final é validada no homelab
   (o pull + `docker compose up` é o único passo que precisa de atenção lá).
2. **RAM disponível: 7.8G** — o build de produção levou ~19s (rolldown-vite, bem
   mais leve que o webpack antigo). No CI (GitHub-hosted runner) não há problema.
3. **`TELEGRAM_API_ID`/`TELEGRAM_API_HASH` não são mais necessários no build**: as
   credenciais são injetadas em runtime pelo container (ver `docs/SETUP.md`).
   O CI constrói com dummies — a imagem publicada é genérica e sem segredos.

## Escopo e comportamento

4. **Canais de broadcast ficam fora do painel.** Painel inclui apenas
   `chatTypeBasicGroup` e `chatTypeSuperGroup` (grupos onde membros enviam
   mensagens). Canais broadcast só permitem envio por admins e não têm slowmode
   por membro — se quiser incluí-los, é mudança de 1 linha no classificador.
5. **Strings novas em português (fallback.strings com valores PT-BR).** O mecanismo
   de lang packs do telegram-tt busca traduções oficiais na plataforma de traduções;
   chaves novas não existem lá, então o fallback é o que aparece. Optei por escrever
   os fallbacks direto em PT-BR para uso pessoal. Se preferir inglês, é só traduzir
   os valores em `fallback.strings`.
6. **Linhas do painel não mostram badge de não-lidas** (v1 mostra apenas título,
   avatar e badges de status). A lista principal nativa continua disponível para
   uso geral do dia a dia. Adicionar depois se fizer falta.
7. **A pasta "de divulgação" também aparece como aba de pasta comum** na sidebar
   nativa (efeito colateral aceito da decisão "pasta nativa"). Ela também fica
   sincronizada no Telegram do celular — dá para curar a visibilidade pelo celular.
8. **`slowmodeNextSendDate` do servidor costuma vir 0/ausente.** O countdown usa
   `max(nextSendDate, lastOwnMessageAt + seconds)` — depois da primeira mensagem
   enviada pelo painel, o dado local é suficiente e confiável.

## Técnico

9. **Detecção de FLOOD_WAIT:** o `invokeRequest` upstream engole o erro (retorna
   `undefined`) sem expor os segundos — a fila aplica backoff conservador fixo
   (60s) e retoma no próximo ciclo de refresh do painel (60s). Confirmar
   comportamento em uso real.
10. **AGENTS.md do upstream manda "não escrever testes"** — instrução do usuário
    (testar o máximo possível) prevaleceu: testes unitários apenas para módulos
    puros novos (`classifyChat`, `buildSections`, `countdownFormat`,
    `settingsSerialization`), sem tocar em código upstream de teste. 115 testes
    passando (40 novos + 75 do upstream). O `tests/init.ts` exigido pelo vitest é
    gitignored — recreado localmente (conteúdo mínimo documentado no arquivo).
11. **ToS:** cliente unofficial com api_id próprio para uso pessoal é o padrão dos
    forks de telegram-tt; evitar distribuir a imagem publicamente com credenciais.
    A F4 futura (envio automatizado) carrega risco real de restrição da conta —
    mitigação já prevista no desenho (respeitar slowmode, esperar mensagens de
    terceiros), mas o risco não é zero.
12. **HTTPS não é opcional — é requisito funcional.** Acessar via `http://IP-DA-REDE:8090`
    desliga `crypto.subtle` e `navigator.locks` (contexto não-seguro, política do
    navegador): o `compatTest` falha com a tela "Your browser is not supported"
    (mesmo em navegador moderno) e, após o "I'm Feeling Lucky", o login fica em
    loop infinito porque o GramJS não consegue fazer o handshake MTProto
    (`TypeError: Cannot read properties of undefined (reading 'digest')` no
    worker — `crypto.subtle` ausente). Reproduzido e confirmado. Servir atrás de
    HTTPS válido (ou acessar via `localhost`/SSH tunnel) resolve os dois
    sintomas. **Correção de uma análise anterior desta doc** que dizia que o app
    "funcionaria sem HTTPS, perdendo só o PWA" — falso: sem contexto seguro o
    app não funciona de forma alguma.

## Descobertas da implementação (validadas em código)

13. **npm 11.x quebra o install deste repo** (bug com a dependência git
    `emoji-data-ios`: conflito `--before` x `min-release-age`). Solução aplicada e
    documentada no SETUP: instalar com `npx -y npm@10.9.0 install` (o Dockerfile
    já faz isso internamente). Não altera o npm global do host.
14. **Build de produção: 19s** (rolldown-vite) com 7.8G de RAM — tranquilo. O
    `dist/` é versionado pelo upstream: builds locais sujam o repo; restaurar com
    `git checkout -- dist && git clean -fqd dist` (o build real vive no Docker).
15. **Smoke test executado:** bundle de dev boots sem nenhum erro JS; tela de login
    renderiza; MTProto alcança os servidores do Telegram (resposta real
    `API_ID_INVALID` com as credenciais placeholder usadas no teste). Com
    credenciais reais o login flui normalmente — mas o fluxo completo do painel
    (login → pasta → badges) precisa ser validado com a conta real no homelab.
16. **`send_paid_messages_stars` confirmado no objeto base `channel`** da layer
    embutida (flags2.14) — o badge de estrelas funciona com zero chamadas de API,
    direto do cache (construído em `ApiChat.paidMessagesStars`).

## Limitações conhecidas (v1) — decisões conscientes de escopo

17. **A pasta de visibilidade deve ser "manual"** (sem regras automáticas como
    "todos os grupos"). Se a pasta tiver regras, chats casados por regra continuam
    entrando nela mesmo após "Ocultar" no Gerenciar Grupos (comportamento do
    Telegram: ocultar = remover de `includedChatIds`; regras re-incluem). Criar a
    pasta vazia e curar 100% pelo Gerenciar Grupos.
18. **Pasta apagada em outro dispositivo:** o painel/saldo referenciam o
    `folderId` salvo; se a pasta for deleta, telas mostram listas vazias de forma
    graciosa e o Gerenciar Grupos avisa que não há pasta — escolher outra nas
    configurações.
19. **Ações em lote são fire-and-forget** (espelha o comportamento upstream de
    `editChatFolders`): se o servidor rejeitar silenciosamente, o estado visual
    só corrige no refresh. Sem spinner de conclusão.
20. **Badge de não-lidas nas linhas do painel:** fora do v1 (linhas mostram
    avatar/título/badges de status). A lista nativa segue disponível.
21. **Gerenciar Grupos lista basic+supergroups** (não canais broadcast, não
    conversas 1:1) — alinhado ao escopo do painel.
22. **Preenchimento progressivo:** ao abrir o painel com muitos grupos, os
    primeiros full info chegam em ~1.5s cada (fila serial) — badges de slowmode
    podem aparecer ao longo de ~1min na primeira visita; depois ficam cacheados
    (TTL 10 min).
23. **Virtualização:** o Gerenciar Grupos renderiza a lista completa (centenas de
    grupos renderizam bem; busca estreita). Se precisar, virtualizar depois com
    o `InfiniteScroll` existente.

## Descobertas da fase de deploy

24. **Bug que só o smoke test pegou (corrigido):** `config.ts` é importado também
    pelos Web Workers (gramjs roda em worker, sem `window`) — a primeira versão do
    override crashava todos os workers (`ReferenceError: window is not defined`).
    Correção: guard `typeof window !== 'undefined'` + credenciais entregues ao
    worker via `ApiInitialArgs` (`initApi`), verificadas interceptando o
    `postMessage` do Worker (`apiId: 6` do override no payload) e pela ausência
    de erros de boot.
25. **A imagem do GHCR é genérica** (build com dummies + credenciais em runtime):
    torná-la pública é seguro; o pull no homelab também funciona sem login se o
    pacote for público. O compose passa as credenciais via `environment`.
26. **Arquitetura da autenticação do upstream (mapeada):** main thread →
    `initApi(initialArgs)` → postMessage → worker `TelegramClient(apiId, apiHash)`.
    O override não poderia viver só no `window`; precisava atravessar essa fronteira.
27. **`npm ci` não funciona neste repo** (lock do upstream dessincronizado do
    `package.json` — o próprio upstream instala com `npm i`; descoberto no CI).
    CI e Dockerfile usam `npm install`. Se quiser `npm ci`, regenere o lock e
    aceite o churn no rebase.
28. **`BASE_URL` de build quebra o build se não for URL completa** (`EISDIR` no
    `vite:build-html` com `/`; reproduzido localmente). Removido de
    Dockerfile/compose — o build usa o default do upstream (metadados canonical/
    og apontando para web.telegram.org, cosmético para uso pessoal). Se quiser
    metadados corretos, passar `BASE_URL=https://seu-dominio/` como build-arg —
    nunca um path relativo.
29. **Pipeline verde e imagem publicada** (acompanhado até o fim): job de testes
    (tsc + 118 vitest) + job docker passam a cada push em `main`; imagem em
    `ghcr.io/brook-sys/tele-interdivu` (tags `latest` e `sha-<commit>`), build
    ~5min com cache GHA. Histórico de debugging do pipeline: `npm ci` → lock
    dessincronizado (item 27); alpine/musl → `node:24-slim` (glibc);
    `BASE_URL=/` → removido (item 28).
30. **O pacote GHCR nasce privado** (comportamento padrão do GitHub para
    packages de Actions). Como a imagem é credential-free, torná-la pública na
    UI do pacote é seguro e dispensa `docker login` no homelab. Alternativa:
    manter privada e logar com um PAT que tenha `read:packages`
    (`docker login ghcr.io -u Brook-sys`). O token `gh` local NÃO tem
    `read:packages` (por isso a API de pacotes não lista via CLI).

## Cadeia de falhas do primeiro takeover (toda ela resolvida)

31. **`self is not defined` no takeover** — GramJS chama `self.crypto.subtle` e
    `self.addEventListener('offline')` (globais de browser/worker). O backend
    Node.js (não browser) não possui `self`. Fix: `server/polyfills.ts`
    importado como primeiro módulo de `server/index.ts` — `globalThis.self =
    globalThis` + `addEventListener` no-op. Validação: session handshake
    acontece agora (completou `Connection to zws4... TCPObfuscated complete`).

32. **Interop CJS/ESM do `@cryptography/aes`** — esbuild com `--platform=node`
    priorizava `main` (CJS) → `import_aes.default is not a constructor` ao
    criar a conexão TCPObfuscated. Fix: `--main-fields=module,main` no
    `build:server` (o pacote exporta ES real em `dist/es`).

33. **Ordem do handoff estava errada** — o frontend chamava `callApi('disconnect')`
    ANTES do takeover, deixando a interface desconectada se o takeover falhasse
    (o refresh da página era o "retorno"). Fix: sequência inversa — o backend
    confirma o takeover PRIMEIRO e o navegador só então desconecta. Em caso de
    erro o navegador jamais perde conexão, e o erro aparece na tela ao invés de
    derrubar o chat.

34. **Mensagem de erro 500 sem contexto** — a rota de takeover retornava apenas
    `Internal server error: ${message}`. Fix: a API agora registra o stack
    completo no log do daemon (`[Automation API] METHOD path failed: stack`) e
    a mensagem passa a conter a rota (`Internal server error (takeover): ...`).

35. **nginx ignorava script do entrypoint** — esqueci o bit de execução;
    `docker-entrypoint.sh` "Ignoring 99-runtime-config.sh, not executable".
    Fix confirmado no boot: `COPY --chmod=755` no Dockerfile + `entrypoint.sh`
    definitivo (nginx oficial agora executa o script).

## Postmortem de UI da automação (corrigido junto com esse ciclo)

36. **Campos de formulários resetando sozinhos a cada 3s** — o loop de telemetria
    (`loadStatusAndData` com `setInterval` 3000ms) hidratava TODOS os inputs a
    cada re-fetch, sobrescrevendo edições do usuário. Fix: `isFormInitializedRef`
    (hidrata os formulários apenas na primeira carga); os re-fetches subsequentes
    só atualizam telemetria (status/grupos/logs).

37. **Inputs numéricos travando ao digitar** — campos minDelay etc. usavam
    `value={Number(...)}` + `Number(e.target.value) || fallback`, o que quebrava
    na tecla Backspace (valor vazio → fallback instantâneo). Fix: estado como
    string, conversão numérica apenas no salvar.

38. **`input type="checkbox"/radio` nativos não estilizavam** — migrados para os
    componentes oficiais `ui/Checkbox` e `ui/Radio` do Telegram Web A (fasterDOM
    / Teact não renderiza visual de checkbox nativo corretamente).

39. **`linkPreview` não persistia ao salvar Ritmo** — a flag estava separada
    entre campaign e config; fix: ambos os botões de salvar agora persistem
    `linkPreviewEnabled` juntos (nunca divergem).
