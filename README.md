# orca-plugins

Plugins for [Orca](https://github.com/stablyai/orca), one folder per plugin.

| Plugin | What it does | Orca |
| --- | --- | --- |
| [`uptime`](uptime/) | Checks your deployments' health endpoints every 60 s: a status bar item, a panel with history and add/remove, and a notification when one goes down, degrades or recovers. | ≥ 1.4.248 |

## Use one

Each plugin folder is a self-contained Orca development folder:

```bash
orca plugin system on
orca plugin dev load /path/to/orca-plugins/<plugin>              # prints the permission review
orca plugin dev load /path/to/orca-plugins/<plugin> --approve <fingerprint>
```

Read a plugin's own README before approving — it lists exactly which access the plugin asks for and why.
