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
} from '@ant-design/icons';

const { Sider, Content, Header } = Layout;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '總覽' },
  { key: '/edges', icon: <NodeIndexOutlined />, label: 'Edge 管理' },
  { key: '/devices', icon: <ClusterOutlined />, label: '設備管理' },
  { key: '/device-models', icon: <ApartmentOutlined />, label: '設備型號' },
  { key: '/ecsu', icon: <ThunderboltOutlined />, label: '計費單位 (ECSU)' },
  { key: '/billing', icon: <DollarOutlined />, label: '電價規則' },
  { key: '/reports', icon: <BarChartOutlined />, label: '報表' },
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
        <div style={{ height: 48, margin: 16, color: '#000000', fontSize: collapsed ? 14 : 16, fontWeight: 'bold', textAlign: 'center', lineHeight: '48px' }}>
          {collapsed ? 'EMS' : 'EMS 工程維護'}
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
        <Header style={{ padding: '0 24px', background: colorBgContainer, fontSize: 16, fontWeight: 'bold' }}>
          Tydares EMS — 工程維護後台
        </Header>
        <Content style={{ margin: 16 }}>
          <div style={{ padding: 24, background: colorBgContainer, borderRadius: borderRadiusLG, minHeight: 360 }}>
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
