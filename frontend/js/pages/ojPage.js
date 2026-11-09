/**
 * C语言在线练习页
 * 三栏布局：题目列表 / 题目+代码 / AI 助教
 * 后端接口统一走 /oj-api/ 前缀（nginx 反代到 oj-backend:8000）
 */

import { requireSessionAndCourse } from '../modules/pageGuard.js';

const guardPassed = requireSessionAndCourse();

import { getParticipantId } from '../modules/session.js';
import chatModule from '../modules/chat.js';
import tracker from '../modules/behavior_tracker.js';
import apiClient from '../api_client.js';
import { showSectionFeedback } from '../modules/section_feedback.js';
import {
  installOjChatTransport,
  clearChatHistory,
  pushAiHint as pushHint,
} from '../modules/oj_chat_transport.js';

const API = '/oj-api';

// ---------------- 状态 ----------------
let problems = [];
let current = null;
let currentLang = 'C';
let lastSubmissionId = null;
let diagnosis = null;
let submitting = false;
let diagnosing = false;
let codeCache = {};          // 按题目 id 记住代码
let errorLines = new Set();  // 编译错误行（红）
let warnLines = new Set();   // 编译警告行（黄）
let aiLines = new Set();     // AI 定位行（橙）

const $ = (id) => document.getElementById(id);

const TEMPLATES = {
  C: '#include <stdio.h>\n\nint main() {\n    \n    return 0;\n}\n',
  'C++': '#include <iostream>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n',
  Python3: '# 请在下方编写代码\n',
};
// ---------------- 初始化 ----------------
document.addEventListener('DOMContentLoaded', () => {
  if (!guardPassed) return;
  init();
});

async function init() {
  await bindEditor();
  bindChatPanel();
  bindBack();
  bindDiagButton();

  await loadProblems();
  initMainChat();
  initBehaviorTracking();
  bindHintButton();
}

// 直接复用主站 test_page 的 AI 助教：chat.js + WebSocket + Celery 流式链路
function initMainChat() {
  if (!getParticipantId()) {
    console.warn('[OJ] 没有 participant_id，AI 助教需要登录态');
    return;
  }

  chatModule.init('test', current ? String(current.id) : 'oj', {
    enableEnterToSend: false,
  });

  clearChatHistory(chatModule, '遇到问题可以问我，我会先给提示，引导你自己想出来，不直接给答案。');

  installOjChatTransport(chatModule, {
    mode: 'test',
    buildPrompt: buildOjPrompt,
    getTopicId: () => `oj_${current ? current.id : 0}`,
    getParticipantId,
    onSend: (message) => {
      activity.aiAskCount += 1;
      tracker.logEvent('ai_help_request', {
        topic_id: current ? `oj_${current.id}` : null,
        message_length: message.length,
      });
    },
    onDone: () => checkAssistance(),
  });
}

// 把当前 C 语言题目和代码明确写进消息，避免主站按 HTML 课生成回复
function buildOjPrompt(message) {
  const lines = [message, '', '【场景】C 语言算法练习，不是 HTML/CSS/JS 前端课程。'];

  if (current) {
    lines.push(`【题目】${current.title}`);
    const desc = current.description || current.fullDescription || '';
    if (desc) {
      const tmp = document.createElement('div');
      tmp.innerHTML = desc;
      lines.push(`【题面】${(tmp.textContent || '').trim().slice(0, 800)}`);
    }
  }

  const code = getCode().trim();
  if (code) {
    lines.push(`【我的 C 代码】\n\`\`\`c\n${code.slice(0, 1500)}\n\`\`\``);
  }
  lines.push('请只围绕这道 C 语言题给提示，不要引用 HTML 标签、CSS 或前端内容。');
  return lines.join('\n');
}

/* ---------------- 主站行为追踪 / 主动提示（只调用，不改主站模块） ---------------- */

