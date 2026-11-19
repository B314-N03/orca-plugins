# Uptime (Orca plugin)

Checks your deployments' health endpoints every 60 s. It shows the result in Orca's status bar
and in a panel, and sends a desktop notification when a deployment goes down, degrades or
recovers. This is a port of the Claude Code `uptime` mod to Orca. It is built against
**Orca ≥ 1.4.248** (plugin manifest format 2, docs at tag `v1.4.263`).

## States

| State | Meaning |
| --- | --- |
| up | 2xx within 10 s, and no dependency in the JSON body reports a failure |
| degraded | 2xx, but the body reports a failing dependency (for example, one environment of a readiness endpoint) |
| down | no 2xx (error status, timeout, connection failure) on **2 checks in a row**; a single failure counts as a blip |

When the body is JSON, the plugin names the failing parts. These are any values of `down`,
`fail`, `error`, `unavailable`, `unhealthy` or `unreachable` below the top level, for example
`503 · database, PROD_FRA.platformMcp`.

A notification appears on every change between up, degraded and down ("✗ staging down",
"✓ staging recovered · after 7m"). The first result after the worker starts is never announced.

## Where it shows up

| Surface | What it shows |
| --- | --- |
| Status bar | `uptime 3/3 ✓` or `uptime 2/3 · staging ✗`, coloured by the worst state. The tooltip lists the problems. Pressing it runs **Check now**. It is hidden while uptime is off. |
| Panel "Uptime" | One card per deployment: state and how long it has held, status code or reason, latency, failing dependencies, a sparkline of the last 30 checks, and the URL. Also a remove button per card, **Check now**, an on/off switch, and a form to add a deployment (re-adding a name replaces its URL). |
| Commands (Cmd-J) | **Check now**, **Show status** (the status line plus one line per deployment), **Turn on**, **Turn off**. Each answers with text. |

The worker starts when the plugin is enabled and keeps checking while Orca runs. Turning it off
is remembered across restarts.

## Install (development folder, Orca ≥ 1.4.248)

```bash
P=/path/to/orca-plugins/uptime
orca plugin system on                  # or Settings → Plugins → on
orca plugin types "$P"                 # writes .orca/types (gitignored), used by tsc
orca plugin validate "$P" --json
orca plugin test "$P"                  # every *.test.ts(x), including the orca/testing ones
orca plugin check "$P"                 # renders the panel per src/panel.check.ts scenario
orca plugin dev load "$P"              # exit 3: prints the permission fingerprint
orca plugin dev load "$P" --approve <fingerprint>
```

The permission review should show the following:

- a trusted worker: Node on this machine, the same access as the Orca app
- *show notifications*
- *its own storage*

Nothing else should be listed.

## Data

The plugin's own storage holds the deployment list, the on/off switch and the last results.
None of them are kept in this folder. On its first start, the worker copies the list once from
the Claude Code mod's store (`~/.claude/plugins/store/uptime_inline-*.json`), if that file
exists. It copies only the list, so the plugin always starts on. URLs that reach the panel,
command output or error text have their userinfo, query string and fragment removed.

## Development

```bash
npm ci
orca plugin types .   # once: tsconfig.json extends .orca/types/tsconfig.json
npm run ci            # tsc --noEmit + node --test test/  (core, manifest, view)
orca plugin test .    # the above plus src/*.test.ts(x) on Orca's mock host
```

There is no build step. Orca transpiles `src/worker.ts` and `src/panel.tsx` itself. The code is
split into four layers:

- **Pure logic:** `logic`, `present`, `view`, `probe`, `seed` and `url`.
- **Worker behaviour:** `uptime.ts` holds it, with storage, notifications, publishing, fetch and
  timers injected as ports.
- **Wiring:** `worker.ts` only connects Orca's worker API to those ports. `panel.tsx` only draws
  the snapshot the worker serves.
- **Protocol:** `protocol.ts` declares the panel↔worker requests and events once, for both sides.

The version for Orca 1.4.215 (manifest v1, command-started worker, notifications only) is in
history at `a42cf2a`.
