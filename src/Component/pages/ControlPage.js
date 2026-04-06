import React from 'react';
import './ControlPage.scss';
import MonitorPanel from '../monitor/MonitorPanel';
import ChatbotPanel from '../chatbot/ChatbotPanel';

function ControlPage() {
  return (
    <div className="control-page">
      <div className="control-page__monitor">
        <MonitorPanel />
      </div>

      <div className="control-page__chatbot">
        <ChatbotPanel />
      </div>
    </div>
  );
}

export default ControlPage;