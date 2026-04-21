import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Empty, Typography } from 'antd';
import AdminLayout from './layouts/AdminLayout';
import Edges from './pages/Edges';

const { Title, Paragraph } = Typography;

function PlaceholderPage({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>{title}</Title>
      <Empty description={hint ?? '此頁將於後續 Phase 實作'} />
    </div>
  );
}

function LoginPlaceholder() {
  return (
    <div style={{ padding: 48, maxWidth: 480, margin: '64px auto' }}>
      <Title level={3}>Token 失效</Title>
      <Paragraph>
        目前 Admin UI 尚未實作登入頁（屬另立 ADR 範疇）。
        請更新環境變數 <code>VITE_API_TOKEN</code> 後重新整理。
      </Paragraph>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/admin-ui">
      <Routes>
        <Route path="/login" element={<LoginPlaceholder />} />
        <Route element={<AdminLayout />}>
          <Route path="/" element={<PlaceholderPage title="總覽 (Dashboard)" hint="Phase 2.3 建骨架、Phase 3+ 填內容" />} />
          <Route path="/edges" element={<Edges />} />
          <Route path="/devices" element={<PlaceholderPage title="設備管理" hint="Phase 4 實作" />} />
          <Route path="/device-models" element={<PlaceholderPage title="設備型號" hint="Phase 5a 實作" />} />
          <Route path="/ecsu" element={<PlaceholderPage title="計費單位 (ECSU)" hint="Phase 5a 實作" />} />
          <Route path="/billing" element={<PlaceholderPage title="電價規則" hint="Phase 5b 實作" />} />
          <Route path="/reports" element={<PlaceholderPage title="報表" hint="Phase 5b 實作" />} />
          <Route path="/config" element={<PlaceholderPage title="系統設定" hint="Phase 2.3 建骨架" />} />
          <Route path="*" element={<PlaceholderPage title="404" hint="此頁不存在，請從左側選單導航" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
