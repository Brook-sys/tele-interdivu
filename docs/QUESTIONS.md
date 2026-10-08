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

40. **Tentativa de disparo em grupos que cobram estrelas (`ALLOW_PAYMENT_REQUIRED_20`)**
    — O frontend enviava a lista bruta da pasta para o backend sem filtrar
    pelo classificador `classifyPromoChat`. Grupos cobrando estrelas entravam
    como `READY` e falhavam com RPCError 403 `ALLOW_PAYMENT_REQUIRED`. Fix:
    (1) `PromoAutomation.tsx` agora filtra estritamente grupos `stars` e
    `blocked` antes do takeover; (2) `telegramRunner.ts` captura erros
    `ALLOW_PAYMENT_REQUIRED`, marca o grupo no SQLite como `STARS` e o
    scheduler nunca mais tenta enviar para ele; (3) migration automática no boot
    para colocar em quarentena grupos que falharam com esse erro no passado.

41. **Tentativa de disparo em grupos em slowmode cooldown / travamento de fila**
    — Erros `SLOWMODE_WAIT_X` eram tratados como `floodWaitSeconds`, o que
    colocava a automação inteira em pausa longa (ou acionava o Circuit Breaker)
    por causa do cooldown de um único grupo. Fix: `telegramRunner.ts` agora
    diferencia `slowmodeSeconds` de `floodWaitSeconds`; o grupo é atualizado no
    SQLite com seu `slowmode_next_send_date` futuro, e a fila pula
    imediatamente para o próximo grupo elegível sem pausar o motor.

42. **Fila da automação mirava grupos não-livres** — Na inicialização da
    automação, o backend agora sincroniza a lista de grupos ativos (`syncTargetGroups`),
    removendo grupos que não estão mais na pasta ou que foram desqualificados.
    Grupos em cooldown ativo entram como `WAITING_SLOWMODE` e só são
    acionados quando o tempo expira e chegam as mensagens de terceiros.

43. **Deadlock da rodada (Starvation de grupos rápidos por causa de grupos lentos)**
    — Se a rodada tinha 23 grupos e 13 foram enviados, os 10 restantes não podiam
    enviar (cooldown longo ou esperando mensagens). O scheduler caía em
    `await this.sleep(15_000)` eterno, dormindo 15s e acordando, sem que os 13
    grupos que já estavam prontos pudessem receber novas mensagens.
    Fix: (1) Se há grupos com slowmode prestes a liberar (< 5 min), entra em
    `WAITING_COOLDOWN` com contagem regressiva real e botão "Pular Espera";
    (2) Se todos os restantes estão bloqueados por mensagens ou slowmode longo,
    conclui a rodada atual e agenda a próxima rodada normalmente (`WAITING_NEXT_ROUND`);
    (3) Adicionado `minOtherMessagesTimeoutHours` (padrão 4h) para evitar que grupos
    parados fiquem presos para sempre; (4) Botão "Forçar Nova Rodada" no painel.

44. **Rate-limit no GetHistory do TelegramRunner** — A cada 15 segundos o scheduler
    fazia GetHistory para todos os grupos em `WAITING_MESSAGES`. Fix: cache TTL de
    5 minutos por chat (`historyCheckCache`); updates do WebSocket já alimentam
    o contador em tempo real sem chamadas de rede. Ping periódico via `help.GetConfig`
    a cada 30 minutos previne desconexões silenciosas de MTProto no Node.js.

45. **Contador de rodada travado em ~20 / rodada nunca concluía** — O progresso
    da rodada era `sentInRound.size` (Set de chatIds únicos enviados). Como
    grupos elegíveis podem ser reenviados livremente, o Set saturava no número
    de grupos válidos únicos e o contador visualmente "travava" (ex.: 20/23);
    adicionalmente, em modo `continuous` a rodada nunca era concluída porque
    não existia meta de envios. Fix: (1) `sentInRoundCount` passou a ser um
    contador inteiro incrementado a cada envio bem-sucedido, independente de
    reenvio; (2) nova config `roundTargetSends` (padrão 23, migration
    `ALTER TABLE config ADD COLUMN round_target_sends`) define a meta de
    envios por rodada — ao atingi-la, o scheduler conclui a rodada (manual:
    para; continuous: `WAITING_NEXT_ROUND` + espera `roundIntervalMinutes`
    e reseta o contador); (3) painel mostra "Enviados na Rodada X / meta" e
    o campo "Envios por rodada" ficou editável na aba de configurações.

46. **Envios durante a janela de sono e reenvios rápidos no mesmo grupo** —
    As esperas longas (intervalo de rodada, circuit breaker de 1h, recheck de
    daily limit, micro-pausa) eram blocos únicos; a janela de sono só era
    reavaliada no topo do loop, permitindo envios dentro da janela por até
    30+ min. Adicionalmente, grupos hiperativos recebiam reenvios a cada
    ~1-2 min porque bastavam N mensagens de terceiros chegarem rápido.
    Fix: (1) `sleepWithWindowCheck` fatia esperas longas em blocos de 60s que
    reavaliam a janela — tempo dentro da janela não conta para a espera e a
    transição é registrada no histórico ("Janela de sono ativada/encerrada");
    (2) nova config `minResendIntervalMinutes` (padrão 10 min, 0 desliga)
    impõe piso mínimo entre reenvios ao mesmo grupo (razão `WAITING_RESEND`,
    contabilizada como cooldown no painel); (3) `consecutiveSendsInRun` é
    zerado ao concluir a rodada; (4) card do painel "Total Hoje" renomeado
    para "Últimas 24h" para refletir a janela deslizante do contador.

