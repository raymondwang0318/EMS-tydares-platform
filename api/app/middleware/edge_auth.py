"""Edge three-layer authentication middleware (ADR-021).

Layer 1: Per-edge token — verify token ↔ edge_id binding
Layer 2: Hardware fingerprint — verify X-Edge-Fingerprint matches registered fingerprint
Layer 3: Whitelist — verify edge status is 'approved'

Maintenance replacement flow:
- maintenance status + valid token → accept new fingerprint → pending_replace
- pending_replace → requires admin approval before full access

This middleware applies to Edge-facing endpoints only (ingest, commands).
Admin endpoints use their own token validation.
"""

from __future__ import annotations

import logging
from typing import Optional

import bcrypt
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger("edge_auth")


class EdgeAuthResult:
    def __init__(self, allowed: bool, edge_id: str = "", error: str = "", status_code: int = 200):
        self.allowed = allowed
        self.edge_id = edge_id
        self.error = error
        self.status_code = status_code


async def verify_edge_identity(
    db: AsyncSession,
    token: str,
    edge_id: str,
    fingerprint: Optional[str] = None,
    remote_ip: Optional[str] = None,
) -> EdgeAuthResult:
    """Three-layer Edge authentication.

    Args:
        db: Database session
        token: Bearer token from Authorization header
        edge_id: Edge ID from request body or URL path
        fingerprint: SHA256 hardware fingerprint from X-Edge-Fingerprint header
        remote_ip: Client IP for logging

    Returns:
        EdgeAuthResult with allowed=True or error details
    """

    # --- Layer 1: Token ↔ edge_id binding ---

    result = await db.execute(
        text("SELECT token_hash, fingerprint, status FROM ems_edge_credential WHERE edge_id = :eid"),
        {"eid": edge_id},
    )
    cred = result.fetchone()

    if cred is None:
        # Unknown edge — auto-register as 'pending' if token is in global allow list
        # For Phase 0: accept and create pending record
        log.info("New edge registration: edge_id=%s ip=%s", edge_id, remote_ip)
        token_hash = bcrypt.hashpw(token.encode(), bcrypt.gensalt()).decode()
        await db.execute(
            text("""
                INSERT INTO ems_edge_credential (edge_id, token_hash, fingerprint, status, hostname, last_seen_ip)
                VALUES (:eid, :thash, :fp, 'pending', :eid, :ip)
                ON CONFLICT (edge_id) DO NOTHING
            """),
            {"eid": edge_id, "thash": token_hash, "fp": fingerprint, "ip": remote_ip},
        )
        await db.commit()
        return EdgeAuthResult(
            allowed=False,
            edge_id=edge_id,
            error="Edge registered as pending — awaiting admin approval",
            status_code=403,
        )

    token_hash, registered_fp, status = cred[0], cred[1], cred[2]

    # Verify token matches
    if not bcrypt.checkpw(token.encode(), token_hash.encode()):
        log.warning("Token mismatch for edge_id=%s ip=%s", edge_id, remote_ip)
        return EdgeAuthResult(
            allowed=False,
            edge_id=edge_id,
            error="Token does not match edge_id",
            status_code=403,
        )

    # --- Layer 2: Fingerprint binding ---

    if fingerprint and registered_fp:
        if fingerprint != registered_fp:
            # Fingerprint mismatch — possible device clone or replacement
            if status == 'maintenance':
                # Expected replacement: record new fingerprint, move to pending_replace
                log.info("Maintenance replacement detected: edge_id=%s new_fp=%s", edge_id, fingerprint[:16])
                await db.execute(
                    text("""
                        UPDATE ems_edge_credential
                        SET fingerprint_prev = fingerprint,
                            fingerprint = :fp,
                            status = 'pending_replace',
                            last_seen_ip = :ip,
                            last_seen_at = NOW()
                        WHERE edge_id = :eid
                    """),
                    {"eid": edge_id, "fp": fingerprint, "ip": remote_ip},
                )
                await db.commit()
                return EdgeAuthResult(
                    allowed=False,
                    edge_id=edge_id,
                    error="Hardware replacement detected — awaiting admin confirmation",
                    status_code=403,
                )
            else:
                # Unexpected fingerprint change — alert
                log.warning(
                    "FINGERPRINT MISMATCH: edge_id=%s expected=%s got=%s ip=%s",
                    edge_id, registered_fp[:16], fingerprint[:16], remote_ip,
                )
                return EdgeAuthResult(
                    allowed=False,
                    edge_id=edge_id,
                    error="Hardware fingerprint mismatch — possible device clone",
                    status_code=403,
                )

    elif fingerprint and not registered_fp:
        # First time fingerprint registration — bind it
        log.info("Binding fingerprint for edge_id=%s fp=%s", edge_id, fingerprint[:16])
        await db.execute(
            text("UPDATE ems_edge_credential SET fingerprint = :fp WHERE edge_id = :eid"),
            {"eid": edge_id, "fp": fingerprint},
        )

    # --- Layer 3: Whitelist status check ---

    if status == 'revoked':
        log.warning("Revoked edge attempted access: edge_id=%s", edge_id)
        return EdgeAuthResult(
            allowed=False,
            edge_id=edge_id,
            error="Edge has been revoked",
            status_code=403,
        )

    if status == 'pending':
        return EdgeAuthResult(
            allowed=False,
            edge_id=edge_id,
            error="Edge pending admin approval",
            status_code=403,
        )

    if status == 'pending_replace':
        return EdgeAuthResult(
            allowed=False,
            edge_id=edge_id,
            error="Hardware replacement pending admin confirmation",
            status_code=403,
        )

    if status == 'maintenance':
        # Maintenance but fingerprint matches (same hardware) — still allow
        pass

    # --- All layers passed: update last_seen ---

    await db.execute(
        text("""
            UPDATE ems_edge_credential
            SET last_seen_at = NOW(), last_seen_ip = :ip
            WHERE edge_id = :eid
        """),
        {"eid": edge_id, "ip": remote_ip},
    )

    return EdgeAuthResult(allowed=True, edge_id=edge_id)
