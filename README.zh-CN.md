# Awaitlight

[English](README.md) | **简体中文**

**把任何一台闲置手机,变成 AI 编程 agent 的实时状态副屏。**

![Awaitlight —— 发光的状态光环显示 agent 正在执行,并附模型、上下文窗口和用量额度](docs/hero.png)

一眼就能看出每个 agent 是在**运行**、**思考**、**等你确认**还是**空闲**,还有剩余**上下文窗口**和你的**用量额度**——不用再切回终端。100% 本地:它只读取你机器上各工具本来就在写的会话文件,任何数据都不会离开你的网络。

![Awaitlight 状态光环在"思考"状态下的动画](docs/halo.gif)

## 快速开始

三种方式任选其一,把服务跑在你的电脑上:

### 1. 桌面客户端(最省事)

从 [awaitlight.com/download](https://awaitlight.com/download) 或 [GitHub Releases(`client-v1.1.0`)](https://github.com/Awaitlight/awaitlight/releases/tag/client-v1.1.0) 下载 macOS / Windows 客户端。

从 **v1.1.0** 起引擎**内置在客户端里**——装完打开就是真实数据,不需要 Node,不需要终端。

### 2. 一行命令(Node 18+)

```bash
npx awaitlight
```

> npm 包本周内发布——如果命令暂时 404,请先用方式 1 或 3。

### 3. 源码运行

```bash
git clone https://github.com/Awaitlight/awaitlight.git
cd awaitlight
node server.js
```

后两种方式换端口:`PORT=8799 npx awaitlight`。

### 然后:手机(三步)

服务会打印一个局域网地址(类似 `http://192.168.x.x:8787`)。

1. 用一台**同一 Wi-Fi** 下的闲置手机,在浏览器里打开这个地址。
2. 手机**横屏**,立在键盘旁边。
3. **存为书签**——**不要**用"添加到主屏幕"。书签会在普通浏览器里打开,才能保住实时连接和屏幕常亮这两个 Awaitlight 依赖的行为。

主题、语言、空闲小宠物的控制台在打印出的 `…/control` 地址(在电脑上打开)。

## 支持的工具

| 工具 | 能看到什么 | 平台 |
| --- | --- | --- |
| **Claude Code** | 最完整:状态(运行 / 思考 / 等你确认 / 空闲)、上下文窗口、5 小时和每周用量额度、模型、费用 | macOS / Linux / Windows |
| **Claude Cowork** | 会话状态与活动 | **仅 macOS**(读取 Cowork 的本地会话文件,该路径是 macOS 专属的) |
| **Codex CLI** | 会话状态与活动(来自本地会话日志) | macOS / Linux / Windows |
| **Cursor** | 会话活动(来自 Cursor 的本地状态数据库) | **仅 macOS**,且需要带 `node:sqlite` 的 Node(22.5+);不满足时静默关闭 |

Claude Code 的集成最完整;其余几个是对各工具本地文件的只读、尽力而为的解析,上游改了格式就会失效,直到我们跟上。

> Awaitlight 是独立项目,works with Claude Code / Codex / Cursor。与 Anthropic、OpenAI、Anysphere **均无从属、认可或赞助关系**,这些名称仅用于说明互操作性。

## 功能

- **一眼看状态** —— 运行 / 思考 / 等你确认 / 空闲,以状态光环呈现。
- **上下文与额度** —— 剩余上下文窗口,以及用量额度的进度。
- **多 agent 监控墙** —— 多个活跃 agent 自动铺成监控网格。
- **空闲小宠物** —— 没有任务时,一只原创像素小生物在屏幕上玩耍。
- **屏幕常亮** —— 手机做副屏期间保持不熄屏。
- **纯本地** —— 只在你自己的机器上读取 agent 活动;无账号、无云端、无遥测。
- **零 npm 依赖** —— 一个只用 `node:http` 和 `node:fs` 的 Node 服务,没有依赖树要审计。
- **主题与语言** —— 多个配色主题,中英文可切换(在 `…/control` 设置)。

### 自定义小宠物

可以在页面上定义 `window.AWAITLIGHT_PET`,用你自己的美术素材替换内置的空闲小生物——见 [`pets/README.md`](pets/README.md)。素材自备,版权自负;Awaitlight 只随附自己的原创小生物。

## 常见问题

**有数据离开我的机器吗?**
没有。服务读取本地会话文件,通过你自己的 Wi-Fi 把页面推给手机。无账号、无云端、无遥测。

**在共用网络上安全吗?**
服务在局域网上**无鉴权**监听——同一网络里的任何人都能打开页面,看到你的项目名、模型和费用。请把它当成"可信家庭网络"工具,不要在咖啡馆 Wi-Fi 上跑。

**状态检测是怎么做的?**
对各工具写的本地会话日志(例如 `~/.claude/projects/` 下的 JSONL)做启发式解析。可能滞后或误判;工具改了日志格式就会失效,直到我们跟上。欢迎反馈问题。

**手机屏幕变暗 / 断连了。**
确认你是通过**书签**在普通浏览器里打开的页面,而不是"添加到主屏幕"——主屏幕壳会破坏屏幕常亮和实时连接。

**想换端口?**
`PORT=8799 npx awaitlight`(用 `node server.js` 时同样设这个环境变量)。

## 硬件

一盏氛围**硬件状态灯即将推出(coming soon)**——到 [awaitlight.com](https://awaitlight.com) 加入 waitlist。

## 许可证

MIT —— 完全开源,任何用途(包括商用)免费。见 [`LICENSE`](LICENSE)。

第三方组件与商标声明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
