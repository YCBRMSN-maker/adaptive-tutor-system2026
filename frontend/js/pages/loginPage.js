// frontend/js/pages/loginPage.js
// 登录页逻辑：本地演示账号登录，登录成功后进入课程选择页

import {
  login,
  isLoggedIn,
  redirectIfLoggedIn,
  NICKNAME_MIN_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../modules/auth.js';
import { setupHeaderTitle } from '../modules/navigation.js';

// 登录成功后进入的页面
const COURSE_SELECTION_URL = '/pages/course_selection.html';

/**
 * 显示错误提示
 * @param {HTMLElement} errorElement - 错误提示元素
 * @param {string} message - 错误信息
 */
function showError(errorElement, message) {
  if (!errorElement) return;
  errorElement.textContent = message;
  errorElement.hidden = false;
}

/**
 * 隐藏错误提示
 * @param {HTMLElement} errorElement - 错误提示元素
 */
function hideError(errorElement) {
  if (!errorElement) return;
  errorElement.textContent = '';
  errorElement.hidden = true;
}

/**
 * 根据当前输入更新登录按钮可用状态
 */
function updateSubmitState() {
  const nicknameInput = document.getElementById('login-nickname');
  const passwordInput = document.getElementById('login-password');
  const submitButton = document.getElementById('login-button');
  if (!nicknameInput || !passwordInput || !submitButton) return;

  const nickname = nicknameInput.value.trim();
  const password = passwordInput.value;
  submitButton.disabled =
    nickname.length < NICKNAME_MIN_LENGTH || password.length < PASSWORD_MIN_LENGTH;
}

document.addEventListener('DOMContentLoaded', () => {
  // 已登录用户直接进入课程选择页，避免重复登录
  if (isLoggedIn()) {
    redirectIfLoggedIn(COURSE_SELECTION_URL);
    return;
  }

  // 标题点击回到登录页（相当于刷新当前页）
  setupHeaderTitle('/pages/login.html');

  const form = document.getElementById('login-form');
  const nicknameInput = document.getElementById('login-nickname');
  const passwordInput = document.getElementById('login-password');
  const submitButton = document.getElementById('login-button');
  const errorElement = document.getElementById('login-error');
  const passwordToggle = document.getElementById('password-toggle');

  if (!form || !nicknameInput || !passwordInput || !submitButton) return;

  // 输入变化时刷新按钮状态并清除旧错误
  [nicknameInput, passwordInput].forEach((input) => {
    input.addEventListener('input', () => {
      hideError(errorElement);
      input.removeAttribute('aria-invalid');
      updateSubmitState();
    });
  });

  // 密码显示 / 隐藏
  if (passwordToggle) {
    passwordToggle.addEventListener('click', () => {
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      passwordToggle.setAttribute('aria-pressed', String(isPassword));
      passwordToggle.setAttribute('aria-label', isPassword ? '隐藏密码' : '显示密码');
      passwordToggle.setAttribute('title', isPassword ? '隐藏密码' : '显示密码');

      const icon = passwordToggle.querySelector('iconify-icon');
      if (icon) {
        icon.setAttribute('icon', isPassword ? 'mdi:eye-off' : 'mdi:eye');
      }
    });
  }

  // 提交登录
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    hideError(errorElement);

    const originalHtml = submitButton.innerHTML;
    submitButton.disabled = true;
    submitButton.innerHTML =
      '<iconify-icon icon="mdi:loading" width="20" height="20" class="spin"></iconify-icon> 登录中...';

    const result = login(nicknameInput.value, passwordInput.value);

    if (!result.ok) {
      showError(errorElement, result.message);
      // 标记输入无效并聚焦，便于读屏软件播报错误
      [nicknameInput, passwordInput].forEach((input) => input.setAttribute('aria-invalid', 'true'));
      passwordInput.focus();
      submitButton.innerHTML = originalHtml;
      updateSubmitState();
      return;
    }

    // 登录成功：进入课程选择页
    window.location.href = COURSE_SELECTION_URL;
  });

  updateSubmitState();
  nicknameInput.focus();
});
