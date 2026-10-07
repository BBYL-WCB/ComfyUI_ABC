// ═══════════════════════════════════════════════════════════════
//  A001_子图节点 · 插槽同步簇（拆分自 A001_SubgraphNode.js）
//
//  职责：把子图内部 inputNode/outputNode 的插槽（增删/改名/连接）实时同步到
//  外层节点的端口，并为「提升控件」建立外层宿主槽的即时绑定地基。
//
//  本簇包含：
//    · 外层端口 ⇄ 子图槽的对齐（_matchOuterSlot / _alignSlotsOneWay / syncSlotsInitial）
//    · 槽查找与链接解析工具（_findOuterSlotBySubgraphSlotId / _resolveSgLink 等）
//    · 子图插槽事件监听装配（attachSlotSync / detachSlotSync 及 6 个处理器工厂）
//    · 提升控件的即时绑定（_bindFromWidgetSlot / _bindPromotedForSubgraphInput）
//
//  ⚠️ 行为保持约束：本文件内的实现与原 A001_SubgraphNode.js 中同名成员**逐字一致**
//  （含判据、日志文案、幂等语义、事件名与注册顺序）。仅做了「位置的搬迁」，
//  未改动任何逻辑、默认值与文案。
//
//  依赖方向：只依赖 A001_shared.js（A001 唯一共享层，底层工具）与下述注入的跨簇能力。
// ═══════════════════════════════════════════════════════════════

import {
    alog,
    safeCall,
    dirtyCanvas,
    isNodeInGraphSilent as isNodeInGraph,
    buildA001SourceRef,
    getSgNodes,
    isConstId,
} from "./A001_shared.js?v=20261007a";

/* ════════════════════════════════════════════════
 *  跨簇依赖注入
 *
 *  本簇在「提升控件」路径上要调用提升簇的函数（createPromotedHostWidget /
 *  mountPromotedWidget / writePromotedPersist / touchA001Inputs）。这些函数仍留在
 *  A001_SubgraphNode.js（提升控件投影簇），若直接 import 会形成「入口 ⇄ 本簇」
 *  循环依赖 —— 与项目既有的 initAppearanceDeps / initRunDeps 同一范式，
 *  改由入口在 queueMicrotask 中注入，避免环。
 * ════════════════════════════════════════════════ */

let _deps = {
    createPromotedHostWidget: null,
    mountPromotedWidget: null,
    writePromotedPersist: null,
    touchA001Inputs: null,
};

/** 由 A001_SubgraphNode.js 注入提升簇能力（幂等）。 */
export function initSlotDeps(deps) {
    if (!deps) return;
    _deps = Object.assign(_deps, deps);
}

/* ════════════════════════════════════════════════
 *  1.5 · 必要插槽同步：外层端口 ⇄ 子图 inputNode/outputNode 插槽
 *  ════════════════════════════════════════════════ */

function _matchOuterSlot(outerSlots, so) {
    // 1) id 精确匹配（最可靠）
    let outer = outerSlots.find((s) => s._a001SubgraphSlotId === so.id);
    if (outer) return outer;
    // 2) 名称 / label 匹配（新建节点由 Schema 生成的同名端口）
    outer = outerSlots.find(
        (s) => s.name === so.name || s.label === so.label || s.label === so.name
    );
    if (outer) return outer;
    /* ★★ 不再做「同序号兜底复用」（原第 3 条）。
     * 实测（浏览器数据层，2026-09-24）证明该兜底是端口错乱/丢失的直接元凶：
     * 官方 SubgraphNode.configure 镜像重建后，外层 node.inputs 可能处于残缺态
     * （如只剩 images_1/images_3/images_5），此时按「位置相同」强行配对本就
     * 名不对位——随后 _alignSlotsOneWay 会用 sg 槽名覆盖外层槽名，
     * 造成「名字与槽位全错位 + 该新建的槽被复用 + 多余的槽被 removeInput 误删」。
     * 正确语义：外层端口【只承认】与子图槽精确对应（id/name/label）者，
     * 匹配不到就按子图槽顺序新建，绝不按下标猜测身份。 */
    return undefined;
}

