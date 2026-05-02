/**
 * HistoryTable — Reports 履歷列表 generic component（[[T-Reports-001]] §AC 2.2）
 *
 * 設計目標：
 * - Energy + Thermal Tab 共用；columns 可配置
 * - row 粒度由 granularity prop 決定（5/15/60min/day）；資料層 caller 負責 ts bucket aggregation
 * - 事件 marker inline 5 態徽章（沿用 [[useAlerts]] computeDeviceHealth/severityColor）
 * - 點擊事件 marker → 展開 detail Modal（caller 可注入 onEventClick；fallback inline alert list）
 * - 預設按時間 DESC（最新在上）；sorter 開啟讓使用者切換
 *
 * 不負責：
 * - fetch（caller 控）
 * - 視角切換（caller 控；不同視角不同 columns 配置即可）
 * - granularity selector UI（caller 控；本 component 純展示）
 */
import { useMemo } from 'react';
import { Card, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  severityColor,
  severityLabel,
  type AlertHistoryEvent,
  type AlertSeverity,
} from '../hooks/useAlerts';

const { Text } = Typography;

export type Granularity = '5min' | '15min' | '1hr' | '1day';

/** 單欄定義；caller 決定 column 數量 / 順序 / 單位 */
export interface HistoryColumnSpec<T> {
  key: keyof T | string;
  title: string;
  unit?: string;
  width?: number;
  precision?: number;
  /** 自訂 render；若未提供則用 number → fixed(precision) + unit */
  render?: (val: unknown, row: T, index: number) => React.ReactNode;
}

export interface HistoryRow {
  ts: string; // ISO 8601；caller 已 floor 到 granularity bucket
  /** 對齊本 row ts bucket 的事件清單（caller 負責對齊；本 component 純顯示）*/
  events?: AlertHistoryEvent[];
  /** 動態 metric 欄位 */
  [metric: string]: unknown;
}

export interface HistoryTableProps<T extends HistoryRow = HistoryRow> {
  columns: HistoryColumnSpec<T>[];
  data: T[];
  loading?: boolean;
  granularity?: Granularity;
  emptyText?: string;
  /** 事件 marker 點擊回呼（caller 通常開 detail Modal）*/
  onEventClick?: (event: AlertHistoryEvent, row: T) => void;
  title?: React.ReactNode;
  pageSize?: number;
}

const TS_FORMAT_BY_GRAN: Record<Granularity, string> = {
  '5min': 'YYYY-MM-DD HH:mm',
  '15min': 'YYYY-MM-DD HH:mm',
  '1hr': 'YYYY-MM-DD HH:mm',
  '1day': 'YYYY-MM-DD',
};

/** 把 alert severity 集合摺疊成 1 個 inline 徽章（取最高 severity）*/
function summarizeEvents(events: AlertHistoryEvent[] | undefined): {
  severity: AlertSeverity | null;
  count: number;
} {
  if (!events || events.length === 0) return { severity: null, count: 0 };
  const has = (s: AlertSeverity) => events.some((e) => e.severity === s);
  if (has('critical')) return { severity: 'critical', count: events.length };
  if (has('warning')) return { severity: 'warning', count: events.length };
  if (has('info')) return { severity: 'info', count: events.length };
  return { severity: null, count: events.length };
}

export default function HistoryTable<T extends HistoryRow = HistoryRow>(
  props: HistoryTableProps<T>,
) {
  const {
    columns,
    data,
    loading,
    granularity = '15min',
    emptyText = '時段內無資料',
    onEventClick,
    title,
    pageSize = 25,
  } = props;

  const tsFormat = TS_FORMAT_BY_GRAN[granularity];

  const tableColumns = useMemo<ColumnsType<T>>(() => {
    const cols: ColumnsType<T> = [
      {
        title: '時間',
        dataIndex: 'ts',
        key: 'ts',
        width: 170,
        sorter: (a: T, b: T) => dayjs(a.ts).valueOf() - dayjs(b.ts).valueOf(),
        defaultSortOrder: 'descend' as const,
        render: (v: string) => dayjs(v).format(tsFormat),
      },
    ];

    columns.forEach((c) => {
      cols.push({
        title: (
          <Space size={4}>
            <span>{c.title}</span>
            {c.unit && <Text type="secondary" style={{ fontSize: 11 }}>({c.unit})</Text>}
          </Space>
        ),
        key: String(c.key),
        dataIndex: String(c.key),
        width: c.width,
        render: (val: unknown, row: T, idx: number) => {
          if (c.render) return c.render(val, row, idx);
          if (val === null || val === undefined) return <Text type="secondary">—</Text>;
          if (typeof val === 'number' && Number.isFinite(val)) {
            const p = c.precision ?? 2;
            return val.toFixed(p);
          }
          return String(val);
        },
      });
    });

    cols.push({
      title: '事件',
      key: '__events__',
      width: 100,
      render: (_: unknown, row: T) => {
        const { severity, count } = summarizeEvents(row.events);
        if (!severity) return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>;
        const tag = (
          <Tag
            color={severityColor(severity)}
            style={{ cursor: onEventClick ? 'pointer' : 'default', marginRight: 0 }}
            onClick={() => {
              if (!onEventClick || !row.events?.length) return;
              onEventClick(row.events[0], row);
            }}
          >
            {severityLabel(severity)} × {count}
          </Tag>
        );
        return (
          <Tooltip title={`${count} 件事件；點擊查看詳情`}>{tag}</Tooltip>
        );
      },
    });

    return cols;
  }, [columns, tsFormat, onEventClick]);

  const card = (
    <Card size="small" title={title}>
      {data.length === 0 && !loading ? (
        <Empty description={emptyText} />
      ) : (
        <Table<T>
          rowKey="ts"
          columns={tableColumns}
          dataSource={data}
          loading={loading}
          size="small"
          pagination={{ pageSize }}
          showSorterTooltip
        />
      )}
    </Card>
  );

  return card;
}
