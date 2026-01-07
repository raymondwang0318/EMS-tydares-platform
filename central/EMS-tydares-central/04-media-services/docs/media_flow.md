# 04-media-services

## Goal
Define how media/thermal files are stored and referenced.

## Principle
- Central EMS domain only stores media IDs/URIs, not blobs in business tables.
- Ingest writes metadata to inbox; later pipeline moves/normalizes storage.