/** ★ 给外层带控件的输入槽打上官方「widget 化」标记。
 * 实证（官方前端产物 settingStore）：
 *   outerInput.widget = { name } —— 让官方把该槽判定为「由控件承载」(widgeted)
 * 官方渲染逻辑：NodeSlots 的 inputs = nonWidgetedInputs() + linkedWidgetedInputs()，
 * 「是否 widgeted」只看槽上的 input.widget（及其 name），【不是】widgetId；
 * 带控件槽默认不进普通端口列表 → 不画圆点，改在槽位渲染控件。
 * 注意：widgetId 只是控件值存储/去重的身份（getWidgetIdentity），不参与该判定，
 * 由 bindOfficialPromotedWidget 另行写入；本函数只保证 widget 载体存在。 */
function _markOuterInputAsWidget(outerInput, name) {
    if (!outerInput || !name) return;
    const n = String(name);
    if (!outerInput.widget) outerInput.widget = { name: n };
    else if (outerInput.widget.name == null) outerInput.widget.name = n;
    if (!outerInput.label) outerInput.label = n;
}
export { _markOuterInputAsWidget as markOuterInputAsWidget };

/** 单向对齐：把子图 sgSlots 的插槽同步到外层 outerSlots。
 * 注意：sg 必须显式传入（用于 _sgInputSlotCarriesWidget 判断带控件）。
 *
 * ★★ 语义（2026-09-24 按浏览器实测重写）：
 *   子图槽 sgSlots 是【唯一真源】。外层端口的数量与顺序必须与 sgSlots 完全一致。
 *   原实现「逐个匹配/新建（新建只追加到末尾）+ 末尾删除多余」有两个致命缺陷：
 *     ① 新建槽永远追加在末尾 → 端口顺序与子图槽顺序不符（用户实测：顺序错乱）；
 *     ② 官方镜像重建后外层处于残缺态，靠 _matchOuterSlot 的下标兜底强行配对
 *        （见 _matchOuterSlot 注释），导致该新建的槽被复用、多余的槽被误删。
 *   新实现：先按 sgSlots 顺序求出「目标端口对象数组」（匹配到的复用 + 匹配不到的
 *   新建），再把它整体写回 node.inputs / node.outputs —— 数量、顺序一次性对齐；
 *   最后仅对「未进入目标数组的旧槽」做移除，且移除时按对象引用定位，不按索引猜。 */
