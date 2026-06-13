/**
 * 语音管理模块
 *
 * 职责：
 *  - 语音识别（STT）：使用浏览器 Web Speech API，完全本地运行，免费
 *  - 语音合成（TTS）：使用浏览器 SpeechSynthesis API，完全本地运行，免费
 *
 * 成本优势：这两个能力不消耗任何云服务费用
 */

import { DEFAULT_CONFIG } from './config.js';

export class SpeechManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // SpeechRecognition 实例
    this.recognition = null;

    // SpeechSynthesis
    this.synthesis = window.speechSynthesis;
    this.selectedVoice = null;

    // 状态
    this.isListening = false;
    this.isSpeaking = false;
    this.paused = false;

    // 回调
    this.onFinalResult = null;   // (text: string) => void — 最终识别结果
    this.onInterimResult = null; // (text: string) => void — 中间结果
    this.onSpeechEnd = null;     // () => void — 语音播报结束
    this.onError = null;         // (error: Error) => void

    // 防止回声：当 AI 在说话时，暂停识别
    this._echoGuard = false;
  }

  /**
   * 初始化语音识别
   */
  async startListening() {
    // 检查浏览器兼容性
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('您的浏览器不支持语音识别。请使用 Chrome 或 Edge。');
    }

    if (this.isListening) return;

    this.recognition = new SpeechRecognition();
    this.recognition.lang = this.config.speechLang;
    this.recognition.continuous = this.config.speechContinuous;
    this.recognition.interimResults = this.config.speechInterimResults;
    this.recognition.maxAlternatives = 1;

    // 处理结果
    this.recognition.onresult = (event) => {
      if (this._echoGuard) return; // AI 说话时忽略

      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      if (final && this.onFinalResult) {
        this.onFinalResult(final.trim());
      }
      if (interim && this.onInterimResult) {
        this.onInterimResult(interim.trim());
      }
    };

    // 处理错误
    this.recognition.onerror = (event) => {
      console.warn('语音识别错误:', event.error);

      // 'no-speech' 和 'aborted' 是正常的，静默处理
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }

      if (this.onError) {
        this.onError(new Error(`语音识别错误: ${event.error}`));
      }
    };

    // 自动重启（continuous 模式下在某些浏览器中需要手动重启）
    this.recognition.onend = () => {
      if (this.isListening && !this._echoGuard) {
        try {
          this.recognition.start();
        } catch (e) {
          // 已经在运行中，忽略
        }
      }
    };

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recognition.start();
      this.isListening = true;
      console.log('🎤 语音识别已开启');
    } catch (error) {
      throw new Error(`无法访问麦克风: ${error.message}`);
    }
  }

  /**
   * 停止语音识别
   */
  stopListening() {
    this.isListening = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (e) {
        // 忽略
      }
      this.recognition = null;
    }
    console.log('🎤 语音识别已停止');
  }

  /**
   * 暂停/恢复识别（用于 AI 说话时的回声防护）
   */
  pauseListening() {
    this._echoGuard = true;
    if (this.recognition) {
      try { this.recognition.stop(); } catch (e) { /* ok */ }
    }
  }

  resumeListening() {
    this._echoGuard = false;
    if (this.isListening && this.recognition) {
      try { this.recognition.start(); } catch (e) { /* ok */ }
    }
  }

  // -----------------------------------------------------------------------
  // TTS — 语音合成
  // -----------------------------------------------------------------------

  /**
   * 朗读文本
   */
  speak(text) {
    if (!this.synthesis) {
      console.warn('浏览器不支持语音合成');
      return;
    }

    // 取消正在进行的朗读
    this.synthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = this.config.speechLang;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // 使用用户选择的音色
    if (this.selectedVoice) {
      utterance.voice = this.selectedVoice;
    } else {
      // 自动选择合适的中文音色
      const voices = this.synthesis.getVoices();
      const preferredVoice = voices.find(
        (v) => v.lang.startsWith('zh') && v.localService
      );
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }
    }

    utterance.onstart = () => {
      this.isSpeaking = true;
      // AI 开始说话时暂停麦克风识别，防止回声
      this.pauseListening();
    };

    utterance.onend = () => {
      this.isSpeaking = false;
      this.resumeListening();
      if (this.onSpeechEnd) this.onSpeechEnd();
    };

    utterance.onerror = (event) => {
      this.isSpeaking = false;
      this.resumeListening();
      console.warn('TTS 错误:', event.error);
    };

    this.synthesis.speak(utterance);
  }

  /**
   * 停止朗读
   */
  stopSpeaking() {
    if (this.synthesis) {
      this.synthesis.cancel();
      this.isSpeaking = false;
      this.resumeListening();
    }
  }

  /**
   * 获取可用的语音合成音色列表
   */
  getVoices() {
    if (!this.synthesis) return [];
    return this.synthesis.getVoices();
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig) {
    const langChanged = newConfig.speechLang && newConfig.speechLang !== this.config.speechLang;
    this.config = { ...this.config, ...newConfig };

    // 如果语言改变，需要重启识别
    if (langChanged && this.isListening) {
      this.stopListening();
      this.startListening().catch(console.error);
    }
  }
}
