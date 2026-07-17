# Permissions and Security

## Roles

The MVP has one role: the local operating-system user. It has no accounts, remote users, or administrator delegation.

## Sensitive Actions

- Store, replace, or delete an API key.
- Use a stored credential to refresh a provider model catalog.
- Activate a provider.
- Patch Codex configuration.
- Snapshot and repair Codex provider metadata for a Codex-level URL transition.
- Start, stop, or restart the proxy worker.
- Generate in-memory diagnostic summary metadata.

## Access Matrix

| Actor | Can Do | Cannot Do | Notes |
| --- | --- | --- | --- |
| Authenticated local UI session launched with a current fragment | Manage providers and worker | Read complete keys; bind remote interfaces | CSRF and origin checks required |
| Valid-cookie UI reload without a fragment | Read status, providers, activity, settings, and anonymous Metrics; explicitly restore management before original expiry | Perform a business mutation before recovery; extend session expiry; recover after expiry | Recovery rotates session and CSRF under exact Origin plus a non-simple header |
| Local CLI with control token | UI launch, status/lifecycle, provider list/add/models/test/activate/delete, and documented inspection commands | Read complete keys; update providers; call Activity, Settings, or diagnostics as CLI commands | ID or case-insensitive exact name selectors; designed for bounded automation |
| Proxy worker | Use the active snapshot captured once per request | Read registry or other provider entries through CRP APIs | IPC receives only the selected credential; general inherited-environment minimization remains pending L3 hardening |
| Remote network client | Nothing | Access UI, API, or proxy management | Admin server is loopback-only |

## Audit Requirements

Activity records only implemented events: provider creation/update/deletion/test/model-refresh/activation, proxy start/stop/restart, and legacy migration outcomes. Store stable IDs, bounded model counts, HTTP status where allowlisted, and sanitized error codes, never model response bodies or secret values. Codex bootstrap and diagnostic-summary generation do not currently append Activity events.

## Security Requirements

