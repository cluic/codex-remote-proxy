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
| Proxy worker | Use the active snapshot captured once per request | Read registry or other provider keys | Receives least-privilege configuration |
| Remote network client | Nothing | Access UI, API, or proxy management | Admin server is loopback-only |

## Audit Requirements

Record provider creation/update/deletion, test result, activation, Codex bootstrap, lifecycle commands, migration, credential fallback choice, and diagnostic export. Store stable IDs and sanitized error codes, never secret values.

## Security Requirements

- Prefer native credential stores.
- Native credential entries use service `org.cluic.codex-remote-proxy` and opaque credential references; the addon loads only during adapter construction, and adapters expose no enumeration API.
- File credential fallback must never be selected without explicit consent.
- Explicit consent permits file selection only when native construction fails before any credential operation; once native is selected, operation failures are returned without replaying reads or mutations into file storage.
- File fallback requires a real `0700` parent and regular `0600` file on POSIX, opens with no-follow protection where supported, verifies descriptor identity, and reads secret bytes only through that descriptor.
- File fallback holds an exclusive protocol gate and canonical primary lock across the complete mutation. Release atomically claims the canonical gate to a unique path and deletes only an ownership-verified claim, never the canonical path. The primary lock remains canonical until gate ownership or an exclusive canonical `mkdir`/`EEXIST` blocker is proven; if neither can be proven, the primary path is retained. A competing instance may briefly own the canonical gate during validation, but its primary acquisition must report busy and its cleanup must not touch the original claim.
- A secret-bearing temporary file that cannot be removed after bounded retries degrades the instance, reports `CREDENTIAL_STORE_TEMP_DEGRADED`, and blocks later mutations before they open a new lock.
- Set metadata, token, state, and fallback secret files to `0600` where supported.
- Never accept sensitive keys inside `extraHeaders`; use the credential field.
- Redact authorization, cookie, token, secret, and API-key headers and fields.
- Redact the exact active authentication header before debug logging or capture persistence; short secrets must never be emitted unchanged.
- Validate parent-child IPC with exact directional version-1 schemas, HTTPS-or-loopback URL rules, HTTP-token authentication fields, Node-compatible final authentication values, and case-insensitive sensitive/authentication-header collision rejection. Resolved credentials may cross the process boundary only inside a parent `configure` message; child lifecycle/fatal messages, sanitizers, stdout, and stderr must never echo settings, causes, complete secrets, or an unvalidated request ID.
- Validate every child message before lifecycle use, correlate acknowledgements to the current request and child epoch, and expose worker-manager status only through its positive allowlist.
- Reject non-loopback admin binds.
- Validate URL scheme and block accidental credential forwarding to an unvalidated target.
- Treat diagnostics and capture content as sensitive local data.

## Credential Verification Boundary

Task 4 unit tests inject a native entry loader and never invoke the default addon loader or construct or query a real Keychain, Credential Manager, or Linux secret-service entry. Real native-backend verification remains an L3 platform gate on every supported system, including Windows and Linux.

## Security Risks

Credential migration, localhost browser attacks, log leakage, symlink/path attacks, and worker IPC spoofing make the first implementation an L3 merge-risk change.