47. **Grupos em quarentena nunca eram reavaliados; reenvios rápidos no mesmo grupo**
    — Grupos marcados `STARS`/`BLOCKED` eram excluídos pela UI no takeover e
    sumiam do `group_state` no próximo `syncTargetGroups`, então um grupo que
    parasse de cobrar estrelas só voltava após restart manual. Logs mostraram
    o mesmo grupo recebendo 4 envios em 2 min (grupos hiperativos satisfazem
    o mínimo de mensagens de terceiros quase instantaneamente). Fix: (1) a UI
    não exclui mais grupos estrelas/bloqueados do takeover — eles entram no
    `group_state` quarentenados; (2) o runner expõe `probeChat` (read-only via
    `channels.GetFullChannel`/`messages.GetFullChat`) e o scheduler revalida
    um lote de até 3 quarentenados a cada 30 min (`revalidateQuarantinedGroups`),
    reintegrando como `READY` quem ficou livre e atualizando preço/status dos
    demais, com log da transição; (3) a priorização por `lastSentAt` mais
    antigo já existia no sort de `readyGroups` — combinada com o piso de
    `minResendIntervalMinutes`, o mesmo grupo não é reenviado antes do
    intervalo mesmo tendo mensagens suficientes.

48. **Controle remoto completo da automação via API** — O daemon já expunha
    status/config/campaign/logs, mas só o browser conseguia iniciar a
    automação (o takeover exigia `sessionData` e `targetChats` vivos da UI,
    e o `group_state` não guardava `accessHash`). Fix: (1) `group_state`
    passou a persistir `access_hash` (migration), nunca exposto nos GETs;
    (2) o takeover aceita corpo vazio `{}` e reusa sessão + grupos salvos
    (`usedSavedSession` na resposta), permitindo start 100% remoto;
    (3) novos endpoints `POST/DELETE /groups/{chatId}` para adicionar,
    quarentenar, reintegrar ou remover grupos sem abrir o painel;
    (4) auth opcional por `AUTOMATION_API_TOKEN` (Bearer) — o painel lê o
    token uma vez de `?automationToken=` na URL e persiste em localStorage.
    Referência completa em `docs/AUTOMATION_API.md`.

49. **Períodos ociosos invisíveis e ciclo de revalidação lento** — Quando todos
    os grupos estavam em cooldown/aguardando mensagens, o scheduler ficava
    minutos sem registrar nada no histórico (parecia travado). E com 41+
    grupos quarentenados, o lote de 3 sondagens a cada 30 min levava ~7h para
    cobrir todos. Fix: (1) `logWaitTransitionOnce` registra uma entrada no
    histórico a cada mudança de tipo de espera (cooldown/mensagens/ocioso);
    (2) lote de revalidação subiu para 10 por ciclo (~2h para cobrir 40+
    quarentenados). Nota: `nextRunAt` igual a `sleepUntil` na API de status
    é intencional durante o delay pré-envio (a próxima ação é o fim do sono).

50. **Módulo de extração passiva de links** — Nova funcionalidade (sem relação
    com o envio): o daemon agora extrai links de cada mensagem nova que chega
    nos grupos-alvo, 100% passivo (zero chamadas extras de API — reusa o
    `handleUpdate` que já recebe os updates do MTProto). Extrator de links
    classifica em `invite_link` (t.me/+…, joinchat), `tg_link` (demais t.me,
    username em lowercase) e `external_link`, cobrindo tanto URLs visíveis
    quanto escondidas atrás de entidades `MessageEntityTextUrl`. Dedup global
    por (kind, valor normalizado) com `times_seen`/`first_seen_at`/
    `last_seen_at`. Ligável/desligável (`extractorEnabled` no config, lido no
    start do runner e atualizado ao vivo pelo POST /config). APIs novas:
    `extract/links|stats|export|clear`. UI nova "Extração de Links" no menu
    lateral com stats, abas por tipo, busca, exportação .txt e limpeza.
    Arquitetura preparada para novos extratores (telefone, @username,
    palavras-chave) — basta adicionar um extrator ao pipeline.

51. **Orquestração multi-conta (fase 1)** — Mesma imagem, papel definido por
    `NODE_ROLE` (padrão `worker`). Master expõe `/api/v1/orchestrator/*`
    (404 em workers): `info`, `workers`, `register`, `heartbeat` (push de
    `desiredConfig` + `desiredCampaign` centralizados), `claim`, `report`,
    `grants`. Coordenador decide o slot por timeline global por grupo
    (cooldown compartilhado entre contas), lease com TTL de 90s, round-robin
    por último grant (intercalação natural de contas), cooldown global de
    grupo após flood reportado e quarentena global para stars/blocked.
    Workers chamam `OrchestratorWorkerClient` (register + heartbeat a cada
    15s + claim antes de cada envio + report depois); falha de rede cai em
    modo degradado = sistema standalone atual (o escalonamento prévio dos
    `lastSentAt` por conta mantém a intercalação residual). Metas de rodada
    são rebalanceadas por worker vivo. Painel "Orquestração" visível em
    qualquer container: no master mostra contas (status, metas, hb) e feed
    de grants; em workers exibe aviso. Env novos: NODE_ROLE, MASTER_URL,
    WORKER_ID, WORKER_API_URL, ORCHESTRATOR_TOKEN.

