# AI 视觉对话助手 — Vision Buddy

> 摄像头 + 麦克风 + 通义千问多模态大模型 = 能看能听的 AI 伙伴

🔗 **在线体验：**[https://ai-visual-conversational-assistant-production.up.railway.app/](https://ai-visual-conversational-assistant-production.up.railway.app/)
demo视频链接通过网盘分享的文件：移动端.mp4
链接: https://pan.baidu.com/s/1Wjyj-ZURDY02ED9QudXyPA?pwd=xepn 提取码: xepn

## 功能

- 🎥 **实时摄像头** — AI 能看到你，描述画面中的内容
- 🎤 **语音对话** — 说话就能交流，AI 会语音回复
- 💬 **文字聊天** — 支持图文混合输入
- 🏷️ **运动检测** — 只在画面变化时上传，节省成本
- 🎨 **简约轻奢** — 温暖色调 + 玻璃拟态界面
- 💾 **多对话管理** — 支持新建/切换/删除对话，localStorage 持久化
- 🔊 **语音播报可选** — 手动开关 TTS，默认关闭不打扰
- 😎 **动态表情** — AI 根据回复内容自动切换匹配的表情
- 🛡️ **防并发** — 处理中自动禁用输入，避免重复请求浪费 Token
- 📱 **手机适配** — 安全区域、触控优化、移动端对话抽屉

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

## 更新日志

### v2.0 (2026-06-13)

**新功能**
- 多对话管理：新建/切换/删除对话，localStorage 持久化，刷新不丢失
- 语音播报可选：TTS 手动开关，默认关闭
- 桌面端对话侧栏：可折叠，收起时浮动展开按钮
- 移动端对话抽屉：左滑手势、遮罩层

**交互优化**
- AI 角色重写：从正式助手变为朋友式聊天伙伴，口语化、幽默、场景化
- 动态表情增强：新增 12 条关键词规则，回复更生动
- 防并发机制：AI 处理中自动禁用所有输入入口，避免重复请求浪费 Token

**手机适配**
- 防误触：touch-action、overscroll-behavior、双击缩放禁用
- 触控友好：按钮最小 44px（iOS HIG）
- 新增 375px 超小屏断点（iPhone SE）、横屏适配
- 小屏自动隐藏提示面板

**安全加固**
- API 端点硬编码：前端不可配置，防止 localStorage 劫持重定向到恶意服务器
- 服务端 Origin/Referer 校验：拒绝跨域 API 请求
- IP 速率限制：60 秒最多 30 次请求
- 输入多层校验：长度、角色白名单、模型白名单、图像大小/MIME/数量
- 控制字符清洗、错误信息脱敏
- localStorage 配额溢出自动降级

**Bug 修复**
- 关闭摄像头后"运动中"指示器仍然显示
- 连续快速拍照导致请求叠加失效
