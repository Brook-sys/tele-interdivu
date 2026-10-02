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
`status` may be `READY`, `WAITING_SLOWMODE`, `WAITING_MESSAGES`, `BLOCKED`, `STARS` — the daemon quarantines `STARS`/`BLOCKED` and re-probes them automatically every 30 min.

### Configuration

| Method | Path | Description |
|---|---|---|
| GET | `config` | Current config. |
| POST | `config` | Partial update. Fields: `mode` (`manual`/`continuous`), `minDelaySeconds`, `maxDelaySeconds`, `roundIntervalMinutes`, `roundTargetSends`, `minOtherMessages`, `minResendIntervalMinutes`, `sleepWindowEnabled`, `sleepWindowStart` (`HH:MM`, container TZ), `sleepWindowEnd`, `dailyLimit` (sliding 24h), `linkPreviewEnabled`, `microPauseEnabled`, `microPauseEveryMin`, `microPauseEveryMax`, `microPauseSeconds`. |

### Campaign

| Method | Path | Description |
|---|---|---|
| GET | `campaign` | Current spintax template + links. |
| POST | `campaign` | `{ spintaxTemplate, links }` — validated before saving. |
| POST | `test-spintax` | `{ template, links }` → 5 rendered previews, nothing is sent. |

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

# each additional account container
environment:
  NODE_ROLE: worker
  WORKER_ID: worker-2
  MASTER_URL: http://<master-host>/            # internal docker network
  WORKER_API_URL: http://<worker-host>/        # how the master reaches it (display/proxy actions)
  ORCHESTRATOR_TOKEN: "shared-secret"
```

- Workers register + heartbeat every 15s (sending their group list + status);
  the master pushes the centralized config + campaign in the response, so
  editing config on the master propagates to every account automatically,
  and round targets are rebalanced acrossalive workers.
- Before every send the worker claims a global per-group slot
  (`POST /api/v1/orchestrator/claim`); the master interleaves accounts by
  oldest last-grant and enforces a shared per-group cooldown. Stars/blocked
  reports quarantine the group globally for all workers.
- If the master is unreachable, workers switch to degraded mode: they keep
  sending standalone (previous interleaving offsets persist per account) and
  rejoin automatically.
- Panel: "Orquestração" in the side menu (workers show a hint instead).
- Endpoints (master only): `GET info`, `GET workers`, `DELETE workers?workerId=`,
  `GET grants?limit=`, `POST register|heartbeat|claim|report`.