52. **Countdown de pausas longas mostrava fatias de 1 minuto** — O fatiamento
    interno (sleepWithWindowCheck, blocos de 60s) vazava para a UI porque
    `sleepUntil` apontava para o fim da fatia. Fix: novo campo
    `waitTotalUntil` no estado do scheduler (e na API `status`) com o fim
    real da espera; na janela de sono aponta para o fim da janela
    (`getSleepWindowEndMs`). O banner agora exibe o tempo total; "Pular
    pausa" de fato pula a pausa inteira (flag `skipRequested` consumida por
    fatia, nunca atravessa a janela de sono — que continua impulável);
    botão "Pular pausa" sumiu de WAITING_COOLDOWN/WAITING_MESSAGES (nada a
    acelerar) e passou a existir em CIRCUIT_BREAKER.

53. **Cooldown girando em loop sem nunca enviar** — Grupos em slowmode que
    também não tinham o mínimo de mensagens de terceiros entravam no balde de
    WAITING_COOLDOWN: a UI mostrava o cooldown zerar, trocar de grupo e zerar
    de novo, sem nenhum envio (o grupo continuava sem mensagens). Fix:
    cooldown só conta para grupos que já cumprem a regra de mensagens
    (verificada via contador local/GetHistory cacheado); quem falta mensagem
    cai em WAITING_MESSAGES, então o status exibido reflete o que realmente
    impede o próximo envio.

54. **Grupos quarentenados nunca reavaliados (starvation da sondagem)** — Três
    bugs combinados esvaziavam a fila: (1) a revalidação ordenava por
    `updatedAt`, mas sondagens sem mudança não atualizavam nada — os mesmos
    10 quarentenados monopolizavam todo ciclo e o resto nunca era checado;
    (2) se todos os grupos virassem quarentena o scheduler parava, matando a
    própria revalidação; (3) classificação de estrelas vinda do takeover
    (potencialmente cache velho do frontend) virava quarentena sem prova.
    Fix: ordem de sondagem justa via `lastProbeAtByChat` em memória; ciclo de
    catch-up de 60s enquanto houver grupo nunca sondado no processo; com
    tudo em quarentena o loop fica vivo sondando; ciclo registra resumo no
    histórico ("X sondados, Y reintegrados"). Classificação do takeover agora
    é tratada como provisória — a sondagem do backend é a fonte da verdade.

55. **Sessão perdida virava sequência infinita de ERRORs iguais** — Quando o
    webapp abria no navegador, o Telegram desconectava o daemon com
    AUTH_KEY_DUPLICATED e o scheduler continuava tentando enviar, gerando o
    mesmo erro em loop até parar por outros motivos. Fix: erros de sessão
    (AUTH_KEY_DUPLICATED / AUTH_KEY_UNREGISTERED / SESSION_REVOKED /
    USER_DEACTIVATED) retornam `isSessionLost`, o scheduler registra um log
    explicativo e para limpo — retomada via painel ou `POST takeover {}`.

56. **CHAT_WRITE_FORBIDDEN detectável sem tentar enviar** — A resposta do
    `GetFullChannel` traz o objeto do canal com flags `left` (não sou membro),
    `bannedRights.sendMessages` (banimento individual) e
    `defaultBannedRights.sendMessages` (grupo trancado p/ membros). A sonda
    (`probeChat`) agora lê esses flags e marca BLOCKED sem nenhum envio
    tentado. A varredura de sondagem também deixou de cobrir só quarentenados:
    todo grupo é verificado uma vez por processo (varredura inicial em ciclo
    rápido), então um grupo que piorou é pego antes do primeiro envio da
    sessão; transições READY→STARS/BLOCKED são logadas.

57. **Modo Automação em tela cheia com takeover rigoroso da UI** — Quando o
    daemon assume a sessão, o app inteiro entra em `AppScreens.automation`:
    uma tela dedicada com nav entre Automação / Extração / Orquestração e o
    painel de chat nunca é montado (o cliente do browser fica desconectado,
    logo AUTH_KEY_DUPLICATED é estruturalmente impossível). Boot detecta
    "automation running" via API e já entra direto no modo (F5-safe).
    Transição de takeover mostra uma sequência animada de preparação
    (entrega de sessão → daemon pronto → desconexão do viewer). Se o daemon
    para de responder (3 falhas de poll), aparece painel de falha com
    "Reconectar" (takeover remoto) ou "Voltar ao chat" (release + initApi).
    BroadcastChannel propaga o modo entre abas — outra aba que recebe o
    sinal re-checa o daemon e entra/sai junto. Botão voltar do browser só
    navega entre as telas do modo; sair exige release explícito.

58. **Upgrade de UX da Extração + resolução de destino sob demanda** — Itens
    viraram cards interativos: texto selecionável, clique copia (+ botão com
    feedback "Copiado!"), toggle de ordenação (recentes/mais vistos), exportar
    TXT/CSV da aba ou CSV completo com todos os tipos (BOM p/ Excel, datas
    ISO). Botão "ver destino" resolve convites sob demanda via
    `checkChatInvite` (read-only, sem join): grava `resolved_title`,
    `resolved_members`, `resolved_type` (grupo/canal), `resolved_about`
    (vira tooltip, sem inchar o layout) e foto stripped (bytes inline do
    próprio convite, zero chamadas extras). Convite expirado marca
    `resolved_failed` e não tenta de novo. Arquitetura do resolver isolada
    (runner.resolveInviteLink) para futura auto-resolução de convites novos.

