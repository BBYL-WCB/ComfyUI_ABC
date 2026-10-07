// ═══════════════════════════════════════════════════════════════
//  A001_子图节点 · 共享工具
//
//  ★ A001 的**唯一**共享层：A001_SubgraphNode.js、三个拆分簇（A001_slots /
//    A001_remap / A001_hidden）以及 A001_Appearance / A001_preview / A001_workflow
//    等全部模块都从这里导入工具与常量。
//  放在独立模块以消除「A ⇄ B」的循环依赖：
//    · 原先 alog / safeCall 只存在于 A001_SubgraphNode.js，A001_preview.js 若直接
//      import 本模块就会形成 A001_SubgraphNode ⇄ A001_preview 环，故下沉到这里。
//    · 曾短暂存在第二个共享模块 A001_SubgraphNode_shared.js，因与本文件重复 9 个
//      符号（属「无职责的垃圾桶模块」反模式）且造成 getNodeGraph 同名两义，
//      已于 2026-10-07 整体并入本文件并删除。
//
//  本模块不 import 任何 A001 私有模块，处于依赖图最底层。
//
//  对外提供 uuidv4() / isConstId() / SG_INPUT_NODE_ID / SG_OUTPUT_NODE_ID：
//  记录/还原（A001_workflow.js）在还原时需重映射子图内部全部 ID，依赖这两项。
//  实现与 A006_shared.js 同名成员完全一致（子图输入/输出固定 id 为常量不可重映射）。
// ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import { injectStyleOnce } from "../A000/A000_DomStyle.js";

/** 统一日志前缀（与 A001_SubgraphNode.js 的 TAG 保持一致）。 */
export const A001_TAG = "[A001 子图节点]";

/** UUID v4（纯前端生成，不需要高熵）。与 A006_shared.js 同名实现一致。 */
export function uuidv4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/** 子图输入/输出节点的固定 id（常量，不可重映射）。取自 A006_shared.js 同款约定。 */
export const SG_INPUT_NODE_ID = -10;
export const SG_OUTPUT_NODE_ID = -20;
export const isConstId = (v) => v === SG_INPUT_NODE_ID || v === SG_OUTPUT_NODE_ID;

