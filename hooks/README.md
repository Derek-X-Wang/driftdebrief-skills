# hooks/

`stop-hook.settings.json` is a **copy-paste fragment for your own `.claude/settings.json`** — it is *not* a plugin hook (there is no `hooks/hooks.json` here on purpose).

DriftDebrief's per-turn EMIT relies on the Claude Code **`Stop`** hook. Plugin-defined hooks are unreliable upstream (claude-code [#16538](https://github.com/anthropics/claude-code/issues/16538), closed `NOT_PLANNED`; "plugin hooks don't execute at all"), and `SessionStart` `additionalContext` is dropped on new sessions ([#10373](https://github.com/anthropics/claude-code/issues/10373)). So the load-bearing hook must live in **`settings.json`**, where it reliably fires — not in the plugin.

Merge the `Stop` block from `stop-hook.settings.json` into your project `.claude/settings.json` (or `~/.claude/settings.json`). If you cloned this repo instead of installing the published package, replace `bunx @driftdebrief/skills stop-hook` with `bun /absolute/path/to/driftdebrief-skills/src/cli.ts stop-hook` — or just run `bun src/cli.ts install` to print the exact command with the path filled in.