59. **Suporte a proxy IPv6** — Três barreiras removidas: (1) `URL#hostname`
    mantém os colchetes em literais IPv6 (`socks5://…@[2001:db8::1]:1080`) e
    `net.connect` engasgava no getaddrinfo — agora o host do proxy é
    desbracketado antes de conectar (SOCKS5 e HTTP CONNECT); (2) destino
    IPv6 no SOCKS5 não era implementado ("use domain") — agora usa
    ATYP=0x04 com endereço de 16 bytes (parser expande "::"); (3) HTTP
    CONNECT e o header `Host` do wsRelay formatam alvo IPv6 com colchetes
    (`CONNECT [::1]:443`), formato exigido pela spec. Testes cobrem proxy
    host IPv6 + destino IPv6 nos dois protocolos.

60. **Campanha fase B — vida real + monitoramento** — Botão "Testar em Saved
    Messages" manda 1 mensagem real pra você mesmo (cooldown 15s no servidor
    contra clique duplo; respeita o toggle de preview de link). Links ganham
    saúde: ao adicionar um link t.me a resolução read-only roda na hora
    (título/membros/tipo/about viram tooltip), botão "stats" verifica de novo
    quando quiser, e linhas mostram envios (total + 24h) e membros com delta
    entre as duas últimas verificações. Tracking periódico de membros é
    opt-in e desligado por padrão (intervalo mínimo 4h, pacing de ~4s entre
    links, read-only): cada verificação é atividade de consulta na conta —
    ressava documentada. ResolveUsername + GetFullChannel cobrem links
    públicos; convites seguem por checkChatInvite.

61. **Campanha fase C — campanhas nomeadas + aba Desempenho** — Seletor no
    topo da aba Campanha com Nova/Duplicar/Renomear; ativar pede confirmação
    explícita e a automação passa a usar a campanha no próximo envio (sem
    restart, pois o scheduler relê a campanha ativa a cada envio; worker
    recebe o novo conteúdo via sync do orquestrador). Aba "Desempenho":
    sucesso por template (7d, com template_id nos logs), barras de envios
    por hora (48h), grupos com mais tentativas e sparkline de crescimento de
    membros por link — tudo leitura pura de banco, zero atividade no
    Telegram. Corrigido de passagem: UPDATE sem .run() no activateCampaign
    deixava duas campanhas ativas.

62. **Correção do layout dos painéis promo — botões com width 100%** — O
    `Button` do design system é bloco de largura total por padrão
    (`width: 100%` + `flex-shrink: 0`, pensado para CTAs de página inteira).
    Em qualquer linha com 2+ botões (barra de campanhas, prévia, ações de
    template, adicionar link, exportações do extrator) cada botão exigia
    100% da largura sem encolher, espremendo selects/inputs até tamanhos
    mínimos e estourando as linhas. Corrigido marcando esses botões com
    `fluid` (largura pelo conteúdo), inputs em linha com `flex: 1` +
    `noMargin` (o input-group carrega margin-bottom de 1.125rem que
    quebrava o ritmo), abas em grid fixo de 3 colunas (6 abas não
    transbordam mais), badge de status com ellipsis, linha de peso+ações
    do template redesenhada e `flex-wrap` nas ações de exportação.

63. **Destinos de divulgação — intercalar grupos na mesma campanha** — Nova
    tabela `destinations` (nome, peso, toggle ativo, ordem) agrupa os links
    de convite do mesmo grupo promovido; `campaign_links.destination_id`
    liga cada link a um destino (nulo = "avulso") e `logs.destination_id`
    grava a atribuição de cada envio para o futuro dashboard de conversão.
    Sem envio: o scheduler sorteia UM destino ativo por peso (peso 4 vs 1 ≈
    80/20) e usa um link dele no `{LINK}`; links avulsos só entram quando
    nenhum destino ativo tem link ativo — um destino focado nunca vaza
    links de outro grupo. A "seleção" É o toggle do destino (nada de modo
    global): "Focar" ativa só aquele; todos marcados = intercalação geral.
    Zero superfície nova de detecção: só o link dentro da mensagem muda,
    a pasta de envio e o pacing continuam idênticos. Migração one-shot no
    primeiro boot agrupa os links existentes por `resolved_title` (resto
    vira "Destino inicial"); duplicar campanha copia destinos com o
    mapeamento remontado; sync do orquestrador envia destinos por índice
    (worker mapeia para os ids locais). UI: seção "Destinos de Divulgação"
    com cards (toggle, envios 24h, membros, peso), links aninhados dentro
    de cada card, grupo "Avulsos", select de destino ao adicionar link e
    prévia sorteando o mesmo pool do envio real (de passagem corrigiu o
    reroll da prévia, que não re-sortava com rotação desligada).

