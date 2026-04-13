import React, { useState, useEffect, useRef, useCallback } from 'react';
import { API_BASE, getAuthHeaders } from '../../authStorage';
import './ElevatorPanel.scss';

const BUILDINGS = [
  { id: 'A', label: 'Tòa A', floors: 15, elevators: ['A1', 'A2', 'A3'] },
  { id: 'B', label: 'Tòa B', floors: 10,  elevators: ['B1', 'B2'] },
  { id: 'C', label: 'Tòa C', floors: 12, elevators: ['C1', 'C2', 'C3', 'C4'] },
];

function generateMockElevatorState(elevatorId, maxFloor) {
  const seed = elevatorId.charCodeAt(0) + elevatorId.charCodeAt(1);
  return {
    id: elevatorId,
    currentFloor: (seed % maxFloor) + 1,
    targetFloor: null,
    direction: ['up', 'down', 'idle'][seed % 3],
    speed: parseFloat((0.8 + Math.random() * 1.4).toFixed(2)),
    peopleCount: Math.floor(Math.random() * 8),
    maxCapacity: 12,
    status: ['online', 'online', 'online', 'maintenance'][seed % 4],
    doorStatus: ['closed', 'open', 'closed'][seed % 3],
    load: Math.floor(Math.random() * 80),
    temperature: (18 + Math.random() * 6).toFixed(1),
    lastService: '2026-04-05',
    upQueue: [],
    downQueue: [],
  };
}