function _alignSlotsOneWay(node, sg, sgSlots, outerSlots, isInput) {
    const arr = outerSlots || [];
    const used = new Set();
    const target = [];
    for (let i = 0; i < sgSlots.length; i++) {
        const so = sgSlots[i];
        if (!so) continue;
        const carriesWidget = isInput && _sgInputSlotCarriesWidget(sg, so);
        /* ★ 对齐官方子图节点的「带控件插槽」表达方式（实证来自本机 004 + 官方产物）：
         * 官方节点(33)的 inputs 里 seed 槽依然存在，形如
         *   { name:"seed", type:"INT", widget:{name:"seed"}, widgetId:"<graphId>:<nodeId>:seed" }
         * 官方前端 NodeSlots 渲染列表 = nonWidgetedInputs() + linkedWidgetedInputs()，
         * 依据槽上的 input.widget 判定「由控件承载」；带控件槽默认不进普通端口列表，
         * 于是「不画圆点端口、改在槽位渲染控件」。
         * 因此本节点必须【保留外层端口槽】——它是 input.widget 与 widgetId 的载体，
         * 投影层（installA001WidgetProjection 的 widgets getter）正是遍历 inputs 找 widgetId。
         * 一旦删除该端口，载体丢失，序列化/反序列化后控件即无法恢复。
         * 正确做法：保留槽 + 打上 widget 标记，由官方机制隐藏圆点。 */
        const outer = _matchOuterSlot(arr, so);
        let slot;
        if (outer) {
            used.add(outer);
            slot = outer;
        } else if (isInput) {
            const added = node.addInput(so.name, so.type, { _a001SubgraphSlotId: so.id });
            slot = added || (node.inputs || [])[node.inputs.length - 1];
        } else {
            slot = node.addOutput(so.name, so.type, { _a001SubgraphSlotId: so.id });
            if (!slot) slot = (node.outputs || [])[node.outputs.length - 1];
        }
        if (!slot) continue;
        used.add(slot);
        /* 槽属性以子图槽为准（名字/标签/类型），保证外层与内层严格对应。
         * 注意：先清掉可能残留的错误 widget 标记，再按 carriesWidget 决定是否重打 ——
         * 若不清，残缺态下被错配过的槽会带着上一个槽的 widget 名（实测曾出现
         * images_4 被打上 widget:"steps"）。 */
        slot._a001SubgraphSlotId = so.id;
        slot.name = so.name;
        slot.label = so.label ?? so.name;
        slot.localized_name = so.name;
        if (so.type) slot.type = so.type;
        if (!carriesWidget && slot.widget && slot._a001Source == null && slot.widgetId == null) {
            try { slot.widget = null; } catch (_e) { /* 只读槽位，忽略 */ }
        }
        if (carriesWidget) _markOuterInputAsWidget(slot, so.name);
        target.push(slot);
    }
    /* 移除「未进入目标数组」的旧槽（按对象引用定位，不按下标猜）。
     * 用 removeInput/removeOutput 以维持官方内部结构一致；逐个删到列表干净为止。 */
    const stale = arr.filter((s) => s && !used.has(s));
    for (const s of stale) {
        const list = isInput ? node.inputs : node.outputs;
        const idx = (list || []).indexOf(s);
        if (idx < 0) continue;
        if (isInput) node.removeInput(idx);
        else node.removeOutput(idx);
    }
    /* ★ 整体重排：把 target 顺序写回外层列表。
     * 仅在顺序确有差异时重排，避免无谓触发监听与重绘。
     * 用就地 splice 改写同一数组，保持 node.inputs 的数组引用不变
     * （官方 configure/渲染持有该引用，整体替换会导致引用不一致）。 */
    const list = isInput ? node.inputs : node.outputs;
    if (Array.isArray(list)) {
        const sameOrder = list.length === target.length && list.every((s, i) => s === target[i]);
        if (!sameOrder) {
            list.length = 0;
            for (const s of target) list.push(s);
        }
    }
}

/** 初始插槽对齐：让外层节点端口与子图 inputNode/outputNode 插槽一一对应。 */
export function syncSlotsInitial(node) {
    const sg = node.subgraph;
    if (!sg) return;
    node.inputs = node.inputs || [];
    node.outputs = node.outputs || [];
    _alignSlotsOneWay(node, sg, sg.inputs || [], node.inputs, true);
    _alignSlotsOneWay(node, sg, sg.outputs || [], node.outputs, false);
    dirtyCanvas(node);
}

function _outerSlotIndexById(outerSlots, subgraphSlotId) {
    /* ★ 改为复用 _findOuterSlotBySubgraphSlotId 的 String() 归一比较：
     *  原实现用严格 ===，会因槽 id 数字/字符串差异找不到（与其它 6 处查找口径不一致，
     *  导致 onSlotRemoving 不删端口）。 */
    if (subgraphSlotId == null) return -1;
    const arr = outerSlots || [];
    return arr.findIndex((s) => String(s?._a001SubgraphSlotId) === String(subgraphSlotId));
}

/** ★ 按子图槽 id 在外层槽列表里查槽（统一 6 处重复的字面量查找）。
 *  容忍 id 的字符串/数字差异，故统一 String() 归一后比较。 */
