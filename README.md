# oc-resume

An OpenCode plugin that adds a `/resume` command: reload the last session and continue it.

## Usage

```text
/resume
/resume My custom continue command here
```

- `/resume` reloads the most recent session (excluding the one you run it from) and sends it `Continue`.
- `/resume <text>` reloads the most recent session and sends it `<text>` instead.
- When a TUI is attached, it also navigates to the resumed session and shows a toast.

## How it works

Plugin source: `.opencode/plugin/resume.ts` (project plugin, auto-loaded at startup).

- `config` hook registers the `resume` slash command (template takes `$ARGUMENTS`).
- `resume` tool performs the reload: `session.list` → pick last (excluding current, preferring root sessions like `opencode run --continue`) → `session.promptAsync` → best-effort TUI switch + toast.
- `command.execute.before` hook intercepts `/resume` so the reload happens even before the LLM runs, then rewrites the command parts to a short acknowledgement (no double tool call).

## Install

This repo is already set up as the plugin: cloning it (or copying `.opencode/plugin/resume.ts` into your project) is enough. Project plugins under `.opencode/plugin/` / `.opencode/plugins/` are auto-discovered. Restart opencode after adding or changing the plugin; running sessions keep using the already-loaded config.
