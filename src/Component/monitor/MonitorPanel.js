import React from 'react';
import './MonitorPanel.scss';

function MonitorPanel() {
  return (
    <div className="monitor-panel">
      <div className="monitor-panel__header">
        <div>
          <div className="monitor-panel__tag">MONITOR</div>
          <h3>Monitor hệ thống</h3>
          <p>Khung này sẽ dùng để gắn camera AI / trạng thái monitor ở phase tiếp theo.</p>
        </div>
      </div>

      <div className="monitor-panel__preview">
        <div className="monitor-panel__preview-overlay" />
        <div className="monitor-panel__preview-center">
          <img
            src="/logo/SmartElevatorLogo1.png"
            alt="SmartElevator"
            className="monitor-panel__preview-logo"
          />
          <h4>SmartElevator Monitor</h4>
          <span>Preview / Control Surface</span>
        </div>
      </div>

      <div className="monitor-panel__stats">
        <div className="monitor-stat-card">
          <span className="monitor-stat-card__label">VISION STATUS</span>
          <strong>STANDBY</strong>
        </div>
        <div className="monitor-stat-card">
          <span className="monitor-stat-card__label">CAMERA</span>
          <strong>NOT STARTED</strong>
        </div>
        <div className="monitor-stat-card">
          <span className="monitor-stat-card__label">EVENT STREAM</span>
          <strong>IDLE</strong>
        </div>
      </div>

      <div className="monitor-panel__actions">
        <button type="button">Mở monitor</button>
        <button type="button">Health check</button>
        <button type="button">Reload dữ liệu</button>
      </div>
    </div>
  );
}

export default MonitorPanel;