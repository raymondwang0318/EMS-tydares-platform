import { useEffect, useState } from 'react';
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
}

interface FormFieldDef {
  name: string;
  label: string;
  type: 'text' | 'number' | 'textarea';
  required?: boolean;
}

export default function CrudTable({ title, apiPath, columns, formFields, rowKey }: CrudTableProps) {
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
        <Button icon={<EditOutlined />} size="small" onClick={() => handleEdit(record)} />
        <Popconfirm title="確定刪除？" onConfirm={() => handleDelete(record[rowKey])}>
          <Button icon={<DeleteOutlined />} size="small" danger />
        </Popconfirm>
      </Space>
    ),
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>{title}</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增</Button>
      </div>

      <Table
        columns={[...columns, actionColumn]}
        dataSource={data}
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
