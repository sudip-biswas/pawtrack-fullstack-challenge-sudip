# Full-Stack Engineering Decisions

## Audit Findings

### CRITICAL-1: Multi-tenancy data leak via `?tenantId` query override
**File:** `server/src/routes/bookings.ts:21`
**Issue:** `const tenantId = query.tenantId || auth.tenantId;` — any authenticated user can pass `?tenantId=tenant_seattle` to see another tenant's bookings. No role check, no ownership check.
**Why it matters:** This is the reported bug ("a customer seeing another customer's bookings"). A Portland user can trivially read all Seattle bookings.
**Severity:** Critical
**Fix:** Removed the query override entirely. `tenantId` is always derived from `auth.tenantId`.

### CRITICAL-2: IDOR on GET /api/bookings/:id
**File:** `server/src/routes/bookings.ts:41-50`
**Issue:** `bookingService.getBooking(id)` returns a booking without any tenant ownership check. Any authenticated user from any tenant can read any booking by guessing or enumerating IDs.
**Why it matters:** Cross-tenant read access to individual booking records including pet notes, owner phone numbers, and sitter assignments.
**Severity:** Critical
**Fix:** Added `if (booking.tenantId !== auth.tenantId)` check; returns 404 (not 403, to avoid confirming existence).

### CRITICAL-3: IDOR on PATCH /api/bookings/:id/status
**File:** `server/src/routes/bookings.ts:89-97`
**Issue:** `bookingService.updateStatus(id, status, auth.userId)` has no tenant check. Any authenticated user from any tenant can cancel or transition any booking by ID.
**Why it matters:** A malicious or misconfigured client could cancel competitors' bookings or fraudulently complete them.
**Severity:** Critical
**Fix:** Fetch booking first in the route handler, verify `booking.tenantId === auth.tenantId`, return 404 on mismatch before calling `updateStatus`.

### CRITICAL-4: Stored XSS via `innerHTML` injection of booking notes
**File:** `client/app.js:129`
**Issue:** `<div class="booking-notes">${booking.notes}</div>` injects raw API data directly into innerHTML. The seed data contains a live XSS payload: `pet_005` notes contain `<img src=x onerror="alert(1)">`.
**Why it matters:** Any user who can create a booking with a malicious `notes` field can execute arbitrary JavaScript in every other user's browser — enabling session hijacking, credential theft, or UI defacement.
**Severity:** Critical
**Fix:** Added `escapeHtml()` helper and applied it to all user-controlled fields rendered in templates (`booking.notes`, `booking.petId`, `booking.sitterId`).

### HIGH-1: Race condition enabling double-bookings
**File:** `server/src/services/booking-service.ts:69-119`
**Issue:** The overlap check (lines 73-88) is followed by `await new Promise(resolve => setTimeout(resolve, 10))` before the write (line 110). This `await` yields the event loop, allowing a concurrent request to pass the same overlap check before either booking is written to the store. Both then write successfully, creating a double-booking.
**Why it matters:** This is the reported double-booking bug. Even in a production DB scenario, a check-then-act without an atomic lock or unique constraint is dangerous.
**Severity:** High
**Fix:** Made `createBooking` synchronous — removed the artificial async delay. The overlap check and store write now happen atomically within a single event-loop tick, eliminating the race condition. In a real database, a `UNIQUE` constraint or serializable transaction would be the equivalent fix.

### HIGH-2: Spoofable role escalation
**File:** `server/src/middleware/auth.ts:21`
**Issue:** `const role = (request.headers['x-user-role'] as string) || 'staff'` — the role is read directly from a client-controlled header with no validation. Any client can set `X-User-Role: admin` and claim elevated privileges. Role is also never actually used to enforce authorization in any route — extracting it is currently security theater.
**Why it matters:** Role-based access control is only meaningful if roles are issued by a trusted authority (e.g., from a JWT claim validated with a server secret).
**Severity:** High
**Note:** Full fix requires replacing header-based auth with signed JWT tokens. Documented as Improvement Proposal #1.

### HIGH-3: Missing server-side input validation on POST /api/bookings
**File:** `server/src/routes/bookings.ts:56-83`
**Issue:** No validation of presence, type, or format for `petId`, `sitterId`, `scheduledDate`, `startTime`, `endTime`. No check that the pet/sitter belong to the authenticated tenant (a user could book a sitter from another tenant).
**Why it matters:** Missing fields cause crashes or undefined behavior; cross-tenant pet/sitter references break data integrity.
**Severity:** High
**Fix:** Added Fastify JSON Schema validation for the POST body (Phase 3 improvement). Added cross-tenant ownership checks for `petId` and `sitterId` in the route handler.

