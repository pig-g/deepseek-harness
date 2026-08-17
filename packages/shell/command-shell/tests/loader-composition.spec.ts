import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as CommandShell from '@deepseek-ai/dsh-command-shell'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Register one idle agent over a store-owned session, as an app's spine does. */
function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('command-shell-loader-agent')
  const session = ctx.sessions.create(id)
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const value: Agent = {
    id,
    options: {},
    session,
    inbox,
    ctx: scope.ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

describe('/cmd real Loader composition through cordis.yml on POSIX', () => {
  it.skipIf(process.platform === 'win32')('boots cordis.yml and runs a raw shell command without model-visible output', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-shell-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-bash-local'",
      "- name: '@deepseek-ai/dsh-command-shell'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-bash-local', LocalBashExecutor],
      ['@deepseek-ai/dsh-command-shell', CommandShell],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = agent(context)
    const signal = new AbortController().signal

    // Discoverable through the composed registry, as a UI adapter finds it.
    expect(context.commands.list(owner).map(command => command.name)).toContain('cmd')

    const executed = await context.commands.execute(owner, '/cmd printf hi-raw', signal)
    expect(executed?.result).toEqual({
      kind: 'success',
      text: '$ printf hi-raw\nstdout:\nhi-raw\nexit code: 0',
    })

    // The command result renders as a UI result; nothing reached the model.
    expect(owner.session.deriveMessages()).toEqual([])
    expect(owner.session.events.map(event => event.type)).toEqual(['command/run', 'command/done'])
  })
})
