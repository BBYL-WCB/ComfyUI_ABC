import { app } from "../../scripts/app.js";
import { injectStyleOnce } from "./A000/A000_DomStyle.js";

// ═══════════════════════════════════════════════
//  A004 忽略组 · 节点级单按钮（DOM Widget 方案）
//  点击按钮 = 只切换本节点所在最内层组的忽略状态（未忽略→忽略；已忽略→取消忽略）。
//  嵌套组场景：A004 在小组 G1(G1 在外层 G2 内)时，点击只动 G1，外层父组 G2 与其他组均不动。
//  不在任何组内时：切换「忽略所有 / 取消所有」。
//  实现：通过 addDOMWidget 挂载 DOM 按钮 widget，样式/文字/位置/大小统一。
//  尺寸：无最小/固定尺寸，节点可自由缩放到任意大小（按钮/文字随之自适应）。
// ═══════════════════════════════════════════════

const EXTENSION_NAME = "ABC.IgnoreGroup";
const NODE_TYPE = "IgnoreGroup";

/** 安全调用：fn 抛错时返回 fallback，异常打印到控制台。
 *  ★ A004 是独立模块，未 import A006_shared 的 safeCall；此处自带一份，
 *    否则 hideSwitchWidget / scheduleHideSwitchWidget / ensureHideSwitchObserver
 *    调用 safeCall 会抛 ReferenceError（曾导致开关控件无法隐藏，勿删）。 */
function safeCall(fn, fallback = undefined, label = "safeCall") {
    try {
        return fn();
    } catch (e) {
        try { console.warn(`[A004] ${label} 失败:`, e); } catch (_e) { /* 忽略 */ }
        return fallback;
    }
}

/** 判定某节点是否为 A004「忽略组」节点（兼容多种身份字段）。
 *  为什么不能只看 node.type：节点被放进 ComfyUI 原生子图后，type 可能变为子图
 *  定义的 UUID；而 V3 节点的 node_id（"IgnoreGroup"）会体现在 comfyClass 上。
 *  故三者任一命中即认定，确保子图内/外的 A004 都能被识别。 */
function isIgnoreGroupNode(node) {
    if (!node) return false;
    return node.type === NODE_TYPE
        || node.comfyClass === NODE_TYPE
        || (node.constructor && node.constructor.comfyClass === NODE_TYPE);
}
const MODE_BYPASS = 4;

/** 刚创建、尚无尺寸时的兜底默认（并不钳制后续缩放） */
const DEFAULT_W = 160;
const DEFAULT_H = 80;
/** 标题栏高度：widget 从标题下方开始 */
const TITLE_H = 30;
/** 按钮区距离节点边框的边距 */
const PAD = 6;

/* ─── 组工具函数 ─── */

/** 当前画布图：进入子图后 app.canvas.graph 切换为子图 LGraph；
 *  不要用 curGraph()（始终指向主图），否则子图内部 A004 会操作主图的组/节点。 */
function curGraph() {
    return (app.canvas && app.canvas.graph) || app.graph || null;
}

/** 取「节点自身所在的图」：A004 常被放进原生子图，其组/邻居节点都在子图里，
 *  不能用当前画布图（curGraph）——否则用户在根画布时找不到子图内的组。 */
function graphOf(node) {
    return (node && node.graph) || curGraph();
}

/** 收集「根图 + 所有子图」的 LGraph 列表，用于跨图刷新按钮。 */
function allGraphs() {
    const out = [];
    const seen = new Set();
    const push = (g) => {
        if (!g || seen.has(g)) return;
        seen.add(g);
        out.push(g);
        // 遍历该图节点持有的子图
        for (const n of (g._nodes || [])) {
            if (n && n.subgraph) push(n.subgraph);
        }
        // 兼容 graph 自身维护的 subgraphs 容器（Set/Map/Array）
        let subs = g._subgraphs;
        if (subs) {
            try {
                if (typeof subs.values === "function") subs = Array.from(subs.values());
                else if (!Array.isArray(subs)) subs = Object.values(subs);
                for (const sg of subs) push(sg);
            } catch (e) { /* 忽略 */ }
        }
    };
    push(app.graph || curGraph());
    return out;
}

