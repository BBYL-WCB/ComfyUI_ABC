// ═══════════════════════════════════════════════════════════════
//  A006 视频节点 · 共享基础工具
//  （常量 / 日志 / DOM 辅助 / 视频 URL / widget 隐藏 / 预览重绘）
//  · 本模块不依赖其它模块（subgraph / exec / 入口 都从这里 import）
//  · a006Nodes 实例注册表放这里，subgraph.js（冲突检测）与 exec.js
//    （事件回灌）共用，避免模块循环依赖
// ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/** 前端节点类型名（对应后端 V3 node_id="A006_VideoNode"）。 */
export const NODE_TYPE = "A006_VideoNode";

/** 日志前缀。 */
export const TAG = "[A006 视频节点]";

/** 输出插槽定位改为「按槽名 → 子图槽 id → 同序 outputNode.slots」解析（见 A006_exec.js 的 resolveSubgraphOutputLink），不再依赖固定下标。 */

/** LiteGraph.NEVER 常量：queuePrompt 前静音非目标节点。 */
export const LG_MODE_NEVER = 4;

/** 内部日志缓冲上限（便于浏览器自动化测试读取）。 */
export const LOG_BUFFER_LIMIT = 200;

/** 子图输入/输出节点的固定 id（常量，不可重映射）。唯一数据源：以前 subgraph/workflow 各定一份，现合并到此处。 */
export const SG_INPUT_NODE_ID = -10;
export const SG_OUTPUT_NODE_ID = -20;
export const isConstId = (v) => v === SG_INPUT_NODE_ID || v === SG_OUTPUT_NODE_ID;

/**
 * ★ 唯一数据源：A006 全部尺寸 / 颜色 / 字体 / 派生量在此一处定义，
 *  其它模块与 CSS 模板一律引用这里的键，禁止再出现裸值。
 *  取值以代码「实际生效值」为准（旧注释里的 80% 宽 / 15px 圆角 / 5px 间距均已失效，不采信）。
 */
