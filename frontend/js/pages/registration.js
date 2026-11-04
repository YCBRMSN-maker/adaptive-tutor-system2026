// frontend/js/pages/registration.js
import { saveParticipantId, checkAndRedirect } from '../modules/session.js';
import { AppConfig, initializeConfig } from '../modules/config.js';
import { setupHeaderTitle, navigateTo } from '../modules/navigation.js';
import websocket from '../modules/websocket_client.js';
import apiClient from '../api_client.js';
import { requireLogin, getCurrentUser } from '../modules/auth.js';
import { getSelectedCourse, requireSelectedCourse } from '../modules/courses.js';
// 页面加载时先检查是否已有会话
// checkAndRedirect(); // 暂时注释掉，避免在注册页面直接跳转

// 页面守卫：未登录先去登录页，未选择课程先去课程选择页
const loginReady = requireLogin();
const courseReady = loginReady ? requireSelectedCourse() : false;

// 课程 → 学习入口页；未列出的课程统一走通用学习页
const COURSE_ENTRY_PAGES = {
    'c-programming': '/pages/oj.html',   // C 语言：算法学习（在线判题）
};
const DEFAULT_LEARNING_URL = '/pages/learning_page.html';

// 当前所选课程。注意不能只在首次加载时读一次：点「切换课程」后浏览器可能用缓存
// 还原本页（DOMContentLoaded 不会重跑），那样拿到的还是旧课程
let selectedCourse = getSelectedCourse();

/**
 * 重新读取所选课程并刷新页面上的课程回显
 */
