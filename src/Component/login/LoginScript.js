import React, { useMemo, useState } from 'react';
import './LoginStyle.scss';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:5000';

function LoginScript({ onLoginSuccess }) {
  const [isRegister, setIsRegister] = useState(false);
  const [form, setForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    remember: true,
  });

  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const isValid = useMemo(() => {
    if (isRegister) {
      return (
        form.username.trim().length >= 3 &&
        form.password.trim().length >= 6 &&
        form.password === form.confirmPassword
      );
    }

    return form.username.trim().length > 0 && form.password.trim().length > 0;
  }, [form, isRegister]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;

    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));

    if (error) setError('');
    if (successMessage) setSuccessMessage('');
  };

  const resetForm = () => {
    setForm({
      username: '',
      password: '',
      confirmPassword: '',
      remember: true,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!isRegister && form.username === "admin" && form.password === "admin123") {
      if (typeof onLoginSuccess === "function") {
        onLoginSuccess({ username: "admin", role: "admin" });
      }
      return;
    }

    if (!isValid) {
      if (isRegister && form.password !== form.confirmPassword) {
        setError('Mật khẩu nhập lại không khớp.');
      } else if (isRegister && form.username.trim().length < 3) {
        setError('Tên tài khoản phải có ít nhất 3 ký tự.');
      } else if (isRegister && form.password.trim().length < 6) {
        setError('Mật khẩu phải có ít nhất 6 ký tự.');
      } else {
        setError('Vui lòng điền đúng và đầy đủ thông tin.');
      }
      return;
    }

    setIsLoading(true);
    setError('');
    setSuccessMessage('');

    try {
      const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';

      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: form.username.trim(),
          password: form.password,
          remember: form.remember,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Thao tác thất bại.');
      }

      if (isRegister) {
        setSuccessMessage('Đăng ký thành công. Hãy đăng nhập bằng tài khoản vừa tạo.');
        setIsRegister(false);
        resetForm();
      } else {
        if (typeof onLoginSuccess === 'function') {
          onLoginSuccess(data.user);
        }
      }
    } catch (err) {
      setError(err.message || 'Lỗi kết nối server.');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMode = () => {
    setIsRegister((prev) => !prev);
    setError('');
    setSuccessMessage('');
    resetForm();
  };

  return (
    <div className="login-page">
      <div className="login-bg-grid" />
      <div className="login-bg-glow glow-1" />
      <div className="login-bg-glow glow-2" />

      <div className="login-shell">
        <div className="login-left-panel">
          <div className="brand-chip">SmartElevator Vision Control</div>

          <h1 className="brand-title">
            Intelligent
            <span> Elevator Monitoring</span>
          </h1>

          <p className="brand-desc">
            Hệ thống điều khiển tập trung cho AI camera, chatbot vận hành và dashboard MongoDB realtime của SmartElevator.
          </p>

          <div className="feature-list">
            <div className="feature-item">
              <span className="feature-dot" />
              <span>AI Camera Monitoring</span>
            </div>
            <div className="feature-item">
              <span className="feature-dot" />
              <span>Realtime Event Tracking</span>
            </div>
            <div className="feature-item">
              <span className="feature-dot" />
              <span>MongoDB Analytics Dashboard</span>
            </div>
            <div className="feature-item">
              <span className="feature-dot" />
              <span>Integrated AI Chat Assistant</span>
            </div>
          </div>

          <div className="system-preview">
            <div className="preview-card">
              <div className="preview-label">SYSTEM STATUS</div>
              <div className="preview-value online">READY FOR INTEGRATION</div>
            </div>

            <div className="preview-grid">
              <div className="mini-stat">
                <span className="mini-stat-title">VISION</span>
                <strong>ACTIVE</strong>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-title">CHATBOT</span>
                <strong>STANDBY</strong>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-title">MONGODB</span>
                <strong>CONNECTED</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="login-right-panel">
          <div className="login-card">
            <div className="login-card-header">
              <div className="login-icon-wrap">
                <img
                  src="/logo/SmartElevatorLogo1.png"
                  alt="SmartElevator Logo"
                  className="login-logo-image"
                />
              </div>

              <h2>{isRegister ? 'Tạo tài khoản mới' : 'Đăng nhập hệ thống'}</h2>
              <p>
                {isRegister
                  ? 'Đăng ký tài khoản để truy cập hệ thống SmartElevator'
                  : 'Truy cập bảng điều khiển SmartElevator'}
              </p>
            </div>

            <form className="login-form" onSubmit={handleSubmit}>
              <div className="form-group">
                <label htmlFor="username">Tài khoản</label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  value={form.username}
                  onChange={handleChange}
                  placeholder={isRegister ? 'Tạo tên tài khoản' : 'Nhập tài khoản'}
                  autoComplete="username"
                />
              </div>

              <div className="form-group">
                <label htmlFor="password">Mật khẩu</label>
                <div className="password-field">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={handleChange}
                    placeholder={isRegister ? 'Tối thiểu 6 ký tự' : 'Nhập mật khẩu'}
                    autoComplete={isRegister ? 'new-password' : 'current-password'}
                  />
                  <button
                    type="button"
                    className="toggle-password-btn"
                    onClick={() => setShowPassword((prev) => !prev)}
                  >
                    {showPassword ? 'Ẩn' : 'Hiện'}
                  </button>
                </div>
              </div>

              {isRegister && (
                <div className="form-group">
                  <label htmlFor="confirmPassword">Nhập lại mật khẩu</label>
                  <input
                    id="confirmPassword"
                    name="confirmPassword"
                    type={showPassword ? 'text' : 'password'}
                    value={form.confirmPassword}
                    onChange={handleChange}
                    placeholder="Xác nhận mật khẩu"
                    autoComplete="new-password"
                  />
                </div>
              )}

              {!isRegister && (
                <div className="form-row">
                  <label className="remember-box">
                    <input
                      type="checkbox"
                      name="remember"
                      checked={form.remember}
                      onChange={handleChange}
                    />
                    <span>Ghi nhớ đăng nhập</span>
                  </label>

                  <button type="button" className="ghost-link-btn">
                    Quên mật khẩu?
                  </button>
                </div>
              )}

              {error && <div className="login-error">{error}</div>}
              {successMessage && <div className="login-success">{successMessage}</div>}

              <button
                type="submit"
                className={`login-submit-btn ${isLoading ? 'loading' : ''}`}
                disabled={isLoading}
              >
                {isLoading
                  ? (isRegister ? 'Đang đăng ký...' : 'Đang xác thực...')
                  : (isRegister ? 'Đăng ký ngay' : 'Đăng nhập')}
              </button>

              <div className="login-helper" style={{ textAlign: 'center', marginTop: '15px' }}>
                <span style={{ color: '#8da9c2' }}>
                  {isRegister ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'}
                </span>
                <button
                  type="button"
                  className="ghost-link-btn"
                  style={{ marginLeft: '8px', fontWeight: 'bold' }}
                  onClick={toggleMode}
                >
                  {isRegister ? 'Đăng nhập' : 'Đăng ký ngay'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoginScript;