# P2 plan — Secret provider and state store

Worktree: .worktrees/browser-session-manager. Risk re-check at Gate: unchanged (Rev 1, Sec 2, Con 1, Blast 1, Infra 0, Amb 1; total 6). No new deps, no schema change, fs writes confined to a configurable root outside any git tree.

Files (all in worktree):
- src/config.js: `browserStateDir` (BROWSER_STATE_DIR), `browserSecretEnvName`, `browserSecret`.
- src/browser/errors.js: add codes invalid_secret_name, secret_missing, state_missing, invalid_storage_ref, invalid_state_dir.
- src/browser/secrets.js (new): resolveSecret, hasSecret, registerSensitive, redact, redactDeep, redactError, clearSensitive.
- src/browser/stateStore.js (new): save/load/has/delete state, writeEvidenceFile, resolveStorageRef, recordArtifact, listArtifacts.
- src/browser/ops.js: installSavedStateProbe(), invoked at module load.
- .env.example: names only.
- Tests: test/browser.secrets.test.js, test/browser.stateStore.test.js (temp dirs, fake names/values).