- The public Supervisor requires the native credential store and fails closed when it cannot be constructed or used.
- Native credential entries use service `org.cluic.codex-remote-proxy` and opaque credential references; the addon loads only during adapter construction, and adapters expose no enumeration API.
- The UI, CLI, Admin API, and ordinary Supervisor startup expose no file-backend selection or consent control.
- The lower-level private file adapter is reachable only through trusted dependency injection. Any future public startup-consent path is L3 work; native failures must never replay into that adapter.
- Set metadata, provider-model cache, token, and state files to `0600` where supported.
- A clean-home Codex bootstrap must create the real `.codex` parent as `0700` and `config.toml` as `0600` on POSIX, reject unsafe/replaced parents or targets, create no nonexistent-source backup, and expose only stable `CODEX_CONFIG_*` errors.
- Existing-config history repair requires Codex to be fully stopped. It must snapshot every resource in the exact write set, validate existing rollout backups byte-for-byte without following links, publish completed SQLite logical snapshots exclusively, reject mutable SQLite files with multiple hard links, make replacement metadata durable before rename, fsync backup/pending/rollout directory entries, retain a discoverable marker or config lock after every committed `pending: true` failure, and never modify an unbacked newly discovered resource.
- Provider activation, Worker start/restart, and unexpected-exit recovery must serialize with bootstrap through the same strict Codex gate and fail or remain in bounded backoff before lifecycle mutation while Codex is unconfigured, locked, unsafe, selected-binding-invalid, or history-repair pending.
- Never accept sensitive keys inside `extraHeaders`; use the credential field.
- Redact authorization, cookie, token, secret, and API-key headers and fields.
- Redact the exact active authentication header before debug logging or capture persistence; short secrets must never be emitted unchanged.
- Validate parent-child IPC with exact directional version-1 schemas, HTTPS-or-loopback URL rules, HTTP-token authentication fields, Node-compatible final authentication values, and case-insensitive sensitive/authentication-header collision rejection. Resolved credentials may cross the process boundary only inside a parent `configure` message; child lifecycle/fatal/metric messages, sanitizers, stdout, and stderr must never echo settings, causes, complete secrets, unvalidated request IDs, or prohibited per-request fields.
- Detached Supervisor startup IPC may carry only exact static allowlisted error contracts. Raw messages, actions, details, causes, stacks, and credentials are prohibited; malformed, unknown, oversized, or extra-field payloads must become generic `SUPERVISOR_START_FAILED`.
- Validate every child message before lifecycle use, correlate acknowledgements to the current request and child epoch, and expose worker-manager status only through its positive allowlist.
- Reject non-loopback admin binds.
- Validate URL scheme, join base and incoming URLs structurally with one path separator, and block accidental credential forwarding to an unvalidated target.
- Treat capture content as sensitive local data. The diagnostic compatibility endpoint returns only in-memory `{ created, generatedAt, eventCount }` metadata and creates no file or bundle.
- Treat Metrics as a separate anonymous aggregate plane. It may retain only fixed result counts, bounded credential-screened model IDs, Provider IDs resolved by Supervisor, Token aggregates/coverage, histogram bins, and quality counters; per-request identifiers, URLs, headers, bodies, session/thread IDs, credentials, raw errors, and exact timings are prohibited in IPC, persistence, and API responses.
- Activity persistence must use only its exact public event allowlist and must omit Error messages, causes, stacks, credentials, headers, bodies, and backup paths.
- Migration tests and ordinary deterministic gates must inject temporary paths and adapters. Authorized macOS native-keyring D2 must isolate CRP paths through `CRP_HOME` while preserving the real `HOME` for login Keychain access; real-home migration remains reserved for L3 platform confirmation.
- Provider CRUD, testing, and activation must serialize through a provider-service mutex and resolve only the selected provider credential for test/activation.
- Provider tests must use a no-follow redirect policy; no 3xx target may receive the configured authentication header or credential.
- Provider model refreshes must use the same selected credential and no-follow redirect policy, cap the response at 1 MiB, accept only a bounded OpenAI-style model list, cap the private cache at 512 entries and 16 MiB, and persist no credential, credential reference, response body, or arbitrary upstream metadata. Any model ID containing the complete request credential must be rejected before cache, API, Activity, or CLI projection so an upstream cannot reflect a key through a public model name. Refresh failure must preserve the last good cache and provider lifecycle state.
- Initial provider selection must be explicit in the Admin request, default false, require a stopped Worker when no provider is active, and use a first-wins registry compare-and-set. It must never start or reconfigure the Worker; conditional Web Setup opts in only for first-provider selection, while ordinary Provider tests omit it.
- Migration and activity cleanup may delete only atomically claimed paths whose descriptor identity or ownership token matches; foreign replacements must remain canonical blockers.
- A `committed: true` persistence error must be reconciled from durable state before compensation; it must never trigger an inverse credential mutation by assumption.
- The Admin server must bind exactly `127.0.0.1`, require its exact loopback `Host`, reject every mismatched `Origin` and CORS preflight, and emit no access-control allow headers.
- CLI requests require the private control-token bearer. Browser reads require an expiring HttpOnly `SameSite=Strict` session cookie, and browser mutations additionally require the matching session CSRF token.
- Browser management recovery must reject bearer auth, missing/mismatched Origin, missing/incorrect `X-CRP-Session-Resume: 1`, query/body input, and unsupported methods; success must rotate session and CSRF, invalidate old values, and preserve the original absolute expiry.
- The UI must clear the launch fragment and in-memory control token after exchange; failed exchange or later session/CSRF authentication failure must terminate the tab's API use without refresh or mutation fallback.
- Browser storage may contain only an explicitly selected `crp.locale`; session, control, and CSRF tokens, credentials, provider drafts, responses, and errors must remain memory-only.
- Admin request bodies must use the exact route schema, UTF-8 JSON where a body is allowed, and a 64 KiB limit; routes defined with an empty body must reject nonempty input.
- API responses, status files, settings, diagnostics, and errors must use positive field allowlists. Error details may expose only stable validation/commit metadata or `[REDACTED]` sensitive fields.
- Static UI serving must map only the three packaged asset filenames, an empty `/favicon.ico` response, and an extensionless index fallback; decoded traversal, unknown asset extensions, and non-GET/HEAD methods are prohibited.
- State and Codex filesystem adapters must remain separate, and supervisor cleanup must not delete state it cannot prove it owns.
- CLI validation must complete before Supervisor discovery or filesystem mutation. Human errors may be localized, but `--json` failures must leave stdout empty and emit one stable, language-independent, positively projected document on stderr.
- CLI help must default to English independently of host locale and use Chinese only after explicit `--locale zh-CN`; removed `init`, `install`, and `setup` commands must fail locally with static replacement guidance and no discovery or mutation.
- CLI name selection must re-read the resolved provider ID and reject a changed ID/name snapshot before mutation. Because the Admin API remains ID-addressed and this guard is not atomic with the later operation, security-sensitive automation must use immutable IDs when concurrent provider renames are possible.

## Credential Verification Boundary

Task 4 unit tests inject a native entry loader and never invoke the default addon loader or construct or query a real Keychain, Credential Manager, or Linux secret-service entry. D1 injects an in-memory credential adapter and loopback upstreams while exercising the rest of the production component chain; it is not native evidence.

The final local macOS D2 used the production native adapter and login Keychain, a real Dusapi upstream, and a detached Supervisor. Provider test, activate/start/restart/health/stop/shutdown, real `/responses` HTTP `200 OK`, stable Supervisor PID, replaced worker PID, and cleanup passed; separate clean-home detached bootstrap evidence also passed. This completes the local native/upstream core gate. GitHub-runner macOS, Windows Credential Manager, Linux Secret Service, and cross-platform process/filesystem evidence remain release gates.

## Security Risks

Credential/history migration, localhost browser attacks, log leakage, symlink/path attacks, worker IPC spoofing, cross-platform hardlink/`O_NOFOLLOW`/directory-fsync/ACL semantics, and inherited child environments make the first release an L3 merge-risk change. Real-home history repair must not run while Codex can append rollout or SQLite state. The retained `provider add --api-key <KEY>` interface may expose credentials through shell history or process inspection; argv redesign and broader child-environment minimization remain future L3 work.
