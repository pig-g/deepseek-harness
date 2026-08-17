# @deepseek-ai/dsh-command-shell

[English](README.md) | 中文

面向用户的 `/cmd` 原始 shell 命令，运行在 [`ctx.shell`](../../shell/shell/README.md) 执行期 seam 之上。
该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一条全局命令，因此每个已组合的命令适配器都能发现它；随附的 Web 客户端会将其作为前导输入的 slash 命令执行，无需模型轮次。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/cmd <shell command>` | 运行一条 shell 命令，并渲染捕获到的 stdout、stderr 与退出事实。 |
| `/cmd` | 直接返回用法错误。仅含空白被视为空输入。 |

会丢弃首尾空白；其余文本原样传递给执行器。命令在接收会话的工作目录下、在该会话当前的沙箱策略内运行；非零退出、信号终止、超时或沙箱拒绝都作为普通结果——`command/done` 以 `kind: 'success'` 结算并携带渲染文本。只有尚未产出结果就抛错（例如沙箱运行器不可用）才以 `kind: 'error'` 结算。

## 安全姿态

`/cmd` 是一个原始 shell 逃生口：它绕过模型，所以命令中的任何内容都不会被解释、概括或由 agent 把关。因此它刻意保守：

- **在会话当前的沙箱策略下运行。** 处理器通过 [`ctx.sandboxPolicy`](../../sandbox/sandbox-policy/README.md) 解析接收会话的策略（其模式与工作区边界）并传递给执行器，因此写到工作区之外的命令会像模型驱动的工具调用一样被拒绝。不会提供任何升级：没有审批提示，也没有更宽的模式。拒绝会在结果中报告。
- **无逐命令审批。** 人类已显式输入该命令；当前策略就是闸门。希望逐命令提示的部署不应暴露此命令。
- **无模型轮次。** 命令及其输出永不进入模型请求、`deriveMessages()` 或 surface——它们只是仅记日志的 `command/run` / `command/done` 簿记，外加渲染出的 UI 结果。

## 模型体验

### 人类 `/cmd` 捕获

#### 模型看到什么

什么也没有。slash 输入、执行的命令与渲染输出都不在模型请求中。命令生命周期事件仅记日志，且不带 `surfaceOp`，因此永不进入 `deriveMessages()` 或系统提示。在一轮内运行 `/cmd` 不会改变该轮后续请求。

#### Token 影响

零直接 token 影响。无论一次完成的运行还是一次用法错误，都不会增加模型 token。

#### KV 缓存影响

与模型请求路径无关。命令不会向 provider 请求写入任何内容，因此可复用的请求前缀不受影响。

## 组合

生产者注入 `commands` 与 `shell`；通过 `ctx.get` 读取可选的 `sandboxPolicy` 服务。自定义应用挂载注册表、一个 shell 执行器和本插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
- id: command-shell
  name: '@deepseek-ai/dsh-command-shell'
```

随附的 `dsh` base 在非 Windows 主机上挂载此命令（仅限 bash，因此与 `tool-bash` 的 win32 门控一致）；它没有配置。Web 客户端通过命令适配器暴露它；headless、ACP 自动化与 JSON-RPC 不提供命令适配器，因此不会暴露它。

## 已知限制与后续工作

- **无升级路径**——被当前沙箱策略拒绝的命令会报告为拒绝，没有审批提示或更宽模式的重试。模型面向的 bash 工具负责升级；此原始命令刻意不提供。
- **捕获上限继承自执行器**——长输出由执行器的输出预算限定，渲染结果中再在每流 4000 字节处截断，因此非常冗长的命令会显示尾部标记而非完整流。
- **不支持后台执行**——`/cmd` 仅前台运行；长运行命令会阻塞命令调用直到执行器超时。后台任务请使用模型驱动的 bash 工具。
- **在随附入口中仅 Web 可用**——headless、ACP 与 JSON-RPC 不提供命令适配器，因此 `/cmd` 在那里不可用。
