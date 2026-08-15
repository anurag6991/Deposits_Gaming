# Open Decisions — things the brief does not settle

Each item has a recommendation. If you say nothing, the build proceeds with the
recommendation, all of which are reversible settings rather than baked-in assumptions.

## Status

| # | Question | Decision |
|---|---|---|
| 1 | Test-data pool | **DECIDED — strict separation.** Each owner's pool is isolated. `OWNER_ONLY` is the default and the central-pool option stays switched off. |
| 2 | Deposit identity source | **DECIDED — fresh identity (`NEW_IDENTITY`).** Deposits draw from the pool independently of leads. |
| 3 | Monthly targets | **DECIDED — shared** across all assigned publishers. Per-publisher caps stay available but unset. |
| 5 | Timezone | **DECIDED — `Asia/Kolkata` (IST).** |

Items 4 and 6–15 proceed on their stated recommendations unless you say otherwise.

---

## 1. Which test-data pool feeds an offer? **(most important)**

> **DECIDED: strict separation.** Every pool is walled off from every other pool.
> `data_source_policy` defaults to `OWNER_ONLY` on every offer and the
> `OWNER_PLUS_SUPER_ADMIN` option is left switched off. A Manager's offers consume only
> that Manager's uploads; Super Admin offers consume only Super Admin uploads. No pool
> can drain another, and no ownership boundary is crossed in any view or query.
>
> The column remains in the schema so the shared-pool option can be enabled later per
> offer, but nothing uses it until you explicitly turn it on.
>
> Consequence to be aware of: a Manager who runs out of data is blocked until they
> upload more — there is no silent fallback. The low-data alert (item in ROADMAP) is
> what gives them warning before that happens.

The brief says a Manager may only see data they uploaded, and may not see Super Admin
data. It does not say which pool a *publisher* draws from when they work an offer.

If a Manager creates the offer, the natural pool is that Manager's uploads. But if the
Super Admin creates an offer and assigns it to Manager A's publishers, whose data is
consumed? And if a Manager runs out of data, should they silently fall back to the
Super Admin's central pool?

