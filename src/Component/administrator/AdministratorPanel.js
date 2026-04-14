import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { API_BASE, getAuthHeaders, withAccessToken } from '../../authStorage';
import './AdministratorPanel.scss';

const ADMIN_NOTE_KEY = 'smartelevator_admin_notes';
const ADMIN_INCIDENT_KEY = 'smartelevator_admin_incident_ack';

function AdministratorPanel({ user }) {
  const [systemHealth, setSystemHealth] = useState(null);
  const [cameraStatus, setCameraStatus] = useState(null);
  const [mongoHealth, setMongoHealth] = useState(null);
  const [mongoStats, setMongoStats] = useState(null);
  const [chatbotHealth, setChatbotHealth] = useState(null);
  const [logs, setLogs] = useState([]);
  const [probeResults, setProbeResults] = useState([]);
  const [browserInfo, setBrowserInfo] = useState(null);

  const [loading, setLoading] = useState(false);
  const [probing, setProbing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState(null);

  const [adminNotes, setAdminNotes] = useState(() => {
    try {
      return localStorage.getItem(ADMIN_NOTE_KEY) || '';
    } catch {
      return '';
    }
  });

  const [acknowledgedIncidentIds, setAcknowledgedIncidentIds] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(ADMIN_INCIDENT_KEY) || '[]');
    } catch {
      return [];
    }
  });

  const saveNotes = useCallback((value) => {
    setAdminNotes(value);
    try {
      localStorage.setItem(ADMIN_NOTE_KEY, value);
    } catch {
      // ignore
    }
  }, []);

  const saveAcknowledgedIncidents = useCallback((ids) => {
    setAcknowledgedIncidentIds(ids);
    try {
      localStorage.setItem(ADMIN_INCIDENT_KEY, JSON.stringify(ids));
    } catch {
      // ignore
    }
  }, []);

  const captureBrowserInfo = useCallback(() => {
    const nav = window.navigator;
    const timing = window.performance;
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;

    setBrowserInfo({
      userAgent: nav.userAgent,
      language: nav.language,
      platform: nav.platform,
      online: nav.onLine,
      cookieEnabled: nav.cookieEnabled,
      memory: performance?.memory
        ? {
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            usedJSHeapSize: performance.memory.usedJSHeapSize,
          }
        : null,
      connection: connection
        ? {
            effectiveType: connection.effectiveType,
            downlink: connection.downlink,
            rtt: connection.rtt,
            saveData: connection.saveData,
          }
        : null,
      pageLoadMs:
        timing?.timing?.navigationStart && timing?.timing?.loadEventEnd
          ? Math.max(0, timing.timing.loadEventEnd - timing.timing.navigationStart)
          : null,
      screen: {
        width: window.screen.width,
        height: window.screen.height,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    });
  }, []);

  const fetchJsonWithLatency = useCallback(async (url) => {
    const startedAt = performance.now();
    const response = await fetch(url, { headers: getAuthHeaders(false) });
    const endedAt = performance.now();
    const latencyMs = Math.round(endedAt - startedAt);
    const data = await response.json();
    return { response, data, latencyMs };
  }, []);

  const loadAdminData = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [
        systemRes,
        cameraRes,
        mongoRes,
        mongoStatsRes,
        chatbotRes,
        logsRes,
      ] = await Promise.all([
        fetchJsonWithLatency(`${API_BASE}/api/system/health`),
        fetchJsonWithLatency(`${API_BASE}/api/camera/status`),
        fetchJsonWithLatency(`${API_BASE}/api/mongo/health`),
        fetchJsonWithLatency(`${API_BASE}/api/mongo/stats`),
        fetchJsonWithLatency(`${API_BASE}/api/chatbot/health`),
        fetchJsonWithLatency(`${API_BASE}/api/logs/recent?limit=160`),
      ]);

      if (!systemRes.data?.success) {
        throw new Error(systemRes.data?.error || 'Không lấy được system health');
      }

      setSystemHealth({ ...systemRes.data, latencyMs: systemRes.latencyMs });
      setCameraStatus({
        ...(cameraRes.data?.status || {}),
        latencyMs: cameraRes.latencyMs,
      });
      setMongoHealth({ ...(mongoRes.data || {}), latencyMs: mongoRes.latencyMs });
      setMongoStats({
        ...(mongoStatsRes.data?.stats || {}),
        latencyMs: mongoStatsRes.latencyMs,
      });
      setChatbotHealth({ ...(chatbotRes.data || {}), latencyMs: chatbotRes.latencyMs });
      setLogs(Array.isArray(logsRes.data?.items) ? logsRes.data.items : []);
      setLastRefresh(new Date().toLocaleString('vi-VN'));
      captureBrowserInfo();
    } catch (err) {
      setError(err.message || 'Không tải được dữ liệu Administrator');
    } finally {
      setLoading(false);
    }
  }, [captureBrowserInfo, fetchJsonWithLatency]);

  useEffect(() => {
    loadAdminData();

    const interval = setInterval(() => {
      loadAdminData();
    }, 15000);

    return () => clearInterval(interval);
  }, [loadAdminData]);

  const runEndpointProbes = useCallback(async () => {
    setProbing(true);

    const endpoints = [
      { key: 'system-health', label: 'System Health', url: `${API_BASE}/api/system/health` },
      { key: 'camera-status', label: 'Camera Status', url: `${API_BASE}/api/camera/status` },
      {
        key: 'camera-preview',
        label: 'Camera Preview',
        url: withAccessToken(`${API_BASE}/api/camera/preview`),
      },
      { key: 'mongo-health', label: 'Mongo Health', url: `${API_BASE}/api/mongo/health` },
      { key: 'mongo-stats', label: 'Mongo Stats', url: `${API_BASE}/api/mongo/stats` },
      { key: 'chatbot-health', label: 'Chatbot Health', url: `${API_BASE}/api/chatbot/health` },
      { key: 'logs-recent', label: 'Logs Recent', url: `${API_BASE}/api/logs/recent?limit=20` },
    ];

    const results = [];

    for (const endpoint of endpoints) {
      const startedAt = performance.now();
      try {
        const response = await fetch(endpoint.url, {
          cache: 'no-store',
          headers: getAuthHeaders(false),
        });
        const endedAt = performance.now();
        const latencyMs = Math.round(endedAt - startedAt);

        results.push({
          ...endpoint,
          status: response.ok ? 'ok' : 'warning',
          httpStatus: response.status,
          latencyMs,
        });
      } catch (err) {
        const endedAt = performance.now();
        results.push({
          ...endpoint,
          status: 'error',
          httpStatus: '--',
          latencyMs: Math.round(endedAt - startedAt),
          error: err.message,
        });
      }
    }

    setProbeResults(results);
    setProbing(false);
  }, []);

  const moduleSummary = useMemo(() => {
    const summary = {
      camera: { INFO: 0, WARNING: 0, ERROR: 0 },
      mongo: { INFO: 0, WARNING: 0, ERROR: 0 },
      chatbot: { INFO: 0, WARNING: 0, ERROR: 0 },
      system: { INFO: 0, WARNING: 0, ERROR: 0 },
      auth: { INFO: 0, WARNING: 0, ERROR: 0 },
    };

    logs.forEach((item) => {
      const moduleName = String(item.module || 'system').toLowerCase();
      const level = String(item.level || 'INFO').toUpperCase();

      if (!summary[moduleName]) {
        summary[moduleName] = { INFO: 0, WARNING: 0, ERROR: 0 };
      }

      if (!summary[moduleName][level]) {
        summary[moduleName][level] = 0;
      }

      summary[moduleName][level] += 1;
    });

    return summary;
  }, [logs]);

  const incidents = useMemo(() => {
    const list = [];

    if (cameraStatus?.mode === 'error') {
      list.push({
        id: 'camera-mode-error',
        severity: 'critical',
        title: 'Vision runtime đang ở trạng thái lỗi',
        detail: cameraStatus?.note || 'Camera worker đang lỗi',
      });
    }

    if (mongoHealth && mongoHealth.success === false) {
      list.push({
        id: 'mongo-disconnect',
        severity: 'critical',
        title: 'MongoDB không phản hồi',
        detail: mongoHealth.error || 'Không lấy được Mongo health',
      });
    }

    if (chatbotHealth && (!chatbotHealth.db_ok || !chatbotHealth.model_exists)) {
      list.push({
        id: 'chatbot-runtime-warning',
        severity: 'high',
        title: 'Chatbot runtime chưa sẵn sàng',
        detail: !chatbotHealth.model_exists
          ? 'Model chatbot chưa sẵn sàng'
          : 'Chatbot chưa kết nối DB ổn định',
      });
    }

    const errorLogs = logs.filter((item) => String(item.level).toUpperCase() === 'ERROR');
    const warningLogs = logs.filter((item) => String(item.level).toUpperCase() === 'WARNING');

    if (errorLogs.length > 0) {
      list.push({
        id: 'error-log-burst',
        severity: 'high',
        title: `Phát hiện ${errorLogs.length} log ERROR`,
        detail: 'Cần rà soát hệ thống backend và service phụ thuộc',
      });
    }

    if (warningLogs.length >= 5) {
      list.push({
        id: 'warning-log-burst',
        severity: 'medium',
        title: `Phát hiện ${warningLogs.length} log WARNING`,
        detail: 'Hệ thống có tín hiệu bất ổn nhẹ cần theo dõi',
      });
    }

    if (cameraStatus?.running && (cameraStatus?.fps ?? 0) < 3) {
      list.push({
        id: 'low-fps-camera',
        severity: 'medium',
        title: 'FPS camera thấp',
        detail: `FPS hiện tại: ${cameraStatus?.fps ?? 0}`,
      });
    }

    if (
      cameraStatus?.running &&
      cameraStatus?.preview_ready === false &&
      cameraStatus?.last_frame_ts &&
      Date.now() / 1000 - Number(cameraStatus.last_frame_ts) > 8
    ) {
      list.push({
        id: 'preview-stale',
        severity: 'high',
        title: 'Preview camera bị stale',
        detail: 'Camera chạy nhưng frame preview không cập nhật gần đây',
      });
    }

    return list;
  }, [cameraStatus, mongoHealth, chatbotHealth, logs]);

  const unacknowledgedIncidents = useMemo(() => {
    return incidents.filter((item) => !acknowledgedIncidentIds.includes(item.id));
  }, [incidents, acknowledgedIncidentIds]);

  const systemCards = useMemo(() => {
    return [
      {
        label: 'Admin Session',
        value: user?.role === 'admin' ? 'ADMIN ACTIVE' : 'UNKNOWN',
        detail: user?.username || '--',
        status: 'ok',
      },
      {
        label: 'Backend API',
        value: systemHealth?.success ? 'ONLINE' : 'OFFLINE',
        detail: `Latency ${systemHealth?.latencyMs ?? '--'} ms`,
        status: systemHealth?.success ? 'ok' : 'danger',
      },
      {
        label: 'Vision Runtime',
        value: cameraStatus?.running ? 'RUNNING' : cameraStatus?.mode?.toUpperCase() || 'STOPPED',
        detail: cameraStatus?.note || 'No note',
        status: cameraStatus?.running ? 'ok' : cameraStatus?.mode === 'error' ? 'danger' : 'warning',
      },
      {
        label: 'MongoDB',
        value: mongoHealth?.success ? 'HEALTHY' : 'DOWN',
        detail: `Latency ${mongoHealth?.latencyMs ?? '--'} ms`,
        status: mongoHealth?.success ? 'ok' : 'danger',
      },
      {
        label: 'Chatbot',
        value:
          chatbotHealth?.success && chatbotHealth?.db_ok && chatbotHealth?.model_exists
            ? 'READY'
            : 'DEGRADED',
        detail: `Latency ${chatbotHealth?.latencyMs ?? '--'} ms`,
        status:
          chatbotHealth?.success && chatbotHealth?.db_ok && chatbotHealth?.model_exists
            ? 'ok'
            : 'warning',
      },
      {
        label: 'Incident Queue',
        value: String(unacknowledgedIncidents.length),
        detail: `${incidents.length} total incidents`,
        status: unacknowledgedIncidents.length > 0 ? 'danger' : 'ok',
      },
    ];
  }, [user, systemHealth, cameraStatus, mongoHealth, chatbotHealth, unacknowledgedIncidents, incidents]);

  const auditRows = useMemo(() => {
    return Object.entries(moduleSummary).map(([moduleName, values]) => ({
      module: moduleName,
      info: values.INFO || 0,
      warning: values.WARNING || 0,
      error: values.ERROR || 0,
      total: (values.INFO || 0) + (values.WARNING || 0) + (values.ERROR || 0),
    }));
  }, [moduleSummary]);

  const derivedRecommendations = useMemo(() => {
    const recs = [];

    if (cameraStatus?.running && (cameraStatus?.fps ?? 0) < 4) {
      recs.push('Giảm tải vision bằng cách tăng YOLO every n hoặc giảm pose frequency.');
    }

    if (mongoHealth?.success === false) {
      recs.push('Rà soát URI MongoDB, network route, và quyền collection.');
    }

    if (chatbotHealth && !chatbotHealth.model_exists) {
      recs.push('Kiểm tra CHAT_ROUTER_API và quyền truy cập model chatbot.');
    }

    if (logs.some((item) => String(item.message).toLowerCase().includes('preview'))) {
      recs.push('Theo dõi pipeline preview/frame encoder để tránh stale image trên web.');
    }

    if (recs.length === 0) {
      recs.push('Hệ thống đang ổn định. Tiếp tục giám sát định kỳ và lưu diagnostic snapshot.');
    }

    return recs;
  }, [cameraStatus, mongoHealth, chatbotHealth, logs]);

  const exportSnapshot = useCallback(() => {
    setExporting(true);

    try {
      const snapshot = {
        exported_at: new Date().toISOString(),
        admin_user: user,
        systemHealth,
        cameraStatus,
        mongoHealth,
        mongoStats,
        chatbotHealth,
        logs: logs.slice(0, 120),
        probeResults,
        browserInfo,
        incidents,
        unacknowledgedIncidents,
        derivedRecommendations,
        adminNotes,
      };

      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: 'application/json;charset=utf-8',
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `administrator_snapshot_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [
    adminNotes,
    browserInfo,
    cameraStatus,
    chatbotHealth,
    derivedRecommendations,
    incidents,
    logs,
    mongoHealth,
    mongoStats,
    probeResults,
    systemHealth,
    unacknowledgedIncidents,
    user,
  ]);

  const copyAdminSummary = useCallback(async () => {
    const summary = [
      `Admin: ${user?.username || '--'}`,
      `System: ${systemHealth?.success ? 'ONLINE' : 'OFFLINE'}`,
      `Vision: ${cameraStatus?.running ? 'RUNNING' : cameraStatus?.mode || 'STOPPED'}`,
      `Mongo: ${mongoHealth?.success ? 'HEALTHY' : 'DOWN'}`,
      `Chatbot: ${
        chatbotHealth?.success && chatbotHealth?.db_ok && chatbotHealth?.model_exists
          ? 'READY'
          : 'DEGRADED'
      }`,
      `Incidents: ${unacknowledgedIncidents.length}`,
      `FPS: ${cameraStatus?.fps ?? 0}`,
      `People: ${cameraStatus?.people_count ?? 0}`,
      `Last refresh: ${lastRefresh || '--'}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(summary);
      alert('Đã copy admin summary.');
    } catch {
      alert(summary);
    }
  }, [user, systemHealth, cameraStatus, mongoHealth, chatbotHealth, unacknowledgedIncidents, lastRefresh]);

  const acknowledgeIncident = useCallback((id) => {
    if (acknowledgedIncidentIds.includes(id)) return;
    saveAcknowledgedIncidents([...acknowledgedIncidentIds, id]);
  }, [acknowledgedIncidentIds, saveAcknowledgedIncidents]);

  return (
    <div className="administrator-panel">
      <div className="administrator-panel__hero">
        <div className="administrator-panel__hero-text">
          <div className="administrator-panel__badge">ADMINISTRATOR MODE</div>
          <h3>Administrator Console</h3>
          <p>
            Bảng điều khiển riêng cho quản trị viên để giám sát backend, web client, incident queue,
            endpoint probe, diagnostic snapshot và audit vận hành toàn hệ thống.
          </p>
        </div>

        <div className="administrator-panel__hero-actions">
          <button type="button" onClick={loadAdminData} disabled={loading}>
            {loading ? 'Đang làm mới...' : 'Refresh system'}
          </button>

          <button type="button" onClick={runEndpointProbes} disabled={probing}>
            {probing ? 'Đang probe...' : 'Endpoint Probe'}
          </button>

          <button type="button" onClick={copyAdminSummary}>
            Copy Summary
          </button>

          <button type="button" onClick={exportSnapshot} disabled={exporting}>
            {exporting ? 'Đang xuất...' : 'Export Snapshot'}
          </button>
        </div>
      </div>

      {error && <div className="administrator-panel__error">{error}</div>}

      <div className="administrator-panel__status-grid">
        {systemCards.map((card) => (
          <div key={card.label} className={`administrator-status-card status-${card.status}`}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.detail}</small>
          </div>
        ))}
      </div>

      <div className="administrator-panel__grid">
        <div className="administrator-card administrator-card--incidents">
          <div className="administrator-card__header">
            <h4>Incident Center</h4>
            <span>{unacknowledgedIncidents.length} chưa xác nhận</span>
          </div>

          <div className="administrator-card__body">
            {incidents.length === 0 ? (
              <div className="administrator-empty">Không có incident nổi bật.</div>
            ) : (
              incidents.map((item) => (
                <div
                  key={item.id}
                  className={`administrator-incident administrator-incident--${item.severity}`}
                >
                  <div className="administrator-incident__top">
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                    </div>
                    <span>{item.severity}</span>
                  </div>

                  {!acknowledgedIncidentIds.includes(item.id) ? (
                    <button type="button" onClick={() => acknowledgeIncident(item.id)}>
                      Xác nhận đã thấy
                    </button>
                  ) : (
                    <div className="administrator-incident__ack">Đã xác nhận</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="administrator-card administrator-card--probes">
          <div className="administrator-card__header">
            <h4>API / Endpoint Probe</h4>
            <span>Kiểm tra phản hồi endpoint hệ thống</span>
          </div>

          <div className="administrator-card__body">
            {probeResults.length === 0 ? (
              <div className="administrator-empty">Chưa chạy probe endpoint.</div>
            ) : (
              <div className="administrator-probe-list">
                {probeResults.map((item) => (
                  <div key={item.key} className={`administrator-probe administrator-probe--${item.status}`}>
                    <div>
                      <strong>{item.label}</strong>
                      <p>{item.url}</p>
                    </div>
                    <div className="administrator-probe__meta">
                      <span>HTTP {item.httpStatus}</span>
                      <span>{item.latencyMs} ms</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="administrator-card administrator-card--audit">
          <div className="administrator-card__header">
            <h4>Log Audit Summary</h4>
            <span>Phân tích theo module</span>
          </div>

          <div className="administrator-card__body">
            <div className="administrator-audit-table">
              <div className="administrator-audit-table__head">
                <span>Module</span>
                <span>Info</span>
                <span>Warn</span>
                <span>Error</span>
                <span>Total</span>
              </div>

              {auditRows.map((row) => (
                <div key={row.module} className="administrator-audit-table__row">
                  <span>{row.module}</span>
                  <span>{row.info}</span>
                  <span>{row.warning}</span>
                  <span>{row.error}</span>
                  <strong>{row.total}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="administrator-card administrator-card--diagnostics">
          <div className="administrator-card__header">
            <h4>Runtime Diagnostics</h4>
            <span>Web client + backend runtime</span>
          </div>

          <div className="administrator-card__body">
            <div className="administrator-diagnostics">
              <div className="administrator-diagnostic-item">
                <span>Backend refresh</span>
                <strong>{lastRefresh || '--'}</strong>
              </div>

              <div className="administrator-diagnostic-item">
                <span>Camera FPS</span>
                <strong>{cameraStatus?.fps ?? 0}</strong>
              </div>

              <div className="administrator-diagnostic-item">
                <span>People count</span>
                <strong>{cameraStatus?.people_count ?? 0}</strong>
              </div>

              <div className="administrator-diagnostic-item">
                <span>Latest event</span>
                <strong>{cameraStatus?.last_event || 'None'}</strong>
              </div>

              <div className="administrator-diagnostic-item">
                <span>Mongo collections</span>
                <strong>{(mongoHealth?.collections || []).length}</strong>
              </div>

              <div className="administrator-diagnostic-item">
                <span>Total events</span>
                <strong>{mongoStats?.total_events ?? 0}</strong>
              </div>

              <div className="administrator-diagnostic-item">
                <span>Browser online</span>
                <strong>{browserInfo?.online ? 'YES' : 'NO'}</strong>
              </div>

              <div className="administrator-diagnostic-item">
                <span>Viewport</span>
                <strong>
                  {browserInfo?.viewport?.width || '--'} x {browserInfo?.viewport?.height || '--'}
                </strong>
              </div>
            </div>
          </div>
        </div>

        <div className="administrator-card administrator-card--recommendations">
          <div className="administrator-card__header">
            <h4>Admin Recommendations</h4>
            <span>Gợi ý tác vụ vận hành</span>
          </div>

          <div className="administrator-card__body">
            <div className="administrator-recommendation-list">
              {derivedRecommendations.map((item, index) => (
                <div key={index} className="administrator-recommendation-item">
                  <span>{index + 1}</span>
                  <p>{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="administrator-card administrator-card--notes">
          <div className="administrator-card__header">
            <h4>Admin Notes</h4>
            <span>Ghi chú riêng cho quản trị viên</span>
          </div>

          <div className="administrator-card__body">
            <textarea
              value={adminNotes}
              onChange={(e) => saveNotes(e.target.value)}
              placeholder="Ghi chú sự cố, lịch kiểm tra, hướng dẫn nội bộ..."
              rows="10"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdministratorPanel;