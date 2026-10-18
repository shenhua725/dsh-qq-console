# DSH QQ 控制台 2.2

把手机 QQ 变成 DeepSeek Harness（DSH）的遥控器。插件在 DSH 进程内运行，
自带 QQ 网关、菜单注册、任务进度看门狗和设置卡片，不依赖 Python 桥接。

## 功能

- **底部菜单**：最多 7 个项目 +「对话」+「设置」+「更多」。
  - 对话：对话状态 / 排队执行 / 打断重发 / 退回编辑 / 删除取消
  - 设置：实时进度 / 当前进度 / 1分钟汇报 / 5分钟汇报 / 只要结果
  - 更多：当前对话 / 全部对话 / 项目 / 会话操作 / 面板
  - 项目内超过 5 个会话时，第 5 项是「更多」，点开列出该项目全部会话。
- **对话状态**：固定 8 行 —— 项目 / 对话 / 当前任务 / 排队任务 / 汇报方式 /
  当前模型 / 推理强度 / 当前权限。电脑端直接发起的轮次也能看到。
- **任务确认 → 进度 → 结果**：默认 5 分钟汇报；可切 1 分钟、实时流式、只要结果。
- **排队**：最多显示 5 条，每条带「引导 n」「取消 n」；引导＝打断当前轮并插入，
  取消＝只删第 n 条。
- **模型与权限**：从 DSH 实时模型目录和 WorkBuddy 缓存目录添加可选模型，
  设置默认模型与推理强度；手机端「模型」以模型全称为可点按钮列出全部已选模型
  （标题显示实际数量，空名称自动回退模型 ID），强度按最高→最低排列，`off`
  显示为「强度0（关闭）」；权限按只读→完全访问排列，`off`/`full` 也有中文名。
  权限档位直接读 DSH `permissionPresets`。
- **凭据持久化**：AppID 落盘；AppSecret 用 Windows DPAPI 加密后落盘，
  永不回显。重启 DSH / 插件重载后自动恢复并尝试连接。
- **闲时闸门**：工作日 9:00–12:00、14:00–18:00 与 8:30–9:00、13:30–14:00 不直接
  外派，进闲时队列，到点自动放行；周末全天可跑。
- **附件**：QQ 图片走 DSH 原生图片输入（`session/prompt` 的 image content）。
  MIME 按「文件魔数 > QQ 声明类型 > 扩展名」判定，缺 `content_type` 的 JPEG 不会被
  误标成 PNG。DSH 只接受 PNG/JPEG/WebP/GIF，BMP/HEIC/AVIF/TIFF 会落盘到状态目录
  `inbox/` 并把绝对路径写进指令；其它文件同样落盘交路径。

## 安装

本版本按 **DSH 0.2.1-rc.2** 的宿主依赖重新对齐（`dsh-home-paths`、
`schemastery`、`cordis`），可与当前 Desktop profile 安装；不再依赖
`dsh-credentials`。

### 1. 落到 profile 的 vendor 目录

插件不能从源码树就地安装（解析不到 DSH 的 peer）。在 PowerShell 里执行：

```powershell
powershell -ExecutionPolicy Bypass -File "F:\Codex\办公自动化\QQ控制台\dsh-qq-console-v2\deploy.ps1"
```

默认目标：

```text
C:\Users\<你>\.dsh\profiles\desktop\vendor\dsh-qq-console-v2
```

脚本只写这个新目录，不会碰旧插件 `dsh-qq-console-plugin`。

### 2. 在 DSH 里安装

1. 打开 DSH → 侧边栏「插件」。
2. 选「从本地路径安装」，填上面的 vendor 目录绝对路径。
3. 安装后重启 DSH。
4. 再到「插件 → DSH QQ 控制台 2.2」：
   - 填 AppID / AppSecret，点「保存并连接」；
   - 从模型目录添加可选模型，设置每项的推理强度；第一项是默认；
   - 点「立即刷新菜单」，确认底部菜单变成 7 项目 + 对话/设置/更多。

设置页保存后会立即重连网关并显示真实连接结果，不必再重启。**以后重启 DSH
会自动恢复已保存的凭据并连接。** 从 2.1 升级到 2.2 时，旧版只存在于进程内存的
凭据无法迁移，需要重填一次；从 2.2 起永久保留（直到在设置页手动清除）。

## 卸载

DSH → 插件 → DSH QQ 控制台 2.2 → 卸载。

用户数据默认保留：

```text
~/.dsh/qq-console-v2/
```

重新安装后会继续使用绑定、排队和会话偏好。要彻底清空再手动删这个目录。

## 凭据

- AppID 明文保存在 `~/.dsh/qq-console-v2/settings.json`；
- AppSecret 先用 Windows DPAPI 加密成 `dpapi:v1:*`，再写入同一文件，
  只能由当前 Windows 用户解密；
- 设置页只显示 AppID 和「已设置 / 未设置」，AppSecret 永不回显；
- 插件启动、DSH 重启或插件重载时自动解密并连接；
- 点「清除已保存凭据」会同时清除内存与落盘凭据并停止网关。

WorkBuddy 缓存模型来自 `~/.dsh/.workbuddy-ai-catalog.json`。未登录 WorkBuddy
时仍可看到并配置这些模型，但要真正调用需先登录 WorkBuddy。手机端会把跑不了
的模型标成「未登录」并拦下选择；如果会话里已经存着这种模型，投递前会自动
回退到能跑的模型，并在回执里说明换了哪只。

模型名后面的 `x0.00`、`Free now` 是宿主拼进来的计价标签，手机端只把模型名
放进按钮，计价单独显示在名字后面——按钮文字不会再把价格当任务投递出去。

## 重要限制

- **同一个 QQ 机器人 AppID 只能有一个消息消费者。** 安装本插件前，先停掉
  Codex 版 `qq_codex_bridge.py`，或给本插件换一个机器人 AppID；否则两边会抢消息。
- 旧插件 `dsh-qq-console-plugin` 与本插件可以并存，但不要同时启用并填同一个 AppID。
- 电脑端界面直接发起的轮次，DSH 能看见状态，也能用「打断重发」取消；
  「引导」只对正在运行的轮次有效，空闲时会提示直接发文字。
- 法定节假日按周末处理需要人工判断；当前闸门只自动识别周六/周日。

## 自检

```powershell
$node = "D:\Program Files (x86)\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node ".\.selftest\v2.mjs"
```

宿主加载/路由/凭据测试（需要已部署的 vendor 副本解析 peer）：

```powershell
$env:DSH_QQ_PLUGIN_DIR = "C:\Users\<你>\.dsh\profiles\desktop\vendor\dsh-qq-console-v2"
& $node ".\.selftest\host-load.mjs"
```

## 文件

- `lib/index.js` — 宿主入口、凭据、设置路由、启动/停止
- `lib/catalog.js` — DSH 实时模型目录与 WorkBuddy 缓存目录归一化
- `lib/secure-store.js` — Windows DPAPI 凭据加密/解密
- `lib/gateway.js` — QQ 网关 WebSocket + REST
- `lib/console.js` — 指令路由、任务、排队、状态、模型/权限
- `lib/menu.js` — 底部菜单构建与刷新
- `lib/sessions.js` — DSH 会话/模型/权限窄接口
- `lib/store.js` — 状态落盘（原子写）
- `lib/client.js` — 设置卡片
- `.selftest/v2.mjs` — 离线行为自检