64. **Loop infinito de reintegração de grupos banidos — probe cego a
    banimento por usuário** — O `probeChat` julgava "canWrite" só pelos
    flags do `GetFullChannel` (`left`/`bannedRights`/`defaultBannedRights`),
    que não refletem banimento por usuário: conta expulsa/banida de grupo
    público continua resolvendo o full info sem `left` nem `bannedRights`,
    e para grupos básicos o probe retornava `canWrite: true`
    incondicional. Resultado: a revalidação (30 min) reintegrava grupos
    banidos, o sort por `lastSentAt` mais antigo os colocava na cabeça da
    fila, o envio real falhava com `USER_BANNED_IN_CHANNEL` e
    re-quarentenava — 30 min depois o sweep reintegrava de novo. Evidência
    ao vivo: 11 grupos com 2–3 erros cada em rajadas separadas por
    exatamente 30 min (28 `SendMessage` desperdiçados em ~2h contra contas
    banidas). Corrigido: o probe pergunta à Telegram via
    `channels.getParticipant(channel, InputPeerSelf)` (read-only) —
    participante `ChannelParticipantBanned` com `kicked` ou
    `bannedRights.sendMessages`, ou `ChannelParticipantLeft`, mantém
    quarentena; erros permanentes (`USER_NOT_PARTICIPANT` etc.) idem;
    transitórios (flood/timeout) devolvem `undefined` e o scheduler
    tenta no próximo ciclo. Grupos básicos: presença do próprio id na
    lista de participantes do `GetFullChat`. De passagem: (1) o motivo de
    espera agora agrega — "Aguardando cooldown de X (~Ns) · N grupo(s)
    aguardando 12+ mensagens de terceiros" — antes dizia só "Aguardando
    cooldown de {grupo}" mesmo quando a maioria esperava mensagens,
    mascarando por que o contador de prontos ficava em 0; (2)
    `WAITING_RESEND` faltava na união de tipos do client e no badge da
    aba Fila; (3) a seção "Livre para enviar" do painel Divulgação ganhou
    um hint explicando que ela avalia só slowmode/estrelas (critério do
    envio manual), enquanto a automação exige também mensagens de
    terceiros desde o último envio e intervalo mínimo de reenvio.

65. **`telegram-promo2` nunca conectava — `PROXY_URL2` com credenciais
    invertidas** — O valor na stack era `http://ip:porta@usuario:senha`;
    `new URL()` rejeita esse formato ("Invalid URL": a porta viraria o
    que vier depois da arroba), e como 100% do tráfego MTProto do daemon
    passa pelo relay Fail-Closed, nenhuma conexão ao Telegram era
    possível: o runner ficou em loop de retry às cegas (~49 mil
    tentativas em 14h) e o takeover nunca completava — do lado da UI,
    "inicia e não vai". O código já suportava proxy autenticado (HTTP
    CONNECT com `Proxy-Authorization: Basic` e SOCKS5 user/pass); o erro
    era só de configuração. Corrigido o valor na stack do Portainer
    (credenciais antes do host), recriando apenas o `telegram-promo2`
    (container 1 intocado, mesma imagem); validação de ponta a ponta:
    upgrade websocket em `/apiws_proxy` na porta 8091 retorna
    `101 Switching Protocols` através do proxy. Hardening: o daemon
    valida o `PROXY_URL` no boot (`getProxyUrlFormatError`) e loga na
    hora o problema e o formato esperado, em vez de deixar o operador
    descobrir por dezenas de milhares de retries silenciosos.

66. **Fail-closed incompleto no navegador — fallback de transporte HTTP
    podia furar o proxy e vazar o IP da máquina** — O relay em si era
    fail-closed (com `proxyRelayOrigin` setado, o websocket só aponta
    para `/apiws_proxy`, sem fallback direto), mas o `MTProtoSender`
    mantinha um plano B herdado do Telegram Web: após
    `_retriesToFallback` falhas de ws, se `shouldAllowHttpTransport`
    estivesse ligado (Configurações → Experimental), trocava para o
    transporte HTTP — `fetch` **direto ao DC**, fora do relay e do
    proxy. Ou seja: com o relay quebrado, um toggle experimental
    "ressuscitava" a interface conectando direto do IP da máquina,
    exatamente o vazamento que a política fail-closed promete impedir.
    O daemon nunca teve esse fallback (por isso ficou preso nos ~49 mil
    retries). Corrigido em três camadas, todas ligadas ao
    `IS_PROXY_ENABLED` (o `config.js` injetado pelo entrypoint): (1) o
    init passa `false` para `shouldAllowHttpTransport`/`shouldForceHttpTransport`;
    (2) os setters em runtime (`setAllowHttpTransport`/
    `setForceHttpTransport`) clampeiam para `false` — chokepoint por
    onde toda mudança de settings passa; (3) os toggles da UI ficam
    desabilitados com o proxy ativo. Com isso a promessa da doc é
    verdadeira: sem relay, sem conexão — nunca direto.

67. **Flood eterno em `messages.CheckChatInvite` — a conta ficava presa
    em FLOOD_WAIT e cada nova tentativa renovava o castigo** — O erro
    `RPCError 420: FLOOD_WAIT_1072 (caused by messages.CheckChatInvite)`
    aparecia no painel ("Internal server error (campaign/links/resolve)")
    e nunca saía. Causa em cadeia: (1) `resolveInviteLink`/
    `resolvePublicUsername` não tinham cache — cada "Adicionar link"
    resolvia implicitamente, cada "checar membros" re-resolvia o mesmo
    hash, e o fluxo de candidatos extraídos resolvia um por clique; (2)
    não havia pacing entre resoluções — uma sequência de cliques virava
    rajada; (3) pior de tudo: nenhum tratamento de `FLOOD_WAIT` —
    durante a janela de castigo, cada novo clique reenviava o request,
    e o Telegram renovava/estendia a janela, então a conta nunca
    deixava de "receber too many requests". Corrigido com o
    `ResolveGuard` (`server/automation/resolveGuard.ts`), por onde
    **toda** resolução agora passa: cache de 10 min por alvo (re-checar
    o mesmo link custa zero chamadas), pacing humano de 4 s entre
    chamadas reais, e portão de flood que registra a janela inteira do
    Telegram e recusa novas tentativas com erro amigável (HTTP 429
    "Telegram flood limit active — try again in N min") até a janela
    expirar — sem tocar na API, sem renovar o castigo. O loop de member
    tracking aborta a passada ao encontrar flood. Nada de resolução
    automática nova: continua tudo no clique; o guard só garante que os
    cliques não viram rajada e que o castigo é honrado até o fim.

