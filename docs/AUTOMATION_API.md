# Automation REST API

The automation daemon exposes a full remote-control API under
`/api/v1/automation/` on the same host/port as the web app
(e.g. `https://seu-host:8090/api/v1/automation/...`).

Everything the web panel does can be done via plain HTTP — start, stop,
reconfigure, edit the campaign, manage the group rotation and inspect
telemetry — without opening the site.

## Authentication (optional)

Set the environment variable `AUTOMATION_API_TOKEN` in the container/stack.
When set, **every** endpoint requires:

```
Authorization: Bearer <token>
```

The web UI keeps working: open it once with `?automationToken=<token>` appended
to the URL (works before or after the `#` hash); the token is persisted in
`localStorage` under `automationApiToken` and sent on every request.

Example stack env:

```yaml
environment:
  AUTOMATION_API_TOKEN: "um-token-longo-e-secreto"
```

## Endpoints

Base path: `/api/v1/automation`

### Status & telemetry

| Method | Path | Description |
|---|---|---|
| GET | `status` | Scheduler state, config, campaign and counters (sent today/24h, per-status group counts, round progress). |
| GET | `debug` | Full diagnostics: scheduler state incl. live remaining seconds, runner connection stats, per-group evaluation reasons. |
| GET | `logs?limit=N` | Last N log entries (max 100): sends, skips, flood waits, errors, system events. |

### Start / stop

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `takeover` | `{ sessionData?, targetChats? }` | Starts (or restarts) the automation. **Remote start:** calling with `{}` reuses the session and group list saved from the last browser takeover. Response includes `usedSavedSession` and `groupsCount`. |
| POST | `release` | – | Stops the automation immediately and releases the Telegram session back to the browser. |

`targetChats` entry: `{ id, title, accessHash, slowmodeSeconds?, slowmodeNextSendDate?, lastSentAt?, starsCost?, status? }`.
`status` may be `READY`, `WAITING_SLOWMODE`, `WAITING_RESEND`, `WAITING_MESSAGES`, `BLOCKED`, `STARS` — the daemon quarantines `STARS`/`BLOCKED` and re-probes them automatically every 30 min. The probe is read-only and verifies actual membership (`channels.getParticipant` for supergroups, participant list for basic groups), so per-user bans stay quarantined instead of being reintegrated into failed sends.

### Configuration

| Method | Path | Description |
|---|---|---|
| GET | `config` | Current config. |
| POST | `config` | Partial update. Fields: `mode` (`manual`/`continuous`), `minDelaySeconds`, `maxDelaySeconds`, `roundIntervalMinutes`, `roundTargetSends`, `minOtherMessages`, `minResendIntervalMinutes`, `sleepWindowEnabled`, `sleepWindowStart` (`HH:MM`, container TZ), `sleepWindowEnd`, `dailyLimit` (sliding 24h), `linkPreviewEnabled`, `microPauseEnabled`, `microPauseEveryMin`, `microPauseEveryMax`, `microPauseSeconds`. |

### Campaign

| Method | Path | Description |
|---|---|---|
| GET | `campaign` | Current spintax template + destinations + links. |
| POST | `campaign` | `{ spintaxTemplate, links }` — validated before saving (legacy). |
| POST | `test-spintax` | `{ template, links }` → 5 rendered previews, nothing is sent. |
| POST | `campaign/destinations` | `{ id?, name, weight?, isEnabled? }` — upsert a promotion destination. |
| POST | `campaign/destinations/focus` | `{ id }` — enable only this destination. |
| DELETE | `campaign/destinations/{id}` | Delete a destination (its links become loose). |

### Group rotation

| Method | Path | Description |
|---|---|---|
| GET | `groups` | All tracked groups with evaluated status (`READY`, `WAITING_SLOWMODE`, `WAITING_MESSAGES`, `WAITING_RESEND`, `BLOCKED`, `STARS`). `accessHash` is never exposed. |
| POST | `groups/{chatId}` | Add/update a group. Body: `{ title?, status?, starsCost?, slowmodeSeconds?, accessHash? }`. `accessHash` is required when adding a chat that is not saved yet. Use `status: 'BLOCKED'` to quarantine manually, `status: 'READY'` to reintegrate. |
| POST | `groups/{chatId}` (probe) | A group reintegrated via `status: 'READY'` will be re-checked by the next automatic probe cycle anyway. |
| DELETE | `groups/{chatId}` | Removes the group from the rotation. |

### Recovery / pacing

