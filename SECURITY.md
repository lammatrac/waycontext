# Security Policy

## Supported versions

WayContext is pre-1.0 and moves quickly. Only the latest release gets security
fixes; there are no maintained release branches.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Use GitHub's private vulnerability reporting instead — go to the
[Security tab](https://github.com/lammatrac/waycontext/security/advisories/new)
and open a draft advisory. That keeps the report private until a fix is
available, and it needs no email address on either side.

Please include what you ran, what happened, and the smallest reproduction you
can manage. You'll get an acknowledgement within a few days. As a solo,
unfunded project there's no formal SLA and no bounty programme.

## Scope

A few things are **known and deliberate**, so they aren't vulnerabilities:

- **`waycontext serve` has no authentication.** It binds `127.0.0.1` only and
  refuses a non-local address unless explicitly overridden. Auth, rate limiting
  and multi-tenancy are absent on purpose rather than half-implemented — see
  [docs/api.md](docs/api.md). Exposing it to a network is outside the supported
  configuration.
- **`waycontext db` opens an interactive psql session** against your
  `DATABASE_URL`. That is its entire purpose.
- **The database holds your source code**, including symbol bodies, doc chunks
  and commit messages. Protect it as you would the repository itself.
- **Embedding providers see your code.** With `EMBEDDING_PROVIDER=voyage` or
  `openai`, symbol bodies and doc chunks are sent to that provider's API at
  index time. Use `EMBEDDING_PROVIDER=none` if that isn't acceptable.

Things that **are** in scope: SQL injection, path traversal, arbitrary code
execution during parsing or indexing, credential leakage into logs or output,
and anything that lets an indexed repository's *contents* affect the host
running WayContext.