export function findOuterSlotBySubgraphSlotId(outerSlots, subgraphSlotId) {
    if (subgraphSlotId == null) return null;
    const arr = outerSlots || [];
    return arr.find((s) => String(s?._a001SubgraphSlotId) === String(subgraphSlotId)) || null;
}
/* 本模块内部按原短名调用（搬迁前口径不变）。 */
const _findOuterSlotBySubgraphSlotId = findOuterSlotBySubgraphSlotId;

/** ★ 按 id 在子图槽列表（sg.inputs 等）里查槽，同上归一比较。 */
export function findSgSlotById(sgSlots, slotId) {
    if (slotId == null) return null;
    const arr = sgSlots || [];
    return arr.find((i) => String(i?.id) === String(slotId)) || null;
}
const _findSgSlotById = findSgSlotById;

/**
 * 判断子图 input 槽是否「已带提升控件」（= 它反查到的内层真实节点输入槽上有 widget）。
 * 依据：官方 LLink.resolve(sg) 返回 { inputNode, input }，再用
 * inputNode.getWidgetFromSlot(input) 取到 widget 即视为「带控件」。
 * 这类槽的控件已由提升机制在外层渲染，attachSlotSync 同步时应跳过，避免多出一个空端口。
 */
/* ★ 抽出的公共退化链：由链接解析逐级退化到槽 id / 槽对象查询。
 *  同一段退化逻辑原先在 _collectSgLinkIds 与 resolveA001PromotedSource 两处各写一份，
 *  此处抽为公共函数，二者共用同一份判定口径。
 *   _sgInputSlotCarriesWidget 与 resolveA001PromotedSource 两条路径都需要
 *   「按链接 id 取子图链接对象（兼容官方 getLink / links 映射 / links 数组三种
 *    形态）」。此处收敛为单一实现，两处调用方仅通过 tag 参数区分日志文案。
 *
 * @param {object} sg 子图
 * @param {number|string} linkId 链接 id
 * @param {string} tag 日志标记（区分调用来源）
 * @returns {object|undefined} 链接对象
 */
export function resolveSgLink(sg, linkId, tag) {
    if (linkId == null) return undefined;
    return typeof sg.getLink === "function"
        ? safeCall(() => sg.getLink(linkId), undefined, tag + " getLink")
        : (typeof sg.links === "object" && sg.links !== null && !Array.isArray(sg.links)
            ? sg.links[linkId]
            : Array.isArray(sg.links) ? sg.links.find((l) => l?.id === linkId) : undefined);
}

/** 收集一个 SubgraphInput 槽上的全部链接 id（兼容 getLinks() 与 linkIds 两种形态）。 */
export function collectSgLinkIds(slot) {
    return (typeof slot.getLinks === "function" ? slot.getLinks() : [])
        .concat(Array.isArray(slot.linkIds) ? slot.linkIds : [])
        .map((l) => (typeof l === "object" ? l.id : l));
}

function _sgInputSlotCarriesWidget(sg, slot) {
    if (!sg || !slot) return false;
    const linkIds = collectSgLinkIds(slot);
    const innerNodes = getSgNodes(sg);
    for (const linkId of linkIds) {
        const sub = resolveSgLink(sg, linkId, "slot 判控件");
        if (!sub) continue;
        const official = safeCall(() => sub.resolve?.(sg), null, "slot 判控件 resolve");
        if (official?.inputNode && official?.input && !isConstId(official.inputNode.id)) {
            const w = safeCall(
                () => official.inputNode.getWidgetFromSlot?.(official.input),
                null,
                "slot 判控件取 widget"
            );
            if (w) return true;
        }
        // 兜底：target_id / target_slot 反查匹配到 inner node 的输入槽
        if (sub.target_id != null && !isConstId(sub.target_id)) {
            const tn = innerNodes.find((n) => String(n?.id) === String(sub.target_id));
            const tSlotIdx = sub.target_slot != null ? Number(sub.target_slot) : null;
            const ts = tn && tSlotIdx != null && Number.isFinite(tSlotIdx)
                ? (tn.inputs || [])[tSlotIdx] : null;
            if (ts && ts.widget?.name != null) return true;
        }
    }
    return false;
}
export { _sgInputSlotCarriesWidget as sgInputSlotCarriesWidget };

