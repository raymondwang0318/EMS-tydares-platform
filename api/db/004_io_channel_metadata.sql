-- =====================================================
-- Migration 004: I/O channel custom-name metadata
-- M-PM-293 §B 落地（M-P11-E44 升報 ②）
-- =====================================================
--
-- 內容：
-- 1. ems_device_channel_metadata — 遠端 I/O 模組（TCS300B03 DI / TCS300B04 DO）
--    每 channel 的業主自訂點位名稱（如「負壓風扇1 手動」）。
--    現況 admin-ui 點位名稱存 browser localStorage；Boss 無法透過 API 查詢。
--    本表讓點位名稱可透過 GET/PATCH /v1/admin/io/devices/{id}/channels 存取。
--
-- 設計：
-- - PK (device_id, channel)：每 device 每 channel 一筆
-- - device_id 存 DB-form（tcs300b03- / tcs300b04- prefix；經 _normalize_device_id）
-- - FK → ems_device(device_id) ON DELETE CASCADE（device 真刪則點位名稱一起清）
-- - channel 1-16（DI/DO 模組均 16 通道）
-- - custom_name nullable（無自訂時回 null，前端 fallback 預設名）
--
-- Idempotent：CREATE TABLE IF NOT EXISTS（再跑不出錯）
--
-- 前置：
-- - ems_device 已存在（ADR-026 V2-final）
-- - 遠端 I/O device row（tcs300b03-/tcs300b04- prefix）由 ScanWizard / confirm_devices 建
--
-- 採證：M-P12-084 §B（無既建 ems_device_channel_metadata；ems_device 無 metadata JSONB）
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ems_device_channel_metadata (
    device_id    VARCHAR(64)  NOT NULL,
    channel      INT          NOT NULL,
    custom_name  VARCHAR(100),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, channel),
    CONSTRAINT chk_io_channel_range CHECK (channel >= 1 AND channel <= 16),
    CONSTRAINT fk_io_channel_device
        FOREIGN KEY (device_id) REFERENCES ems_device(device_id) ON DELETE CASCADE
);

COMMENT ON TABLE ems_device_channel_metadata IS
    'M-PM-293 §B：遠端 I/O 模組每 channel 業主自訂點位名稱（DI/DO；device_id DB-form）';

COMMIT;
