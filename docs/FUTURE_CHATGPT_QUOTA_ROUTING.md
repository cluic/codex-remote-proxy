# Future Feature: ChatGPT Quota-Aware Routing

## Status

This document records a future feature candidate only. It is not part of the
current release, does not change runtime behavior, and must not weaken the
stable Codex `OpenAI` provider or `http://127.0.0.1:15100` proxy invariants.

Implementation would be an L3 credential, lifecycle, and routing change. It
requires a separate roadmap slice, expert confirmation, and fresh release
evidence before it can ship.

## Product Goal

When the user explicitly enables ChatGPT-first routing, CRP could:

1. read Codex's `~/.codex/auth.json` without modifying it;
2. recognize a ChatGPT session only when `auth_mode` is `chatgpt` and the
   required access-token and account fields are present;
3. query and cache normalized ChatGPT quota windows;
4. route an eligible request to the ChatGPT Codex upstream while quota is
   known to be available; and
5. route to an explicitly selected CRP Provider when quota is known to be
   exhausted.

Codex must continue to see the same CRP provider and local base URL. Internal
upstream selection must not trigger Codex history repair.

## Feasibility Conclusion

The mechanism is technically feasible, but it is not a small extension to the
current single-upstream snapshot. A production implementation requires a
per-request dual-upstream dispatcher, secure read-only Codex authentication,
quota normalization and caching, model eligibility, route-aware Metrics, and
strict pre-response fallback rules.

The quota mechanism described by the research input depends on the
undocumented ChatGPT endpoint `/backend-api/wham/usage` and may also depend on
client headers or TLS/browser characteristics. It must be treated as an
unstable internal integration until a read-only spike proves current behavior.

## Required Security Boundary

- Treat `auth.json` as password-grade secret material.
- CRP must not write `auth.json`, use its refresh token, or take ownership of
  Codex's OAuth refresh lifecycle.
- Access tokens must never enter logs, Activity, Capture, Admin responses,
  diagnostics, persisted quota state, or long-lived Worker snapshots.
- Re-read authentication after Codex atomically refreshes the file.
- Persist only sanitized quota fields such as availability, window duration,
  used percentage, reset time, observation time, and expiry time.
- Do not persist or display email addresses, account IDs, user IDs, raw token
  claims, or the raw quota response.
- Unknown, expired, or failed quota observations must fail closed to the
  configured Provider rather than optimistically selecting ChatGPT.

## Recommended Architecture

### CodexAuthReader

A Supervisor-owned, read-only adapter that validates and reads the exact Codex
authentication file, returns only the fields needed in memory, detects file
replacement, and emits static sanitized errors.

### ChatGptQuotaService

A bounded service that queries quota, normalizes all applicable windows by
their durations, caches the sanitized result, schedules refresh near reset
boundaries, and applies TTL, backoff, and jitter.

### RoutingPolicyService

An explicit policy document separate from the Provider registry. Suggested
fields include the opt-in mode, fallback Provider ID, model eligibility policy,
and quota-only fallback setting. A ChatGPT login must not silently enable the
feature.

### DualUpstreamDispatcher

A per-request dispatcher that chooses ChatGPT only when authentication, quota,
policy, and model eligibility are all positively known. Provider credentials
and ChatGPT credentials remain separate security domains.

### Dynamic Route State

Quota changes must not restart the Supervisor or Worker and must not rewrite
Codex configuration. A versioned dynamic state path should update routing and
quota observations without copying the access token into persisted settings.

## Fallback Contract

Automatic fallback is safe only before any client response has started and
only for deterministic quota exhaustion:

- a fresh quota observation reports `allowed: false` or
  `limit_reached: true`; or
- a pre-response 429 is strictly classified as a quota-limit response.

Do not automatically replay on:

- 401 or 403, because Codex may need to refresh and retry its session;
- 400 or 404, because the model or request may be incompatible;
- network ambiguity or 5xx, because the first upstream may already have
  accepted the request; or
- any response after headers or the first non-empty body chunk reached the
  client.

## Model and Metrics Requirements

ChatGPT and external Providers may expose different model catalogs. Automatic
routing should initially require a positively verified compatible model rather
than silently translating model names.

Metrics must record the actual route per request instead of attributing every
request in one Worker generation to one Provider. Suggested dimensions are
route source, Provider ID when applicable, fallback use, fallback reason, and
quota-observation age. These fields must remain anonymous and secret-free.

## Proposed Delivery

### Phase 0: Read-only feasibility spike — 1 to 2 engineer-days

- validate safe `auth.json` reading;
- query the quota endpoint with the current session;
- verify Node HTTP/TLS compatibility;
- inspect which authentication headers Codex sends through CRP;
- prove the ChatGPT Codex Responses request and 401 refresh behavior; and
- verify representative model compatibility.

No UI, persistence, automatic routing, or authentication mutation belongs in
this phase.

### Phase 1: Quota observability — 4 to 7 engineer-days

- secure authentication reader;
- normalized quota cache and reset scheduling;
- sanitized Admin projection;
- read-only Web status; and
- deterministic security, API, and browser tests.

### Phase 2: ChatGPT-first routing — additional 10 to 18 engineer-days

- explicit routing policy;
- dual-upstream dispatch;
- model eligibility;
- strict streaming and fallback boundaries;
- dynamic state transport;
- route-aware Metrics and Activity; and
- CLI/Web management and complete regression coverage.

### Phase 3: Release hardening — 5 to 10 engineer-days

- token-rotation and concurrent-client races;
- quota reset and stale-observation behavior;
- cross-platform validation;
- long-running soak tests;
- internal-endpoint compatibility monitoring; and
- independent L3 security and lifecycle review.

A production-grade implementation is estimated at roughly 15 to 28
engineer-days, or about 3 to 5 calendar weeks for one engineer under the
project's current verification requirements.

## Decision

Retain this as a future feature. If scheduled, begin with Phase 0 and stop if
the quota endpoint requires brittle browser impersonation or cannot be called
without CRP taking ownership of Codex OAuth refresh. The release-quality
product should be an explicit “Use ChatGPT quota first” mode with one selected
fallback Provider, not an automatic behavior triggered merely by finding
`auth.json`.
