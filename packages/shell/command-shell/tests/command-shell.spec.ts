import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as CommandShell from '@deepseek-ai/dsh-command-shell'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly shell: FakeShell
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build a live idle agent over a store-owned session, as an app's spine does. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** Controllable `shell` executor returning a scripted result and recording specs. */
class FakeShell extends ShellExecutor {
  readonly seen: ShellExecSpec[] = []
  script: (spec: ShellExecSpec) => ShellRunResult | Promise<ShellRunResult>

  constructor(ctx: Context, script: (spec: ShellExecSpec) => ShellRunResult | Promise<ShellRunResult>) {
    super(ctx)
    this.script = script
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const spec: ShellExecSpec = {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: 65_536,
      ...request.signal === undefined ? {} : { signal: request.signal },
      sandboxPolicy: request.sandboxPolicy,
    }
    this.seen.push(spec)
    return spec
  }

  override run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return Promise.resolve(this.script(spec))
  }

  override start(): ShellProcess {
    throw new Error('unused')
  }
}

/** Minimal sandbox-policy service exposing the session-keyed resolve the command reads. */
class FakePolicy extends Service {
  resolve(request: { session?: { id: string } } = {}): { mode: 'workspace-write'; workspaceRoot: string; sessionId?: string } {
    return {
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      ...request.session === undefined ? {} : { sessionId: request.session.id },
    }
  }
}

function collected(text: string, truncated = false) {
  return { text, truncated }
}

function result(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 60_000,
    stdout: collected(''),
    stderr: collected(''),
    ...overrides,
  }
}

/** Mount the real command registry and producer over one idle agent. */
async function harness(withPolicy = false): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const shell = new FakeShell(ctx, vi.fn(() => result({ stdout: collected('ok') })))
  if (withPolicy) new FakePolicy(ctx, 'sandboxPolicy')
  const plugin = await ctx.plugin(CommandShell)
  const { agent, session } = stubAgent(ctx, `command-shell-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, shell, plugin }
}

/** Execute `/cmd ...` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>['result']> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/cmd${suffix}`,
    [],
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('cmd command was not registered')
  return execution.result
}

describe('@deepseek-ai/dsh-command-shell registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(CommandShell.name).toBe('command-shell')
    expect(CommandShell.inject).toEqual(['commands', 'shell'])
    expect('default' in CommandShell).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(CommandShell)).toBe(CommandShell)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'cmd',
      description: 'run a raw shell command directly (no model turn)',
      input: { hint: '<shell command>' },
    })
    expect(test.ctx.commands.find(test.agent, 'cmd')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'cmd')).toBeUndefined()
  })
})

describe('/cmd human command', () => {
  it('runs the shell command and renders stdout, stderr, and exit code', async () => {
    const test = await harness()
    test.shell.script = vi.fn(() => result({
      exitCode: 3,
      stdout: collected('out line'),
      stderr: collected('err line'),
    }))
    await expect(run(test, "  sh -c 'echo out; echo err >&2; exit 3' ")).resolves.toEqual({
      kind: 'success',
      text: "$ sh -c 'echo out; echo err >&2; exit 3'\nstdout:\nout line\nstderr:\nerr line\nexit code: 3",
    })
    expect(test.shell.seen[0]?.command).toBe("sh -c 'echo out; echo err >&2; exit 3'")
    expect(test.session.events.map(event => event.type)).toEqual(['command/run', 'command/done'])
  })

  it('reports an empty command as a usage error without touching the executor', async () => {
    const test = await harness()
    await expect(run(test)).resolves.toEqual({
      kind: 'error',
      text: 'No shell command supplied. Usage: /cmd <shell command>',
    })
    expect(test.shell.seen).toEqual([])
    await expect(run(test, '   \n\t  ')).resolves.toEqual({
      kind: 'error',
      text: 'No shell command supplied. Usage: /cmd <shell command>',
    })
  })

  it('omits empty streams, renders a signal death, and flags a sandbox denial', async () => {
    const test = await harness()
    test.shell.script = vi.fn(() => result({
      exitCode: null,
      signal: 'SIGKILL',
      sandbox: { mode: 'workspace-write', denied: true },
    }))
    await expect(run(test, ' sleep')).resolves.toEqual({
      kind: 'success',
      text: '$ sleep\nterminated by SIGKILL\n[sandbox: file access denied under workspace-write mode]',
    })
  })

  it('renders an unsignalled death and truncates oversized output with ellipsis', async () => {
    const test = await harness()
    test.shell.script = vi.fn(() => result({
      exitCode: null,
      signal: null,
      stdout: collected('x'.repeat(5000), true),
    }))
    await expect(run(test, ' big')).resolves.toEqual({
      kind: 'success',
      text: '$ big\nstdout:\n' + 'x'.repeat(4000) + '\n…[truncated]\nterminated by signal',
    })
  })

  it('surfaces a throwing runner as an error result for Error and non-Error reasons', async () => {
    const error = await harness()
    error.shell.script = vi.fn(() => { throw new Error('runner boom') })
    await expect(run(error, ' fail')).resolves.toEqual({ kind: 'error', text: '$ fail\nrunner boom' })

    const thrown = await harness()
    // A non-Error thrown value is rendered via String().
    thrown.shell.script = vi.fn(() => { throw 'plain reason' })
    await expect(run(thrown, ' fail')).resolves.toEqual({ kind: 'error', text: '$ fail\nplain reason' })
  })

  it('omits the sandbox policy without a policy service and carries the session policy when one is mounted', async () => {
    const bare = await harness(false)
    await run(bare, ' ls')
    expect(bare.shell.seen[0]?.sandboxPolicy).toBeUndefined()

    const within = await harness(true)
    await run(within, ' ls')
    expect(within.shell.seen[0]?.sandboxPolicy).toMatchObject({ sessionId: within.session.id })
  })
})