const NS = {
    /* ── 尺寸（px） ── */
    MIN_W: 300,               // 节点最小宽
    TITLE_H: 30,              // 标题栏高
    PAD_TOP: 0,               // dom 上下留白（外框铺满，无留白）
    PAD_SIDE: 0,              // dom 水平留白（外框铺满，无留白）
    FRAME_PAD: 10,            // 外框内边距（外框与视频框/文本框/按键的间隙）
    GAP: 10,                  // 容器内元素间距
    CORNER_RADIUS: 20,        // 外层圆角容器 + 视频区圆角
    TEXT_RADIUS: 20,          // 文本框 border-radius
    BTN_H: 30,                // 运行按钮高
    PREVIEW_MIN_H: 150,       // 视频区最小高
    TEXT_MIN_H: 30,           // 文本框最小高
    TEXT_FONT_SIZE: 14,       // 文本框字号
    TEXT_PAD: 15,             // 文本框内边距
    TEXT_LINE_HEIGHT: 1.2,    // 文本框行高
    BTN_FONT_SIZE: 13,        // 运行按钮字号
    SET_BTN_SIZE: 30,         // 设置按键（⚙）直径
    SET_BTN_FONT_SIZE: 17,    // 设置按键图标字号
    SETTINGS_BOX_H: 70,       // 设置框高（内边距*2 + 清除行 + 间距 + 记录/还原行）
    SETTINGS_BOX_RADIUS: 20,  // 设置框圆角
    SETTINGS_BOX_PAD: 10,     // 设置框内边距
    TOGGLE_W: 34,             // 设置框内滑块开关宽
    TOGGLE_H: 18,             // 设置框内滑块开关高
    TOGGLE_KNOB: 14,          // 设置框内滑块开关圆点直径
    SET_BTN_SM_H: 20,         // 设置框内小按键高
    SET_BTN_SM_RADIUS: 10,    // 设置框内小按键圆角
    SET_BTN_SM_FONT_SIZE: 12, // 设置框内小按键字号
    SET_BTN_SM_FONT_SIZE_SUB: 9, // 设置框内小按键次要文字字号（比主字号小 3）
    HIDDEN_WIDGET_H: -4,      // 幽灵化原生控件的 computeSize 高度（负数=不占位）
    AUTO_FIT_THRESHOLD: 180,  // 首次预览时「过小」判定阈值（宽或高低于此值则放大到推荐尺寸）
    /* ── 颜色 ── */
    CONTAINER_BG: "#171717",        // 外层圆角容器
    SURFACE_BG: "#1f1f1f",          // 视频占位 + 文本框底色
    BTN_COLOR: "#1e90ff",           // 运行按钮
    BTN_HOVER: "#3aa0ff",           // 运行按钮 hover
    BTN_FG: "#ffffff",              // 运行按钮文字
    TEXT_FG: "#c0c0c0",             // 文本框文字 + 光标
    TEXT_PLACEHOLDER: "#6a6a6a",    // 文本框占位符
    SET_BTN_BG: "rgba(34,34,34,.92)", // 设置按键底色（也是图标色）
    SET_BTN_BORDER: "rgba(255,255,255,.3)", // 设置按键描边
    SETTINGS_BOX_BG: "#222",        // 设置框底色
    SETTINGS_BOX_BORDER: "#444",    // 设置框描边
    SET_BTN_SM_BG: "#333",          // 设置框内小按键底色
    SET_BTN_SM_HOVER: "#444",       // 设置框内小按键 hover
    SET_BTN_SM_FG: "#e6e6e6",       // 设置框内小按键文字
    SET_BTN_SM_BORDER: "rgba(255,255,255,.25)", // 设置框内小按键描边
    TOGGLE_OFF: "#3a3a3a",                  // 滑块开关关闭态轨道底色
    TOGGLE_OFF_BORDER: "rgba(255,255,255,.25)", // 滑块开关关闭态轨道描边
    TOGGLE_ON: "#1e90ff",                   // 滑块开关开启态轨道底色
    TOGGLE_KNOB_COLOR: "#ffffff",           // 滑块开关圆点颜色
};
/* ── 派生量：统一在此推导，其它模块禁止重复计算 ── */
NS.BTN_RADIUS = NS.BTN_H / 2;                        // 胶囊形运行按钮圆角
NS.SETTINGS_H = NS.SETTINGS_BOX_H + NS.GAP;          // 设置框展开时节点增高总量（= 80）
NS.WIDGET_MIN_H =                                    // 最小内容高（= 270）
    NS.PAD_TOP * 2 + NS.FRAME_PAD * 2 + NS.PREVIEW_MIN_H + NS.GAP * 2 + NS.TEXT_MIN_H + NS.BTN_H;
NS.MIN_H = NS.TITLE_H + NS.WIDGET_MIN_H;           // 节点最小总高（标题栏 + DOM 内容）
NS.DEFAULT_W = 400;                                  // 首次预览时的推荐节点宽（4:5 比例）
NS.DEFAULT_H = 600;                                  // 首次预览时的推荐节点高
export const NODE_SIZE = Object.freeze(NS);

window.__a006Logs = window.__a006Logs || [];

/** 统一日志出口：打 console + 写入环形缓冲。 */
export function alog(...args) {
    // alog 是 safeCall 的异常出口自身，绝不能再抛：否则 safeCall 的
    // "保证返回 fallback" 契约失效，异常会穿透到调用方。
    try {
        const msg = args
            .map((a) => {
                if (a instanceof Error) return a.name + ": " + a.message;
                if (typeof a === "object" && a !== null) {
                    try { return JSON.stringify(a); } catch (_e) { return "[object]"; }
                }
                try { return String(a); } catch (_e) { return "[unprintable]"; }
            })
            .join(" ");
        if (!Array.isArray(window.__a006Logs)) window.__a006Logs = [];
        window.__a006Logs.push(msg);
        if (window.__a006Logs.length > LOG_BUFFER_LIMIT) window.__a006Logs.shift();
    } catch (_e) { /* 缓冲写入失败不阻断日志 */ }
    try { console.log(TAG, ...args); } catch (_e) { /* console 不可用 */ }
}

/** 安全调用：fn 抛错时返回 fallback，异常写入日志。 */
export function safeCall(fn, fallback = undefined, label = "safeCall") {
    try {
        return fn();
    } catch (e) {
        alog(`${label} 失败:`, e);
        return fallback;
    }
}

/** 触发节点重绘（LiteGraph 画布）。 */
export function dirtyCanvas(node) {
    node?.setDirtyCanvas?.(true, true);
}

