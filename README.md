# AI 视觉对话助手 — Vision Buddy

> 摄像头 + 麦克风 + 通义千问多模态大模型 = 能看能听的 AI 伙伴

🔗 **在线体验：**[https://ai-visual-conversational-assistant-production.up.railway.app/](https://ai-visual-conversational-assistant-production.up.railway.app/)

## 功能

- 🎥 **实时摄像头** — AI 能看到你，描述画面中的内容
- 🎤 **语音对话** — 说话就能交流，AI 会语音回复
- 💬 **文字聊天** — 支持图文混合输入
- 🏷️ **运动检测** — 只在画面变化时上传，节省成本
- 🎨 **简约轻奢** — 温暖色调 + 玻璃拟态界面

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | HTML5 + CSS3 + ES Modules |
| 后端 | Node.js + Express |
| AI | 通义千问 VL (DashScope) |
| 语音 | Web Speech API |
| 部署 | Railway |

## 本地运行

```bash
# 1. 安装依赖
npm install

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，填入你的 DashScope API Key

# 3. 启动
npm start
```

打开 http://localhost:3000

## 获取 API Key

https://bailian.console.aliyun.com/
