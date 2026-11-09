/**
 * 算法学习页（oj_learn.html）
 * 结构对齐主站 learning_page.html：上块知识点讲解，下块渐进式题目，右侧 AI 助教。
 *
 * 数据分层：
 *   /oj-api/lessons            章节摘要列表
 *   /oj-api/lessons/{chapter}  章节详情（含 definition/points/example/pitfalls/problems）
 *   /oj-api/problems           题目摘要列表
 *   /oj-api/problems/{id}      题目详情（含 description/samples）
 */

import { getParticipantId } from '../modules/session.js';
import chatModule from '../modules/chat.js';
import tracker from '../modules/behavior_tracker.js';
import apiClient from '../api_client.js';
import { requireSessionAndCourse } from '../modules/pageGuard.js';
import { installOjChatTransport, clearChatHistory } from '../modules/oj_chat_transport.js';

const guardPassed = requireSessionAndCourse();

const API = '/oj-api';
const PRACTICE_URL = '/pages/oj.html';

const state = {
  lessons: [],      // 章节摘要
  problems: new Map(), // id -> 题目摘要
  index: 0,
  detail: null,     // 当前章节详情
  openPid: null,
  detailCache: new Map(),
};

const $ = (id) => document.getElementById(id);

/* ---------------- 初始化 ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  if (!guardPassed) return;
  init();
});

async function init() {
  bindHeader();
  initMainChat();

  try {
    const [lessons, problems] = await Promise.all([
      fetchJson(`${API}/lessons`),
      fetchJson(`${API}/problems`),
    ]);
    state.lessons = lessons || [];
    (problems || []).forEach((p) => state.problems.set(Number(p.id), p));
  } catch (err) {
    renderError(`题目数据加载失败：${err.message}`);
    return;
  }

  if (!state.lessons.length) {
    renderError('题库为空，请先运行 seed 脚本导入题目');
    return;
  }

  const fromUrl = Number(new URLSearchParams(location.search).get('chapter'));
  state.index = Number.isInteger(fromUrl) && fromUrl >= 1 && fromUrl <= state.lessons.length
    ? fromUrl - 1
    : 0;

  await renderChapter();

  // 支持 ?open=题目id 直接展开某道题
  const openPid = Number(new URLSearchParams(location.search).get('open'));
  if (openPid && state.detail?.problems?.includes(openPid)) {
    state.openPid = openPid;
    renderProblemCards();
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---------------- 顶栏与切章 ---------------- */

function bindHeader() {
  $('backButton').addEventListener('click', () => {
    // 一级一级返回：从目录页、图谱页或练习页进来就退回那一页；
    // 直接打开学习页（没有同源来路）时才回到目录页。
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
      window.location.href = '/pages/oj_graph.html';
    }
  });

  $('prevChapterBtn').addEventListener('click', async () => {
    if (state.index > 0) {
      state.index -= 1;
      state.openPid = null;
      await renderChapter();
    }
  });

  $('nextChapterBtn').addEventListener('click', async () => {
    if (state.index < state.lessons.length - 1) {
      state.index += 1;
      state.openPid = null;
      await renderChapter();
    }
  });
}

async function renderChapter() {
  const meta = state.lessons[state.index];
  const total = state.lessons.length;

  $('chapterTitle').textContent = meta.title;
  $('chapterBadge').textContent = `第 ${state.index + 1} / ${total} 章`;
  $('prevChapterBtn').disabled = state.index === 0;
  $('nextChapterBtn').disabled = state.index === total - 1;

  $('knowledgeContent').innerHTML = '<div class="oj-loading">加载知识点…</div>';
  $('problemCards').innerHTML = '<div class="oj-loading">加载题目…</div>';

  try {
    state.detail = await fetchJson(`${API}/lessons/${meta.chapter}`);
  } catch (err) {
    renderError(`第 ${meta.chapter} 章加载失败：${err.message}`);
    return;
  }

  renderKnowledge(state.detail);
  renderProblemCards();
}

/* ---------------- 知识点讲解 ---------------- */

