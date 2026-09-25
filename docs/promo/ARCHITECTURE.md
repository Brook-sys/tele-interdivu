# Painel de Divulgação — Arquitetura

Fork de `Ajaxy/telegram-tt` (Telegram Web A) com uma camada customizada ("Painel de
Divulgação") para gestão de grupos de divulgação de links. Branch `custom`, pinada
na tag upstream `air_v2.11.5`.

## Decisões de produto (confirmadas com o usuário)

| Decisão | Valor |
|---|---|
| Visibilidade de grupos | Derivada de uma **pasta nativa** do Telegram (fonte de verdade na nuvem, sync entre dispositivos) |
| Categorias do painel | **3 fixas**, em nível de sistema: `Livre para enviar`, `Com slowmode ativo`, `Cobra Estrelas` |
| Chat bloqueado (banido/restringido) | **Fora do painel** (não aparece em nenhuma seção; gerenciável em "Gerenciar Grupos") |
| Precedência estrelas × slowmode | **Estrelas vencem**; countdown de slowmode exibido no badge da linha |
| "Slowmode ativo" | = countdown rodando para o usuário (não "grupo tem slowmode configurado") |
| Configurável | Apenas ordem entre as 3 seções + critério de sort dentro de cada uma (tela de settings, persistida) |
| Local na UI | Aba/conteúdo adicional na sidebar (coexiste com listas nativas) |
| Automação futura (F4) | NÃO implementada; dados serializáveis e lógica pura para plugar depois |

## Árvore de classificação (regra central, nível de sistema)

```
classifyChat(chat, fullInfo, promoStatus, serverNow) → 'blocked' | 'stars' | 'slowmode' | 'free'

1. blocked  → fora do painel
     isForbidden || isNotJoined || isRestricted
     || currentUserBannedRights?.sendMessages || defaultBannedRights?.sendMessages
     (adminRights?.postMessages desbloqueia)
     || tipo não é grupo (basic/supergroup)
2. stars    → chat.paidMessagesStars > 0           [precedência sobre slowmode]
3. slowmode → remainingSeconds > 0
     remaining = max(slowMode.nextSendDate - now, lastOwnMessageAt + slowMode.seconds - now, 0)
4. free     → caso contrário
```

Cada chat visível ocupa **exatamente 1 seção**. Movimentação entre seções ocorre
somente por transição real de estado (countdown expirou, admin mudou cobrança,
banimento). **Nova mensagem recebida nunca reordena** — a ordenação dentro das
seções usa critérios estáticos (alfabético/estrelas/countdown), nunca última mensagem.

## Fontes de dados (todas validadas no código upstream)

| Dado | Fonte | Custo de API |
|---|---|---|
| Custo em estrelas | `ApiChat.paidMessagesStars` — vem no **objeto base** `channel` (flags2.14), já cacheado em `global.chats.byId` | Zero |
| Permissão de envio | `ApiChat.currentUserBannedRights`, `defaultBannedRights`, `adminRights`, `isNotJoined`, `isForbidden`, `isRestricted` — objeto base cacheado | Zero |
| Slowmode (config) | `ApiChatFullInfo.slowMode.seconds/nextSendDate` — `global.chats.fullInfoById` | fetchFullChat on-demand |
| Última mensagem própria | `promo.statusById[chatId].lastOwnMessageAt` — capturada do updater `newMessage` (echo local + confirmação) | Zero |
| Recalibragem slowmode | Erro `SLOWMODE_WAIT_X` (se exposto pelo fluxo de erro) | Zero |
| Membros visíveis | Pasta nativa → `folderManager.getOrderedIds(folderId)` via hook `useFolderManagerForOrderedIds` | Zero |

## Política anti-FloodWait (F1b)

- Contagem regressiva é computação **local** (`getServerTime()` de `src/util/serverTime.ts`).
- Refetch de `fullInfo`: fila global serial (concorrência 1), intervalo mínimo entre
  chamadas, TTL de status de 10 min, executada apenas com o painel aberto.
- Backoff: em `FLOOD_WAIT_X`, pausa a fila por `seconds + margem`; backoff genérico
  se o erro não expuser segundos.
- Updates do Telegram (`updateChat`, mudanças de permissões) já disparam refetch de
  full info no upstream (`apiUpdaters`), sem ação nossa.

## Persistência

- Estado custom no slice global `promo` (teactn), persistido em IndexedDB pelo mecanismo
  existente (`src/global/cache.ts` → `reduceGlobal`), versionado com migração.
- Estrutura por conta (multi-account safe): `promo.byUserId[userId] = { settings, statusById }`.
- Sem backend próprio; SQLite foi descartado (SPA client-side; volume de dados trivial).
- `navigator.storage.persist()` não é aplicado no fork (o app já é PWA instalável);
  mitigação contra evicção: a fonte de verdade de visibilidade (pasta) vive na nuvem do
  Telegram; settings têm export/import JSON.

## Estrutura de módulos (novos arquivos — isolados do upstream)

```
src/global/types/promo.ts              tipos (PromoSettings, PromoChatStatus, PromoCategoryId…)
src/global/reducers/promo.ts           reducers puros (recordOutgoing, updateSettings…)
src/global/selectors/promo.ts          seletores (settings, classificação, seções)
src/global/actions/api/promo.ts        ações (fila fullChat, toggle visibilidade em lote)
src/util/promo/classifyChat.ts         classificador puro (testável) + countdown
src/util/promo/statusQueue.ts          fila serial de fetchFullChat com backoff
src/components/left/promo/PromoPanel.tsx        aba do painel (3 seções fixas)
src/components/left/promo/PromoSection.tsx      cabeçalho de seção
src/components/left/promo/PromoChatRow.tsx     linha com badges (estrelas/countdown)
src/components/left/promo/PromoPanelSettings.tsx  tela de settings do painel
src/components/left/promo/PromoManageGroups.tsx   Gerenciar Grupos (busca+multi-select)
docs/promo/ARCHITECTURE.md             (este arquivo)
docs/CUSTOMIZATIONS.md                 manifest de cada arquivo upstream tocado
docs/QUESTIONS.md                      dúvidas pendentes
docs/SETUP.md                          build/deploy
```

## Arquivos upstream modificados (diffs mínimos — ver CUSTOMIZATIONS.md)

1. `src/types/index.ts` — enum `LeftColumnContent` += `PromoPanel`, `PromoManage`
2. `src/components/left/LeftColumn.tsx` — `ContentType` + render dos novos conteúdos
3. Menu lateral — itens de entrada "Painel de Divulgação" e "Gerenciar Grupos"
4. `src/global/types/globalState.ts` — slice `promo`
5. `src/global/initialState.ts` — estado inicial
6. `src/global/cache.ts` — persistência (`reducePromo`) + migração
7. `src/global/types/actions.ts` — assinaturas das ações novas
8. `src/global/actions/all.ts` — registro `./api/promo`
9. `src/global/actions/apiUpdaters/messages.ts` — 1 linha no `case 'newMessage'`
   (captura de mensagens enviadas)
10. `src/assets/localization/fallback.strings` — chaves novas (regenerar com `npm run lang:ts`)

## Ponto de extensão futura (F4 — NÃO implementado)

O classificador `classifyChat` e os seletores de seção são funções puras sobre dados
serializáveis. Um scheduler futuro (browser ou serviço headless Node+GramJS) pode
reusá-los: "Livre para enviar" = fila de envio; "Com slowmode" = agendamento pós-countdown;
"Cobra Estrelas" = fora da automação gratuita. Nenhuma lógica de negócio vive em
componentes de UI.