function initBehaviorTracking() {
  // tracker._sendPayload 依赖全局 apiClient
  window.apiClient = apiClient;
  window.currentTopicId = current ? `oj_${current.id}` : null;

  if (editor) {
    editor.onDidChangeModelContent(() => {
      markActive();
      clearTimeout(codeEditTimer);
      codeEditTimer = setTimeout(() => {
        tracker.logEvent('code_edit', {
          topic_id: window.currentTopicId,
          code_length: getCode().length,
        });
      }, 2000);
    });
  }

  document.addEventListener('click', markActive);
  document.addEventListener('keydown', markActive);

  // 60 秒无操作，主动问一次
  setInterval(() => {
    const idle = Date.now() - activity.lastActive;
    if (idle > 60000 && !activity.idleHintShown) {
      activity.idleHintShown = true;
      tracker.logEvent('user_idle', { idle_ms: idle, topic_id: window.currentTopicId });
      pushHint(chatModule, '已经有一会儿没有操作了，需要我给点思路吗？可以告诉我你卡在哪一步。');
    }
  }, 10000);
}

function markActive() {
  activity.lastActive = Date.now();
  activity.idleHintShown = false;
}

// 把 OJ 判题结果转成主站反馈模块能识别的「检查点 N 失败: ...」格式
function buildFailureDetails(detail) {
  if (!detail) return [];
  const out = [];

  (detail.cases || []).forEach((c, i) => {
    if (c.status && c.status !== 'AC') {
      out.push(`检查点 ${c.index || i + 1} 失败: ${c.message || c.status}`);
    }
  });
  (detail.diagnostics || []).forEach((d) => {
    out.push(`检查点 ${out.length + 1} 失败: ${d.type_zh || d.explain || '编译错误'}`);
  });
  if (!out.length && detail.status !== 'AC') {
    out.push(`检查点 1 失败: ${detail.message || detail.status}`);
  }
  return out;
}

// 通过之后弹出主站的「自我评价 → 系统评价」两步反馈
function showOjSectionFeedback(detail) {
  if (!current) return;

  showSectionFeedback({
    topicId: `oj_${current.id}`,
    topicLabel: current.title || `题目 ${current.id}`,
    feedbackType: 'section',
    submissionMsg: { passed: true, details: [] },
    failedSubmissionCount: activity.failedSubmissionCount,
    accumulatedFailures: activity.accumulatedFailures.slice(),
    lastFailedCode: { html: getCode(), css: '', js: '' },
    task: null,
  }).then((result) => {
    tracker.logEvent('ai_help_request', {
      topic_id: window.currentTopicId,
      source: 'section_feedback',
      submitted: !!(result && result.submitted),
      skipped: !!(result && result.skipped),
    });
  }).catch((err) => console.warn('[OJ] 小节反馈异常:', err));
}

function reportSubmission(detail) {
  activity.submissionCount += 1;
  const ok = !!detail && detail.status === 'AC';
  if (!ok) {
    activity.failedSubmissionCount += 1;
    activity.accumulatedFailures.push(...buildFailureDetails(detail));
  }

  tracker.logEvent('test_submission', {
    topic_id: window.currentTopicId,
    status: detail ? detail.status : 'SE',
    passed: ok,
  });
  checkAssistance();
}

// 照主站 test_page 的阈值：提交过 + 问了 4 次以上且偶数次 → 主动给提示
function checkAssistance() {
  if (activity.assistanceShown) return;
  if (activity.submissionCount < 1) return;
  if (activity.aiAskCount >= 4 && activity.aiAskCount % 2 === 0) {
    activity.assistanceShown = true;
    pushHint(chatModule, '我注意到你已经问了好几次、也提交过代码。要不要我给你几个针对性的提示，帮你把卡住的地方拆开？');
  }
}

function bindHintButton() {
  const btn = document.getElementById('problem-solving-hint-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const input = document.getElementById('user-message');
    if (!input) return;

    // 主站 EventType 没有 problem_solving_hint_requested，用合法的 ai_help_request
    tracker.logEvent('ai_help_request', {
      topic_id: window.currentTopicId,
      source: 'problem_solving_hint_button',
    });

    // 复用 chatModule.sendMessage，走主站 AI 接口并渲染到聊天框
    input.value = '请针对这道题给我一点思路提示，讲清楚解题思路和关键知识点，但不要直接给完整代码。';
    chatModule.sendMessage('test', `oj_${current ? current.id : 0}`);
  });
}

function bindBack() {
  $('backButton').addEventListener('click', () => {
    // 一级一级返回：通常是从学习页点「开始练习」进来的
    let sameOrigin = false;
    try {
      sameOrigin = !!document.referrer
        && new URL(document.referrer).origin === location.origin;
    } catch {
      sameOrigin = false;
    }

    if (sameOrigin && history.length > 1) {
      history.back();
    } else {
      window.location.href = '/pages/oj_learn.html';
    }
  });
}

