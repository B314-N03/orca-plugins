# Uptime (Orca plugin)

Checks your deployments' health endpoints every 60 s and shows a desktop notification when one
goes down, degrades or recovers. A port of the Claude Code `uptime` mod to Orca, built against
**Orca 1.4.215** (plugin manifest v1).

## States

| State | Meaning |
| --- | --- |
| up | 2xx within 10 s, and no dependency in the JSON body reports a failure |
| degraded | 2xx, but the body reports a failing dependency (e.g. one environment of a readiness endpoint) |
| down | no 2xx (error status, timeout, connection failure) on **2 checks in a row**; one failure is treated as a blip |

For a JSON body it names the failing parts: any value `down`, `fail`, `error`, `unavailable`,
`unhealthy` or `unreachable` below the top level, e.g. `503 · database, PROD_FRA.platformMcp`.

A notification is shown on every change between up, degraded and down ("✗ staging down",
"✓ staging recovered · after 7m"). The first result after the worker starts is never announced.

## Commands (Cmd-J)

| Command | Effect |
| --- | --- |
| Uptime: Check now | Starts checking if it isn't yet, checks every deployment and shows a summary notification (`uptime 2/3 · staging ✗` plus one line per deployment) |
| Uptime: Show status | The same summary without a new check; while off, the last known results dated by their last check |
| Uptime: Turn on | Resumes checking (remembered across restarts) |
| Uptime: Turn off | No checks and no notifications, remembered across restarts |

## Install (development folder)

1. Orca → Settings → Plugins: turn plugins on.
2. Settings → Plugins → Development: add this folder's absolute path, then **Add path**.
3. Review and approve the permissions: it runs a Node worker on this machine and asks for
   *notifications* and *its own storage*.
4. Cmd-J → **Uptime: Check now**. Orca 1.4.215 starts a plugin worker only when one of its
   commands runs, so do this once after every Orca launch; the worker then keeps checking.

## Data

The deployment list, the on/off switch and the last results live in the plugin's own storage
(`~/Library/Application Support/orca/plugins-data/local.uptime/storage.json`), never in this
folder. On its first start the worker copies the list once from the Claude Code mod's store
(`~/.claude/plugins/store/uptime_inline-*.json`) if that file exists. URLs shown in
notifications or error text drop userinfo and query strings.

## What Orca 1.4.215 cannot do

- **No status bar:** there is no persistent indicator; "Show status" answers with a notification.
- **No autostart:** the worker starts on the first command after each Orca launch.
- **No add/remove:** palette commands take no arguments and panels cannot reach the worker or
  storage, so the list cannot be edited from Orca's UI. It is seeded from the mod.
- **No panel:** a panel cannot read the worker's results (no bridge, `connect-src 'none'`).

Orca 1.4.248+ adds status bar items, workers that run while the plugin is enabled, and panels
that talk to their worker, which cover all four (manifest v2).

## Development

```bash
npm ci
npm run ci     # tsc --noEmit + node --test
```

Orca runs `src/worker.ts` as written (its worker runtime is Node 24 with type stripping); there
is no build step. Logic lives in pure modules (`logic`, `present`, `probe`, `seed`, `url`), the
worker behaviour in `uptime.ts` with injected I/O, and `worker.ts` only wires Orca to it.
