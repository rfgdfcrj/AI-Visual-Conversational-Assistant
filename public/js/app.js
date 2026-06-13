/**
 * AI 视觉对话助手 — 主应用控制器
 *
 * 职责：
 *  - 协调 CameraManager、SpeechManager、AIService 三个模块
 *  - 管理 UI 状态（按钮、状态指示器、对话显示）
 *  - 处理用户交互（按钮点击、文本输入、设置变更）
 *  - 实现端云协同的成本控制逻辑
 */

import { loadConfig, saveConfig } from './config.js';
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

    // DOM 引用（在 init() 中填充）
    this.elements = {};

    // 绑定方法（确保 this 正确）
    this._onFrame = this._onFrame.bind(this);
    this._onMotionState = this._onMotionState.bind(this);
    this._onSpeechFinal = this._onSpeechFinal.bind(this);
    this._onSpeechInterim = this._onSpeechInterim.bind(this);
    this._onSpeechEnd = this._onSpeechEnd.bind(this);
  }

  // -----------------------------------------------------------------------
  // 初始化
  // -----------------------------------------------------------------------

  /**
   * 应用入口：初始化所有 DOM 引用和事件监听器
   */
  init() {
    this._cacheElements();
    this._bindEvents();

    // 初始化摄像头模块（绑定 video/canvas 元素）
    this.camera.init(
      this.elements.cameraVideo,
      this.elements.captureCanvas
    );

    // 加载可用语音音色
    this._loadVoices();

    // 从 localStorage 恢复 UI 状态
    this._restoreSettings();

    console.log('🚀 Vision Buddy 初始化完成');
    console.log('📋 配置:', this.config);
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

      // 自动开始帧捕获（经过运动检测过滤）
      this.camera.startCapture(this._onFrame, this._onMotionState);

      // 立即捕获第一帧，确保后续语音触发时有画面可用
      setTimeout(() => {
        const initialFrame = this.camera.captureSnapshot();
        if (initialFrame) this._lastFrame = initialFrame;
      }, 500); // 等摄像头曝光稳定

      // 启用麦克风按钮和快照按钮
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

    this._showToast('摄像头已关闭', 'info');
  }

  _updateCameraUI(active) {
    const btn = this.elements.btnCamera;
    const video = this.elements.cameraVideo;
    const placeholder = this.elements.cameraPlaceholder;
    const container = document.querySelector('.video-container');

    if (active) {
      btn.classList.add('active');
      btn.querySelector('.btn-text').textContent = '关闭摄像头';
      btn.querySelector('.btn-icon').textContent = '🔴';
      video.classList.add('active');
      placeholder.classList.add('hidden');
      container.classList.add('active');
      this.elements.statusCamera.textContent = '已连接';
      this.elements.statusCamera.className = 'status-badge badge-on';
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
      // 设置语音回调
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
  // 快照分析
  // -----------------------------------------------------------------------

  async takeSnapshot() {
    if (!this.cameraActive) return;

    const frame = this.camera.captureSnapshot();
    if (!frame) {
      this._showToast('无法捕获画面', 'error');
      return;
    }

    this._showToast('📸 正在分析当前画面...', 'info');

    // 添加隐藏的系统提示
    const snapshotPrompt = '（用户手动拍摄了一张快照，请详细描述你在这张照片中看到的内容。）';

    this._addUserMessage(snapshotPrompt);
    this.isProcessing = true;

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
  // 文本输入
  // -----------------------------------------------------------------------

  async sendTextMessage() {
    const input = this.elements.textInput;
    const text = input.value.trim();
    if (!text || this.isProcessing) return;

    input.value = '';

    // 如果摄像头开着，附上一帧当前画面
    let images = [];
    if (this.cameraActive) {
      const frame = this.camera.captureSnapshot();
      if (frame) images.push(frame);
    }

    this._addUserMessage(text);
    this.isProcessing = true;

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

  /**
   * 当运动检测触发时，自动发送当前帧给 AI 分析
   * 这是一个低频率的自动分析，不会每次都发送
   */
  _onFrame(base64Image) {
    // 自动帧暂时只做缓存，不主动发送
    // 避免在没有用户语音时频繁调用 API 产生费用
    // 用户可以手动点击"快照分析"来触发视觉分析
    this._lastFrame = base64Image;
  }

  /**
   * 运动状态变化
   */
  _onMotionState(isMoving) {
    const dot = document.querySelector('.motion-dot');
    const label = document.querySelector('.motion-label');

    if (isMoving) {
      dot.classList.add('active');
      label.textContent = '运动中';
    } else {
      dot.classList.remove('active');
      label.textContent = '静止';
    }
  }

  // -----------------------------------------------------------------------
  // 语音回调（来自 SpeechManager）
  // -----------------------------------------------------------------------

  _onSpeechFinal(text) {
    console.log('🎤 识别:', text);
    this.elements.interimText.style.display = 'none';

    if (this.isProcessing) {
      // AI 正在回复中，忽略用户语音
      return;
    }

    // 实时捕获当前帧（不用缓存的 _lastFrame，确保 AI 看到最新画面）
    let images = [];
    if (this.cameraActive) {
      const frame = this.camera.captureSnapshot();
      if (frame) images.push(frame);
    }

    this._addUserMessage(text);
    this.isProcessing = true;

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
    // TTS 播报结束，不需要额外处理
  }

  // -----------------------------------------------------------------------
  // AI 响应处理
  // -----------------------------------------------------------------------

  _onAIResponseComplete(fullText, usage) {
    this.isProcessing = false;

    // 更新 token 统计
    if (usage) {
      this._updateTokenStats(usage);
    }

    // 根据回复内容更新 AI 头像表情
    if (fullText) {
      this._updateAssistantAvatar(fullText);
    }

    // 自动朗读（如果启用）
    if (this.config.autoSpeak && fullText) {
      this.speech.speak(fullText);
    }
  }

  _onAIError(error) {
    this.isProcessing = false;
    this._showToast(`AI 错误: ${error.message}`, 'error');
    console.error('AI 错误详情:', error);
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
      // 移除"思考中..."占位
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

    // 按优先级排列，先匹配到的优先
    const rules = [
      { emoji: '👋', keywords: ['你好', 'hello', 'hi', '欢迎', '嗨', '再见', '拜拜', 'bye'] },
      { emoji: '👀', keywords: ['看到', '看见', '画面', '图片', '摄像头', '镜头', '观察', '图像', '照片'] },
      { emoji: '😮', keywords: ['惊讶', '哇', '哦', '天啊', '居然', '竟然', '没想到', '意外'] },
      { emoji: '😊', keywords: ['开心', '高兴', '棒', '太好了', '哈哈', '不错', '喜欢', '很棒', '真好', '微笑', '😊'] },
      { emoji: '💡', keywords: ['建议', '试试', '推荐', '提醒', '注意', '提示', '小技巧'] },
      { emoji: '🤔', keywords: ['看起来', '好像', '可能', '不确定', '似乎', '也许', '大概'] },
      { emoji: '👍', keywords: ['是的', '没错', '对', '好的', '正确', '可以', '没问题', '当然'] },
      { emoji: '🎉', keywords: ['恭喜', '庆祝', '成功', '完成', '太好了', '优秀', '厉害'] },
      { emoji: '😅', keywords: ['抱歉', '对不起', '不清楚', '无法', '不能', '遗憾'] },
      { emoji: '💛', keywords: ['理解', '关心', '小心', '注意安全', '保重', '在乎', '陪伴'] },
      { emoji: '🧠', keywords: ['分析', '推理', '逻辑', '深度', '思考', '推理'] },
    ];

    for (const rule of rules) {
      for (const kw of rule.keywords) {
        if (lower.includes(kw)) {
          return rule.emoji;
        }
      }
    }

    // 默认保持机器人
    return '🤖';
  }

  /**
   * 更新最后一条 AI 消息的头像表情
   */
  _updateAssistantAvatar(fullText) {
    const messagesEl = this.elements.chatMessages;
    const lastAiMsg = messagesEl.querySelector('.message.assistant:last-of-type');
    if (!lastAiMsg) return;

    const avatar = lastAiMsg.querySelector('.message-avatar');
    if (!avatar) return;

    const emoji = this._pickAssistantEmoji(fullText);

    // 添加切换动画类
    avatar.classList.add('emoji-switch');
    avatar.textContent = emoji;

    // 动画结束后移除类
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
  // 事件绑定
  // -----------------------------------------------------------------------

  _bindEvents() {
    // 按钮
    this.elements.btnCamera.addEventListener('click', () => this.toggleCamera());
    this.elements.btnMic.addEventListener('click', () => this.toggleMic());
    this.elements.btnSnapshot.addEventListener('click', () => this.takeSnapshot());
    this.elements.btnSend.addEventListener('click', () => this.sendTextMessage());
    this.elements.btnClearChat.addEventListener('click', () => this._clearChat());

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
      settingApiEndpoint: document.getElementById('settingApiEndpoint'),
      settingMaxDimension: document.getElementById('settingMaxDimension'),
      settingQuality: document.getElementById('settingQuality'),
      qualityValue: document.getElementById('qualityValue'),
      settingMotionDetection: document.getElementById('settingMotionDetection'),
      settingMotionSensitivity: document.getElementById('settingMotionSensitivity'),
      sensitivityValue: document.getElementById('sensitivityValue'),
      settingLanguage: document.getElementById('settingLanguage'),
      settingVoice: document.getElementById('settingVoice'),
    };
  }

  // -----------------------------------------------------------------------
  // 设置管理
  // -----------------------------------------------------------------------

  _restoreSettings() {
    const s = this.elements;
    const c = this.config;

    if (s.settingApiEndpoint) s.settingApiEndpoint.value = c.apiEndpoint;
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
  }

  _saveSettings() {
    const s = this.elements;

    this.config.apiEndpoint = s.settingApiEndpoint?.value || this.config.apiEndpoint;
    this.config.maxImageDimension = parseInt(s.settingMaxDimension?.value) || 512;
    this.config.jpegQuality = parseFloat(s.settingQuality?.value) || 0.6;
    this.config.motionDetection = s.settingMotionDetection?.checked ?? true;
    this.config.motionSensitivity = parseInt(s.settingMotionSensitivity?.value) || 15;
    this.config.speechLang = s.settingLanguage?.value || 'zh-CN';

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
      apiEndpoint: this.config.apiEndpoint,
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
  // 对话管理
  // -----------------------------------------------------------------------

  _clearChat() {
    this.ai.clearHistory();
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
