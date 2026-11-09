/**
 * 全屏知识图谱页（oj_graph_full.html）
 * 复用主站的 GraphState / GraphRenderer：章节是矩形，题目挂在章节下，AC 后变绿。
 * 全屏宽度下用 5 列布局，展开时把后续行整体下移，避免题目压住下一行章节。
 */

import { requireSessionAndCourse } from '../modules/pageGuard.js';

const guardPassed = requireSessionAndCourse();

import { getParticipantId } from '../modules/session.js';
import { GraphState } from '../modules/graph_data.js';
import { GraphRenderer } from '../modules/graph_renderer.js';

const API = '/oj-api';
const BACK_URL = '/pages/oj_graph.html';
const LEARN_URL = '/pages/oj_learn.html';
const PRACTICE_URL = '/pages/oj.html';

const $ = (id) => document.getElementById(id);

const COLS = 5;
const GAP_X = 265;
const GAP_Y = 200;
const ROW_SHIFT = 130;
const KID_SPAN = 80;
const KID_OFFSET_Y = 195;
const KID_TURN_SHIFT = 165;  // 转折处题目组向画布内侧的横移量

let renderer = null;
let graphState = null;

document.addEventListener('DOMContentLoaded', () => {
  if (!guardPassed) return;
  init();
});

async function init() {
  $('backButton').addEventListener('click', () => {
    window.location.href = BACK_URL;
  });

  let chapters = [];
  let problemMap = new Map();
  let details = [];

  try {
    const [lessons, problems] = await Promise.all([
      fetchJson(`${API}/lessons`),
      fetchJson(`${API}/problems`),
    ]);
    chapters = lessons || [];
    (problems || []).forEach((p) => problemMap.set(Number(p.id), p));

    details = await Promise.all(
      chapters.map((c) => fetchJson(`${API}/lessons/${c.chapter}`))
    );
  } catch (err) {
    $('cy').innerHTML = `<div class="oj-loading" style="padding:24px">加载失败：${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!chapters.length) {
    $('cy').innerHTML = '<div class="oj-loading" style="padding:24px">题库为空</div>';
    return;
  }

  const solved = await loadSolvedSet();
  renderGraph(details, problemMap, solved);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSolvedSet() {
  const pid = getParticipantId();
  if (!pid) return new Set();
  try {
    const summary = await fetchJson(
      `${API}/submissions/summary?participant_id=${encodeURIComponent(pid)}`
    );
    return new Set(summary.filter((s) => s.solved).map((s) => Number(s.problem_id)));
  } catch {
    return new Set();
  }
}

/* ---------------- 构图 ---------------- */

function buildGraphData(details, problemMap) {
  const nodes = [];
  const edges = [];

  details.forEach((d, ci) => {
    const chId = `ch_${d.chapter}`;
    nodes.push({ data: { id: chId, label: d.title, type: 'chapter' } });

    const pids = Array.isArray(d.problems) ? d.problems : [];
    let prevId = chId;

    pids.forEach((pid, pi) => {
      const p = problemMap.get(Number(pid));
      if (!p) return;

      const nodeId = `${chId}_${pi + 1}`;
      nodes.push({
        data: { id: nodeId, label: p.title, type: 'knowledge', problemId: p.id },
      });
      edges.push({ data: { source: prevId, target: nodeId } });
      prevId = nodeId;
    });

    if (ci > 0) {
      edges.push({ data: { source: `ch_${details[ci - 1].chapter}`, target: chId } });
    }
  });

  return { nodes, edges, dependent_edges: [], metadata: null };
}

function renderGraph(details, problemMap, solved) {
  const graphData = buildGraphData(details, problemMap);

  const learnedNodes = [];
  graphData.nodes.forEach((n) => {
    if (n.data.type === 'knowledge' && solved.has(Number(n.data.problemId))) {
      learnedNodes.push(n.data.id);
    }
  });
  details.forEach((d) => {
    const pids = (Array.isArray(d.problems) ? d.problems : []).map(Number);
    if (pids.length && pids.every((pid) => solved.has(pid))) {
      learnedNodes.push(`ch_${d.chapter}`);
    }
  });

  try {
    graphState = new GraphState(graphData, learnedNodes);
    graphState.initMaps();

    renderer = new GraphRenderer('cy', graphState);
    renderer.addElements([...graphData.nodes, ...graphData.edges]);

    renderer.cy.nodes('[type="knowledge"]').style({
      width: 70,
      height: 70,
      'font-size': '10px',
      'text-max-width': '62px',
      'text-wrap': 'wrap',
      'text-overflow-wrap': 'anywhere',
    });
    // 让悬停动画以 70px 为基准放大，而不是样式表里的 120px
    renderer.cy.nodes('[type="knowledge"]').forEach((n) => {
      if (renderer.originalSizes) renderer.originalSizes.set(n.id(), { width: 70, height: 70 });
    });

    renderer.hideAllKnowledgeNodes();
    layoutChapters();
    renderer.updateNodeColors();
  } catch (err) {
    console.error('图谱初始化失败:', err);
    $('cy').innerHTML = '<div class="oj-loading" style="padding:24px">图谱渲染失败</div>';
    return;
  }

  // 原站的悬停动画按 120px 的基准放大节点并把字号改到 18px，
  // 而且 mouseout 不恢复字号。我们的节点只有 70px，直接卸掉这套监听，
  // 换成只加粗边框的轻量反馈。
  renderer.cy.off('mouseover', 'node');
  renderer.cy.off('mouseout', 'node');

  renderer.cy.on('mouseover', 'node', (evt) => {
    evt.target.style({ 'border-width': 3, 'border-color': '#4f46e5' });
    renderer.cy.container().style.cursor = 'pointer';
  });
  renderer.cy.on('mouseout', 'node', (evt) => {
    evt.target.removeStyle('border-width border-color');
    renderer.cy.container().style.cursor = 'default';
  });

  bindTools();
  bindNodeClick();
  window.__cy = renderer.cy;
  window.__toggleChapter = (id) => handleSingle(renderer.cy.getElementById(id));
}

/* ---------------- 布局 ---------------- */

function layoutChapters() {
  const cy = renderer.cy;
  const chapters = cy.nodes('[type="chapter"]');
  const totalRows = Math.ceil(chapters.length / COLS);

  chapters.forEach((node, i) => {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    const x = (row % 2 === 0 ? col : COLS - 1 - col) * GAP_X;
    const y = row * GAP_Y;

    node.position({ x, y });
    node.data('order', i);
    // 每行最后一个（且下面还有一行）是蛇形转折的起点，
    // 章节链边会从它垂直向下，题目组不能再压在正下方
    node.data('isTurn', col === COLS - 1 && row < totalRows - 1);
    node.data('rowParity', row % 2);

    graphState.fixedPositions[node.id()] = { x, y };
  });
  fitVisible();
}

function fitVisible() {
  const cy = renderer.cy;
  const visible = cy.nodes(':visible');
  if (visible.length) cy.fit(visible, 60);
}

/* ---------------- 交互 ---------------- */

function bindTools() {
  const cy = renderer.cy;
  const center = () => {
    const box = $('cy').getBoundingClientRect();
    return { x: box.width / 2, y: box.height / 2 };
  };

  $('zoomInBtn').addEventListener('click', () => cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: center() }));
  $('zoomOutBtn').addEventListener('click', () => cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: center() }));
  $('fitBtn').addEventListener('click', () => fitVisible());
}

function bindNodeClick() {
  const cy = renderer.cy;
  let lastId = null;
  let lastTs = 0;
  let timer = null;
  const DBL_DELAY = 260;

  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    const id = node.id();
    const now = Date.now();

    if (lastId === id && now - lastTs < DBL_DELAY) {
      clearTimeout(timer);
      timer = null;
      lastId = null;
      handleDouble(node);
    } else {
      lastId = id;
      lastTs = now;
      timer = setTimeout(() => {
        handleSingle(node);
        timer = null;
        lastId = null;
      }, DBL_DELAY);
    }
  });
}

function handleSingle(node) {
  const type = node.data('type');
  if (type === 'chapter') {
    toggleChapter(node.id());
    return;
  }
  const pid = node.data('problemId');
  if (pid) window.location.href = `${PRACTICE_URL}?pid=${pid}`;
}

function handleDouble(node) {
  if (node.data('type') !== 'chapter') return;
  const chapter = Number(String(node.id()).replace('ch_', ''));
  if (chapter) window.location.href = `${LEARN_URL}?chapter=${chapter}`;
}

/* ---------------- 展开 / 收起 ---------------- */

function toggleChapter(chId) {
  const cy = renderer.cy;
  if (!cy.getElementById(chId).length) return;

  const kids = graphState.collectKnowledgeDescendantsForDisplay(chId);
  if (!kids.length) return;

  if (graphState.expandedSet.has(chId)) {
    graphState.expandedSet.delete(chId);
    hideKids(chId);
  } else {
    graphState.expandedSet.add(chId);
  }

  renderer.updateNodeColors();
  relayoutAll();
  graphState.expandedSet.forEach((id) => placeKids(id));
  applyDim();
  // 不自动缩放，视野交给用户自己拖
}

function hideKids(chId) {
  const cy = renderer.cy;
  const kids = graphState.collectKnowledgeDescendantsForDisplay(chId);

  kids.forEach((id) => {
    const n = cy.getElementById(id);
    if (n.length) n.hide();

    // 与这些节点相连的边全部隐藏
    cy.edges().filter((e) => e.data('source') === id || e.data('target') === id)
      .forEach((e) => e.style('display', 'none'));
  });

  // 章节到第一个题目的边
  if (kids.length) {
    const e = cy.edges(`[source = "${chId}"][target = "${kids[0]}"]`);
    if (e.length) e.style('display', 'none');
  }
}

function relayoutAll() {
  const cy = renderer.cy;
  const expandedRows = new Set();
  graphState.expandedSet.forEach((id) => {
    const base = graphState.fixedPositions[id];
    if (base) expandedRows.add(Math.round(base.y / GAP_Y));
  });

  cy.nodes('[type="chapter"]').forEach((n) => {
    const base = graphState.fixedPositions[n.id()];
    if (!base) return;
    const row = Math.round(base.y / GAP_Y);
    let shift = 0;
    for (const r of expandedRows) if (r < row) shift += ROW_SHIFT;
    // 目标位置不同才做动画，避免无谓抖动
    const target = { x: base.x, y: base.y + shift };
    const cur = n.position();
    if (Math.abs(cur.x - target.x) > 1 || Math.abs(cur.y - target.y) > 1) {
      n.animate({ position: target }, { duration: 260, easing: 'ease-in-out-cubic' });
    }
  });
}

function placeKids(chId) {
  const cy = renderer.cy;
  const chapter = cy.getElementById(chId);
  if (!chapter.length) return;

  const kids = graphState.collectKnowledgeDescendantsForDisplay(chId);
  const pos = chapter.position();
  const span = Math.min(KID_SPAN, 200 / Math.max(1, kids.length - 1));

  // 转折处：偶数行末在最右 → 题目往左；奇数行末在最左 → 题目往右
  const isTurn = chapter.data('isTurn');
  const shiftX = isTurn
    ? (chapter.data('rowParity') === 0 ? -KID_TURN_SHIFT : KID_TURN_SHIFT)
    : 0;

  let prevId = chId;

  kids.forEach((id, i) => {
    const node = cy.getElementById(id);
    if (!node.length) return;

    // 直接点亮这一条边，不依赖 visible() 的判断
    const edge = cy.edges(`[source = "${prevId}"][target = "${id}"]`);
    if (edge.length) edge.style('display', 'element');
    prevId = id;

    node.position({
      x: pos.x + shiftX + (i - (kids.length - 1) / 2) * span,
      y: pos.y + KID_OFFSET_Y,
    });
    node.style({
      width: 70,
      height: 70,
      'font-size': '10px',
      'text-max-width': '62px',
      opacity: 0,
    });
    if (renderer.originalSizes) renderer.originalSizes.set(id, { width: 70, height: 70 });
    node.show();
    node.animate(
      { position: node.position(), style: { opacity: 1 } },
      { duration: 240, easing: 'ease-out-cubic' }
    );
  });
}

// 展开时把视野对准该章节及其题目
function focusChapter(chId) {
  const cy = renderer.cy;
  const chapter = cy.getElementById(chId);
  if (!chapter.length) return;

  const kids = graphState
    .collectKnowledgeDescendantsForDisplay(chId)
    .map((id) => cy.getElementById(id))
    .filter((n) => n.length && n.visible());

  const eles = cy.collection().merge(chapter);
  kids.forEach((n) => eles.merge(n));

  cy.animate({
    fit: { eles, padding: 90 },
    duration: 350,
  });
}

// 只控制边的显隐，颜色和线型保留主站样式表里的定义
function syncEdgeVisibility() {
  const cy = renderer.cy;
  cy.edges().forEach((e) => {
    const sn = cy.getElementById(e.data('source'));
    const tn = cy.getElementById(e.data('target'));
    const show = sn.length && tn.length && sn.visible() && tn.visible();
    e.style('display', show ? 'element' : 'none');
  });
}

function applyDim() {
  const cy = renderer.cy;
  const anyExpanded = graphState.expandedSet.size > 0;
  cy.nodes('[type="chapter"]').forEach((n) => {
    const on = graphState.expandedSet.has(n.id());
    n.style('opacity', !anyExpanded || on ? 1 : 0.4);
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
