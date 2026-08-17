# @deepseek-ai/dsh-command-shell

English | [中文](README.zh.md)

Human-facing `/cmd` raw-shell command over the [`ctx.shell`](../../shell/shell/README.md) executor seam.
Its plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so
every composed command adapter discovers it; the shipped Web client executes it as a leading-input
slash command without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/cmd <shell command>` | Run one shell command and render its captured stdout, stderr, and exit fact. |
| `/cmd` | Return a direct usage error. Whitespace-only input is treated as empty. |

Surrounding whitespace is discarded; the remaining text is passed verbatim to the executor. The
command runs in the receiving session's working directory under the session's standing sandbox
policy and observes a nonzero exit, a signal death, a timeout, or a sandbox denial as a normal
outcome — `command/done` settles with the rendered text as `kind: 'success'`. Only a run that
throws before producing a result (for example an unavailable sandbox runner) settles as
`kind: 'error'`.

## Safety posture

`/cmd` is a raw shell escape hatch: it bypasses the model, so nothing in the command is interpreted,
summarized, or gated by an agent. It is therefore intentionally conservative:

- **Runs under the session's standing sandbox policy.** The handler resolves the receiving
  session's policy through [`ctx.sandboxPolicy`](../../sandbox/sandbox-policy/README.md) (its mode
  and workspace boundary) and passes it to the executor, so a command that writes outside the
  workshop is denied exactly as a model-driven tool call would be. No policy service, no escalation
  is offered: there is no approval prompt and no wider mode. A denial is reported in the result.
- **No per-command approval.** The human typed the command explicitly; the standing policy is the
  gate. Deployments that want a per-command prompt must not expose this command.
- **No model turn.** The command and its output never enter model requests, `deriveMessages()`, or
  the surface — they are log-only `command/run` / `command/done` bookkeeping plus the rendered UI
  result.

## Model Experience

### Human `/cmd` capture

#### What the model sees

Nothing. The slash input, the executed command, and the rendered output are absent from model
requests. The command lifecycle events are log-only and carry no `surfaceOp`, so they never reach
`deriveMessages()` or a system prompt. Running `/cmd` during a turn does not change that turn's
remaining requests.

#### Token effect

Zero direct token effect. Neither a completed run nor a usage error adds model tokens.

#### KV Cache effect

Independent of the model request path. The command writes nothing into the provider request, so an
already-reusable request prefix is untouched.

## Composition

The producer injects `commands` and `shell`; it reads the optional `sandboxPolicy` service through
`ctx.get`. A custom app mounts the registry, a shell executor, and this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
- id: command-shell
  name: '@deepseek-ai/dsh-command-shell'
```

The shipped `dsh` base mounts this command on non-Windows hosts (it is bash-only, so it follows
`tool-bash`'s win32 gating); it has no configuration. The Web client exposes it through the command
adapter; headless mode, ACP automation, and JSON-RPC do not provide a command adapter, so they do
not expose it.

## Known Limitations and Deferred Work

- **No escalation path** — a command the standing sandbox denies is reported as a denial, with no
  approval prompt or wider-mode retry. The model-facing bash tool owns escalation; this raw command
  deliberately does not.
- **Capture caps inherited from the executor** — long output is bounded by the executor's output
  budget and further truncated at 4000 bytes per stream in the rendered result, so very chatty
  commands show a tail marker, not the full stream.
- **Background execution unavailable** — `/cmd` runs foreground only; a long-running command blocks
  the command call until the executor's timeout. Use the model-driven bash tool for background jobs.
- **Web only among the shipped entry points** — headless, ACP, and JSON-RPC provide no command
  adapter, so `/cmd` is unavailable there.