function ElevatorPanel() {
  const [selectedBuilding, setSelectedBuilding] = useState(BUILDINGS[0]);
  const [selectedElevatorId, setSelectedElevatorId] = useState(BUILDINGS[0].elevators[0]);
  const [targetFloor, setTargetFloor] = useState(null);
  const [elevatorStates, setElevatorStates] = useState({});
  const [callLog, setCallLog] = useState([]);
//   const [isLoading, setIsLoading] = useState(false);
  const [calling, setCalling] = useState(false);
  const [error, setError] = useState('');
  const [animFloor, setAnimFloor] = useState(null);
  const shaftRef = useRef(null);
  const tickRef = useRef(null);

  // Initialize mock states
  useEffect(() => {
    const init = {};
    BUILDINGS.forEach((b) => {
      b.elevators.forEach((eid) => {
        init[eid] = generateMockElevatorState(eid, b.floors);
      });
    });
    setElevatorStates(init);
  }, []);

  // Simulate real-time elevator movement
  useEffect(() => {
    tickRef.current = setInterval(() => {
      setElevatorStates((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((eid) => {
          const el = { ...next[eid] };
          if (el.status === 'maintenance') return;

          // Move towards target
          if (el.targetFloor !== null && el.targetFloor !== el.currentFloor) {
            const delta = el.targetFloor > el.currentFloor ? 1 : -1;
            el.currentFloor = el.currentFloor + delta;
            el.direction = delta > 0 ? 'up' : 'down';
            el.speed = parseFloat((1.2 + Math.random() * 0.6).toFixed(2));

            if (el.currentFloor === el.targetFloor) {
              el.direction = 'idle';
              el.speed = 0;
              el.doorStatus = 'open';
              el.targetFloor = null;

              // Close door after 2 ticks
              setTimeout(() => {
                setElevatorStates((s) => ({
                  ...s,
                  [eid]: { ...s[eid], doorStatus: 'closed' },
                }));
              }, 2000);
            }
          } else if (!el.targetFloor) {
            // Random idle drift
            el.speed = 0;
            el.direction = 'idle';
          }

          // Slight people variation
          if (Math.random() < 0.04) {
            el.peopleCount = Math.max(0, Math.min(el.maxCapacity, el.peopleCount + (Math.random() > 0.5 ? 1 : -1)));
            el.load = Math.round((el.peopleCount / el.maxCapacity) * 100);
          }

          next[eid] = el;
        });
        return next;
      });
    }, 1000);

    return () => clearInterval(tickRef.current);
  }, []);

  const currentElevator = elevatorStates[selectedElevatorId] || null;

  const handleBuildingChange = (building) => {
    setSelectedBuilding(building);
    setSelectedElevatorId(building.elevators[0]);
    setTargetFloor(null);
    setError('');
    // Re-init any elevator states for this building that don't exist yet
    setElevatorStates((prev) => {
      const next = { ...prev };
      building.elevators.forEach((eid) => {
        if (!next[eid]) {
          next[eid] = generateMockElevatorState(eid, building.floors);
        } else {
          // Clamp currentFloor to new building's floor count
          if (next[eid].currentFloor > building.floors) {
            next[eid] = { ...next[eid], currentFloor: building.floors, targetFloor: null };
          }
        }
      });
      return next;
    });
  };

  const handleCallElevator = useCallback(async () => {
    if (!targetFloor || !currentElevator) return;
    if (currentElevator.status === 'maintenance') {
      setError('Thang máy đang bảo trì, không thể điều khiển.');
      return;
    }

    setCalling(true);
    setError('');

    const logEntry = {
      id: Date.now(),
      time: new Date().toLocaleTimeString('vi-VN'),
      elevator: selectedElevatorId,
      building: selectedBuilding.label,
      from: currentElevator.currentFloor,
      to: targetFloor,
      status: 'dispatched',
    };

    // Attempt real API call, fallback to mock
    try {
      const res = await fetch(`${API_BASE}/api/elevator/call`, {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({
          elevator_id: selectedElevatorId,
          building: selectedBuilding.id,
          target_floor: targetFloor,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'API error');
    } catch (_) {
      // Mock: update elevator state
      setElevatorStates((prev) => ({
        ...prev,
        [selectedElevatorId]: {
          ...prev[selectedElevatorId],
          targetFloor,
          direction: targetFloor > prev[selectedElevatorId]?.currentFloor ? 'up' : 'down',
        },
      }));
    }

    setCallLog((prev) => [logEntry, ...prev.slice(0, 19)]);
    setAnimFloor(targetFloor);
    setTimeout(() => setAnimFloor(null), 1200);
    setTargetFloor(null);
    setCalling(false);
  }, [targetFloor, currentElevator, selectedElevatorId, selectedBuilding]);

  const handleEmergencyStop = () => {
    setElevatorStates((prev) => ({
      ...prev,
      [selectedElevatorId]: {
        ...prev[selectedElevatorId],
        targetFloor: null,
        direction: 'idle',
        speed: 0,
        status: 'maintenance',
      },
    }));
    setCallLog((prev) => [
      {
        id: Date.now(),
        time: new Date().toLocaleTimeString('vi-VN'),
        elevator: selectedElevatorId,
        building: selectedBuilding.label,
        from: currentElevator?.currentFloor,
        to: '—',
        status: 'emergency',
      },
      ...prev.slice(0, 19),
    ]);
  };

  const handleRestoreElevator = () => {
    setElevatorStates((prev) => ({
      ...prev,
      [selectedElevatorId]: {
        ...prev[selectedElevatorId],
        status: 'online',
        direction: 'idle',
        speed: 0,
      },
    }));
  };

  const maxFloor = selectedBuilding.floors;
  const floors = Array.from({ length: maxFloor }, (_, i) => maxFloor - i);

  const floorPercent = currentElevator
    ? ((currentElevator.currentFloor - 1) / (maxFloor - 1)) * 100
    : 0;

  const directionIcon = !currentElevator
    ? '—'
    : currentElevator.direction === 'up'
    ? '▲'
    : currentElevator.direction === 'down'
    ? '▼'
    : '●';

  const statusColor = !currentElevator
    ? 'warning'
    : currentElevator.status === 'online'
    ? 'ok'
    : currentElevator.status === 'maintenance'
    ? 'danger'
    : 'warning';

  return (
    <div className="elevator-panel">
      {/* ── TOP CONTROLS ── */}
      <div className="elevator-panel__topbar">
        <div className="elevator-panel__intro">
          <div className="elevator-panel__badge">ELEVATOR CONTROL</div>
          <h3>Điều khiển thang máy</h3>
          <p>Chọn tòa, thang máy và tầng để điều phối hành trình tức thời.</p>
        </div>

        <div className="elevator-panel__selectors">
          {/* Building selector */}
          <div className="elevator-selector-group">
            <label>Chọn tòa nhà</label>
            <div className="elevator-btn-row">
              {BUILDINGS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`elevator-chip ${selectedBuilding.id === b.id ? 'active' : ''}`}
                  onClick={() => handleBuildingChange(b)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          {/* Elevator selector */}
          <div className="elevator-selector-group">
            <label>Chọn thang máy</label>
            <div className="elevator-btn-row">
              {selectedBuilding.elevators.map((eid) => {
                const st = elevatorStates[eid];
                const isOnline = st?.status === 'online';
                return (
                  <button
                    key={eid}
                    type="button"
                    className={`elevator-chip ${selectedElevatorId === eid ? 'active' : ''} ${!isOnline ? 'maintenance' : ''}`}
                    onClick={() => { setSelectedElevatorId(eid); setTargetFloor(null); }}
                  >
                    {eid}
                    <span className={`elevator-chip__dot dot--${isOnline ? 'ok' : 'danger'}`} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {error && <div className="elevator-panel__error">{error}</div>}

      <div className="elevator-panel__body">
        {/* ── LEFT: SHAFT VISUAL ── */}
        <div className="elevator-shaft-col">
          <div className="elevator-shaft-card">
            <div className="elevator-shaft-card__title">
              Trục thang — {selectedElevatorId}
              <span className={`status-badge status-badge--${statusColor}`}>
                {currentElevator?.status?.toUpperCase() || '—'}
              </span>
            </div>

            <div className="elevator-shaft" ref={shaftRef}>
              <div className="elevator-shaft__track">
                {floors.map((f) => {
                  const isCurrentFloor = currentElevator?.currentFloor === f;
                  const isTarget = currentElevator?.targetFloor === f;
                  const isAnimated = animFloor === f;
                  return (
                    <div
                      key={f}
                      className={`elevator-shaft__floor ${isCurrentFloor ? 'current' : ''} ${isTarget ? 'target' : ''} ${isAnimated ? 'anim-flash' : ''}`}
                    >
                      <span className="elevator-shaft__floor-label">
                        {f < 10 ? `0${f}` : f}
                      </span>
                      <div className="elevator-shaft__floor-line" />
                      {isCurrentFloor && (
                        <div className="elevator-shaft__car">
                          <div className="elevator-shaft__car-inner">
                            <span className="elevator-shaft__car-dir">{directionIcon}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Progress bar */}
            <div className="elevator-shaft__progress-wrap">
              <div className="elevator-shaft__progress-label">
                <span>Tầng 1</span>
                <span>Tầng {maxFloor}</span>
              </div>
              <div className="elevator-shaft__progress-bar">
                <div
                  className="elevator-shaft__progress-fill"
                  style={{ width: `${floorPercent}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ── CENTER: FLOOR BUTTONS + STATS ── */}
        <div className="elevator-center-col">
          {/* Live stats */}
          <div className="elevator-stats-grid">
            <div className="elevator-stat">
              <span>TẦNG HIỆN TẠI</span>
              <strong className="elevator-stat__big">
                {currentElevator ? String(currentElevator.currentFloor).padStart(2, '0') : '--'}
              </strong>
            </div>
            <div className="elevator-stat">
              <span>HƯỚNG DI CHUYỂN</span>
              <strong className={`elevator-stat__dir dir--${currentElevator?.direction || 'idle'}`}>
                {directionIcon} {currentElevator?.direction?.toUpperCase() || '—'}
              </strong>
            </div>
            <div className="elevator-stat">
              <span>TỐC ĐỘ (m/s)</span>
              <strong>{currentElevator ? `${currentElevator.speed} m/s` : '--'}</strong>
            </div>
            <div className="elevator-stat">
              <span>SỐ NGƯỜI</span>
              <strong>
                {currentElevator ? `${currentElevator.peopleCount} / ${currentElevator.maxCapacity}` : '--'}
              </strong>
            </div>
            <div className="elevator-stat">
              <span>TẢI TRỌNG</span>
              <strong>{currentElevator ? `${currentElevator.load}%` : '--'}</strong>
            </div>
            <div className="elevator-stat">
              <span>NHIỆT ĐỘ</span>
              <strong>{currentElevator ? `${currentElevator.temperature}°C` : '--'}</strong>
            </div>
            <div className="elevator-stat">
              <span>TRẠNG THÁI CỬA</span>
              <strong className={currentElevator?.doorStatus === 'open' ? 'text--open' : ''}>
                {currentElevator?.doorStatus?.toUpperCase() || '--'}
              </strong>
            </div>
            <div className="elevator-stat">
              <span>BẢO TRÌ GẦN NHẤT</span>
              <strong>{currentElevator?.lastService || '--'}</strong>
            </div>
          </div>

          {/* Load bar */}
          {currentElevator && (
            <div className="elevator-load-bar-wrap">
              <div className="elevator-load-bar-label">
                <span>Tải trọng</span>
                <span>{currentElevator.load}%</span>
              </div>
              <div className="elevator-load-bar">
                <div
                  className={`elevator-load-bar__fill ${currentElevator.load > 80 ? 'overload' : currentElevator.load > 60 ? 'heavy' : ''}`}
                  style={{ width: `${currentElevator.load}%` }}
                />
              </div>
            </div>
          )}

          {/* Floor buttons */}
          <div className="elevator-floor-panel">
            <div className="elevator-floor-panel__title">Chọn tầng muốn đến</div>
            <div className="elevator-floor-grid">
              {floors.map((f) => {
                const isCurrent = currentElevator?.currentFloor === f;
                const isTarget = currentElevator?.targetFloor === f;
                const isSelected = targetFloor === f;
                return (
                  <button
                    key={f}
                    type="button"
                    className={`elevator-floor-btn ${isCurrent ? 'current' : ''} ${isTarget ? 'moving-target' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={() => setTargetFloor(f === targetFloor ? null : f)}
                    disabled={isCurrent || currentElevator?.status === 'maintenance'}
                  >
                    {f}
                    {isCurrent && <span className="floor-btn-dot dot-current" />}
                    {isTarget && !isCurrent && <span className="floor-btn-dot dot-target" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Action buttons */}
          <div className="elevator-actions">
            <button
              type="button"
              className="elevator-call-btn"
              onClick={handleCallElevator}
              disabled={!targetFloor || calling || currentElevator?.status === 'maintenance'}
            >
              {calling
                ? 'Đang gọi...'
                : targetFloor
                ? `Gọi đến Tầng ${targetFloor}`
                : 'Chọn tầng để gọi'}
            </button>

            {currentElevator?.status === 'online' ? (
              <button
                type="button"
                className="elevator-emergency-btn"
                onClick={handleEmergencyStop}
              >
                ⚠ Dừng khẩn cấp
              </button>
            ) : (
              <button
                type="button"
                className="elevator-restore-btn"
                onClick={handleRestoreElevator}
              >
                ↺ Khôi phục thang máy
              </button>
            )}
          </div>
        </div>

        {/* ── RIGHT: ALL ELEVATORS OVERVIEW + CALL LOG ── */}
        <div className="elevator-right-col">
          {/* All elevators mini status */}
          <div className="elevator-overview-card">
            <div className="elevator-overview-card__title">Tổng quan — {selectedBuilding.label}</div>
            <div className="elevator-overview-list">
              {selectedBuilding.elevators.map((eid) => {
                const st = elevatorStates[eid];
                const isSelected = eid === selectedElevatorId;
                const dirIcon = !st ? '—' : st.direction === 'up' ? '▲' : st.direction === 'down' ? '▼' : '●';
                return (
                  <button
                    key={eid}
                    type="button"
                    className={`elevator-mini-card ${isSelected ? 'selected' : ''} ${st?.status === 'maintenance' ? 'maintenance' : ''}`}
                    onClick={() => { setSelectedElevatorId(eid); setTargetFloor(null); }}
                  >
                    <div className="elevator-mini-card__head">
                      <strong>{eid}</strong>
                      <span className={`status-dot status-dot--${st?.status === 'online' ? 'ok' : 'danger'}`} />
                    </div>
                    <div className="elevator-mini-card__floor">
                      Tầng <em>{st?.currentFloor ?? '--'}</em>
                    </div>
                    <div className="elevator-mini-card__meta">
                      <span>{dirIcon} {st?.direction?.toUpperCase() || '—'}</span>
                      <span>👤 {st?.peopleCount ?? 0}</span>
                    </div>
                    {st?.status === 'maintenance' && (
                      <div className="elevator-mini-card__maintenance-tag">BẢO TRÌ</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Call log */}
          <div className="elevator-log-card">
            <div className="elevator-log-card__title">
              Nhật ký điều phối
              <span className="elevator-log-card__count">{callLog.length}</span>
            </div>
            <div className="elevator-log-list">
              {callLog.length === 0 ? (
                <div className="elevator-log-empty">Chưa có lệnh gọi nào.</div>
              ) : (
                callLog.map((entry) => (
                  <div key={entry.id} className={`elevator-log-item log--${entry.status}`}>
                    <div className="elevator-log-item__meta">
                      <span>{entry.time}</span>
                      <em>{entry.elevator} · {entry.building}</em>
                    </div>
                    <div className="elevator-log-item__route">
                      Tầng {entry.from} → Tầng {entry.to}
                    </div>
                    <span className={`elevator-log-badge badge--${entry.status}`}>
                      {entry.status === 'emergency' ? '⚠ EMERGENCY' : '✓ DISPATCHED'}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ElevatorPanel;