/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-command-shell`.
 * @module @deepseek-ai/dsh-command-shell/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-command-shell'

/** Cordis companion plugin name. */
export const name = 'command-shell-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: each `/cmd` run is an independent pass-through with
 * the command's outcome rendered and durably logged by the command adapter; a
 * failed run leaves the same log-only `command/done` pairing as a success.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
