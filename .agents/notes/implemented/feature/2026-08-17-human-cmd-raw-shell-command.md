# Agent Note: Human `/cmd` raw-shell command

Status: implemented

## Problem

The Web UI's only reserved input syntax is the slash-command plane. Every known slash command (`/plan`, `/goal`, `/feedback`, `/export`, `/compact`) is a fixed, host-registered handler that either mutates a domain or runs a bounded utility — none of them lets a person run an arbitrary shell command without routing through a model turn. Users coming from CLI agents that support a `!command` escape hatch expect a way to run a quick command directly. Earlier dialogue established the invocation as `/cmd <shell command>` and the safety posture as **run under the session's standing sandbox policy**, with no per-command approval and no auto-escalation.

## Decision

`@deepseek-ai/dsh-command-shell` registers one global `/cmd` command through `ctx.commands`. Its handler trims the raw input, resolves the receiving session's sandbox policy via `ctx.sandboxPolicy` (when mounted), and runs the command through the `ctx.shell` executor (`ctx.shell.resolve` → `ctx.shell.run`), passing the invocation's abort signal. The rendered `CommandResult` carries the command line, captured stdout/stderr (each stream truncated at 4000 bytes), the exit fact (code or signal), and a sandbox-denial marker when `result.sandbox.denied` is set. A thrown runner (e.g. `SandboxUnavailableError`) settles as `kind: 'error'`.

`/cmd` is deliberately minimal and safe:

- **Standing policy only, no escalation.** The handler passes the session's resolved `SandboxExecutionPolicy` to the executor, so a command that leaves the workspace is denied exactly like a model-driven `bash` call. There is no approval prompt and no `sandbox_permissions`/`justification` pair — the human typed the command explicitly, and the standing policy is the gate. Denials are reported in the result.
- **No model turn.** The command input and output never enter model requests, `deriveMessages()`, or the ordered surface; they ride the command adapter's log-only `command/run`/`command/done` pairing plus the detached UI result.
- **Foreground only.** No `run_in_background`; a long command blocks until the executor's timeout. Background work stays with the model-driven `bash` tool.

The command name `cmd` is a plain `[a-z]` name, so it needs **no change to the shared `parseCommand`/`COMMAND_NAME` grammar** and nothing in the client command surface — the Web client already dispatches host commands with an `input` hint as leading-input claims (the same path `/plan`/`/goal` use). The base bundle mounts the plugin on non-Windows hosts (it is bash-only, gated identically to `tool-bash`); the plugin injects `commands` and `shell`, and reads the optional `sandboxPolicy` via `ctx.get` so it works in compositions without a policy service.

The new package lives at `packages/shell/command-shell/`, registered in `tsconfig.host.json`, with its own invariant companion (`@deepseek-ai/dsh-command-shell/invariant`).

## Alternatives considered

**Extend the shared parser to accept a `!` singleton command name.** Not taken: the chosen invocation is `/cmd`, a normal valid command name, so the shared `dsh-commands` grammar (used by every command adapter) stays untouched and blast radius is limited to the new package, its bundle row, and its dependency edges. This was the earlier proposal; the user's `/cmd` preference removed the shared-code change.

**Bare `!ls` (no leading slash).** Not taken: it would require special-casing the client input trigger outside the command plane, which contradicts the `everything-is-a-plugin` slot model and the single deterministic command path.

**Prompt for approval before every raw command, or run with full access.** Not taken: per-command approval interrupts the CLI-like flow the feature is for, and full access contradicts the repo's sandbox-first stance. Standing-policy execution is the recommended option from the design question.

**Reuse the model-facing `bash` tool instead of `ctx.shell` directly.** Not taken: the tool layer is ToolExecution-shaped (approval, escalation, background jobs) and is not a fit for a no-turn user command; the handler targets the executor seam directly.

## Consequences

- **Safety:** `/cmd` bypasses the model, so nothing in the command is interpreted or gated by an agent. Its safety is the standing sandbox policy alone. Deployments that want per-command prompts must not expose it.
- **Coverage:** `packages/shell/command-shell/src/*` is at 100% statement/branch/function/line coverage via a controllable fake `shell` executor plus a real Loader composition that boots `dsh-bash-local` and runs an actual `/cmd printf`.
- **Composition:** the base bundle row `command-shell` is win32-disabled; the web profile inherits it from base (bash-sandbox/sandbox-policy remain host-plane there, so the handler resolves both).
- **Docs:** bilingual README with the canonical Model Experience section; invariant companion registered with a justified empty installer.

### Follow-ups

- Bilingual Agent Note translation and any `doc-sync` gates are generator-owned and run on explicit invocation.
- Making the running GUI at `http://127.0.0.1:3080` serve the new command requires restarting the host server whose base bundle is composed from this checkout.
