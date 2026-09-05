// frontend/js/modules/section_feedback.js
/**
 * 小节/章节反馈模块
 *
 * 流程（对应设计稿过程线，其中后台步骤不直接展示给用户）：
 *   [后台] 系统生成评价
 *    -> 用户自我评价
 *   [后台] 评分对比【<>=】+ 自动修改负向/正向文本
 *    -> 展示系统评价
 *
 * 系统评价内容：
 *   - 打分（5星制，基于测试尝试次数与通过情况）
 *   - 偏负向错误总结型文本（高频错误代码 + 薄弱点文本，从用户角度人性化表达）
 *   - 偏正向肯定激励型文本（激励文本）
 */

// 星级文字标签
const STAR_LABELS = {
  0: '点击星星，为你的表现打分',
  1: '很不满意',
  2: '不太满意',
  3: '一般',
  4: '满意',
  5: '非常满意',
};

// 保存当前弹窗的 Promise resolve，避免并发弹窗
let currentResolver = null;

// ---------------------------------------------------------------------------
// 系统评价生成（基于测试结果，规则驱动）
// ---------------------------------------------------------------------------

function dedup(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

/**
 * 计算系统打分（5星制，保留1位小数）
 * 首次通过 = 5.0；每失败一次扣 0.5 分，最低 2.5 分
 */
function computeSystemScore(failedSubmissionCount) {
  const penalty = Math.min(2.5, (failedSubmissionCount || 0) * 0.5);
  return Math.round((5.0 - penalty) * 10) / 10;
}

/**
 * 从失败详情中解析 "检查点 N 失败: xxx" 格式
 * 返回 [{ index, feedback }]
 */
function parseFailureDetails(details) {
  const result = [];
  for (const d of dedup(details)) {
    const m = String(d).match(/检查点\s*(\d+)\s*失败[：:]\s*(.+)/);
    if (m) {
      result.push({ index: parseInt(m[1], 10), feedback: m[2].trim() });
    } else {
      result.push({ index: null, feedback: String(d).trim() });
    }
  }
  return result;
}

/**
 * 从用户代码快照中提取与失败检查点相关的代码行（高频错误代码）
 */
function extractErrorCodeLines(parsedFailures, checkpoints, codeSnapshot) {
  const codeMap = {
    html: (codeSnapshot && codeSnapshot.html) || '',
    css: (codeSnapshot && codeSnapshot.css) || '',
    js: (codeSnapshot && codeSnapshot.js) || '',
  };
  const lines = [];

  for (const failure of parsedFailures) {
    if (lines.length >= 3) break;
    if (failure.index === null) continue;

    const cp = (checkpoints && checkpoints[failure.index - 1]) || null;
    if (!cp) continue;

    // 提取选择器（h2 / .class / #id / [attr] 等）
    const selector = (cp.selector || '').trim();
    if (!selector) continue;
    const needle = selector.replace(/^[.#]/, '').replace(/\[.*\]/, '');

    for (const [lang, code] of Object.entries(codeMap)) {
      if (lines.length >= 3) break;
      if (!code) continue;
      const codeLines = code.split('\n');
      for (let i = 0; i < codeLines.length; i++) {
        const text = codeLines[i].trim();
        if (!text || text.startsWith('//')) continue;
        if (text.includes(needle)) {
          lines.push({ line: i + 1, lang, code: text.slice(0, 60) });
          break; // 每个语言最多取一行与该检查点相关的代码
        }
      }
    }
  }
  return lines;
}

/**
 * 将检查点失败反馈转成更贴近用户的表达
 * @param {Object} failure { index, feedback }
 * @param {Object|null} checkpoint 检查点配置（可能缺失）
 */
function humanizeFailure(failure, checkpoint) {
  if (!checkpoint) return failure.feedback;

  const selector = (checkpoint.selector || '').trim();
  const value = checkpoint.value;
  const cpType = checkpoint.type;
  const op = checkpoint.assertion_type;

  if (cpType === 'assert_element') {
    if (op === 'exists') {
      return selector
        ? `还没在页面中看到 ${selector} 元素，试着添加一个，内容会更有层次感～`
        : failure.feedback;
    }
    if (op === 'not_exists') {
      return selector
        ? `页面中出现了 ${selector} 元素，这一步暂时用不到它，可以先移除～`
        : failure.feedback;
    }
  }

  if (cpType === 'assert_text_content') {
    if (op === 'equals') {
      return selector
        ? `${selector} 里的文字需要是「${value || '指定内容'}」，看看你写的和它是否完全一致～`
        : failure.feedback;
    }
    if (op === 'contains') {
      return selector
        ? `${selector} 里的文字最好能包含「${value || '指定内容'}」，试着补充一下～`
        : failure.feedback;
    }
    if (op === 'matches_regex') {
      return selector
        ? `${selector} 里的文字格式还没对上要求，再检查一下拼写和格式～`
        : failure.feedback;
    }
  }

  if (cpType === 'assert_attribute') {
    if (op === 'exists') {
      return selector
        ? `记得给 ${selector} 加上 ${checkpoint.attribute || '对应'} 属性～`
        : failure.feedback;
    }
    if (op === 'not_exists') {
      return selector
        ? `${selector} 上的 ${checkpoint.attribute || '对应'} 属性这一步用不到，可以先去掉～`
        : failure.feedback;
    }
    return selector
      ? `${selector} 的 ${checkpoint.attribute || '相关'} 属性和期望还有差距，再检查一下～`
      : failure.feedback;
  }

  if (cpType === 'assert_style') {
    return selector
      ? `${selector} 的样式和期望还差一点，重点看看 ${checkpoint.css_property || '相关属性'} 的设置～`
      : failure.feedback;
  }

  if (cpType === 'custom_script') {
    return '部分元素的先后顺序还没对上要求，试着调整一下它们的位置～';
  }

  return failure.feedback;
}

/**
 * 生成偏负向错误总结文本（薄弱点 + 高频错误代码，人性化表达）
 */
function generateNegativeText({ parsedFailures, errorCodeLines, checkpoints }) {
  const parts = [];

  if (parsedFailures.length > 0) {
    parts.push('这一节里，还有几个小地方可以再打磨一下：');
    parsedFailures.slice(0, 3).forEach((f) => {
      const cp = (checkpoints && checkpoints[f.index - 1]) || null;
      parts.push(`· ${humanizeFailure(f, cp)}`);
    });
  }

  if (errorCodeLines.length > 0) {
    parts.push('下面这几处代码和上面的薄弱点有关，可以对照着检查：');
    errorCodeLines.forEach((l) => parts.push(`· ${l.lang.toUpperCase()} 代码第 ${l.line} 行附近：${l.code}`));
  }

  if (parts.length === 0) {
    return '这一节掌握得很扎实，没有发现明显的薄弱点，继续保持！';
  }
  parts.push('别灰心，照着提示再改一改，很快就能看到进步！');
  return parts.join('\n');
}

/**
 * 生成偏正向激励文本
 */
function generatePositiveText({ systemScore, failedSubmissionCount, isChapter }) {
  const name = isChapter ? '章节' : '小节';
  let core = '';
  if (systemScore >= 4.5) {
    core = '太棒了！你的表现非常出色，内容掌握得很扎实！继续保持这份热情，下一个知识点正在等你挑战！';
  } else if (systemScore >= 3.5) {
    core = '很不错！你已经掌握了大部分内容，再细心一点就能满分通过，继续加油！';
  } else {
    core = '完成就是胜利！每一次尝试都在让你变得更强，别灰心，再多练习几次一定会越来越好！';
  }

  if (failedSubmissionCount > 0) {
    core += `\n经过 ${failedSubmissionCount} 次尝试后通过本${name}，这份坚持非常值得肯定！`;
  }
  return core;
}

/**
 * 综合生成系统评价
 */
function generateSystemEvaluation(options) {
  const {
    feedbackType,
    submissionMsg,
    failedSubmissionCount,
    accumulatedFailures,
    lastFailedCode,
    task,
  } = options;

  const isChapter = feedbackType === 'chapter';

  // 合并历史失败详情（包含最后一次提交的 details）
  const allFailures = dedup([...(accumulatedFailures || []), ...((submissionMsg && submissionMsg.details) || [])]);
  const parsedFailures = parseFailureDetails(allFailures);
  const checkpoints = (task && task.checkpoints) || [];

  const errorCodeLines = extractErrorCodeLines(parsedFailures, checkpoints, lastFailedCode);
  const systemScore = computeSystemScore(failedSubmissionCount);
  const negativeText = generateNegativeText({ parsedFailures, errorCodeLines, checkpoints });
  const positiveText = generatePositiveText({ systemScore, failedSubmissionCount, isChapter });

  return {
    systemScore,
    negativeText,
    positiveText,
    parsedFailures,
    errorCodeLines,
  };
}

// ---------------------------------------------------------------------------
// 后台操作：评分对比 + 自动修改文本（不直接展示中间过程）
// ---------------------------------------------------------------------------

/**
 * 后台完成评分对比，并根据对比结果自动微调负向/正向文本。
 * @param {Object} systemEval 系统评价 { systemScore, negativeText, positiveText }
 * @param {number} selfScore 用户自我评分（1-5）
 * @returns {{symbol: string, comparisonText: string, negativeText: string, positiveText: string, diff: number}}
 */
function finalizeEvaluation(systemEval, selfScore) {
  const sysScore = systemEval.systemScore;
  const diff = selfScore - sysScore;

  let symbol = '=';
  let comparisonText = '你的自我评价和系统评价一致，看来你对自己的掌握程度有很清晰的判断！';

  if (diff > 0) {
    symbol = '>';
    comparisonText = `你给自己打了 ${selfScore} 分，比系统评价高 ${diff.toFixed(1)} 分。自信是好事，也可以对照下面这些提示再巩固一下～`;
  } else if (diff < 0) {
    symbol = '<';
    comparisonText = `你给自己打了 ${selfScore} 分，比系统评价低 ${Math.abs(diff).toFixed(1)} 分。其实你比自己想象中做得更好，请多给自己一些肯定！`;
  }

  // 后台自动修改文本：根据对比结果做温和的补充
  let negativeText = systemEval.negativeText;
  let positiveText = systemEval.positiveText;

  if (diff > 0) {
    // 自评高于系统分：可能是某些细节还没完全掌握，温和提醒
    negativeText += '\n\n如果刚才有哪里不太确定，可以重点看看上面这几条，再动手改一改～';
  } else if (diff < 0) {
    // 自评低于系统分：加强肯定，帮助建立信心
    positiveText += '\n你比自己想象中掌握得更好，下次可以更大胆地肯定自己！';
  }

  return { symbol, comparisonText, negativeText, positiveText, diff };
}

// ---------------------------------------------------------------------------
// 星星渲染工具
// ---------------------------------------------------------------------------

/**
 * 渲染只读星级（支持小数，如 4.5 -> 4颗满星 + 半星）
 */
function renderReadonlyStars(score) {
  const full = Math.floor(score);
  const frac = score - full;
  let html = '';
  for (let i = 1; i <= 5; i++) {
    if (i <= full) {
      html += '<span class="fb-star fb-star-filled">★</span>';
    } else if (i === full + 1 && frac >= 0.25 && frac < 0.75) {
      html += '<span class="fb-star fb-star-half">★</span>';
    } else if (i === full + 1 && frac >= 0.75) {
      html += '<span class="fb-star fb-star-filled">★</span>';
    } else {
      html += '<span class="fb-star">★</span>';
    }
  }
  return html;
}

/**
 * 渲染可交互星级
 */
function renderInteractiveStars() {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += `<span class="fb-star fb-star-input" data-v="${i}">★</span>`;
  }
  return html;
}

// ---------------------------------------------------------------------------
// 弹窗 DOM 构建
// ---------------------------------------------------------------------------

function buildModalHtml({ topicId, topicLabel, feedbackType }) {
  const title = feedbackType === 'chapter' ? '章节反馈' : '小节反馈';
  const label = topicLabel && topicLabel !== topicId ? topicLabel : '';

  return `
  <div id="sectionFeedbackModal" class="modal feedback-modal" style="display: block;">
    <div class="modal-content feedback-content">
      <!-- 头部 -->
      <div class="feedback-header">
        <div class="feedback-header-left">
          <iconify-icon icon="mdi:star-box-multiple-outline" width="26" height="26"></iconify-icon>
          <h2>${title}</h2>
        </div>
        <div class="feedback-topic-label">${topicId}${label ? ' · ' + label : ''}</div>
        <button type="button" class="feedback-close" id="fb-close" title="关闭（跳过）">&times;</button>
      </div>

      <!-- 过程线（仅展示给用户的步骤；评分对比与文本修改在后台完成） -->
      <div class="feedback-stepper">
        <div class="fb-step is-active" data-step="1"><span class="fb-step-num">1</span><span class="fb-step-name">自我评价</span></div>
        <div class="fb-step-line"></div>
        <div class="fb-step" data-step="2"><span class="fb-step-num">2</span><span class="fb-step-name">系统评价</span></div>
      </div>

      <!-- 步骤内容 -->
      <div class="feedback-body">

        <!-- 步骤1：用户自我评价（系统评价此时已在后台生成，暂不展示） -->
        <div class="fb-panel is-active" data-panel="1">
          <div class="fb-panel-title"><iconify-icon icon="mdi:star-face" width="18" height="18"></iconify-icon> 先来做个自我评价</div>
          <p class="fb-hint">在查看系统评价之前，先凭感觉给自己打个分吧～</p>
          <div class="fb-stars-input-wrap" id="fb-self-stars">${renderInteractiveStars()}</div>
          <div class="fb-self-label" id="fb-self-label">${STAR_LABELS[0]}</div>
        </div>

        <!-- 步骤2：展示系统评价（后台已完成评分对比与文本修改） -->
        <div class="fb-panel" data-panel="2">
          <div class="fb-panel-title"><iconify-icon icon="mdi:check-decagram-outline" width="18" height="18"></iconify-icon> 系统评价</div>
          <div class="fb-final-box">
            <div class="fb-final-score" id="fb-final-score"></div>
            <div class="fb-compare-row">
              <div class="fb-compare-item">
                <span class="fb-compare-name">系统评分</span>
                <span class="fb-compare-score" id="fb-cmp-system">-</span>
              </div>
              <div class="fb-compare-badge" id="fb-cmp-badge">=</div>
              <div class="fb-compare-item">
                <span class="fb-compare-name">我的评分</span>
                <span class="fb-compare-score" id="fb-cmp-self">-</span>
              </div>
            </div>
            <div class="fb-compare-text" id="fb-cmp-text"></div>
            <div class="fb-final-block">
              <div class="fb-box-title"><iconify-icon icon="mdi:alert-circle-outline" width="16" height="16"></iconify-icon> 错误总结</div>
              <div class="fb-box-content" id="fb-final-neg"></div>
            </div>
            <div class="fb-final-block">
              <div class="fb-box-title"><iconify-icon icon="mdi:hand-wave-outline" width="16" height="16"></iconify-icon> 激励文本</div>
              <div class="fb-box-content" id="fb-final-pos"></div>
            </div>
          </div>
          <div class="fb-thanks">把系统评价当作一面镜子，经常和自己的判断对比，你会越来越了解自己的掌握情况，继续加油！</div>
        </div>

      </div>

      <!-- 底部操作 -->
      <div class="feedback-actions">
        <button type="button" class="fb-btn fb-btn-ghost" id="fb-skip">跳过</button>
        <button type="button" class="fb-btn fb-btn-ghost" id="fb-prev" style="display: none;">上一步</button>
        <button type="button" class="fb-btn fb-btn-primary" id="fb-next">下一步</button>
      </div>
    </div>
  </div>`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 显示小节/章节反馈弹窗
 * @param {Object} options
 * @param {string} options.topicId 测试主题ID，如 '1_1' / '1_end'
 * @param {string} options.topicLabel 主题名称
 * @param {string} options.feedbackType 'section' | 'chapter'
 * @param {Object} options.submissionMsg 最终提交结果消息
 * @param {number} options.failedSubmissionCount 通过前失败次数
 * @param {Array} options.accumulatedFailures 历史失败详情
 * @param {Object} options.lastFailedCode 最近一次失败时的代码快照 {html, css, js}
 * @param {Object} options.task 当前测试任务数据（含 checkpoints）
 * @returns {Promise<{submitted: boolean, skipped: boolean, data?: Object}>}
 */
export function showSectionFeedback(options) {
  // 若已有弹窗，先关闭
  closeModal();

  const systemEval = generateSystemEvaluation(options);

  const modalHtml = buildModalHtml({
    topicId: options.topicId,
    topicLabel: options.topicLabel,
    feedbackType: options.feedbackType,
  });
  document.body.insertAdjacentHTML('beforeend', modalHtml);

  return new Promise((resolve) => {
    currentResolver = resolve;
    let currentStep = 1;
    let selfScore = 0;
    // 后台完成对比与文本修改后的最终评价
    let final = null;

    const modal = document.getElementById('sectionFeedbackModal');
    const prevBtn = document.getElementById('fb-prev');
    const nextBtn = document.getElementById('fb-next');
    const skipBtn = document.getElementById('fb-skip');
    const closeBtn = document.getElementById('fb-close');

    const panels = modal.querySelectorAll('.fb-panel');
    const steps = modal.querySelectorAll('.fb-step');

    // ---------- 步骤切换 ----------
    function goToStep(step) {
      currentStep = step;

      panels.forEach((p) => p.classList.remove('is-active'));
      steps.forEach((s) => s.classList.remove('is-active', 'is-done'));

      modal.querySelector(`.fb-panel[data-panel="${step}"]`).classList.add('is-active');
      for (let i = 1; i <= 2; i++) {
        const stepEl = modal.querySelector(`.fb-step[data-step="${i}"]`);
        if (i < step) stepEl.classList.add('is-done');
        if (i === step) stepEl.classList.add('is-active');
      }

      prevBtn.style.display = step === 1 ? 'none' : 'inline-block';
      skipBtn.style.display = step === 2 ? 'none' : 'inline-block';

      if (step === 2) {
        renderFinal();
        nextBtn.innerHTML = '完成';
      } else {
        nextBtn.innerHTML = '下一步';
      }
    }

    // ---------- 步骤2 渲染最终展示（后台对比 + 文本修改，基于当前自评分实时计算） ----------
    function renderFinal() {
      // 每次进入步骤2都基于最新的自评分重新计算，避免"上一步改分后返回"时展示旧结果
      final = finalizeEvaluation(systemEval, selfScore);

      document.getElementById('fb-final-score').innerHTML =
        `系统 <span class="fb-final-strong">${systemEval.systemScore.toFixed(1)}</span> ★` +
        `&nbsp;&nbsp;vs&nbsp;&nbsp;我的 <span class="fb-final-strong">${selfScore}</span> ★`;

      document.getElementById('fb-cmp-system').textContent = systemEval.systemScore.toFixed(1);
      document.getElementById('fb-cmp-self').textContent = selfScore;

      const cmpBadge = document.getElementById('fb-cmp-badge');
      cmpBadge.textContent = final.symbol;
      cmpBadge.className =
        'fb-compare-badge fb-compare-' +
        (final.diff > 0 ? 'up' : final.diff < 0 ? 'down' : 'eq');
      // 播放一次对比动画
      cmpBadge.classList.remove('fb-badge-pop');
      void cmpBadge.offsetWidth;
      cmpBadge.classList.add('fb-badge-pop');

      document.getElementById('fb-cmp-text').textContent = final.comparisonText;
      document.getElementById('fb-final-neg').innerHTML = escapeHtml(final.negativeText);
      document.getElementById('fb-final-pos').innerHTML = escapeHtml(final.positiveText);
    }

    // ---------- 提交 ----------
    async function submitFeedback() {
      const payload = {
        topic_id: options.topicId,
        feedback_type: options.feedbackType,
        system_score: systemEval.systemScore,
        self_score: selfScore || null,
        comparison: final ? final.symbol : (selfScore ? (selfScore > systemEval.systemScore ? '>' : selfScore < systemEval.systemScore ? '<' : '=') : null),
        negative_text: final ? final.negativeText : systemEval.negativeText,
        positive_text: final ? final.positiveText : systemEval.positiveText,
      };

      nextBtn.disabled = true;
      nextBtn.innerHTML = '请稍候...';

      try {
        if (window.apiClient && window.apiClient.post) {
          await window.apiClient.post('/feedback', payload);
        }
        // 无论接口成功与否，都视为已提交反馈，继续流程
        finish({ submitted: true, skipped: false, data: payload });
      } catch (err) {
        console.error('[SectionFeedback] 提交反馈失败:', err);
        // 接口失败也继续流程（避免阻塞学习），并记录到控制台
        finish({ submitted: true, skipped: false, data: payload, submitError: err });
      }
    }

    // ---------- 结束 ----------
    function finish(result) {
      closeModal();
      if (currentResolver) {
        const resolver = currentResolver;
        currentResolver = null;
        resolver(result);
      }
    }

    // ---------- 事件绑定 ----------

    // 关闭 / 跳过
    function skip() {
      finish({ submitted: false, skipped: true });
    }
    closeBtn.addEventListener('click', skip);
    skipBtn.addEventListener('click', skip);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) skip();
    });

    // 上一步 / 下一步
    prevBtn.addEventListener('click', () => {
      if (currentStep > 1) goToStep(currentStep - 1);
    });

    nextBtn.addEventListener('click', () => {
      if (currentStep === 2) {
        submitFeedback();
        return;
      }
      // 步骤1需要先打分
      if (currentStep === 1 && selfScore === 0) {
        const wrap = document.getElementById('fb-self-stars');
        wrap.classList.remove('fb-shake');
        void wrap.offsetWidth;
        wrap.classList.add('fb-shake');
        document.getElementById('fb-self-label').textContent = '请先为你的表现打分哦～';
        return;
      }
      goToStep(currentStep + 1);
    });

    // 自我评价星星
    const starsWrap = document.getElementById('fb-self-stars');
    const starEls = starsWrap.querySelectorAll('.fb-star-input');

    starEls.forEach((star) => {
      star.addEventListener('mouseenter', () => {
        const v = parseInt(star.dataset.v, 10);
        starEls.forEach((s) => {
          const sv = parseInt(s.dataset.v, 10);
          s.classList.toggle('fb-star-hover', sv <= v);
        });
        document.getElementById('fb-self-label').textContent = STAR_LABELS[v];
      });

      star.addEventListener('click', () => {
        const v = parseInt(star.dataset.v, 10);
        selfScore = v;
        starEls.forEach((s) => {
          const sv = parseInt(s.dataset.v, 10);
          s.classList.toggle('fb-star-selected', sv <= v);
          s.classList.remove('fb-star-pop');
          if (sv === v) {
            // 点击的星星播放弹跳动画
            s.classList.add('fb-star-pop');
          }
        });
        document.getElementById('fb-self-label').textContent = STAR_LABELS[v];
      });
    });

    starsWrap.addEventListener('mouseleave', () => {
      starEls.forEach((s) => s.classList.remove('fb-star-hover'));
      document.getElementById('fb-self-label').textContent =
        selfScore ? STAR_LABELS[selfScore] : STAR_LABELS[0];
    });

    goToStep(1);
  });
}

/**
 * 关闭反馈弹窗
 */
export function closeModal() {
  const existing = document.getElementById('sectionFeedbackModal');
  if (existing) {
    existing.remove();
  }
}

export default { showSectionFeedback, closeModal };
