import { useEffect, useMemo, useState } from 'react';
import { Table, Button, Space, Modal, Form, Input, InputNumber, message, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import api from '../services/api';

interface CrudTableProps {
  title: string;
  apiPath: string;
  columns: ColumnsType<any>;
  formFields: FormFieldDef[];
  rowKey: string;
  /**
   * 是否隱藏「新增」按鈕（設 `true` 用於「新增全走另一流程」的頁面；
   * 例：Modbus 設備管理走 Wizard 掃描批次匯入，手動新增會造成 dirty data）
   */
  hideAdd?: boolean;
  /**
   * 是否隱藏每列「刪除」按鈕（設 `true` 用於安全保護）
   */
  hideDelete?: boolean;
  /**
   * 是否隱藏每列「編輯」按鈕
   */
  hideEdit?: boolean;
  /** 頁面 header 下的提示文字（例：引導用戶走另一流程） */
  hintText?: React.ReactNode;
  /**
   * Toolbar 額外注入點（顯示在「新增」按鈕旁；典型用於 filter Select）
   * M-PM-176 / T-AdminUI-004 設備管理 Edge filter 下拉用
   */
  toolbarExtra?: React.ReactNode;
  /**
   * 純 frontend filter（apply 在 fetch 後；不影響 backend 請求）
   * M-PM-176 / T-AdminUI-004 設備管理頁 Edge filter 用
   */
  filterFn?: (row: any) => boolean;
}

interface FormFieldDef {
  name: string;
  label: string;
  type: 'text' | 'number' | 'textarea';
  required?: boolean;
}

export default function CrudTable({
  title,
  apiPath,
  columns,
  formFields,
  rowKey,
  hideAdd = false,
  hideDelete = false,
  hideEdit = false,
  hintText,
  toolbarExtra,
  filterFn,
}: CrudTableProps) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get(apiPath);
      setData(res.data.items || res.data || []);
    } catch (e: any) {
      message.error(`載入失敗: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [apiPath]);

  const handleAdd = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const handleEdit = (record: any) => {
    setEditing(record);
    form.setFieldsValue(record);
    setModalOpen(true);
  };

  const handleDelete = async (id: any) => {
    try {
      await api.delete(`${apiPath}/${id}`);
      message.success('已刪除');
      fetchData();
    } catch (e: any) {
      message.error(`刪除失敗: ${e.message}`);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        await api.put(`${apiPath}/${editing[rowKey]}`, values);
        message.success('已更新');
      } else {
        await api.post(apiPath, values);
        message.success('已新增');
      }
      setModalOpen(false);
      fetchData();
    } catch (e: any) {
      if (e.errorFields) return; // form validation
      message.error(`儲存失敗: ${e.message}`);
    }
  };

  const actionColumn = {
    title: '操作',
    key: 'actions',
    width: 150,
    render: (_: any, record: any) => (
      <Space>
        {!hideEdit && (
          <Button icon={<EditOutlined />} size="small" onClick={() => handleEdit(record)} />
        )}
        {!hideDelete && (
          <Popconfirm title="確定刪除？" onConfirm={() => handleDelete(record[rowKey])}>
            <Button icon={<DeleteOutlined />} size="small" danger />
          </Popconfirm>
        )}
      </Space>
    ),
  };

  // 若所有操作都被隱藏 → 不顯示操作欄
  const showActionColumn = !hideEdit || !hideDelete;

  // M-PM-176 / T-AdminUI-004：純 frontend filter（filterFn 由 caller 注入）
  const displayData = useMemo(
    () => (filterFn ? data.filter(filterFn) : data),
    [data, filterFn],
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {!hideAdd && (
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增</Button>
        )}
      </div>
      {hintText && (
        <div style={{ marginBottom: 16 }}>{hintText}</div>
      )}
      {toolbarExtra && (
        // 老王 5/8 chat：「沒有看到所屬 Edge 下拉選單」
        // 修：toolbarExtra 從 header 右側（被 space-between 推到視窗外）移到獨立工具列
        // 顯著位置：hintText 下、Table 上；左對齊；窄螢幕也能見
        <div style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {toolbarExtra}
        </div>
      )}

      <Table
        columns={showActionColumn ? [...columns, actionColumn] : columns}
        dataSource={displayData}
        rowKey={rowKey}
        loading={loading}
        size="middle"
        pagination={{ pageSize: 20 }}
      />

      <Modal
        title={editing ? `編輯${title}` : `新增${title}`}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        okText="儲存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          {formFields.map((f) => (
            <Form.Item
              key={f.name}
              name={f.name}
              label={f.label}
              rules={f.required ? [{ required: true, message: `請輸入${f.label}` }] : []}
            >
              {f.type === 'number' ? (
                <InputNumber style={{ width: '100%' }} />
              ) : f.type === 'textarea' ? (
                <Input.TextArea rows={3} />
              ) : (
                <Input />
              )}
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </>
  );
}