/** 已挂 input-connected 监听的 SubgraphInput 实例（SubgraphInput 是 class 实例，不能挂自有属性）。*/
const A001_WATCHED_INPUTS = new WeakSet();
/** SubgraphInput 实例 → 其 input-connected 处理器，供反注册。 */
const A001_INPUT_HANDLERS = new WeakMap();

/** 监听子图插槽事件：内部增删/改名插槽时实时同步到外层端口。
 * 【为提升提供即时生效地基】官方提升链路在 addInput 派发 input-added 那一刻
 * connect 还没跑、linkIds 仍空；connect 派发 input-connected 时 linkIds.push 也
 * 未执行。所以同时监听 SubgraphInput 实例自己的 'input-connected'，其 payload 直接
 * 携带内层 widget 对象，立即建投影。 */
/** ★ 提升控件延迟补绑的「下一帧重试」步骤（原为 bindPromotedForSubgraphInput 内的匿名闭包）。
 *  抽离目的：把 6-8 层缩进压平，并让重试逻辑可单独阅读/复用。
 *  语义与原实现完全一致：先取节点在当前图中的存活性与最新外层槽，再以 retry=false 重入。 */
function _retryBindPromotedNextFrame(node, bindPromotedForSubgraphInput, subgraphInput, slotId) {
    safeCall(
        () => window.requestAnimationFrame(() => {
            if (!isNodeInGraph(node)) return;
            const fresh = _findOuterSlotBySubgraphSlotId(node.inputs, slotId);
            if (!fresh) return;
            safeCall(
                () => bindPromotedForSubgraphInput(subgraphInput, fresh, false),
                undefined,
                "提升控件延迟补绑"
            );
        }),
        undefined,
        "提升控件延迟补绑排程"
    );
}

export function attachSlotSync(node) {
    const sg = node.subgraph;
    const prev = node._a001SyncedSg;
    if (prev === sg) return;
    if (prev) {
        detachSlotSync(node);
        node._a001SyncedSg = null;
    }
    if (!sg?.events) return;
    node._a001SyncedSg = sg;
    const ev = sg.events;

    node._a001SlotHandlers = [
        ["input-added", _makeA001OnSlotAdded(node, sg, true)],
        ["removing-input", _makeA001OnSlotRemoving(node, true)],
        ["output-added", _makeA001OnSlotAdded(node, sg, false)],
        ["removing-output", _makeA001OnSlotRemoving(node, false)],
        ["renaming-input", _makeA001OnSlotRenaming(node, true)],
        ["renaming-output", _makeA001OnSlotRenaming(node, false)],
    ];
    for (const [evn, h] of node._a001SlotHandlers) ev.addEventListener(evn, h);

    for (const s of sg.inputs || []) {
        safeCall(() => _watchA001SubgraphInputConnect(node, sg, s), undefined, "存量槽补挂连接监听");
    }
}

/* ─── attachSlotSync 的分解体（函数级拆分：仅搬代码，零逻辑改动） ───
 * 原实现把 6 个闭包全部内联在 attachSlotSync 内（单函数近 190 行、最深 8 层缩进）。
 * 这里把闭包外提为模块级函数：原先由闭包捕获的 node / sg 改为显式参数传入，
 * 调用时机、判据、日志文案、幂等语义均与原实现逐字等价。 */