68. **Orquestração 0/0 online — master configurado, mas ninguém (nem ele
    próprio) se registrava** — Sintoma: com `NODE_ROLE=master` no container
    1, o painel de Orquestração abria mas mostrava "0/0 contas online".
    Causa dupla: (1) a arquitetura só registra quem tem `MASTER_URL` +
    `WORKER_API_URL` — o container 2 nunca recebeu essas variáveis, então
    nunca chamou `register`; (2) o master **não se registrava a si mesmo**:
    a tabela `orchestrator_workers` ficava vazia e, com ela, a própria
    conta do master ficava invisível e FORA das regras globais (sem claim,
    sem interleaving, sem cooldown compartilhado — podia até colidir com a
    conta 2 no mesmo grupo). Correções: (a) auto-registro do master — sem
    `MASTER_URL`, o daemon cria um client apontando para a própria API
    local (`http://127.0.0.1:3000`) e se registra como worker com
    `WORKER_ID`, participando das regras globais como qualquer conta;
    (b) o self-registration **não aplica** o desired config/campaign de
    volta em si (ele é a fonte da verdade — aplicar de volta criaria um
    loop em que cada rebalance encolheria a meta global); em vez disso,
    o scheduler do master consome a própria fatia `metaTarget` direto do
    coordenador (`resolveRoundTarget`), mantendo o interleaving justo;
    (c) wiring completo no compose da stack (`WORKER_ID` estável e
    legível por conta, `MASTER_URL` pela rede interna do docker);
    (d) debug: boot log com role/workerId/target, logs de transição
    (`running degraded` / `restored`) em vez de falha silenciosa no
    heartbeat/claim/report. Testes: self-registro, não-aplicação do
    desired-state no master, aplicação da fatia no worker real,
    rebalance 4/3, e claim grantable pelo self (268/268).

69. **Campaign-sync do worker nunca funcionou — crash silencioso a cada
    heartbeat (`Cannot read properties of undefined (reading 'id')`)** —
    Descoberto pelos logs de transição novos do fix 68: o container 2
    flapava degradado↔saudável a cada tick de 15s. Causa: o master montava
    o `desiredCampaign.templates` com os **registros completos**
    (`campaign.templates`, incluindo os `id`s locais do master), violando
    o contrato content-only já declarado na interface do workerClient. No
    worker, `replaceCampaignContent` faz `saveCampaignTemplate({campaignId,
    ...template})` — com `id` presente, caía no caminho de UPDATE com o id
    do MASTER, logo após deletar os templates locais: UPDATE não acha
    linha, `SELECT ... WHERE id = ?` volta `undefined` e `mapTemplateRow`
    explode. Determinístico em qualquer worker cujo master tivesse
    templates — ou seja, o sync de campanha nunca funcionou em produção;
    antes dos logs a exceção era engolida e o worker vivia "degradado".
    Correção nos dois lados: (a) master projeta templates content-only
    (`title/content/weight/isEnabled`), igual já fazia com `allLinks` e
    `destinations` — o que inclusive conserta workers em imagens antigas;
    (b) worker normaliza o payload antes de aplicar, por defesa contra
    masters antigos. Teste de regressão com o cenário real (master com
    template+destino+link, worker adotando o conteúdo e rebindando links
    aos ids locais) + asserções de `isDegraded === false`. Validado ao
    vivo: campanha da conta 2 agora é espelho exato da conta 1
    (268/268).

70. **Orquestração v2 — fim do desired-state; config/campanha 100% locais,
    overrides globais esparsos e canal de comandos** — Decisão de produto
    registrada após o postmortem 69: mesmo com o sync consertado, empurrar
    estado completo (config + campanha) a cada heartbeat é frágil e
    acoplado — qualquer mudança de shape quebra o worker distante, e a
    conta vira um clone sem identidade própria. Modelo novo: (a) cada
    conta é dona da própria config e campanha, sempre; (b) o master define
    **overrides esparsos por campo** (`orchestrator_overrides`,
    whitelist `OVERRIDEABLE_CONFIG_FIELDS` — ritmo completo), o daemon
    aplica `efetivo = override ?? local` via cache persistido em
    `orchestrator_state` (nunca escreve na config local; remoção do
    override restaura o valor local na hora; cache sobrevive a restart e a
    período degradado); `roundTargetSends` é especial — a meta global é
    dividida entre contas online e a **fatia** substitui o campo
    (`clearMetaTargets` quando não há override, cada conta volta à meta
    local); (c) ações **por comando, com ack**: `start`/`stop`/
    `campaign-copy` ficam pendentes na linha do worker
    (`pending_command_json`), são entregues no heartbeat, executados de
    forma idempotente e ackados no tick seguinte (`last_command_ack_json`);
    TTL de 120 s expira comando de conta morta (anti-zombie-start); (d)
    painel "Orquestração" vira cockpit: identidade (username/user id
    capturados no connect), digest só-leitura do ritmo efetivo,
    Iniciar/Parar/copiar campanha **um clique consciente por conta com
    confirmação** (nunca em lote — regra permanente), seção "Valores
    globais" e badges de override no editor de ritmo; (e) cópia de
    campanha é one-shot e content-only (destinos por índice, ids locais
    nunca vazam; destino reconstrói com ids próprios) — sem sincronização
    automática por design. Compatibilidade de deploy misto: worker novo
    ignora resposta sem `overrides` (checagem por presença de chave);
    master novo não quebra worker velho (não envia mais desiredConfig/
    desiredCampaign). Protocolo extensível: campos novos na whitelist
    propagam sem mudar wire-format; worker antigo simplesmente ignora
    campos desconhecidos (272/272).