/** 校验 [x,y,w,h] 是否为有效边界（4 个有限数且宽高 > 0），无效返回 null。 */
function _validBox(b) {
    if (!b || b.length == null || b.length < 4) return null;
    const x = Number(b[0]), y = Number(b[1]), w = Number(b[2]), h = Number(b[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    if (!(w > 0) || !(h > 0)) return null;
    return [x, y, w, h];
}

/** 安全获取组的画布边界 [x, y, w, h]；多来源兜底，尽量在任何时机都拿到有效值。
 *
 *  ★ 为何不能只读 group._bounding：
 *    新版 ComfyUI 前端 LGraphGroup._bounding 是 createMutationView() 返回的响应式
 *    Proxy，真值由 syncBoundsFromStore() 从 layout store 灌入；该方法在
 *    「无 layout 记录 / graph 未就绪 / id===-1」时提前 return，此时 bounds 仍是初始值。
 *    打开工作流/刷新画布的最初几帧，store 往往尚未就绪 → _bounding 取不到有效值。
 *
 *  ★ 持久化修复：过去「取不到就直接返回 null」会让调用方跳过该组，导致 A004 打开
 *    工作流瞬间判定「我不在任何组内」→ 按钮从蓝变成灰。现改为**多来源兜底**：
 *      1) getBounding() / boundingRect（会触发 sync）
 *      2) group._bounding（兼容直接读）
 *      3) group.pos + group.size（普通属性，反序列化时通常已就绪）
 *      4) group._pos + group._size
 *    任一来源有效即返回；全都无效才返回 null（此时调用方跳过该组）。
 */
function getGroupBounds(group) {
    if (!group) return null;

    let b = null;
    try {
        if (typeof group.getBounding === "function") b = group.getBounding();
        else if (group.boundingRect) b = group.boundingRect;
        else b = group._bounding;
    } catch (e) { b = null; }
    let out = _validBox(b);
    if (out) return out;

    // 兜底 2：直接读 _bounding
    try { out = _validBox(group._bounding); if (out) return out; } catch (e) {}

    // 兜底 3：pos + size（普通属性）
    const _boxFromPosSize = (pos, size) => {
        if (!pos || !size) return null;
        const x = Number(pos[0]), y = Number(pos[1]);
        const w = Number(size[0]), h = Number(size[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
        return [x, y, w, h];
    };
    try { out = _boxFromPosSize(group.pos, group.size); if (out) return out; } catch (e) {}

    // 兜底 4：_pos + _size
    try { out = _boxFromPosSize(group._pos, group._size); if (out) return out; } catch (e) {}

    return null;
}

/** 安全获取「节点的画布边界」[x, y, w, h]；多来源兜底。
 *
 *  ★ 为何不能用 node.getBounding()：
 *    A004 常被放进 ComfyUI 原生子图。子图内部节点在「根画布」视角并不参与渲染，
 *    LiteGraph 不会为其计算 bounding，此时 node.getBounding() 返回 [0,0,0,0]，
 *    导致 overlapBounding 全部失败 → 判定「节点不在任何组内」→ 开关/按钮全部失效。
 *    改用 pos + size（反序列化时已就绪的普通属性）即可稳定命中组范围。
 */
function getNodeBounds(node) {
    if (!node) return null;
    // ① getBounding()（已渲染时最准）
    try {
        if (typeof node.getBounding === "function") {
            const b = _validBox(node.getBounding());
            if (b) return b;
        }
    } catch (e) { /* 忽略 */ }
    // ② bounding 属性
    try { const b = _validBox(node.bounding); if (b) return b; } catch (e) { /* 忽略 */ }
    try { const b = _validBox(node._bounding); if (b) return b; } catch (e) { /* 忽略 */ }
    // ③ pos + size（子图内节点走这里）
    const fromPS = (pos, size) => {
        if (!pos || !size) return null;
        const x = Number(pos[0]), y = Number(pos[1]), w = Number(size[0]), h = Number(size[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
        return [x, y, w, h];
    };
    try { const b = fromPS(node.pos, node.size); if (b) return b; } catch (e) { /* 忽略 */ }
    try { const b = fromPS(node._pos, node._size); if (b) return b; } catch (e) { /* 忽略 */ }
    return null;
}

/** 节点 → 「所属最内层组」的缓存（WeakMap，条目随节点被 GC）。
 *  ★ 2026-10-05 启用：此前该缓存**从未被读取**（唯一读取者 findGroupOfNode 全文件无调用，
 *    已删除），clearGroupCache() 在 onChange 等热点被反复调用却毫无收益。
 *  失效路径：
 *    ① 组结构/几何变化 → clearGroupCache()（graph.onChange 与各 toggle 内调用）；
 *    ② 节点自身移动/缩放 → findInnermostGroupOfNode 的包围盒签名变化。 */
let _nodeGroupCache = new WeakMap();

function clearGroupCache() {
    _nodeGroupCache = new WeakMap();
}

function getNodesInGroup(group) {
    const r = [];
    const gb = getGroupBounds(group);
    const graph = (group && group.graph) || curGraph();
    if (!gb || !graph?._nodes) return r;
    for (const n of graph._nodes) {
        if (!n) continue;
        try {
            const nb = getNodeBounds(n);
            if (nb && LiteGraph.overlapBounding(gb, nb)) r.push(n);
        } catch (e) {}
    }
    return r;
}

/** ★ 取「该组实际可控的节点」：排除那些「归属更内层组」的节点。
 *  场景：嵌套组 group3 ⊇ group1。节点4 同时落在两组内，但其最内层组是 group1。
 *  当操作外层 group3 时，节点4 应由它自己的最内层组开关管理，不该被外层组连带切换。
 *  （用户口径：每个 A004 开关只控制自己所在的最内层组，以开关为准、互不越权。） */
function getControlledNodesInGroup(group) {
    const all = getNodesInGroup(group);
    const out = [];
    for (const n of all) {
        const inner = findInnermostGroupOfNode(n);
        if (inner && inner !== group) continue;   // 该节点真正的归属是更内层的组 → 跳过
        out.push(n);
    }
    return out;
}

/** 判断组的真实忽略状态：
 *   - 组内至少有 1 个节点且全部 mode===4 → 已忽略
 *   - 否则（空组 / 有正常节点） → 未忽略
 */
function isGroupBypassed(group) {
    let hasAny = false;
    const ns = getControlledNodesInGroup(group);
    for (const n of ns) {
        hasAny = true;
        if (n.mode !== MODE_BYPASS) return false;
    }
    return hasAny;
}

/** ★★ 组状态是否「已就绪」——用于区分「确认为未忽略」与「暂时查不到」。
 *
 *  背景（勿删，实测根因）：isGroupBypassed 在「组边界尚未由 layout store 同步」或
 *  「组内节点 mode 尚未反序列化」时会返回 false（=未忽略）。调用方若把它当成
 *  权威结论，就会把「快照里明明是已忽略(false)」的开关误写成 true（用户反馈：
 *  「记录的视频开关是关着的，还原后却变成打开的」）。
 *
 *  就绪判据（用「曾确认过」记忆 + 当前几何完整度双重把关）：
 *    · 曾确认：一旦某节点成功取到「组 + 组内受控节点」且 mode 均为数值，就在该节点上
 *      打 __a004GroupEverReady 标记。此后（组就一直可信）即可放行 —— 包括「用户把节点
 *      拖出组、确实变成无组」这种需要按 w=null 原语义处理的场景。
 *    · 未确认前：必须同时满足 ①图组列表已建立 ②节点包围盒可算 ③组内受控节点 mode 为数值，
 *      才认为可信；任一不满足 → 视为「组信息未就绪」→ 调用方跳过写入、保持现状。
 *
 *  ★ 为什么必须补这条门控：还原/加载路径存在数百毫秒的「组信息未就绪」窗口，
 *    loadedGraphNode / setup / hookSwitchConnection 的多次定时重刷恰好反复命中它，
 *    任何一帧的失真都会被 syncSwitchFromState 固化成错误值。 */
function isGroupStateReady(node) {
    if (!node) return false;
    /* 曾确认过 → 长期可信（含「后来确实不在组内」的正常场景）。 */
    if (node.__a004GroupEverReady === true) return true;
    let graph = null;
    try { graph = graphOf(node); } catch (e) { return false; }
    /* 图的组列表都还没建立 → 无从判断，视为未就绪（还原最早期）。 */
    if (!graph || !Array.isArray(graph._groups)) return false;
    /* 节点自身包围盒都算不出 → 几何链路未就绪，视为未就绪。 */
    let nodeBox = null;
    try { nodeBox = getNodeBounds(node); } catch (e) { return false; }
    if (!nodeBox) return false;

    let w = null;
    try { w = findInnermostGroupOfNode(node); } catch (e) { return false; }
    if (!w) {
        /* 图组列表 + 节点包围盒都已就绪，却仍无组 → 「确实不在任何组内」可信结论，
         * 走原语义（w=null → 按未忽略处理）。 */
        node.__a004GroupEverReady = true;
        return true;
    }
    let ns = null;
    try { ns = getControlledNodesInGroup(w); } catch (e) { return false; }
    /* 组存在却算不出受控节点 → 组几何未就绪（边界抖动），视为未就绪。 */
    if (!ns || !ns.length) return false;
    for (const n of ns) {
        if (!n || typeof n.mode !== "number") return false;
    }
    node.__a004GroupEverReady = true;
    return true;
}

function setGroupMode(group, bypass) {
    const ns = getControlledNodesInGroup(group);
    for (const n of ns) {
        if (bypass) { n.mode = MODE_BYPASS; n.bypass = true; }
        else        { n.mode = LiteGraph.ALWAYS; n.bypass = false; }
    }
}

/** 找出覆盖当前节点的所有组中「最内层」的一个（面积最小者）。
 *  null → 节点不在任何组内。 */
function findInnermostGroupOfNode(node) {
    const graph = graphOf(node);
    const nodeBox = getNodeBounds(node);
    if (!graph?._groups || !nodeBox) return null;
    /* ★ 缓存命中（2026-10-05 启用）：本函数是 computeDomAction → refreshDomButton 的热点，
     *  且经 isGroupBypassed → getControlledNodesInGroup 还会对组内每个节点再各调一次，
     *  整体复杂度 O(节点×组)。命中条件用「节点包围盒签名 + 组数量」——
     *  节点移动/缩放即签名变化自动失效；组增删/几何变化由 clearGroupCache() 兜住。 */
    const sig = nodeBox[0] + "," + nodeBox[1] + "," + nodeBox[2] + "," + nodeBox[3];
    const cached = _nodeGroupCache.get(node);
    if (cached && cached.sig === sig && cached.groupsLen === graph._groups.length) {
        return cached.group;
    }
    const containing = [];
    for (const g of graph._groups) {
        const gb = getGroupBounds(g);
        if (!gb) continue;
        let hit = false;
        try { hit = LiteGraph.overlapBounding(gb, nodeBox); } catch (e) { hit = false; }
        if (hit) containing.push([g, gb]);
    }
    const area = ([, gb]) => gb[2] * gb[3];
    const group = containing.length
        ? containing.reduce((a, b) => area(a) <= area(b) ? a : b)[0]
        : null;
    _nodeGroupCache.set(node, { sig, groupsLen: graph._groups.length, group });
    return group;
}

/** \u2605 取「组所属的图」：A004 在原生子图内时，组在子图 LGraph 里，
 *  必须操作 group.graph，而不是当前画布图（curGraph）。否则子图内的组操作会落空。 */
function groupGraph(group) {
    return (group && group.graph) || curGraph();
}

/** \u2605 给「单个图」挂 onChange（幂等）：组/节点结构变化时清缓存并刷新按钮。
 *  抽出来供「所有图」（含子图）挂载，确保子图内部的组变化也能驱动按钮刷新。 */
function hookGraphOnChange(graph) {
    if (!graph || graph._xzgIgOnChangeHooked) return;
    graph._xzgIgOnChangeHooked = true;
    const origOnChange = graph.onChange;
    graph.onChange = function (...args) {
        clearGroupCache();
        /* ★ rAF 合批（2026-10-05）：拖拽组 / 批量增删节点期间 onChange 会被高频触发，
         *  原先每次都同步跑全量刷新（含全图遍历 + 逐节点 O(节点×组) 组归属判定），
         *  再叠加各 toggle 内部 graph.change() 的重入会放大成本。改为同帧只刷一次。 */
        scheduleRefreshAllDomButtons();
        return origOnChange ? origOnChange.apply(this, args) : undefined;
    };
}

/* 全量刷新合批器：同一帧内最多刷新一次；刷新进行中再次请求则顺延到下一帧。 */
let _refreshAllRaf = 0;
let _refreshingAll = false;
function scheduleRefreshAllDomButtons() {
    if (_refreshAllRaf) return;
    if (typeof requestAnimationFrame !== "function") { refreshAllDomButtons(); return; }
    _refreshAllRaf = requestAnimationFrame(() => {
        _refreshAllRaf = 0;
        if (_refreshingAll) { scheduleRefreshAllDomButtons(); return; }
        _refreshingAll = true;
        try { refreshAllDomButtons(); } finally { _refreshingAll = false; }
    });
}

/** 忽略其他组：本组恢复正常，其余所有组一律设为忽略（照搬旧版交互）。
 *  currentGroup 为 null（不在任何组内）时，等同于忽略所有组。 */
function ignoreOthers(currentGroup, graph) {
    const g = graph || groupGraph(currentGroup);
    if (!g?._groups) return;
    for (const grp of g._groups) setGroupMode(grp, grp !== currentGroup);
    clearGroupCache();
    g?.change?.();
    app.canvas?.setDirty?.(true, true);
}

/** 判断子组 child 是否被父组 parent 完全包含（留 1px 容差）。 */
function isGroupInside(child, parent) {
    const cb = getGroupBounds(child);
    const pb = getGroupBounds(parent);
    if (!cb || !pb) return false;
    return cb[0] >= pb[0] - 1 && cb[1] >= pb[1] - 1
        && cb[0] + cb[2] <= pb[0] + pb[2] + 1
        && cb[1] + cb[3] <= pb[1] + pb[3] + 1;
}

/** 找出包含 group 的「最小父组」（面积比它大、且完全包含它）。
 *  null → group 是最外层（顶层）组；有值 → group 是「组中组」里的子组。
 *  用于区分：顶层组（独苗互斥）vs 组中组（局部开关）。 */
function findParentGroup(group) {
    const wb = getGroupBounds(group);
    if (!wb) return null;
    const wArea = wb[2] * wb[3];
    let best = null, bestArea = Infinity;
    for (const g of (groupGraph(group)?._groups || [])) {
        if (g === group) continue;
        const gb = getGroupBounds(g);
        if (!gb) continue;
        const a = gb[2] * gb[3];
        if (a <= wArea) continue;                 // 必须比自己大
        if (!isGroupInside(group, g)) continue;   // 且完全包含自己
        if (a < bestArea) { bestArea = a; best = g; }
    }
    return best;
}

/** 找出 group 的「全部后代子组」= 被 group 完全包含的所有其他组（面积更小者）。 */
function getDescendantGroups(group) {
    const out = [];
    const wb = getGroupBounds(group);
    if (!wb) return out;
    const wArea = wb[2] * wb[3];
    for (const g of (groupGraph(group)?._groups || [])) {
        if (g === group) continue;
        const gb = getGroupBounds(g);
        if (!gb) continue;
        if (gb[2] * gb[3] >= wArea) continue;     // 不比自己小，不可能是后代
        if (isGroupInside(g, group)) out.push(g);
    }
    return out;
}

/** 把「其他父组下的子组」强制设为忽略（紫）—— 用于「子组之间互斥」。
 *
 *  ★ 互斥范围：只压「与 exceptGroup 父组不同」的子组（跨父组的子组互斥）；
 *    同一父组下的兄弟子组 **不互斥**，保持原状不动。
 *  顶层组（无父组）一律不动；exceptGroup 自身及其后代也不动。 */
function setOtherSubgroupsIgnored(exceptGroup) {
    const graph = groupGraph(exceptGroup);
    if (!graph?._groups) return;
    const exceptTree = new Set();
    if (exceptGroup) {
        exceptTree.add(exceptGroup);
        for (const d of getDescendantGroups(exceptGroup)) exceptTree.add(d);
    }
    const exceptParent = exceptGroup ? findParentGroup(exceptGroup) : null;
    for (const g of graph._groups) {
        if (exceptTree.has(g)) continue;
        const gp = findParentGroup(g);
        if (!gp) continue;                 // 只处理「子组」，顶层组不动
        if (gp === exceptParent) continue; // 同父组的兄弟子组不互斥，跳过
        setGroupMode(g, true);             // 其他父组下的子组 → 强制紫
    }
}

/** 子组开关（跨父组互斥版）：切换 group（含其后代）的忽略状态，
 *  同时把「其他父组下的子组」强制设为紫。
 *  - 点亮方向（紫→蓝）：group 变蓝，其他父组的子组变紫            （对应需求 04）
 *  - 忽略方向（蓝→紫）：group 变紫，其他父组的子组也变紫          （对应需求 02）
 *  同一父组下的兄弟子组不互斥（保持原状）；父组与顶层组均不受影响。 */
function toggleSubgroup(group) {
    if (!group) return;
    const bypass = !isGroupBypassed(group);
    setGroupMode(group, bypass);
    for (const d of getDescendantGroups(group)) setGroupMode(d, bypass);
    setOtherSubgroupsIgnored(group);
    clearGroupCache();
    groupGraph(group)?.change?.();
    app.canvas?.setDirty?.(true, true);
}

function ignoreAll(graph) {
    const g = graph || curGraph();
    if (!g?._groups) return;
    for (const grp of g._groups) setGroupMode(grp, true);
    clearGroupCache();
    g?.change?.();
    app.canvas?.setDirty?.(true, true);
}

function unignoreAll(graph) {
    const g = graph || curGraph();
    if (!g?._groups) return;
    for (const grp of g._groups) setGroupMode(grp, false);
    clearGroupCache();
    g?.change?.();
    app.canvas?.setDirty?.(true, true);
}

/** 全局（不在组内的节点用）状态判定：
 *   扫描所有有节点的组，是否全部为 BYPASS（被忽略）。
 *   用于不在组内的按钮：在「忽略所有」和「取消所有」之间智能切换。
 */
function isAllGroupsBypassed(graph) {
    const groups = (graph || curGraph())?._groups || [];
    let hasAny = false;
    for (const g of groups) {
        const nodes = getNodesInGroup(g);
        if (!nodes.length) continue;
        hasAny = true;
        if (!isGroupBypassed(g)) return false;
    }
    return hasAny;
}

/* ─── DOM 按钮 ─── */

function injectDomCss() {
    injectStyleOnce("xzg-abc-a004-style", `
        .xzg-ig-dom { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
                      padding: 6px; box-sizing: border-box; }
        .xzg-ig-btn { width: 100%; height: 100%; border: 1px solid rgba(255,255,255,0.30); border-radius: 10px;
                      color: #fff; font-weight: 600; white-space: pre-line; line-height: 1.15; cursor: pointer;
                      display: flex; flex-direction: column; align-items: center; justify-content: center;
                      font-family: "Microsoft YaHei","微软雅黑","PingFang SC",Arial,sans-serif;
                      transition: filter 0.15s; background: rgba(34,34,34,0.92); }
        .xzg-ig-btn:hover { filter: brightness(1.15); }
        .xzg-ig-btn[data-state="blue"]   { background: rgba(52,152,219,0.92); }
        .xzg-ig-btn[data-state="purple"] { background: rgba(155,89,182,0.92); }
    `);
}

/** 计算按钮的显示状态（旧版逻辑 + 「组中组 / 顶层组互斥」）：
 *
 *  ① 不在任何组内（保留旧版全局逻辑）：
 *     - 全局全忽略 → 紫「取消所有」→ unignoreAll（恢复所有组）
 *     - 非全忽略   → 灰「忽略所有」→ ignoreAll（忽略所有组）
 *
 *  ② 在组内 → 取「最内层组 W」= findInnermostGroupOfNode(node)：
 *
 *     2A. W 是「组中组」里的子组（findParentGroup(W) 非空）—— 子组开关（子组之间互斥）：
 *         - W 正常(蓝) → 蓝「忽略本组」→ toggleSubgroup(W)（W 变紫；其他子组强制紫；父组/顶层组不动） 需求 02
 *         - W 已忽略(紫) → 紫「取消忽略」→ toggleSubgroup(W)（W 变蓝；其他子组强制紫；父组/顶层组不动） 需求 04
 *
 *     2B. W 是「顶层组」（无父组）—— 独苗互斥，保证同画布只有一个顶层组是蓝：
 *         - W 正常(蓝) → 蓝「忽略」→ ignoreAll()（W + 子组 + 其他所有组，全部变紫）       需求 01
 *         - W 已忽略(紫) → 紫「取消」→ ignoreOthers(W)（W 变蓝，其余所有组强制变紫）      需求 03/05
 */
function computeDomAction(node) {
    const w = findInnermostGroupOfNode(node);
    if (!w) {
        // 不在组内：按「节点所属图」判定全局忽略状态（子图内也适用）
        return isAllGroupsBypassed(graphOf(node))
            ? { label: "取消所有", state: "purple", action: "unignoreAll" }
            : { label: "忽略所有", state: "gray",   action: "ignoreAll" };
    }
    // 2A 组中组（W 有父组）→ 子组开关（子组之间互斥）
    if (findParentGroup(w)) {
        return isGroupBypassed(w)
            ? { label: "取消忽略", state: "purple", action: "toggleSubgroup" }
            : { label: "忽略本组", state: "blue",   action: "toggleSubgroup" };
    }
    // 2B 顶层组 → 独苗互斥
    return isGroupBypassed(w)
        ? { label: "取消", state: "purple", action: "ignoreOthers" }
        : { label: "忽略", state: "blue",   action: "ignoreAll" };
}

/** 把标签拆成两行（第一行 忽略/取消，第二行 其他/所有） */
function domLines(label) {
    if (label === "忽略本组") return ["忽略", "本组"];
    if (label === "取消忽略") return ["取消", "忽略"];
    if (label === "忽略所有") return ["忽略", "所有"];
    if (label === "取消所有") return ["取消", "所有"];
    if (label === "忽略")     return ["忽略", "所有"];
    if (label === "取消")     return ["取消", "其他"];
    return [label];
}

/* ─── switch 布尔输入端口 + 开关控件（与按键双向联动） ───
 * 语义（用户口径）：开(true)=蓝=不忽略/恢复；关(false)=紫=忽略。
 * 后端用标准布尔输入（socket + 官方布尔 widget 同时存在）：
 *   · socket：可被 ComfyUI 自动识别/连线；
 *   · widget：官方布尔控件（开关），与节点上的大按钮双向联动。
 */

/** 取节点的 switch 布尔 widget。
 *  多级匹配，兼容不同前端对 widget.name 的赋值差异：
 *    ① name === "switch"（标准）
 *    ② name 含 "switch"（可能被加后缀/前缀）
 *    ③ 布尔型 widget（type 为 toggle/checkbox，或 value 为 boolean）—— 本节点只有一个布尔输入
 *  首次找不到时打印一次诊断，便于定位（可在浏览器控制台查看）。 */
function getSwitchWidget(node) {
    const ws = node?.widgets;
    if (!ws || !ws.length) return null;
    // ① 精确
    for (const w of ws) if (w && w.name === "switch") return w;
    // ② 包含
    for (const w of ws) if (w && typeof w.name === "string" && w.name.indexOf("switch") !== -1) return w;
    // ③ 布尔型兜底
    let boolW = null;
    for (const w of ws) {
        if (!w) continue;
        const t = (w.type || "").toString();
        if (t === "toggle" || t === "checkbox" || typeof w.value === "boolean") { boolW = w; break; }
    }
    if (!node.__a004SwitchDiag) {
        node.__a004SwitchDiag = true;
        try {
            console.warn("[A004] switch widget 未按 name 命中，widget 列表=",
                ws.map((w) => ({ name: w && w.name, type: w && w.type, val: w && w.value })));
        } catch (e) { /* 忽略 */ }
    }
    return boolW;
}

/** 取节点的 switch 输入端口（socket）。 */
function getSwitchInput(node) {
    const ins = node?.inputs;
    if (!ins || !ins.length) return null;
    for (const i of ins) {
        if (i && i.name === "switch") return i;
    }
    return null;
}

/** ★ 通用取 link：兼容新版 ComfyUI 的 graph.links 为 Map 的情况。
 *  实测 ComfyUI 新版前端的 LGraph.links 是 Map<number, Link>，用 links[id] 取不到，
 *  必须用 links.get(id)。此处统一兼容 Map / 普通对象 / graph.getLink() 三种入口。 */
function _getLink(graph, linkId) {
    if (!graph || linkId == null) return null;
    const L = graph.links;
    try {
        if (L) {
            if (typeof L.get === "function") { const l = L.get(linkId); if (l) return l; }
            const l2 = L[linkId];
            if (l2) return l2;
        }
    } catch (e) { /* 忽略 */ }
    try {
        if (typeof graph.getLink === "function") { const l = graph.getLink(linkId); if (l) return l; }
    } catch (e) { /* 忽略 */ }
    return null;
}

/** ★ 通用按 id 取节点：兼容 graph.getNodeById / _nodes_by_id / _nodes 扫描。 */
function _getNodeById(graph, nodeId) {
    if (!graph || nodeId == null) return null;
    try { if (typeof graph.getNodeById === "function") { const n = graph.getNodeById(nodeId); if (n) return n; } } catch (e) { /* 忽略 */ }
    try { const m = graph._nodes_by_id; if (m) { if (typeof m.get === "function") { const n = m.get(nodeId); if (n) return n; } const n2 = m[nodeId]; if (n2) return n2; } } catch (e) { /* 忽略 */ }
    try { for (const n of (graph._nodes || [])) { if (n && n.id === nodeId) return n; } } catch (e) { /* 忽略 */ }
    return null;
}

/** 从任意节点上取出「布尔值」（switch/value 控件，或 widgets_values 首个）。取不到返回 undefined。 */
function pickBooleanFromNode(n) {
    if (!n) return undefined;
    const w = (n.widgets || []).find((x) => x && (x.name === "switch" || x.name === "value"));
    if (w) return !!w.value;
    if (Array.isArray(n.widgets_values) && n.widgets_values.length) {
        const v = n.widgets_values[0];
        if (typeof v === "boolean") return v;
    }
    return undefined;
}

/** ★ 从「子图 LGraph」反查其「外层宿主子图节点」。
 *  实测：子图 LGraph 上并没有 subgraphNode/hostNode/ownerNode/node 等直接引用字段，
 *  因此在所有图里全局扫描，找 n.subgraph === targetGraph 的那个节点。
 *  这是「子图内部节点无法感知宿主控件变化」问题的关键一环。 */
function findHostOfSubgraph(targetGraph) {
    if (!targetGraph) return null;
    const seen = new Set();
    const stack = [app.graph || curGraph()];
    while (stack.length) {
        const g = stack.pop();
        if (!g || seen.has(g)) continue;
        seen.add(g);
        for (const n of (g._nodes || [])) {
            if (!n) continue;
            if (n.subgraph === targetGraph) return n;
            if (n.subgraph) stack.push(n.subgraph);
        }
    }
    return null;
}

/** ★★ 判断本节点的 switch 输入是否为「自反馈回路」——在给出上游值之前必须先排除它。
 *
 *  背景（浏览器实测根因，勿删）：
 *    A004 常被放进原生子图，其 switch 端口连到「子图虚拟输入」（origin_id<0），
 *    对应的真实控件是**外层宿主子图节点上的提升控件**（用户看到的「视频开关」）。
 *    而该提升控件的**真源**，恰恰就是本节点自己的 switch widget（A001 提升机制：
 *    bindOfficialPromotedWidget 把内层源 widget 登记成外层控件并双向回流）。
 *    于是形成闭环：
 *        A004.switch.value → 提升 → host.widgets["switch"].value
 *             ↑                                  ↓
 *             └──────── readSubgraphInputValue ──┘
 *    一旦外层提升控件的初值是「被污染的存档值 true」，该回路就会把组状态反复改回
 *    「未忽略」，与 A001 的存档回灌（mode=4）来回拉锯（实测日志可见 0↔4 反复跳）。
 *
 *  判据：宿主槽上登记的提升源控件（outerInput._a001SourceWidget）就是本节点的 switch
 *    widget（或宿主控件的 widgetId 与本节点 switch 槽的 widgetId 相同）→ 自反馈。
 *
 *  @returns {boolean} true 表示「上游值其实来自本节点自身」→ 应放弃用它驱动组状态。
 */
function isSelfFeedbackSwitchInput(node, host, slot) {
    if (!node || !host) return false;
    let selfSw = null;
    try { selfSw = getSwitchWidget(node); } catch (e) { return false; }
    if (!selfSw) return false;
    let hin = null;
    try { hin = (host.inputs || [])[slot]; } catch (e) { return false; }
    if (!hin) return false;
    /* ① 直接比对提升源控件引用（A001 bindOfficialPromotedWidget 写入的字段）。 */
    if (hin._a001SourceWidget && hin._a001SourceWidget === selfSw) return true;
    /* ② 退路：比对 widgetId —— 本节点 switch 槽的 widgetId 与宿主控件的 widgetId
     *    指向同一身份时，同样说明是同一个控件的投影。 */
    let selfInp = null;
    try { selfInp = getSwitchInput(node); } catch (e) { selfInp = null; }
    const selfWid = selfInp && selfInp.widgetId;
    const hostWid = hin.widgetId || hin._a001OfficialWidgetId;
    if (selfWid && hostWid && String(selfWid) === String(hostWid)) return true;
    /* ③ 再退一步：宿主控件名与本节点 switch 名一致，且宿主该槽没有真实连线
     *    （是「控件型槽」而非「被连线端口」）→ 视为同一控件的投影。
     *    有真实上游连线时（hin.link 非空且非虚拟输入）不算自反馈，交回正常取值。 */
    const hostW = (host.widgets || []).find((x) => x && x.name === "switch");
    if (hostW && hostW === selfSw) return true;
    return false;
}

/** 沿「子图虚拟输入」（origin_id 为负，如 -10）找到外层宿主子图节点上对应输入的控件值。
 *  说明：A004 常被放进 ComfyUI 原生子图，子图对外暴露的输入在内部 link 的 origin_id
 *  为负数；其真实值来自「外层子图节点」对应序位的输入控件。此处按多种可能的内部
 *  结构逐级尝试取值，取不到返回 undefined。 */
function readSubgraphInputValue(node, link) {
    // ★ origin_id 可能是字符串 "-10"（新版 ComfyUI），统一转数字判断
    const oid = Number(link.origin_id);
    if (!Number.isFinite(oid) || !(oid < 0)) return undefined;
    const slot = Number(link.origin_slot) || 0;   // origin_slot 可能为字符串
    // 该输入在子图定义中的「对外名称」（A004 的 switch input 名）
    let portName = null;
    try {
        const inp = getSwitchInput(node);
        portName = inp ? inp.name : null;
    } catch (e) { /* 忽略 */ }
    // ① 通过 node.graph（子图 LGraph）拿宿主节点：
    //    先试直接引用字段，再全局扫描（实测子图 LGraph 上没有直接引用字段）
    let host = null;
    try {
        const g = node.graph;
        host = g && (g.subgraphNode || g.hostNode || g.ownerNode || g.node || null);
    } catch (e) { /* 忽略 */ }
    if (!host) {
        try { host = findHostOfSubgraph(node.graph); } catch (e) { /* 忽略 */ }
    }
    if (host) {
        /* ★★ 自反馈短路（方案 A 核心，勿删）：
         *  若该虚拟输入对应的外层控件，其真源就是本节点自己的 switch widget，
         *  那么「上游值」不过是本节点自身值的镜像。此时若拿它驱动组状态，
         *  就会形成 A004.switch ↔ 组状态 的自激拉锯（实测 0↔4 反复跳）。
         *  故此处直接返回 undefined → readSwitchInputValue 视为「不控制」，
         *  syncFromSwitchPort 不再用 switch 驱动组状态；开关与组状态的联动改由
         *  「组状态 → switch」单向同步（syncSwitchFromState / syncSwitchHostFromState）承担。 */
        if (isSelfFeedbackSwitchInput(node, host, slot)) return undefined;
        // ★ host 若也是子图节点（嵌套子图），其 switch 端口可能又是虚拟输入，
        //   继续沿「宿主自己的 switch 输入端口的 link」向上递归解析。
        try {
            const hInp = getSwitchInput(host);
            if (hInp && hInp.link != null) {
                const hg = host.graph || curGraph();
                const hlink = _getLink(hg, hInp.link);
                if (hlink && Number(hlink.origin_id) < 0) {
                    const deep = readSubgraphInputValue(host, hlink);
                    if (deep !== undefined) return deep;
                }
            }
        } catch (e) { /* 忽略 */ }
        // ★ 外层子图节点的对外输入取值，按优先级：
        //   ① 该输入在宿主 inputs[slot] 上若挂了 widget → 取 widget 值（widget 型输入）
        //   ② 宿主 inputs[slot] 的名字 → 用名称在宿主 widgets 里找控件
        //   ③ 宿主 widgets[slot] 直接按序取布尔控件
        //   ④ 宿主 widgets_values[slot] 兜底
        // ① 宿主 inputs[slot] 的名字（子图虚拟输入对外名）→ 在宿主 widgets 里按名找
        const hin0 = (host.inputs || [])[slot];
        const slotName = (hin0 && hin0.name) || portName;
        if (slotName) {
            const hwn = (host.widgets || []).find((x) => x && x.name === slotName);
            if (hwn && typeof hwn.value === "boolean") return !!hwn.value;
        }
        if (hin0 && hin0.widget) {
            const hwv = (host.widgets || []).find((x) => x && x.name === hin0.widget.name);
            if (hwv) return !!hwv.value;
        }
        if (portName) {
            const hw = (host.widgets || []).find((x) => x && x.name === portName);
            if (hw) return !!hw.value;
        }
        const hw = (host.widgets || [])[slot];
        if (hw && typeof hw.value === "boolean") return !!hw.value;
        if (Array.isArray(host.widgets_values) && slot < host.widgets_values.length) {
            const v = host.widgets_values[slot];
            if (typeof v === "boolean") return v;
        }
        // 外层没有 widget 时，取 inputs[slot] 的上游值（用宿主自身的图查 link）
        const hin = (host.inputs || [])[slot];
        if (hin && hin.link != null) {
            const hg = host.graph || curGraph();
            const hlink = _getLink(hg, hin.link);
            if (hlink) {
                const hn = _getNodeById(hg, hlink.origin_id);
                const hv = pickBooleanFromNode(hn);
                if (hv !== undefined) return hv;
            }
        }
    }
    return undefined;
}

/** 读取 switch 端口「上游连线的布尔值」。
 *  返回 undefined 表示「未连线/取不到」→ 不参与控制（按钮照旧手动点）。
 *  有连线时返回 true/false：
 *    · 普通上游节点 → 取其控件值；
 *    · 子图虚拟输入（origin_id 为负）→ 取外层子图节点对应输入的控件值。 */
function readSwitchInputValue(node) {
    const inp = getSwitchInput(node);
    if (!inp || inp.link == null) return undefined;          // 未连线 → 不控制
    // ★ 必须用「节点自身的图」：A004 在原生子图内，link 属于子图 LGraph，
    //   若用 curGraph()（根画布）则取不到 link → 联动失效。
    const graph = graphOf(node);
    const link = _getLink(graph, inp.link);
    if (!link) return undefined;
    // 子图虚拟输入（负 origin_id；可能是字符串 "-10"，统一转数字）
    if (Number(link.origin_id) < 0) {
        const sv = readSubgraphInputValue(node, link);
        if (sv !== undefined) return sv;
        return undefined;
    }
    const up = _getNodeById(graph, link.origin_id);
    return pickBooleanFromNode(up);
}

/** 按 switch 的值对目标组执行忽略逻辑（只作用于该组自身）。
 *  映射（用户口径）：开(true)=蓝=不忽略/恢复；关(false)=紫=忽略。 */
function applySwitchValue(node, value) {
    /* ★★ 就绪门控（与 syncSwitchFromState 同源）：组未就绪时不改组状态，
     *   避免在还原窗口内用「失真的上游值/几何」误改组，进而反向污染开关。 */
    if (!isGroupStateReady(node)) return;
    const w = findInnermostGroupOfNode(node);
    if (!w) return;
    setGroupMode(w, !value);             // 开(true)→恢复；关(false)→忽略
    clearGroupCache();
    // ★ 用节点自身的图触发变更（A004 在原生子图内时 curGraph() 是根图，错了）
    const g = graphOf(node);
    g?.change?.();
    app.canvas?.setDirty?.(true, true);
    refreshAllDomButtons();
}

/** 读取 switch 端口的上游连线值并驱动忽略逻辑（连线才控制）。
 *  ★ 值已与当前组状态一致时直接返回，避免「apply → refresh → apply」自激循环。 */
function syncFromSwitchPort(node) {
    const v = readSwitchInputValue(node);
    if (v === undefined) return;                 // 未连线 → 不控制
    /* ★★ 就绪门控：组信息未就绪时勿用上游值驱动组状态（还原早期窗口）。 */
    if (!isGroupStateReady(node)) return;
    const w = findInnermostGroupOfNode(node);
    if (!w) return;
    // ★ 一致性判据用「节点自身 mode」：嵌套/部分忽略时 isGroupBypassed 会失真。
    //   期望：开(v=true) → 节点为正常(mode!=4)；关(v=false) → 节点为忽略(mode==4)。
    const nodeBypassed = node.mode === MODE_BYPASS;
    if (nodeBypassed === !v) return;             // 已一致 → 不写，断环
    applySwitchValue(node, v);
}

/** 依据目标组「当前是否被忽略」，把 switch widget 的值同步过来（仅在确有控件时）。 */
function syncSwitchFromState(node) {
    const sw = getSwitchWidget(node);
    if (!sw) return;                     // force_input 下无控件 → 无需同步
    /* ★★ 就绪门控（修复「还原后开关 false→true」，勿删）：
     *   组信息未就绪时 isGroupBypassed 会假阴性（返回 false=未忽略），若照此写值，
     *   就会把快照里「已忽略(false)」的开关误写成 true。故此处必须先确认组状态可信，
     *   否则直接跳过本轮写入、保持开关现状，等下一次重刷（组就绪后）再同步。 */
    if (!isGroupStateReady(node)) return;
    const w = findInnermostGroupOfNode(node);
    const bypassed = w ? isGroupBypassed(w) : false;
    const wantOpen = !bypassed;          // 已忽略 → 关(false)；正常 → 开(true)
    /* ★★ 加载后强制校正（修复「刷新后开关变开」，与就绪门控配套，勿删）：
     *   根因：外层 A001 的「视频开关」提升控件把值存进 widgets_values_named.switch，
     *   官方 configure 会按名把它回灌（经投影 setter 直写本节点的 switch widget）。
     *   若存档里是历史污染值 true，而组实际为「已忽略」，就会显示为开。
     *   本开关的值本应「由组状态派生」，不该被存档覆盖 —— 故加载后必须无条件校正一次：
     *   即使当前值看起来一致（其实是被污染的同值），也要按组状态重写并刷新 UI。 */
    const force = node.__a004NeedReconcile === true;
    if (!force && !!sw.value === wantOpen) return;
    node.__a004NeedReconcile = false;
    node.__a004SilentSwitch = true;   // 静默：避免本次赋值触发 onWidgetChanged 造成自激
    try {
        sw.value = wantOpen;
        /* 回灌路径可能同时污染宿主的 widgets_values_named/widgets_values（序列化用），
         * 一并修正，避免「改好了但再保存又存成污染的 true」。 */
        try {
            if (Array.isArray(node.widgets_values)) {
                const idx = (node.widgets || []).indexOf(sw);
                if (idx >= 0 && node.widgets_values[idx] !== wantOpen) node.widgets_values[idx] = wantOpen;
            }
            if (node.widgets_values_named && typeof node.widgets_values_named === "object"
                && sw?.name && node.widgets_values_named[sw.name] !== wantOpen) {
                node.widgets_values_named[sw.name] = wantOpen;
            }
        } catch (_e) { /* 忽略 */ }
    } finally {
        node.__a004SilentSwitch = false;
        node.__a004LastSwitchVal = !!wantOpen;   // 记录值，避免轮询把反向同步误判为变化
    }
}

/** ★ 找「本节点 switch 输入」在外层宿主子图节点上对应的「开关控件」。
 *  子图内 A004 的 switch 输入若来自子图虚拟输入（origin_id<0），其真实控件在外层宿主
 *  子图节点上。返回 { host, widget, slot } 或 null。 */
function findHostSwitchWidget(node) {
    const inp = getSwitchInput(node);
    if (!inp) return null;
    const graph = graphOf(node);
    const link = _getLink(graph, inp.link);
    if (!link) return null;
    const oid = Number(link.origin_id);
    if (!Number.isFinite(oid) || !(oid < 0)) return null;   // 只处理「子图虚拟输入」情形
    const slot = Number(link.origin_slot) || 0;
    const host = findHostOfSubgraph(graph);
    if (!host) return null;
    // 按 slot 名（= 子图虚拟输入对外名 = 本节点输入名）在宿主 widgets 里按名匹配
    const hin = (host.inputs || [])[slot];
    const name = (hin && hin.name) || inp.name;
    let widget = null;
    if (name) widget = (host.widgets || []).find((x) => x && x.name === name) || null;
    if (!widget) widget = (host.widgets || [])[slot] || null;
    if (!widget || typeof widget.value !== "boolean") return null;
    return { host, widget, slot };
}

/** ★★ 便捷判断：本节点 switch 端口的上游，是否为「指回自身提升控件的自反馈」。
 *
 *  供「轮询兜底」等无法拿到 host/slot 的调用点使用：命中时表示 switch 的值并非
 *  外部来源，而是本节点自身被提升后的镜像 —— 这类「变化」多来自加载回灌或
 *  程序写入，不该被当成用户拨动去驱动组状态（否则与存档回灌来回拉锯）。
 *  返回 false 时（未连线 / 真实外部上游 / 拿不到宿主）保持原有联动语义。 */
function isSwitchSelfFeedback(node) {
    let info = null;
    try { info = findHostSwitchWidget(node); } catch (e) { info = null; }
    if (!info) return false;
    return isSelfFeedbackSwitchInput(node, info.host, info.slot);
}

/** ★ 按键 → 外层宿主开关：根据「本节点目标组当前是否被忽略」，
 *  把外层宿主子图节点上对应的 switch 开关值同步过去。
 *  允许按键控制开关（与「开关 → 按键」形成双向联动）。 */
function syncSwitchHostFromState(node) {
    let info = null;
    try { info = findHostSwitchWidget(node); } catch (e) { info = null; }
    if (!info) return;
    /* ★★ 就绪门控：组信息未就绪时 bypassed 会假阴性(false) → wantOpen=true，
     *   会把「外层宿主开关（用户看到的视频开关）」误写成开。故未就绪时直接跳过。 */
    if (!isGroupStateReady(node)) return;
    const w = findInnermostGroupOfNode(node);
    const bypassed = w ? isGroupBypassed(w) : false;
    const wantOpen = !bypassed;                 // 已忽略 → 关(false)；正常 → 开(true)
    const sw = info.widget;
    if (!!sw.value === wantOpen) return;        // 已一致 → 不写
    const host = info.host;
    // 静默标记：避免写入宿主控件后被宿主 onWidgetChanged/callback 反向驱动造成自激
    host.__a004SilentHostSwitch = true;
    try {
        sw.value = wantOpen;
        // 同步宿主的 widgets_values（序列化用）
        if (Array.isArray(host.widgets_values)) {
            const idx = (host.widgets || []).indexOf(sw);
            if (idx >= 0) host.widgets_values[idx] = wantOpen;
        }
        // 记录快照，避免宿主轮询把本次写入误判为「用户拨动」
        if (Array.isArray(host.__a004HostLastVals)) {
            const idx = (host.widgets || []).indexOf(sw);
            if (idx >= 0) host.__a004HostLastVals[idx] = wantOpen;
        }
    } catch (e) { /* 忽略 */ }
    host.__a004SilentHostSwitch = false;
    // 让开关控件重绘
    try { host.setDirtyCanvas?.(true, true); } catch (e) { /* 忽略 */ }
    try { app.canvas?.setDirty?.(true, true); } catch (e) { /* 忽略 */ }
}

/** 给 switch 控件挂「开关 → 忽略」的联动出口（幂等）。
 *  同时挂两处，覆盖不同前端版本：
 *   ① widget.callback（旧路径）
 *   ② node.onWidgetChanged(name,value,...)（新版前端 widget 值变化的标准出口）
 *  ★ 用 node.__a004SilentSwitch 静默标记避免「反向同步 sw.value」触发自激循环。 */
function hookSwitchWidget(node) {
    // ① widget.callback
    const sw = getSwitchWidget(node);
    if (sw && !sw.__a004SwitchHooked) {
        sw.__a004SwitchHooked = true;
        const orig = sw.callback;
        sw.callback = function (value, ...rest) {
            let r = undefined;
            try { if (typeof orig === "function") r = orig.call(this, value, ...rest); } catch (e) { /* 忽略 */ }
            if (!node.__a004SilentSwitch) {
                try { applySwitchValue(node, sw.value); } catch (e) { /* 忽略 */ }
            }
            return r;
        };
    }
    // ② node.onWidgetChanged（新版前端主要走这条）
    if (!node.__a004SwitchWidgetHooked) {
        node.__a004SwitchWidgetHooked = true;
        const onWC = node.onWidgetChanged;
        node.onWidgetChanged = function (name, value, oldValue, widget) {
            const r = onWC ? onWC.apply(this, arguments) : undefined;
            if (name === "switch" && !this.__a004SilentSwitch) {
                try { applySwitchValue(this, value); } catch (e) { /* 忽略 */ }
            }
            return r;
        };
    }
    // ③ 轮询兜底：某些前端版本既不触发 callback 也不触发 onWidgetChanged，
    //    这里低频比对 sw.value 变化，确保「开关 → 按键」在任何版本都能联动。
    if (!node.__a004SwitchPollTimer) {
        node.__a004LastSwitchVal = sw ? !!sw.value : undefined;
        node.__a004SwitchPollTimer = setInterval(() => {
            try {
                if (document.hidden) return;              // 后台标签页跳过轮询
                if (node.__a004SilentSwitch) return;      // 反向同步期间跳过
                /* ★★ 自反馈时跳过（方案 A）：switch 的值来自「指回自身的提升控件」，
                 *  其变化多由加载回灌 / 程序写入引起，不是用户拨动 —— 若据此驱动组状态，
                 *  会与存档回灌（mode=4）来回拉锯。用户真实拨动仍走 ①②（callback /
                 *  onWidgetChanged），不受此处影响。 */
                if (isSwitchSelfFeedback(node)) return;
                const cur = getSwitchWidget(node);
                if (!cur) return;
                const v = !!cur.value;
                if (v !== node.__a004LastSwitchVal) {
                    node.__a004LastSwitchVal = v;
                    applySwitchValue(node, v);
                }
            } catch (e) { /* 忽略 */ }
        }, 200);
    }
}

/** 连线监听（幂等）：switch 端口的上游连线建立/断开/值变化时，同步忽略逻辑。
 *  对应「连线才控制」：未连线时不做任何自动控制。 */
function hookSwitchConnection(node) {
    if (node.__a004SwitchConnHooked) return;
    node.__a004SwitchConnHooked = true;
    const sync = () => {
        try {
            const v = readSwitchInputValue(node);
            if (v !== undefined) applySwitchValue(node, v);   // 仅连线时才控制
            refreshAllDomButtons();                            // 断开/建立后一并刷新按钮
        } catch (e) { /* 忽略 */ }
    };
    // 连线变化：建立/断开
    if (typeof node.onConnectionsChange === "function") {
        const o = node.onConnectionsChange;
        node.onConnectionsChange = function (...args) {
            const r = o.apply(this, args);
            sync();
            return r;
        };
    }
    // 初次与后续延时校正
    [0, 200, 600].forEach((ms) => setTimeout(sync, ms));
}

/** 隐藏官方布尔 widget 的「控件显示」，但**保留其 socket 端口**（可连线、可识别）。
 *
 *  目的：节点上不出现多余的开关控件（大按钮即其控件表示），
 *        同时该输入的「可连线端口」保持正常显示、可被 ComfyUI 自动识别与连线。
 *
 *  ★★ DOM 结构（浏览器实测，勿改错层）：
 *    官方把「端口槽区」与「控件本体」放在**同一行** `.lg-node-widget` 内：
 *      .lg-node-widget
 *        ├── DIV（w-3，含 .lg-slot 端口圆点）      ← 【必须保留】端口
 *        └── DIV（grid，含 button[role=switch]）    ← 【要隐藏】开关控件本体
 *    因此**绝不能对整行 display:none** —— 那会把端口一起隐藏（违背需求）。
 *    只能隐藏「控件本体」那一层。实测：隐藏后行高仍由端口槽区撑住（24px 不变），
 *    端口与连线识别均不受影响。
 *
 *  ★ 不要设 sw.hidden = true —— 某些 ComfyUI 版本会连带把该输入的 socket
 *    端口一起隐藏；也不要删 input.widget（会改变端口的 widget 型判定）。 */
function hideSwitchWidget(node) {
    if (!node) return;
    const sw = getSwitchWidget(node);
    /* ① 控件高度压为 0（不写 hidden，避免牵连端口）。 */
    if (sw) {
        try { sw.computeSize = function () { return [0, 0]; }; } catch (e) { /* 忽略 */ }
    }
    /* ② 精确定位「官方开关控件行」，隐藏其中的「控件本体」而保留端口槽区。 */
    safeCall(() => {
        const root = node._xzgIgDom?.el?.closest?.("[data-node-id]")
            || (node.id != null ? document.querySelector(`[data-node-id="${node.id}"]`) : null);
        if (!root) return;
        /* 找出含 switch 控件（button[role=switch] 或官方布尔 input）的那一行。 */
        const rows = root.querySelectorAll(".lg-node-widget");
        let switchRow = null;
        for (const row of rows) {
            const ctrl = row.querySelector('button[role="switch"], input[type="checkbox"], .p-togglebutton');
            if (!ctrl) continue;
            /* 该行内：隐藏「控件容器」子元素，保留「端口槽区」子元素。
             * 端口槽区特征：包含 .lg-slot 且宽度很小（w-3）；控件容器是其余那个 div。 */
            const kids = Array.from(row.children);
            const ctrlBox = kids.find((k) => !k.querySelector(".lg-slot"));
            if (ctrlBox) {
                ctrlBox.style.setProperty("display", "none", "important");
            }
            row.setAttribute("data-xzg-a004-switch-row", "1");
            switchRow = row;
            break;   // 本节点只有一个 switch 行
        }
        /* ③ 按键「向上铺满」：开关控件已隐藏，但端口槽区仍把该行撑住（约 17-24px）。
         *   让下方 DOM 按钮行做等量负 margin-top，把这块空白吃掉，按钮紧贴标题。
         *   ★ 端口必须保留：负 margin 只作用于【按钮行】，且给端口行提升层级，
         *     使端口圆点/连线热区仍位于按钮之上，不被遮挡、仍可连线。 */
        collapseSwitchRowSpace(node, root, switchRow);
    }, undefined, "隐藏官方开关控件（保留端口）");
}

/** 让 DOM 按钮行向上「吃掉落」被隐藏开关控件所留下的空白行高（幂等）。
 *
 *  ★ 背景（浏览器实测）：隐藏开关控件「本体」后，同一 `.lg-node-widget` 行里的
 *    端口槽区仍存在，会把这一行撑到约 17-24px，于是按钮上方出现一条空白。
 *    需求「按键覆盖隐藏区域」= 让按钮上移到该空白处。
 *
 *  实现（实测最稳，勿改成负 margin / 绝对定位）：
 *    · 把「端口行」高度压为 0（height:0; min-height:0），它便不再占据文档流高度，
 *      下方 DOM 按钮行自然上移铺满，空白被吃掉；
 *    · 端口行设 overflow:visible —— 端口圆点本就在该行内，溢出仍正常显示，
 *      且端口行保持原 z-index/位置，官方连线热区不受影响、仍可连线；
 *    · 仅隐藏「控件本体」而保留端口（见 hideSwitchWidget ②）。
 *  为何不用负 margin：该行是 grid 子项，负 margin 会被 grid 行高约束，上移量打折
 *  （实测只吃到 11px / 需 17px）；为何不用绝对定位：会与官方标题栏/内边距打架。
 *  每次调用重新测量，节点缩放 / Vue 重建后再次调用即可自愈（配 MutationObserver）。 */
function collapseSwitchRowSpace(node, root, switchRow) {
    if (!root || !switchRow) return;
    /* 端口行高度压 0：不再占位，按钮上移填满；端口靠 overflow 溢出保留。 */
    switchRow.style.setProperty("height", "0", "important");
    switchRow.style.setProperty("min-height", "0", "important");
    switchRow.style.setProperty("overflow", "visible", "important");
    switchRow.setAttribute("data-xzg-a004-btn-covered", "1");
    /* 端口行已压 0 且溢出可见：把端口圆点移到节点左侧垂直居中。 */
    centerSwitchPortVertically(node, root, switchRow);
}

/** 把「开关（端口）」圆点移到节点**左侧垂直居中**位置（幂等）。
 *
 *  ★ 为什么必须做 scale 换算而不能直接相减：
 *    画布内的 `.lg-node` 带有 canvas 缩放（实测 ds.scale≈0.69）。
 *    getBoundingClientRect 返回【屏幕像素】（已被 scale 乘过），
 *    而 style.top 写的是【逻辑像素】（会被 scale 再乘一次）→ 直接相减会差 (1-scale) 倍。
 *    故：屏幕相对顶距 ÷ scale = 逻辑相对顶距；节点逻辑高取 offsetHeight（不含 transform）。
 *
 *  实现：以「整个节点含标题」为参照做垂直居中——
 *    目标逻辑 top = (节点逻辑高 - 端口逻辑高) / 2；
 *    当前逻辑 top = (端口屏幕 top - 节点屏幕 top) / scale；
 *    偏移量 = 目标 - 当前，写进端口 style.top（position:relative）。
 *    每次调用重算并覆盖，节点缩放 / Vue 重建后再次调用即可自愈。
 *  ★ 不用 absolute：会脱离端口行的连线热区上下文，破坏官方连线命中判定。 */
function centerSwitchPortVertically(node, root, switchRow) {
    if (!root || !switchRow) return;
    const slot = switchRow.querySelector(".lg-slot");
    if (!slot) return;
    const nodeLogH = root.offsetHeight;              // 逻辑高（不受 transform 影响）
    const slotLogH = slot.offsetHeight;
    if (!nodeLogH || !slotLogH) return;
    /* 画布缩放：从 canvas.ds 取；取不到则视为 1（退化为直接相减）。 */
    let scale = 1;
    try { scale = (app?.canvas?.ds?.scale) || 1; } catch (e) { scale = 1; }
    if (!scale || scale <= 0) scale = 1;
    /* ★ 关键：先清掉上次写入的 top 偏移，再测「未偏移」的真实布局位置。
     *   否则 getBoundingClientRect 返回的是含偏移后的位置，重算会自相抵消
     *   （shift 收敛为 0 → 端口被弹回顶部）。 */
    slot.style.removeProperty("top");
    const rootTop = root.getBoundingClientRect().top;
    const slotTop = slot.getBoundingClientRect().top;
    const curLogTop = (slotTop - rootTop) / scale;   // 当前逻辑顶距（相对节点根）
    const targetLogTop = (nodeLogH - slotLogH) / 2;  // 垂直居中目标
    const shift = Math.round(targetLogTop - curLogTop);
    slot.style.setProperty("position", "relative");
    slot.style.setProperty("top", `${shift}px`);
    slot.setAttribute("data-xzg-a004-port-centered", "1");
}

/* ═══════════════════════════════════════════════
 *  连接线跟随端口「左侧垂直居中」
 *
 *  ★★ 为什么需要单独 hook（浏览器实测，勿删）：
 *    Nodes 2.0（DOM 模式）下，端口圆点的【视觉位置】由 CSS 控制，
 *    而连接线的【端点坐标】由官方布局系统独立计算（实测：改 input.pos 会被
 *    官方立刻覆盖回原值；CSS 移动 .lg-slot 后 getConnectionPos 调用数为 0）。
 *    二者是两套系统 → 只移圆点，线不跟（线上端点仍钉在节点顶部）。
 *
 *  ★ 实测注入点：画布真正的画线函数是 app.canvas.linkRenderer.renderLinkDirect，
 *    它每帧接收 (ctx, startPoint, endPoint, link, ...)。我们只对「A004 的 switch
 *    连线」把 endPoint.y 改写为『节点垂直居中处』，其它线原样放行。
 *    该 hook 为全局单例（幂等），按 link 的 target_id/target_slot 判定归属，
 *    找不到对应 A004 节点时直接放行（节点被删亦安全）。
 *
 *  ★ 微调常量：A004_LINK_Y_NUDGE —— 在「节点垂直居中」基准上再上移的像素量
 *    （正值 = 上移）。用于人工微调线头与圆点的对齐，按需调整。 */
const A004_LINK_Y_NUDGE = 15;
/* ═══════════════════════════════════════════════ */

/** 判断某条 link 的「目标端」是否落在某个 A004 节点的 switch 输入端口上。
 *  命中返回 {node, slotIndex}，否则 null。 */
/* ★ 连线匹配结果缓存（性能）：renderLinkDirect 每帧、每条 link 都会调用
 *   matchA004SwitchLink，而原实现每次都 allGraphs() 新建集合 + 递归遍历所有图/子图
 *   + 线性查节点。同一条 link 的匹配结果（目标是否 A004 节点 / 命中槽下标）在图结构
 *   不变时恒定；link 对象在重连时会被替换成新对象，故按 link 用 WeakMap 缓存即可，
 *   条目随 link 被 GC，无泄漏。 */
const A004_LINK_MATCH_CACHE = new WeakMap();

function matchA004SwitchLink(link) {
    if (!link || link.target_id == null) return null;
    if (A004_LINK_MATCH_CACHE.has(link)) return A004_LINK_MATCH_CACHE.get(link);
    let result = null;
    try {
        const tid = String(link.target_id);
        const slotIndex = Number(link.target_slot);
        /* 在所有图（含子图）里找目标节点。 */
        for (const g of allGraphs()) {
            const tgt = _getNodeById(g, tid);
            if (!tgt || !isIgnoreGroupNode(tgt)) continue;
            const inp = getSwitchInput(tgt);
            if (!inp) continue;
            /* target_slot 与 switch 输入的下标一致才认（避免误改同节点别的端口）。 */
            const idx = tgt.inputs ? tgt.inputs.indexOf(inp) : -1;
            if (idx !== -1 && (isNaN(slotIndex) || slotIndex === idx)) {
                result = { node: tgt, slotIndex: idx };
                break;
            }
        }
    } catch (e) { /* 忽略：判定失败即放行 */ }
    A004_LINK_MATCH_CACHE.set(link, result);
    return result;
}

/** 给一个 linkRenderer 实例挂「A004 switch 连线端点居中」hook（幂等）。
 *  多个画布/子图可能有各自的 renderer，故对每个实例分别安装。 */
function installA004LinkRendererHook(renderer) {
    if (!renderer || typeof renderer.renderLinkDirect !== "function") return false;
    if (renderer.__a004LinkHooked) return true;
    const orig = renderer.renderLinkDirect;
    renderer.renderLinkDirect = function (ctx, startPoint, endPoint, link, ...rest) {
        let ep = endPoint;
        try {
            if (link && endPoint) {
                const hit = matchA004SwitchLink(link);
                if (hit && hit.node && hit.node.size) {
                    /* 就地改 y（不改数组引用，避免影响官方其它读取）。
                     * 基准 = 节点垂直居中；再按 A004_LINK_Y_NUDGE 上移（y 减小）。 */
                    const centerY = hit.node.pos[1] + hit.node.size[1] / 2 - A004_LINK_Y_NUDGE;
                    endPoint[1] = centerY;
                    ep = endPoint;
                }
            }
        } catch (e) { /* 忽略：异常即放行 */ }
        return orig.call(this, ctx, startPoint, ep, link, ...rest);
    };
    renderer.__a004LinkHooked = true;
    return true;
}

/** 为「主画布 + 所有子图画布」的 linkRenderer 安装 hook（幂等，可多次调用）。 */
function installAllA004LinkRendererHooks() {
    return safeCall(() => {
        const done = [];
        /* 主画布 renderer */
        if (app?.canvas?.linkRenderer) {
            if (installA004LinkRendererHook(app.canvas.linkRenderer)) done.push("main");
        }
        /* 子图画布 renderer（不同 canvas 实例可能各有 renderer）。 */
        try {
            for (const g of allGraphs()) {
                const lr = g?.canvas?.linkRenderer || g?.list_of_graphcanvas;
                if (lr && lr.linkRenderer) installA004LinkRendererHook(lr.linkRenderer);
            }
        } catch (e) { /* 忽略 */ }
        return done;
    }, [], "安装 A004 连接线端点 hook");
}

/** 排程「隐藏开关控件」并**持续守护**：DOM 由 Vue 异步渲染，且可能在任意时刻被重建。
 *
 *  ★ 为什么必须用 MutationObserver（浏览器实测，勿改回纯定时重试）：
 *    · setupDomButton 执行时控件行 DOM 往往还没出现 → 一次性调用会扑空；
 *    · 即便某次隐藏成功，Vue 后续**重建控件行 DOM** 会把内联 display:none 与标记
 *      一起清掉（实测：手动隐藏后触发工作流重载，隐藏即失效）；
 *    · 定时重试链只能覆盖固定窗口，重建若发生在窗口之后就无人兜底。
 *    故这里在节点根上挂一个 MutationObserver：只要控件行出现/重建，就立即重新隐藏。
 *    另叠加一条短重试链，覆盖「节点根 DOM 尚未创建、无法挂 observer」的最早窗口。
 *    全部幂等：重复隐藏只是重设同一个 display:none。 */
function scheduleHideSwitchWidget(node) {
    if (!node) return;
    /* ★ 复用节点（撤销/重做）时复位「已停止」标记：否则上一轮删除留下的标记会让新链立即退出。 */
    node.__a004HideSwStopped = false;
    /* ★ 诊断标记：证明本函数被调用过（节点级，不会被 Vue 重建 DOM 清除）。 */
    node.__a004HideSwCalled = (node.__a004HideSwCalled || 0) + 1;
    /* ① 尽力隐藏一次（DOM 已就绪时立即生效）。 */
    safeCall(() => hideSwitchWidget(node), undefined, "隐藏开关控件（首次）");
    /* ② 尝试挂守护观察器（DOM 未就绪时留待 refreshDomButton / 定时器再试）。 */
    ensureHideSwitchObserver(node);
    if (node.__a004HideSwObserver) return;
    /* ③ 短重试：覆盖「setupDomButton 时 DOM 还没渲染好」的窗口。 */
    if (node.__a004HideSwRetry) return;
    node.__a004HideSwRetry = true;
    let tries = 0;
    const tick = () => {
        /* ★ 节点已销毁（onRemoved 置位）→ 提前退出，避免删除后继续挂 observer / 隐藏已移除的 DOM。 */
        if (node.__a004HideSwStopped) { node.__a004HideSwRetry = false; return; }
        if (node.__a004HideSwObserver) { node.__a004HideSwRetry = false; return; }
        ensureHideSwitchObserver(node);
        hideSwitchWidget(node);
        if (node.__a004HideSwObserver || tries >= 40) { node.__a004HideSwRetry = false; return; }
        tries += 1;
        safeCall(() => setTimeout(tick, 150), undefined, "隐藏开关控件重试");
    };
    safeCall(() => setTimeout(tick, 80), undefined, "隐藏开关控件首拍");
}

/** 找到节点根并挂 MutationObserver（幂等）。找到并挂上返回 true。 */
function ensureHideSwitchObserver(node) {
    if (!node || node.__a004HideSwObserver) return !!node?.__a004HideSwObserver;
    if (typeof MutationObserver === "undefined") return false;
    return !!safeCall(() => {
        let el = null;
        try { el = node._xzgIgDom?.el?.closest?.("[data-node-id]") || null; } catch (e) { el = null; }
        if (!el && node.id != null) el = document.querySelector(`[data-node-id="${node.id}"]`);
        if (!el || el.nodeType !== 1) return false;
        const mo = new MutationObserver(() => { hideSwitchWidget(node); });
        mo.observe(el, { childList: true, subtree: true });
        node.__a004HideSwObserver = mo;
        return true;
    }, false, "挂隐藏开关控件观察器");
}

/** ★ 关键补丁：A004 在「原生子图」内部时，用户在根画布拨的是「外层子图节点」上的
 *  switch 控件（不是 A004 自己的控件）。内部 A004 节点完全收不到该事件，
 *  所以必须给外层子图节点也挂上监听：其 switch 控件变化 → 重新同步子图内所有 A004。
 *  幂等；对每个子图节点挂 ① callback ② onWidgetChanged 两条出口。 */
function hookHostSubgraphSwitches(subgraphNode) {
    if (!subgraphNode || subgraphNode.__a004HostSwHooked) return;
    if (!subgraphNode.subgraph) return;                 // 只处理原生子图节点
    subgraphNode.__a004HostSwHooked = true;
    const refreshInner = () => {
        if (subgraphNode.__a004SilentHostSwitch) return;   // 反向同步期间跳过，断自激
        try {
            clearGroupCache();
            refreshAllDomButtons();
        } catch (e) { /* 忽略 */ }
    };
    const isBoolWidget = (w) => w && (typeof w.value === "boolean");
    const attach = (w) => {
        if (!w || w.__a004HostSwAttached) return;
        w.__a004HostSwAttached = true;
        const o = w.callback;
        w.callback = function (value, ...rest) {
            let r = undefined;
            try { if (typeof o === "function") r = o.call(this, value, ...rest); } catch (e) { /* 忽略 */ }
            refreshInner();
            return r;
        };
    };
    // ① 直接给布尔控件挂 callback
    (subgraphNode.widgets || []).forEach((w) => { if (isBoolWidget(w)) attach(w); });
    // ② onWidgetChanged（新版前端）
    const onWC = subgraphNode.onWidgetChanged;
    subgraphNode.onWidgetChanged = function (name, value, oldValue, widget) {
        const r = onWC ? onWC.apply(this, arguments) : undefined;
        refreshInner();
        return r;
    };
    // ③ 轮询兜底：值快照比对（部分前端版本不触发上面两条）
    if (!subgraphNode.__a004HostSwTimer) {
        const snap = (subgraphNode.widgets || []).filter(isBoolWidget).map((w) => !!w.value);
        subgraphNode.__a004HostLastVals = snap;
        subgraphNode.__a004HostSwTimer = setInterval(() => {
            try {
                if (document.hidden) return;              // 后台标签页跳过轮询
                const ws = (subgraphNode.widgets || []).filter(isBoolWidget);
                const cur = ws.map((w) => !!w.value);
                const last = subgraphNode.__a004HostLastVals || [];
                let diff = cur.length !== last.length;
                if (!diff) for (let i = 0; i < cur.length; i++) { if (cur[i] !== last[i]) { diff = true; break; } }
                if (diff) {
                    subgraphNode.__a004HostLastVals = cur;
                    refreshInner();
                }
            } catch (e) { /* 忽略 */ }
        }, 200);
    }
    /* ★ 宿主子图节点不是 A004 节点，不经过 A004 原型 onRemoved → 必须自挂一次性清理：
     *  否则子图被删除/重建后该 200ms 计时器永久存活，持续全图刷新（内存 + CPU 双泄漏）。
     *  包装时先取实例当前 onRemoved（含原型链/其它已挂清理），再在内部原样转发，保证行为不变。 */
    if (!subgraphNode.__a004HostSwCleanupHooked) {
        subgraphNode.__a004HostSwCleanupHooked = true;
        const prevRemoved = subgraphNode.onRemoved;
        subgraphNode.onRemoved = function () {
            try {
                if (this.__a004HostSwTimer) {
                    clearInterval(this.__a004HostSwTimer);
                    this.__a004HostSwTimer = 0;
                }
            } catch (e) { /* 忽略 */ }
            if (typeof prevRemoved === "function") return prevRemoved.apply(this, arguments);
        };
    }
}

/** 遍历所有图，为其中的子图节点挂 switch 监听（幂等）。 */
function hookAllHostSubgraphs() {
    for (const g of allGraphs()) {
        for (const n of (g._nodes || [])) {
            if (n && n.subgraph) {
                try { hookHostSubgraphSwitches(n); } catch (e) { /* 忽略 */ }
            }
        }
    }
}

/** 刷新单个节点 DOM 按钮的外观与动作 */
function refreshDomButton(node) {
    const dom = node._xzgIgDom;
    if (!dom) return;
    const { label, state, action } = computeDomAction(node);
    dom.btn.textContent = domLines(label).join("\n");
    dom.btn.dataset.state = state;
    dom._action = action;
    dom._group = findInnermostGroupOfNode(node);
    if (dom.syncFont) dom.syncFont();
    // 确保 switch 开关已挂双向联动回调（开关 ↔ 忽略）
    try { hookSwitchWidget(node); } catch (e) { /* 忽略 */ }
    /* ★ 每次刷新都重隐藏开关控件本体（保留端口）：Vue 可能重建控件行 DOM，
     *  重建后内联 display:none 会丢失，这里兜底补一次（幂等）。
     *  同时确保守护观察器已挂（此处 DOM 通常已就绪）。 */
    try { hideSwitchWidget(node); } catch (e) { /* 忽略 */ }
    try { ensureHideSwitchObserver(node); } catch (e) { /* 忽略 */ }
    // ★ 方向判定：
    //   · 若本次是「用户点按键」触发的刷新（__a004BtnToggled）：
    //       不让开关覆盖按键结果 → 跳过 syncFromSwitchPort；
    //       并把按键产生的新组状态「写回」外层宿主开关（按键 → 开关）。
    //   · 否则（拨开关 / 加载 / 其他刷新）：走「开关 → 按键」，用开关值驱动组状态。
    const byButton = !!node.__a004BtnToggled;
    node.__a004BtnToggled = false;
    if (!byButton) {
        // 连线才控制：若 switch 端口接了上游，值变化时驱动忽略逻辑（内部自带断环）
        try { syncFromSwitchPort(node); } catch (e) { /* 忽略 */ }
    }
    // 按钮状态变化后，把 switch 布尔值同步为「目标组是否已忽略」
    // ★ 无论 byButton 与否都执行：按键路径下也要把内层 switch widget 拨到与组状态一致，
    //   否则「按按键改变了组、但开关没跟着动」。其内部的就绪门控负责挡住组未就绪的窗口，
    //   不会再把「快照 false」误写成 true。
    syncSwitchFromState(node);
    // ★ 按键 → 外层宿主开关：把本节点组状态同步回「外层子图节点」的 switch 控件
    try { syncSwitchHostFromState(node); } catch (e) { /* 忽略 */ }
}

/** 刷新所有已挂载 DOM 按钮的 A004 节点（组结构/忽略状态变化后调用） */
function refreshAllDomButtons() {
    // 顺带确保「外层子图节点的 switch 监听」已挂（幂等，覆盖后加载的子图节点）
    try { hookAllHostSubgraphs(); } catch (e) { /* 忽略 */ }
    let any = false;
    for (const g of allGraphs()) {
        for (const n of (g._nodes || [])) {
            if (isIgnoreGroupNode(n) && n._xzgIgDom) { refreshDomButton(n); any = true; }
        }
    }
    return any;
}

/** 为节点挂载 DOM 按钮 widget */
function setupDomButton(node) {
    // 幂等：节点已在（重复创建/工作流加载）时跳过，避免重复挂载 widget
    if (node._xzgIgDom) return;
    injectDomCss();
    const el = document.createElement("div");
    el.className = "xzg-ig-dom";
    const btn = document.createElement("button");
    btn.className = "xzg-ig-btn";
    el.appendChild(btn);
    const widget = node.addDOMWidget("xzg_ig_ui", "ignore_group_dom", el, {
        serialize: false,
        hideOnZoom: false,
        // 布局高度策略（兼容 Nodes 2.0 与 legacy 画布）：
        // - 不设最小高度，getMinHeight 取极低值，仅保证有空间可显示；
        // - getMaxHeight 跟随节点高度，供 Nodes 2.0 的 distributeSpace 分配，让按钮铺满内容区。
        getMinHeight: () => 10,
        getMaxHeight: () => Math.max(10, (node.size?.[1] ?? DEFAULT_H) - TITLE_H),
    });
    // 布局：switch 开关控件显示在顶部一行，DOM 大按钮排在其下方（不再覆盖开关）。
    // 不设 widgets_start_y，让 DOM widget 按 node.widgets 顺序自然排在 switch 之后。
    // 绑定 switch 开关的双向联动回调（开关 ↔ 忽略，幂等）+ 连线监听（连线才控制）
    try { hookSwitchWidget(node); } catch (e) { /* 忽略 */ }
    try { hookSwitchConnection(node); } catch (e) { /* 忽略 */ }
    /* ★ 隐藏官方布尔开关控件本体（保留其 socket 端口，可连线）。
     *  DOM 由 Vue 异步渲染、可能晚于本函数，故走「重试排程」命中即停。 */
    try { scheduleHideSwitchWidget(node); } catch (e) { /* 忽略 */ }
    // 单击逻辑
    const doSingleClick = () => {
        const dom = node._xzgIgDom;
        if (!dom?._action) return;
        // ★ 标记本次刷新由「按键点击」触发：refreshDomButton 据此跳过开关→按键覆盖，
        //   并反向把新组状态写回外层宿主开关（实现「按键也能控制开关」的双向联动）。
        node.__a004BtnToggled = true;
        // \u2605 目标图统一取「节点所属图」：A004 在原生子图内时，组操作必须作用于子图 LGraph
        const g = graphOf(node);
        /* ★ 与 computeDomAction 的唯一产出集合保持一致（2026-10-05 清理）：
         *  原 toggleInnermost / ignoreGroupTree / toggleOnly 三个分支永不触发
         *  （computeDomAction 只返回 unignoreAll / ignoreAll / toggleSubgroup / ignoreOthers），
         *  对应函数已一并删除。此处 4 个 case 与产出集合一一对应。 */
        switch (dom._action) {
            case "ignoreOthers":    ignoreOthers(dom._group, g);      break;
            case "toggleSubgroup":  toggleSubgroup(dom._group);       break;
            case "ignoreAll":       ignoreAll(g);                     break;
            case "unignoreAll":     unignoreAll(g);                   break;
        }
        // 状态变化后刷新所有 A004 DOM 按钮，保持多节点一致
        refreshAllDomButtons();
    };
    /* ★ 具名句柄：匿名闭包无法 removeEventListener，节点移除时若元素未被框架回收会强引用 node。 */
    const onBtnClick = () => { doSingleClick(); };
    btn.addEventListener("click", onBtnClick);
    // 字号：按钮区高度 ×25%（下限8px），宽度溢出按比例缩小
    const syncFont = () => {
        const nodeH = node.size?.[1] || DEFAULT_H;
        const areaH = Math.max(8, (nodeH - TITLE_H) - PAD * 2);
        const fontFace = '"Microsoft YaHei","微软雅黑","PingFang SC",Arial,sans-serif';
        let size = Math.max(8, Math.floor(areaH * 0.25));
        const availW = Math.max(10, (el.clientWidth || DEFAULT_W) - PAD * 2);
        const ctx2d = syncFont._ctx || (syncFont._ctx = document.createElement("canvas").getContext("2d"));
        ctx2d.font = `600 ${size}px ${fontFace}`;
        let w = 0;
        for (const l of (btn.textContent || "").split("\n")) {
            w = Math.max(w, ctx2d.measureText(l).width);
        }
        const maxW = availW * 0.9;
        if (w > maxW) size = Math.max(6, Math.floor(size * (maxW / w)));
        btn.style.fontSize = size + "px";
        /* ★ 每次字号/尺寸重算时顺带重收拢「按钮上移覆盖隐藏空白」：
         *   节点缩放、Vue 重建后行高会变，需按当前端口行高重新测并覆盖负 margin。 */
        try { hideSwitchWidget(node); } catch (e) { /* 忽略 */ }
    };
    node._xzgIgDom = { el, btn, widget, syncFont, onClick: onBtnClick, _action: null, _group: null, ro: null };
    // 给「所有图」（含子图）补挂 change 监听（去重）：子图内部组/节点结构变化也能刷新按钮
    try { for (const g of allGraphs()) hookGraphOnChange(g); } catch (e) { /* 忽略 */ }
    refreshDomButton(node);
    // 字体随节点缩放动态更新 + 首次挂载后强制重绘，确保覆盖层定位与字号正确
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(syncFont);
        ro.observe(el);
    }
    node._xzgIgDom.ro = ro;
    requestAnimationFrame(() => {
        syncFont();
        app.canvas?.setDirty?.(true, true);
    });
}

app.registerExtension({
    name: EXTENSION_NAME,
    // 新建节点：直接挂 DOM 按钮
    // Nodes 2.0：nodeCreated 在构造函数内触发，此时 node.type 尚未赋值，须用 comfyClass 判断
    nodeCreated(node) {
        if (isIgnoreGroupNode(node)) setupDomButton(node);
    },
    // 工作流加载/反序列化路径可能不触发 nodeCreated，补挂一次（幂等）
    loadedGraphNode(node) {
        if (!isIgnoreGroupNode(node)) return;
        setupDomButton(node);
        /* ★ 加载后强制校正：switch 值由组状态派生，不采信存档/回灌进来的值。 */
        node.__a004NeedReconcile = true;
        // 打开工作流后布局 store 就绪有延时：多次重刷，确保按钮状态与真实组状态一致
        // （修复「刷新/打开后原本蓝色的组变成灰色」）
        [0, 60, 200, 500, 1200].forEach((ms) => {
            setTimeout(() => {
                try { clearGroupCache(); refreshDomButton(node); } catch (e) { /* 忽略 */ }
            }, ms);
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;


        /* ══ onNodeCreated：初始化内部状态 + 兜底补挂 DOM 按钮 ══ */
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated ? origCreated.apply(this, arguments) : undefined;
            // Nodes 2.0：createNode 在 node.type 赋值后才调用 onNodeCreated，此处兜底补挂（幂等）
            try { setupDomButton(this); } catch (e) { /* 忽略 */ }
            this.serialize_widgets = false;
            /* ★ 标记「首次就绪后强制校正一次 switch」：本开关的值应由组状态派生，
             *   不采信存档 / 外层提升控件回灌进来的值（历史污染会把 true 写进来）。
             *   新建节点也设此标记无害 —— 就绪后按组状态算出正确值并写入。 */
            this.__a004NeedReconcile = true;
            // 仅在尚无尺寸时给一下子默认；已有尺寸（如加载工作流）则保留，不再覆盖
            if (!this.size || !this.size[0]) {
                this.setSize(this.computeSize());
            }
            this.setDirtyCanvas(true, true);
            return r;
        };

        /* ══ configure：官方反序列化钩子。A004 常被放进原生子图，
         *  子图重建走 sg.configure(data) 时【不触发】扩展的 loadedGraphNode，
         *  故这里显式补设「加载后强制校正」标记，确保存量污染值必被纠正。
         *  ★ 判据用「是否走过 configure」而非 widgets_values_named：
         *    A004 自身 serialize_widgets=false，其 widgets_values_named 恒为 null，
         *    但反向的「外层提升控件回灌」照样会污染它的 switch widget。 ══ */
        const origConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
            /* 无条件标记：能进 configure 就说明是「反序列化/加载」路径（新建节点不走这里）。 */
            this.__a004NeedReconcile = true;
            return r;
        };

        /* ══ computeSize：不再强制/兜底固定尺寸。
         *  优先返回节点当前实际尺寸（this.size），保证自由缩放不被拉回；
         *  仅当尚无尺寸时用 DEFAULT 作初始默认。 */
        const origCS = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (width) {
            if (this.size && this.size[0] && this.size[1]) return this.size.slice();
            let r = origCS ? origCS.apply(this, arguments) : null;
            if (!r || !r[0] || !r[1]) r = [DEFAULT_W, DEFAULT_H];
            return r;
        };

        /* ══ onRemoved：清理（ResizeObserver 防泄漏） ══ */
        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (origRemoved) origRemoved.apply(this, arguments);
            const dom = this._xzgIgDom;
            if (dom) {
                if (dom.ro) dom.ro.disconnect();
                dom.ro = null;
                /* ★ 显式解绑具名 click 监听：框架若不移除元素，闭包会强引用 node → 泄漏。 */
                try { if (dom.btn && dom.onClick) dom.btn.removeEventListener("click", dom.onClick); } catch (e) { /* 忽略 */ }
                this._xzgIgDom = null;
            }
            // 清理 switch 轮询兜底定时器，避免内存泄漏
            if (this.__a004SwitchPollTimer) {
                clearInterval(this.__a004SwitchPollTimer);
                this.__a004SwitchPollTimer = null;
            }
            /* ★ 复位「组状态曾就绪」标记：节点对象会被撤销/重做复用，
             *  残留 true 会让 isGroupStateReady 在复用初期误放行（组信息尚未就绪时）。 */
            this.__a004GroupEverReady = false;
            /* ★ 复位「加载后强制校正」标记：复用节点时重新按需触发一次校正，
             *  避免残留 true 造成后续多余的强制写入。 */
            this.__a004NeedReconcile = false;
            /* ★ 断开「隐藏开关控件」守护观察器，避免节点被移除后泄漏。 */
            if (this.__a004HideSwObserver) {
                try { this.__a004HideSwObserver.disconnect(); } catch (e) { /* 忽略 */ }
                this.__a004HideSwObserver = null;
            }
            /* ★ 停止「隐藏开关」短重试链：置位让 tick 下一拍提前退出，并复位排程标记，
             *  否则节点删除后最多 40×150ms 内仍会对已移除节点重复挂 observer。 */
            this.__a004HideSwStopped = true;
            this.__a004HideSwRetry = false;
        };
    },
    /* ══ setup：监听 graph 结构变化，让节点-组缓存自动失效 ══ */
    setup() {
        // 给「所有图」（含子图）挂 onChange，确保子图内组结构/忽略状态变化也能刷新按钮
        try { for (const g of allGraphs()) hookGraphOnChange(g); } catch (e) { /* 忽略 */ }
        /* ★ 安装「连接线端点跟随端口居中」的 linkRenderer hook。
         *  linkRenderer 可能晚于 setup 创建，故多次延时重试（install 幂等）。 */
        [0, 200, 800, 2000].forEach((ms) => {
            setTimeout(() => { try { installAllA004LinkRendererHooks(); } catch (e) { /* 忽略 */ } }, ms);
        });
        // 启动后多次延时重刷：等布局 store 就绪，把加载瞬间误判为「不在组内」的按钮校正回来
        [0, 60, 200, 500, 1200, 2500].forEach((ms) => {
            setTimeout(() => {
                try { clearGroupCache(); refreshAllDomButtons(); } catch (e) { /* 忽略 */ }
            }, ms);
        });
    },
});