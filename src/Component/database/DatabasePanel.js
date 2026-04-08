import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './DatabasePanel.scss';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:5000';

const initialFilters = {
  date: '',
  event_type: '',
  cam_id: '',
  person_id: '',
  person_name: '',
};

function DatabasePanel() {
  const [stats, setStats] = useState({
    total_personnels: 0,
    total_events: 0,
    latest_event: null,
    event_counts: {},
    generated_at: '',
  });

  const [personnels, setPersonnels] = useState([]);
  const [events, setEvents] = useState([]);

  const [filters, setFilters] = useState(initialFilters);

  const [loadingStats, setLoadingStats] = useState(false);
  const [loadingPersonnels, setLoadingPersonnels] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const [error, setError] = useState('');

  const chartData = useMemo(() => {
    const counts = stats?.event_counts || {};
    return [
      { name: 'LYING', value: counts.LYING || 0 },
      { name: 'FALL', value: counts.FALL || 0 },
      { name: 'BOTTLE', value: counts.BOTTLE || 0 },
      { name: 'CROWD', value: counts.CROWD || 0 },
    ];
  }, [stats]);

  const latestEventText = useMemo(() => {
    if (!stats?.latest_event) return '--';

    const latest = stats.latest_event;
    const type = latest.event_type || 'EVENT';
    const person = latest.person_name || 'Unknown';
    const time = latest.timestamp || latest.time || '--';

    return `${type} - ${person} - ${time}`;
  }, [stats]);

  const loadAllData = useCallback(async () => {
    setError('');
    await Promise.allSettled([
      fetchStats(),
      fetchPersonnels(),
      fetchEvents(filters),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  const fetchStats = async () => {
    setLoadingStats(true);
    try {
      const res = await fetch(`${API_BASE}/api/mongo/stats`);
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || 'Không lấy được stats');
      }

      setStats(data.stats || {});
    } catch (err) {
      setError(err.message || 'Lỗi lấy thống kê MongoDB');
    } finally {
      setLoadingStats(false);
    }
  };

  const fetchPersonnels = async () => {
    setLoadingPersonnels(true);
    try {
      const res = await fetch(`${API_BASE}/api/mongo/personnels?limit=100`);
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || 'Không lấy được personnels');
      }

      setPersonnels(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setError(err.message || 'Lỗi lấy personnels');
    } finally {
      setLoadingPersonnels(false);
    }
  };

  const fetchEvents = async (filterValues = filters) => {
    setLoadingEvents(true);
    try {
      const params = new URLSearchParams();

      Object.entries(filterValues).forEach(([key, value]) => {
        if (value !== null && value !== undefined && String(value).trim() !== '') {
          params.append(key, value);
        }
      });

      params.append('limit', '100');

      const res = await fetch(`${API_BASE}/api/mongo/events?${params.toString()}`);
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || 'Không lấy được events');
      }

      setEvents(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setError(err.message || 'Lỗi lấy events');
    } finally {
      setLoadingEvents(false);
    }
  };

  const handleFilterChange = (field, value) => {
    setFilters((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleApplyFilters = async () => {
    await fetchEvents(filters);
  };

  const handleResetFilters = async () => {
    setFilters(initialFilters);
    await fetchEvents(initialFilters);
  };

  return (
    <div className="database-panel">
      <div className="database-panel__header">
        <div className="database-panel__header-text">
          <div className="database-panel__badge">MONGODB</div>
          <h3>Dữ liệu MongoDB</h3>
          <p>
            Hiển thị personnels, events, thống kê tổng quan và biểu đồ dữ liệu thật từ backend.
          </p>
        </div>

        <div className="database-panel__header-actions">
          <button
            type="button"
            onClick={loadAllData}
            disabled={loadingStats || loadingPersonnels || loadingEvents}
          >
            {loadingStats || loadingPersonnels || loadingEvents ? 'Đang tải...' : 'Refresh dữ liệu'}
          </button>
        </div>
      </div>

      {error && <div className="database-panel__error">{error}</div>}

      <div className="database-panel__stats">
        <div className="database-stat-card">
          <span>TỔNG PERSONNELS</span>
          <strong>{loadingStats ? '...' : stats.total_personnels ?? 0}</strong>
        </div>

        <div className="database-stat-card">
          <span>TỔNG EVENTS</span>
          <strong>{loadingStats ? '...' : stats.total_events ?? 0}</strong>
        </div>

        <div className="database-stat-card">
          <span>LATEST EVENT</span>
          <strong className="database-stat-card__small">
            {loadingStats ? '...' : latestEventText}
          </strong>
        </div>

        <div className="database-stat-card">
          <span>UPDATED AT</span>
          <strong className="database-stat-card__small">
            {loadingStats ? '...' : stats.generated_at || '--'}
          </strong>
        </div>
      </div>

      <div className="database-panel__middle">
        <div className="database-card">
          <div className="database-card__title">Biểu đồ event</div>

          <div className="database-chart-wrap">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData}>
                <CartesianGrid stroke="rgba(80,145,255,0.12)" vertical={false} />
                <XAxis dataKey="name" stroke="rgba(176,210,235,1)" />
                <YAxis stroke="rgba(176,210,235,1)" />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(7,15,29,0.96)',
                    border: '1px solid rgba(69,157,255,0.16)',
                    borderRadius: '12px',
                    color: '#fff',
                  }}
                />
                <Bar dataKey="value" radius={[8, 8, 0, 0]} fill="rgba(30,144,255,0.88)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="database-card">
          <div className="database-card__title">Bộ lọc events</div>

          <div className="database-filters">
            <div className="database-filter-field">
              <label>Ngày</label>
              <input
                type="date"
                value={filters.date}
                onChange={(e) => handleFilterChange('date', e.target.value)}
              />
            </div>

            <div className="database-filter-field">
              <label>Event type</label>
              <select
                value={filters.event_type}
                onChange={(e) => handleFilterChange('event_type', e.target.value)}
              >
                <option value="">Tất cả</option>
                <option value="LYING">LYING</option>
                <option value="FALL">FALL</option>
                <option value="BOTTLE">BOTTLE</option>
                <option value="CROWD">CROWD</option>
              </select>
            </div>

            <div className="database-filter-field">
              <label>Camera</label>
              <input
                type="text"
                placeholder="Ví dụ: 0"
                value={filters.cam_id}
                onChange={(e) => handleFilterChange('cam_id', e.target.value)}
              />
            </div>

            <div className="database-filter-field">
              <label>Person ID</label>
              <input
                type="text"
                placeholder="Ví dụ: 1"
                value={filters.person_id}
                onChange={(e) => handleFilterChange('person_id', e.target.value)}
              />
            </div>

            <div className="database-filter-field database-filter-field--wide">
              <label>Person name</label>
              <input
                type="text"
                placeholder="Ví dụ: Nguyen Van Dat"
                value={filters.person_name}
                onChange={(e) => handleFilterChange('person_name', e.target.value)}
              />
            </div>
          </div>

          <div className="database-filter-actions">
            <button
              type="button"
              onClick={handleApplyFilters}
              disabled={loadingEvents}
            >
              {loadingEvents ? 'Đang lọc...' : 'Áp dụng lọc'}
            </button>

            <button
              type="button"
              className="secondary"
              onClick={handleResetFilters}
              disabled={loadingEvents}
            >
              Reset
            </button>
          </div>
        </div>
      </div>

      <div className="database-panel__grid">
        <div className="database-card">
          <div className="database-card__title">
            Bảng personnels
            <span className="database-card__count">
              {loadingPersonnels ? '...' : `${personnels.length} records`}
            </span>
          </div>

          <div className="database-table-wrap">
            <table className="database-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Person ID</th>
                  <th>Họ tên</th>
                  <th>Mã NV</th>
                  <th>Bộ phận</th>
                  <th>Ngày sinh</th>
                </tr>
              </thead>
              <tbody>
                {loadingPersonnels ? (
                  <tr>
                    <td colSpan="6" className="database-table__empty">
                      Đang tải personnels...
                    </td>
                  </tr>
                ) : personnels.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="database-table__empty">
                      Không có dữ liệu personnels.
                    </td>
                  </tr>
                ) : (
                  personnels.map((item) => (
                    <tr key={`${item._id}_${item.person_id}`}>
                      <td>{item._id}</td>
                      <td>{item.person_id}</td>
                      <td>{item.ho_ten}</td>
                      <td>{item.ma_nv}</td>
                      <td>{item.bo_phan}</td>
                      <td>{item.ngay_sinh}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="database-card">
          <div className="database-card__title">
            Bảng events
            <span className="database-card__count">
              {loadingEvents ? '...' : `${events.length} records`}
            </span>
          </div>

          <div className="database-table-wrap">
            <table className="database-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Event</th>
                  <th>Camera</th>
                  <th>Person</th>
                  <th>Person ID</th>
                  <th>Date</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {loadingEvents ? (
                  <tr>
                    <td colSpan="7" className="database-table__empty">
                      Đang tải events...
                    </td>
                  </tr>
                ) : events.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="database-table__empty">
                      Không có dữ liệu events.
                    </td>
                  </tr>
                ) : (
                  events.map((item) => (
                    <tr key={`${item._id}_${item.timestamp}`}>
                      <td>{item._id}</td>
                      <td>{item.event_type}</td>
                      <td>{item.cam_id}</td>
                      <td>{item.person_name || 'Unknown'}</td>
                      <td>{item.person_id ?? '--'}</td>
                      <td>{item.date}</td>
                      <td>{item.time}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DatabasePanel;