### HIGH-4: Wrong HTTP status codes throughout
**File:** `server/src/routes/bookings.ts`
**Issue:**
- GET /:id returns `200` with `{ error: 'Booking not found' }` instead of `404`
- POST returns `200` on both success and failure (should be `201` and `409`/`422`)
- PATCH returns `200` regardless of whether the booking was found or the transition was invalid
**Why it matters:** Clients rely on status codes to differentiate success from error. Middleware, monitoring, and API clients all treat `200` as success.
**Severity:** High
**Fix:** Correct status codes applied: `201` for created, `404` for not found, `409` for conflict (overlap), `422` for validation/transition error.

### MEDIUM-1: Pagination off-by-one (first page always skipped)
**File:** `server/src/services/booking-service.ts:53`
**Issue:** `const offset = page * limit` uses 0-based indexing, but the client sends 1-based page numbers. When the client sends `?page=1`, the server computes `offset = 1 * 5 = 5`, skipping the first 5 results. Page 0 (the true first page) is never requested.
**Why it matters:** Staff never see the most recent bookings — they are always skipped. This is likely contributing to the "stale data" reports.
**Severity:** Medium
**Fix:** Changed to `const offset = (page - 1) * limit`.

### MEDIUM-2: Timezone-naive date filter
**File:** `server/src/services/booking-service.ts:39`
**Issue:** `bookings.filter(b => b.scheduledDate.startsWith(date))` does a string prefix match. A booking stored as `2026-04-09T06:30:00Z` (which is April 8 at 11:30 PM Pacific) will not match a filter for `2026-04-08`, even though it occurs on that date in the tenant's local timezone. The seed data explicitly flags this (booking_006, booking_011).
**Why it matters:** Staff filtering by "today" will miss late-evening bookings that cross the UTC midnight boundary.
**Severity:** Medium
**Note:** Left as Improvement Proposal #2. Full fix requires per-tenant timezone-aware date range conversion.

### LOW-1: CORS `origin: true` too permissive
**File:** `server/src/index.ts:11`
**Issue:** `origin: true` reflects any origin, effectively disabling CORS protection.
**Severity:** Low (acceptable in dev; critical in production)

### LOW-2: Misleading code comment about polling closure
**File:** `client/app.js:53`
**Issue:** Comment says "the polling closure still has the old one" after a `filters` reassignment. This is factually incorrect — JavaScript closures capture variable *bindings*, not values. The setInterval callback reads the current value of `filters` at call time, which is always the latest assigned object. The polling behavior is actually correct.
**Severity:** Low
**Fix:** Removed the misleading comment.

---

## API Design

**Status codes now follow RFC 7231:**
- `200 OK` — successful read/update
- `201 Created` — booking created
- `404 Not Found` — resource doesn't exist or belongs to another tenant (no tenant existence leakage via 403)
- `409 Conflict` — sitter schedule overlap
- `422 Unprocessable Entity` — validation failure (missing fields, invalid transition)

**Multi-tenancy pattern:** All data access is scoped by `auth.tenantId`, derived from validated server state (the tenant lookup in `auth.ts`), never from client-supplied query parameters.

**For production evolution:**
- Replace header-based auth with JWT; derive tenantId and role from signed claims
- Add pagination cursors or keyset pagination to avoid offset drift on concurrent writes
- Add `ETag`/`Last-Modified` headers for optimistic concurrency in the client

---

## Architecture Observations

**What's good:**
- Service layer (`BookingService`) cleanly separates business logic from HTTP concerns
- Domain events via `EventBus` enable loose coupling for notifications and audit hooks
- `VALID_TRANSITIONS` as a data structure (not switch/case) is clean and extensible

**What I'd change:**
- Route handlers are directly calling `bookingService.getBooking()` to do pre-checks, then `updateStatus` separately — the service layer should own the full operation including the tenant check, so routes don't need to know about the store
- The `EventBus` is fire-and-forget with no error handling; a handler that throws will propagate up and could fail the HTTP request
- The in-memory store has no locking primitives — acceptable for a challenge, but any real persistent store needs transactions for the overlap check

---

## Frontend Approach

**Changes made:**
- Fixed XSS: all user-controlled strings now pass through `escapeHtml()` before insertion into innerHTML
- Removed misleading polling-closure comment

**State management note:** The module-level `filters` object with `setInterval` polling is correct as written (closures capture variable bindings). In production I'd use React with React Query: automatic revalidation on focus, correct stale-while-revalidate semantics, and built-in deduplication for concurrent fetches.

