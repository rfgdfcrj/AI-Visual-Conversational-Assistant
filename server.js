/**
 * AI 视觉对话助手 — 后端代理服务器（通义千问 / DashScope 版）
 *
 * 职责：
 *  1. 提供静态文件服务（前端页面）
 *  2. 代理 /api/chat 请求到 DashScope API（保护 API Key）
 *  3. 流式响应转发（OpenAI 兼容 SSE → 前端统一格式）
 *  4. 对话上下文管理（限制历史长度以控制成本）
 *
 * Qwen 视觉模型（原生支持图像理解）：
 *   - qwen-vl-max     — 最强视觉模型，支持复杂场景分析
 *   - qwen-vl-plus    — 均衡性能与成本
 *   - qwen2.5-vl-72b  — 开源旗舰 VL 模型
 *
 * API 文档：https://help.aliyun.com/zh/model-studio/getting-started/models
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen-vl-plus';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY, 10) || 20;

// 安全限制
const MAX_MESSAGE_LENGTH = 4000;      // 单条消息最大字符数
const MAX_IMAGES_PER_REQUEST = 5;     // 每次请求最多图像数
const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024; // 单张图像最大 2MB（base64 解码后）
const RATE_LIMIT_WINDOW_MS = 60_000;  // 速率限制窗口 60 秒
const RATE_LIMIT_MAX_REQUESTS = 30;   // 每窗口最多 30 次请求
const ALLOWED_MODELS = [              // 模型白名单
  'qwen-vl-plus',
  'qwen-vl-max',
  'qwen2.5-vl-72b-instruct',
];

// DashScope OpenAI 兼容端点
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// 简单内存速率限制器
const rateLimitMap = new Map();

// 启动时校验
if (!DASHSCOPE_API_KEY) {
  console.error('❌ 缺少 DASHSCOPE_API_KEY 环境变量。请创建 .env 文件并设置 API Key。');
  console.error('   获取 Key: https://bailian.console.aliyun.com/');
  console.error('   参考 .env.example 文件。');
  process.exit(1);
}

// 定期清理过期的速率限制记录（每 5 分钟）
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, 300_000);

// ---------------------------------------------------------------------------
// Express 应用
// ---------------------------------------------------------------------------
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' })); // 支持 base64 图像的大请求体
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 安全中间件：验证 /api/chat 请求来源 + 速率限制
// ---------------------------------------------------------------------------
app.use('/api/chat', (req, res, next) => {
  // ---- 1. Origin/Referer 校验：防止跨域数据劫持 ----
  const origin = req.get('origin') || '';
  const referer = req.get('referer') || '';
  const host = req.get('host') || '';

  // 核心逻辑：如果 Origin 头存在且不匹配当前 Host，
  // 则必须同时有匹配的 Referer 才算合法（说明用户从本站页面发起请求）
  const foreignOrigin = origin && !origin.endsWith(host);
  const sameReferer = referer && referer.includes(host);

  if (foreignOrigin && !sameReferer) {
    console.warn(`⚠️ 拒绝跨域 API 请求: origin=${origin}, referer=${referer}, host=${host}`);
    return res.status(403).json({
      error: '跨域请求被拒绝。请通过应用前端访问 API。',
    });
  }

  // ---- 2. 速率限制：基于 IP ----
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(clientIp);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(clientIp, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    console.warn(`⚠️ 速率限制触发: IP=${clientIp}, count=${entry.count}`);
    return res.status(429).json({
      error: `请求过于频繁，请 ${Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000)} 秒后再试。`,
    });
  }

  next();
});

// ---------------------------------------------------------------------------
// 系统提示词
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `你是"视觉伙伴"（Vision Buddy）——一个能通过摄像头实时看到用户的 AI 伙伴，由通义千问多模态大模型驱动。你就像视频通话另一端的朋友，能看到用户的一举一动，用自然、有趣、接地气的方式聊天。

## 核心个性
- **轻松好玩**：你不是一个冷冰冰的助手，而是一个有温度、有幽默感的伙伴，偶尔开个玩笑或调侃一下
- **主动观察**：看到有趣的画面细节直接说出来、问出来，不要等用户先开口
- **简短有力**：大多数时候 2-4 句话就够了，像真人微信聊天，别写小作文
- **互动引导**：根据画面内容主动提问或提出有趣建议，让对话持续下去

## 场景化互动（看到什么就聊什么，灵活发挥）
- 看到食物/饮料 → "哇你在吃什么？看起来好香！" 或 "这是在喝咖啡还是茶？"
- 看到人对着屏幕 → "在忙什么呢？工作还是摸鱼哈哈"
- 看到宠物 → "好可爱！！是你的猫/狗吗？叫什么名字？"
- 看到户外 → "这是在哪儿？风景不错诶"
- 看到书本/文字 → 试着读出来并简短评论
- 看到人脸表情 → "今天看起来心情不错！" 或 "怎么皱着眉头，遇到什么事了？"
- 画面暗 → "好黑啊，开个灯？还是你在偷偷摸摸干什么坏事 😏"
- 画面模糊/晃动 → "你手别抖啊，我都看不清了！"
- 看到多个人 → "旁边还有别人？介绍一下呗"
- 看到乐器/画具 → "你会弹/画？来一段看看！"
- 看到手机/平板 → "在刷什么好玩的？我也想看"

## 对话风格
1. 自然口语化，像朋友视频聊天一样说话
2. 适当用"哈哈"、"emmm"、"诶"、"哇塞"、"hhh"这类词
3. 幽默但不浮夸，真诚但不肉麻
4. 记住之前聊过的内容，保持上下文连贯
5. 用户情绪不高时多鼓励、多陪伴
6. 用"你"而不是"您"，拉近距离

## 严格禁止
- ❌ 禁止说"作为AI助手/语言模型/人工智能"这类暴露身份的话
- ❌ 禁止说"根据我的分析/基于图像识别/通过摄像头观察"等机械表达
- ❌ 禁止长篇大论或列出 1、2、3 点
- ❌ 禁止每次都以问候语开头
- ❌ 禁止复读用户的话

## 基础要求
- 始终用中文回复
- 画面看不清就诚实说，可以幽默化解
- 每次回复都像第一次聊天那样新鲜自然`;


// ---------------------------------------------------------------------------
// 辅助：限制对话历史长度（控制 token 消耗）
// ---------------------------------------------------------------------------
function trimHistory(messages, maxMessages) {
  if (messages.length <= maxMessages) return messages;
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages.filter((m) => m.role !== 'system');
  const recent = conversationMessages.slice(-maxMessages);
  return [...systemMessages, ...recent];
}

// ---------------------------------------------------------------------------
// POST /api/chat — 核心对话接口（流式 SSE）
// ---------------------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const { messages, images, model: requestedModel } = req.body;

  // ---- 1. 参数类型校验 ----
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: '缺少 messages 数组' });
  }

  // ---- 2. 模型白名单校验 ----
  const model = requestedModel || DEFAULT_MODEL;
  if (!ALLOWED_MODELS.includes(model)) {
    return res.status(400).json({
      error: `无效的模型: ${model}。可用模型: ${ALLOWED_MODELS.join(', ')}`,
    });
  }

  // ---- 3. 消息数量限制 ----
  if (messages.length > MAX_HISTORY + 10) {
    return res.status(400).json({
      error: `消息数量超过限制 (最多 ${MAX_HISTORY + 10} 条)`,
    });
  }

  // ---- 4. 单条消息长度校验 ----
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: `单条消息超过最大长度限制 (${MAX_MESSAGE_LENGTH} 字符)`,
      });
    }
    // 拒绝非法的 role
    if (msg.role && !['user', 'assistant', 'system'].includes(msg.role)) {
      return res.status(400).json({ error: `无效的消息角色: ${msg.role}` });
    }
  }

  // ---- 5. 图像校验 ----
  if (images && Array.isArray(images)) {
    if (images.length > MAX_IMAGES_PER_REQUEST) {
      return res.status(400).json({
        error: `每次最多发送 ${MAX_IMAGES_PER_REQUEST} 张图像`,
      });
    }
    for (const img of images) {
      if (!img.data || typeof img.data !== 'string') {
        return res.status(400).json({ error: '图像数据格式无效' });
      }
      // 检查 base64 数据大小（解码后约 3/4 的编码长度）
      const estimatedSize = (img.data.length * 3) / 4;
      if (estimatedSize > MAX_IMAGE_SIZE_BYTES) {
        return res.status(400).json({
          error: `单张图像超过最大大小 (${Math.round(MAX_IMAGE_SIZE_BYTES / 1024 / 1024)}MB)`,
        });
      }
      // 拒绝非图片 MIME
      const mime = img.media_type || 'image/jpeg';
      if (!mime.startsWith('image/')) {
        return res.status(400).json({ error: '只允许上传图像文件' });
      }
    }
  }

  // ---- 6. 提取并清洗用户文本 ----
  const lastMessage = messages[messages.length - 1];
  let userText = lastMessage && lastMessage.role === 'user'
    ? (typeof lastMessage.content === 'string' ? lastMessage.content : '')
    : '';

  // 清洗：移除控制字符（保留换行和常用空白）
  userText = userText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();

  try {
    // ---- 构建当前 user message 的 content（OpenAI 多模态格式）----
    const contentParts = [];

    // 添加图像（Qwen VL 支持 image_url 格式，含 base64）
    if (images && Array.isArray(images)) {
      for (const img of images) {
        const dataUrl = `data:${img.media_type || 'image/jpeg'};base64,${img.data}`;
        contentParts.push({
          type: 'image_url',
          image_url: { url: dataUrl },
        });
      }
    }

    // 智能选择提示文本
    let finalText = userText;
    if (!finalText) {
      if (images && images.length > 0) {
        finalText = '请描述你在这张图片中看到的内容。';
      } else {
        return res.status(400).json({
          error: '消息内容为空，请说话或输入文字后再试。',
        });
      }
    }

    // 截断过长的文本（保底）
    if (finalText.length > MAX_MESSAGE_LENGTH) {
      finalText = finalText.slice(0, MAX_MESSAGE_LENGTH);
    }

    contentParts.push({
      type: 'text',
      text: finalText,
    });

    // ---- 构建完整的消息列表 ----
    const apiMessages = [{ role: 'system', content: SYSTEM_PROMPT }];

    // 添加历史消息（纯文本，不含图像——节省 token）
    const historyMessages = messages.slice(0, -1).filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    );
    for (const msg of historyMessages) {
      let content = typeof msg.content === 'string' ? msg.content : '';
      // 截断历史消息中的超长文本
      if (content.length > MAX_MESSAGE_LENGTH) {
        content = content.slice(0, MAX_MESSAGE_LENGTH);
      }
      apiMessages.push({ role: msg.role, content });
    }

    // 添加当前用户消息（含图像）
    apiMessages.push({ role: 'user', content: contentParts });

    // 限制历史长度
    const trimmedMessages = trimHistory(apiMessages, MAX_HISTORY);

    // ---- 调用 DashScope API（OpenAI 兼容格式 + 流式）----
    const response = await fetch(`${DASHSCOPE_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: trimmedMessages,
        max_tokens: 2048,
        temperature: 0.9,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: req.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      console.error(`DashScope API ${response.status}: ${errText.slice(0, 200)}`);
      // 不要向前端暴露后端错误细节
      throw new Error(`AI 服务暂时不可用 (${response.status})`);
    }

    // ---- 设置 SSE 响应头 ----
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // ---- 逐块读取并转发 ----
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let usage = null;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          res.write(
            `data: ${JSON.stringify({
              type: 'done',
              fullText,
              usage: usage
                ? {
                    input_tokens: usage.prompt_tokens,
                    output_tokens: usage.completion_tokens,
                  }
                : null,
            })}\n\n`
          );
          res.end();
          return;
        }

        try {
          const chunk = JSON.parse(dataStr);

          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            res.write(`data: ${JSON.stringify({ type: 'text', text: delta })}\n\n`);
          }

          if (chunk.usage) {
            usage = chunk.usage;
          }
        } catch {
          // 跳过无法解析的行
        }
      }
    }

    // 如果流没有以 [DONE] 结束，手动发送完成
    res.write(
      `data: ${JSON.stringify({
        type: 'done',
        fullText,
        usage: usage
          ? {
              input_tokens: usage.prompt_tokens,
              output_tokens: usage.completion_tokens,
            }
          : null,
      })}\n\n`
    );
    res.end();
  } catch (error) {
    console.error('API error:', error.message);
    if (!res.headersSent) {
      return res.status(502).json({ error: 'AI 服务请求失败，请稍后重试。' });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: '连接中断，请重试。' })}\n\n`);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// GET /api/health — 健康检查
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    provider: 'DashScope (通义千问)',
    model: DEFAULT_MODEL,
    maxHistory: MAX_HISTORY,
  });
});

// ---------------------------------------------------------------------------
// GET /api/config — 前端获取可用模型列表和成本信息
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    models: [
      {
        id: 'qwen-vl-plus',
        name: 'Qwen-VL-Plus (推荐)',
        description: '视觉理解 + 对话，性价比最高',
        pricing: '视觉输入约 ¥0.002/1K tokens',
      },
      {
        id: 'qwen-vl-max',
        name: 'Qwen-VL-Max (专家模式)',
        description: '最强视觉推理，适合复杂场景',
        pricing: '视觉输入约 ¥0.02/1K tokens',
      },
      {
        id: 'qwen2.5-vl-72b-instruct',
        name: 'Qwen2.5-VL-72B (开源版)',
        description: '最新开源旗舰 VL 模型',
        pricing: '请参考阿里云官网定价',
      },
    ],
    currentModel: DEFAULT_MODEL,
    provider: 'Qwen (通义千问) via DashScope',
    costTips: [
      'Qwen VL 模型原生支持图像，不需额外模型',
      '运动检测：只在画面变化时发送图像',
      '自适应帧率：静态场景降低捕获频率',
      '分辨率压缩：图像缩放到 512px 以内',
      'JPEG 压缩：使用 60% 质量减少数据量',
      '语音识别/合成：使用浏览器本地能力，完全免费',
      '模型分级：默认 Plus 经济模式，按需升级 Max',
    ],
  });
});

// ---------------------------------------------------------------------------
// 404 处理
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// 启动服务器
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('');
  console.log('🎥  AI 视觉对话助手 — 后端服务已启动');
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   模型: ${DEFAULT_MODEL}`);
  console.log(`   API: DashScope (通义千问) OpenAI 兼容模式`);
  console.log(`   最大历史: ${MAX_HISTORY} 条消息`);
  console.log('');
  console.log('💡 成本控制策略:');
  console.log('   • 运动检测 — 场景无变化时跳过上传');
  console.log('   • 分辨率缩放 — 前端压缩后再发送');
  console.log('   • Qwen VL 原生视觉 — 不需要额外模型');
  console.log('   • 语音识别 — 浏览器本地处理（免费）');
  console.log('   • 语音合成 — 浏览器本地处理（免费）');
  console.log('   • 模型分级 — 默认 Plus 经济模式，按需切换');
  console.log('');
});
