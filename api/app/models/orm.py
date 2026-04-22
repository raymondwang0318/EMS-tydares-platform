"""
V2-final SQLAlchemy ORM models (ADR-026)

全部 17 張實體表集中在此檔，方便追蹤。
對應 db/v2_final_schema.sql
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON, TIMESTAMP, BigInteger, Boolean, CheckConstraint, Date, DateTime,
    Double, ForeignKey, Index, Integer, SmallInteger, String, Text,
    UniqueConstraint, func, text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


# =============================================================================
# Layer A — ems_*
# =============================================================================

class EmsEdge(Base):
    __tablename__ = "ems_edge"

    edge_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    edge_name: Mapped[str | None] = mapped_column(String(200))
    site_code: Mapped[str | None] = mapped_column(String(64))
    hostname: Mapped[str | None] = mapped_column(String(128))
    token_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    fingerprint: Mapped[str | None] = mapped_column(String(128))
    previous_fingerprints: Mapped[list | None] = mapped_column(JSONB, default=list)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    last_seen_ip: Mapped[str | None] = mapped_column(String(45))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    config_version: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    registered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by: Mapped[str | None] = mapped_column(String(128))
    maintenance_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    replaced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_reason: Mapped[str | None] = mapped_column(Text)
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','approved','maintenance','pending_replace','revoked')",
            name="chk_edge_status",
        ),
        Index("ix_edge_status", "status"),
    )


class EmsEdgeHeartbeat(Base):
    __tablename__ = "ems_edge_heartbeat"

    edge_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    hb_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    ip_addr: Mapped[str | None] = mapped_column(String(64))
    config_version: Mapped[int | None] = mapped_column(BigInteger)
    config_applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload_json: Mapped[dict | None] = mapped_column(JSONB)


class EmsDevice(Base):
    __tablename__ = "ems_device"

    device_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    edge_id: Mapped[str] = mapped_column(String(64), ForeignKey("ems_edge.edge_id"), nullable=False)
    device_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(200))
    model_id: Mapped[int | None] = mapped_column(BigInteger)
    config_version: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "device_kind IN ('modbus_meter','thermal','relay','bacnet','other')",
            name="chk_device_kind",
        ),
    )


class EmsDeviceModbus(Base):
    __tablename__ = "ems_device_modbus"

    device_id: Mapped[str] = mapped_column(String(64), ForeignKey("ems_device.device_id", ondelete="CASCADE"), primary_key=True)
    slave_id: Mapped[int] = mapped_column(Integer, nullable=False)
    bus_id: Mapped[str | None] = mapped_column(String(32))
    transport: Mapped[str] = mapped_column(String(16), nullable=False, default="rtu")
    tcp_host: Mapped[str | None] = mapped_column(String(64))
    tcp_port: Mapped[int | None] = mapped_column(Integer)
    poll_interval_sec: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    endianness: Mapped[str | None] = mapped_column(String(16), default="big")

    __table_args__ = (
        CheckConstraint("transport IN ('rtu','tcp')", name="chk_modbus_transport"),
        CheckConstraint("slave_id BETWEEN 1 AND 247", name="chk_modbus_slave"),
    )


class EmsDeviceThermal(Base):
    __tablename__ = "ems_device_thermal"

    device_id: Mapped[str] = mapped_column(String(64), ForeignKey("ems_device.device_id", ondelete="CASCADE"), primary_key=True)
    camera_model: Mapped[str | None] = mapped_column(String(64))
    mac_addr: Mapped[str | None] = mapped_column(String(32))
    zone_count: Mapped[int | None] = mapped_column(Integer, default=1)
    upload_interval_sec: Mapped[int | None] = mapped_column(Integer, default=5)


class EmsIngestInbox(Base):
    __tablename__ = "ems_ingest_inbox"

    idemp_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    edge_id: Mapped[str] = mapped_column(String(64), ForeignKey("ems_edge.edge_id"), nullable=False)
    device_id: Mapped[str | None] = mapped_column(String(64))
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    msg_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False)


class EmsCommand(Base):
    __tablename__ = "ems_commands"

    command_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    edge_id: Mapped[str] = mapped_column(String(64), ForeignKey("ems_edge.edge_id"), nullable=False)
    device_id: Mapped[str | None] = mapped_column(String(64), ForeignKey("ems_device.device_id"))
    command_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict | None] = mapped_column(JSONB)
    result_json: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="QUEUED")
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    not_before_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expire_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    issued_by: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "status IN ('QUEUED','DELIVERED','RUNNING','SUCCEEDED','FAILED','EXPIRED','CANCELED')",
            name="chk_commands_status",
        ),
    )


class EmsEvent(Base):
    __tablename__ = "ems_events"

    event_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True, server_default=func.now())
    event_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="info")
    edge_id: Mapped[str | None] = mapped_column(String(64))
    device_id: Mapped[str | None] = mapped_column(String(64))
    command_id: Mapped[str | None] = mapped_column(String(128))
    actor: Mapped[str | None] = mapped_column(String(128))
    message: Mapped[str | None] = mapped_column(String(2000))
    data_json: Mapped[dict | None] = mapped_column(JSONB)

    __table_args__ = (
        CheckConstraint(
            "event_kind IN ('command','operation','comm_abn','edge_lifecycle','config_sync')",
            name="chk_event_kind",
        ),
        CheckConstraint(
            "severity IN ('info','warn','error','critical')",
            name="chk_event_severity",
        ),
    )


# =============================================================================
# Layer B — fnd_*
# =============================================================================

class FndConfig(Base):
    __tablename__ = "fnd_config"

    config_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    config_code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    config_name: Mapped[str | None] = mapped_column(String(150))
    config_value: Mapped[str | None] = mapped_column(Text)
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FndElectricParameter(Base):
    __tablename__ = "fnd_electric_parameter"

    electric_parameter_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    parameter_code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    parameter_name: Mapped[str] = mapped_column(String(150), nullable=False)
    uom_name: Mapped[str | None] = mapped_column(String(30))
    data_type: Mapped[str | None] = mapped_column(String(30))
    decimal_place: Mapped[int | None] = mapped_column(Integer)
    parameter_category: Mapped[str | None] = mapped_column(String(30))
    display_seq: Mapped[int | None] = mapped_column(Integer)
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FndDeviceModel(Base):
    __tablename__ = "fnd_device_model"

    model_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    model_code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    model_name: Mapped[str] = mapped_column(String(150), nullable=False)
    model_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    vendor: Mapped[str | None] = mapped_column(String(100))
    slave_id_default: Mapped[int | None] = mapped_column(Integer)
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FndDeviceModelCircuit(Base):
    __tablename__ = "fnd_device_model_circuit"

    circuit_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    model_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("fnd_device_model.model_id", ondelete="CASCADE"), nullable=False)
    circuit_code: Mapped[str] = mapped_column(String(50), nullable=False)
    circuit_name: Mapped[str | None] = mapped_column(String(150))
    display_seq: Mapped[int | None] = mapped_column(Integer)
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (UniqueConstraint("model_id", "circuit_code"),)


class FndDeviceModelParam(Base):
    __tablename__ = "fnd_device_model_param"

    param_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    circuit_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("fnd_device_model_circuit.circuit_id", ondelete="CASCADE"), nullable=False)
    electric_parameter_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("fnd_electric_parameter.electric_parameter_id"), nullable=False)
    low_word_address: Mapped[int] = mapped_column(Integer, nullable=False)
    data_type: Mapped[str] = mapped_column(String(16), nullable=False)
    decimal_place: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    function_code: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (UniqueConstraint("circuit_id", "electric_parameter_id"),)


class FndEcsu(Base):
    __tablename__ = "fnd_ecsu"

    ecsu_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ecsu_code: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    ecsu_name: Mapped[str] = mapped_column(String(150), nullable=False)
    parent_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("fnd_ecsu.ecsu_id"))
    display_seq: Mapped[int | None] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FndEcsuCircuitAssgn(Base):
    __tablename__ = "fnd_ecsu_circuit_assgn"

    assgn_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ecsu_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("fnd_ecsu.ecsu_id", ondelete="CASCADE"), nullable=False)
    device_id: Mapped[str] = mapped_column(String(64), ForeignKey("ems_device.device_id", ondelete="CASCADE"), nullable=False)
    circuit_code: Mapped[str] = mapped_column(String(50), nullable=False)
    sign: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("ecsu_id", "device_id", "circuit_code"),
        CheckConstraint("sign IN (-1, 1)", name="chk_assgn_sign"),
    )


class FndBillingRule(Base):
    __tablename__ = "fnd_billing_rule"

    rule_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    rule_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    rule_code: Mapped[str] = mapped_column(String(50), nullable=False)
    rule_name: Mapped[str | None] = mapped_column(String(150))
    effective_from: Mapped[datetime | None] = mapped_column(Date)
    effective_to: Mapped[datetime | None] = mapped_column(Date)
    rule_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    display_seq: Mapped[int | None] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    remark_desc: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        CheckConstraint("rule_kind IN ('time_of_use','tier','period_map')", name="chk_rule_kind"),
        UniqueConstraint("rule_kind", "rule_code"),
    )


# =============================================================================
# Layer C — trx_* (非 ORM 通常直接走 SQL，但保留映射供查詢)
# =============================================================================

class TrxReading(Base):
    __tablename__ = "trx_reading"

    # hypertable 沒有單一 PK，用 composite 讓 SQLAlchemy 可識別
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    circuit_code: Mapped[str] = mapped_column(String(50), primary_key=True)
    parameter_code: Mapped[str] = mapped_column(String(50), primary_key=True)
    value: Mapped[float] = mapped_column(Double, nullable=False)
    quality: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