function bindDiagButton() {
  const btn = $('aiDiagBtn');
  if (btn) btn.addEventListener('click', diagnoseErrors);
}

// ---------------- 题目加载 ----------------
async function loadProblems() {
  try {
    const res = await fetch(`${API}/problems`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    problems = await res.json();

    const params = new URLSearchParams(location.search);
    const pid = Number(params.get('pid'));
    const chapter = Number(params.get('chapter'));
    const target = pid ? problems.find((x) => x.id === pid) : null;

    // 只带 chapter 时，从章节接口取第一道题
    let chapterFirstId = null;
    if (!target && chapter) {
      const r = await fetch(`${API}/lessons/${chapter}`);
      if (r.ok) {
        const d = await r.json();
        if (d.problems && d.problems.length) chapterFirstId = Number(d.problems[0]);
      }
    }

    const startId = target ? target.id : (chapterFirstId ?? (problems[0] ? problems[0].id : null));
    if (startId != null) await selectProblem(startId);
  } catch (err) {
    $('problemBody').innerHTML =
      `<div class="oj-empty">题目加载失败：${escapeHtml(err.message)}</div>`;
  }
}

async function selectProblem(id) {
  const brief = problems.find((x) => x.id === id);
  if (!brief) return;

  // 切换前存下当前代码
  if (current) codeCache[current.id] = getCode();
  current = brief;
  if (chatModule && chatModule.currentContentId !== undefined) {
    chatModule.currentContentId = String(brief.id);
  }
  diagnosis = null;
  lastSubmissionId = null;
  errorLines.clear();
  aiLines.clear();
  warnLines.clear();
  renderResult(null);

  // 先用标题占位，再拉完整题面
  $('problemTitle').textContent = brief.title;
  $('problemBody').innerHTML = '<div class="oj-empty">加载题目…</div>';
  setCode(codeCache[brief.id] || TEMPLATES[currentLang] || '');
  syncGutter();

  // 列表接口只给精简字段（id/title/难度…），description 这些要单独取
  try {
    const res = await fetch(`${API}/problems/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const full = await res.json();
    current = full;
    renderProblem(full);
  } catch (err) {
    $('problemBody').innerHTML =
      `<div class="oj-empty">题目加载失败：${escapeHtml(err.message)}</div>`;
  }
}

function renderProblem(p) {
  $('problemTitle').textContent = p.title;
  if (current) current.fullDescription = p.description || '';
  // 顶栏原来显示题目总数，列表移除后改为显示当前题目的知识点
  $('ojProgress').textContent = p.knowledge || '';
  $('problemMeta').innerHTML =
    `<span>时间限制 ${p.time_limit} ms</span>` +
    `<span>内存限制 ${p.memory_limit} MB</span>` +
    (p.knowledge ? `<span>${escapeHtml(p.knowledge)}</span>` : '');

  const samples = (p.samples || []).map((s, i) => `
    <div class="oj-sample">
      <div class="oj-sample-label">样例 ${i + 1} 输入</div><pre>${escapeHtml(s.input || '')}</pre>
      <div class="oj-sample-label" style="margin-top:6px">样例 ${i + 1} 输出</div><pre>${escapeHtml(s.output || '')}</pre>
    </div>
  `).join('');

  $('problemBody').innerHTML = `
    <div class="oj-desc">${p.description || ''}</div>
    ${p.input_description ? `<div class="oj-sub-title">输入格式</div><div class="oj-desc">${p.input_description}</div>` : ''}
    ${p.output_description ? `<div class="oj-sub-title">输出格式</div><div class="oj-desc">${p.output_description}</div>` : ''}
    ${samples ? `<div class="oj-sub-title">样例</div>${samples}` : ''}
  `;
}

function updateProgress() {
  // 题目列表已移除，顶栏改为显示当前知识点（在 renderProblem 里设置）
}

// ---------------- 编辑器 ----------------
// ---------------- 编辑器（Monaco，与主站测试页同一份 vendor） ----------------
let editor = null;
let decorationIds = [];

// 与主站 test_page 一致的行为计数，用于卡住检测与主动提示
const activity = {
  aiAskCount: 0,
  submissionCount: 0,
  failedSubmissionCount: 0,
  lastActive: Date.now(),
  idleHintShown: false,
  assistanceShown: false,
  accumulatedFailures: [],
};
let codeEditTimer = null;

const MONACO_LANG = { C: 'c', 'C++': 'cpp', Python3: 'python' };

function getCode() {
  return editor ? editor.getValue() : '';
}

function setCode(text) {
  if (editor) editor.setValue(text || '');
}

function bindEditor() {
  return new Promise((resolve) => {
    if (typeof require === 'undefined') {
      console.error('Monaco loader 未加载，编辑器无法初始化');
      resolve(null);
      return;
    }

    require(['vs/editor/editor.main'], () => {
      editor = monaco.editor.create(document.getElementById('monacoEditor'), {
        value: TEMPLATES[currentLang] || '',
        language: MONACO_LANG[currentLang] || 'c',
        theme: 'vs',
        fontSize: 13,
        lineHeight: 21,
        fontFamily: "'SFMono-Regular', Consolas, monospace",
        tabSize: 4,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        glyphMargin: false,
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 6,
        renderLineHighlight: 'line',
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      });

      // 暴露给调试与端到端脚本使用
      window.__ojEditor = editor;

      editor.onDidChangeModelContent(() => syncGutter());

      document.getElementById('languageSelect').addEventListener('change', (e) => {
        currentLang = e.target.value;
        // 只有代码还是模板时才替换，避免覆盖用户写的内容
        const val = getCode().trim();
        const isTemplate = Object.values(TEMPLATES).some((t) => t.trim() === val);
        if (!val || isTemplate) {
          setCode(TEMPLATES[currentLang] || '');
          const model = editor.getModel();
          if (model) monaco.editor.setModelLanguage(model, MONACO_LANG[currentLang] || 'c');
        }
      });

      document.getElementById('resetBtn').addEventListener('click', () => {
        if (!confirm('确定要清空当前代码吗？')) return;
        setCode(TEMPLATES[currentLang] || '');
        errorLines.clear();
        aiLines.clear();
        warnLines.clear();
        syncGutter();
        renderResult(null);
      });

      document.getElementById('submitBtn').addEventListener('click', submit);

      resolve(editor);
    });
  });
}

// 用行装饰标记错误 / 警告 / AI 定位行（替代原来的自绘行号）
function syncGutter() {
  if (!editor) return;

  const decorations = [];
  const push = (line, cls) => {
    if (!line || line < 1) return;
    decorations.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: cls,
        lineNumberClassName: cls.replace('-line-', '-ln-'),
      },
    });
  };

  for (const n of errorLines) push(n, 'oj-line-err');
  for (const n of warnLines) push(n, 'oj-line-warn');
  for (const n of aiLines) push(n, 'oj-line-ai');

  decorationIds = editor.deltaDecorations(decorationIds, decorations);
}

// ---------------- 提交判题 ----------------
async function submit() {
  if (!current || submitting) return;
  const code = getCode();
  const meaningful = code
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').replace(/\/\/.*$/, '').trim())
    .filter(Boolean);
  if (!meaningful.length) {
    alert('请先编写代码再提交');
    return;
  }

  submitting = true;
  diagnosis = null;
  errorLines.clear();
  aiLines.clear();
  warnLines.clear();
  syncGutter();
  renderResult({ status: 'Pending', message: '正在编译并运行…' });
  $('submitBtn').disabled = true;

  try {
    const res = await fetch(`${API}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem_id: current.id,
        language: currentLang,
        code,
        participant_id: getParticipantId(),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { submission_id } = await res.json();
    lastSubmissionId = submission_id;
    await poll(submission_id);
  } catch (err) {
    renderResult({ status: 'SE', message: `提交失败：${err.message}` });
  } finally {
    submitting = false;
    $('submitBtn').disabled = false;
  }
}

async function poll(sid) {
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${API}/submissions/${sid}`);
      const s = await res.json();
      if (s.status !== 'Pending') {
        const detail = s.detail && s.detail.status
          ? s.detail
          : { status: s.status, message: s.message };
        renderResult(detail);
        reportSubmission(detail);
        if (detail.status === 'AC') showOjSectionFeedback(detail);
        return;
      }
    } catch {
      /* 继续重试 */
    }
  }
  renderResult({ status: 'SE', message: '判题超时，请稍后重试' });
}

// ---------------- 结果渲染 ----------------
let lastDetail = null;

// 把「编译器原文：xxx」从说明里拆出来单独成段，
// 否则中文折行会把「编译器原文」拆到两行
function splitExplain(text) {
  const s = String(text || '');
  const key = '编译器原文';
  const idx = s.indexOf(key);
  if (idx < 0) return { main: s, raw: '' };
  return {
    main: s.slice(0, idx).trim(),
    raw: s.slice(idx + key.length).replace(/^[：:]\s*/, ''),
  };
}

function explainHtml(text) {
  const { main, raw } = splitExplain(text);
  const mainPart = main ? `<span>${escapeHtml(main)}</span>` : '';
  const rawPart = raw ? `<em class="oj-raw">编译器原文：${escapeHtml(raw)}</em>` : '';
  return mainPart + rawPart;
}

function renderResult(detail) {
  if (detail) lastDetail = detail;
  const box = $('resultPanel');

  if (!detail) {
    box.innerHTML = `<div class="oj-result-placeholder">
        <iconify-icon icon="mdi:progress-clock" width="32" height="32"></iconify-icon>
        <p>写好代码后点击提交，稍等就会出现测试结果</p>
      </div>`;
    errorLines.clear();
    warnLines.clear();
    aiLines.clear();
    syncGutter();
    const footer = $('aiDiagFooter');
    if (footer) footer.style.display = 'none';
    return;
  }

  // 行号标记：错误标红、警告标黄
  errorLines = new Set();
  for (const d of detail.diagnostics || []) {
    const n = d.fix_line || d.line;
    if (n) errorLines.add(n);
  }
  warnLines = new Set();
  for (const w of detail.warnings || []) {
    const n = w.fix_line || w.line;
    if (n) warnLines.add(n);
  }
  syncGutter();

  const statusText = {
    AC: '全部通过', WA: '答案错误', CE: '编译错误',
    RE: '运行时错误', TLE: '运行超时', MLE: '内存超限',
    Pending: '判题中', SE: '系统错误',
  };

  let html = `<div class="oj-result-inner">
    <div class="oj-status-row">
      <span class="oj-badge" data-s="${detail.status}">${statusText[detail.status] || detail.status}</span>
      <span class="oj-status-msg">${escapeHtml(detail.message || '')}</span>
    </div>`;

  // 编译诊断
  for (const d of detail.diagnostics || []) {
    html += `
      <div class="oj-diag">
        <div class="oj-diag-head">
          <span class="oj-diag-loc">${escapeHtml(lineLabel(d))}</span>
          <span class="oj-diag-type">${escapeHtml(d.type_zh || '编译错误')}</span>
          ${d.knowledge ? `<span class="oj-diag-know">${escapeHtml(d.knowledge)}</span>` : ''}
        </div>
        <div class="oj-diag-explain">${explainHtml(d.explain)}</div>
        ${renderSnippet(d.snippet)}
      </div>`;
  }

  // 编译警告
  if ((detail.warnings || []).length) {
    html += `<div class="oj-warns">
      <div class="oj-warns-head">编译通过，但有 ${detail.warnings.length} 条警告</div>
      ${detail.warnings.map((w) => `
        <div class="oj-warn-item">
          <span>${escapeHtml(lineLabel(w))}</span>
          <span><b>${escapeHtml(w.type_zh || '')}</b></span>
          <span>${explainHtml(w.explain)}</span>
        </div>`).join('')}
    </div>`;
  }

  // AI 定位
  if (diagnosis && (diagnosis.errors || []).length) {
    html += `<div class="oj-ai-diag">
      <div class="oj-ai-head">
        <iconify-icon icon="mdi:auto-fix" width="16" height="16"></iconify-icon>
        AI 定位 <span class="oj-ai-sum">${escapeHtml(diagnosis.summary || '')}</span>
      </div>
      ${diagnosis.errors.map((e) => `
        <div class="oj-ai-item">
          <div class="oj-ai-item-head">
            <span class="oj-ai-line">第 ${e.line} 行</span>
            <span class="oj-ai-type">${escapeHtml(e.type || '')}</span>
          </div>
          <div class="oj-ai-why">${escapeHtml(e.why || '')}</div>
          ${renderSnippet(buildAiSnippet(e.line))}
        </div>`).join('')}
    </div>`;
  }

  // 错误定位入口放在面板底部（对齐主站 test_page 的询问 AI 按钮位置）
  const diagFooter = $('aiDiagFooter');
  if (diagFooter) {
    diagFooter.style.display = (canDiagnose(detail) && !diagnosis) ? 'flex' : 'none';
  }

  // 测试点
  if ((detail.cases || []).length) {
    html += `<div class="oj-cases">${detail.cases.map((c) => `
      <div class="oj-case">
        <span class="oj-case-badge" data-s="${c.status}">${c.status}</span>
        <span>测试点 #${c.index}</span>
        <span>${c.time_ms} ms</span>
        <span>${escapeHtml((c.message || '').slice(0, 80))}</span>
      </div>`).join('')}</div>`;
  }

  html += '</div>';
  box.innerHTML = html;
}

function renderSnippet(snippet) {
  if (!snippet || !snippet.length) return '';
  const text = snippet.map((line) => {
    // GCC 的片段里 `^^^` 那行是错误位置，标红
    if (/^\s*\^+\s*$/.test(line)) return `<b>${escapeHtml(line)}</b>`;
    return escapeHtml(line);
  }).join('\n');
  return `<div class="oj-diag-code">${text}</div>`;
}

// 按行号从编辑器内容里截一段，格式与编译器返回的片段保持一致
function buildAiSnippet(lineNo) {
  const n = Number(lineNo);
  if (!n || n < 1) return [];
  const lines = getCode().split('\n');
  const code = lines[n - 1];
  if (code === undefined) return [];

  const no = String(n);
  const pad = ' '.repeat(no.length);
  const indent = Math.max(0, code.search(/\S/));
  const len = Math.max(3, code.trim().length || 3);

  return [
    `${no} | ${code}`,
    `${pad} | ${' '.repeat(indent)}${'^'.repeat(len)}`,
  ];
}

function lineLabel(d) {
  if (d.fix_line && d.fix_line !== d.line) return `改第 ${d.fix_line} 行`;
  if (!d.line) return '链接阶段';
  return d.col ? `第 ${d.line} 行 ${d.col} 列` : `第 ${d.line} 行`;
}

function canDiagnose(detail) {
  const st = detail.status;
  if (!st || st === 'AC' || st === 'CE' || st === 'Pending') return false;
  // 代码太短（只有框架）就不给按钮
  const meaningful = getCode()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('#') &&
      l !== '{' && l !== '}' && l !== 'return 0;' && !/^(int|void)\s+main/.test(l));
  return meaningful.length >= 2;
}

async function diagnoseErrors() {
  if (!current || !lastSubmissionId || diagnosing) return;
  diagnosing = true;
  const btn = $('aiDiagBtn');
  const label = $('aiDiagText');
  if (btn) btn.disabled = true;
  if (label) label.textContent = '正在分析代码…';

  try {
    const res = await fetch(`${API}/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem_id: current.id,
        submission_id: lastSubmissionId,
      }),
    });
    const r = await res.json();
    if (!r.ok) {
      alert(r.error || '定位失败');
      return;
    }
    diagnosis = r;
    aiLines = new Set((r.errors || []).map((e) => e.line));
    syncGutter();
    renderResult(lastDetail);   // 带着原始结果重新渲染，追加 AI 区块
  } catch (err) {
    alert(`定位请求失败：${err.message}`);
  } finally {
    diagnosing = false;
    if (btn) btn.disabled = false;
    if (label) label.textContent = 'AI 定位';
  }
}

// ---------------- AI 助教面板（内容由主站 chat.js 提供） ----------------
function bindChatPanel() {
  $('chatCloseBtn').addEventListener('click', () => toggleChat(false));
  $('chatToggleBtn').addEventListener('click', () => {
    toggleChat($('ojChat').classList.contains('is-hidden'));
  });
}

function toggleChat(show) {
  const chat = $('ojChat');
  const layout = $('ojLayout');
  if (!chat || !layout) return;
  if (!show) {
    chat.classList.add('is-hidden');
    layout.classList.add('chat-collapsed');
  } else {
    chat.classList.remove('is-hidden');
    layout.classList.remove('chat-collapsed');
  }
}

// ---------------- 工具 ----------------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
