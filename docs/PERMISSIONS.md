# Permissions and Security

## Roles

The MVP has one role: the local operating-system user. It has no accounts, remote users, or administrator delegation.

## Sensitive Actions

- Store, replace, or delete an API key.
- Activate a provider.
- Patch Codex configuration.
- Start, stop, or restart the proxy worker.
- Generate in-memory diagnostic summary metadata.

## Access Matrix

| Actor | Can Do | Cannot Do | Notes |
| --- | --- | --- | --- |
| Authenticated local UI session launched with a current fragment | Manage providers and worker | Read complete keys; bind remote interfaces | CSRF and origin checks required |
| Valid-cookie UI reload without a fragment | Read status, providers, activity, and settings | Perform any mutation | GET-only until reopened with `crp ui` |
| Local CLI with control token | UI/init launch, status/lifecycle, provider list/add/test/activate/delete, and documented compatibility commands | Read complete keys; update providers; call Activity, Settings, or diagnostics as CLI commands | Designed for bounded automation |
| Proxy worker | Use the active snapshot captured once per request | Read registry or other provider entries through CRP APIs | IPC receives only the selected credential; general inherited-environment minimization remains pending L3 hardening |
| Remote network client | Nothing | Access UI, API, or proxy management | Admin server is loopback-only |

## Audit Requirements

Activity records only implemented events: provider creation/update/deletion/test/activation, proxy start/stop/restart, and legacy migration outcomes. Store stable IDs and sanitized error codes, never secret values. Codex bootstrap and diagnostic-summary generation do not currently append Activity events.

## Security Requirements

- The public Supervisor requires the native credential store and fails closed when it cannot be constructed or used.
- Native credential entries use service `org.cluic.codex-remote-proxy` and opaque credential references; the addon loads only during adapter construction, and adapters expose no enumeration API.
- The UI, CLI, Admin API, and ordinary Supervisor startup expose no file-backend selection or consent control.
- The lower-level private file adapter is reachable only through trusted dependency injection. Any future public startup-consent path is L3 work; native failures must never replay into that adapter.
- Set metadata, token, and state files to `0600` where supported.
- A clean-home Codex bootstrap must create the real `.codex` parent as `0700` and `config.toml` as `0600` on POSIX, reject unsafe/replaced parents or targets, create no nonexistent-source backup, and expose only stable `CODEX_CONFIG_*` errors.
- Never accept sensitive keys inside `extraHeaders`; use the credential field.
- Redact authorization, cookie, token, secret, and API-key headers and fields.
- Redact the exact active authentication header before debug logging or capture persistence; short secrets must never be emitted unchanged.
- Validate parent-child IPC with exact directional version-1 schemas, HTTPS-or-loopback URL rules, HTTP-token authentication fields, Node-compatible final authentication values, and case-insensitive sensitive/authentication-header collision rejection. Resolved credentials may cross the process boundary only inside a parent `configure` message; child lifecycle/fatal messages, sanitizers, stdout, and stderr must never echo settings, causes, complete secrets, or an unvalidated request ID.
- Validate every child message before lifecycle use, correlate acknowledgements to the current request and child epoch, and expose worker-manager status only through its positive allowlist.
- Reject non-loopback admin binds.
- Validate URL scheme, join base and incoming URLs structurally with one path separator, and block accidental credential forwarding to an unvalidated target.
- Treat capture content as sensitive local data. The diagnostic compatibility endpoint returns only in-memory `{ created, generatedAt, eventCount }` metadata and creates no file or bundle.
- Activity persistence must use only its exact public event allowlist and must omit Error messages, causes, stacks, credentials, headers, bodies, and backup paths.
- Migration tests and ordinary deterministic gates must inject temporary paths and adapters. Authorized macOS native-keyring D2 must isolate CRP paths through `CRP_HOME` while preserving the real `HOME` for login Keychain access; real-home migration remains reserved for L3 platform confirmation.
- Provider CRUD, testing, and activation must serialize through a provider-service mutex and resolve only the selected provider credential for test/activation.
- Provider tests must use a no-follow redirect policy; no 3xx target may receive the configured authentication header or credential.
- Migration and activity cleanup may delete only atomically claimed paths whose descriptor identity or ownership token matches; foreign replacements must remain canonical blockers.
- A `committed: true` persistence error must be reconciled from durable state before compensation; it must never trigger an inverse credential mutation by assumption.
- The Admin server must bind exactly `127.0.0.1`, require its exact loopback `Host`, reject every mismatched `Origin` and CORS preflight, and emit no access-control allow headers.
- CLI requests require the private control-token bearer. Browser reads require an expiring HttpOnly `SameSite=Strict` session cookie, and browser mutations additionally require the matching session CSRF token.
- The UI must clear the launch fragment and in-memory control token after exchange; failed exchange or later session/CSRF authentication failure must terminate the tab's API use without refresh or mutation fallback.
- Browser storage may contain only an explicitly selected `crp.locale`; session, control, and CSRF tokens, credentials, provider drafts, responses, and errors must remain memory-only.
- Admin request bodies must use the exact route schema, UTF-8 JSON where a body is allowed, and a 64 KiB limit; routes defined with an empty body must reject nonempty input.
- API responses, status files, settings, diagnostics, and errors must use positive field allowlists. Error details may expose only stable validation/commit metadata or `[REDACTED]` sensitive fields.
- Static UI serving must map only the three packaged asset filenames and an extensionless index fallback; decoded traversal, unknown asset extensions, and non-GET/HEAD methods are prohibited.
- State and Codex filesystem adapters must remain separate, and supervisor cleanup must not delete state it cannot prove it owns.
- CLI validation must complete before Supervisor discovery or filesystem mutation. Human errors may be localized, but `--json` failures must leave stdout empty and emit one stable, language-independent, positively projected document on stderr.

## Credential Verification Boundary

Task 4 unit tests inject a native entry loader and never invoke the default addon loader or construct or query a real Keychain, Credential Manager, or Linux secret-service entry. D1 injects an in-memory credential adapter and loopback upstreams while exercising the rest of the production component chain; it is not native evidence.

The final local macOS D2 used the production native adapter and login Keychain, a real Dusapi upstream, and a detached Supervisor. Provider test, activate/start/restart/health/stop/shutdown, real `/responses` HTTP `200 OK`, stable Supervisor PID, replaced worker PID, and cleanup passed; separate clean-home detached bootstrap evidence also passed. This completes the local native/upstream core gate. GitHub-runner macOS, Windows Credential Manager, Linux Secret Service, and cross-platform process/filesystem evidence remain release gates.

## Security Risks

Credential migration, localhost browser attacks, log leakage, symlink/path attacks, worker IPC spoofing, cross-platform hardlink/`O_NOFOLLOW`/ACL semantics, and inherited child environments make the first release an L3 merge-risk change. The retained `provider add --api-key <KEY>` interface may expose credentials through shell history or process inspection; the user explicitly deferred redesign. Argv redesign and broader child-environment minimization are future L3 work, not blockers for the completed local core gate.