/** 用内层 widget 在外层槽上建立提升控件（原 bindFromWidget 闭包）。 */
function _bindFromWidgetSlot(node, sg, subgraphInput, outerInput, widget) {
    if (!subgraphInput || !outerInput || !widget || !sg) return false;
    if (outerInput._a001OfficialWidgetId) return false;
    outerInput._a001Source = buildA001SourceRef(
        widget._a001OwnerNodeId ?? widget.nodeId ?? null,
        widget.name
    );
    const hostWidget = _deps.createPromotedHostWidget(widget, node);
    if (!hostWidget) return false;
    if (hostWidget._a001SourceWidget) {
        hostWidget._a001SourceWidget.nodeId =
            outerInput._a001Source.nodeId ?? hostWidget._a001SourceWidget.nodeId;
    }
    _deps.mountPromotedWidget(node, outerInput, hostWidget);
    _deps.writePromotedPersist(node);
    _deps.touchA001Inputs(node);
    dirtyCanvas(node);
    return true;
}

/** 按子图输入槽的链接解析出内层 widget 并绑定（原 bindPromotedForSubgraphInput 闭包）。
 *  链接尚未建立（linkIds 为空）时可 retry=true 排到下一帧重试一次。 */
function _bindPromotedForSubgraphInput(node, sg, subgraphInput, outerInput, retry) {
    if (!subgraphInput || !sg) return;
    const linkIds = subgraphInput.linkIds || [];
    const linkId = linkIds[0];
    if (linkId === undefined) {
        if (!retry || typeof window === "undefined") return;
        _retryBindPromotedNextFrame(
            node,
            (si, outer) => _bindPromotedForSubgraphInput(node, sg, si, outer, false),
            subgraphInput,
            subgraphInput.id
        );
        return;
    }
    if (!outerInput) {
        outerInput = _findOuterSlotBySubgraphSlotId(node.inputs, subgraphInput.id);
        if (!outerInput) return;
    }
    if (outerInput._a001OfficialWidgetId) return;
    const link = sg.getLink?.(linkId) ?? (sg._links?.get?.(linkId));
    if (!link) return;
    const resolved = safeCall(() => link.resolve(sg), null, "提升解析内层链接");
    const inputNode = resolved?.inputNode;
    const innerSlot = resolved?.input;
    if (!inputNode || !innerSlot) return;
    const widget = safeCall(() => inputNode.getWidgetFromSlot?.(innerSlot), null, "提升取内层 widget");
    if (!widget) return;
    widget._a001OwnerNodeId = inputNode.id;
    _bindFromWidgetSlot(node, sg, subgraphInput, outerInput, widget);
}

/** 监听单个子图输入槽的 input-connected 事件（原 watchSubgraphInputConnect 闭包）。 */
function _watchA001SubgraphInputConnect(node, sg, subgraphInput) {
    if (!subgraphInput?.events?.addEventListener) return;
    /* SubgraphInput 是 class 实例，不能挂自有属性 → 用模块级 WeakSet/WeakMap 记账。 */
    if (A001_WATCHED_INPUTS.has(subgraphInput)) return;
    A001_WATCHED_INPUTS.add(subgraphInput);
    const onConn = (e) => {
        safeCall(() => {
            if (!isNodeInGraph(node)) return;
            const outer = _findOuterSlotBySubgraphSlotId(node.inputs, subgraphInput.id);
            if (!outer) return;
            const widget = e?.detail?.widget ?? e?.widget ?? null;
            if (widget) _bindFromWidgetSlot(node, sg, subgraphInput, outer, widget);
            else _bindPromotedForSubgraphInput(node, sg, subgraphInput, outer, true);
        }, undefined, "子图槽连接事件");
    };
    A001_INPUT_HANDLERS.set(subgraphInput, onConn);
    subgraphInput.events.addEventListener("input-connected", onConn);
}

