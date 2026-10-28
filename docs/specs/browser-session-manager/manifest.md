# Manifest — Browser Session Manager (BSM) MVP

Spec: `tasks/context/browser-session-manager/spec.md` (798 lines)
Slug: `browser-session-manager`
Contracts: `contracts.md` in this directory.

## Phase boundary note

Phases are taken as-is from the spec's § 4 "Implementation phases (dependency
order, for spec-phase-runner)" table (L89-101), including its dependencies.
All eight § 19 open questions are resolved to option A (L6, L656-798), so
the conditional phases P5 (Q-007 A) and P6 (Q-001 A) are in scope.
Migration number `0018` verified: highest existing is
`src/migrations/0017_embed_hash.sql`.

REQ-015 (navigation guard) ownership resolved by the user on 2026-10-28:
P3 owns it; P2 does not touch it; P5 consumes it. The spec § 4 table was
corrected to match. See `contracts.md` Settled decisions.

Shared reference ranges every phase should read: § 3.1 current state
L54-66, § 3.2 L68-74, CON-001 L410-414, CON-002 L416-420, CON-003 L422-425,
§ 13 L486-491, § 15 L617-629.

## Phases

| Phase | Title | Spec range | Depends on | Rev/Sec/Con/Blast/Infra/Amb | Total | Checkpoint | Status |
|---|---|---|---|---|---|---|---|
| P1 | Schema, profile store, policy core | § 4 P1 row L93; REQ-001 L123-138; REQ-002 L140-145; REQ-003 L147-155; REQ-004 L157-163; REQ-016 L290-301; § 6.2.3 `browser_profile_list` row + rejections L366-385; § 6.2.5 migration `0018` L394-406; CON-001 L410-414; CON-003 L422-425; § 8 L432-443; § 9 edge cases L447-448, L457; § 10 L459-464; § 18 L648-654; AC-001 L495-506; AC-002 L508-513; AC-011 L598-604; AC-012 L606-612; Q-002 L679-694; Q-006 L748-765; Q-008 L782-798 | — | 1/2/0/1/0/1 | 5 | yes | done |
| P2 | Secret provider and state store | § 4 P2 row L94; REQ-005 L165-180; REQ-006 L182-194; § 6.2.5 `browser_session_artifacts` L403; § 8 config keys L438-443; § 9 missing state L453-454; § 10 L459-475 (clean state store L474-475); § 16 L635-639; AC-004 L527-537 (state file `0600`, outside root); AC-005 L539-549; Q-003 L696-710; Q-004 L712-728 | P1 | 1/2/1/1/0/1 | 6 | yes | done |
| P3 | Browser runtime adapter | § 4 P3 row L95, L100; REQ-007 L196-205; REQ-008 L207-211; REQ-015 L281-288; CON-002 L416-420; CON-004 L427-430; § 11 L477-480; § 13 L486-491; § 15 integration tests L623-627; § 16 L633-637; § 17 L641-646; AC-006 second bullet L557-558; AC-007 L560-568 (guard behaviour); AC-010 L588-596; Q-005 L730-746 | P1 | 0/2/1/1/2/1 | 7 | yes | done |
| P4 | Session manager and lifecycle ops | § 4 P4 row L96, L101; REQ-009 L213-218; REQ-010 L220-235; REQ-011 L237-249; REQ-012 L251-256; REQ-013 L258-267; REQ-016 L290-301; § 6 scenarios L316-330; § 6.2.1 L332-349; § 6.2.2 L351-364; § 6.2.3 L366-385; § 6.2.4 L387-392; § 6.2.5 `browser_sessions`/artifacts/audit L402-404; § 9 L449-457; § 10 L459-475; AC-003 L515-525; AC-004 L527-537; AC-005 L539-549; AC-006 L551-558; AC-008 L570-576; AC-009 L578-586; AC-011 L598-604; Q-001 L663-677 | P2, P3 | 1/2/2/1/0/1 | 7 | yes | done |
| P5 | Navigate and screenshot ops | § 4 P5 row L97; REQ-014 L269-279; REQ-015 L281-288; § 6.2.1 `READY`→`EXPIRED` L343; § 6.2.3 navigate/screenshot rows L374-385; § 6.2.4 L387-392; § 8 evidence dir L440; § 10 L465-470; CON-004 L427-430; AC-006 first bullet L555-556; AC-007 L560-568; AC-011 L598-604; Q-007 L767-780 | P4 | 0/2/1/1/0/1 | 5 | yes | done |
| P6 | Human-only `browser-login` CLI | § 4 P6 row L98; REQ-017 L303-312; REQ-006 L182-194; REQ-011 L237-249; CON-001 L410-414; § 8 L436-437; § 9 missing state L453-454; § 10 L471-473; Q-001 L663-677 | P4 | 0/1/0/1/0/1 | 3 | no | done |

## Score justifications

- **P1** — Sec 2: the exact-origin matcher and import-time validation are
  the allowlist trust boundary every later guard relies on (spec L7-9 names
  origin bypass as the headline risk), and the phase registers the first
  browser operation, so the Q-008 HTTP refusal must exist from here. Amb 1:
  YAML schema shape (verify/identity assertion, `login_url_pattern`, save
  flag) and the HTTP-exclusion mechanism are not specified.
- **P2** — Sec 2: handles secret values and saved cookie state, with
  REQ-005's no-leak guarantee across results, logs and rows. Amb 1:
  `storage_ref` format and redaction mechanism
  are open.
- **P3** — Sec 2: new sandbox and trust boundary — launches Chromium against
  external sites and owns the navigation guard (redirects, script
  navigations, popups). Infra 2: new external dependency (`playwright-core`
  optional dep plus an explicitly installed Chromium binary). Amb 1: the
  fake-adapter interface (CON-002) and guard abort/reporting shape are left
  to the implementer.
- **P4** — Sec 2: drives logged-in admin sessions, types secrets, saves
  state and enforces cross-project isolation and verification-before-READY.
  Con 2: new cross-process ownership coordination (host/pid/boot ID
  liveness, `runtime_lost`), `session_busy` fail-fast, idle-timeout timers
  racing with in-flight calls. Amb 1: idle-timeout default, `expires_at`
  semantics, liveness check for a remote host, and `login_failed` vs
  `verification_failed` boundary are open.
- **P5** — Sec 2: newly exposed agent-reachable endpoint that steers an
  authenticated session to agent-chosen URLs and writes screenshots that may
  hold admin/personal data. Amb 1: evidence directory layout/filenames and
  how a login redirect is detected for `EXPIRED` are not specified.
- **P6** — no 2s. Amb 1: how the CLI knows the human "finished logging in"
  (keypress vs polling verification, timeout) is not specified.
