import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, theme, ConfigProvider } from 'antd';
import {
  DashboardOutlined,
  NodeIndexOutlined,
  ClusterOutlined,
  ApartmentOutlined,
  ThunderboltOutlined,
  DollarOutlined,
  BarChartOutlined,
  SettingOutlined,
  FireOutlined,
  CameraOutlined,
  LineChartOutlined,
  ApiOutlined,
  ControlOutlined,
} from '@ant-design/icons';
// M-PM-215 / T-AdminUI-002 方向 B：feature flag 控制設備型號 menu 顯示
import { FF_DEVICE_MODELS_ENABLED } from '../lib/featureFlags';

// M-PM-201 §1.3: Header 移除（含文字+背景）；只保留 Sider + Content
const { Sider, Content } = Layout;

// M-PM-215 / T-AdminUI-002 方向 B：menu items 依 feature flag 動態組裝
// 業主 5/12 chat：「Web UI 設備型號分頁，似乎不需要存在？型號已經掛載到設備 ID 裡面了」
// 預設 FF_DEVICE_MODELS_ENABLED=false → sidebar menu 隱藏；route + component code + schema 保留
const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '總覽' },
  { key: '/edges', icon: <NodeIndexOutlined />, label: 'Edge 管理' },
  { key: '/devices', icon: <ClusterOutlined />, label: '設備管理' },
  // M-PM-215：設備型號 menu 由 feature flag 控制
  ...(FF_DEVICE_MODELS_ENABLED
    ? [{ key: '/device-models', icon: <ApartmentOutlined />, label: '設備型號' }]
    : []),
  { key: '/ecsu', icon: <ThunderboltOutlined />, label: '計費單位 (ECSU)' },
  { key: '/billing', icon: <DollarOutlined />, label: '電價規則' },
  { key: '/ir-devices', icon: <FireOutlined />, label: 'IR 標籤管理' },
  { key: '/thermal/all', icon: <CameraOutlined />, label: '熱力圖即時監控' },
  // M-PM-289：§A 改名「遠端 I/O 操作」；§B 新增「遠端 I/O 設定」
  { key: '/io', icon: <ApiOutlined />, label: '遠端 I/O 操作' },
  { key: '/io-settings', icon: <ControlOutlined />, label: '遠端 I/O 設定' },
  { key: '/reports', icon: <BarChartOutlined />, label: '報表' },
  // M-PM-202：趨勢圖獨立分項；跟報表同級
  { key: '/trends', icon: <LineChartOutlined />, label: '趨勢圖' },
  { key: '/config', icon: <SettingOutlined />, label: '系統設定' },
];

export default function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { token: { colorBgContainer, borderRadiusLG } } = theme.useToken();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={220}
        style={{ background: '#e8f5e9' }}
      >
        <div style={{ height: 48, margin: 16, color: '#000000', fontSize: collapsed ? 14 : 14, fontWeight: 'bold', textAlign: 'center', lineHeight: '48px' }}>
          {/* M-PM-201 §1.2: 「EMS 工程維護」改「Tydares EMS — 工程維護」；collapsed 仍 EMS */}
          {collapsed ? 'EMS' : 'Tydares EMS — 工程維護'}
        </div>
        <ConfigProvider theme={{ components: { Menu: { itemBg: '#e8f5e9', itemColor: '#000000', itemHoverBg: '#c8e6c9', itemSelectedBg: '#a5d6a7', itemSelectedColor: '#000000', subMenuItemBg: '#e8f5e9', popupBg: '#e8f5e9' } } }}>
          <Menu
            mode="inline"
            selectedKeys={[location.pathname]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
          />
        </ConfigProvider>
      </Sider>
      <Layout>
        {/* M-PM-201 §1.3: Header bar 整塊移除（釋放垂直空間給內容區）*/}
        <Content style={{ margin: 16 }}>
          <div style={{ padding: 24, background: colorBgContainer, borderRadius: borderRadiusLG, minHeight: 360 }}>
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
