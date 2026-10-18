# DSH QQ Console

[![CI](https://github.com/shenhua725/dsh-qq-console/actions/workflows/ci.yml/badge.svg)](https://github.com/shenhua725/dsh-qq-console/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)

把手机 QQ 变成 DeepSeek Harness（DSH）的遥控器。
插件直接运行在 DSH 进程内，自带 QQ 网关、菜单注册、任务进度看门狗和设置卡片，
不依赖 Python 桥接。

> Turn your phone QQ into a remote control for DeepSeek Harness. The plugin runs
> inside DSH with its own QQ gateway, menu registration, progress watchdog and
> settings UI — no Python bridge required.

## 功能

- **底部菜单**：最多 7 个项目 +「对话」+「设置」+「更多」。
  - 项目：该项目最近的会话；超过 5 个时第 5 项为「更多」。
  - 对话：对话状态 / 排队执行 / 打断重发 / 退回编辑 / 删除取消。
  - 设置：实时进度 / 当前进度 / 1 分钟汇报 / 5 分钟汇报 / 只要结果。
  - 更多：当前对话 / 全部对话 / 项目 / 会话操作 / 面板。
- **卡片内标签选择**：项目卡、对话卡、汇报卡、当前对话卡、会话操作卡和忙时
  选择卡都带行内可点标签。选择项目、进入对话、切换汇报模式都可以直接点，
  不必再手动输入命令。
- **对话状态**：固定 8 行 —— 项目 / 对话 / 当前任务 / 排队任务 / 汇报方式 /
  当前模型 / 推理强度 / 当前权限。电脑端直接发起的轮次也能看到。
- **任务确认 → 进度 → 结果**：默认 5 分钟汇报，可切换 1 分钟、实时流式或只要结果。
- **排队与改向**：队列最多显示 5 条，每条带「引导 n」「取消 n」。引导会打断
  当前轮并插入新要求，取消只删除第 n 条。
- **模型与权限**：从 DSH 实时模型目录和 WorkBuddy 缓存目录添加模型，设置默认
  模型与推理强度。手机端按模型全称列出全部已选模型，强度从高到低排列；
  `off` 显示为「强度0（关闭）」。权限档位直接读取 DSH `permissionPresets`。
- **凭据持久化**：AppID 落盘；AppSecret 用 Windows DPAPI 加密后落盘，永不回显。
  重启 DSH 或重载插件后自动恢复并连接。
- **闲时闸门**：工作日 9:00–12:00、14:00–18:00 以及 8:30–9:00、13:30–14:00
  不直接外派，进入闲时队列，到点自动放行；周末全天可跑。
- **附件**：QQ 图片走 DSH 原生图片输入。MIME 按「文件魔数 > QQ 声明类型 >
  扩展名」判定；DSH 不支持的格式落盘到状态目录 `inbox/`，并把绝对路径写进指令。

## 安装

环境要求：

- Windows 10/11
- DeepSeek Harness Desktop（按 DSH 0.2.1-rc.2 的宿主依赖对齐）
- Node.js 22.19+ 或 24+

### 1. 部署到 DSH profile

```powershell
git clone https://github.com/shenhua725/dsh-qq-console.git
cd dsh-qq-console
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

默认目标：

```text
%USERPROFILE%\.dsh\profiles\desktop\vendor\dsh-qq-console-v2
```

脚本只写这个目录，不会碰旧插件 `dsh-qq-console-plugin`。

### 2. 在 DSH 中安装

1. 打开 DSH → 侧边栏「插件」。
2. 选择「从本地路径安装」，填入上面的 vendor 目录绝对路径。
3. 安装后重启 DSH。
4. 打开「插件 → DSH QQ 控制台 2.2」：
   - 填 AppID / AppSecret，点「保存并连接」；
   - 从模型目录添加可选模型，设置每项推理强度，第一项为默认；
   - 点「立即刷新菜单」，确认底部菜单已注册。

设置页保存后会立即重连并显示真实连接结果。之后重启 DSH 会自动恢复凭据并连接。

## QQ 机器人配置

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，拿到 AppID / AppSecret。
2. 开启单聊消息与相关事件订阅。
3. 把 AppID / AppSecret 填进插件设置页。

> **同一个 QQ 机器人 AppID 只能有一个消息消费者。** 如果同一 AppID 还跑着别的
> 桥接（例如 Codex 版 `qq_codex_bridge.py`），先停掉其中一个，或给本插件换一个
> 机器人 AppID，否则两边会抢消息。

## 常用指令

| 指令 | 作用 |
| --- | --- |
| `项目` | 查看项目并选择 |
| `项目 N` | 查看第 N 个项目的全部会话 |
| `会话` / `对话` | 查看全部活跃对话 |
| `进入 <对话名>` | 绑定对话；同名时自动附 8 位短 ID |
| `当前` | 当前对话与运行状态 |
| `对话状态` / `状态` | 8 行对话状态 |
| `汇报` | 打开汇报模式选择 |
| `排队执行` / `引导改向` / `打断重发` / `取消本条` | 忙时任务处理 |
| `模型` / `强度` / `权限` | 模型、推理强度、权限选择 |
| `刷新菜单` | 按当前会话清单重建底部菜单 |
| `帮助` | 完整指令表 |

## 凭据与安全

- AppID 明文保存在 `%USERPROFILE%\.dsh\qq-console-v2\settings.json`。
- AppSecret 先用 Windows DPAPI 加密成 `dpapi:v1:*`，再写入同一文件，只能由
  当前 Windows 用户解密。
- 设置页只显示 AppID 和「已设置 / 未设置」，AppSecret 永不回显。
- 点「清除已保存凭据」会同时清除内存与落盘凭据并停止网关。
- 仓库不包含任何真实 AppID、AppSecret、Token 或用户数据。

WorkBuddy 缓存模型来自 `%USERPROFILE%\.dsh\.workbuddy-ai-catalog.json`。未登录
WorkBuddy 时仍可配置这些模型，但真正调用前需要先登录。

## 开发与测试

```powershell
npm run check   # 9 个 lib 文件的语法检查
npm test        # 离线行为自检：47 项
```

宿主加载测试需要已部署的 vendor 副本解析 DSH peer：

```powershell
$env:DSH_QQ_PLUGIN_DIR = "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-qq-console-v2"
node .selftest/host-load.mjs
```

## 已知限制

- 仅在 Windows 上验证；凭据加密依赖 Windows DPAPI。
- 法定节假日不会自动识别，闲时闸门只识别周六/周日。
- QQ C2C 对多行键盘支持不稳定，卡片内选择使用行内可点标签。
- 「引导」只对正在运行的轮次有效；空闲时会提示直接发文字。
- 电脑端界面直接发起的轮次可以看状态、可以打断，但不算 QQ 任务台账。

## 目录结构

```text
lib/
  index.js         宿主入口、凭据、设置路由、启动/停止
  catalog.js       DSH 实时模型目录与 WorkBuddy 缓存目录归一化
  secure-store.js  Windows DPAPI 凭据加密/解密
  gateway.js       QQ 网关 WebSocket + REST
  console.js       指令路由、任务、排队、状态、模型/权限
  menu.js          底部菜单构建与刷新
  sessions.js      DSH 会话/模型/权限窄接口
  store.js         状态落盘（原子写）
  client.js        设置卡片
.selftest/         离线自检与宿主加载测试
deploy.ps1         部署到 DSH profile 的 vendor 目录
cordis.patch.yml   DSH 插件清单
```

## License

[MIT](LICENSE) © 2026 shenhua725
