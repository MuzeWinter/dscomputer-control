/**
 * dscomputer-control — 把官方电脑控制引擎接进 DeepSeek Harness。
 *
 * 工具面来自官方 `@oai/sky` 的 Windows 客户端（窗口级 API）：
 *   list_apps / list_windows / get_window_state / activate_window
 *   click / type_text / press_key / scroll / drag / set_value / perform_secondary_action
 *   launch_app
 *
 * 与 `dsh-click` 的分工：后者用 UIA 写值 + PostMessage（不抢前台焦点），
 * 本插件用官方引擎（真实输入注入 + Windows.Graphics.Capture 窗口截图，遮挡也能截），
 * 并且带官方内建的物理 Esc 急停。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadSky, APPROVAL_MODES, resetSky } from './engine.js';

//#region 加载追踪 —— DSH 不落盘插件日志，这里写一个极小追踪文件便于排障
const LOAD_LOG = path.join(process.env.TEMP ?? '.', 'dscomputer-control-load.log');
function trace(message) {
  try {
    fs.appendFileSync(LOAD_LOG, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* 追踪失败绝不影响插件 */
  }
}
trace(`module imported (pid ${process.pid})`);
//#endregion

/** Cordis 插件名。 */
const name = 'dscomputer-control';
/** 只依赖工具注册表；llm / attachments 是可选服务，运行时探测。 */
const inject = ['tools'];

const DEFAULTS = Object.freeze({
  approval: 'auto',
  approvedApps: [],
  imageMode: 'auto',
  // 默认 false = 控制期间保持引擎存活，横幅稳定显示（用户要看得见"谁在控制"）。
  // 光标安全由空闲自动释放兜底；需要"每次都收干净"可设 true。
  releaseAfterAction: false,
  // 空闲自动释放：最后一次 cua_* 调用后 N 毫秒内没有新调用 → 关闭引擎、收起覆盖层、
  // 恢复真实鼠标。0 = 关闭该兜底（此时务必显式 cua_release）。
  releaseAfterIdleMs: 60000,
  maxTextChars: 20000,
  timeoutMs: 45000,
  scrollStep: 3,
});

function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) };
  if (!APPROVAL_MODES.includes(merged.approval)) merged.approval = DEFAULTS.approval;
  if (!Array.isArray(merged.approvedApps)) merged.approvedApps = [];
  if (typeof merged.releaseAfterAction !== 'boolean') merged.releaseAfterAction = DEFAULTS.releaseAfterAction;
  if (!Number.isFinite(merged.releaseAfterIdleMs) || merged.releaseAfterIdleMs < 0) {
    merged.releaseAfterIdleMs = DEFAULTS.releaseAfterIdleMs;
  }
  if (!Number.isFinite(merged.maxTextChars) || merged.maxTextChars < 1000) merged.maxTextChars = DEFAULTS.maxTextChars;
  if (!Number.isFinite(merged.timeoutMs) || merged.timeoutMs < 5000) merged.timeoutMs = DEFAULTS.timeoutMs;
  if (!Number.isFinite(merged.scrollStep) || merged.scrollStep === 0) merged.scrollStep = DEFAULTS.scrollStep;
  return merged;
}

//#region 通用工具函数

const WINDOW_FIELDS = {
  id: { type: 'integer', description: '窗口 id（来自 cua_list_apps / cua_list_windows）。' },
  app: { type: 'string', description: '应用标识（来自 cua_list_apps 的 app 字段）。' },
  title: { type: 'string', description: '窗口标题（可选）。' },
};

/** 目标窗口参数：既接受整个窗口对象，也接受 windowId + app 的扁平写法。 */
const WINDOW_PARAMS = {
  window: {
    type: 'object',
    additionalProperties: false,
    properties: WINDOW_FIELDS,
    required: ['id'],
    description: 'cua_list_apps 返回的窗口对象原样传回即可。',
  },
  windowId: { type: 'integer', description: '窗口 id 的扁平写法（与 app 搭配）。' },
  app: { type: 'string', description: '应用标识的扁平写法。' },
  title: { type: 'string', description: '窗口标题的扁平写法（可选）。' },
};