function renderKnowledge(lesson) {
  const box = $('knowledgeContent');
  const parts = [];

  if (lesson.intro) {
    parts.push(`<h3>${escapeHtml(lesson.intro)}</h3>`);
  }

  if (lesson.definition) {
    parts.push(section('mdi:text-box-outline', '概念', `<p>${escapeHtml(lesson.definition)}</p>`));
  }

  if (Array.isArray(lesson.points) && lesson.points.length) {
    const items = lesson.points.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
    parts.push(section('mdi:format-list-checks', '要点', `<ul>${items}</ul>`));
  }

  if (lesson.example) {
    parts.push(section('mdi:code-tags', '示例代码',
      `<pre class="oj-code-block">${escapeHtml(lesson.example)}</pre>`));
  }

  if (Array.isArray(lesson.pitfalls) && lesson.pitfalls.length) {
    const items = lesson.pitfalls.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
    parts.push(section('mdi:alert-circle-outline', '常见错误',
      `<ul class="oj-pitfall-list">${items}</ul>`));
  }

  box.innerHTML = parts.join('') || '<div class="oj-loading">本章暂无知识点内容</div>';
  box.scrollTop = 0;
}

function section(icon, label, body) {
  return `<section class="oj-k-section">
    <div class="oj-k-label"><iconify-icon icon="${icon}" width="16" height="16"></iconify-icon>${label}</div>
    ${body}
  </section>`;
}

/* ---------------- 题目卡片 ---------------- */

function renderProblemCards() {
  const ids = Array.isArray(state.detail?.problems) ? state.detail.problems : [];
  const box = $('problemCards');

  // 展开态：整块替换为题目详情（对齐主站渐进式卡片的展开方式）
  if (state.openPid) {
    box.innerHTML = '<div class="oj-card-detail"><div class="oj-loading">加载题目详情…</div></div>';
    fillDetail(box.querySelector('.oj-card-detail'), state.openPid);
    return;
  }

  const chapterName = state.detail?.title || '';
  const cards = ids.map((pid, i) => {
    const p = state.problems.get(Number(pid));
    if (!p) return '';
    const desc = [p.difficulty || '易', chapterName].filter(Boolean).join(' · ');
    return `<div class="oj-problem-card" data-pid="${p.id}">
      <div class="oj-card-level">Level ${i + 1} · ${escapeHtml(p.title)}</div>
      <div class="oj-card-desc">${escapeHtml(desc)}</div>
      <div class="oj-card-enter">
        <iconify-icon icon="mdi:gesture-tap" width="14" height="14"></iconify-icon>
        点击进入学习
      </div>
    </div>`;
  }).filter(Boolean);

  $('problemCount').textContent = `${cards.length} 题`;

  if (!cards.length) {
    box.innerHTML = '<div class="oj-loading">本章暂无题目</div>';
    return;
  }

  box.innerHTML = `<div class="oj-card-flow">${cards.join('')}</div>`;

  box.querySelectorAll('.oj-problem-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.openPid = Number(card.dataset.pid);
      renderProblemCards();
      $('problemCards').scrollTop = 0;
    });
  });
}