| Method | Path | Description |
|---|---|---|
| POST | `skip-pause` | Interrupts the current wait (micro-pause, cooldown, sleep window, round interval). |
| POST | `force-new-round` | Resets the round counter and starts a new round immediately. |
| POST | `reset-round` | Resets the per-round send counter. |
| POST | `reconnect` | Forces a Telegram MTProto reconnect (drops and re-dials). |

## curl examples

```bash
BASE="https://seu-host:8090/api/v1/automation"
AUTH="Authorization: Bearer $TOKEN"   # omit if AUTOMATION_API_TOKEN is unset

# Health / progress
curl -s -H "$AUTH" $BASE/status | jq .status,.stats

# Remote start after a server restart (uses saved session + groups)
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' $BASE/takeover -d '{}'

# Stop everything (releases the session back to the browser)
curl -s -X POST -H "$AUTH" $BASE/release

# Change pacing remotely
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' $BASE/config -d '{
  "minDelaySeconds": 30, "maxDelaySeconds": 120,
  "roundTargetSends": 20, "roundIntervalMinutes": 60,
  "minResendIntervalMinutes": 15
}'

# Update the campaign
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' $BASE/campaign -d '{
  "spintaxTemplate": "{🔥|✨} {LINK}",
  "links": ["https://t.me/+AAA", "https://t.me/+BBB"]
}'

# Quarantine / reintegrate / remove a group remotely
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  $BASE/groups/-1001234567890 -d '{"status":"BLOCKED"}'
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  $BASE/groups/-1001234567890 -d '{"status":"READY"}'
curl -s -X DELETE -H "$AUTH" $BASE/groups/-1001234567890
```

## Notes & limits

- The **24h send counter is a sliding window**, not a calendar day.
- The **sleep window uses the container timezone** (`TZ` env, default
  `America/Sao_Paulo` via docker-compose).
- A group added purely via API without `accessHash` cannot receive messages
  until a browser takeover supplies the real hash (Telegram requires it for
  channels).
- With `AUTOMATION_API_TOKEN` enabled, the web UI needs the token once via URL
  (see Authentication).

## Deploy / ops notes

### Stack redeploy webhook (Portainer)

If the stack has a Portainer webhook configured, trigger a redeploy + image
re-pull with:

```
POST <portainer-url>/api/stacks/webhooks/<webhook-uuid>
```

The webhook UUID is shown in the stack settings in the Portainer UI (or via
`GET /api/stacks`, field `Webhook`). Expected response: `HTTP 204`.
Then verify out-of-band with `GET /api/v1/automation/status` — a redeploy
restarts the container and the daemon state resets to `STOPPED`.

### After any container restart

The scheduler state is in-memory: the automation comes back `STOPPED`.
To resume remotely without the UI:

```bash
curl -X POST -H 'Content-Type: application/json' $BASE/takeover -d '{}'
```

(requires that a browser takeover happened at least once, so the session and
target groups are saved).

### Timezone

The scheduler (sleep window) uses the container clock. `TZ` defaults to
`America/Sao_Paulo` in `docker-compose.yml`; override via stack env `TZ`.


### Link extraction (passive)

The daemon passively extracts links from new messages arriving in the target
groups (only while it owns the session). No extra API calls are made — the
messages already flow through the update handler.

| Method | Path | Description |
|---|---|---|
| GET | `extract/links?kind=&q=&limit=&sort=` | Extracted links (deduped), filtered by `kind` (`invite_link`, `tg_link`, `external_link`), text search `q`, `sort=seen` for most-seen first. Includes `timesSeen`, `firstSeenAt`, `lastSeenAt`, source group. |
| GET | `extract/stats` | `{ enabled, byKind: [{ kind, total, last24h, sourceChats }] }`. |
| GET | `extract/export?kind=invite_link` | `text/plain`, one normalized link per line (max 500). |
| POST | `extract/clear` | `{ kind?: string }` — clears one kind or everything. |

Toggle globally via `POST /config` with `{ "extractorEnabled": true|false }`.

## Multi-account orchestration

One image, roles by env. Exactly one container runs as master:

```yaml
# master service (in addition to being a full worker)
environment:
  NODE_ROLE: master
  WORKER_ID: master-1
  WORKER_API_URL: http://<master-host>/        # how the master is displayed in the panel

# each additional account container
environment:
  NODE_ROLE: worker
  WORKER_ID: worker-2
  MASTER_URL: http://<master-host>/            # internal docker network
  WORKER_API_URL: http://<worker-host>/        # how the master reaches it (display/proxy actions)
  ORCHESTRATOR_TOKEN: "shared-secret"
```