function resolveWindow(args) {
  const raw = args?.window;
  if (raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw)) {
    if (!Number.isInteger(raw.id)) throw new Error('window.id 必须是整数（取自 cua_list_apps）');
    return { ...raw };
  }
  if (Number.isInteger(args?.windowId)) {
    const win = { id: args.windowId };
    if (typeof args.app === 'string' && args.app !== '') win.app = args.app;
    if (typeof args.title === 'string' && args.title !== '') win.title = args.title;
    return win;
  }
  throw new Error('缺少目标窗口：请传 window（cua_list_apps 的窗口对象）或 windowId');
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}\n…（已截断，共 ${value.length} 字符）`;
}

/**
 * DSH 要求工具返回值是**无损 JSON**（`snapshotJsonValue` 会校验，失败时报
 * "returned invalid output: value is not lossless JSON"）。
 * 这里递归丢弃 undefined / 函数 / 二进制（Buffer、TypedArray）—— 引擎返回的
 * 无障碍字段经常带 undefined，截图附件对象里则可能带 Buffer。
 */
function jsonSafe(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(jsonSafe).filter((item) => item !== undefined);
  if (type === 'object') {
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return undefined;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }
  return undefined; // function / symbol
}

/**
 * 把 `attachments.saveImage()` 的返回投影成 JSON 无损的**附件引用**。
 * 附件对象可能含 Buffer 等字段；DSH 的图片块只需要这几项标量。
 */
function imageRef(image) {
  if (image === null || image === undefined || typeof image !== 'object') return undefined;
  const out = {};
  for (const key of ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name']) {
    const value = image[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function decodeDataUrl(url) {
  const matched = /^data:([^;,]+);base64,(.*)$/s.exec(String(url ?? ''));
  if (matched === null) return undefined;
  try {
    return { mediaType: matched[1], data: Buffer.from(matched[2], 'base64') };
  } catch {
    return undefined;
  }
}

const EXT_BY_MEDIA = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 从 get_window_state 的返回里取第一张截图并解码成字节。 */
function screenshotPayload(state) {
  if (state === null || typeof state !== 'object') return undefined;
  const list = Array.isArray(state.screenshots) ? state.screenshots : [];
  const shot = state.screenshot ?? list[0];
  if (shot === null || shot === undefined) return undefined;
  const direct = decodeDataUrl(typeof shot === 'string' ? shot : (shot.url ?? shot.data_url));
  if (direct !== undefined) return direct;
  if (shot.bytes !== undefined) {
    try {
      return { mediaType: 'image/png', data: Buffer.from(shot.bytes) };
    } catch {
      return undefined;
    }
  }
  if (typeof shot.filepath === 'string' && fs.existsSync(shot.filepath)) {
    const mediaType = `image/${path.extname(shot.filepath).slice(1).replace('jpg', 'jpeg') || 'png'}`;
    try {
      return { mediaType, data: fs.readFileSync(shot.filepath) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 当前会话模型是否声明了图像输入能力（照抄 dsh-click 的判定方式）。 */
async function sessionAcceptsImages(agent, ctx, signal) {
  if (agent === undefined) return false;
  const provider = agent.options?.provider;
  const model = agent.options?.model;
  if (provider === undefined || model === undefined) return false;
  const llm = ctx.get('llm');
  if (llm === undefined) return false;
  try {
    const info = await llm.resolveModelInfo(provider, model, signal);
    return info?.inputModalities?.includes('image') ?? false;
  } catch {
    return false;
  }
}

/** 把截图存进 DSH 附件库，返回可放进 `content` 的图片块载荷。 */
async function saveScreenshot(ctx, exec, config, state) {
  if (config.imageMode === 'text') return undefined;
  const attachments = ctx.get('attachments');
  if (attachments === undefined) return undefined;
  if (!(await sessionAcceptsImages(exec?.agent, ctx, exec?.signal))) return undefined;
  const payload = screenshotPayload(state);
  if (payload === undefined) return undefined;
  try {
    return await attachments.saveImage({
      data: payload.data,
      mediaType: payload.mediaType,
      name: `cua-${Date.now().toString(36)}.${EXT_BY_MEDIA[payload.mediaType] ?? 'png'}`,
    });
  } catch {
    return undefined;
  }
}

/** 事件/结果里的窗口摘要行。 */
function windowLine(win, fallback) {
  const id = win?.id ?? fallback?.id;
  const label = win?.title || fallback?.title || win?.app || fallback?.app || '(未知窗口)';
  return `windowId ${id ?? '?'} — ${label}`;
}

/** 把执行结果渲染成文本块（窗口状态工具另有专用渲染）。 */
function renderText(value, maxChars) {
  if (value === null || typeof value !== 'object') {
    return [{ type: 'text', text: String(value) }];
  }
  const { image, ...rest } = value;
  const text = typeof rest.text === 'string' ? rest.text : JSON.stringify(rest, null, 2);
  const blocks = [{ type: 'text', text: truncate(text, maxChars) }];
  if (image !== undefined) blocks.push({ type: 'image', attachment: image });
  return blocks;
}

//#endregion

/** 构造全部工具定义。 */
function buildTools(config, client, ctx, resetClient, lifecycle) {
  const call = async () => (await client()).sky;

  /**
   * 结束控制、释放引擎。
   *
   * 官方引擎在操作期间会绘制一层"光标覆盖层"（真实光标被它盖住），只有**正常结束**
   * 才会收起覆盖层并恢复真实鼠标 —— 否则用户会看到"鼠标漂了、找不到鼠标"。
   *
   * ⚠️ `close()` 是**终态**：关闭后客户端再请求会报
   * `Windows computer-use client is closed`（实测踩到）。因此释放后必须同时丢弃
   * 引擎层与插件层的缓存，让下一次工具调用重新构造客户端并重新 spawn 引擎。
   */
  const release = async (force = false) => {
    if (!force && config.releaseAfterAction !== true) {
      return { released: false, reason: 'releaseAfterAction=false' };
    }
    stopIdleTimer();
    sessionActive = false;
    try {
      const { sky } = await client();
      const closer = sky?.close ?? sky?.closeTransport;
      if (typeof closer !== 'function') return { released: false, reason: '客户端未暴露 close/closeTransport' };
      await closer.call(sky);
      resetSky();
      resetClient();
      trace('engine released (overlay/cursor restored; client discarded)');
      return { released: true };
    } catch (error) {
      resetSky();
      resetClient();
      trace(`engine release failed: ${error?.message ?? error}`);
      return { released: false, reason: String(error?.message ?? error) };
    }
  };

  //#region 空闲自动释放兜底
  // 横幅需要"控制期间稳定显示"（releaseAfterAction=false），但如果 Agent 忘了收尾，
  // 引擎的光标覆盖层会一直盖着真实鼠标 —— 正是用户抱怨的"鼠标漂了、找不到鼠标"。
  // 所以在最后一次调用后起一个定时器：空闲超过 releaseAfterIdleMs 就自动收干净。
  let sessionActive = false;
  let idleTimer;

  const stopIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const scheduleIdleRelease = () => {
    sessionActive = true;
    if (!(config.releaseAfterIdleMs > 0)) return;
    stopIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (!sessionActive) return;
      sessionActive = false;
      trace(`idle ${config.releaseAfterIdleMs}ms → auto release`);
      void release(true);
    }, config.releaseAfterIdleMs);
    if (typeof idleTimer?.unref === 'function') idleTimer.unref();
  };
  //#endregion

  // 交给 apply：插件卸载时停掉定时器，避免悬挂
  if (lifecycle !== undefined) {
    lifecycle.stop = stopIdleTimer;
  }

  /** 只读工具：直接返回结果。 */
  const readTool = ({ toolName, description, parameters, run, render }) => ({
    name: toolName,
    description,
    parameters,
    timeoutMs: config.timeoutMs + 15000,
    // DSH 的 ctx.tools.register() 要求 output { schema, render }：
    // schema 会在注册时被 assertSupportedJsonSchema 校验、并在执行后用于校验返回值，
    // 这里用最小的对象根（放开额外字段），具体呈现交给 render。
    output: {
      schema: { type: 'object' },
      render: render ?? ((_args, value) => renderText(value, config.maxTextChars)),
    },
    async execute(args, exec) {
      const sky = await call();
      try {
        return await run(sky, args, exec);
      } finally {
        // 每次调用都重置空闲计时：控制期间引擎/横幅持续存活，停止控制后自动收尾
        scheduleIdleRelease();
      }
    },
  });

  /** 变更性工具：统一包一层错误处理，返回 ok/false 加原因。 */
  const actTool = ({ toolName, description, parameters, run }) =>
    readTool({
      toolName,
      description,
      parameters,
      async run(sky, args, exec) {
        const win = resolveWindow(args);
        try {
          const extra = await run(sky, args, exec, win);
          return jsonSafe({ ok: true, window: win, ...(extra ?? {}) }) ?? { ok: true, window: win };
        } catch (error) {
          return jsonSafe({ ok: false, window: win, error: String(error?.message ?? error) })
            ?? { ok: false, window: win };
        } finally {
          // 每次变更性操作后收干净引擎，避免光标覆盖层残留
          await release();
        }
      },
    });

  return [
    readTool({
      toolName: 'cua_status',
      description:
        '查看 DScomputer-control 引擎的接入状态：@oai/sky 版本与目录、引擎 CLI 路径、审批策略、最近的审批决定。排障时先用它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const { info } = await client();
        const latest = info.decisions.slice(-5);
        return {
          skyVersion: info.skyVersion,
          skyDir: info.skyDir,
          clientPath: info.clientPath,
          cliPath: info.cliPath,
          approval: info.approval,
          approvedApps: info.approvedApps,
          releaseAfterAction: config.releaseAfterAction,
          loadedAt: info.loadedAt,
          engineTransport: 'helper(stdio JSONL, 自 spawn 引擎进程)',
          approvalsSeen: info.decisions.length,
          lastDecisions: latest,
        };
      },
    }),

    readTool({
      toolName: 'cua_release',
      description:
        '结束本轮电脑控制：关闭官方引擎进程，立即收起它的光标覆盖层并恢复真实鼠标。'
        + 'GUI 操作做完后建议调用一次（默认配置 releaseAfterAction=true 时，每次变更性操作后也会自动调用）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const result = await release(true);
        return { ok: result.released === true, ...result };
      },
    }),

    readTool({
      toolName: 'cua_list_apps',
      description:
        '列出可被官方引擎操作的桌面应用及其窗口（id/app/title）。这是所有操作的第一步：拿到窗口对象后再调用 cua_window_state / cua_click 等。只读，不需要审批。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run(sky) {
        const apps = await sky.list_apps();
        const compact = (Array.isArray(apps) ? apps : []).map((app) => ({
          id: app?.id,
          displayName: app?.displayName,
          isRunning: app?.isRunning,
          windows: (app?.windows ?? []).map((win) => ({ app: win?.app, id: win?.id, title: win?.title })),
        }));
        return { count: compact.length, apps: compact };
      },
    }),

    readTool({
      toolName: 'cua_list_windows',
      description: '仅列出窗口（不含应用分组）。只读，不需要审批。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run(sky) {
        const windows = await sky.list_windows();
        return { count: Array.isArray(windows) ? windows.length : 0, windows };
      },
    }),

    readTool({
      toolName: 'cua_window_state',
      description:
        '读取某个窗口的当前状态：截图（Windows.Graphics.Capture，窗口被遮挡也能截）+ 无障碍文本树（含可点击元素的 element_index）。'
        + '截图会作为图片直接附在结果里；操作前先调用它，之后的 click/set_value 用其中的 element_index 定位。'
        + '首次读取返回完整树，之后返回与上次的差异。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_PARAMS,
          include_text: { type: 'boolean', description: '是否返回无障碍文本树，默认 true。' },
          include_screenshot: { type: 'boolean', description: '是否返回截图，默认 true。' },
        },
      },
      // 必须接收 exec：saveScreenshot 要用 exec.agent 判断当前模型是否收图
      async run(sky, args, exec) {
        const win = resolveWindow(args);
        const includeText = args.include_text ?? true;
        const includeShot = args.include_screenshot ?? true;
        if (includeText !== true && includeShot !== true) {
          throw new Error('include_text 与 include_screenshot 至少要有一个为 true');
        }
        const state = await sky.get_window_state({
          window: win,
          include_text: includeText,
          include_screenshot: includeShot,
        });
        const a11y = state?.accessibility ?? {};
        const text = typeof state?.text === 'string'
          ? state.text
          : (typeof a11y.tree === 'string' ? a11y.tree : JSON.stringify(a11y, null, 2));
        // 附件对象可能含 Buffer，必须投影成 JSON 无损的引用；无障碍字段常带 undefined。
        // 整体过一遍 jsonSafe 才满足 DSH 的"无损 JSON"要求。
        const saved = includeShot ? await saveScreenshot(ctx, exec, config, state) : undefined;
        const image = imageRef(saved);
        const shotCount = Array.isArray(state?.screenshots)
          ? state.screenshots.length
          : (state?.screenshot ? 1 : 0);
        return jsonSafe({
          window: state?.window ?? win,
          text,
          focusedElement: a11y.focused_element,
          selectedText: a11y.selected_text,
          documentText: a11y.document_text,
          screenshotCount: shotCount,
          imageAttached: image !== undefined,
          image,
        }) ?? { window: win, text, screenshotCount: shotCount, imageAttached: false };
      },
      render(_args, value) {
        const head = `窗口状态：${windowLine(value.window)}`
          + `\n截图：${value.imageAttached ? '已作为图片附上' : '未附（模型不支持图像、imageMode=text 或附件服务不可用）'}`;
        const blocks = [{ type: 'text', text: truncate(`${head}\n\n${value.text ?? ''}`, config.maxTextChars) }];
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    }),

    actTool({
      toolName: 'cua_click',
      description:
        '在窗口内点击：用 element_index（来自 cua_window_state 的文本树）或 x/y（相对窗口截图的坐标）。'
        + 'click_count=2 即双击。需要该应用的审批。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_PARAMS,
          element_index: { type: 'integer', description: '无障碍树里的元素索引（与 x/y 二选一）。' },
          x: { type: 'integer', description: '窗口截图内 X 坐标。' },
          y: { type: 'integer', description: '窗口截图内 Y 坐标。' },
          click_count: { type: 'integer', description: '点击次数，默认 1（2=双击）。' },
          mouse_button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键，默认 left。' },
        },
      },
      async run(sky, args, _exec, win) {
        const input = { window: win };
        if (Number.isInteger(args.element_index)) input.element_index = args.element_index;
        if (Number.isInteger(args.x)) input.x = args.x;
        if (Number.isInteger(args.y)) input.y = args.y;
        if (Number.isInteger(args.click_count)) input.click_count = args.click_count;
        if (typeof args.mouse_button === 'string') input.mouse_button = args.mouse_button;
        if (input.element_index === undefined && (input.x === undefined || input.y === undefined)) {
          throw new Error('需要 element_index，或同时给出 x 与 y');
        }
        await sky.click(input);
        return { target: input.element_index !== undefined ? `element_index=${input.element_index}` : `(${input.x},${input.y})` };
      },
    }),

    actTool({
      toolName: 'cua_type_text',
      description: '向窗口当前焦点输入文本（官方真实输入注入，支持中文）。需要该应用的审批。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { ...WINDOW_PARAMS, text: { type: 'string', description: '要输入的文本。' } },
        required: ['text'],
      },
      async run(sky, args, _exec, win) {
        await sky.type_text({ window: win, text: String(args.text) });
        return { typed: String(args.text).length };
      },
    }),

    actTool({
      toolName: 'cua_press_key',
      description:
        '在窗口内按键盘组合键，使用 X keysym 风格：`a`、`Return`、`Tab`、`Control_L+a`（也接受 Control/Ctrl/Alt/Shift 等别名）。需要该应用的审批。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { ...WINDOW_PARAMS, key: { type: 'string', description: '按键或 + 连接的组合键。' } },
        required: ['key'],
      },
      async run(sky, args, _exec, win) {
        await sky.press_key({ window: win, key: String(args.key) });
        return { keys: String(args.key) };
      },
    }),

    actTool({
      toolName: 'cua_scroll',
      description:
        '在窗口内滚动。可用 direction（up/down/left/right，按 scrollStep 换算）或直接给 scrollX/scrollY 原始值；'
        + '坐标 x/y 可选（相对窗口截图）。需要该应用的审批。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_PARAMS,
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向（与 scrollX/scrollY 二选一）。' },
          scrollX: { type: 'integer', description: '横向滚动原始值。' },
          scrollY: { type: 'integer', description: '纵向滚动原始值（负数通常向下）。' },
          x: { type: 'integer', description: '滚动原点 X（可选）。' },
          y: { type: 'integer', description: '滚动原点 Y（可选）。' },
        },
      },
      async run(sky, args, _exec, win) {
        const step = config.scrollStep;
        const input = { window: win };
        if (typeof args.direction === 'string') {
          const map = { down: { scrollY: -step }, up: { scrollY: step }, right: { scrollX: step }, left: { scrollX: -step } };
          Object.assign(input, map[args.direction] ?? {});
        }
        if (Number.isInteger(args.scrollX)) input.scrollX = args.scrollX;
        if (Number.isInteger(args.scrollY)) input.scrollY = args.scrollY;
        if (Number.isInteger(args.x)) input.x = args.x;
        if (Number.isInteger(args.y)) input.y = args.y;
        if (input.scrollX === undefined && input.scrollY === undefined) {
          throw new Error('需要 direction，或 scrollX/scrollY 之一');
        }
        await sky.scroll(input);
        return jsonSafe({ scrollX: input.scrollX, scrollY: input.scrollY }) ?? {};
      },
    }),

    actTool({
      toolName: 'cua_drag',
      description: '在窗口内拖拽：从 (from_x,from_y) 拖到 (to_x,to_y)，坐标相对窗口截图（用于选中文字、拖动滑块/文件）。需要该应用的审批。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_PARAMS,
          from_x: { type: 'integer' },
          from_y: { type: 'integer' },
          to_x: { type: 'integer' },
          to_y: { type: 'integer' },
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y'],
      },
      async run(sky, args, _exec, win) {
        await sky.drag({
          window: win,
          from_x: args.from_x,
          from_y: args.from_y,
          to_x: args.to_x,
          to_y: args.to_y,
        });
        return { drag: `(${args.from_x},${args.from_y}) -> (${args.to_x},${args.to_y})` };
      },
    }),

    actTool({
      toolName: 'cua_set_value',
      description: '直接替换某个可编辑元素的值（比逐键输入更可靠）。element_index 来自 cua_window_state。需要该应用的审批。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_PARAMS,
          element_index: { type: 'integer', description: '可编辑元素的索引。' },
          value: { type: 'string', description: '新的值。' },
        },
        required: ['element_index', 'value'],
      },
      async run(sky, args, _exec, win) {
        await sky.set_value({ window: win, element_index: args.element_index, value: String(args.value) });
        return { element_index: args.element_index, length: String(args.value).length };
      },
    }),

    actTool({
      toolName: 'cua_secondary_action',
      description: '对某个元素调用无障碍次级动作（如 Expand/Collapse/ScrollIntoView/Switch）。action 名与 element_index 来自 cua_window_state。需要该应用的审批。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_PARAMS,
          element_index: { type: 'integer' },
          action: { type: 'string', description: '无障碍动作名。' },
        },
        required: ['element_index', 'action'],
      },
      async run(sky, args, _exec, win) {
        await sky.perform_secondary_action({ window: win, element_index: args.element_index, action: String(args.action) });
        return { element_index: args.element_index, action: String(args.action) };
      },
    }),

    actTool({
      toolName: 'cua_activate_window',
      description: '把窗口带到前台并聚焦（注意：其余操作通常不需要它，官方引擎可直接在后台操作窗口）。需要该应用的审批。',
      parameters: { type: 'object', additionalProperties: false, properties: { ...WINDOW_PARAMS } },
      async run(sky, _args, _exec, win) {
        await sky.activate_window({ window: win });
        return { activated: true };
      },
    }),

    readTool({
      toolName: 'cua_launch_app',
      description: '启动一个应用（app 标识来自 cua_list_apps 的 id/displayName）。只读工具，但引擎可能就应用访问发起审批。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { app: { type: 'string', description: '应用标识或显示名。' } },
        required: ['app'],
      },
      async run(sky, args) {
        try {
          await sky.launch_app({ app: String(args.app) });
          return { ok: true, app: String(args.app) };
        } catch (error) {
          return { ok: false, app: String(args.app), error: String(error?.message ?? error) };
        }
      },
    }),
  ];
}

/**
 * Cordis 入口。
 * @param {object} ctx 插件上下文（需要 tools 服务）。
 * @param {object} [config] profile patch 中的 config。
 */
function apply(ctx, config) {
  try {
    const resolved = resolveConfig(config);
    let clientPromise;
    // 不得缓存一个 rejected promise：否则一次瞬时失败（引擎缺失、spawn 失败、
    // 运行时被引擎升级换目录等）会让插件此后永久失效。失败即清空，下次重试。
    const client = () => {
      if (clientPromise === undefined) {
        clientPromise = loadSky(resolved, ctx.logger).catch((error) => {
          clientPromise = undefined;
          trace(`loadSky FAILED: ${error?.stack ?? error}`);
          throw error;
        });
      }
      return clientPromise;
    };

    // 释放引擎后必须丢弃客户端缓存（close() 是终态），下次工具调用会重建
    const resetClient = () => { clientPromise = undefined; };

    // 生命周期钩子：buildTools 会把"空闲计时器停止"回调塞进来
    const lifecycle = { stop: () => {} };

    const tools = buildTools(resolved, client, ctx, resetClient, lifecycle);
    for (const tool of tools) {
      ctx.effect(() => ctx.tools.register(tool), `${name}: ${tool.name} tool`);
    }

    // 向系统提示注入能力声明 —— 工具只在工具表里"被动可见"，模型未必会主动想起；
    // 注入一行说明后，遇到 GUI 类任务会自己选这套工具（无需用户点名）。
    const prompt = ctx.get?.('systemPrompt');
    if (prompt !== undefined && typeof prompt.section === 'function') {
      ctx.effect(() => prompt.section({
        name: 'dsh:dscomputer-control',
        order: 9900,
        text: () => (resolved.approval === 'deny'
          ? ''
          : '[DScomputer-control] 已挂载官方引擎的桌面工具（cua_*）：可以看屏幕并在本机 Windows 图形界面里动手。'
            + '任务需要在 GUI 应用里操作时直接用它，不要让用户手动点：'
            + '先 cua_list_apps / cua_list_windows 取窗口对象（必须同时含 app 与 id）→ '
            + 'cua_activate_window 置前台 → 用 cua_window_state 的截图与元素索引定位（坐标以**客户区**左上角为原点，不含标题栏）→ '
            + 'cua_click / cua_type_text / cua_press_key / cua_scroll / cua_drag / cua_set_value 执行 → 再 cua_window_state 验证。'
            + '控制结束调用 cua_release 收尾（关闭引擎、恢复真实鼠标）。'
            + 'WinUI/AUMID 窗口（Win11 记事本、Windows Terminal）与提权窗口不支持，遇到就换经典 Win32 应用。'),
      }), `${name}: system prompt`);
    }
    // 插件卸载时关闭引擎子进程，避免留下孤儿。
    ctx.effect(() => () => {
      lifecycle.stop(); // 卸载时停掉空闲计时器，避免悬挂
      if (clientPromise === undefined) return;
      void clientPromise
        .then(({ sky }) => sky?.close?.() ?? sky?.closeTransport?.())
        .catch(() => {});
    }, `${name}: engine lifecycle`);

    ctx.logger?.info?.(
      `[${name}] 已挂载 ${tools.length} 个工具（审批=${resolved.approval}，imageMode=${resolved.imageMode}，`
      + `releaseAfterAction=${resolved.releaseAfterAction}，idle=${resolved.releaseAfterIdleMs}ms）`,
    );
    trace(`apply ok: ${tools.length} tools, approval=${resolved.approval},`
      + ` releaseAfterAction=${resolved.releaseAfterAction}, idle=${resolved.releaseAfterIdleMs}`);
  } catch (error) {
    trace(`apply FAILED: ${error?.stack ?? error}`);
    throw error;
  }
}

export { name, inject, apply };
