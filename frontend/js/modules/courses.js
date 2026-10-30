// frontend/js/modules/courses.js
// 课程列表与「当前所选课程」的本地持久化。
// 课程是学习的大方向（如 Web前端技术、C语言程序设计、Python），
// 首页的「学习主题」是课程内的具体场景，两者是不同层级的概念。

const COURSE_STORAGE_KEY = 'pbl.course.selected';
const DEFAULT_COURSE_URL = '/pages/course_selection.html';

/**
 * 可选课程列表
 * id 用于持久化与后续接口传参，name 为界面展示名称
 */
export const COURSES = [
  {
    id: 'web-frontend',
    name: 'Web前端技术',
    icon: 'mdi:language-html5',
    accent: '#e34f26',
    description: 'HTML / CSS / JavaScript，从零搭建你的第一个网页',
    tags: ['HTML', 'CSS', 'JavaScript'],
  },
  {
    id: 'c-programming',
    name: 'C语言程序设计',
    icon: 'mdi:language-c',
    accent: '#5c6bc0',
    description: '变量与数据类型、流程控制、函数与指针，打牢编程基础',
    tags: ['变量', '流程控制', '函数', '指针'],
  },
  {
    id: 'python',
    name: 'Python',
    icon: 'mdi:language-python',
    accent: '#3776ab',
    description: 'Python 语法基础、常用容器与标准库，用代码解决实际问题',
    tags: ['语法基础', '数据结构', '标准库'],
  },
];

/**
 * 按 id 查找课程
 * @param {string} courseId - 课程 id
 * @returns {Object|null} 课程信息
 */
export function getCourseById(courseId) {
  if (!courseId) return null;
  return COURSES.find((course) => course.id === courseId) || null;
}

/**
 * 删除已选课程的本地记录，存储不可用时不会抛异常
 */
export function clearSelectedCourse() {
  try {
    window.localStorage.removeItem(COURSE_STORAGE_KEY);
  } catch (error) {
    console.error('[courses] 清除已选课程失败', error);
  }
}

/**
 * 获取当前已选课程
 * @returns {Object|null} 课程信息，未选择或数据失效时返回 null
 */
export function getSelectedCourse() {
  try {
    const raw = window.localStorage.getItem(COURSE_STORAGE_KEY);
    if (!raw) return null;

    const saved = JSON.parse(raw);
    const course = getCourseById(saved?.id);
    if (!course) {
      // 本地数据与课程列表不一致时清理，避免后续流程拿不到有效课程
      clearSelectedCourse();
      return null;
    }
    return course;
  } catch (error) {
    console.warn('[courses] 读取已选课程失败', error);
    clearSelectedCourse();
    return null;
  }
}

/**
 * 保存所选课程
 * @param {string} courseId - 课程 id
 * @returns {Object|null} 保存成功返回课程信息，失败返回 null
 */
export function saveSelectedCourse(courseId) {
  const course = getCourseById(courseId);
  if (!course) {
    console.warn('[courses] 无效的课程 id:', courseId);
    return null;
  }

  try {
    window.localStorage.setItem(
      COURSE_STORAGE_KEY,
      JSON.stringify({ id: course.id, name: course.name, selectedAt: new Date().toISOString() }),
    );
    return course;
  } catch (error) {
    console.error('[courses] 保存已选课程失败', error);
    return null;
  }
}

/**
 * 页面守卫：未选择课程时跳转到课程选择页
 * @param {string} courseUrl - 课程选择页地址
 * @returns {boolean} 是否已选择课程
 */
export function requireSelectedCourse(courseUrl = DEFAULT_COURSE_URL) {
  if (getSelectedCourse()) {
    return true;
  }
  window.location.replace(courseUrl);
  return false;
}