function refreshCourseContext() {
    selectedCourse = getSelectedCourse();

    const courseContext = document.getElementById('course-context');
    const courseContextName = document.getElementById('course-context-name');
    if (selectedCourse && courseContext && courseContextName) {
        courseContextName.textContent = selectedCourse.name;
        courseContext.hidden = false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    if (!loginReady || !courseReady) return;

    // 版本标记：一眼看出浏览器加载的是哪一版脚本
    console.log('%c[OJ-INTEGRATION] registration.js v20261104a 已加载', 'color:#4f46e5;font-weight:bold');

    // 初始化配置
    await initializeConfig();
    // 设置标题点击跳转到首页（刷新）
    setupHeaderTitle('/pages/index.html');

    const startButton = document.getElementById('start-button');
    const nicknameInput = document.getElementById('nickname-input');
    const themeSelector = document.getElementById('theme-selector');

    // 回显当前课程，并提供切换课程入口
    refreshCourseContext();

    // 昵称默认使用登录时的昵称，用户仍可修改
    const currentUser = getCurrentUser();
    if (currentUser && nicknameInput && !nicknameInput.value) {
        nicknameInput.value = currentUser.nickname;
    }

    // 重置按钮状态（处理页面后退的情况）
    if (startButton) {
        startButton.disabled = false;
        startButton.innerHTML = '<iconify-icon icon="mdi:play" width="20" height="20"></iconify-icon> 开始学习';
    }

    // 监听输入变化
    if (nicknameInput) {
        nicknameInput.addEventListener('input', checkFormValid);
        nicknameInput.addEventListener('blur', validateNickname);
    }

    if (themeSelector) {
        themeSelector.addEventListener('change', checkFormValid);
    }

    // 开始按钮点击处理
    if (startButton) {
        startButton.addEventListener('click', async () => {
            const nickname = nicknameInput?.value.trim() || '';
            const theme = themeSelector?.value || '';

            // 验证输入
            if (!nickname) {
                showError('请输入学习昵称');
                nicknameInput?.focus();
                return;
            }

            if (!theme) {
                showError('请选择学习主题');
                themeSelector?.focus();
                return;
            }

            // 禁用按钮，防止重复点击
            startButton.disabled = true;
            const originalText = startButton.innerHTML;
            startButton.innerHTML = '<iconify-icon icon="mdi:loading" width="20" height="20" class="spin"></iconify-icon> 启动中...';

            try {
                // 生成基于昵称和主题的用户ID
                const participantId = generateParticipantId(nickname, theme);

                // 使用统一的apiClient方法发送请求
                const result = await apiClient.postWithoutAuth('/session/initiate', {
                    participant_id: participantId,
                    nickname: nickname,
                    theme: theme,
                    // 课程作为学习大方向一并上报，后端当前会话接口会忽略未知字段
                    course: selectedCourse ? selectedCourse.id : null,
                    course_name: selectedCourse ? selectedCourse.name : null
                });

                if (result.code === 200 || result.code === 201) {
                    saveParticipantId(result.data.participant_id);

                    // 兜底：getSelectedCourse() 在数据不一致时会返回 null，
                    // 那时直接读 localStorage 里存的原始课程 id
                    let courseId = selectedCourse && selectedCourse.id;
                    if (!courseId) {
                        try {
                            const raw = JSON.parse(window.localStorage.getItem('pbl.course.selected') || '{}');
                            courseId = raw.id || null;
                        } catch (e) { /* 忽略解析失败 */ }
                    }
                    console.log('[开始学习] 课程 id =', courseId, ' 返回码 =', result.code);

                    // 按课程决定进入哪个学习入口：C 语言进算法学习（在线判题），其余进通用学习页
                    const entryUrl = COURSE_ENTRY_PAGES[courseId] || DEFAULT_LEARNING_URL;
                    console.log('[开始学习] 入口 =', entryUrl);

                    if (entryUrl === DEFAULT_LEARNING_URL) {
                        navigateTo(DEFAULT_LEARNING_URL, '1_1', true);
                        return;
                    }

                    window.location.href = entryUrl;
                } else {
                    showError(result.message || '启动失败，请重试');
                    // 恢复按钮状态
                    startButton.disabled = false;
                    startButton.innerHTML = originalText;
                    checkFormValid();
                }
            } catch (error) {
                console.error('启动请求失败:', error);
                // 带上真实错误信息，避免所有失败都显示同一句"网络错误"导致无法定位
                const detail = error && error.message ? `：${error.message}` : '';
                showError('网络错误，请检查网络连接后重试' + detail);
                // 恢复按钮状态
                startButton.disabled = false;
                startButton.innerHTML = originalText;
                checkFormValid();
            }
        });
    }

    // 检查表单是否有效
    function checkFormValid() {
        const nickname = nicknameInput?.value.trim() || '';
        const theme = themeSelector?.value || '';
        const isValid = nickname.length >= 2 && theme;

        if (startButton) {
            startButton.disabled = !isValid;
        }
    }

    // 验证昵称
    function validateNickname() {
        const nickname = nicknameInput?.value.trim() || '';
        if (nickname && nickname.length < 2) {
            showError('昵称至少需要2个字符');
            return false;
        }
        return true;
    }

    // 生成参与者ID（直接使用昵称）
    function generateParticipantId(nickname, theme) {
        // 清理昵称，只保留字母数字和中文
        const cleanNickname = nickname.replace(/[^\w\u4e00-\u9fa5]/g, '').trim();
        return cleanNickname;
    }


    // 获取主题名称
    function getThemeName(theme) {
        const names = {
            'pets': '宠物世界',
            'shopping': '购物商城',
            'travel': '旅游探索',
            'food': '美食天地',
            'fitness': '健身达人',
            'music': '音乐空间'
        };
        return names[theme] || '学习';
    }

    // 显示错误提示
    function showError(message) {
        // 简单的错误提示，可以后续优化为更好的UI组件
        alert('❌ ' + message);
    }

    // 显示成功提示
    function showSuccess(message) {
        // 简单的成功提示，可以后续优化为更好的UI组件
        alert('✅ ' + message);
    }

    // 初始化检查表单状态
    checkFormValid();
});

// 监听页面显示事件（包括从缓存恢复）
window.addEventListener('pageshow', (event) => {
    // bfcache 恢复时重新校验登录与选课状态，避免退出登录后退绕过守卫
    if (event.persisted) {
        if (!requireLogin()) return;
        if (!requireSelectedCourse()) return;
    }

    // 从缓存还原时 DOMContentLoaded 不会重跑，课程可能已被切走，需要重新读取
    refreshCourseContext();

    const startButton = document.getElementById('start-button');
    if (startButton) {
        // 重置按钮状态
        startButton.disabled = false;
        startButton.innerHTML = '<iconify-icon icon="mdi:play" width="20" height="20"></iconify-icon> 开始学习';

        // 重新检查表单有效性
        const nicknameInput = document.getElementById('nickname-input');
        const themeSelector = document.getElementById('theme-selector');
        if (nicknameInput && themeSelector) {
            const nickname = nicknameInput.value.trim() || '';
            const theme = themeSelector.value || '';
            const isValid = nickname.length >= 2 && theme;
            startButton.disabled = !isValid;
        }
    }
});