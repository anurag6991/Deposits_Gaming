# Role and Permission Matrix

Three roles: `SUPER_ADMIN`, `MANAGER`, `PUBLISHER`.

Permissions are defined once in `packages/shared/permissions.ts` as a
`Record<Role, Permission[]>` and imported by both the backend middleware and the
frontend sidebar. The frontend uses it only to decide what to *render*. The backend
uses it to decide what to *allow*. Hiding a button is never the control.

## Two layers of authorisation

**Layer 1 — capability.** Can this role perform this action at all?
Enforced by `authorize('offer.create')` middleware on the route.

**Layer 2 — data scope.** Which rows may this specific user touch?
Enforced by a `scopeFilter(user)` helper that every service calls when building a
query. It returns:

| Role | Filter applied |
|---|---|
| Super Admin | none |
| Manager | `owner_user_id = me OR manager_id = me` (depending on the table) |
| Publisher | `publisher_id = me` |

A capability check without a scope filter is the classic hole — Manager A calling
`GET /deposits/:id` with Manager B's id. Every service function takes the requesting
user and applies the scope filter to single-row reads as well as lists. This is
covered by tests in Phase 3.

## Matrix

Legend: **A** = all, **O** = own scope only, **–** = no access

| Capability | Super Admin | Manager | Publisher |
|---|:--:|:--:|:--:|
| **Users** |
| Create manager | A | – | – |
| Edit / disable manager | A | – | – |
| Create publisher | A | O | – |
| Edit / disable publisher | A | O | – |
| Reassign publisher to another manager | A | – | – |
| View users | A | O | – |
| **Offers** |
| Create offer | A | O | – |
| Edit offer | A | O | – |
| Change offer status | A | O | – |
| Extend offer | A | O | – |
| Assign publishers to offer | A | O | – |
| View offers | A | O | assigned only |
| View offer progress/targets | A | O | assigned only |
| **Test data** |
| Upload bulk data | A | O | – |
| View test data table | A | **own uploads only** | – |
| Release / disable / reset record | A | O | – |
| Receive one identity for a task | – | – | one at a time |
| View pool health stats | A | O | – |
| **Leads** |
| Perform lead | – | – | Y |
| View lead activity | A | O | own only |
| **Deposits** |
| Create deposit | – | – | Y |
| View deposits | A | O | own only |
| Change deposit status | A | O | own only |
| Update balance | A | O | own only |
| Confirm gameplay | A | O | own only |
| Reveal test-account secret | A | O (audited) | own, task-scoped (audited) |
| **Withdrawals** |
| Record withdrawal | A | O | own only |
| View withdrawals | A | O | own only |
| **Advances** |
| Create advance | A | O | – |
| View advances | A | O | own, read-only |
| **Proxies** |
| Create / edit / disable proxy | A | O | – |
| View proxy list (no credentials) | A | O | assigned only |
| Reveal proxy credentials | A (audited) | O (audited) | task-scoped (audited) |
| Assign proxy | A | O | – |
| **System** |
| View reports | A | O | own summary |
| View audit logs | A | own actions | – |
| Edit system settings | A | – | – |
| Export data (CSV) | A | O | – |

## Explicit walls

1. A Manager **cannot** see test data uploaded by the Super Admin or by another
   Manager, in any view, filter, search result, or export.
2. A Manager **cannot** see another Manager's publishers, offers, deposits, advances,
   or proxies.
3. A Publisher **never** receives more than one test identity at a time, and only for
   an open task session they own.
4. A Publisher **cannot** enumerate the test-data table under any endpoint.
5. Search endpoints run through the same scope filter as list endpoints — search is not
   a bypass.
6. Audit logs are readable by Super Admin only (a Manager sees their own actions), and
   are not writable by anyone through the API.

## Notes on Super Admin data and Manager offers

The Super Admin pool is shared for **consumption** by default
(`data_source_policy = OWNER_PLUS_SUPER_ADMIN`). An offer spends its own owner's
uploads first, then draws from the central pool.

This does not weaken wall 1 above. Consumption and visibility are separate:

| | Manager's own uploads | Super Admin central pool | Another Manager's uploads |
|---|:--:|:--:|:--:|
| Manager can browse / search / export | yes | **no** | **no** |
| Manager can see counts and pool stats | yes | **no** | **no** |
| Their publishers can consume from it | yes | **yes** | **no** |

A publisher receives exactly one reserved identity for one open task, regardless of
which pool it came from, and cannot tell or query which pool that was. There is no
endpoint through which a Manager or Publisher can enumerate central-pool records.

`OWNER_ONLY` can be set per offer to seal an offer to its own data. See DECISIONS.md
item 1.
