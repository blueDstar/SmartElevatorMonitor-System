import React, { useEffect, useRef, useState } from 'react';
import './ChatbotPanel.scss';

import { API_BASE, getAuthHeaders } from '../../authStorage';

function ChatbotPanel() {
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isBackendOnline, setIsBackendOnline] = useState(false);

  const chatMessagesRef = useRef(null);
  const textareaRef = useRef(null);
  const sessionIdRef = useRef(`session_${Date.now()}`);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
    checkBackendHealth();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const checkBackendHealth = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/health`, { headers: getAuthHeaders(false) });
      const data = await response.json();
      setIsBackendOnline(Boolean(data.success));
    } catch (error) {
      setIsBackendOnline(false);
    }
  };

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      if (chatMessagesRef.current) {
        chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
      }
    });
  };

  const autoResizeTextarea = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 130)}px`;
  };

  const appendMessage = (role, content) => {
    setMessages((prev) => [...prev, { role, content }]);
  };

  const handleInputChange = (e) => {
    setMessage(e.target.value);
    setTimeout(autoResizeTextarea, 0);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (message.trim() && !isLoading) {
        sendMessage();
      }
    }
  };

  const escapeHtml = (text) => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  };

  const formatMessage = (content) => {
    let formatted = escapeHtml(content);

    formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, __, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    formatted = formatted.replace(/\n/g, '<br>');

    return `<p>${formatted}</p>`;
  };

  const sendMessage = async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || isLoading) return;

    appendMessage('user', trimmedMessage);
    setMessage('');
    setIsLoading(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ message: trimmedMessage, session_id: sessionIdRef.current }),
      });

      const data = await response.json();

      if (!response.ok) {
        appendMessage('error', data.error || 'Yêu cầu thất bại.');
        return;
      }

      if (data.success) {
        appendMessage('assistant', data.message || 'Không có nội dung trả về.');
      } else {
        appendMessage('error', data.error || 'Đã có lỗi xảy ra. Vui lòng thử lại.');
      }
    } catch (error) {
      appendMessage('error', 'Không thể kết nối backend chatbot.');
      setIsBackendOnline(false);
    } finally {
      setIsLoading(false);
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }
  };

  const clearChat = async () => {
    setMessages([]);
    try {
      await fetch(`${API_BASE}/api/clear`, {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ session_id: sessionIdRef.current }),
      });
    } catch (error) {
      // phase này bỏ qua lỗi clear
    }

    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  return (
    <div className="dashboard-chatbot">
      <header className="dashboard-chatbot__header">
        <div className="dashboard-chatbot__brand">
          <div className="dashboard-chatbot__brand-icon">
            <img src="/logo/SmartElevatorLogo1.png" alt="SmartElevator Logo" />
          </div>

          <div className="dashboard-chatbot__brand-text">
            <h3>SmartElevator Chatbot</h3>
            <span className={`dashboard-chatbot__status ${isBackendOnline ? 'online' : 'offline'}`}>
              <span className="dashboard-chatbot__status-dot" />
              {isBackendOnline ? 'Backend Online' : 'Backend Offline'}
            </span>
          </div>
        </div>

        <button
          className="dashboard-chatbot__clear-btn"
          onClick={clearChat}
          title="Xóa lịch sử chat"
          type="button"
        >
          Xóa
        </button>
      </header>

      <main className="dashboard-chatbot__messages" ref={chatMessagesRef}>
        {messages.length === 0 && !isLoading && (
          <div className="dashboard-chatbot__welcome">
            <div className="dashboard-chatbot__welcome-icon">
            <img
                src="/logo/Chatbot1.png"
                alt="Chatbot Logo"
                className="chatbot-logo-image"
            />
            </div>
            <h4>Xin chào!</h4>
            <p>Khung chat này sẽ dùng để gọi API chatbot của hệ thống SmartElevator.</p>
          </div>
        )}

        {messages.map((msg, index) => {
          if (msg.role === 'error') {
            return (
              <div key={index} className="dashboard-chatbot__error">
                {msg.content}
              </div>
            );
          }

          return (
            <div key={index} className={`dashboard-chatbot__message ${msg.role}`}>
              <div className="dashboard-chatbot__avatar">
                {msg.role === 'user' ? (
                  <img 
                    src="/logo/User.png" 
                    alt="User Avatar" 
                    className="chatbot-user-image" 
                  />
                ) : (
                  <img 
                    src="/logo/Chatbot1.png" 
                    alt="Chatbot Respond Avatar" 
                    className="chatbot-respond-image" 
                  />
                )}
              </div>
              <div
                className="dashboard-chatbot__bubble"
                dangerouslySetInnerHTML={{ __html: formatMessage(msg.content) }}
              />
            </div>
          );
        })}

        {isLoading && (
          <div className="dashboard-chatbot__typing">
            <div className="dashboard-chatbot__avatar">
                        <img
                src="/logo/Chatbot1.png"
                alt="Chatbot Avatar"
                className="chatbot-avatar-image"
            /></div>
            <div className="dashboard-chatbot__typing-dots">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </main>

      <footer className="dashboard-chatbot__footer">
        <div className="dashboard-chatbot__input-wrap">
          <textarea
            ref={textareaRef}
            placeholder="Nhập tin nhắn..."
            rows="1"
            value={message}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
          />
          <button
            type="button"
            className="dashboard-chatbot__send-btn"
            onClick={sendMessage}
            disabled={!message.trim() || isLoading}
          >
            Gửi
          </button>
        </div>
        <p className="dashboard-chatbot__hint">Enter để gửi, Shift+Enter để xuống dòng</p>
      </footer>
    </div>
  );
}

export default ChatbotPanel;