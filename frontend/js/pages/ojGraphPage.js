/**
 * 算法课程入口页（oj_graph.html）
 * 左：章节目录；右：学习概览（通过数、提交次数、最近提交）。
 * 知识图谱在独立的全屏页 oj_graph_full.html。
 */

import { requireSessionAndCourse } from '../modules/pageGuard.js';

const guardPassed = requireSessionAndCourse();

const API = '/oj-api';
const LEARN_URL = '/pages/oj_learn.html';
const GRAPH_URL = '/pages/oj_graph_full.html';

const $ = (id) => document.getElementById(id);

let problemMap = new Map();

document.addEventListener('DOMContentLoaded', () => {
  if (!guardPassed) return;
  init();
});

async function init() {
  $('backButton').addEventListener('click', () => {
    window.location.href = '/pages/course_selection.html';
  });

  $('graphButton').addEventListener('click', () => {
    window.location.href = GRAPH_URL;
  });

  let chapters = [];
  let problems = [];

  try {
    [chapters, problems] = await Promise.all([
      fetchJson(`${API}/lessons`),
      fetchJson(`${API}/problems`),
    ]);
  } catch (err) {
    $('catalog').innerHTML = `<div class="oj-loading">章节加载失败：${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!chapters.length) {
    $('catalog').innerHTML = '<div class="oj-loading">题库为空</div>';
    return;
  }

  problems.forEach((p) => problemMap.set(Number(p.id), p));
  $('catalogCount').textContent = `${chapters.length} 章`;
  renderCatalog(chapters);

  renderStats(problems.length, await loadSummary());
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSummary() {
  const pid = localStorage.getItem('participant_id');
  if (!pid) return [];
  try {
    return await fetchJson(
      `${API}/submissions/summary?participant_id=${encodeURIComponent(pid)}`
    );
  } catch (err) {
    console.warn('学习进度加载失败:', err);
    return [];
  }
}

/* ---------------- 目录 ---------------- */

function renderCatalog(items) {
  $('catalog').innerHTML = items.map((l, i) => `
    <button class="oj-cat-item" data-chapter="${l.chapter}">
      <span class="oj-cat-no">${i + 1}</span>
      <span class="oj-cat-main">
        <span class="oj-cat-title">${escapeHtml(l.title)}</span>
        <span class="oj-cat-sub">${l.problem_count} 道题</span>
      </span>
      <iconify-icon class="oj-cat-arrow" icon="mdi:chevron-right" width="18" height="18"></iconify-icon>
    </button>`).join('');

  $('catalog').querySelectorAll('.oj-cat-item').forEach((el) => {
    el.addEventListener('click', () => {
      window.location.href = `${LEARN_URL}?chapter=${Number(el.dataset.chapter)}`;
    });
  });
}

/* ---------------- 学习概览 ---------------- */

function renderStats(totalProblems, summary) {
  const solved = summary.filter((s) => s.solved).length;
  const attempts = summary.reduce((sum, s) => sum + (s.attempts || 0), 0);
  const rate = totalProblems ? Math.round((solved / totalProblems) * 100) : 0;

  $('statSolved').textContent = solved;
  $('statTotal').textContent = totalProblems;
  $('statAttempts').textContent = attempts;
  $('statRate').textContent = `${rate}%`;
  $('statFill').style.width = `${rate}%`;

  const recent = summary
    .slice()
    .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)))
    .slice(0, 6);

  if (!recent.length) {
    $('recentList').innerHTML = '<div class="oj-loading">还没有提交记录，从下面挑一章开始吧</div>';
    return;
  }

  $('recentList').innerHTML = recent.map((r) => {
    const p = problemMap.get(Number(r.problem_id));
    const ok = Number(r.solved) === 1;
    return `<div class="oj-recent-item">
      <span class="oj-dot" data-ok="${ok ? 1 : 0}"></span>
      <span class="oj-recent-title">${escapeHtml(p ? p.title : `题目 ${r.problem_id}`)}</span>
      <span class="oj-recent-meta">${ok ? '通过' : `${r.attempts} 次`}</span>
    </div>`;
  }).join('');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
