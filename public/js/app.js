/**
 * AI 视觉对话助手 — 主应用控制器 v2.0
 *
 * 新增：
 *  - 防并发机制（处理中禁用所有触发入口）
 *  - TTS 手动切换（默认关闭）
 *  - 运动状态修复（摄像头关闭时隐藏指示器）
 *  - 多对话管理（localStorage 持久化）
 *  - 连续拍照防失效（取消进行中的请求）
 *  - 移动端对话抽屉
 */

import { loadConfig, saveConfig, loadConversations, saveConversations, LIMITS } from './config.js';
import { CameraManager } from './camera.js';
import { SpeechManager } from './speech.js';
import { AIService } from './ai.js';

class AppController {
  constructor() {
    // 加载配置
    this.config = loadConfig();

    // 初始化模块
    this.camera = new CameraManager(this.config);
    this.speech = new SpeechManager(this.config);
    this.ai = new AIService(this.config);

    // 应用状态
    this.cameraActive = false;
    this.micActive = false;
    this.isProcessing = false;    // 是否正在等待 AI 回复
    this.pendingSnapshot = false; // 是否需要在下一次发送时附加快照
    this.totalCost = 0;

    // 对话管理
    this.convData = loadConversations();
    this.activeConvId = this.convData.activeId;

    // TTS 状态
    this.ttsEnabled = this.config.autoSpeak || false;

    // DOM 引用（在 init() 中填充）
    this.elements = {};

    // 绑定方法
    this._onFrame = this._onFrame.bind(this);
    this._onMotionState = this._onMotionState.bind(this);
    this._onSpeechFinal = this._onSpeechFinal.bind(this);
    this._onSpeechInterim = this._onSpeechInterim.bind(this);
    this._onSpeechEnd = this._onSpeechEnd.bind(this);
  }

  // -----------------------------------------------------------------------
  // 初始化
  // -----------------------------------------------------------------------

  init() {
    this._cacheElements();
    this._bindEvents();

    // 初始化摄像头模块
    this.camera.init(
      this.elements.cameraVideo,
      this.elements.captureCanvas
    );

    // 加载可用语音音色
    this._loadVoices();

    // 恢复 UI 状态
    this._restoreSettings();
    this._updateTTSButton();

    // 恢复对话列表
    this._renderConvList();
    this._restoreActiveConversation();

    console.log('🚀 Vision Buddy v2.0 初始化完成');
    console.log('📋 配置:', this.config);
    console.log('💬 对话数据:', this.convData);
  }

  // -----------------------------------------------------------------------
  // 对话管理
  // -----------------------------------------------------------------------