**Framework choice for production:** React + TypeScript with React Query for server state. The vanilla JS approach becomes hard to maintain as component count grows; React's component model and the hook ecosystem make state isolation and testing much easier.

---

## Improvement Implemented: Fastify JSON Schema Validation on POST /api/bookings

**What:** Added Fastify's built-in JSON Schema validation to `POST /api/bookings` and `PATCH /api/bookings/:id/status`. Also added cross-tenant `petId`/`sitterId` ownership validation in the POST handler.

**Why this one:** Input validation addresses multiple problem vectors simultaneously — prevents crashes from missing fields, prevents type confusion bugs, and provides an explicit API contract that documents required inputs. Fastify's built-in schema approach means no new dependencies (unlike Zod), and validation runs before any handler code executes, making it a clean defense-in-depth layer.

**Specific schemas added:**
- `POST /api/bookings`: requires `petId`, `sitterId`, `scheduledDate`, `startTime`, `endTime` as non-empty strings; `notes` optional
- `PATCH /api/bookings/:id/status`: requires `status` to be one of the five valid enum values; invalid values now return `400` with a Fastify-generated message before reaching business logic

---

## Improvements Proposed

### Proposal 1: Replace header-based auth with JWT

**What:** Issue signed JWT tokens from a `/auth/login` endpoint. Validate the token in `authMiddleware`, derive `tenantId`, `userId`, and `role` from claims signed with a server secret. Add middleware to enforce role-based access (e.g., only `admin`/`staff` can create bookings; only `sitter` assigned to a booking can move it to `in_progress`).

**Why:** The current auth is entirely client-controlled. Any user can set `X-User-Id: user_admin_portland` and `X-User-Role: admin` and claim any identity. Role-based authorization is currently security theater.

**Estimated effort:** 1-2 days. Add `jsonwebtoken` package, login route, refresh token handling (short-lived access token + longer-lived refresh token stored in httpOnly cookie), and client-side token storage and refresh logic.

**Trade-offs:** Stateless JWTs can't be revoked before expiry without a token blocklist. A short expiry (15 minutes) + refresh token pattern mitigates this but adds complexity. Session-based auth (server-side sessions in Redis) is simpler to revoke but requires shared session state across instances.

### Proposal 2: Timezone-aware date filtering

**What:** When filtering bookings by date, convert the requested date string to a UTC timestamp range using the tenant's timezone (already stored on the `Tenant` object). Filter `scheduledDate >= startOfDayUTC && scheduledDate < endOfDayUTC` rather than string prefix matching.

**Why:** The current prefix match silently misses bookings that cross the UTC midnight boundary in the tenant's local timezone (explicitly flagged in seed data comments for booking_006 and booking_011). Staff in Austin (CST, UTC-5) filtering for "today" will miss bookings at 11 PM local time that are stored with a timestamp starting with "tomorrow" in UTC.

**Estimated effort:** 2-3 hours. Use the `Intl` API (no dependency) or `date-fns-tz` (~20KB) for more readable code. The tenant timezone is already on the `Tenant` object; pass it through to `listBookings`. No schema changes required.

**Trade-offs:** Using native `Intl` avoids adding a dependency but is more verbose. If the client sends date filters in local time and the server converts to UTC ranges, the API contract must be documented clearly. Alternatively, the client could send explicit UTC range bounds — simpler to implement but shifts complexity to the frontend.

---

## AI Usage

**Tool used:** Claude (claude-sonnet-4-6) via Claude Code.

**How I used it:** I used Claude to read all source files and identify bugs, then directed it to implement fixes and draft this document. I validated every non-trivial conclusion:

- **XSS fix:** Confirmed that `escapeHtml()` covers all user-controlled fields in the template string (notes, petId, sitterId are all escaped).
- **Race condition:** Verified the JS event-loop analysis — `await` yields control, so two in-flight requests can both pass the overlap check before either writes. Making the function synchronous is the correct fix for an in-memory store; a DB would need a transaction or unique constraint.
- **Pagination math:** Verified `(page - 1) * limit` is correct for 1-based pages and confirmed that the client sends page starting at `1`.
- **Closure behavior:** Verified that JS closures capture variable *bindings*, so the polling interval reads the current `filters` value — the code comment was wrong, not the code.
- **Schema validation approach:** Evaluated Zod vs Fastify built-in schema and agreed that built-in is appropriate here to avoid adding a dependency.

**What I chose not to rely on AI for:** Final prioritization decisions (e.g., whether role spoofing warranted a full fix now vs. a documented proposal), and the trade-off analysis in the improvement proposals — those required judgment about the specific constraints of this challenge context.