- Workers register + heartbeat every 15s (sending their group list + status).
  The heartbeat response carries only **sparse global overrides** plus the
  account's rebalanced round-target share (when a global target is defined);
  there is **no config or campaign sync** — each account owns its local
  config and campaign, and cached overrides are stored in a dedicated
  `orchestrator_state` table, never written over local values. Removing an
  override instantly restores local behavior. The cache survives restarts
  and degraded periods.
- **Effective config**: the scheduler and status route always read
  `getEffectiveConfig()` = local config merged with the cached overrides.
  `roundTargetSends` is special: a global target is split across alive
  accounts by the master, so the rebalanced share replaces it per account.
- **Global values** (`GET/PUT /api/v1/orchestrator/overrides`, master only):
  `PUT` body `{ set?: { field: value }, clear?: [field] }` against the
  whitelist `OVERRIDEABLE_CONFIG_FIELDS` (rhythm, limits, sleep window,
  micro-pauses, link preview, extractor, template rotation). Unknown fields
  or wrong types are rejected with 400. The master's own account consumes
  overrides through the same cache (refreshed immediately on edit).
- **Command channel** (`POST /api/v1/orchestrator/workers/command`, body
  `{ workerId, type, payload? }` with `type` = `start` | `stop` |
  `campaign-copy`): one pending command per account, delivered in the
  heartbeat response, acked on the next heartbeat (acked commands are
  recorded on the worker row for panel feedback). Commands expire after
  120 s so a long-dead command never fires when the account comes back.
  Executors are idempotent: `start` when already running and `stop` when
  stopped are no-ops, `campaign-copy` replaces content. Every command is a
  single explicit click per account in the panel — no batching, no retries.
- **Self-registration**: a master with no `MASTER_URL` registers its own
  account as a worker through its local daemon API, so the master's sends
  are coordinated under the same global rules and its account appears in
  the panel like any other, including identity (username/user id captured
  at connect time and reported in the heartbeat snapshot).
- **Campaign copy**: the orchestration panel can copy the master's campaign
  to another account as a one-shot, confirmed action. The payload is
  content-only (templates, links, destinations by index) — local row ids
  never leave the origin and the destination rebuilds rows with its own ids.
  There is no automatic sync by design.
- Before every send the worker claims a global per-group slot
  (`POST /api/v1/orchestrator/claim`); the master interleaves accounts by
  oldest last-grant and enforces a shared per-group cooldown. Stars/blocked
  reports quarantine the group globally for all workers.
- If the master is unreachable, workers switch to degraded mode: they keep
  sending standalone with their local config plus the last cached overrides,
  and rejoin automatically. State transitions are logged (`docker logs`) —
  `[Interdivu Orchestrator] … running degraded` / `restored` — instead of
  failing silently; boot logs state the role, worker id and master target.
- Panel: "Orquestração" in the side menu (workers show a hint instead). The
  panel is a read-only cockpit over accounts (identity, effective-rhythm
  digest, start/stop/copy actions behind confirmations) plus the global
  values editor.
- Endpoints (master only): `GET info`, `GET workers`, `DELETE workers?workerId=`,
  `GET grants?limit=`, `GET/PUT overrides`, `POST register|heartbeat|claim|report|workers/command`.

### Extract niceties

- `GET extract/export` agora aceita `format=csv` (com BOM UTF-8, datas em ISO
  8601, escapamento RFC 4180) e sem `kind` exporta todos os tipos.
- `POST extract/resolve` body `{ kind: 'invite_link', value }` — resolve o
  convite via `messages.CheckChatInvite` (read-only) e registra
  título/membros/tipo/about/foto-stripped na linha. 410 quando o convite está
  expirado/inválido (fica registrado para não esgotar re-tentativas).
- Toda resolução de link (rotas `extract/resolve` e `campaign/links/resolve`)
  passa pelo `ResolveGuard`: cache de 10 min por alvo, pacing humano de 4 s
  entre chamadas reais e portão de `FLOOD_WAIT` — durante a janela de flood
  a rota responde **429** com mensagem amigável em vez de reenviar ao
  Telegram (reenviar dentro da janela renova o castigo). Cache continua
  sendo servido durante a janela.

### Campaign CRUD (multiple templates + per-link toggles)

