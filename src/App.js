import React, { useEffect, useMemo, useState } from 'react';
import LoginScript from './Component/login/LoginScript';
import Sidebar from './Component/layout/Sidebar';
import ControlPage from './Component/pages/ControlPage';
import CameraPanel from './Component/camera/CameraPanel';
import DatabasePanel from './Component/database/DatabasePanel';
import MaintenancePanel from './Component/maintenance/MaintenancePanel';
import ElevatorPanel from './Component/elevator/ElevatorPanel';
import AdministratorPanel from './Component/administrator/AdministratorPanel';

function App() {
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('control');

  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin && activeTab === 'administrator') {
      setActiveTab('control');
    }
  }, [activeTab, isAdmin]);

  const pageMeta = useMemo(() => {
    if (activeTab === 'camera') {
      return {
        badge: 'Recognition System',
        title: ' Hệ thống giám sát camera AI',
        description: 'Theo dõi camera, trạng thái AI vision và cụm điều khiển trên camera.',
      };
    }

    if (activeTab === 'database') {
      return {
        badge: 'Database Management',
        title: 'Cơ sở dữ liệu MongoDB',
        description: 'Theo dõi personnels, events, thống kê dữ liệu và các bảng dashboard hệ thống.',
      };
    }

    if (activeTab === 'maintenance') {
      return {
        badge: 'Maintenance System',
        title: 'Bảo trì hệ thống',
        description: 'Theo dõi tình trạng hệ thống, lịch bảo trì và các tác vụ kỹ thuật vận hành.',
      };
    }

    if (activeTab === 'elevator') {
      return {
        badge: 'Elevator Control ( Đang phát triển )',
        title: 'Điều khiển thang máy',
        description: 'Gọi tầng, theo dõi vị trí, tốc độ, số người và trạng thái thang máy theo thời gian thực.',
      };
    }

    if (activeTab === 'administrator') {
      return {
        badge: 'Administrator Console ( Đang phát triển )',
        title: 'Bảng điều khiển quản trị viên',
        description: 'Không gian riêng cho admin để chẩn đoán hệ thống, endpoint, incident và vận hành backend/web.',
      };
    }

    return {
      badge: 'System Control Panel',
      title: 'Điều khiển hệ thống',
      description: 'Giám sát tổng quan monitor và thao tác chatbot ngay trên dashboard.',
    };
  }, [activeTab]);

  if (!user) {
    return <LoginScript onLoginSuccess={setUser} />;
  }

  return (
    <div className="system-shell">
      <div className="system-bg-glow glow-a" />
      <div className="system-bg-glow glow-b" />

      <div className="dashboard-shell">
        <Sidebar
          activeTab={activeTab}
          onChangeTab={setActiveTab}
          user={user}
        />

        <div className="dashboard-main">
          <header className="dashboard-topbar">
            <div className="dashboard-topbar__brand">
              <img
                src="/logo/SmartElevatorLogo1.png"
                alt="SmartElevator Logo"
                className="dashboard-topbar__brand-logo"
              />
              <div>
                <h1>SmartElevator</h1>
                <p>Control Dashboard</p>
              </div>
            </div>

            <div className="dashboard-topbar__page-meta">
              <div className="dashboard-topbar__badge">{pageMeta.badge}</div>
              <h2>{pageMeta.title}</h2>
              <p>{pageMeta.description}</p>
            </div>

            <div className="dashboard-topbar__actions">
              <div className="dashboard-user-chip">
                <span className="dashboard-user-chip__label">User name</span>
                <strong>{user.username}</strong>
                {isAdmin && (
                  <small style={{ display: 'block', color: '#7ec3ff', marginTop: 4 }}>
                    ADMIN MODE
                  </small>
                )}
              </div>

              <button
                type="button"
                className="dashboard-logout-btn"
                onClick={() => {
                  setActiveTab('control');
                  setUser(null);
                }}
              >
                Đăng xuất
              </button>
            </div>
          </header>

          <main className="dashboard-content">
            {activeTab === 'control' && <ControlPage />}
            {activeTab === 'camera' && <CameraPanel />}
            {activeTab === 'database' && <DatabasePanel />}
            {activeTab === 'maintenance' && <MaintenancePanel />}
            {activeTab === 'elevator' && <ElevatorPanel />}
            {activeTab === 'administrator' && isAdmin && <AdministratorPanel user={user} />}
          </main>
        </div>
      </div>
    </div>
  );
}

export default App;