async function fillDetail(box, pid) {
  let full = state.detailCache.get(pid);
  if (!full) {
    try {
      full = await fetchJson(`${API}/problems/${pid}`);
      state.detailCache.set(pid, full);
    } catch (err) {
      box.innerHTML = `<div class="oj-loading">题目详情加载失败：${escapeHtml(err.message)}</div>`;
      return;
    }
  }

  // 用户可能在加载期间返回了列表
  if (state.openPid !== pid) return;

  const levelNo = (state.detail?.problems || []).indexOf(pid) + 1;
  const samples = Array.isArray(full.samples) && full.samples.length ? full.samples[0] : null;
  const samplesHtml = samples ? `<div class="oj-sample">
      <div class="oj-sample-box"><span>输入</span><pre>${escapeHtml(samples.input || '')}</pre></div>
      <div class="oj-sample-box"><span>输出</span><pre>${escapeHtml(samples.output || '')}</pre></div>
    </div>` : '';

  box.innerHTML = `
    <div class="oj-detail-head">
      <button class="oj-back-link" data-action="back">
        <iconify-icon icon="mdi:chevron-left" width="16" height="16"></iconify-icon>
        返回题目
      </button>
      <div class="oj-detail-title">
        <span class="oj-detail-level">Level ${levelNo > 0 ? levelNo : 1}</span>
        <h3>${escapeHtml(full.title)}</h3>
      </div>
    </div>
    <div class="oj-detail-body">
      <div>${full.description || ''}</div>
      ${full.input_description ? `<p><strong>输入</strong>：${full.input_description}</p>` : ''}
      ${full.output_description ? `<p><strong>输出</strong>：${full.output_description}</p>` : ''}
      ${samplesHtml}
    </div>
    <div class="oj-detail-actions">
      <button class="oj-btn" data-action="hint">
        <iconify-icon icon="mdi:lightbulb-on-outline" width="16" height="16"></iconify-icon>
        给点灵感
      </button>
      <button class="oj-btn oj-btn-primary" data-action="start">
        <iconify-icon icon="mdi:play" width="16" height="16"></iconify-icon>
        开始练习
      </button>
    </div>`;

  box.querySelector('[data-action="back"]').addEventListener('click', () => {
    state.openPid = null;
    renderProblemCards();
  });

  box.querySelector('[data-action="start"]').addEventListener('click', () => {
    window.location.href = `${PRACTICE_URL}?pid=${pid}`;
  });

  box.querySelector('[data-action="hint"]').addEventListener('click', () => {
    const input = document.getElementById('user-message');
    if (!input) return;
    tracker.logEvent('ai_help_request', {
      topic_id: topicId(),
      source: 'problem_solving_hint_button',
    });
    input.value = `我想做「${full.title}」这道题，给我一点思路提示，不要直接给答案。`;
    chatModule.sendMessage('learning', topicId());
  });
}

/* ---------------- AI 助教 ---------------- */

/* ---------------- AI 助教：直接复用主站 chat.js ---------------- */

function topicId() {
  const lesson = state.lessons[state.index];
  return `oj_lesson_${lesson ? lesson.chapter : 1}`;
}

function buildLearnPrompt(message) {
  const d = state.detail;
  const lines = [message, '', '【场景】C 语言算法课程 · 章节知识点学习，不是 HTML/CSS/JS 前端课程。'];

  if (d) {
    lines.push(`【章节】${d.title}`);
    if (d.definition) lines.push(`【概念】${String(d.definition).slice(0, 400)}`);
    if (Array.isArray(d.points) && d.points.length) {
      lines.push(`【要点】${d.points.join('；')}`);
    }
    if (state.openPid) {
      const p = state.problems.get(Number(state.openPid));
      if (p) lines.push(`【当前题目】${p.title}`);
    }
  }
  lines.push('请只围绕这个 C 语言知识点讲解，不要引用 HTML 标签、CSS 或前端内容。');
  return lines.join('\n');
}

function initMainChat() {
  if (!getParticipantId()) {
    console.warn('[OJ] 没有 participant_id，AI 助教需要登录态');
    return;
  }

  // behavior_tracker 依赖全局 apiClient
  window.apiClient = apiClient;

  chatModule.init('learning', topicId(), { enableEnterToSend: false });
  clearChatHistory(chatModule, '遇到问题可以问我。我会先给提示，引导你自己想出来，不直接给答案。');

  installOjChatTransport(chatModule, {
    mode: 'learning',
    buildPrompt: buildLearnPrompt,
    getTopicId: topicId,
    getParticipantId,
    onSend: (msg) => tracker.logEvent('ai_help_request', {
      topic_id: topicId(),
      message_length: msg.length,
    }),
  });
}

/* ---------------- 工具 ---------------- */

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderError(msg) {
  $('knowledgeContent').innerHTML = `<div class="oj-loading">${escapeHtml(msg)}</div>`;
  $('problemCards').innerHTML = '';
}
