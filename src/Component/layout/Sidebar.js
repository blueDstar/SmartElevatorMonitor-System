import React, { useMemo } from 'react';
import './Sidebar.scss';

function Sidebar({ activeTab, onChangeTab, user }) {
  const isAdmin = user?.role === 'admin';

  const items = useMemo(() => {
    const baseItems = [
      { key: 'control', label: 'Dashboard', icon: '/logo/dashboard.png' },
      { key: 'camera', label: 'Camera AI', icon: '/logo/Camera1.png' },
      { key: 'elevator', label: 'Elevator', icon: '/logo/Elevator1.png' },
      { key: 'database', label: 'MongoDB', icon: '/logo/database.png' },
      { key: 'maintenance', label: 'Maintenance', icon: '/logo/maintenance.png' },
    ];

    if (isAdmin) {
      baseItems.push({
        key: 'administrator',
        label: 'Administrator',
        icon: '/logo/Administrator1.png',
        adminOnly: true,
      });
    }

    return baseItems;
  }, [isAdmin]);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div className="sidebar__brand-logo-wrap">
          <img
            src="/logo/SmartElevatorLogo1.png"
            alt="SmartElevator Logo"
            className="sidebar__brand-logo"
          />
        </div>

        <div className="sidebar__brand-text">
          <h3>SmartElevator</h3>
          <span>System Navigation</span>
        </div>
      </div>

      <nav className="sidebar__nav">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`sidebar__nav-item ${activeTab === item.key ? 'active' : ''} ${item.adminOnly ? 'sidebar__nav-item--admin' : ''}`}
            onClick={() => onChangeTab(item.key)}
          >
            <span className="sidebar__nav-icon">
              <img
                src={item.icon}
                alt={item.label}
                className="sidebar__nav-icon-image"
              />
            </span>

            <span className="sidebar__nav-label">{item.label}</span>

            {item.adminOnly && (
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                  color: '#7ec3ff',
                }}
              >
                ADMIN ONLY
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar__footer">
        <div className="sidebar__footer-card">
          <span className="sidebar__footer-label">SYSTEM MODE</span>
          <strong>{isAdmin ? 'SMART CONTROL / ADMIN' : 'SMART CONTROL'}</strong>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;