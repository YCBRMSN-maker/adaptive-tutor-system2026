/**
 * OJ 页面共用的 AI 助教传输层。
 *
 * 主站 chat.js 默认走 /chat/ai/chat2（Celery + WebSocket 流式），
 * 但本环境里聚类模型加载不出来，任务会卡住。这里保留 chat.js 的全部 UI、
 * Markdown 渲染和历史回放，只把发送动作接到主站同步接口 /chat/ai/chat。
 *
 * 练习页和学习页都引用本模块，避免各自写一份重复实现。
 */

/**
 * @param {object} chatModule chat.js 的单例
 * @param {object} opts
 * @param {string} [opts.mode] 传给主站的 mode（test / learning）
 * @param {(message: string) => string} opts.buildPrompt 把题目/章节上下文拼进消息
 * @param {() => string} opts.getTopicId 主站 content_id
 * @param {() => string} opts.getParticipantId
 * @param {(message: string) => void} [opts.onSend] 发送时的计数与行为上报
 * @param {() => void} [opts.onDone] 一轮结束后的回调（如卡住检测）
 */
export function installOjChatTransport(chatModule, opts) {
  const {
    mode = 'test',
    buildPrompt,
    getTopicId,
    getParticipantId,
    onSend,
    onDone,
  } = opts;

  chatModule.sendMessage = async function (activeMode, activeContentId) {
    const input = this.inputElement;
    const message = input ? input.value.trim() : '';
    if (!message || this.isLoading) return;

    input.value = '';
    if (onSend) onSend(message);
    this.isLoading = true;
    if (this.sendButton) this.sendButton.disabled = true;

    this.addMessageToUI('user', message, {
      mode: activeMode || mode,
      contentId: activeContentId,
    });
    // addMessageToUI 对 ai 消息返回的就是 .markdown-content 元素
    const md = this.addMessageToUI('ai', '', {
      mode: activeMode || mode,
      contentId: activeContentId,
    });

    const payload = {
      participant_id: getParticipantId(),
      user_message: buildPrompt(message),
      mode: activeMode || mode,
      content_id: getTopicId(),
      // 主站 prompt 只要 code_context 非空就按 HTML/CSS/JS 教学，这里留空
      code_context: { html: '', css: '', js: '' },
      conversation_history: this.getConversationHistory(),
    };

    try {
      // 主站偶发返回空回复，自动重试一次
      let reply = '';
      for (let attempt = 0; attempt < 2 && !reply; attempt += 1) {
        const res = await fetch('/api/v1/chat/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const r = await res.json();
        reply = (r && r.data && r.data.ai_response) || '';
        if (!reply && attempt === 0) {
          await new Promise((done) => setTimeout(done, 1200));
        }
      }

      if (md) {
        if (reply) this.appendMessageContent(md, reply);
        else md.textContent = '这次没能生成回复，稍等一下再问一次。';
      }
    } catch (err) {
      if (md) md.textContent = `连接 AI 助教失败：${err.message}`;
    } finally {
      this.isLoading = false;
      if (this.sendButton) this.sendButton.disabled = false;
      if (onDone) onDone();
    }
  };
}

/** 清掉 chat.js 回放的主站历史，只留 OJ 自己的欢迎语 */
export function clearChatHistory(chatModule, welcome) {
  const box = document.getElementById('ai-chat-messages');
  if (!box) return;
  box.innerHTML = '';
  chatModule.addMessageToUI('ai', welcome, { persist: false });
}

/** 主动往聊天框插一条 AI 提示（卡住检测 / idle 用） */
export function pushAiHint(chatModule, text) {
  if (!chatModule || !chatModule.messagesContainer) return;
  chatModule.addMessageToUI('ai', text, { persist: false });
}