/** 预览重绘统一入口：画布重绘 + 触发 DOM 预览刷新（若已挂载）。 */
export function requestPreviewRedraw(node) {
    dirtyCanvas(node);
    try {
        node._a006Redraw?.();
    } catch (e) {
        alog("预览重绘失败:", e);
    }
}

/** UUID v4（纯前端生成，不需要高熵）。 */
export function uuidv4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/** 是否为本插件的 A006 节点。 */
export function isOurNode(node) {
    if (!node) return false;
    return node.comfyClass === NODE_TYPE || node.type === NODE_TYPE;
}

/** 取节点所属图（优先 node.graph，逐步回退）。 */
export function getNodeGraph(node) {
    // app 可能尚未初始化（与 hideNativeWidget 同标准做防御），逐级回退到 undefined
    if (node?.graph) return node.graph;
    try { return app?.graph || app?.rootGraph; } catch (_e) { return undefined; }
}

/** 按名称查找节点 widget（不存在返回 undefined）。 */
export function findWidgetByName(node, name) {
    return (node?.widgets || []).find((w) => w.name === name);
}

/** 查找「文本」widget。 */
export function getTextWidget(node) {
    return findWidgetByName(node, "文本");
}

/** 获取图中 link 对象（兼容 Map / 数组两种容器）。 */
export function getGraphLink(graph, linkId) {
    const links = graph?.links;
    if (links instanceof Map) return links.get(linkId);
    return links?.[linkId];
}

/** 隐藏单个原生控件：widget.hidden + options.hidden 双写（Nodes 2.0 Vue 读 options.hidden）；
 *  multiline / customtext 拉伸控件额外幽灵化（computeSize 缩 0 高 + 清空 draw）防叠压。
 *  注意：w.inputEl 可能是 Vue 计算属性，图未初始化时访问会抛
 *  "ComfyApp graph accessed before initialization"，须 try 保护，回退到仅按 type 判断。 */
export function hideNativeWidget(w) {
    if (!w) return false;
    let changed = false;
    try { if (!w.hidden) { w.hidden = true; changed = true; } } catch (_e) { /* 忽略 */ }
    try {
        w.options = w.options || {};
        if (!w.options.hidden) { w.options.hidden = true; changed = true; }
    } catch (_e) { /* 忽略 */ }
    try { w.computeSize = () => [0, NODE_SIZE.HIDDEN_WIDGET_H]; } catch (_e) { /* 忽略 */ }
    try { w.draw = () => {}; } catch (_e) { /* 忽略 */ }
    return changed;
}

/** 框架原生「视频预览」DOM widget 名（core 的 useNodeVideo 以该名 addDOMWidget）。 */
export const NATIVE_PREVIEW_WIDGET = "video-preview";

/** 移除框架自动挂上的原生「视频预览」DOM widget（内含带控件的 <video>）。
 *  节点执行产出视频时，core 的 updatePreviews 会额外挂一个 video-preview DOM widget；
 *  它与 A006 自有播放器叠在同一节点上互相遮挡，表现为「节点上的播放器控件看得见但点不动」。
 *  幂等：可重复调用（框架每次执行都可能重挂）。
 *  移除方式对齐核心 removeCanvasImagePreview：onRemove + widgets.splice。 */
export function removeNativePreviewWidget(node) {
    const ws = node?.widgets;
    if (!Array.isArray(ws)) return false;
    let hit = false;
    for (let i = ws.length - 1; i >= 0; i--) {
        const w = ws[i];
        if (!w || w.name !== NATIVE_PREVIEW_WIDGET) continue;
        safeCall(() => w.onRemove?.(), undefined, "原生预览控件: onRemove");
        try { w.element?.remove?.(); } catch (_e) { /* 忽略 */ }
        ws.splice(i, 1);
        hit = true;
    }
    if (!hit) return false;
    // 清掉框架缓存的预览容器：不清则下次执行会复用这个已脱离文档的 DOM
    try { node.videoContainer?.remove?.(); } catch (_e) { /* 忽略 */ }
    node.videoContainer = undefined;
    safeCall(() => node.arrange?.(), undefined, "原生预览控件: 重排");
    safeCall(() => node.setDirtyCanvas?.(true, true), undefined, "原生预览控件: 重绘");
    alog("已移除框架原生视频预览控件（预览由 A006 自有播放器接管）");
    return true;
}

