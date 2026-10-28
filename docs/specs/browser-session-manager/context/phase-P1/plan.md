# P1 plan (as implemented)

Worktree: .worktrees/browser-session-manager, branch feature/browser-session-manager.

New: src/migrations/0018_browser_sessions.sql; src/browser/{errors,origin,profileSchema,profileStore,audit,ops}.js;
tests test/browser.{origin,profileSchema,profileStore,operations,cli}.test.js.
Changed: src/operations.js (surfaces, operationsFor, browser_profile_list), src/mcpServer.js (surface option, ctx),
src/http.js (filter + 403 + ctx), src/cli.js (ctx, browser-profile command), src/completion.js (section, OP_HELP, command),
src/config.js (browserEnabled), .gitignore (un-ignore migrations), .env.example, test/http.test.js, test/fixtures/help.txt.

Gate re-score: rev 1, sec 2, con 0, blast 1 (operations.js/http/mcp touched, additive), infra 0, amb 1. No escalation.
Note: /mcp over HTTP is also unauthenticated, so Q-008's rationale applies; browser tools are excluded there too.
