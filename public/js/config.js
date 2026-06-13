/**
 * 全局配置模块
 * 集中管理所有可配置参数，支持从 localStorage 加载/保存用户偏好
 */

export const DEFAULT_CONFIG = {
  // API
  apiEndpoint: '/api/chat',
  model: 'qwen-vl-plus',

  // 摄像头
  cameraWidth: 1280,
  cameraHeight: 720,
  facingMode: 'user', // 'user' | 'environment'

  // 帧捕获
  fps: 2,                    // 每秒捕获帧数
  maxImageDimension: 512,    // 发送给 API 的最大边长
  jpegQuality: 0.6,          // JPEG 压缩质量

  // 运动检测
  motionDetection: true,     // 是否启用运动检测
  motionSensitivity: 15,     // 灵敏度阈值（像素差异百分比，越低越敏感）

  // 语音
  speechLang: 'zh-CN',       // 语音识别语言
  speechContinuous: true,    // 持续识别
  speechInterimResults: true,// 显示中间结果

  // 对话
  maxHistory: 20,            // 最大消息历史
  autoSpeak: true,           // TTS 自动朗读 AI 回复
};

// localStorage 键名
const STORAGE_KEY = 'vision-buddy-config';

/**
 * 从 localStorage 加载配置（合并默认值）
 */
export function loadConfig() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (e) {
    console.warn('加载配置失败，使用默认值', e);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * 保存配置到 localStorage
 */
export function saveConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (e) {
    console.warn('保存配置失败', e);
  }
}

/**
 * 累计 token 用量追踪器
 */
export class TokenTracker {
  constructor() {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }

  /**
   * 记录一次 API 调用的 token 用量
   */
  record(inputTokens, outputTokens) {
    this.totalInputTokens += inputTokens || 0;
    this.totalOutputTokens += outputTokens || 0;
  }

  /**
   * 估算费用（USD）
   * Qwen VL DashScope 参考价格（每百万 token）：
   *   qwen-vl-plus:                  ~$0.3 input / ~$0.9 output
   *   qwen-vl-max:                   ~$3.0 input / ~$9.0 output
   *   qwen2.5-vl-72b-instruct:       ~$1.5 input / ~$4.5 output
   */
  estimateCost(model) {
    const rates = {
      'qwen-vl-plus': { input: 0.3, output: 0.9 },
      'qwen-vl-max': { input: 3.0, output: 9.0 },
      'qwen2.5-vl-72b-instruct': { input: 1.5, output: 4.5 },
    };
    const rate = rates[model] || rates['qwen-vl-plus'];
    const cost =
      (this.totalInputTokens / 1_000_000) * rate.input +
      (this.totalOutputTokens / 1_000_000) * rate.output;
    return cost;
  }

  /**
   * 重置计数器
   */
  reset() {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }
}
