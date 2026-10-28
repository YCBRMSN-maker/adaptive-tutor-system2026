// frontend/js/pages/courseSelectionPage.js
// 课程选择页逻辑：登录后选择学习课程，选择结果写入本地后进入课程生成页

import { requireLogin, getCurrentUser, isLoggedIn, logout } from '../modules/auth.js';
import {
  COURSES,
  getCourseById,
  getSelectedCourse,
  saveSelectedCourse,
} from '../modules/courses.js';
import { setupHeaderTitle } from '../modules/navigation.js';

// 登录页与课程生成页地址
const LOGIN_URL = '/pages/login.html';
const INDEX_URL = '/pages/index.html';

// 当前选中的课程 id
let selectedCourseId = null;

/**
 * 创建课程卡片
 * @param {Object} course - 课程信息
 * @param {number} index - 课程序号，用于键盘焦点定位
 * @returns {HTMLButtonElement} 课程卡片元素
 */
function createCourseCard(course, index) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'course-card';
  card.dataset.courseId = course.id;
  card.dataset.index = String(index);
  card.setAttribute('role', 'radio');
  card.setAttribute('aria-checked', 'false');
  card.setAttribute('aria-label', `${course.name}：${course.description}`);
  // radiogroup 采用 roving tabindex：仅当前选中项可被 Tab 聚焦
  card.tabIndex = -1;

  // 选中标记
  const check = document.createElement('span');
  check.className = 'course-card-check';
  check.setAttribute('aria-hidden', 'true');
  const checkIcon = document.createElement('iconify-icon');
  checkIcon.setAttribute('icon', 'mdi:check-circle');
  checkIcon.setAttribute('width', '22');
  checkIcon.setAttribute('height', '22');
  check.appendChild(checkIcon);

  // 课程图标
  const iconWrap = document.createElement('span');
  iconWrap.className = 'course-card-icon';
  iconWrap.style.setProperty('--course-accent', course.accent);
  const icon = document.createElement('iconify-icon');
  icon.setAttribute('icon', course.icon);
  icon.setAttribute('width', '40');
  icon.setAttribute('height', '40');
  iconWrap.appendChild(icon);

  // 课程名称
  const title = document.createElement('span');
  title.className = 'course-card-title';
  title.textContent = course.name;

  // 课程描述
  const description = document.createElement('span');
  description.className = 'course-card-desc';
  description.textContent = course.description;

  // 能力标签
  const tags = document.createElement('span');
  tags.className = 'course-card-tags';
  course.tags.forEach((tagText) => {
    const tag = document.createElement('span');
    tag.className = 'course-tag';
    tag.textContent = tagText;
    tags.appendChild(tag);
  });

  card.append(check, iconWrap, title, description, tags);
  return card;
}

document.addEventListener('DOMContentLoaded', () => {
  // 未登录用户先回到登录页
  if (!requireLogin(LOGIN_URL)) return;

  setupHeaderTitle('/pages/course_selection.html');

  const courseGrid = document.getElementById('course-grid');
  const confirmButton = document.getElementById('course-confirm-button');
  const tipElement = document.getElementById('course-selection-tip');
  const logoutButton = document.getElementById('logout-button');
  const userNickname = document.getElementById('user-nickname');

  if (!courseGrid || !confirmButton) return;

  // 展示当前登录用户
  const currentUser = getCurrentUser();
  if (userNickname && currentUser) {
    userNickname.textContent = currentUser.nickname;
  }

  // 渲染课程卡片
  const cards = COURSES.map((course, index) => createCourseCard(course, index));
  cards.forEach((card) => courseGrid.appendChild(card));
  // 尚未选择时让第一张卡片可被 Tab 聚焦
  if (cards.length) cards[0].tabIndex = 0;

  /**
   * 选中指定课程并刷新界面状态
   * @param {string} courseId - 课程 id
   */
  function selectCourse(courseId) {
    const course = getCourseById(courseId);
    if (!course) return;

    selectedCourseId = course.id;
    cards.forEach((card) => {
      const isSelected = card.dataset.courseId === course.id;
      card.classList.toggle('is-selected', isSelected);
      card.setAttribute('aria-checked', String(isSelected));
      card.tabIndex = isSelected ? 0 : -1;
    });

    confirmButton.disabled = false;
    if (tipElement) {
      tipElement.textContent = `已选择：${course.name}`;
    }
  }

  // 点击选择课程
  cards.forEach((card) => {
    card.addEventListener('click', () => selectCourse(card.dataset.courseId));
  });

  // 方向键在课程卡片之间切换选中项
  courseGrid.addEventListener('keydown', (event) => {
    const keyOffsetMap = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const offset = keyOffsetMap[event.key];
    if (!offset) return;

    event.preventDefault();
    const currentIndex = selectedCourseId
      ? COURSES.findIndex((course) => course.id === selectedCourseId)
      : -1;
    const nextIndex = (currentIndex + offset + COURSES.length) % COURSES.length;
    const nextCourse = COURSES[nextIndex];
    selectCourse(nextCourse.id);
    const nextCard = cards[nextIndex];
    if (nextCard) nextCard.focus();
  });

  // 确认进入课程
  confirmButton.addEventListener('click', () => {
    if (!selectedCourseId) return;

    const savedCourse = saveSelectedCourse(selectedCourseId);
    if (!savedCourse) {
      if (tipElement) {
        tipElement.textContent = '课程保存失败，请重试';
      }
      return;
    }
    window.location.href = INDEX_URL;
  });

  // 退出登录
  if (logoutButton) {
    logoutButton.addEventListener('click', () => {
      logout();
      window.location.href = LOGIN_URL;
    });
  }

  // 若此前已选过课程，进入页面时回显选择
  const previouslySelected = getSelectedCourse();
  if (previouslySelected) {
    selectCourse(previouslySelected.id);
  }
});

// 从浏览器缓存（bfcache）恢复时重新校验登录状态，避免注销后后退绕过守卫
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !isLoggedIn()) {
    window.location.replace(LOGIN_URL);
  }
});