**Recommendation:** `data_source_policy` on each offer, defaulting to `OWNER_ONLY`
(the offer creator's pool). Set an offer to `OWNER_PLUS_SUPER_ADMIN` and its publishers
draw from the creator's pool plus the central pool, without the Manager ever being able
to browse central data. This preserves the wall and makes a shared pool possible.

---

## 2. Is a deposit made on a fresh identity, or on an account created by an earlier lead?

> **DECIDED: fresh identity (`NEW_IDENTITY`).** A deposit task draws a brand-new test
> identity from the pool, exactly like a lead does. The publisher registers that
> identity on the brand and deposits in the same session. Deposits are fully
> independent of leads.
>
> Schema effects:
> - `deposit_identity_source` defaults to `NEW_IDENTITY` on every offer.
> - `deposits.test_data_id` gets a UNIQUE constraint, mirroring `leads.test_data_id`.
>   Every identity is therefore consumed exactly once, by either a lead or a deposit,
>   never both and never twice.
> - `deposits.lead_id` stays in the schema but is unused; it is what allows an offer to
>   be switched to `FROM_PRIOR_LEAD` later without a migration.
>
> **Consequence: the test-data pool now feeds both task types.** An offer needing 100
> leads and 50 deposits consumes 150 identities per month, not 100. Combined with the
> strict pool separation from item 1, a Manager must upload for their full combined
> volume. The low-data alert therefore counts against leads plus deposits remaining,
> not leads alone.
>
> Leads and deposits describe different people under this model, so there is no
> lead-to-deposit conversion metric. Reporting shows the two as independent counters.

Original question: the brief treats leads and deposits as two independent task types on
the same offer, but in a typical gaming funnel the lead is the registration and the
deposit funds that same account.

---

## 3. Are monthly targets per offer, or per publisher?

> **DECIDED: shared across all assigned publishers.** A 100-lead monthly target means
> 100 leads total, whoever completes them. Every assigned publisher draws from the same
> pool until it is exhausted, then the offer stops accepting leads for that month.
>
> `monthly_lead_cap` and `monthly_deposit_cap` stay on the assignment row, left NULL.
> Setting one later restricts that one publisher without affecting anyone else.
>
> This is precisely why the `offer_publishers` row lock matters: with a shared target,
> two publishers submitting simultaneously at 99/100 must not both succeed.

Original ambiguity: "100 leads/month" on an offer with five assigned publishers — 100
total, or 100 each?

---

## 4. Is the total deposit *amount* target monthly or lifetime?

Section 8 lists it as an offer field, section 19 shows it under a monthly heading.

**Recommendation:** treat it as monthly (`monthly_deposit_amount_target`, resets each
calendar month) and add an optional `lifetime_deposit_amount_target` for an overall cap
across the offer's life. Both are shown to the publisher.

---

## 5. What is a "month"?

> **DECIDED: `Asia/Kolkata` (IST, UTC+5:30).** Seeded as the `app_timezone` system
> setting and used for every month boundary, day boundary, "today" counter, and
> `month_key` generation in the system. Calendar months, not rolling 30-day windows.
>
> The server clock stays UTC; only the application's date logic uses IST. A lead
> completed at 02:00 IST on 1 September counts toward September, even though it is
> still 31 August in UTC. India has no daylight saving, so there are no DST edge cases
> to handle.

Original question: counters, targets, and advances all reset monthly, and server UTC
versus your operating timezone would shift activity across month boundaries.

---

## 6. What happens when a publisher starts a task and walks away?

The identity is reserved. Without a rule it stays reserved forever and the pool bleeds.

**Recommendation:** a reservation TTL (default 30 minutes, configurable). A sweeper
returns expired reservations to `AVAILABLE` and audit-logs it. The publisher also gets
an explicit "Cancel task" button that releases immediately. A released record goes back
to `AVAILABLE`, not `USED` — nothing is wasted by an abandoned attempt.

---

## 7. Can a lead be undone?

A publisher misclicks "Lead Completed". The identity is now burned permanently.

**Recommendation:** Super Admin can reset an activity, which deletes the lead row,
returns the identity to `AVAILABLE`, decrements the counter, and writes an audit entry
recording who reset it and why (reason required). Managers cannot do this. This is the
"unmark the data" capability from your brief, made concrete.

---

## 8. Do withdrawals need approval?

The brief has publishers recording withdrawals themselves with no review step.

**Recommendation:** no approval for now — publishers record, managers see. Add a
`status` column on withdrawals from day one so an approval flow can be switched on
later without a migration. Tell me if you want approval immediately.

---

## 9. Advances — is this money paid, or money owed?

The brief says "advance given to publisher in a month" but does not define whether
recording it means it has been paid.

**Recommendation:** `status` of `PENDING` / `PAID` / `CANCELLED` with a `paid_on` date.
Manager records it as pending and marks it paid when the transfer happens. Publisher
sees the month total and its status.

---

## 10. How are proxies matched to work?

The brief allows assigning a proxy to a publisher and to an offer, but not which one
wins, or what happens when neither is set.

**Recommendation:** resolution order at task start —
identity-sticky assignment → publisher+offer assignment → publisher assignment →
any active proxy matching the offer country → none (task proceeds, warning shown).
Identity-sticky is the important one: the same test account should always appear from
the same IP, or the brand's fraud systems will flag it.

---

## 11. Storing test-account passwords

Section 18 asks for a password field on deposits and then says to avoid storing real
credentials.

**Recommendation:** store it encrypted (AES-256-GCM), masked in every table view,
revealed only through an explicit "Show" action that writes an audit entry. It is a
throwaway test-account password, so this is proportionate. It is never logged, never in
an export, and never in an API list response.

---

## 12. Offer expiry is described two ways

Section 9 says mark red after 3 months and section 8 has an explicit `expiry_date`.

**Recommendation:** `expiry_date` is the single source of truth, defaulted to
`start_date + 90 days` from a configurable setting. Red is `now() > expiry_date`.
"3 months" becomes the default, not a hard-coded rule.

---

## 13. Does a disabled offer or publisher hide history?

**Recommendation:** no. Disabling stops new work; all historical leads, deposits, and
reports remain visible and attributed. Nothing is ever hard-deleted.

---

## 14. Local development environment

Node.js is not installed on your Windows machine. Two options:

- **A (recommended):** install Node 22 LTS and PostgreSQL 16 locally, develop and test
  on Windows, deploy to the VPS. Fastest iteration, no risk to production.
- **B:** develop directly on the VPS in a separate `dev` directory with its own
  database. No local install needed, but slower and riskier.

I recommend A. Either way, production is only ever touched by the deploy script.

---

## 15. Domain name

Nginx and Lets Encrypt need a real domain pointed at the VPS. `srv1836208.hstgr.cloud`
can work for testing but is not ideal for a permanent internal tool. Do you have a
domain to point at this?
