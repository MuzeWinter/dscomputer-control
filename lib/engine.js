/**
 * dscomputer-control — 引擎发现与加载层。
 *
 * 本模块负责把 **本机已安装的官方电脑控制引擎** 接进 DSH：
 *
 *   1. 定位 `@oai/sky`（官方客户端 + 引擎二进制随它一起分发）。
 *      运行时布局为 `<厂商目录>\runtimes\cua_node\<hash>\bin\node_modules\@oai\sky`。
 *      本模块**枚举** `%LOCALAPPDATA%\OpenAI\` 下的厂商目录来发现它，不写死任何名字。
 *   2. 定位引擎 CLI（引擎会另起它的 app-server 子进程；找不到就报 "program not found"）。
 *      取 `<厂商目录>\bin\<hash>\` 下体积最大的可执行文件，并把它的目录加入 PATH。
 *   3. 补上引擎宿主才会提供的那一个接缝：审批回调。
 *      DSH 里没有 `globalThis.nodeRepl`，官方客户端因此自动改走
 *      「自己 spawn 引擎进程 + stdio(JSONL)」的传输层；
 *      唯一缺的是审批函数，它按 `globalThis.nodeRepl?.config?.createElicitation`
 *      查找——这里补一个最小 shim，只挂 config，**不设置**
 *      `env.SKY_CUA_NATIVE_PIPE`，以免被误判为引擎宿主的命名管道模式。
 *
 * 因此本插件既不复制引擎、也不改引擎自己的文件，只是在 DSH 进程内借用它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 审批回调允许的三种策略。 */
export const APPROVAL_MODES = Object.freeze(['auto', 'allowlist', 'deny']);

const localAppData = () =>
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');

/**
 * 引擎运行时的候选厂商目录（枚举，不写死名字）。
 * 布局约定：`<厂商>\runtimes\cua_node\<hash>\...` 与 `<厂商>\bin\<hash>\...`
 */