  /**
   * 生成唯一对话 ID
   */
  _generateId() {
    return 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * 获取当前活跃的对话对象
   */
  _getActiveConv() {
    if (!this.activeConvId) return null;
    return this.convData.conversations.find(c => c.id === this.activeConvId) || null;
  }

  /**
   * 创建新对话
   */
  _createConversation() {
    // 对话数量限制
    if (this.convData.conversations.length >= LIMITS.MAX_CONVERSATIONS) {
      this._showToast(`最多保留 ${LIMITS.MAX_CONVERSATIONS} 个对话，请先删除旧的`, 'warning');
      return;
    }

    const conv = {
      id: this._generateId(),
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    this.convData.conversations.unshift(conv);
    this.activeConvId = conv.id;
    this.convData.activeId = conv.id;
    this._safeSaveConversations();

    // 同步 AI 服务的历史
    this.ai.clearHistory();
    this._renderChatMessages([]);
    this._renderConvList();
    this._updateConvTitle();
    this._showToast('新建对话', 'info');
  }

  /**
   * 切换对话
   */
  _switchConversation(convId) {
    if (convId === this.activeConvId) return;

    // 取消当前请求
    if (this.isProcessing) {
      this.ai.cancel();
      this.isProcessing = false;
      this._updateProcessingUI(false);
    }

    this.activeConvId = convId;
    this.convData.activeId = convId;
    this._safeSaveConversations();

    // 恢复对话历史到 AI 服务
    const conv = this._getActiveConv();
    this.ai.clearHistory();
    if (conv) {
      // 只恢复最近的文本消息到 AI 服务
      const recentMessages = conv.messages.slice(-this.config.maxHistory * 2);
      for (const msg of recentMessages) {
        this.ai.messageHistory.push({ role: msg.role, content: msg.content });
      }
    }

    this._renderChatMessages(conv ? conv.messages : []);
    this._renderConvList();
    this._updateConvTitle();
  }

  /**
   * 删除对话
   */
  _deleteConversation(convId, e) {
    e.stopPropagation();

    if (this.convData.conversations.length <= 1) {
      this._showToast('至少保留一个对话', 'warning');
      return;
    }

    this.convData.conversations = this.convData.conversations.filter(c => c.id !== convId);

    // 如果删除的是当前对话，切换到第一个
    if (convId === this.activeConvId) {
      this.activeConvId = this.convData.conversations[0]?.id || null;
      this.convData.activeId = this.activeConvId;
      const conv = this._getActiveConv();
      this.ai.clearHistory();
      if (conv) {
        for (const msg of conv.messages) {
          this.ai.messageHistory.push({ role: msg.role, content: msg.content });
        }
      }
      this._renderChatMessages(conv ? conv.messages : []);
      this._updateConvTitle();
    }

    this._safeSaveConversations();
    this._renderConvList();
    this._showToast('对话已删除', 'info');
  }

  /**
   * 渲染对话列表（侧栏 + 移动端抽屉）
   */
  _renderConvList() {
    const convs = this.convData.conversations;

    const renderItem = (conv) => {
      const time = new Date(conv.updatedAt).toLocaleDateString('zh-CN', {
        month: 'numeric', day: 'numeric',
      });
      const isActive = conv.id === this.activeConvId;
      return `
        <div class="conv-item ${isActive ? 'active' : ''}"
             data-conv-id="${conv.id}"
             title="${this._escapeHtml(conv.title)}">
          <div class="conv-item-icon">${isActive ? '💬' : '📝'}</div>
          <div class="conv-item-info">
            <div class="conv-item-title">${this._escapeHtml(conv.title)}</div>
            <div class="conv-item-time">${time}</div>
          </div>
          <button class="conv-item-delete" data-delete="${conv.id}" title="删除">×</button>
        </div>`;
    };

    // 桌面侧栏
    const listEl = this.elements.convList;
    if (listEl) {
      listEl.innerHTML = convs.length === 0
        ? '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:var(--text-xs);">暂无对话</div>'
        : convs.map(renderItem).join('');

      // 绑定点击事件
      listEl.querySelectorAll('.conv-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.dataset.convId;
          if (id) this._switchConversation(id);
        });
      });
      listEl.querySelectorAll('.conv-item-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = btn.dataset.delete;
          if (id) this._deleteConversation(id, e);
        });
      });
    }

    // 移动端抽屉
    const drawerList = this.elements.convDrawerList;
    if (drawerList) {
      drawerList.innerHTML = convs.map(renderItem).join('');
      drawerList.querySelectorAll('.conv-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.dataset.convId;
          if (id) {
            this._switchConversation(id);
            this._closeDrawer();
          }
        });
      });
      drawerList.querySelectorAll('.conv-item-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = btn.dataset.delete;
          if (id) this._deleteConversation(id, e);
        });
      });
    }
  }

  /**
   * 恢复上次活跃的对话
   */
  _restoreActiveConversation() {
    // 没有对话则创建默认对话
    if (this.convData.conversations.length === 0) {
      this._createConversation();
      return;
    }

    // 恢复活跃对话
    if (this.activeConvId) {
      const conv = this._getActiveConv();
      if (conv) {
        this.ai.clearHistory();
        const recent = conv.messages.slice(-this.config.maxHistory * 2);
        for (const msg of recent) {
          this.ai.messageHistory.push({ role: msg.role, content: msg.content });
        }
        this._renderChatMessages(conv.messages);
        this._updateConvTitle();
        return;
      }
    }

    // 活跃对话丢失，使用第一个
    this.activeConvId = this.convData.conversations[0].id;
    this.convData.activeId = this.activeConvId;
    this._safeSaveConversations();
    const conv = this._getActiveConv();
    if (conv) {
      for (const msg of conv.messages) {
        this.ai.messageHistory.push({ role: msg.role, content: msg.content });
      }
      this._renderChatMessages(conv.messages);
      this._updateConvTitle();
    }
  }

  /**
   * 更新对话标题
   */
  _updateConvTitle() {
    const conv = this._getActiveConv();
    const title = conv ? conv.title : '对话';
    if (this.elements.convTitle) {
      this.elements.convTitle.textContent = title;
    }
  }

  /**
   * 根据对话内容自动生成标题
   */
  _autoTitle() {
    const conv = this._getActiveConv();
    if (!conv || conv.title !== '新对话') return;

    // 取第一条用户消息作为标题
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (firstUserMsg) {
      const text = typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : '';
      conv.title = text.slice(0, LIMITS.MAX_CONV_TITLE_LENGTH)
        + (text.length > LIMITS.MAX_CONV_TITLE_LENGTH ? '...' : '');
      conv.updatedAt = Date.now();
      this._safeSaveConversations();
      this._renderConvList();
      this._updateConvTitle();
    }
  }

  /**
   * 安全保存对话（处理 localStorage 配额溢出）
   */
  _safeSaveConversations() {
    try {
      saveConversations(this.convData);
    } catch (e) {
      console.warn('localStorage 存储失败，尝试清理旧数据', e);
      // 保留最近 10 个对话，删除其余
      if (this.convData.conversations.length > 10) {
        this.convData.conversations = this.convData.conversations
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 10);
      }
      // 对每个对话只保留最近 100 条消息
      for (const conv of this.convData.conversations) {
        if (conv.messages.length > 100) {
          conv.messages = conv.messages.slice(-100);
        }
      }
      try {
        saveConversations(this.convData);
      } catch (e2) {
        this._showToast('存储空间不足，请删除一些旧对话', 'warning');
      }
    }
  }

  /**
   * 保存消息到当前对话
   */
  _saveMessageToConv(role, content) {
    const conv = this._getActiveConv();
    if (!conv) return;

    // 消息数量限制
    if (conv.messages.length >= LIMITS.MAX_MESSAGES_PER_CONV) {
      conv.messages = conv.messages.slice(-LIMITS.MAX_MESSAGES_PER_CONV + 1);
    }

    // 截断过长消息内容
    const safeContent = typeof content === 'string' && content.length > LIMITS.MAX_MESSAGE_LENGTH
      ? content.slice(0, LIMITS.MAX_MESSAGE_LENGTH)
      : content;

    conv.messages.push({ role, content: safeContent });
    conv.updatedAt = Date.now();
    this._safeSaveConversations();

    // 自动生成标题
    if (conv.title === '新对话' && role === 'user') {
      this._autoTitle();
    }
  }

  /**
   * 渲染对话消息到界面
   */
  _renderChatMessages(messages) {
    const messagesEl = this.elements.chatMessages;
    messagesEl.innerHTML = '';

    if (messages.length === 0) {
      messagesEl.innerHTML = `
        <div class="welcome-message">
          <div class="welcome-icon">🤖</div>
          <h3>欢迎使用 Vision Buddy</h3>
          <p>开启摄像头和麦克风后，AI 就能看到你、听到你。</p>
          <p>试试直接说话，或者把物品展示给摄像头看！</p>
        </div>`;
      return;
    }

    messages.forEach(msg => {
      const msgDiv = document.createElement('div');
      msgDiv.className = `message ${msg.role}`;
      const avatar = msg.role === 'user' ? '👤' : '🤖';
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      msgDiv.innerHTML = `
        <div class="message-avatar">${avatar}</div>
        <div>
          <div class="message-bubble">${this._escapeHtml(msg.content)}</div>
          <div class="message-time">${time}</div>
        </div>`;
      messagesEl.appendChild(msgDiv);
    });

    this._scrollToBottom();
  }

  // -----------------------------------------------------------------------
  // 摄像头控制
  // -----------------------------------------------------------------------

  async toggleCamera() {
    if (this.cameraActive) {
      this._disableCamera();
    } else {
      await this._enableCamera();
    }
  }

  async _enableCamera() {
    try {
      const btn = this.elements.btnCamera;
      btn.disabled = true;
      btn.querySelector('.btn-text').textContent = '正在开启...';

      await this.camera.start();

      this.cameraActive = true;
      this._updateCameraUI(true);

      // 自动开始帧捕获
      this.camera.startCapture(this._onFrame, this._onMotionState);

      // 立即捕获第一帧
      setTimeout(() => {
        const initialFrame = this.camera.captureSnapshot();
        if (initialFrame) this._lastFrame = initialFrame;
      }, 500);

      // 启用相关按钮
      this.elements.btnMic.disabled = false;
      this.elements.btnSnapshot.disabled = false;

      this._showToast('摄像头已开启', 'success');
    } catch (error) {
      this._showToast(error.message, 'error');
      this._updateCameraUI(false);
    }
  }

  _disableCamera() {
    this.camera.stop();
    this.cameraActive = false;

    // 如果麦克风开着，先关掉
    if (this.micActive) {
      this._disableMic();
    }

    this._updateCameraUI(false);
    this.elements.btnMic.disabled = true;
    this.elements.btnSnapshot.disabled = true;

    // 重置运动状态指示器（修复"关闭摄像头仍显示运动中"的 bug）
    this._onMotionState(false);
    // 隐藏运动指示器
    const motionIndicator = document.getElementById('motionIndicator');
    if (motionIndicator) motionIndicator.classList.add('hidden');

    this._showToast('摄像头已关闭', 'info');
  }

  _updateCameraUI(active) {
    const btn = this.elements.btnCamera;
    const video = this.elements.cameraVideo;
    const placeholder = this.elements.cameraPlaceholder;
    const container = document.querySelector('.video-container');
    const motionIndicator = document.getElementById('motionIndicator');

    if (active) {
      btn.classList.add('active');
      btn.querySelector('.btn-text').textContent = '关闭摄像头';
      btn.querySelector('.btn-icon').textContent = '🔴';
      video.classList.add('active');
      placeholder.classList.add('hidden');
      container.classList.add('active');
      this.elements.statusCamera.textContent = '已连接';
      this.elements.statusCamera.className = 'status-badge badge-on';
      if (motionIndicator) motionIndicator.classList.remove('hidden');
    } else {
      btn.classList.remove('active');
      btn.querySelector('.btn-text').textContent = '开启摄像头';
      btn.querySelector('.btn-icon').textContent = '🎥';
      video.classList.remove('active');
      placeholder.classList.remove('hidden');
      container.classList.remove('active');
      this.elements.statusCamera.textContent = '未连接';
      this.elements.statusCamera.className = 'status-badge badge-off';
    }

    btn.disabled = false;
  }

  // -----------------------------------------------------------------------
  // 麦克风控制
  // -----------------------------------------------------------------------

  async toggleMic() {
    if (this.micActive) {
      this._disableMic();
    } else {
      await this._enableMic();
    }
  }

  async _enableMic() {
    try {
      this.speech.onFinalResult = this._onSpeechFinal;
      this.speech.onInterimResult = this._onSpeechInterim;
      this.speech.onSpeechEnd = this._onSpeechEnd;

      await this.speech.startListening();

      this.micActive = true;
      this._updateMicUI(true);
      this._showToast('麦克风已开启，请说话...', 'success');
    } catch (error) {
      this._showToast(error.message, 'error');
      this._updateMicUI(false);
    }
  }

  _disableMic() {
    this.speech.stopListening();
    this.micActive = false;
    this._updateMicUI(false);

    // 隐藏中间识别文本
    this.elements.interimText.style.display = 'none';
  }

  _updateMicUI(active) {
    const btn = this.elements.btnMic;

    if (active) {
      btn.classList.add('active');
      btn.querySelector('.btn-text').textContent = '关闭麦克风';
      btn.querySelector('.btn-icon').textContent = '🔴';
      this.elements.statusMic.textContent = '监听中';
      this.elements.statusMic.className = 'status-badge badge-on';
    } else {
      btn.classList.remove('active');
      btn.querySelector('.btn-text').textContent = '开启麦克风';
      btn.querySelector('.btn-icon').textContent = '🎤';
      this.elements.statusMic.textContent = '未连接';
      this.elements.statusMic.className = 'status-badge badge-off';
    }
  }

  // -----------------------------------------------------------------------
  // 快照分析（防并发）
  // -----------------------------------------------------------------------

  async takeSnapshot() {
    // 防并发：处理中不允许触发
    if (this.isProcessing) {
      this._showToast('AI 正在回复中，请稍后...', 'warning');
      return;
    }

    if (!this.cameraActive) {
      this._showToast('请先开启摄像头', 'warning');
      return;
    }

    const frame = this.camera.captureSnapshot();
    if (!frame) {
      this._showToast('无法捕获画面', 'error');
      return;
    }

    const snapshotPrompt = '（用户手动拍了一张快照，看看画面里有什么有趣的？）';

    this.isProcessing = true;
    this._updateProcessingUI(true);
    this._addUserMessage(snapshotPrompt);
    this._saveMessageToConv('user', snapshotPrompt);

    await this.ai.sendMessage(snapshotPrompt, [frame], {
      onText: (delta) => this._appendToLastAssistantMessage(delta),
      onDone: (fullText, usage) => {
        this._onAIResponseComplete(fullText, usage);
      },
      onError: (error) => {
        this._onAIError(error);
      },
    });
  }

  // -----------------------------------------------------------------------
  // 文本输入（防并发）
  // -----------------------------------------------------------------------

  async sendTextMessage() {
    // 防并发：处理中不允许发送
    if (this.isProcessing) {
      this._showToast('AI 正在回复中，请稍后...', 'warning');
      return;
    }

    const input = this.elements.textInput;
    let text = input.value.trim();
    if (!text) return;

    // 长度校验
    if (text.length > LIMITS.MAX_INPUT_LENGTH) {
      this._showToast(`消息过长，最多 ${LIMITS.MAX_INPUT_LENGTH} 个字符`, 'warning');
      text = text.slice(0, LIMITS.MAX_INPUT_LENGTH);
      input.value = text;
      return;
    }

    input.value = '';

    // 如果摄像头开着，附上一帧当前画面
    let images = [];
    if (this.cameraActive) {
      const frame = this.camera.captureSnapshot();
      if (frame) images.push(frame);
    }

    // 图像数量校验
    if (images.length > LIMITS.MAX_IMAGES_PER_REQUEST) {
      images = images.slice(0, LIMITS.MAX_IMAGES_PER_REQUEST);
    }

    this.isProcessing = true;
    this._updateProcessingUI(true);
    this._addUserMessage(text);
    this._saveMessageToConv('user', text);

    await this.ai.sendMessage(text, images, {
      onText: (delta) => this._appendToLastAssistantMessage(delta),
      onDone: (fullText, usage) => {
        this._onAIResponseComplete(fullText, usage);
      },
      onError: (error) => {
        this._onAIError(error);
      },
    });
  }

  // -----------------------------------------------------------------------
  // 帧回调（来自 CameraManager）
  // -----------------------------------------------------------------------

  _onFrame(base64Image) {
    // 自动帧只做缓存，不主动发送（避免无语音时消耗 API 费用）
    this._lastFrame = base64Image;
  }

  /**
   * 运动状态变化（修复：仅摄像头开启时更新 UI）
   */
  _onMotionState(isMoving) {
    // 关键修复：摄像头关闭时不更新运动状态
    if (!this.cameraActive) return;

    const dot = document.querySelector('.motion-dot');
    const label = document.querySelector('.motion-label');

    if (isMoving) {
      if (dot) dot.classList.add('active');
      if (label) label.textContent = '运动中';
    } else {
      if (dot) dot.classList.remove('active');
      if (label) label.textContent = '静止';
    }
  }

  // -----------------------------------------------------------------------
  // 语音回调（来自 SpeechManager）
  // -----------------------------------------------------------------------

  _onSpeechFinal(text) {
    console.log('🎤 识别:', text);
    this.elements.interimText.style.display = 'none';

    // 防并发：AI 正在回复中，忽略用户语音
    if (this.isProcessing) {
      this._showToast('AI 正在回复中，请稍后再说...', 'warning');
      return;
    }

    // 语音识别结果校验
    if (!text || !text.trim()) return;
    text = text.trim();

    // 截断过长语音识别结果
    if (text.length > LIMITS.MAX_INPUT_LENGTH) {
      text = text.slice(0, LIMITS.MAX_INPUT_LENGTH);
    }

    // 实时捕获当前帧
    let images = [];
    if (this.cameraActive) {
      const frame = this.camera.captureSnapshot();
      if (frame) images.push(frame);
    }

    if (images.length > LIMITS.MAX_IMAGES_PER_REQUEST) {
      images = images.slice(0, LIMITS.MAX_IMAGES_PER_REQUEST);
    }

    this.isProcessing = true;
    this._updateProcessingUI(true);
    this._addUserMessage(text);
    this._saveMessageToConv('user', text);

    this.ai.sendMessage(text, images, {
      onText: (delta) => this._appendToLastAssistantMessage(delta),
      onDone: (fullText, usage) => {
        this._onAIResponseComplete(fullText, usage);
      },
      onError: (error) => {
        this._onAIError(error);
      },
    });
  }

  _onSpeechInterim(text) {
    this.elements.interimText.style.display = 'flex';
    this.elements.interimContent.textContent = text;
  }

  _onSpeechEnd() {
    // TTS 播报结束
  }

  // -----------------------------------------------------------------------
  // AI 响应处理
  // -----------------------------------------------------------------------

  _onAIResponseComplete(fullText, usage) {
    this.isProcessing = false;
    this._updateProcessingUI(false);

    // 保存 AI 回复到当前对话
    if (fullText) {
      this._saveMessageToConv('assistant', fullText);
    }

    // 更新 token 统计
    if (usage) {
      this._updateTokenStats(usage);
    }

    // 根据回复内容更新 AI 头像表情
    if (fullText) {
      this._updateAssistantAvatar(fullText);
    }

    // TTS：根据用户选择决定是否朗读（默认关闭）
    if (this.ttsEnabled && fullText) {
      this.speech.speak(fullText);
    }

    // 更新对话列表（标题可能变了）
    this._renderConvList();
  }

  _onAIError(error) {
    this.isProcessing = false;
    this._updateProcessingUI(false);
    this._showToast(`AI 错误: ${error.message}`, 'error');
    console.error('AI 错误详情:', error);
  }

  // -----------------------------------------------------------------------
  // 防并发 UI：处理中时禁用所有输入
  // -----------------------------------------------------------------------

  _updateProcessingUI(processing) {
    // 快照按钮
    this.elements.btnSnapshot.disabled = processing || !this.cameraActive;

    // 发送按钮
    this.elements.btnSend.disabled = processing;

    // 文本输入
    this.elements.textInput.disabled = processing;
    if (processing) {
      this.elements.textInput.placeholder = 'AI 正在回复中...';
    } else {
      this.elements.textInput.placeholder = '输入消息，或直接对着麦克风说话...';
    }
  }

  // -----------------------------------------------------------------------
  // UI 更新
  // -----------------------------------------------------------------------

  _addUserMessage(text) {
    const messagesEl = this.elements.chatMessages;

    // 隐藏欢迎消息
    const welcome = messagesEl.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = 'message user';
    msgDiv.innerHTML = `
      <div class="message-avatar">👤</div>
      <div>
        <div class="message-bubble">${this._escapeHtml(text)}</div>
        <div class="message-time">${this._formatTime()}</div>
      </div>
    `;
    messagesEl.appendChild(msgDiv);

    // 创建 AI 回复占位
    const aiDiv = document.createElement('div');
    aiDiv.className = 'message assistant';
    aiDiv.id = 'ai-message-' + Date.now();
    aiDiv.innerHTML = `
      <div class="message-avatar">🤖</div>
      <div>
        <div class="message-bubble"><span class="typing-indicator">思考中...</span></div>
        <div class="message-time">${this._formatTime()}</div>
      </div>
    `;
    messagesEl.appendChild(aiDiv);

    this._scrollToBottom();
  }

  _appendToLastAssistantMessage(delta) {
    const messagesEl = this.elements.chatMessages;
    const lastAiMsg = messagesEl.querySelector('.message.assistant:last-of-type .message-bubble');

    if (lastAiMsg) {
      const typing = lastAiMsg.querySelector('.typing-indicator');
      if (typing) typing.remove();

      lastAiMsg.textContent += delta;
      this._scrollToBottom();
    }
  }

  _updateTokenStats(usage) {
    const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    this.elements.statusTokens.textContent = `${totalTokens.toLocaleString()} tokens`;

    const cost = this.ai.getEstimatedCost();
    this.elements.statusCost.textContent = `$${cost.toFixed(4)}`;
  }

  /**
   * 根据 AI 回复内容匹配对应表情
   */
  _pickAssistantEmoji(text) {
    const lower = text.toLowerCase();

    const rules = [
      { emoji: '👋', keywords: ['你好', 'hello', 'hi', '欢迎', '嗨', '再见', '拜拜', 'bye'] },
      { emoji: '👀', keywords: ['看到', '看见', '画面', '图片', '摄像头', '镜头', '观察', '图像', '照片'] },
      { emoji: '😮', keywords: ['惊讶', '哇', '哦', '天啊', '居然', '竟然', '没想到', '意外', '哇塞'] },
      { emoji: '😊', keywords: ['开心', '高兴', '棒', '太好了', '哈哈', '不错', '喜欢', '很棒', '真好', '微笑', 'hhh', 'hh'] },
      { emoji: '💡', keywords: ['建议', '试试', '推荐', '提醒', '注意', '提示', '小技巧', '可以'] },
      { emoji: '🤔', keywords: ['看起来', '好像', '可能', '不确定', '似乎', '也许', '大概', 'emmm'] },
      { emoji: '👍', keywords: ['是的', '没错', '对', '好的', '正确', '没问题', '当然', '厉害'] },
      { emoji: '🎉', keywords: ['恭喜', '庆祝', '成功', '完成', '优秀', '厉害', '牛逼'] },
      { emoji: '😅', keywords: ['抱歉', '对不起', '不清楚', '无法', '不能', '遗憾', '看不清'] },
      { emoji: '💛', keywords: ['理解', '关心', '小心', '注意安全', '保重', '在乎', '陪伴', '加油'] },
      { emoji: '🧠', keywords: ['分析', '推理', '逻辑', '深度', '思考'] },
      { emoji: '😏', keywords: ['偷偷', '哈哈', '摸鱼', '搞笑', '逗', '调皮'] },
    ];

    for (const rule of rules) {
      for (const kw of rule.keywords) {
        if (lower.includes(kw)) {
          return rule.emoji;
        }
      }
    }

    return '🤖';
  }

  _updateAssistantAvatar(fullText) {
    const messagesEl = this.elements.chatMessages;
    const lastAiMsg = messagesEl.querySelector('.message.assistant:last-of-type');
    if (!lastAiMsg) return;

    const avatar = lastAiMsg.querySelector('.message-avatar');
    if (!avatar) return;

    const emoji = this._pickAssistantEmoji(fullText);

    avatar.classList.add('emoji-switch');
    avatar.textContent = emoji;

    avatar.addEventListener('animationend', () => {
      avatar.classList.remove('emoji-switch');
    }, { once: true });
  }

  _scrollToBottom() {
    const messagesEl = this.elements.chatMessages;
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // -----------------------------------------------------------------------
  // TTS 切换
  // -----------------------------------------------------------------------

  toggleTTS() {
    this.ttsEnabled = !this.ttsEnabled;
    this.config.autoSpeak = this.ttsEnabled;
    saveConfig(this.config);
    this._updateTTSButton();

    if (this.ttsEnabled) {
      this._showToast('语音播报已开启 🔊', 'success');
    } else {
      this.speech.stopSpeaking();
      this._showToast('语音播报已关闭 🔇', 'info');
    }
  }

  _updateTTSButton() {
    const btn = this.elements.btnTTS;
    if (!btn) return;

    if (this.ttsEnabled) {
      btn.classList.add('active');
      btn.querySelector('span').textContent = '🔊';
      btn.title = '语音播报（开启）';
    } else {
      btn.classList.remove('active');
      btn.querySelector('span').textContent = '🔇';
      btn.title = '语音播报（关闭）';
    }
  }

  // -----------------------------------------------------------------------
  // 移动端抽屉
  // -----------------------------------------------------------------------

  _openDrawer() {
    this.elements.convOverlay.style.display = 'block';
    this.elements.convDrawer.style.display = 'flex';
    this._renderConvList();
  }

  _closeDrawer() {
    this.elements.convOverlay.style.display = 'none';
    this.elements.convDrawer.style.display = 'none';
  }

  // -----------------------------------------------------------------------
  // 侧栏折叠
  // -----------------------------------------------------------------------

  _toggleSidebar() {
    const sidebar = this.elements.conversationSidebar;
    const expandBtn = this.elements.btnExpandSidebar;

    if (sidebar) {
      sidebar.classList.toggle('collapsed');
      const isCollapsed = sidebar.classList.contains('collapsed');
      if (expandBtn) {
        expandBtn.style.display = isCollapsed ? 'flex' : 'none';
      }
      // 更新收起按钮文字
      const toggleBtn = this.elements.btnToggleSidebar;
      if (toggleBtn) {
        toggleBtn.innerHTML = isCollapsed ? '▶ 展开' : '◀ 收起';
      }
    }
  }

  _expandSidebar() {
    const sidebar = this.elements.conversationSidebar;
    const expandBtn = this.elements.btnExpandSidebar;
    if (sidebar) {
      sidebar.classList.remove('collapsed');
    }
    if (expandBtn) {
      expandBtn.style.display = 'none';
    }
    const toggleBtn = this.elements.btnToggleSidebar;
    if (toggleBtn) {
      toggleBtn.innerHTML = '◀ 收起';
    }
  }

  // -----------------------------------------------------------------------
  // 事件绑定
  // -----------------------------------------------------------------------

  _bindEvents() {
    // 按钮
    this.elements.btnCamera.addEventListener('click', () => this.toggleCamera());
    this.elements.btnMic.addEventListener('click', () => this.toggleMic());
    this.elements.btnSnapshot.addEventListener('click', () => this.takeSnapshot());
    this.elements.btnSend.addEventListener('click', () => this.sendTextMessage());
    this.elements.btnClearChat.addEventListener('click', () => this._clearChat());
    this.elements.btnTTS?.addEventListener('click', () => this.toggleTTS());

    // 对话管理
    this.elements.btnNewConv?.addEventListener('click', () => this._createConversation());
    this.elements.btnNewConvDrawer?.addEventListener('click', () => {
      this._createConversation();
      this._closeDrawer();
    });
    this.elements.btnToggleSidebar?.addEventListener('click', () => this._toggleSidebar());
    this.elements.btnExpandSidebar?.addEventListener('click', () => this._expandSidebar());

    // 移动端对话抽屉
    this.elements.btnMobileConvList?.addEventListener('click', () => this._openDrawer());
    this.elements.btnCloseDrawer?.addEventListener('click', () => this._closeDrawer());
    this.elements.convOverlay?.addEventListener('click', () => this._closeDrawer());

    // 文本输入
    this.elements.textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendTextMessage();
      }
    });

    // 模型选择
    this.elements.modelSelect.addEventListener('change', (e) => {
      this.config.model = e.target.value;
      this.ai.setModel(e.target.value);
      saveConfig(this.config);
    });

    // 帧率选择
    this.elements.fpsSelect.addEventListener('change', (e) => {
      const fps = parseInt(e.target.value);
      this.config.fps = fps;
      this.camera.updateConfig({ fps });
      saveConfig(this.config);
    });

    // 设置模态框
    this.elements.btnSettings?.addEventListener('click', () => {
      this.elements.settingsModal.showModal();
    });
    this.elements.btnCloseSettings?.addEventListener('click', () => {
      this.elements.settingsModal.close();
    });
    this.elements.btnSaveSettings?.addEventListener('click', () => this._saveSettings());
    this.elements.btnCancelSettings?.addEventListener('click', () => {
      this.elements.settingsModal.close();
    });

    // 设置滑块实时更新
    this.elements.settingQuality?.addEventListener('input', (e) => {
      this.elements.qualityValue.textContent = e.target.value;
    });
    this.elements.settingMotionSensitivity?.addEventListener('input', (e) => {
      this.elements.sensitivityValue.textContent = e.target.value;
    });

    // 页面卸载
    window.addEventListener('beforeunload', () => this._cleanup());

    // 移动端：滑动手势关闭抽屉
    let touchStartX = 0;
    this.elements.convDrawer?.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    this.elements.convDrawer?.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - touchStartX;
      if (dx < -60) {
        this._closeDrawer();
      }
    }, { passive: true });
  }

  // -----------------------------------------------------------------------
  // DOM 缓存
  // -----------------------------------------------------------------------

  _cacheElements() {
    this.elements = {
      // 视频
      cameraVideo: document.getElementById('cameraVideo'),
      captureCanvas: document.getElementById('captureCanvas'),
      cameraPlaceholder: document.getElementById('cameraPlaceholder'),

      // 按钮
      btnCamera: document.getElementById('btnCamera'),
      btnMic: document.getElementById('btnMic'),
      btnSnapshot: document.getElementById('btnSnapshot'),
      btnSend: document.getElementById('btnSend'),
      btnClearChat: document.getElementById('btnClearChat'),
      btnTTS: document.getElementById('btnTTS'),

      // 对话管理
      conversationSidebar: document.getElementById('conversationSidebar'),
      convList: document.getElementById('convList'),
      btnNewConv: document.getElementById('btnNewConv'),
      btnToggleSidebar: document.getElementById('btnToggleSidebar'),
      btnExpandSidebar: document.getElementById('btnExpandSidebar'),
      btnNewConvDrawer: document.getElementById('btnNewConvDrawer'),

      // 移动端
      btnMobileConvList: document.getElementById('btnMobileConvList'),
      convOverlay: document.getElementById('convOverlay'),
      convDrawer: document.getElementById('convDrawer'),
      convDrawerList: document.getElementById('convDrawerList'),
      btnCloseDrawer: document.getElementById('btnCloseDrawer'),

      // 对话标题
      convTitle: document.getElementById('convTitle'),

      // 状态
      statusCamera: document.getElementById('statusCamera'),
      statusMic: document.getElementById('statusMic'),
      statusTokens: document.getElementById('statusTokens'),
      statusCost: document.getElementById('statusCost'),
      modelSelect: document.getElementById('modelSelect'),
      fpsSelect: document.getElementById('fpsSelect'),

      // 对话
      chatMessages: document.getElementById('chatMessages'),
      textInput: document.getElementById('textInput'),
      interimText: document.getElementById('interimText'),
      interimContent: document.getElementById('interimContent'),

      // 设置
      btnSettings: document.getElementById('btnSettings'),
      settingsModal: document.getElementById('settingsModal'),
      btnCloseSettings: document.getElementById('btnCloseSettings'),
      btnSaveSettings: document.getElementById('btnSaveSettings'),
      btnCancelSettings: document.getElementById('btnCancelSettings'),
      settingMaxDimension: document.getElementById('settingMaxDimension'),
      settingQuality: document.getElementById('settingQuality'),
      qualityValue: document.getElementById('qualityValue'),
      settingMotionDetection: document.getElementById('settingMotionDetection'),
      settingMotionSensitivity: document.getElementById('settingMotionSensitivity'),
      sensitivityValue: document.getElementById('sensitivityValue'),
      settingLanguage: document.getElementById('settingLanguage'),
      settingVoice: document.getElementById('settingVoice'),
      settingAutoSpeak: document.getElementById('settingAutoSpeak'),
    };
  }

  // -----------------------------------------------------------------------
  // 设置管理
  // -----------------------------------------------------------------------

  _restoreSettings() {
    const s = this.elements;
    const c = this.config;

    if (s.settingMaxDimension) s.settingMaxDimension.value = c.maxImageDimension;
    if (s.settingQuality) {
      s.settingQuality.value = c.jpegQuality;
      if (s.qualityValue) s.qualityValue.textContent = c.jpegQuality;
    }
    if (s.settingMotionDetection) s.settingMotionDetection.checked = c.motionDetection;
    if (s.settingMotionSensitivity) {
      s.settingMotionSensitivity.value = c.motionSensitivity;
      if (s.sensitivityValue) s.sensitivityValue.textContent = c.motionSensitivity;
    }
    if (s.settingLanguage) s.settingLanguage.value = c.speechLang;
    if (s.modelSelect) s.modelSelect.value = c.model;
    if (s.fpsSelect) s.fpsSelect.value = String(c.fps);
    if (s.settingAutoSpeak) s.settingAutoSpeak.checked = this.ttsEnabled;
  }

  _saveSettings() {
    const s = this.elements;

    this.config.maxImageDimension = parseInt(s.settingMaxDimension?.value) || 512;
    this.config.jpegQuality = parseFloat(s.settingQuality?.value) || 0.6;
    this.config.motionDetection = s.settingMotionDetection?.checked ?? true;
    this.config.motionSensitivity = parseInt(s.settingMotionSensitivity?.value) || 15;
    this.config.speechLang = s.settingLanguage?.value || 'zh-CN';
    this.ttsEnabled = s.settingAutoSpeak?.checked ?? false;
    this.config.autoSpeak = this.ttsEnabled;
    this._updateTTSButton();

    // 同步到各模块
    this.camera.updateConfig({
      maxImageDimension: this.config.maxImageDimension,
      jpegQuality: this.config.jpegQuality,
      motionDetection: this.config.motionDetection,
      motionSensitivity: this.config.motionSensitivity,
    });

    this.speech.updateConfig({
      speechLang: this.config.speechLang,
    });

    this.ai.updateConfig({
      model: this.config.model,
    });

    saveConfig(this.config);
    this.elements.settingsModal.close();
    this._showToast('设置已保存', 'success');
  }

  // -----------------------------------------------------------------------
  // 音色加载
  // -----------------------------------------------------------------------

  _loadVoices() {
    const voiceSelect = this.elements.settingVoice;
    if (!voiceSelect) return;

    const populateVoices = () => {
      const voices = this.speech.getVoices();
      voiceSelect.innerHTML = '<option value="">默认</option>';
      voices.forEach((voice) => {
        const option = document.createElement('option');
        option.value = voice.name;
        option.textContent = `${voice.name} (${voice.lang})`;
        voiceSelect.appendChild(option);
      });
    };

    populateVoices();
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = populateVoices;
    }
  }

  // -----------------------------------------------------------------------
  // 对话清空
  // -----------------------------------------------------------------------

  _clearChat() {
    // 取消进行中的请求
    if (this.isProcessing) {
      this.ai.cancel();
      this.isProcessing = false;
      this._updateProcessingUI(false);
    }

    this.ai.clearHistory();

    // 清空当前对话的消息
    const conv = this._getActiveConv();
    if (conv) {
      conv.messages = [];
      conv.updatedAt = Date.now();
      this._safeSaveConversations();
    }

    this.elements.chatMessages.innerHTML = `
      <div class="welcome-message">
        <div class="welcome-icon">🤖</div>
        <h3>对话已清空</h3>
        <p>AI 的记忆已重置，开始新的对话吧。</p>
      </div>
    `;
    this.elements.statusTokens.textContent = '--';
    this.elements.statusCost.textContent = '$0.000';
    this.ai.tokenTracker.reset();
    this._renderConvList();
  }

  // -----------------------------------------------------------------------
  // 清理
  // -----------------------------------------------------------------------

  _cleanup() {
    if (this.cameraActive) {
      this.camera.stop();
    }
    if (this.micActive) {
      this.speech.stopListening();
    }
    this.speech.stopSpeaking();
    this.ai.cancel();
  }

  // -----------------------------------------------------------------------
  // 工具方法
  // -----------------------------------------------------------------------

  _showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  _formatTime() {
    const now = new Date();
    return now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
}

// ---------------------------------------------------------------------------
// 应用启动
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  app.init();

  // 暴露到全局作用域，方便调试
  window.__app = app;
});