71. **Fome de slots do orquestrador — fairness sem janela + re-eleição
    determinística** — Diagnosticado ao vivo pós-deploy v2: ambas as contas
    passavam a maior parte do tempo em `Aguardando slot global do
    orquestrador` com a fila cheia de grupos elegíveis (conta 1: 4,4h sem
    enviar nenhum grupo; ~1 grant/hora na rede). Duas causas combinadas:
    (a) o round-robin de fairness (`otherLastGrant < myLastGrant`) não
    tinha janela — num grupo compartilhado onde a conta rival **nunca**
    enviou (`lastGrant = 0`), quem já tinha enviado ficava bloqueado
    **para sempre** (`0 < t` é sempre verdadeiro); com 35 grupos
    compartilhados, boa parte da fila ficava cativa da conta que "devia" a
    vez e nunca a usava; (b) o scheduler elegia o grupo de `lastSentAt`
    mais antigo e, negado o claim, dormia 5-30 s e re-elegia **o mesmo
    grupo** — loop infinito de nega enquanto dezenas de grupos claimáveis
    ficavam ociosos. Correções: fairness agora expira com a janela de
    resend (`serverNow - myLastGrant < resendGapSeconds` — após o gap o
    grupo reabre mesmo se a rival não usou a vez); negativa de claim é
    cacheada worker-side por até 2 min (`orchestratorSlotDenyUntil`) e o
    loop segue **imediatamente** para o próximo grupo elegível, dormindo
    só quando todos estão negados (motivo e próximo slot no log). Junto,
    no mesmo ciclo: `start`/`stop` do painel passaram a ser empurrados
    direto ao daemon do worker (`takeover`/`release` na mesma requisição,
    ack incluso na resposta; heartbeat vira fallback quando a entrega
    direta falha) e o worker passou a confirmar execução via
    `POST /command-ack` imediato em vez de esperar o heartbeat seguinte —
    fim da "demora para iniciar". Painel: botão de ação contextual
    (Iniciar quando parado, Parar quando rodando, estado da transição
    durante comando pendente) em vez dos dois botões sempre visíveis
    (274/274).

72. **Sessões destruídas por AUTH_KEY_DUPLICATED após redeploy — logout das
    duas contas (incidente real)** — O redeploy via webhook (10:39Z) matou os
    containers com as duas sessões CONECTADAS (automações armadas desde
    10:03Z). ~70s depois, o primeiro re-arm da account-1 recebeu
    `AUTH_KEY_DUPLICATED`; a sessão da account-2 foi destruída na reconexão do
    próprio navegador (hand-back do modo automação) dentro da janela em que o
    servidor ainda via a conexão morta como "em uso" — piorada pelo proxy da
    conta 2, que pode manter o upstream aberto mesmo após o FIN. O 406 não é
    transitório: o Telegram **invalida a chave** — as duas contas precisaram
    logar de novo. Três brechas somadas: (a) o handler de SIGTERM existia,
    mas travava em `server.close()` com keep-alive do nginx até o SIGKILL do
    Docker; (b) o hand-back do navegador reconectava sem nenhuma noção de
    janela (boot, desbloqueio de passcode e "Voltar ao chat"); (c) o re-arm
    remoto não respeitava janela alguma — e podia colidir com um navegador
    que já tivesse retomado a sessão. Correções (defesa em camadas):
    SIGTERM/SIGINT robusto (desconecta o client, fecha o DB e sai em <1s, com
    rede de força de 3s — sem esperar o drain do HTTP); marcadores
    persistidos `session-last-alive-at` (tick de 30s conectado) e
    `session-user-released-at` (todo release via API); cooldown de 180s
    divulgado no status (`sessionSafetyWaitSeconds`) e ENFORCADO em três
    pontos — start do daemon (recusa com mensagem), boot/unlock do navegador
    (initApi espera zerar) e saída do modo automação (estaciona com countdown;
    daemon morto → o navegador conta a mesma janela a partir do último poll
    que viu `isTelegramConnected`); watcher global de takeover (poll de 15s:
    cliente local conectado + daemon conectado → entrega a sessão e entra no
    modo automação, espelhando o handover do painel local, historicamente
    seguro). Revisão do design revelou que o gatilho do 406 é o uso
    concorrente SUSTENTADO da mesma key (~segundos a dezenas de segundos) —
    o painel local sobrevive há semanas porque sua sobreposição dura 1-3s
    e o browser se desconecta logo em seguida, mas um arm remoto com o
    navegador vivo sustentaria a sobreposição indefinidamente. Logo o
    watcher sozinho não bastaria: foi adicionada **presença de browser** —
    o app POSTa `browser-presence` a cada 5s com `isClientConnected`, e todo
    start REMOTO (takeover vazio ou comando do orquestrador) é recusado com
    "the account is open in a web browser" enquanto houver sinal recente
    (≤120s, cobrindo abas em background com timer throttado pelo browser e
    abas recém-fechadas); o handover coordenado (takeover COM `sessionData`
    — painel local e "Reconectar" do modo automação, que desconectam o
    browser logo após a confirmação) segue liberado; o `handleReconnect`
    do modo automação agora também desconecta o client do browser após o
    takeover (caso pós-relogin). `AUTH_KEY_DUPLICATED` vira falha
    estruturada com instrução de relogin; e o catch do connect não deixa
    client órfão (fix prévio da parte 1 deste item, mantido). Runbook:
    redeploy com automação armada agora é seguro; após crash/OOM, aguardar o
    countdown que a UI mostra antes de armar/navegar; para armar remotamente
    a interface da conta precisa estar fechada ou no modo automação (o
    daemon recusa e explica no ack). Testes: 12 em `sessionSafety.test.ts`
    (286/286). Backlog de hardening (exige decisão de produto): autorizações
    separadas por client (browser e daemon com keys próprias) eliminaria a
    fragilidade da key compartilhada.

