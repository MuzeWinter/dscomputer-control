---
name: dscomputer-control
description: 用 DScomputer-control（官方引擎）操作本机 Windows 图形界面。当任务需要"看见屏幕并动手"时使用——打开/操作某个应用、点击按钮或菜单、在界面里输入文字、拖拽（选文字/拖滑块/拖文件）、滚动列表、读取某个窗口的内容或控件树；用户说"帮我在 XX 软件里…""点一下那个按钮""把这个拖过去""看看这个窗口里有什么"时也适用。不适用于纯命令行/文件操作（那用 pwsh / 文件工具更稳）。
---

# DScomputer-control —— 本机 GUI 操作

DSH 里已挂载官方电脑控制引擎（`@oai/sky`），提供 `cua_*` 工具。
**当任务需要操作图形界面时优先用它**，不要让用户手动去点。

## 工具面（14 个）

| 工具 | 用途 |
|---|---|
| `cua_status` | 排障：引擎版本、CLI 路径、审批策略、最近的审批决定 |
| `cua_list_apps` / `cua_list_windows` | 列出应用与窗口，拿 `{app, id, title}` 窗口对象 |
| `cua_window_state` | 窗口**截图**（WGC，被遮挡也能截）+ **无障碍文本树**（含 `element_index`） |
| `cua_click` | 按 `element_index` 或 `x/y` 点击（`click_count: 2` = 双击） |
| `cua_type_text` | 向焦点输入文本（真实键盘注入，支持中文） |
| `cua_press_key` | 组合键：`Control_L+a`、`Return`、`Tab`… |
| `cua_scroll` | 滚动：`direction` 或原始 `scrollX/scrollY` |
| `cua_drag` | **拖拽**：`from_x/from_y` → `to_x/to_y`（选文字/拖滑块/拖文件） |
| `cua_set_value` | 直接替换可编辑元素的值（比逐键输入可靠） |
| `cua_secondary_action` | 无障碍次级动作（Expand/Collapse/ScrollIntoView…） |
| `cua_activate_window` | 把窗口带到前台 |
| `cua_launch_app` | 启动应用（`app` 必须是 `cua_list_apps` 里的 id 或可执行标识） |
| `cua_release` | 结束控制、关闭引擎、恢复真实鼠标 |

## 使用纪律（照做能省很多轮）

1. **先观察**：`cua_list_apps` 或 `cua_list_windows` 拿窗口对象。**窗口对象必须同时含 `app` 和 `id` 两个字段**（只给 id 会被引擎拒绝）。
2. **先激活**：`cua_type_text` / `cua_press_key` 依赖前台窗口，先 `cua_activate_window`。
3. **看清再动**：`cua_window_state` 拿截图 + 无障碍树；优先用树里的 `element_index` 定位（语义精确、不受缩放影响），表达不了才用坐标。
4. ⚠️ **坐标原点 = 客户区左上角**（不含标题栏）。按窗口外框算会整体偏下约一个标题栏高度（实测踩过：拖拽落到列表表头）。
5. **一动作一验证**：改完再 `cua_window_state` 看结果，别连点。
6. **收尾必做**：控制结束调用 `cua_release` —— 否则引擎的光标覆盖层会继续盖着真实鼠标。
7. **能力边界**：WinUI/AUMID 窗口（Win11 记事本 `Microsoft.WindowsNotepad_*`、Windows Terminal）与**提权窗口**不支持（报 `foreground window did not report a process id` 或被 UIPI 拦截）。遇到就改选经典 Win32 应用，或用 `dsh-click` 的 `screen_read`/`type`（UIA 写值路线）。

## 同期可用的互补工具

`dsh-click`（另一套实现）擅长：UIA 写值、不抢前台焦点、`screen_read` 出元素矩形、`screen_find`（OCR）。
两者可混用：官方引擎负责**真实输入注入**（含拖拽），`dsh-click` 负责**无干扰的读取与校验**。

## 审批与安全

默认 `approval: auto`（不再逐个询问）。要收紧就改 profile 的 `cordis.patch.yml`：

```yaml
- id: dscomputer-control
  name: "dscomputer-control"
  config:
    approval: allowlist        # auto | allowlist | deny
    approvedApps: ['记事本']    # 仅 allowlist 生效
    releaseAfterAction: false   # true=每次操作后即关引擎（光标最安全）
    releaseAfterIdleMs: 60000   # 空闲自动释放（默认 60s，0=关闭）
```
