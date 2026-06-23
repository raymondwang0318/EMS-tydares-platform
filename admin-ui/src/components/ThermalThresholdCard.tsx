/**
 * 熱像溫度閾值（全 811C 統一）設定卡（M-PM-313 階段2 P1；§3.6.1）。
 *
 * 放在 IR 標籤管理頁「藍色提示」與「設備列表」之間。讀/寫 ems_alarm_rule
 * 三級閾值（info 60 / warn 75 / critical 90）+ 啟用開關。
 * 後端：v1_admin_alarms.py（GET/PATCH /v1/admin/alarm-rules）。
 *
 * 三級語意：提醒(info) / 警告(warn) / 嚴重異常(critical)。
 * ⚠️ critical 觸發時 Alarm Evaluator 自動 notify_pananora=TRUE → Boss UI 可讀 + 發 mail。
 *
 * 老王 2026-06-09 回饋：三級改橫式並排；儲存鍵可操作（無變更時提示，非 disable）。
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, InputNumber, Space, Spin, Typography, message } from 'antd';
import {
  useThermalAlarmRules,
  useUpdateAlarmRule,
  type AlarmRule,
} from '../hooks/useAlarmRules';

const { Text } = Typography;

const SEV_LABEL: Record<string, string> = {
  info: '提醒（info）',
  warn: '警告（warn）',
  critical: '嚴重異常（critical）',
};
const SEV_ORDER: Record<string, number> = { info: 1, warn: 2, critical: 3 };

interface LocalRow {
  rule_id: number;
  severity: string;
  threshold_value: number;
  enabled: boolean;
}

export default function ThermalThresholdCard() {
  const { data, isLoading, error } = useThermalAlarmRules();
  const update = useUpdateAlarmRule();
  const [rows, setRows] = useState<LocalRow[]>([]);
  const [saving, setSaving] = useState(false);

  // 後端資料載入 / 變更 → 同步本地編輯狀態
  useEffect(() => {
    if (!data) return;
    const sorted = [...data].sort(
      (a, b) => (SEV_ORDER[a.severity] ?? 99) - (SEV_ORDER[b.severity] ?? 99),
    );
    setRows(
      sorted.map((r: AlarmRule) => ({
        rule_id: r.rule_id,
        severity: r.severity,
        threshold_value: r.threshold_value,
        enabled: r.enabled,
      })),
    );
  }, [data]);

  const setRow = (rule_id: number, patch: Partial<LocalRow>) =>
    setRows((prev) => prev.map((r) => (r.rule_id === rule_id ? { ...r, ...patch } : r)));

  const handleSave = async () => {
    if (!data) return;
    const changed = rows.filter((row) => {
      const orig = data.find((d) => d.rule_id === row.rule_id);
      return (
        orig &&
        (orig.threshold_value !== row.threshold_value || orig.enabled !== row.enabled)
      );
    });
    if (changed.length === 0) {
      message.info('目前無變更');
      return;
    }
    setSaving(true);
    try {
      await Promise.all(
        changed.map((row) =>
          update.mutateAsync({
            rule_id: row.rule_id,
            patch: { threshold_value: row.threshold_value, enabled: row.enabled },
          }),
        ),
      );
      message.success('熱像溫度閾值已儲存');
    } catch (e: any) {
      message.error(`儲存失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      size="small"
      title="🌡️ 熱像溫度閾值（全 811C 統一）"
      style={{ marginBottom: 16, maxWidth: 760 }}
    >
      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="載入閾值設定失敗"
          description={String((error as any)?.message ?? error)}
        />
      )}
      <Spin spinning={isLoading}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {/* 三級橫式並排 */}
          <Space size={28} wrap align="start">
            {rows.map((row) => (
              <div key={row.rule_id}>
                <div style={{ marginBottom: 6 }}>
                  <Text strong>{SEV_LABEL[row.severity] ?? row.severity}</Text>
                </div>
                <Space size={8} align="center">
                  <InputNumber
                    min={0}
                    max={300}
                    step={1}
                    value={row.threshold_value}
                    onChange={(v) => setRow(row.rule_id, { threshold_value: Number(v ?? 0) })}
                    addonAfter="°C"
                    style={{ width: 110 }}
                  />
                  <Checkbox
                    checked={row.enabled}
                    onChange={(e) => setRow(row.rule_id, { enabled: e.target.checked })}
                  >
                    啟用
                  </Checkbox>
                </Space>
              </div>
            ))}
          </Space>
          <Text type="warning" style={{ fontSize: 12 }}>
            ⚠️ 「嚴重異常（critical）」觸發時會讓 Pananora 前台讀得到 + 發送 mail 通知。
          </Text>
          <Button type="primary" onClick={handleSave} loading={saving} disabled={isLoading}>
            💾 儲存
          </Button>
        </Space>
      </Spin>
    </Card>
  );
}
