# Ingest HTTP Entry Flow (Normative)

Status: Normative  
Authority: Appendix A (Implementation Blueprint)

## Purpose

Define the mandatory HTTP ingress flow for `/ingest/*`.
All implementations (ORDS, API Gateway, app server) MUST follow this order and semantics.

This document defines what must happen, not how it is implemented.

## Mandatory Flow Order

Every ingest request MUST execute the following steps in order:

1. Global Overload Short-Circuit
2. Per-Device Rate Limit (Token Bucket)
3. Inbox Ingest & Deduplication
4. HTTP Acknowledgement (200 / 202)

This order MUST NOT be changed.

## Step 1 — Global Overload Short-Circuit (HTTP 503)

Call `ems_ingest_overload.check_overload()`.

If `is_overloaded = 1`:

- MUST immediately return HTTP 503
- MUST NOT consume rate-limit tokens
- MUST NOT write to inbox
- MUST set response header:
  - `Retry-After: <retry_after_sec>` (unit: seconds)
- Response body SHOULD follow error-code conventions; minimal body is allowed.

Rationale: Protect database and workers under sustained overload.

## Step 2 — Per-Device Rate Limit (HTTP 429)

Call `ems_ingest_rate_limit.try_consume_token(bucket_key)`.

If `allowed = 0`:

- MUST return HTTP 429
- MUST set `Retry-After` header (unit: seconds)
- MUST NOT write to inbox

Rationale: Enforce fair usage per device without global side effects.

## Step 3 — Inbox Ingest & Deduplication

- Persist payload to inbox
- Apply deduplication rules (idempotency)
- Processing mode MUST be asynchronous (inbox → worker); ingress MUST NOT synchronously write core tables.

## Step 4 — HTTP Acknowledgement (200 / 202)

Phase is controlled by `ems_ingest_settings.get_ack_http_phase()`.

- Phase 1:
  - MAY return HTTP 200
- Phase 2:
  - MUST return HTTP 202

Success MUST be determined by response body `status`, not HTTP code alone.

## Prohibited Behaviors

- Consuming rate-limit tokens before overload check
- Writing inbox records when returning 503 or 429
- Returning `Retry-After` in units other than seconds
- Changing semantics without updating Appendix A
