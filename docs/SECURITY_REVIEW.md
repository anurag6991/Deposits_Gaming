# Security Review — Phase 6

Date: 2026-08-16. Reviewed against section 34 and section 6 of the original brief.

Method: dependency audit, code review, and — the part that actually found things —
a probe script attacking the **running** API with real tokens, real ids belonging to
other users, and payloads designed to slip past a check applied in only one place.
`ops/scripts/security-probe.mjs`, 28 checks, all passing.

**Result: 2 real issues found and fixed, 3 dependency advisories resolved, 0 open.**

---

## Findings

### 1. Stored XSS via offer URL — FIXED

**Severity: high.** `z.string().url()` accepts every URL scheme, including
`javascript:`. The probe created an offer with `url: "javascript:alert(1)"` and the
API returned **201 Created**.

That URL is rendered on the publisher task screen as a clickable "Open website"
button. Any Super Admin or Manager could therefore store script that executes in a
publisher's browser — in a session holding that publisher's access token.

Not exploitable by a publisher, and this is an internal tool, so it needs someone with
offer-creation rights. But a compromised manager account turns into compromised
publisher accounts, and the fix is trivial.

**Fix:** `isSafeHttpUrl()` in `packages/shared`, enforced two ways —

- the offer schema rejects any scheme other than `http`/`https` on write
- the task screen re-checks before rendering, so a bad URL already in the database
  cannot become clickable

Regression test: `apps/api/src/modules/offers/url-safety.test.ts`, covering
`javascript:`, `JavaScript:` (case), `data:`, `vbscript:`, `file:` and `about:`.

### 2. Permanently vulnerable `xlsx` on the upload path — FIXED

**Severity: high.** The importer parses untrusted uploaded files with SheetJS.
npm's newest `xlsx` is **0.18.5**, which carries prototype pollution
(GHSA-4r6h-8v6p-xvw6, fixed in 0.19.3) and ReDoS (GHSA-5pgg-2g8v-p4x9, fixed in
0.20.2). SheetJS stopped publishing to npm, so **no npm version is safe** and
`npm audit fix` reports "no fix available".

This sat directly on the one code path that consumes attacker-supplied bytes. The
existing magic-byte guard does not help: a legitimate zip-structured `.xlsx` can still
carry a prototype-pollution payload.

**Fix:** installed SheetJS's own maintained build,
`xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. This is the vendor's
documented remedy, the API is identical, and all 31 importer tests pass unchanged.

**Operational note:** installs now fetch that tarball from `cdn.sheetjs.com`. If that
host is unreachable during a deploy, `npm ci` fails. Mitigate by vendoring the tarball
into the repo or an internal mirror if this becomes a problem.

### 3. Vulnerable transitive `postcss` and `sharp` — FIXED

**Severity: high by label, not reachable here.** Next.js pins `postcss` to exactly
`8.4.31` in a nested copy (four sourceMappingURL path-traversal and XSS advisories),
and pulls `sharp` 0.34.5 (libvips CVEs).

Honest assessment before fixing: neither was exploitable. PostCSS runs at build time
over our own Tailwind CSS and never sees user input. Sharp is used only by
`next/image`, and this application contains no images at all — confirmed by grep.

Fixed anyway, because "not currently reachable" is a property that a future commit can
silently remove. npm `overrides` force `postcss ^8.5.26`; `sharp` now resolves out of
the tree entirely as an unused optional dependency.

`npm audit --omit=dev` now reports **0 vulnerabilities**. Avoided a Next 16 major
upgrade immediately before deployment.

---

## What was verified and found sound

Every item below was attacked against the running server, not merely read.

### Authorization — horizontal

| Attack | Result |
|---|---|
| Manager B reads Manager A's publisher by id | refused |
| Manager B disables Manager A's publisher | refused |
| Publisher reads another publisher | refused |
| `GET /deposits?managerId=<other manager>` | zero rows |
| `GET /advances?publisherId=<other team>` | zero rows |
| Publisher requests the publisher report | zero rows |

The filter-parameter cases matter most: passing another user's id as a *filter* is the
classic way a scope check gets bypassed, because the handler looks like it is doing
what it was asked. The scope filter is ANDed after user input, so it cannot widen.

### Authorization — vertical

Publisher cannot create users, enumerate test data, or read audit logs. Manager cannot
create managers, change settings, or reset a lead. A manager's pool stats returned
**15 records — their own uploads only**, with none of the 375 central records visible,
confirming the consumption-versus-visibility split holds at runtime.

### Injection

SQL metacharacters in search are treated as data (Prisma parameterises; the two raw
queries use tagged templates with bound parameters, never string concatenation).
`' OR 1=1 --` in the audit filter returns nothing rather than everything. A JSON body
carrying `__proto__` does not pollute `Object.prototype`.

### Mass assignment

Sending `role: "SUPER_ADMIN"` inside a profile update does not change the role — Zod
strips unknown keys before the service ever sees them.

### Sensitive data

`passwordHash`, `accountSecretEnc` and `passwordEnc` appear in no list response.
A publisher cannot reveal proxy credentials without an open task session holding that
proxy. Error bodies contain no Prisma internals, SQL, or stack traces.

### Authentication

Missing, malformed, forged-signature, and `alg:none` tokens are all refused. A token
stays valid cryptographically after its account is disabled, but the request is still
rejected, because `authenticate` re-reads the user and session on every call.

---

## Accepted risks

| Risk | Why accepted |
|---|---|
| Rate limiting is per-process, in memory | PM2 runs 2 API instances, so the effective limit is roughly double the configured value. Fine for an internal tool; add Redis if it ever matters. |
| Test-account passwords are stored (encrypted) | Section 18 of the brief asks for them. AES-256-GCM, masked everywhere, audited on reveal, absent from logs and exports. |
| SheetJS installs from a vendor CDN | The only safe distribution channel. Vendor the tarball if deploy reliability demands it. |
| No 2FA | Out of scope for the initial build; listed as a future feature. |

---

## Not yet verifiable — deferred to deployment

These belong to Phase 5 and cannot be checked until the VPS is reachable:

- TLS configuration and HSTS in the real Nginx (headers are set by helmet and verified
  locally, but the certificate chain and redirect are server-side)
- Postgres bound to localhost only, and the UFW ruleset
- `.env.production` file permissions and the absence of secrets from the repo on disk
- fail2ban, SSH key-only login, unattended upgrades
- A real backup **and a real restore test** — an untested backup is not a backup

## Re-running this

```bash
node ops/scripts/security-probe.mjs
```

Needs the API running and the dev database seeded. Run it after any change to
authentication, authorization, or the scope filters.
