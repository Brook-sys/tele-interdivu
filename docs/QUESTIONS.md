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
