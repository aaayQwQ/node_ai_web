# Security policy

## Current deployment boundary

Until the remaining security work is complete, Node AI Web should be treated as a
single-user, local-first application. Keep it bound to `127.0.0.1`. Do not expose
it directly to the public internet or use it as a multi-user gateway.

## Current fail-closed controls

- Non-loopback binding requires a configured web password.
- Cross-origin preflight requests are rejected; wildcard CORS is not enabled.
- Request bodies have endpoint-specific size limits.
- Runtime configuration, history, and logs are written with restrictive file modes
  where the operating system supports POSIX permissions.
- Upstream and MCP HTTP requests validate DNS answers and reject private, loopback,
  link-local, and reserved IP ranges by default.
- Private/local upstream access requires the explicit
  `NODE_AI_WEB_ALLOW_PRIVATE_UPSTREAM=true` environment opt-in.
- MCP Stdio is disabled unless `NODE_AI_WEB_ALLOW_STDIO_MCP=true` and the executable
  is listed in `NODE_AI_WEB_STDIO_ALLOWLIST`.
- Plugins are not loaded unless their IDs are listed in
  `NODE_AI_WEB_TRUSTED_PLUGINS`. Node's `vm` module is not a security sandbox.
- MCP tool execution is disabled unless `NODE_AI_WEB_ALLOW_MCP_CALLS=true`, global
  auto-approval is enabled, and the individual MCP server is configured for auto
  approval. Server-side per-call approval tokens are not yet implemented.

## Secrets and privacy

Do not commit runtime configuration, history, logs, API keys, passwords, or MCP
credentials. The application still uses a shared web password and stores provider
credentials in its local configuration; this is not equivalent to encrypted
secret storage or short-lived user sessions. Protect the host account and backup
files accordingly.

## Reporting

Report suspected vulnerabilities privately to the repository maintainer. Include
the affected version/commit, reproduction steps, and impact. Do not publish
credentials or personal data in an issue.