73. **Postmortem do segundo 406 + recusa de arm remoto que travou o fluxo do
    cockpit (2026-10-08)** — Timeline validada por logs: as duas contas
    rodaram bem pela manhã (acc1 19 envios, acc2 43) na imagem ANTERIOR ao
    fix 72; às 09:44:55Z a account-2 tomou 406 (`AUTH_KEY_DUPLICATED`,
    "outro cliente assumiu — ex.: o webapp foi aberto") — o webapp foi aberto
    com o daemon rodando, exatamente a classe de incidente que o fix 72 (que
    só subiu às 14:12Z) visa eliminar. Depois do deploy do fix, o usuário
    re-logou a account-2 e tentou armar AMBAS pelo painel de orquestração às
    ~14:58Z — as duas recusadas pelo guard de presença com a mensagem em
    inglês "close that tab and wait up to ~2 min", que (a) não dizia o que
    realmente resolveria e (b) transformou o fluxo principal do cockpit em
    dead-end. Brechas encontradas na revisão completa: (1) a recusa de
    presença não tinha caminho de auto-resolução; (2) `connectBrowserClientWhenSessionSafe`
    ignorava `isRunning`/`isTelegramConnected` do status — race boot × arm
    remoto podia conectar o browser com o daemon vivo; (3) `syncAutomationModeFromOtherTab`
    ativava o modo automação SEM desconectar o client da aba (dual-use
    cross-tab); (4) `requestReconnectApi` (health-check do worker Safari)
    reconectava sem gate — no modo automação isso reconectaria com o daemon
    rodando; (5) `fetchSessionWaitSeconds` retornava 0 quando
    `isTelegramConnected` — e "Voltar ao chat" interpretava 0 como "seguro
    conectar": release falho + daemon vivo = 406 na saída; (6) start remoto
    pós-relogin usaria a sessão salva morta e falharia com erro críptico de
    RPC em vez de instrução acionável. Correções: **handshake de
    pending-start** — start remoto com browser presente publica
    `browserPendingStart` no status por ≤30s e espera até 12s; o watcher da
    aba da conta (~2.5s, antes 5s) vê a flag, entrega a sessão
    (disconnect + modo automação) e confirma no próximo beat; o daemon só
    conecta após beat fresco `isClientConnected:false` — sobreposição zero;
    aba que não responde (fechada/throttle de background) → recusa honesta
    após 12s; **fingerprint de sessão** — o beat carrega SHA-256(prefixo) das
    authKeys; divergência com a sessão salva (relogin) = recusa IMEDIATA
    dizendo para usar o painel da própria conta (Iniciar), em vez de
    conectar numa key morta; guard `isRunning||isTelegramConnected` no boot
    (entra no modo automação em vez de initApi); sync cross-tab desconecta o
    client antes de ativar o modo; `requestReconnectApi` não reconecta no
    modo automação; "Voltar ao chat"/countdown usam `SessionHandbackState`
    (daemon dono da sessão → não sai do modo, não conecta) com erro visível
    se o release não vingou; mensagens de guard em PT-BR acionáveis;
    `DIRECT_DELIVERY_TIMEOUT_MS` 30s→45s para cobrir handshake+connect
    dentro de UMA entrega (sem cair no fallback confuso do heartbeat).
    Validação: 16 testes em `sessionSafety.test.ts` (290/290 no total) +
    E2E com daemon real em sandbox (sessão fake, DB limpo, sem API ID —
    zero contato com Telegram): fingerprint divergente → recusa imediata
    (0.00s); handshake → `browserPendingStart:true` visível no status,
    yield aceito em 2.0s, start liberado; sem yield → recusa honesta em
    12.0s. Fluxo do usuário volta a ser: cockpit Iniciar → a aba da conta
    entrega a sessão sozinha → armado; a ÚNICA exceção é conta recém
    re-logada (fingerprint divergente), em que o ack manda usar o painel da
    conta uma vez — depois disso o cockpit volta a funcionar sempre.
    Ressalva de risco permanente: o guard cobre o navegador DESTE
    produto; a mesma conta logada em OUTRO cliente (Telegram desktop /
    celular / outro navegador fora daqui) continua podendo gerar
    AUTH_KEY_DUPLICATED — Telegram não oferece isolamento por client sem
    autorizações separadas (backlog 72, exige decisão de produto).
