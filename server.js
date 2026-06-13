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

// DashScope OpenAI 兼容端点
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// 启动时校验
if (!DASHSCOPE_API_KEY) {
  console.error('❌ 缺少 DASHSCOPE_API_KEY 环境变量。请创建 .env 文件并设置 API Key。');
  console.error('   获取 Key: https://bailian.console.aliyun.com/');
  console.error('   参考 .env.example 文件。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express 应用
// ---------------------------------------------------------------------------
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' })); // 支持 base64 图像的大请求体
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 系统提示词
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `你是"视觉伙伴"（Vision Buddy）——一个能通过摄像头看到用户、听到用户说话的 AI 助手，由通义千问多模态大模型驱动。

## 你的能力
- 你能看到摄像头中的实时画面（用户会定期发送截图）
- 你能听到用户说的话（语音识别转录的文字）
- 你可以用自然、友好的中文与用户对话

## 行为准则
1. **认真倾听**：仔细理解用户说的每一句话，结合画面内容给出有针对性的回应，不要套用固定模板
2. **主动观察**：当用户问"你看到了什么"时，详细描述画面中的物体、人物、场景、文字等具体细节
3. **自然对话**：像真人朋友一样聊天，根据上下文灵活调整回复长度——可以是一句话的玩笑，也可以是详细的解释
4. **视觉优先**：如果画面中有值得注意的内容（物体、文字、场景、人物表情、手势），主动提及并展开
5. **上下文连贯**：记住并引用之前的对话内容，让对话有连续性
6. **诚实表态**：如果看不清或不确定，直接说出来，可以请用户靠近或调整光线
7. **中文对话**：始终使用中文回复

## 特殊指令
- 每次回复都应该基于用户的具体问题和当前画面，禁止使用固定问候语
- 如果用户问"你看到了什么"，详细描述画面内容
- 如果画面太暗或模糊，提醒用户调整光线
- 如果检测到用户在展示某个物品，识别它并询问相关问题
- 保持友好、温暖的语气，像个真正的视觉伙伴`;


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

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: '缺少 messages 数组' });
  }

  const model = requestedModel || DEFAULT_MODEL;

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

    // 添加用户文本
    const lastMessage = messages[messages.length - 1];
    const userText = lastMessage && lastMessage.role === 'user'
      ? (typeof lastMessage.content === 'string' ? lastMessage.content : '')
      : '';

    // 智能选择提示文本，避免死循环兜底
    let finalText = userText;
    if (!finalText) {
      if (images && images.length > 0) {
        finalText = '请描述你在这张图片中看到的内容。';
      } else {
        // 没有文字也没有图像，说明前端出了问题，返回错误让前端处理
        return res.status(400).json({
          error: '消息内容为空，请说话或输入文字后再试。',
        });
      }
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
      apiMessages.push({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : msg.content,
      });
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
        stream_options: { include_usage: true }, // 在流末尾返回 token 用量
      }),
      signal: req.signal, // 客户端断开时自动取消
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`DashScope API 返回 ${response.status}: ${errText}`);
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
          // 流结束
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

          // 提取文本增量
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            res.write(`data: ${JSON.stringify({ type: 'text', text: delta })}\n\n`);
          }

          // 提取最后的 usage 信息
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
    console.error('API error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
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