/** 常驻移除框架原生视频预览：观察节点 DOM，出现预览类名或原生 video-preview 控件即移除。
 *  框架挂载发生在视频元数据加载完成之后（异步），故用 MutationObserver 兜住时序；
 *  Vue 重建会换掉 DOM widget 宿主层，故每次变化时顺带校验并重挂观察器。
 *  同时观察 DOM widget 宿主层与节点根元素，兼容 legacy / Nodes 2.0 两种挂载位置。 */
export function watchNativePreviewRemoval(node, g) {
    if (typeof MutationObserver === "undefined" || !node || !g?.el) return;
    const hostsNow = () => [g.el?.parentElement, g.el?.closest?.(".lg-node")].filter(Boolean);
    const sameHosts = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((h, i) => h === b[i]);
    const check = () => {
        if (node._xzgA006 !== g) return;
        // 双重判据：DOM 出现预览类名，或节点 widgets 上挂有原生 video-preview 控件
        // （框架挂载时机与 DOM 类名可能随版本变化，仅看类名会漏判 → 控件残留遮挡）。
        const hasPreviewDom = hostsNow().some((h) => h.querySelector?.(".comfy-img-preview"));
        const hasNativeWidget = (node.widgets || []).some((w) => w?.name === NATIVE_PREVIEW_WIDGET);
        if (!hasPreviewDom && !hasNativeWidget) return;
        removeNativePreviewWidget(node);
    };
    const ensure = () => {
        const hosts = hostsNow();
        if (!hosts.length || sameHosts(hosts, g._prevHosts)) return;
        for (const mo of g._prevMOs || []) mo.disconnect();
        g._prevHosts = hosts;
        g._prevMOs = hosts.map((h) => {
            const mo = new MutationObserver(() => { check(); ensure(); });
            mo.observe(h, { childList: true, subtree: true });
            return mo;
        });
        check();
    };
    ensure();
}

/** 由后端保存的视频数据对象构造 /view URL（图片 / 视频均可经 /view 访问）。 */
export function videoDataToUrl(data) {
    return api.apiURL(
        `/view?filename=${encodeURIComponent(data.filename)}` +
        `&type=${data.type}` +
        `&subfolder=${encodeURIComponent(data.subfolder || "")}` +
        `${app.getPreviewFormatParam()}${app.getRandParam()}`
    );
}

/** 将一批视频数据（后端 ui.videos/ui.images 格式）转换为视频源 URL 数组。 */
export function loadVideosFromData(dataList, onDirty) {
    const urls = (Array.isArray(dataList) ? dataList : []).map((d) => videoDataToUrl(d));
    if (typeof onDirty === "function" && urls.length) setTimeout(onDirty, 0);
    return urls;
}

/** 取 A006 子图内某节点最近一次 executed 广播的视频（原始数据数组 {filename,type,subfolder,...}）。 */
export function getInnerUiVideos(node, feedId) {
    const m = node?._a006InnerUiVideos;
    const arr = (m && typeof m.get === "function") ? (m.get(String(feedId)) || []) : [];
    return Array.isArray(arr) ? arr : [];
}

/** 设置节点预览视频源数组（写入 _a006Vids，URL 数组）。 */
export function setPreviewVideos(node, vids) {
    node._a006Vids = Array.isArray(vids) ? vids : [];
}

/** 首次预览时把过小节点放大到推荐尺寸（幂等）。 */
export function ensureMinNodeSize(node) {
    const s = node?.size;
    // 用「与」：只有宽高都低于阈值（真正的小节点）才放大，
    // 避免宽扁/高瘦节点每次出图都被强制拉回默认尺寸。
    if (s && s[0] < NODE_SIZE.AUTO_FIT_THRESHOLD && s[1] < NODE_SIZE.AUTO_FIT_THRESHOLD) {
        safeCall(() => node.setSize?.([NODE_SIZE.DEFAULT_W, NODE_SIZE.DEFAULT_H]), undefined, "ensureMinNodeSize");
    }
}

/** 所有已初始化的 A006 节点注册表（供事件回灌 / 复制粘贴 ID 冲突检测 / 清理）。 */
export const a006Nodes = new Set();
