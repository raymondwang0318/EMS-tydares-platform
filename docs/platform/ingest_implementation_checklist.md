# Ingest Implementation Checklist

## v1 Freeze (Guardrails)

- Ingest is frozen as v1 (breaking changes allowed, but drift is not)
- No parallel ingest entrypoints are allowed
- HTTP shells (ORDS handlers) MUST NOT implement business logic
- Any ingest behavior change updates Edge + Central contracts and Appendix A first

## Purpose

Prevent semantic drift from Appendix A and `ingest_http_flow.md`.

## Entry Flow

- Overload check is executed before any other logic
- HTTP 503 is returned immediately on overload
- No token is consumed when returning 503

## Rate Limiting

- Token deduction uses single `UPDATE … RETURNING`
- No SELECT-before-UPDATE exists
- Retry-After is calculated in seconds
- Bounds come from `ems_ingest_settings` / `ems_ingest_constants`

## Inbox Handling

- No inbox write occurs on 503 or 429
- Deduplication runs only after passing rate limit

## HTTP Semantics

- Retry-After header unit is seconds
- 200 / 202 phase is driven by config
- Success is determined by body status

## Prohibitions

- No hard-coded numeric thresholds outside constants
- No logic added that is not described in Appendix A
- Any semantic change updates Appendix A first
- No new ingest endpoints (v1 only: `POST /ingest/{device_id}`)
