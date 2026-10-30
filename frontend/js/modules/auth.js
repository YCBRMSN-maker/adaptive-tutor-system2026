// frontend/js/modules/auth.js
// 演示用的本地登录能力：账号与登录状态只保存在浏览器 localStorage 中。
// 注意：前端模拟登录不能作为真实鉴权手段。接入真实账号体系时，
//       账号密码必须由后端校验并由后端下发会话凭证，前端只保存凭证。

import { clearParticipantId } from './session.js';
import { clearSelectedCourse, getSelectedCourse } from './courses.js';

// localStorage 键名
const AUTH_USER_KEY = 'pbl.auth.user';
const AUTH_ACCOUNTS_KEY = 'pbl.auth.accounts';

// 输入校验限制（与页面的 maxlength 保持一致）
export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 32;

// 本地密码哈希的固定盐值：仅用于避免明文存储，不具备加密强度
const PASSWORD_HASH_SALT = 'sync-pbl-local-demo';

const DEFAULT_LOGIN_URL = '/pages/login.html';
const DEFAULT_COURSE_URL = '/pages/course_selection.html';
const DEFAULT_INDEX_URL = '/pages/index.html';

/**
 * 读取并解析 localStorage 中的 JSON，解析失败时返回兜底值
 * @param {string} key - 存储键名
 * @param {*} fallback - 解析失败时的兜底值
 */
function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (error) {
    console.warn(`[auth] 读取本地数据失败：${key}`, error);
    return fallback;
  }
}

/**
 * 将对象序列化后写入 localStorage
 * @param {string} key - 存储键名
 * @param {*} value - 需要保存的值
 * @returns {boolean} 写入是否成功
 */
function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`[auth] 写入本地数据失败：${key}`, error);
    return false;
  }
}

/**
 * 删除 localStorage 中的键，存储不可用时不会抛异常
 * @param {string} key - 存储键名
 */
function safeRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    console.error(`[auth] 清理本地数据失败：${key}`, error);
  }
}

/**
 * 生成密码哈希（FNV-1a 变体，非加密算法，仅用于演示场景避免明文存储）
 * @param {string} password - 明文密码
 * @returns {string} 8 位十六进制哈希
 */
function hashPassword(password) {
  const source = `${PASSWORD_HASH_SALT}:${password}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 规整昵称：去除首尾空白
 * @param {string} nickname - 原始昵称
 * @returns {string} 规整后的昵称
 */
export function normalizeNickname(nickname) {
  return String(nickname ?? '').trim();
}

/**
 * 校验昵称格式
 * @param {string} nickname - 昵称
 * @returns {{ valid: boolean, message: string }} 校验结果
 */
export function validateNickname(nickname) {
  const value = normalizeNickname(nickname);
  if (!value) {
    return { valid: false, message: '请输入昵称' };
  }
  if (value.length < NICKNAME_MIN_LENGTH) {
    return { valid: false, message: `昵称至少需要 ${NICKNAME_MIN_LENGTH} 个字符` };
  }
  if (value.length > NICKNAME_MAX_LENGTH) {
    return { valid: false, message: `昵称最多 ${NICKNAME_MAX_LENGTH} 个字符` };
  }
  return { valid: true, message: '' };
}

/**
 * 校验密码格式
 * @param {string} password - 密码
 * @returns {{ valid: boolean, message: string }} 校验结果
 */
export function validatePassword(password) {
  const value = String(password ?? '');
  if (!value) {
    return { valid: false, message: '请输入密码' };
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return { valid: false, message: `密码至少需要 ${PASSWORD_MIN_LENGTH} 位` };
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return { valid: false, message: `密码最多 ${PASSWORD_MAX_LENGTH} 位` };
  }
  return { valid: true, message: '' };
}

/**
 * 登录（首次登录的昵称会自动在本机创建演示账号）
 * @param {string} nickname - 昵称
 * @param {string} password - 密码
 * @returns {{ ok: boolean, message: string, user: Object|null }} 登录结果
 */
export function login(nickname, password) {
  const nicknameCheck = validateNickname(nickname);
  if (!nicknameCheck.valid) {
    return { ok: false, message: nicknameCheck.message, user: null };
  }

  const passwordCheck = validatePassword(password);
  if (!passwordCheck.valid) {
    return { ok: false, message: passwordCheck.message, user: null };
  }

  const nick = normalizeNickname(nickname);
  const accountKey = nick.toLowerCase();
  const passwordHash = hashPassword(String(password));
  const accounts = readJson(AUTH_ACCOUNTS_KEY, {});
  const existingAccount = accounts[accountKey];

  // 同一昵称在同一浏览器内重复登录时校验密码，避免“换个昵称就换人”的误操作
  if (existingAccount && existingAccount.passwordHash !== passwordHash) {
    return {
      ok: false,
      message: '该昵称已在本机使用过，密码不正确。请重试，或换一个昵称登录。',
      user: null,
    };
  }

  if (!existingAccount) {
    accounts[accountKey] = {
      nickname: nick,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    writeJson(AUTH_ACCOUNTS_KEY, accounts);
  }

  const user = {
    nickname: nick,
    loginAt: new Date().toISOString(),
  };
  if (!writeJson(AUTH_USER_KEY, user)) {
    return { ok: false, message: '登录状态保存失败，请检查浏览器存储权限', user: null };
  }

  return { ok: true, message: '', user };
}

/**
 * 当前是否已登录
 * @returns {boolean} 登录状态
 */
export function isLoggedIn() {
  const user = getCurrentUser();
  return Boolean(user && user.nickname);
}

/**
 * 获取当前登录用户
 * @returns {{ nickname: string, loginAt: string }|null} 当前用户信息
 */
export function getCurrentUser() {
  const user = readJson(AUTH_USER_KEY, null);
  if (!user || typeof user !== 'object' || !user.nickname) {
    return null;
  }
  return user;
}

/**
 * 退出登录：清除登录状态、参与者 ID 与已选课程
 */
export function logout() {
  safeRemove(AUTH_USER_KEY);
  clearParticipantId();
  clearSelectedCourse();
}

/**
 * 页面守卫：未登录时跳转到登录页
 * @param {string} loginUrl - 登录页地址
 * @returns {boolean} 是否已登录
 */
export function requireLogin(loginUrl = DEFAULT_LOGIN_URL) {
  if (isLoggedIn()) {
    return true;
  }
  window.location.replace(loginUrl);
  return false;
}

/**
 * 已登录用户访问登录页时的跳转：
 * 已选过课程直接进入课程生成页，否则进入课程选择页
 * @param {string} courseUrl - 课程选择页地址
 * @returns {boolean} 是否发生了跳转
 */
export function redirectIfLoggedIn(courseUrl = DEFAULT_COURSE_URL) {
  if (!isLoggedIn()) {
    return false;
  }
  const target = getSelectedCourse() ? DEFAULT_INDEX_URL : courseUrl;
  window.location.replace(target);
  return true;
}
