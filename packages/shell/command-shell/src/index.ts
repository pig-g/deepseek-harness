/**
 * Human-facing `/cmd` raw-shell command. Runs one shell command directly
 * through the `ctx.shell` executor, with no model turn, under the receiving
 * session's standing sandbox policy. The command result renders as a UI
 * CommandResult and never enters model history.
 * @module @deepseek-ai/dsh-command-shell
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { CollectedOutput, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** Plugin identity, matched by the Loader to its module exports. */
export const name = 'command-shell'
/** Services resolved when the command dispatches. */
export const inject = ['commands', 'shell']

const USAGE = 'Usage: /cmd <shell command>'

/** Captured-output display budget in bytes before an ellipsis marker. */
const DISPLAY_MAX = 4000

/** Whether a run's own output is both empty and untruncated. */
function isEmpty(output: CollectedOutput): boolean {
  return output.text.length === 0 && !output.truncated
}

/** Bounded display text for one captured stream, or the empty string when absent. */
function channel(label: string, output: CollectedOutput): string {
  if (isEmpty(output)) return ''
  const body = output.text.length <= DISPLAY_MAX
    ? output.text
    : `${output.text.slice(0, DISPLAY_MAX)}\n…[truncated]`
  return `${label}:\n${body}`
}

/** One-line exit fact after the captured streams. */
function exitLine(result: ShellRunResult): string {
  return result.exitCode === null
    ? `terminated by ${result.signal ?? 'signal'}`
    : `exit code: ${result.exitCode}`
}

/** Render a completed foreground run as a compact UI block. */
function renderResult(command: string, result: ShellRunResult): string {
  const lines = [`$ ${command}`]
  const stdout = channel('stdout', result.stdout)
  if (stdout !== '') lines.push(stdout)
  const stderr = channel('stderr', result.stderr)
  if (stderr !== '') lines.push(stderr)
  lines.push(exitLine(result))
  if (result.sandbox?.denied === true) {
    lines.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
  }
  return lines.join('\n')
}

/** Render the failed command line plus the throwing reason. */
function renderError(command: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return `$ ${command}\n${reason}`
}

/**
 * Resolve the receiving session's standing sandbox policy, when a policy
 * service is mounted, so the command runs under the session's own mode and
 * workspace boundary rather than the deployment default.
 * @param ctx - plugin context carrying the optional `sandboxPolicy` service.
 * @param invocation - receiving agent whose session keys the policy resolution.
 */
function sessionPolicy(ctx: Context, invocation: CommandInvocation): { sandboxPolicy?: SandboxExecutionPolicy } {
  const sandboxPolicy: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
  return sandboxPolicy === undefined
    ? {}
    : { sandboxPolicy: sandboxPolicy.resolve({ session: invocation.agent.session }) }
}

/**
 * Run one raw shell command on the receiving session's behalf.
 * @param invocation - receiving agent, raw command input, and UI cancellation.
 * @param ctx - plugin context used to read the optional sandbox policy.
 * @returns the rendered command output, or a usage/runner error result.
 */
async function executeCmd(invocation: CommandInvocation, ctx: Context): Promise<CommandResult> {
  const command = invocation.rawInput.trim()
  if (command.length === 0) {
    return { kind: 'error', text: `No shell command supplied. ${USAGE}` }
  }
  const request = {
    command,
    signal: invocation.signal,
    ...sessionPolicy(ctx, invocation),
  }
  const spec = ctx.shell.resolve(request)
  let result: ShellRunResult
  try {
    result = await ctx.shell.run(spec)
  } catch (error) {
    return { kind: 'error', text: renderError(command, error) }
  }
  return { kind: 'success', text: renderResult(command, result) }
}

/** Register the global `/cmd` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'cmd',
    description: 'run a raw shell command directly (no model turn)',
    input: { hint: '<shell command>' },
    handler: invocation => executeCmd(invocation, ctx),
  })
}