/** 统一日志出口。 */
export function alog(...args) {
    try { console.log(A001_TAG, ...args); } catch (_e) { /* console 不可用 */ }
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

/** 取节点所属图（优先 node.graph，逐步回退）。 */
export function getNodeGraph(node) {
    if (node?.graph) return node.graph;
    return safeCall(() => app?.graph || app?.rootGraph, undefined, "取当前图");
}

/** 判定节点当前是否仍在所属图中（已从画布删除则为 false）。 */
export function isNodeInGraph(node) {
    const g = getNodeGraph(node);
    return !!g && (g._nodes || []).includes(node);
}

/** 获取子图内部节点列表（兼容 _nodes / nodes 两种属性名）。 */
export function getSgNodes(sg) {
    if (!sg) return [];
    return sg._nodes || sg.nodes || [];
}

/* ── 轻量 toast 提示（A001_run.js 与 A001_workflow.js 共用） ──
 * 两处原先各有一份完全同构的实现（jscpd 91 tokens 克隆簇，本插件最大 JS 重复段）。
 * 按「差异参数化保留、禁止顺手统一」原则，公共实现下沉到本模块（依赖图最底层），
 * 调用点各自包装以保留原有差异：
 *   · A001_run.js      → safeCall 包装 + "运行提示条" 日志标签
 *   · A001_workflow.js → try/catch 静默（原语义：提示失败不影响主流程）
 * 定时器状态由「两模块各一份」合并为一份：toast 本身是全局单例（按 .xzg-a001-toast
 * 查找并移除旧实例），合并后外部可观察行为不变，且顺带消除了旧实例的悬挂定时器。 */
let _a001ToastTimer = 0;
let _a001ToastFadeTimer = 0;

/** 显示 toast：body 挂载，2400ms 后淡出、再 260ms 移除（幂等：重复调用先清理旧实例）。 */
export function showA001Toast(text) {
    const old = document.querySelector(".xzg-a001-toast");
    if (old) old.remove();
    if (_a001ToastTimer) { clearTimeout(_a001ToastTimer); _a001ToastTimer = 0; }
    if (_a001ToastFadeTimer) { clearTimeout(_a001ToastFadeTimer); _a001ToastFadeTimer = 0; }
    const t = document.createElement("div");
    t.className = "xzg-a001-toast";
    t.textContent = text;
    t.style.cssText = "position:fixed;left:50%;top:56px;transform:translateX(-50%);z-index:99999;background:rgba(20,22,26,.96);border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:8px 18px;font:500 13px/1 system-ui,sans-serif;color:#e6e6e6;box-shadow:0 4px 18px rgba(0,0,0,.55);pointer-events:none;animation:xzg-a001-toast-in .18s ease;transition:opacity .25s ease";
    injectStyleOnce("xzg-a001-toast-style", "@keyframes xzg-a001-toast-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}");
    document.body.appendChild(t);
    _a001ToastTimer = setTimeout(() => {
        _a001ToastTimer = 0;
        t.style.opacity = "0";
        _a001ToastFadeTimer = setTimeout(() => { _a001ToastFadeTimer = 0; t.remove(); }, 260);
    }, 2400);
}

/* ── 面板视觉常量与节点根定位（由 A001_Appearance.js 下沉） ──
 * 下沉原因：A001_Appearance.js 拆出 A001_HeightModel.js 后，两者都要用这两项；
 * 放在共享层可避免「Appearance ⇄ HeightModel」互相 import 形成环。
 * 定义内容与原实现逐字一致（仅 findNodeRoot 由模块私有改为 export）。 */

/**
 * 节点面板的尺寸与配色（预览框 + 控件框）。
 * 取值对齐姊妹节点 A006_VideoNode 的常量表
 * （CONTAINER_BG / CORNER_RADIUS / FRAME_PAD），保持 A005/A006/A001 三节点视觉一致。
 */
export const A001_FRAME = {
    RADIUS: 20,             // 框圆角半径（A006 CORNER_RADIUS）
    PAD: 5,                 // 框内边距（A006 FRAME_PAD）
    BG: "#171717",          // 预览框底色（A006 CONTAINER_BG）
    SIDE_GAP: 5,            // 框与节点左右边缘的间隔
    PREVIEW_MIN_H: 200,     // ★ 预览框最小高度（常驻下限，防止节点压矮时塌成一条线；不设默认高度）
    CONTROLS_H: 40,         // 控件框固定高度（PAD 5 + 按键高 30 + PAD 5 = 40）
    CONTROLS_BG: "#1c1c1c", // 控件框底色（用户指定）
    GAP: 5,                 // 预览框与控件框之间的间距
    /* ★ 文档流可用高度阈值（px）：实测面板在块级父容器下的高度若低于此值，
     * 说明 flex 布局被塌陷（flex:1 + min-height:0 在块级父下会塌成 0），
     * 必须退化到 "cover" 绝对定位模式兜底。取 4 而非 1 是为了同时排除
     * 亚像素/边框产生的几像素假高度。 */
    FLOW_MIN_H: 4,
};

/**
 * 找到节点的 DOM 根元素（.lg-node）。
 * 优先 [data-node-id="<id>"] 精确定位；退回全局扫描 .lg-node 匹配属性值。
 * 命中后缓存到 node._a001DomRoot。
 */
export function findNodeRoot(node) {
    if (typeof document === "undefined" || node?.id == null) return null;
    // 缓存命中：既连通、又仍是「节点根」（外层可能再包一层 wrapper，须校验它未变成
    // 内部子节点容器）。命中后即可直接复用，避免每轮全量 querySelector。
    const cached = node._a001DomRoot;
    if (cached?.isConnected && cached.getAttribute?.("data-node-id") === String(node.id)) {
        return cached;
    }
    node._a001DomRoot = null;
    const byAttr = document.querySelector(`[data-node-id="${node.id}"]`);
    if (byAttr) {
        node._a001DomRoot = byAttr;
        return byAttr;
    }
    /* 注：节点根的属性就是 data-node-id，上面的属性选择器已覆盖全部 .lg-node，
     * 原「再遍历 .lg-node 匹配属性」的第二段查询纯属冗余（命中时多一次 O(N) 扫描），
     * 故删除。 */
    return null;
}

/* ══════════════════════════════════════════════════════════════
 *  以下成员由 A001_SubgraphNode_shared.js 并入（2026-10-07）
 *
 *  背景：A001 拆分时曾新建 A001_SubgraphNode_shared.js，但它与本文件重复了
 *  9 个符号（alog / safeCall / uuidv4 / getNodeGraph / isNodeInGraph / getSgNodes /
 *  SG_INPUT_NODE_ID / SG_OUTPUT_NODE_ID / isConstId），属「无职责的垃圾桶模块」
 *  反模式；且与既有 getNodeGraph 形成「同名两义」。现统一并入本文件 —— A001
 *  只保留一个共享层。以下为原文件的独有成员，实现逐字保留、零逻辑改动。
 * ══════════════════════════════════════════════════════════════ */

/** 节点类型名（对应后端 V3 node_id="A001_SubgraphNode"）。
 *  多处用于 `node.type === NODE_TYPE` 判定，属稳定标识，勿改。 */
export const NODE_TYPE = "A001_SubgraphNode";

/** 提升控件尺寸重算容差（px）：避免亚像素差值触发无意义的 setSize。 */
export const A001_PROMOTED_SIZE_EPS = 2;

/** ★ 新建 A001 子图节点的默认宽度（px）。
 * 本节点此前没有任何默认尺寸定义，尺寸完全由官方 LGraphNode.computeSize() 决定
 * （空节点即最小固有尺寸）。这里**只作用于新建**：仅当该节点尚未被反序列化
 * （即不是从工作流读出来的）时才落地，避免覆盖用户在已保存工作流里手动拉过的尺寸。
 * 高度不设默认（交给官方 computeSize()，见 applyA001DefaultSize）；
 * 「节点内上方预览框」的最小高度由外观模块单独负责（A001_FRAME.PREVIEW_MIN_H）。 */
export const A001_DEFAULT_WIDTH = 250;

/** 新建节点的「控件收起」默认态：true = 默认收起控件（展开需用户点击）。
 *  ★ 只作用于**新建节点**（非反序列化来源）；已存档工作流一律按存档键原样恢复，
 *    不受本默认值影响（详见 restoreA001HiddenState 的无键分支）。 */
export const A001_DEFAULT_COLLAPSED = true;

/** 「收起控件」状态在 node.properties 中的存档键。 */
export const A001_HIDDEN_PROP = "a001_widgets_hidden";

/** 静默取图（不写日志）：逐字搬运自 A001_SubgraphNode.js 的原有实现。
 *
 *  ⚠️ 与上方 getNodeGraph 并存、**刻意不合并**（遵守「禁止顺手统一」）：
 *     上方版本用 safeCall 包装、异常时打「取当前图 失败」日志；
 *     本版本为 try/catch 静默返回 undefined。两者仅在「访问 app.graph 抛异常」
 *     这一罕见路径上可观察行为不同 —— 那正是两侧既有调用方各自的既有语义。
 *     入口与拆分簇（slots / remap / hidden）沿用本静默版，保证拆分前后行为不变。 */
export function getNodeGraphSilent(node) {
    if (node?.graph) return node.graph;
    try { return app?.graph || app?.rootGraph; } catch (_e) { return undefined; }
}

/** isNodeInGraph 的静默版（与 getNodeGraphSilent 配套）。
 *  判定口径与上方 isNodeInGraph 完全一致，仅底层取图函数不同（见上条说明）。 */
export function isNodeInGraphSilent(node) {
    const g = getNodeGraphSilent(node);
    return !!g && (g._nodes || []).includes(node);
}

/** 触发节点重绘（LiteGraph 画布）。
 *  ★ 同帧去重（性能优化）：同一事件循环内多次调用只做一次实际置脏。
 *  实现在「首次仍同步」与「后续去重」之间取折中，保证行为等价：
 *   1) 本帧尚未置脏 → 立即同步 setDirtyCanvas，并登记 pending；
 *   2) 同帧内再次调用 → 直接返回（真正的重复都被吃掉，收益集中于此）；
 *   3) rAF 时清除 pending，使下一帧恢复可触发。
 *  为何不能整体推迟到 rAF：多处调用点（onSlotAdded/onSlotRemoving/getExtraMenuOptions
 *  等）需要在当前帧就完成画布失效，推迟会表现为「拖一下才刷新」。
 *  为何安全：原生 setDirtyCanvas 自身也只是给画布打一个 dirty 标记、
 *  等下一帧统一重绘，同一帧内重复打标记本就是纯冗余。 */
export function dirtyCanvas(node) {
    if (!node) return;
    if (node._a001DirtyPending) return;
    node._a001DirtyPending = true;
    try {
        node?.setDirtyCanvas?.(true, true);
    } finally {
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
            try {
                /* ★ 保存 rAF 句柄：节点可能在回调执行前被删除，onRemoved 需能取消，
                 *  否则回调会多持有 node 引用一拍（属「rAF 无配对 cancel」）。 */
                node._a001DirtyRaf = window.requestAnimationFrame(() => {
                    node._a001DirtyRaf = 0;
                    node._a001DirtyPending = false;
                });
            } catch (e) {
                node._a001DirtyRaf = 0;
                node._a001DirtyPending = false;
            }
        } else {
            node._a001DirtyPending = false;
        }
    }
}

/** ★ 构造提升实例的源映射对象 `{ nodeId, widgetName }`。
 * 该结构在 promote / reconcile / bindFromWidget 等多处生成，字段口径必须一致，
 * 故统一由此构造，避免各处手写导致键名漂移。 */
export function buildA001SourceRef(nodeId, widgetName) {
    return { nodeId: nodeId ?? null, widgetName };
}
