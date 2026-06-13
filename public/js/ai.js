/**
 * AI 服务通信模块
 *
 * 职责：
 *  - 发送消息 + 图像到后端 /api/chat
 *  - 处理 SSE 流式响应
 *  - 管理本地对话历史
 *  - 跟踪 token 用量和费用
 */

import { TokenTracker } from './config.js';

export class AIService {
  constructor(config = {}) {
    // API 端点硬编码，不可从外部配置（安全性：防止 localStorage 劫持）
    this.apiEndpoint = '/api/chat';
    this.model = config.model || 'qwen-vl-plus';
    this.maxHistory = config.maxHistory || 20;

    // 对话历史（本地存储，仅保留文本摘要）
    this.messageHistory = [];

    // Token 追踪
    this.tokenTracker = new TokenTracker();

    // 当前活跃的 AbortController（用于取消请求）
    this.abortController = null;
  }

  /**
   * 发送消息（带可选图像），获取流式响应
   *
   * @param {string} text - 用户消息文本
   * @param {string[]} images - base64 图像数组（可选）
   * @param {Object} callbacks - 回调函数集合
   * @param {Function} callbacks.onText - (delta: string) => void 流式文本增量
   * @param {Function} callbacks.onDone - (fullText: string, usage: object) => void 完成
   * @param {Function} callbacks.onError - (error: Error) => void 错误
   */
  async sendMessage(text, images = [], callbacks = {}) {
    const { onText, onDone, onError } = callbacks;

    // 添加用户消息到历史
    this.messageHistory.push({ role: 'user', content: text });

    // 限制历史长度
    if (this.messageHistory.length > this.maxHistory * 2) {
      this.messageHistory = this.messageHistory.slice(-this.maxHistory * 2);
    }

    // 取消之前的请求
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    try {
      // 解析 base64 图像（去除 data URI 前缀）
      const processedImages = images.map((img) => {
        if (img.startsWith('data:')) {
          const [header, data] = img.split(',');
          const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/jpeg';
          return { media_type: mediaType, data };
        }
        return { media_type: 'image/jpeg', data: img };
      });

      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: this.messageHistory,
          images: processedImages,
          model: this.model,
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `API 请求失败 (${response.status})`);
      }

      // 读取 SSE 流
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 事件
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 最后一行可能不完整

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === 'text') {
              fullText += event.text;
              if (onText) onText(event.text);
            } else if (event.type === 'done') {
              fullText = event.fullText || fullText;

              // 记录 token 用量
              if (event.usage) {
                this.tokenTracker.record(
                  event.usage.input_tokens,
                  event.usage.output_tokens
                );
              }

              // 添加 AI 回复到历史
              if (fullText) {
                this.messageHistory.push({ role: 'assistant', content: fullText });
              }

              if (onDone) {
                onDone(fullText, event.usage);
              }
            } else if (event.type === 'error') {
              throw new Error(event.error);
            }
          } catch (parseError) {
            if (parseError.message && !parseError.message.includes('JSON')) {
              throw parseError;
            }
            // JSON 解析错误，跳过
          }
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('请求已取消');
        return;
      }
      console.error('AI 服务错误:', error);
      if (onError) onError(error);
    }
  }

  /**
   * 取消当前请求
   */
  cancel() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * 清空对话历史
   */
  clearHistory() {
    this.messageHistory = [];
  }

  /**
   * 更新模型
   */
  setModel(model) {
    this.model = model;
  }

  /**
   * 更新配置
   */
  updateConfig(config) {
    // apiEndpoint 不允许运行时修改（防劫持）
    if (config.model) this.model = config.model;
    if (config.maxHistory) this.maxHistory = config.maxHistory;
  }

  /**
   * 获取费用估算
   */
  getEstimatedCost() {
    return this.tokenTracker.estimateCost(this.model);
  }

  /**
   * 获取累计 token 数
   */
  getTokenUsage() {
    return {
      input: this.tokenTracker.totalInputTokens,
      output: this.tokenTracker.totalOutputTokens,
    };
  }
}
