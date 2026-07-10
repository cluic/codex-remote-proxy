# Permissions and Security

## Roles

The MVP has one role: the local operating-system user. It has no accounts, remote users, or administrator delegation.

## Sensitive Actions

- Store, replace, or delete an API key.
- Activate a provider.
- Patch Codex configuration.
- Start, stop, or restart the proxy worker.
- Change listening ports or credential backend.
- Export diagnostics.

## Access Matrix

| Actor | Can Do | Cannot Do | Notes |
| --- | --- | --- | --- |
| Authenticated local UI session | Manage providers and worker | Read complete keys; bind remote interfaces | CSRF and origin checks required |
| Local CLI with control token | Same management actions | Read complete keys | Designed for automation |
| Proxy worker | Use active snapshot | Read registry or other provider keys | Receives least-privilege configuration |
| Remote network client | Nothing | Access UI, API, or proxy management | Admin server is loopback-only |

## Audit Requirements

Record provider creation/update/deletion, test result, activation, Codex bootstrap, lifecycle commands, migration, credential fallback choice, and diagnostic export. Store stable IDs and sanitized error codes, never secret values.

## Security Requirements

- Prefer native credential stores.
- Set metadata, token, state, and fallback secret files to `0600` where supported.
- Never accept sensitive keys inside `extraHeaders`; use the credential field.
- Redact authorization, cookie, token, secret, and API-key headers and fields.
- Reject non-loopback admin binds.
- Validate URL scheme and block accidental credential forwarding to an unvalidated target.
- Treat diagnostics and capture content as sensitive local data.

## Security Risks

Credential migration, localhost browser attacks, log leakage, symlink/path attacks, and worker IPC spoofing make the first implementation an L3 merge-risk change.
