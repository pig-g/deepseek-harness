# Agent Note: Optional serving of the privileged plane to trusted hosts

Status: implemented

## Problem

The `/api` trust fence (`dsh-client-connection`) pins a privileged method set to
loopback unconditionally: `PRIVILEGED_METHODS` (`settings.*`, `credentials.*`,
`agentPreset.read/copy/openDocument/remove`, `host.pickDirectory`,
`host.openPath`, `llm.discoverModels`) is checked with an *empty* trust list, so
a deployment that binds `--host 0.0.0.0` and walls its reachable surface (a
firewall, or a VPN whose members arrive over `tun`/`utun`) still cannot let a
trusted LAN/VPN peer open the provider directory or edit settings — the GUI
loads, but `settings.describe` and `llm.discoverModels` answer 403 with
"transport failure for /api/settings.describe: HTTP 403". The fence already
trusts those peers for every non-privileged method (the Web runtime auto-derives
all non-internal IPv4 literals, `tun`/`utun` included, into `trustedHosts`), so
the privileged pin is the sole remaining gate.

## Decision

Add an opt-in, default-off switch that serves the privileged plane to any
authority that can reach the port, instead of loopback only:

- `ConnectionConfig.servePrivilegedToTrustedHosts` (default `false`) drops the
  Host pin for the whole `/api` fence (route, WebSocket, and privileged check),
  so the flag alone is the whole trust grant for the deployment — no
  `trustedHosts` listing is required. Only the browser-marker fences (a
  `sec-fetch-site: cross-site` marker or a foreign `Origin`) still refuse.
- The CLI surfaces it as `dsh web --allow-privileged-remote`, threaded
  `webStartup` → `web-app` runtime → `dsh-client-connection` config in the
  `web-app` bundle patch.
- **Client-side persistence gate (upstream rebase port):** the rebased upstream
  base independently disables settings for non-loopback browsers — the
  `ui-settings` mirror picks `memory` (settings unavailable) from
  `connection.isLoopback`, so the fence fix alone still leaves a remote browser
  unable to edit the provider directory. The browser-half connection handle
  therefore exposes `privilegedAvailable` = loopback **or**
  `servePrivilegedToTrustedHosts`, and `ui-settings` gates its `'host'`/
  `'memory'` persistence on that instead of `isLoopback`.

This is a whole-grant for private internal use, per the operator's explicit
choice: anyone who can reach the port gets the configuration plane when the
switch is on. The default (loopback-only) is unchanged, so no deployment
regresses unless it opts in.

## Alternatives considered

- **Always use `trustedHosts` for privileged methods.** Rejected: silently
  widens the security posture of every existing `0.0.0.0` deployment without an
explicit decision, contradicting the "fail loud / no silent widening"
convention; the pin exists because there is no authentication layer.
- **Add full authentication.** The correct long-term answer, but real product
  surface (tokens, storage, rotation); the opt-in keeps today's VPN/firewall
  deployments usable without pre-deciding an auth design. Deferred work.

## Consequences

- `--host 0.0.0.0` serves ordinary reads without opt-in but 403s the
  configuration plane; with `--allow-privileged-remote` it serves
  settings/credentials/presets and model discovery to any authority that can
  reach the port — no `trusted-host` or LAN listing needed.
- This is a whole-grant, not authentication: any peer able to reach the port
  could read (redacted) config and change settings. That remains explicitly
  documented as out of scope until an auth layer lands; the flag exists for a
  private internal/LAN surface the operator is willing to trust as a unit.
- Partially supersedes the loopback-pin aspect of the api-browser-trust-boundary
decision; the carrier fences themselves (DNS-rebinding and cross-site markers)
are unchanged and still apply to every request.
