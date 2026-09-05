// frontend/js/api_client.js
import { getParticipantId } from './modules/session.js';
import { buildBackendUrl } from './modules/config.js';
import {AppConfig} from './modules/config.js';

export function buildWebSocketUrl(id='') {
    return `${buildBackendUrl('/ws/user/')}${id}`;
}

/**
 * 统一处理响应：先检查状态码，再解析 JSON
 * 如果响应不是 JSON 格式，会提取纯文本错误信息
 */
async function _handleResponse(response) {
    if (!response.ok) {
        // 尝试解析 JSON 错误响应
        let errorData = null;
        let errorText = '';
        try {
            const text = await response.text();
            errorText = text;
            try {
                errorData = JSON.parse(text);
            } catch (e) {
                // 不是 JSON，保留纯文本
                errorData = null;
            }
        } catch (e) {
            errorText = `HTTP ${response.status} ${response.statusText}`;
        }

        // 构造有意义的错误消息
        let message = `请求失败 (${response.status})`;
        if (errorData) {
            if (errorData.detail) {
                if (typeof errorData.detail === 'string') {
                    message = errorData.detail;
                } else if (Array.isArray(errorData.detail)) {
                    // Pydantic 验证错误格式
                    const errors = errorData.detail.map(e => `${e.loc.join('.')}: ${e.msg}`).join('; ');
                    message = `参数验证错误: ${errors}`;
                } else {
                    message = JSON.stringify(errorData.detail);
                }
            } else if (errorData.message) {
                message = errorData.message;
            } else {
                message = JSON.stringify(errorData);
            }
        } else if (errorText) {
            // 纯文本错误，截断显示
            message = errorText.length > 200 ? errorText.substring(0, 200) + '...' : errorText;
        }

        const error = new Error(message);
        error.status = response.status;
        error.data = errorData;
        error.text = errorText;
        throw error;
    }

    // 正常响应，解析 JSON
    try {
        return await response.json();
    } catch (e) {
        // 如果 JSON 解析失败，尝试获取纯文本
        const text = await response.text().catch(() => '');
        const error = new Error(`响应解析失败: ${e.message}`);
        error.status = response.status;
        error.text = text;
        throw error;
    }
}

// --- 不带 participant_id 的通用请求方法 ---
async function _requestWithoutAuth(endpoint, options = {}) {
    const defaultOptions = {
        headers: { 'Content-Type': 'application/json' },
        ...options
    };
    
    const url = buildBackendUrl(endpoint);
    const response = await fetch(url, defaultOptions);
    return _handleResponse(response);
}

async function getWithoutAuth(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const urlWithParams = queryString ? `${endpoint}?${queryString}` : endpoint;
    return _requestWithoutAuth(urlWithParams, { method: 'GET' });
}

async function postWithoutAuth(endpoint, body) {
    return _requestWithoutAuth(endpoint, {
        method: 'POST',
        body: JSON.stringify(body)
    });
}
// --- 新增结束 ---


async function post(endpoint, body) {
  const participantId = getParticipantId();
  if (!participantId) {
        // 如果没有ID，说明会话已丢失，应强制返回注册页
        window.location.href = '/pages/index.html';
        throw new Error("Session not found. Redirecting to login.");
  }

  // 自动在请求体中注入participant_id
  const fullBody = { ...body, participant_id: participantId };

  const response = await fetch(buildBackendUrl(endpoint), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fullBody),
  });
  return _handleResponse(response);
}

// ... 实现 get, put, delete 等方法
async function get(endpoint, params = {}) {
  const participantId = getParticipantId();
  if (!participantId) {
        // 如果没有ID，说明会话已丢失，应强制返回注册页
        window.location.href = '/pages/index.html';
        throw new Error("Session not found. Redirecting to login.");
  }
  
  // 自动添加participant_id到查询参数
  params.participant_id = participantId;
  
  const queryString = new URLSearchParams(params).toString();
  const url = `${buildBackendUrl(endpoint)}?${queryString}`;
  
  const response = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
  });
  return _handleResponse(response);
}

// 挂载到window对象上，以便全局访问
window.apiClient = {
  post,
  get,
  // --- 新增：暴露不带认证的方法 ---
  postWithoutAuth,
  getWithoutAuth
  // --- 新增结束 ---
};

// 默认导出
export default {
  post,
  get,
  // --- 新增：导出不带认证的方法 ---
  postWithoutAuth,
  getWithoutAuth
  // --- 新增结束 ---
};
