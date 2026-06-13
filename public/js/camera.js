/**
 * 摄像头管理模块
 *
 * 职责：
 *  - 打开/关闭摄像头
 *  - 定时捕获视频帧
 *  - 运动检测（场景变化检测，跳过冗余帧以节省 API 调用成本）
 *  - 图像预处理（缩放、压缩）
 */

import { DEFAULT_CONFIG } from './config.js';

export class CameraManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stream = null;
    this.videoElement = null;
    this.canvasElement = null;
    this.captureTimer = null;
    this.isRunning = false;

    // 运动检测状态
    this.lastThumbnail = null;  // 上一帧的缩略图 ImageData
    this.motionCallback = null; // 检测到运动时的回调
    this.motionStateCallback = null; // 运动状态变化回调
    this.isMoving = false;
  }

  /**
   * 初始化：绑定 DOM 元素
   */
  init(videoEl, canvasEl) {
    this.videoElement = videoEl;
    this.canvasElement = canvasEl;
  }

  /**
   * 请求摄像头权限并开启视频流
   */
  async start() {
    if (this.isRunning) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.config.cameraWidth },
          height: { ideal: this.config.cameraHeight },
          facingMode: this.config.facingMode,
        },
        audio: false, // 音频由 SpeechManager 单独管理
      });

      this.videoElement.srcObject = this.stream;
      this.videoElement.classList.add('active');
      this.isRunning = true;

      console.log('📷 摄像头已开启');
      return true;
    } catch (error) {
      console.error('摄像头开启失败:', error);
      throw new Error(`无法访问摄像头: ${error.message}`);
    }
  }

  /**
   * 关闭摄像头
   */
  stop() {
    this.stopCapture();

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement.classList.remove('active');
    }

    this.isRunning = false;
    this.lastThumbnail = null;
    console.log('📷 摄像头已关闭');
  }

  /**
   * 开始定时捕获帧
   * @param {Function} onFrame - 帧回调 (base64ImageData: string) => void
   * @param {Function} onMotionState - 运动状态回调 (isMoving: boolean) => void
   */
  startCapture(onFrame, onMotionState) {
    if (!this.isRunning || this.captureTimer) return;

    this.motionCallback = onFrame;
    this.motionStateCallback = onMotionState;

    const interval = 1000 / this.config.fps;
    this.captureTimer = setInterval(() => this._captureFrame(), interval);

    console.log(`⏱️ 帧捕获已开始 (${this.config.fps} FPS, 间隔 ${interval}ms)`);
  }

  /**
   * 停止定时捕获
   */
  stopCapture() {
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    this.motionCallback = null;
    this.motionStateCallback = null;
  }

  /**
   * 手动捕获一帧（不经过运动检测）
   * @returns {string|null} base64 图像数据
   */
  captureSnapshot() {
    if (!this.isRunning) return null;
    return this._encodeFrame(this.config.maxImageDimension, this.config.jpegQuality);
  }

  /**
   * 更新配置（运行时）
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };

    // 如果帧率改变了，重启定时器
    if (this.captureTimer) {
      const onFrame = this.motionCallback;
      const onMotion = this.motionStateCallback;
      this.stopCapture();
      if (onFrame) {
        this.startCapture(onFrame, onMotion);
      }
    }
  }

  // -----------------------------------------------------------------------
  // 私有方法
  // -----------------------------------------------------------------------

  /**
   * 捕获一帧，进行运动检测，决定是否发送
   */
  _captureFrame() {
    if (!this.isRunning || !this.videoElement) return;
    if (this.videoElement.readyState < 2) return; // 视频还没准备好

    const video = this.videoElement;
    const canvas = this.canvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // 1. 生成小缩略图用于运动检测 (16x12)
    const thumbW = 16;
    const thumbH = 12;
    canvas.width = thumbW;
    canvas.height = thumbH;
    ctx.drawImage(video, 0, 0, thumbW, thumbH);
    const thumbnailData = ctx.getImageData(0, 0, thumbW, thumbH);

    // 2. 比较与前帧的差异
    let hasMotion = true;

    if (this.config.motionDetection && this.lastThumbnail) {
      hasMotion = this._detectMotion(this.lastThumbnail, thumbnailData);
    }

    this.lastThumbnail = thumbnailData;

    // 3. 通知运动状态
    if (hasMotion !== this.isMoving) {
      this.isMoving = hasMotion;
      if (this.motionStateCallback) {
        this.motionStateCallback(hasMotion);
      }
    }

    // 4. 如果有运动，编码完整帧并回调
    if (hasMotion && this.motionCallback) {
      const fullFrame = this._encodeFrame(
        this.config.maxImageDimension,
        this.config.jpegQuality
      );
      if (fullFrame) {
        this.motionCallback(fullFrame);
      }
    }
  }

  /**
   * 简单像素差异检测
   * 比较两个缩略图的像素值差异比例
   * @returns {boolean} true=有运动, false=静止
   */
  _detectMotion(prev, curr) {
    const threshold = this.config.motionSensitivity / 100;
    const length = prev.data.length;
    let diffCount = 0;

    // 每隔 4 个像素采样一次（RGBA，每个像素 4 个值）
    for (let i = 0; i < length; i += 16) {
      const rDiff = Math.abs(prev.data[i] - curr.data[i]);
      const gDiff = Math.abs(prev.data[i + 1] - curr.data[i + 1]);
      const bDiff = Math.abs(prev.data[i + 2] - curr.data[i + 2]);

      // RGB 任一通道差异超过 25 就算变化
      if (rDiff > 25 || gDiff > 25 || bDiff > 25) {
        diffCount++;
      }
    }

    const totalSamples = length / 16;
    const diffRatio = diffCount / totalSamples;

    return diffRatio >= threshold;
  }

  /**
   * 将当前视频帧编码为 base64 JPEG
   */
  _encodeFrame(maxDim, quality) {
    const video = this.videoElement;
    const canvas = this.canvasElement;

    // 计算缩放尺寸
    let { videoWidth: w, videoHeight: h } = video;
    if (w === 0 || h === 0) return null;

    const scale = Math.min(1, maxDim / Math.max(w, h));
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);

    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, dw, dh);

    return canvas.toDataURL('image/jpeg', quality);
  }
}