- `GET campaign` — returns the active campaign as `{ id, name, spintaxTemplate,
  templates[], destinations[], links[], allLinks[], updatedAt }`. `templates[]` items:
  `{ id, title, content, weight, isEnabled, position }`; `destinations[]`:
  `{ id, name, weight, isEnabled, position }`; `allLinks[]`:
  `{ id, url, isEnabled, position, destinationId? }`; `links` = urls of enabled links.
- `POST campaign/templates` body `{ id?, title?, content, weight?, isEnabled? }`
  — upserts a template of the active campaign (spintax validated, weight
  clamped to ≥ 1). `id` omitted = create.
- `DELETE campaign/templates/{id}`
- `POST campaign/links` body `{ id?, url, isEnabled?, destinationId? }` —
  `destinationId` (must belong to the active campaign) only applies on create;
  toggles keep the assignment.
- `DELETE campaign/links/{id}`
- `POST campaign` (legacy) body `{ spintaxTemplate, links }` — replaces the
  whole active campaign content with a single template (destinations are
  preserved, links come back unassigned); kept for old clients.
- Config flag `templateRotationEnabled` (`POST config`): when true the
  scheduler picks a random enabled template weighted by `weight` per send;
  when false (default) it always uses the first enabled template.

### Promotion destinations (multi-group interleaving)

Destinations group the invite links that point to the same promoted group, so
one campaign can interleave several groups per send instead of rotating a flat
link list.

- `POST campaign/destinations` body `{ id?, name, weight?, isEnabled? }` —
  upserts a destination of the active campaign (name required on create,
  weight clamped to ≥ 1). `id` omitted = create.
- `DELETE campaign/destinations/{id}` — deletes the destination; its links
  survive as loose (`destinationId: null`).
- `POST campaign/destinations/focus` body `{ id }` — enables exactly `id` and
  disables every other destination of the campaign atomically
  ("promote only this group now"). Returns `{ success, campaign }`.
- Send-time behavior: each send picks one **enabled** destination weighted by
  `weight` (weight 4 vs 1 ≈ 80/20 split), then one of its enabled links fills
  `{LINK}`. Loose links are only used while no enabled destination has
  enabled links, so a focused destination never leaks other groups' links.
  Selection lives entirely in the destination toggle — no mode switch, and
  nothing changes about the send-folder groups themselves: only the link inside
  the message varies.
- One-time migration: on the first boot after the upgrade, existing links with
  a resolved title are grouped into destinations named after that title; the
  rest land in a `Destino inicial` destination (per campaign, runs once).

### Campaign live-testing, link health and member tracking

- `POST campaign/test-send` body `{ text }` — sends ONE real message to the
  account's Saved Messages so the content can be inspected as rendered
  (respects `linkPreviewEnabled`). Server-side cooldown: one per 15s.
  503 when the daemon is disconnected.
- `POST campaign/links/resolve` body `{ id }` — resolves a campaign link
  destination read-only (`checkChatInvite` for private invites,
  `resolveUsername` + full info for public links), storing
  title/members/type/about/stripped-photo on the link and appending a member
  snapshot. 410 when the destination is dead (recorded as `resolvedFailed`).
- `GET campaign/links/stats` — per-link send counts (SUCCESS only, total and
  last 24h from the logs) plus resolved destination info and the member
  delta between the two latest snapshots.
- Config: `memberTrackingEnabled` (default **off**) and
  `memberTrackingIntervalHours` (clamped to ≥ 4) — when enabled, the daemon
  re-checks enabled t.me links in the background, paced ~4s apart. Each
  check is read-only but is still account activity; keep it off unless the
  growth curve matters to you.

### Named campaigns & performance dashboard

- `GET campaigns` — list `{ id, name, isActive, updatedAt }`.
- `POST campaign/create` body `{ name? }` — creates an inactive empty
  campaign (default name `Campanha N`).
- `POST campaign/duplicate` body `{ id, name? }` — deep-copies templates,
  destinations and links of `id` into a new inactive campaign (link→destination
  mapping is remapped to the copy's own ids).
- `POST campaign/rename` body `{ id, name }`.
- `POST campaign/activate` body `{ id }` — single active campaign invariant;
  the scheduler picks the new content on the next send (no restart needed).
  Returns the refreshed active campaign.
- `GET campaign/performance` — pure-DB aggregates for the dashboard: per
  template attempts/successes/errors over 7 days (from `logs.template_id`),
  hourly success buckets for the last 48h, top-20 groups by attempts with
  success rate, and up to 30 member snapshots per link for growth sparklines.