export function engineRoots() {
  return listDirs(path.join(localAppData(), 'OpenAI'));
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** 点分版本号比较；非数字段按 0 处理。 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 找到引擎运行时里的 `@oai/sky` 包。
 * 运行时升级会更换 `runtimes\cua_node\<hash>` 目录，因此这里按目录枚举并取
 * 版本最高（同版本取最新）的一份，而不是写死 hash；厂商目录同理枚举。
 * @param {string} [root] 指定单个厂商目录（便于测试注入）；省略则自动枚举。
 * @returns {{dir: string, version: string, mtime: number} | undefined}
 */
export function findSkyPackage(root) {
  const roots = root === undefined ? engineRoots() : [root];
  const found = [];
  for (const r of roots) {
    for (const runtime of listDirs(path.join(r, 'runtimes', 'cua_node'))) {
      const manifestPath = path.join(runtime, 'bin', 'node_modules', '@oai', 'sky', 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        found.push({
          dir: path.dirname(manifestPath),
          version: manifest.version ?? '0.0.0',
          mtime: fs.statSync(manifestPath).mtimeMs,
        });
      } catch {
        /* 损坏的运行时不影响其它候选 */
      }
    }
  }
  if (found.length === 0) return undefined;
  found.sort((a, b) => compareVersions(b.version, a.version) || b.mtime - a.mtime);
  return found[0];
}

/**
 * 找到引擎 CLI 可执行文件（引擎用它另起 app-server 子进程）。
 * 不写死文件名：取 `<厂商>\bin\<hash>\` 下体积最大的可执行文件。
 * @param {string} [root] 指定单个厂商目录；省略则自动枚举。
 * @returns {string | undefined}
 */
export function findEngineCli(root) {
  const roots = root === undefined ? engineRoots() : [root];
  const found = [];
  for (const r of roots) {
    for (const dir of listDirs(path.join(r, 'bin'))) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.exe')) continue;
        const exe = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(exe);
          found.push({ exe, size: stat.size, mtime: stat.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  }
  found.sort((a, b) => b.size - a.size || b.mtime - a.mtime);
  return found[0]?.exe;
}

/** 解析包的 ESM 入口：exports["."] → module/main → 已知路径。 */
function resolveClientEntry(pkgDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const dot = manifest.exports?.['.'];
  const rel =
    (typeof dot === 'string' ? dot : dot?.default) ??
    manifest.module ??
    manifest.main ??
    'dist/project/cua/sky_js/src/index.js';
  return path.join(pkgDir, rel);
}

/**
 * 依据请求与配置给出审批结论（纯函数，便于单测）。
 *
 * 引擎发来的请求形如
 * `{ message: '<引擎生成的授权询问>', meta: { tool_params: { app }, tool_params_display: [{ value }] } }`。
 * @param {object} request 引擎的 approvalRequest。
 * @param {{approval?: string, approvedApps?: string[]}} config 插件配置。
 * @returns {{action: 'accept'|'reject', app: string, reason: string}}
 */
export function decideApproval(request, config = {}) {
  const meta = request?.meta ?? {};
  const app = String(meta?.tool_params?.app ?? '');
  const display = String(meta?.tool_params_display?.[0]?.value ?? app ?? '');
  const mode = APPROVAL_MODES.includes(config.approval) ? config.approval : 'auto';
  if (mode === 'deny') return { action: 'reject', app: display, reason: 'approval=deny' };
  if (mode === 'auto') return { action: 'accept', app: display, reason: 'approval=auto' };
  const needles = Array.isArray(config.approvedApps) ? config.approvedApps : [];
  const hit = needles.find((needle) => {
    const text = String(needle).trim().toLowerCase();
    if (text === '') return false;
    return app.toLowerCase().includes(text) || display.toLowerCase().includes(text);
  });
  return hit !== undefined
    ? { action: 'accept', app: display, reason: `allowlist:${String(hit)}` }
    : { action: 'reject', app: display, reason: 'not in approvedApps' };
}

/**
 * 安装审批 shim。
 *
 * 官方传输层的查找逻辑（helper_transport.js 的 `D`）等价于：
 *     const nodeRepl = globalThis.nodeRepl;
 *     const r = nodeRepl?.config == null ? undefined : nodeRepl;   // config 只作存在性门禁
 *     const elicitation = customElicitation ?? r?.createElicitation;
 * 即**回调挂载在 `nodeRepl` 顶层**，`config` 只是个门禁 —— 这与官方
 * `computer-use-client.mjs` 里 `globalThis.nodeRepl?.createElicitation` 的写法一致。
 * 这里两处都挂，兼容不同版本的读法；并刻意不设置 `env.SKY_CUA_NATIVE_PIPE`，
 * 让客户端走 helper(stdio) 自我 spawn 路径。
 */
function installApprovalShim(createElicitation) {
  const existing = globalThis.nodeRepl;
  const shim = existing !== null && typeof existing === 'object' ? existing : {};
  if (shim.env === null || typeof shim.env !== 'object') shim.env = {};
  if (shim.config === null || typeof shim.config !== 'object') shim.config = {};
  shim.createElicitation = createElicitation; // ← 实际查找位置（顶层）
  shim.config.createElicitation = createElicitation; // 兼容另一种读法
  globalThis.nodeRepl = shim;
  return shim;
}

let cached;

/**
 * 丢弃已缓存的客户端。
 *
 * `close()` 是**终态**：客户端一旦关闭，再请求会报
 * `Windows computer-use client is closed`。所以"释放引擎"必须同时丢弃客户端，
 * 由下一次工具调用经 loadSky 重新构造（并重新 spawn 引擎）。
 */
export function resetSky() {
  cached = undefined;
}

/**
 * 载入官方客户端（进程内单例）。
 * @param {object} config 插件配置。
 * @param {object} [logger] DSH logger（可选）。
 * @returns {Promise<{sky: object, info: object}>}
 */
export async function loadSky(config = {}, logger) {
  if (cached !== undefined) return cached;

  const pkg = findSkyPackage();
  if (pkg === undefined) {
    throw new Error(
      '未找到官方电脑控制运行时（@oai/sky）。请先安装/启动一次提供该运行时的应用，'
      + '并至少在其中使用过一次"电脑控制"功能。',
    );
  }

  const cli = findEngineCli();
  if (cli !== undefined) {
    // 引擎按「CLI 文件名大写 + _CLI_PATH」读取该环境变量；由文件名推导，避免写死。
    const envName = `${path.basename(cli, '.exe').toUpperCase()}_CLI_PATH`;
    process.env[envName] = process.env[envName] || cli;
    const dir = path.dirname(cli);
    const parts = (process.env.PATH ?? '').split(path.delimiter);
    if (!parts.includes(dir)) {
      process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
    }
  }

  // 强制 helper(stdio) 传输：DSH 没有引擎宿主的 nativePipe / createConnection。
  delete process.env.SKY_CUA_NATIVE_PIPE;
  delete process.env.SKY_CUA_NATIVE_PIPE_DIRECTORY;

  const decisions = [];
  installApprovalShim(async (request) => {
    const decision = decideApproval(request, config);
    decisions.push({
      at: new Date().toISOString(),
      app: decision.app,
      action: decision.action,
      reason: decision.reason,
    });
    if (decisions.length > 200) decisions.shift();
    logger?.info?.(
      `[dscomputer-control] 审批 ${decision.action}：${decision.app || '(未知应用)'}（${decision.reason}）`,
    );
    return { action: decision.action };
  });

  // 直接构造 Windows 客户端，**绕开包入口的 `sky` 代理**。
  //
  // 原因：`sky.js` 的默认导出是个 Proxy，其惰性构造逻辑是
  //     if (globalThis.nodeRepl === undefined) return create_client(load_options());
  //     if (typeof globalThis.nodeRepl.rpc !== 'function') throw new Error(
  //         "sky requires node_repl; configure NODE_REPL_TRUSTED_SERVICES");
  // 而审批回调恰恰必须挂在 `globalThis.nodeRepl.config.createElicitation` 上
  // （传输层是 `customElicitation ?? globalThis.nodeRepl?.config?.createElicitation`），
  // 两者直接冲突：挂 shim ⇒ 代理抛错；不挂 ⇒ 所有需审批的调用必失败。
  //
  // 解法：绕开代理，直接走目标平台工厂 ——
  //     targets/windows/create_client.js → new WindowsComputerUseClient()
  // 该客户端在 `nodeRepl?.env?.SKY_CUA_NATIVE_PIPE !== "1"` 时自选 helper(stdio) 传输，
  // 于是：独立路径 + 审批 shim 同时成立。
  const entry = resolveClientEntry(pkg.dir);
  const skySrcDir = path.join(pkg.dir, 'dist', 'project', 'cua', 'sky_js', 'src');
  let sky;
  let clientPath = 'package-entry';
  try {
    const { create_client: createClient } = await import(
      pathToFileURL(path.join(skySrcDir, 'create_client.js')).href
    );
    const { load_options: loadOptions } = await import(
      pathToFileURL(path.join(skySrcDir, 'load_options.js')).href
    );
    sky = createClient(loadOptions());
    clientPath = path.join(skySrcDir, 'create_client.js');
  } catch (error) {
    logger?.warn?.(
      `[dscomputer-control] 直接构造客户端失败（${String(error?.message ?? error)}），回退到包入口`,
    );
    const mod = await import(pathToFileURL(entry).href);
    sky = mod.sky ?? mod.default?.sky ?? mod.default;
  }
  if (sky === null || typeof sky !== 'object' || typeof sky.list_apps !== 'function') {
    throw new Error(`@oai/sky 未构造出可用客户端（入口 ${clientPath}）`);
  }

  cached = {
    sky,
    info: {
      skyDir: pkg.dir,
      skyVersion: pkg.version,
      entry,
      clientPath,
      cliPath: cli ?? null,
      approval: APPROVAL_MODES.includes(config.approval) ? config.approval : 'auto',
      approvedApps: Array.isArray(config.approvedApps) ? [...config.approvedApps] : [],
      decisions,
      loadedAt: new Date().toISOString(),
    },
  };
  logger?.info?.(
    `[dscomputer-control] 已接入官方引擎 @oai/sky@${pkg.version}（cli=${cli ?? '未找到'}，审批=${cached.info.approval}）`,
  );
  return cached;
}
