// frontend/js/modules/pageGuard.js
// 受保护页面的统一访问守卫：必须已登录，且已选择学习课程

import { requireLogin } from './auth.js';
import { requireSelectedCourse } from './courses.js';

/**
 * 校验受保护页面的访问条件，不满足时自动跳转
 * @returns {boolean} 是否允许继续初始化页面
 */
export function requireSessionAndCourse() {
  if (!requireLogin()) {
    return false;
  }
  return requireSelectedCourse();
}
