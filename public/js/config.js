/**
 * 全局配置模块
 * 集中管理所有可配置参数，支持从 localStorage 加载/保存用户偏好
 */

export const DEFAULT_CONFIG = {
  // API 端点已硬编码在后端代理中，前端不可配置（防劫持）
  // apiEndpoint 不再存在于配置中，ai.js 中固定为 '/api/chat'
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
  autoSpeak: false,          // TTS 自动朗读 AI 回复（默认关闭，用户手动开启）
};

// ── 安全限制常量（前后端保持一致）─────────────────────────────────────
export const LIMITS = {
  MAX_INPUT_LENGTH: 2000,        // 单次输入最大字符数
  MAX_MESSAGE_LENGTH: 4000,      // 单条消息存储最大字符数
  MAX_CONVERSATIONS: 50,         // 最多对话数量
  MAX_MESSAGES_PER_CONV: 500,    // 单对话最多消息数
  MAX_IMAGES_PER_REQUEST: 5,     // 每次请求最多图像数
  MAX_CONV_TITLE_LENGTH: 50,     // 对话标题最大长度
};

// 对话持久化存储键名
export const CONV_STORAGE_KEY = 'vision-buddy-conversations';

/**
 * 对话数据结构
 * @typedef {Object} Conversation
 * @property {string} id - 唯一标识
 * @property {string} title - 对话标题
 * @property {number} createdAt - 创建时间戳
 * @property {number} updatedAt - 更新时间戳
 * @property {Array<{role:string, content:string}>} messages - 消息列表
 */

/**
 * 从 localStorage 加载所有对话
 * @returns {{ conversations: Conversation[], activeId: string|null }}
 */
export function loadConversations() {
  try {
    const raw = localStorage.getItem(CONV_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('加载对话失败', e);
  }
  return { conversations: [], activeId: null };
}

/**
 * 保存所有对话到 localStorage
 */
export function saveConversations(data) {
  try {
    localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('保存对话失败（可能超出存储限制）', e);
  }
}

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
      // 安全：强制删除 apiEndpoint，防止 localStorage 投毒劫持 API 请求
      delete parsed.apiEndpoint;
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
