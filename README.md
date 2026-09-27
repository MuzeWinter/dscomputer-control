# DScomputer-control

**Windows desktop automation for DeepSeek Harness** — the agent gets eyes and hands on the local GUI.

14 tools · pure JS, zero dependencies · brings real keyboard/mouse input, occlusion-proof window screenshots and the accessibility tree into DSH.

## What it does

- **Enumerate** apps and windows (`cua_list_apps`, `cua_list_windows`) → `{app, id, title}`.
- **Look** — `cua_window_state` returns a window screenshot captured with Windows.Graphics.Capture (**works even when the window is covered by others**) plus the accessibility (UIA) tree, which carries `element_index` values for precise targeting.
- **Act** — real input injection, not UI-Automation value writes: `cua_click` (single/double, by element or pixel), `cua_type_text` (CJK included), `cua_press_key` (`Control_L+a`, `Return`, …), `cua_scroll`, `cua_drag` (text selection, sliders, files), `cua_set_value`, `cua_secondary_action`.
- **Launch / focus** — `cua_activate_window`, `cua_launch_app`.
- **Clean exit** — `cua_release` shuts the engine down so its on-screen cursor overlay is torn down and the real pointer returns; an idle timer (`releaseAfterIdleMs`, default 60 s) does the same automatically if a session is left open.

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 x64 |
| Host | DeepSeek Harness Desktop 0.1.x |
| Runtime | The official computer-use runtime (`@oai/sky`) **already installed** on the machine |

This package does **not** ship the engine binary — the runtime comes from the vendor application that provides it. The plugin finds it by **enumerating** the vendor directories under `%LOCALAPPDATA%\OpenAI\` (highest `@oai/sky` version, largest CLI executable), so vendor upgrades that change hash directories keep working without touching the plugin.

No admin rights required.

## Install

From the plugin market, or directly:

```sh
dsh plugin add https://github.com/MuzeWinter/dscomputer-control
```

Then **fully quit and restart DeepSeek Harness** — bundle modules are cached per process, so a restart is what loads the plugin. Changes to the `config` block below are hot-reloaded in a few seconds and do not need a restart.

Manual installation: copy `lib/` and `cordis.patch.yml` into `<profile>/_plugins/dscomputer-control`, expose it in `<profile>/node_modules/`, add `"dscomputer-control"` to `dsh.profile.bundles` in `<profile>/package.json`, and append:

```yaml
- id: dscomputer-control
  name: "dscomputer-control"
  config:
    approval: auto
    releaseAfterAction: false
    releaseAfterIdleMs: 60000
    imageMode: auto
    maxTextChars: 20000
    timeoutMs: 45000
```

The bundled skill (`skill/SKILL.md`) can be copied to `%USERPROFILE%\.dsh\skills\dscomputer-control\SKILL.md`; skills are picked up without a restart and make the model reach for this toolset on GUI tasks.

## Configuration

| key | default | meaning |
|---|---|---|
| `approval` | `auto` | `auto` runs unattended; `allowlist` allows only `approvedApps` matches; `deny` rejects every action deterministically |
| `approvedApps` | `[]` | substrings matched against app title / process name (only with `approval: allowlist`) |
| `imageMode` | `auto` | `auto` attaches the screenshot when the active model accepts images; `text` returns only the tree |
| `releaseAfterAction` | `false` | `true` closes the engine after every action (safest for the pointer, but the overlay only flashes) |
| `releaseAfterIdleMs` | `60000` | auto-release after this much idle time; `0` disables it |
| `maxTextChars` | `20000` | truncation length for the accessibility tree |
| `timeoutMs` | `45000` | per-call timeout (registered with DSH as `timeoutMs + 15000`) |
| `scrollStep` | `3` | step size for direction-based scrolling |

## Tools (14)

`cua_status` · `cua_list_apps` · `cua_list_windows` · `cua_window_state` · `cua_click` · `cua_type_text` · `cua_press_key` · `cua_scroll` · `cua_drag` · `cua_set_value` · `cua_secondary_action` · `cua_activate_window` · `cua_launch_app` · `cua_release`

Usage discipline that saves turns: enumerate first (`{app, id}` are both required), activate before typing, prefer `element_index` over pixels, verify after every action, and release when done.

## Behaviour and caveats

- **Real input injection steals foreground focus.** It activates the target window; it is not suited to silent background work. For value-setting without focus changes, the separate `dsh-click` plugin is a better fit — the two are complementary and can be installed side by side.
- **WinUI / AUMID windows** (Windows 11 Notepad, Windows Terminal) and **elevated windows** are not supported by the engine (`foreground window did not report a process id`, or UIPI blocks the injection). Classic Win32 targets work.
- **Coordinates originate at the client area's top-left**, excluding the title bar.
- **`cua_launch_app`** takes an app id from `cua_list_apps` (or a launchable executable), not a display name.
- The engine's cursor overlay is drawn while controlling; `cua_release` / idle auto-release removes it.

## 中文要点

- 给 DeepSeek Harness 加"看屏幕 + 动手"能力：**14 个工具**，纯 JS、零依赖。
- 枚举应用/窗口 → 窗口截图（**被遮挡也能截**）+ 无障碍树 → 真实输入（点击、输入中文、组合键、滚动、**拖拽**）。
- **需要机器上已装官方电脑控制运行时（`@oai/sky`）**，本包不含引擎二进制；插件按厂商目录**枚举发现**运行时，引擎升级换目录不影响。
- 安装后**必须完全重启 DSH**；改 `config` 会热重载、不用重启。
- 已知边界：WinUI/AUMID 窗口与提权窗口不支持；真实输入会抢前台焦点；坐标以**客户区**左上角为原点。
- 收尾用 `cua_release`（或等 `releaseAfterIdleMs` 自动释放），否则引擎的光标覆盖层会一直盖着鼠标。

## Attribution

The computer-use engine and the `@oai/sky` runtime belong to their vendor and are **not** part of this package. This plugin only locates and loads them in-process on behalf of DSH; it neither ships, copies nor modifies their files.

## License

MIT — covers the plugin code in this repository only.