/** 内部新增输入/输出槽 → 同步到外层端口（工厂式，原闭包外提）。 */
function _makeA001OnSlotAdded(node, sg, isInput) {
    return () => {
        safeCall(() => {
            if (!isNodeInGraph(node)) return;
            syncSlotsInitial(node);
            /* 新增输入槽若已带控件（提升链路），立即尝试绑定投影。 */
            if (isInput) {
                for (const s of sg.inputs || []) {
                    const outer = _findOuterSlotBySubgraphSlotId(node.inputs, s.id);
                    if (outer && !outer._a001OfficialWidgetId
                        && !(node.inputs || []).some((i) => i && i._a001Source
                            && String(i._a001SubgraphSlotId) === String(s.id))) {
                        _bindPromotedForSubgraphInput(node, sg, s, outer, true);
                    }
                }
            }
            /* ★ 插槽增删会改变端口几何 → 补一次胶囊刷新（尺寸/端点跟随）。 */
            safeCall(() => node._a001RefreshPorts?.(), undefined, "插槽变化刷新端口");
        }, undefined, isInput ? "子图新增输入槽" : "子图新增输出槽");
    };
}

/** 内部移除输入/输出槽 → 同步到外层端口（工厂式，原闭包外提）。 */
function _makeA001OnSlotRemoving(node, isInput) {
    return (e) => {
        safeCall(() => {
            if (!isNodeInGraph(node)) return;
            const removedId = e?.detail?.id ?? e?.slot?.id ?? e?.id ?? null;
            const list = isInput ? node.inputs : node.outputs;
            const idx = _outerSlotIndexById(list, removedId);
            /* ★ 官方已在内部移除该槽；外层同 id 端口需一并摘掉，否则留下空端口。
             *  用 removeInput/removeOutput 而非直接 splice，保持官方内部结构一致。 */
            if (idx >= 0) {
                if (isInput) node.removeInput(idx);
                else node.removeOutput(idx);
            }
            safeCall(() => node._a001RefreshPorts?.(), undefined, "插槽变化刷新端口");
        }, undefined, isInput ? "子图移除输入槽" : "子图移除输出槽");
    };
}

/** 内部重命名槽 → 同步外层端口名（工厂式，原闭包外提）。 */
function _makeA001OnSlotRenaming(node, isInput) {
    return (e) => {
        safeCall(() => {
            if (!isNodeInGraph(node)) return;
            const id = e?.detail?.id ?? e?.slot?.id ?? e?.id ?? null;
            const name = e?.detail?.name ?? e?.detail?.label
                ?? e?.slot?.name ?? e?.name ?? null;
            if (id == null || name == null) return;
            const list = isInput ? node.inputs : node.outputs;
            const idx = _outerSlotIndexById(list, id);
            if (idx < 0) return;
            const slot = list[idx];
            if (!slot) return;
            slot.name = name;
            slot.label = name;
            slot.localized_name = name;
            dirtyCanvas(node);
        }, undefined, isInput ? "子图重命名输入槽" : "子图重命名输出槽");
    };
}

/** 反注册单个 SubgraphInput 的 input-connected 监听。 */
function _detachSgInputWatcher(subgraphInput) {
    if (!subgraphInput?.events?.removeEventListener) return;
    const h = A001_INPUT_HANDLERS.get(subgraphInput);
    if (!h) return;
    safeCall(() => subgraphInput.events.removeEventListener("input-connected", h),
        undefined, "卸载子图槽连接监听");
    A001_INPUT_HANDLERS.delete(subgraphInput);
    A001_WATCHED_INPUTS.delete(subgraphInput);
}

/** 卸载插槽同步：移除全部事件监听并复位记账（节点删除时调用，幂等）。 */
export function detachSlotSync(node) {
    if (!node) return;
    const sg = node._a001SyncedSg;
    if (sg && Array.isArray(node._a001SlotHandlers)) {
        const ev = sg.events;
        if (ev?.removeEventListener) {
            for (const [evn, h] of node._a001SlotHandlers) {
                safeCall(() => ev.removeEventListener(evn, h), undefined, "卸载子图槽事件");
            }
        }
    }
    node._a001SlotHandlers = null;
    if (sg) {
        for (const s of sg.inputs || []) _detachSgInputWatcher(s);
    }
    node._a001SyncedSg = null;
}

export { alog };
