import React, { useEffect, useMemo, useState } from 'react';
import './MaintenancePanel.scss';

import { API_BASE, getAuthHeaders } from '../../authStorage';

function MaintenancePanel() {
  const [systemHealth, setSystemHealth] = useState(null);
  const [cameraStatus, setCameraStatus] = useState(null);
  const [chatbotHealth, setChatbotHealth] = useState(null);
  const [mongoHealth, setMongoHealth] = useState(null);
  const [logs, setLogs] = useState([]);

  const [loading, setLoading] = useState(false);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [error, setError] = useState('');
  const [generatedPlan, setGeneratedPlan] = useState([]);

  useEffect(() => {
    loadMaintenanceData();
  }, []);

  const loadMaintenanceData = async () => {
    setLoading(true);
    setError('');

    try {
      const auth = {
        headers: getAuthHeaders(false),
      };

      const [systemRes, cameraRes, chatbotRes, mongoRes, logsRes] = await Promise.all([
        fetch(`${API_BASE}/api/system/health`, auth),
        fetch(`${API_BASE}/api/camera/status`, auth),
        fetch(`${API_BASE}/api/chatbot/health`, auth),
        fetch(`${API_BASE}/api/mongo/health`, auth),
        fetch(`${API_BASE}/api/logs/recent?limit=80`, auth),
      ]);

      const [systemData, cameraData, chatbotData, mongoData, logsData] = await Promise.all([
        systemRes.json(),
        cameraRes.json(),
        chatbotRes.json(),
        mongoRes.json(),
        logsRes.json(),
      ]);

      if (!systemData?.success) {
        throw new Error(systemData?.error || 'Không lấy được system health');
      }

      setSystemHealth(systemData || null);
      setCameraStatus(cameraData?.status || null);
      setChatbotHealth(chatbotData || null);
      setMongoHealth(mongoData || null);
      setLogs(Array.isArray(logsData?.items) ? logsData.items : []);
    } catch (err) {
      setError(err?.message || 'Lỗi tải dữ liệu maintenance');
    } finally {
      setLoading(false);
    }
  };

  const buildMaintenancePlan = () => {
    setCreatingPlan(true);

    const plan = [];
    const cameraRunning = Boolean(cameraStatus?.running);
    const cameraMode = cameraStatus?.mode || 'unknown';
    const mongoOk = Boolean(mongoHealth?.success);
    const chatbotDbOk = Boolean(chatbotHealth?.db_ok);
    const chatbotApiReady = Boolean(
      chatbotHealth?.openrouter_api_key_configured && chatbotHealth?.model_name
    );

    const warningLogs = logs.filter(
      (item) => String(item?.level || '').toUpperCase() === 'WARNING'
    );
    const errorLogs = logs.filter(
      (item) => String(item?.level || '').toUpperCase() === 'ERROR'
    );

    if (!cameraRunning) {
      plan.push({
        date: 'Hôm nay',
        title: 'Kiểm tra lại luồng camera AI',
        desc: `Camera hiện không chạy hoặc đang ở mode "${cameraMode}". Cần xác minh thiết bị, stream và worker vision.`,
        priority: 'high',
      });
    }

    if (!mongoOk) {
      plan.push({
        date: 'Hôm nay',
        title: 'Rà soát kết nối MongoDB',
        desc: 'Backend chưa xác nhận kết nối MongoDB ổn định. Cần kiểm tra URI, network và quyền truy cập.',
        priority: 'high',
      });
    }

    if (!chatbotDbOk || !chatbotApiReady) {
      plan.push({
        date: 'Hôm nay',
        title: 'Kiểm tra chatbot runtime',
        desc: !chatbotApiReady
          ? 'Chatbot chưa sẵn sàng do OpenRouter chưa cấu hình đúng hoặc chưa có model name.'
          : 'Chatbot chưa truy cập được dữ liệu hệ thống. Cần kiểm tra MongoDB access.',
        priority: 'medium',
      });
    }

    if (warningLogs.length > 0) {
      plan.push({
        date: 'Trong 24h',
        title: 'Xử lý các warning hệ thống',
        desc: `Phát hiện ${warningLogs.length} warning gần đây trong log hệ thống.`,
        priority: 'medium',
      });
    }

    if (errorLogs.length > 0) {
      plan.push({
        date: 'Ngay lập tức',
        title: 'Khắc phục log lỗi hệ thống',
        desc: `Có ${errorLogs.length} log mức ERROR. Ưu tiên kiểm tra backend service và camera pipeline.`,
        priority: 'high',
      });
    }

    if (plan.length === 0) {
      plan.push({
        date: 'Theo lịch',
        title: 'Bảo trì định kỳ tổng quát',
        desc: 'Hệ thống hiện ổn định. Tiếp tục theo dõi định kỳ và backup dữ liệu.',
        priority: 'low',
      });
    }

    setGeneratedPlan(plan);
    setCreatingPlan(false);
  };

  const statusRows = useMemo(() => {
    const cameraOk = Boolean(cameraStatus);
    const mongoOk = Boolean(mongoHealth?.success);
    const chatbotOk = Boolean(
      chatbotHealth?.success &&
        chatbotHealth?.db_ok &&
        chatbotHealth?.openrouter_api_key_configured
    );

    const visionRuntime = cameraStatus?.running
      ? 'Đang hoạt động'
      : cameraStatus?.mode === 'error'
        ? 'Lỗi'
        : 'Chưa chạy';

    return [
      {
        label: 'Camera AI',
        value: cameraStatus?.running ? 'Đang chạy' : 'Dừng',
        type: cameraStatus?.running ? 'ok' : 'warning',
        detail: cameraOk
          ? `Mode: ${cameraStatus?.mode || 'unknown'}`
          : 'Chưa có phản hồi camera',
      },
      {
        label: 'Chatbot Server',
        value: chatbotOk ? 'Ổn định' : 'Cần kiểm tra',
        type: chatbotOk ? 'ok' : 'warning',
        detail: chatbotHealth?.openrouter_api_key_configured
          ? `OpenRouter sẵn sàng${chatbotHealth?.model_name ? ` (${chatbotHealth.model_name})` : ''}`
          : 'OpenRouter chưa cấu hình',
      },
      {
        label: 'MongoDB',
        value: mongoOk ? 'Kết nối tốt' : 'Lỗi kết nối',
        type: mongoOk ? 'ok' : 'warning',
        detail: mongoOk
          ? `${(mongoHealth?.collections || []).length} collections`
          : mongoHealth?.error || 'Không có dữ liệu',
      },
      {
        label: 'Vision Runtime',
        value: visionRuntime,
        type: cameraStatus?.running
          ? 'ok'
          : cameraStatus?.mode === 'error'
            ? 'danger'
            : 'warning',
        detail: cameraStatus?.note || 'Không có ghi chú',
      },
    ];
  }, [cameraStatus, chatbotHealth, mongoHealth]);

  const metrics = useMemo(() => {
    const warningCount = logs.filter(
      (item) => String(item?.level || '').toUpperCase() === 'WARNING'
    ).length;
    const errorCount = logs.filter(
      (item) => String(item?.level || '').toUpperCase() === 'ERROR'
    ).length;
    const infoCount = logs.filter(
      (item) => String(item?.level || '').toUpperCase() === 'INFO'
    ).length;

    return [
      { label: 'CPU', value: systemHealth?.features?.vision_enabled ? 'Active' : 'Inactive' },
      { label: 'Mongo', value: mongoHealth?.success ? 'Healthy' : 'Down' },
      { label: 'Warnings', value: warningCount },
      { label: 'Errors', value: errorCount },
      { label: 'Logs', value: infoCount },
      { label: 'People', value: cameraStatus?.people_count ?? 0 },
      { label: 'FPS', value: cameraStatus?.fps ?? 0 },
      { label: 'Event', value: cameraStatus?.last_event || 'None' },
    ];
  }, [systemHealth, mongoHealth, logs, cameraStatus]);

  const recentMaintenanceItems = useMemo(() => {
    const items = logs
      .filter((item) => ['camera', 'system', 'mongo', 'chatbot'].includes(item?.module))
      .slice(0, 8)
      .map((item) => ({
        time: item?.timestamp || '--',
        title: `[${String(item?.module || 'system').toUpperCase()}] ${item?.message || 'Không có nội dung'}`,
        level: String(item?.level || 'INFO').toUpperCase(),
      }));

    return items.length > 0
      ? items
      : [{ time: '--', title: 'Chưa có log gần đây', level: 'INFO' }];
  }, [logs]);

  return (
    <div className="maintenance-panel">
      <div className="maintenance-panel__top">
        <div className="maintenance-panel__intro">
          <div className="maintenance-panel__badge">MAINTENANCE</div>
          <h3>Bảo trì hệ thống</h3>
          <p>Theo dõi tình trạng hệ thống và lịch bảo trì định kỳ của SmartElevator.</p>
        </div>

        <div className="maintenance-panel__actions">
          <button type="button" onClick={loadMaintenanceData} disabled={loading}>
            {loading ? 'Đang kiểm tra...' : 'Kiểm tra hệ thống'}
          </button>
          <button type="button" onClick={buildMaintenancePlan} disabled={creatingPlan || loading}>
            {creatingPlan ? 'Đang tạo...' : 'Tạo lịch bảo trì'}
          </button>
        </div>
      </div>

      {error && <div className="maintenance-panel__error">{error}</div>}

      <div className="maintenance-panel__body">
        <div className="maintenance-panel__main-col">
          <div className="maintenance-card maintenance-card--status">
            <div className="maintenance-card__title">Tình trạng thiết bị</div>
            <div className="maintenance-status-list">
              {statusRows.map((item) => (
                <div className="maintenance-status-item" key={item.label}>
                  <div className="maintenance-status-item__left">
                    <span className="maintenance-status-item__label">{item.label}</span>
                    <small className="maintenance-status-item__detail">{item.detail}</small>
                  </div>
                  <strong className={`status-${item.type}`}>{item.value}</strong>
                </div>
              ))}
            </div>
          </div>

          {generatedPlan.length > 0 && (
            <div className="maintenance-card maintenance-card--plan">
              <div className="maintenance-card__title">Kế hoạch đề xuất</div>
              <div className="maintenance-card__content maintenance-card__content--plan">
                {generatedPlan.map((plan, idx) => (
                  <div key={idx} className="maintenance-plan-item">
                    <div className="maintenance-plan-item__meta">
                      <span>{plan.date}</span>
                      <em className={`priority priority--${plan.priority}`}>{plan.priority}</em>
                    </div>
                    <strong>{plan.title}</strong>
                    <p>{plan.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="maintenance-panel__side">
          <div className="maintenance-card maintenance-card--logs">
            <div className="maintenance-card__title">Lịch / log gần nhất</div>
            <div className="maintenance-card__content maintenance-card__content--logs">
              {recentMaintenanceItems.map((item, index) => (
                <div className="maintenance-mini-line" key={index}>
                  <span>{item.time}</span>
                  <strong>{item.title}</strong>
                  <em className={`maintenance-level maintenance-level--${item.level.toLowerCase()}`}>
                    {item.level}
                  </em>
                </div>
              ))}
            </div>
          </div>

          <div className="maintenance-card maintenance-card--metrics">
            <div className="maintenance-card__title">Thông số hệ thống</div>
            <div className="maintenance-card__content maintenance-card__content--metrics">
              <div className="maintenance-metrics">
                {metrics.map((metric) => (
                  <div className="maintenance-metric" key={metric.label}>
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MaintenancePanel;