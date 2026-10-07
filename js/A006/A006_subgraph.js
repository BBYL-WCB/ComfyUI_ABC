// ═══════════════════════════════════════════════════════════════
//  A006 视频节点 · 子图生命周期 / 插槽同步 / 持久化
//  · 创建/恢复内部子图（createSubgraph + configure）
//  · 外层端口 ⇄ 子图 inputNode/outputNode 插槽同步
//  · 「文本」widget ↔ 「文本」输入端口 widgetId 绑定
//  · 预览画面持久化（properties._a006_preview，随工作流保存/恢复）
//  · 复制粘贴 ID 重映射：同画布复制 A006 时，子图内部节点/槽位/连线/分组
//    ID 整体重新生成，保证两个实例互不冲突（嵌套 A006 由各自的
//    ensureSubgraph 自然递归处理；内嵌原生子图定义单独重映射）
//  ═══════════════════════════════════════════════════════════════
//  子图数据保存（Nodes 2.0 单通道，不兼容旧工作流）：
//  · serialize 时写 properties.subgraph_data_json（JSON 字符串，
//    LGraphNode 原始 serialize 克隆 properties 时会一并带上）
//  · 内嵌原生子图定义：properties.embedded_subgraph_defs_json，
//    恢复时 leaf-first 注册 UUID node type，内层 SubgraphNode 才不会变成未知节点
//  ═══════════════════════════════════════════════════════════════

import {
    alog,
    safeCall,
    uuidv4,
    dirtyCanvas,
    getNodeGraph,
    getTextWidget,
    videoDataToUrl,
    setPreviewVideos,
    requestPreviewRedraw,
    a006Nodes,
    SG_INPUT_NODE_ID,
    SG_OUTPUT_NODE_ID,
    isConstId,
} from "./A006_shared.js";

/* ─── 子图插槽对象 ─── */

function makeSlot(name, type, id, x, y) {
    return {
        id,
        name,
        type,
        linkIds: [],
        localized_name: name,
        label: name,
        pos: [x, y],
    };
}

/**
 * 构造空子图定义（ExportedSubgraph 格式，对齐原生子图结构）。
 * 默认 1 个输入插槽（文本），「视频01」与「对比视频」2 个输出插槽。
 * 「对比视频」为内部输出槽（_a006InternalOnly），仅子图内部 outputNode 生成锚点口，
 * 外层 A006 节点不生成对应输出端口。
 */
export function buildSubgraphData(name = "006 视频节点") {
    const 对比视频槽 = makeSlot("对比视频", "VIDEO", uuidv4(), 380, 20);
    对比视频槽._a006InternalOnly = true;

    return {
        id: uuidv4(),
        version: 1,
        state: { lastGroupId: 0, lastNodeId: 0, lastLinkId: 0, lastRerouteId: 0 },
        revision: 0,
        config: {},
        name,
        inputNode: { id: SG_INPUT_NODE_ID, bounding: [0, 0, 120, 60] },
        outputNode: { id: SG_OUTPUT_NODE_ID, bounding: [400, 0, 120, 60] },
        inputs: [makeSlot("文本", "STRING", uuidv4(), 120, 10)],
        outputs: [对比视频槽, makeSlot("视频01", "VIDEO", uuidv4(), 380, 20)],
        widgets: [],
        nodes: [],
        groups: [],
        links: [],
        extra: { workflowRendererVersion: "LG" },
        category: "ABC",
        description: "双击进入的视频节点内部空间",
    };
}

/** 获取子图内部节点列表（兼容 _nodes / nodes 两种属性名）。 */
export function getSgNodes(sg) {
    if (!sg) return [];
    return sg._nodes || sg.nodes || [];
}

/** 读取节点保存的子图数据（单通道：properties.subgraph_data_json）。 */
function readSavedSubgraphData(node) {
    const rawJson = node.properties?.subgraph_data_json;
    if (typeof rawJson === "string" && rawJson.length > 0) {
        const parsed = safeCall(() => JSON.parse(rawJson), null, "subgraph_data_json 解析");
        if (parsed && parsed.nodes) {
            return { data: parsed, channel: "subgraph_data_json" };
        }
    }
    return null;
}

/* ─── 内嵌 ComfyUI 原生子图定义 ─── */

/** 判断某节点是否是一个「活的 ComfyUI 原生子图节点」（SubgraphNode，带 .subgraph）。 */
function isEmbeddedNativeSubgraphNode(n) {
    return !!n && typeof n.isSubgraphNode === "function" && n.isSubgraphNode() && !!n.subgraph;
}

/** 收集子图内所有内嵌原生子图定义（ExportedSubgraph 数组），递归、按 id 去重。 */
export function collectEmbeddedSubgraphDefs(subgraph) {
    const defs = [];
    const seen = new Set();
    const walk = (g) => {
        for (const n of getSgNodes(g)) {
            if (!isEmbeddedNativeSubgraphNode(n)) continue;
            const sid = String(n.subgraph.id);
            if (seen.has(sid)) continue;
            seen.add(sid);
            const def = safeCall(
                () => n.subgraph.asSerialisable?.(),
                null,
                "collectEmbeddedSubgraphDefs.asSerialisable"
            );
            if (def) {
                defs.push(def);
                walk(n.subgraph);
            }
        }
    };
    walk(subgraph);
    return defs;
}

/** 恢复前把内嵌原生子图定义注册进 rootGraph（leaf-first，深层 SubgraphNode 才能识别）。 */
function restoreEmbeddedSubgraphDefs(node, graph, defs) {
    if (!Array.isArray(defs) || !defs.length) return;
    const root = node?.rootGraph || graph?.rootGraph || graph;
    if (!root || typeof root.createSubgraph !== "function") {
        alog("restoreEmbeddedSubgraphDefs: 无可用 rootGraph.createSubgraph");
        return;
    }
    const created = new Map();
    for (const def of defs) {
        if (!def || def.id == null) continue;
        if (created.has(String(def.id))) continue;
        const existing = (typeof root.subgraphs?.get === "function")
            ? root.subgraphs.get(def.id)
            : undefined;
        const sg = existing
            || safeCall(() => root.createSubgraph(def), null, "restoreEmbedded.createSubgraph");
        if (sg) created.set(String(def.id), sg);
    }
    for (const [sid, sg] of created) {
        const def = defs.find((d) => d && String(d.id) === String(sid));
        if (def && (def.nodes?.length || def.links?.length)) {
            safeCall(() => sg.configure?.(def), undefined, "restoreEmbedded.sg.configure");
        }
    }
}

/* ─── 插槽同步：外层端口 ⇄ 子图 inputNode/outputNode 插槽 ─── */

function _matchOuterSlot(outerSlots, so, soIndex) {
    // 1) id 精确匹配（最可靠）
    let outer = outerSlots.find((s) => s._a006SubgraphSlotId === so.id);
    if (outer) return outer;
    // 2) 名称 / label 匹配（新建节点由 Schema 生成的同名端口）
    outer = outerSlots.find(
        (s) => s.name === so.name || s.label === so.label || s.label === so.name
    );
    if (outer) return outer;
    // 3) 同序号兜底：该位置外层有端口且未分配子图 id 时，就地复用
    const candidate = outerSlots[soIndex];
    if (candidate && !candidate._a006SubgraphSlotId) return candidate;
    return undefined;
}

/** 单向对齐：把子图 sgSlots 的插槽同步到外层 outerSlots。 */
function _alignSlotsOneWay(node, sgSlots, outerSlots, isInput) {
    for (let i = 0; i < sgSlots.length; i++) {
        const so = sgSlots[i];
        // 内部专用槽（如「对比视频」）：外层不映射端口
        // 注意：_a006InternalOnly 是运行时属性，不随工作流保存，加载后需按名称兜底识别
        if (so._a006InternalOnly) continue;
        // 名称兜底（对齐原版）：_a006InternalOnly 标记序列化会丢失，
        // 加载后靠「输出槽 + 名称=对比视频 + IMAGE」识别为内部专用
        if (!isInput && so.name === "对比视频" && so.type === "VIDEO") continue;
        const outer = _matchOuterSlot(outerSlots, so, i);
        if (outer) {
            outer._a006SubgraphSlotId = so.id;
            outer.name = so.name;
            outer.label = so.label ?? so.name;
            outer.localized_name = so.name;
            if (so.type) outer.type = so.type;
        } else if (isInput) {
            node.addInput(so.name, so.type, { _a006SubgraphSlotId: so.id });
        } else {
            node.addOutput(so.name, so.type, { _a006SubgraphSlotId: so.id });
        }
    }
    // 倒序删除外层多余端口
    for (let i = outerSlots.length - 1; i >= 0; i--) {
        const s = outerSlots[i];
        const stillNeeded = sgSlots.some((so) => {
            // 内部专用槽（_a006InternalOnly / 名称「对比视频」）不支撑外层端口，匹配到也算不需要
            if (so._a006InternalOnly) return false;
            if (!isInput && so.name === "对比视频" && so.type === "VIDEO") return false;
            return so.id === s._a006SubgraphSlotId || so.name === s.name;
        });
        if (!stillNeeded) {
            if (isInput) node.removeInput(i);
            else node.removeOutput(i);
        }
    }
}

/** 初始插槽对齐：让外层节点端口与子图 inputNode/outputNode 插槽一一对应。 */
export function syncSlotsInitial(node) {
    const sg = node.subgraph;
    if (!sg) return;
    node.inputs = node.inputs || [];
    node.outputs = node.outputs || [];
    // 补标记：名称「对比视频」的输出槽一律视为内部专用（序列化会丢失 _a006InternalOnly）
    for (const so of sg.outputs || []) {
        if (so.name === "对比视频" && so.type === "VIDEO") so._a006InternalOnly = true;
    }
    _alignSlotsOneWay(node, sg.inputs || [], node.inputs, true);
    _alignSlotsOneWay(node, sg.outputs || [], node.outputs, false);
    dirtyCanvas(node);
}

function _outerSlotIndexById(outerSlots, subgraphSlotId) {
    return outerSlots.findIndex((s) => s._a006SubgraphSlotId === subgraphSlotId);
}

/** 监听子图插槽事件：内部增删/改名插槽时实时同步到外层端口。 */
export function attachSlotSync(node) {
    const sg = node.subgraph;
    // 守卫顺序：先把「当前是否有已挂载的旧子图」判掉，再判新子图能否挂载。
    // 原写法把两者合并成一次 return，导致「旧子图有 events、新子图无 events」时
    // 直接返回、旧 handler 永不解除（节点已换子图但仍在收旧事件）。
    const prev = node._a006SyncedSg;
    if (prev === sg) return;
    if (prev) {
        detachSlotSync(node);
        node._a006SyncedSg = null;
    }
    if (!sg?.events) return;
    node._a006SyncedSg = sg;
    const ev = sg.events;

    const onSlotAdded = (isInput) => (e) => {
        const slot = e.detail?.input ?? e.detail?.output;
        if (!slot) return;
        if (slot._a006InternalOnly) return;
        // 名称兜底（对齐原版）：丢失标记的「对比视频」输出槽同样视为内部专用
        if (!isInput && slot.name === "对比视频" && slot.type === "VIDEO") return;
        const outer = isInput ? (node.inputs || []) : (node.outputs || []);
        if (outer.some((s) => s._a006SubgraphSlotId === slot.id)) return;
        if (isInput) node.addInput(slot.name, slot.type, { _a006SubgraphSlotId: slot.id });
        else node.addOutput(slot.name, slot.type, { _a006SubgraphSlotId: slot.id });
        dirtyCanvas(node);
        // 端口增删会让 Vue 重建端口条（丢掉 absolute 悬浮样式）并把 DOM 面板顶下去，
        // 依赖外层的端口条重绘机制（domIsolationRefresh）在下一帧同步悬浮样式
    };

    const onSlotRemoving = (isInput) => (e) => {
        const idx = e.detail?.index;
        if (typeof idx !== "number") return;
        const inner = isInput
            ? node.subgraph?.inputs?.[idx]
            : node.subgraph?.outputs?.[idx];
        if (!inner) return;
        const outer = isInput ? (node.inputs || []) : (node.outputs || []);
        const outerIdx = _outerSlotIndexById(outer, inner.id);
        if (outerIdx >= 0) {
            if (isInput) node.removeInput(outerIdx);
            else node.removeOutput(outerIdx);
        }
        dirtyCanvas(node);
    };

    const onSlotRenaming = (isInput) => (e) => {
        const { index, newName } = e.detail || {};
        const outer = isInput ? (node.inputs || []) : (node.outputs || []);
        const slot = outer[index];
        if (slot) {
            slot.label = newName;
            dirtyCanvas(node);
            }
    };

    // 保存具名处理器，供节点删除时 onRemoved 反注册（防止监听器随子图 events 残留而泄漏）
    node._a006SlotHandlers = [
        ["input-added", onSlotAdded(true)],
        ["removing-input", onSlotRemoving(true)],
        ["output-added", onSlotAdded(false)],
        ["removing-output", onSlotRemoving(false)],
        ["renaming-input", onSlotRenaming(true)],
        ["renaming-output", onSlotRenaming(false)],
    ];
    for (const [evn, h] of node._a006SlotHandlers) ev.addEventListener(evn, h);
}

/** 节点删除时解除子图插槽事件监听（配合 onRemoved 调用，防内存泄漏 + 幽灵节点无效重绘）。 */
export function detachSlotSync(node) {
    const ev = node._a006SyncedSg?.events;
    const handlers = node._a006SlotHandlers;
    if (!ev || !handlers) return;
    for (const [evn, h] of handlers) {
        try { ev.removeEventListener(evn, h); } catch (e) { /* 忽略 */ }
    }
    node._a006SlotHandlers = null;
    node._a006SyncedSg = null;
}

/**
 * 把容器「文本」输入端口的 widgetId 指向 widget store 中对应 key，
 * 打通路径：文本控件 → io 插槽 → 子图内部节点（前端 ExecutableNodeDTO.resolveInput）。
 */
export function bindTextWidgetToSlot(node) {
    const slot = (node.inputs || []).find((s) => s.name === "文本");
    const widget = getTextWidget(node);
    if (!slot || !widget) return;

    const graphId = node.graph?.rootGraph?.id ?? node.graph?.id;
    if (graphId == null || node.id == null) return;

    slot.widget = slot.widget ?? { name: "文本" };
    slot.widgetId = [
        String(graphId),
        encodeURIComponent(String(node.id)),
        encodeURIComponent("文本"),
    ].join(":");
}

/* ─── 复制粘贴 ID 重映射 ─── */

/** 收集某子图（活对象）的全部 ID（槽位/节点/连线/分组，排除常量 -10/-20）。 */
function collectSubgraphIds(sg) {
    const ids = new Set();
    for (const s of [...(sg.inputs || []), ...(sg.outputs || [])]) {
        if (s?.id != null && !isConstId(s.id)) ids.add(String(s.id));
    }
    for (const n of getSgNodes(sg)) {
        if (n?.id != null && !isConstId(n.id)) ids.add(String(n.id));
    }
    const links = sg.links;
    if (Array.isArray(links)) {
        for (const l of links) if (l?.id != null) ids.add(String(l.id));
    } else if (links && typeof links === "object") {
        for (const k of Object.keys(links)) {
            if (links[k]?.id != null) ids.add(String(links[k].id));
        }
    }
    for (const g of sg.groups || []) if (g?.id != null) ids.add(String(g.id));
    for (const r of sg.reroutes || []) if (r?.id != null) ids.add(String(r.id));
    return ids;
}

/** 收集子图数据（JSON）的全部 ID（槽位/节点/连线/分组，排除常量 -10/-20）。 */
function collectDataIds(data) {
    const ids = new Set();
    for (const s of [...(data.inputs || []), ...(data.outputs || [])]) {
        if (s?.id != null && !isConstId(s.id)) ids.add(String(s.id));
    }
    for (const n of data.nodes || []) {
        if (n?.id != null && !isConstId(n.id)) ids.add(String(n.id));
    }
    for (const l of data.links || []) if (l?.id != null) ids.add(String(l.id));
    for (const g of data.groups || []) if (g?.id != null) ids.add(String(g.id));
    for (const r of data.reroutes || []) if (r?.id != null) ids.add(String(r.id));
    return ids;
}

/** 收集数据中全部数值 ID（用于提升重映射种子，避免与已有 ID 冲突）。 */
function collectNumericIds(data) {
    const nums = [];
    for (const s of [...(data.inputs || []), ...(data.outputs || [])]) {
        if (typeof s?.id === "number" && !isConstId(s.id)) nums.push(s.id);
    }
    for (const n of data.nodes || []) {
        if (typeof n?.id === "number" && !isConstId(n.id)) nums.push(n.id);
    }
    for (const l of data.links || []) if (typeof l?.id === "number") nums.push(l.id);
    for (const g of data.groups || []) if (typeof g?.id === "number") nums.push(g.id);
    for (const r of data.reroutes || []) if (typeof r?.id === "number") nums.push(r.id);
    return nums;
}

/** 计算画布上所有已建 A006 子图中的最大数值 ID（重映射种子基准）。 */
function computeGlobalMaxInt() {
    let max = 0;
    for (const an of a006Nodes) {
        if (!an?.subgraph) continue;
        for (const id of collectSubgraphIds(an.subgraph)) {
            const n = Number(id);
            if (Number.isInteger(n) && n > max) max = n;
        }
    }
    return max;
}

/** 判断本节点要恢复的子图数据 ID 是否与其它 A006 实例冲突（同画布复制粘贴场景）。 */
function hasIdConflict(node, data) {
    const myIds = collectDataIds(data);
    if (!myIds.size) return false;
    for (const other of a006Nodes) {
        if (other === node || !other?.subgraph) continue;
        const otherIds = collectSubgraphIds(other.subgraph);
        for (const id of myIds) {
            if (otherIds.has(id)) return true;
        }
    }
    return false;
}

/** 应用 idMap 到子图数据：槽位/节点/连线/分组 + 引用（link 引用、group 引用）+ 计数器。 */
function applyRemapToData(data, idMap) {
    const mapId = (v) => {
        if (v == null) return v;
        const k = String(v);
        return idMap.has(k) ? idMap.get(k) : v;
    };
    // 槽位
    for (const s of [...(data.inputs || []), ...(data.outputs || [])]) {
        if (s?.id != null) s.id = mapId(s.id);
    }
    // 内部节点
    for (const n of data.nodes || []) {
        if (n?.id != null) n.id = mapId(n.id);
        for (const inp of n?.inputs || []) {
            if (inp?.link != null) inp.link = mapId(inp.link);
            // io 节点（-10/-20）的 slot 若以 uuid 引用子图槽位，一并重映射
            if (inp?.slot != null && typeof inp.slot === "string") inp.slot = mapId(inp.slot);
        }
        for (const out of n?.outputs || []) {
            if (Array.isArray(out?.links)) out.links = out.links.map(mapId);
            if (out?.slot != null && typeof out.slot === "string") out.slot = mapId(out.slot);
        }
        // 分组引用（ExportedSubgraph 中可能以数字 group id 记录）
        if (n?.group != null && Number.isFinite(n.group)) n.group = mapId(n.group);
    }
    // 连线
    for (const l of data.links || []) {
        if (l?.id != null) l.id = mapId(l.id);
        if (l?.origin_id != null) l.origin_id = mapId(l.origin_id);
        if (l?.target_id != null) l.target_id = mapId(l.target_id);
        // parentId 引用 reroute 的 id，随 idMap 一并重映射
        if (l?.parentId != null) l.parentId = mapId(l.parentId);
    }
    // 分组
    for (const g of data.groups || []) {
        if (g?.id != null) g.id = mapId(g.id);
    }
    // 虚拟连线节点（reroute）：id / parentId 随 idMap 重映射，linkIds 引用 link id
    for (const r of data.reroutes || []) {
        if (r?.id != null) r.id = mapId(r.id);
        if (r?.parentId != null) r.parentId = mapId(r.parentId);
        if (Array.isArray(r?.linkIds)) r.linkIds = r.linkIds.map(mapId);
    }
    // 计数器：重置为本次重映射的最大值 + 1，防止后续新建节点/连线复用旧 ID
    let maxInt = 0;
    for (const v of idMap.values()) {
        if (typeof v === "number" && v > maxInt) maxInt = v;
    }
    data.state = data.state || {};
    data.state.lastNodeId = maxInt + 1;
    data.state.lastLinkId = maxInt + 1;
    data.state.lastGroupId = maxInt + 1;
    data.state.lastRerouteId = maxInt + 1;
}

/**
 * 整体重映射一个 ExportedSubgraph 数据：数值 ID → 全局递增新整数，
 * uuid 字符串 ID（槽位/子图 id）→ 新 uuid。返回 idMap（旧→新）。
 */
function remapExportedSubgraph(data) {
    const idMap = new Map();
    // 不用 Math.max(...arr)：id 数量极大时展开会抛 RangeError 致整体重映射失败
    let seed = computeGlobalMaxInt();
    for (const v of collectNumericIds(data)) {
        if (typeof v === "number" && Number.isFinite(v) && v > seed) seed = v;
    }
    const nextInt = () => ++seed;
    const mapFor = (v) => {
        const k = String(v);
        if (idMap.has(k)) return idMap.get(k);
        const nv = typeof v === "number" ? nextInt() : uuidv4();
        idMap.set(k, nv);
        return nv;
    };
    // 预建映射（槽位/节点/连线/分组）
    for (const s of [...(data.inputs || []), ...(data.outputs || [])]) {
        if (s?.id != null && !isConstId(s.id)) mapFor(s.id);
    }
    for (const n of data.nodes || []) {
        if (n?.id != null && !isConstId(n.id)) mapFor(n.id);
    }
    for (const l of data.links || []) if (l?.id != null) mapFor(l.id);
    for (const g of data.groups || []) if (g?.id != null) mapFor(g.id);
    for (const r of data.reroutes || []) if (r?.id != null) mapFor(r.id);
    // 应用
    applyRemapToData(data, idMap);
    return idMap;
}

/** 更新外层端口标记：_a006SubgraphSlotId 按 idMap 同步到新值。 */
function updateOuterPortMarkers(node, idMap) {
    for (const slot of [...(node.inputs || []), ...(node.outputs || [])]) {
        if (slot?._a006SubgraphSlotId != null) {
            const k = String(slot._a006SubgraphSlotId);
            if (idMap.has(k)) slot._a006SubgraphSlotId = idMap.get(k);
        }
    }
}

/** 重映射内嵌原生子图定义（复制粘贴时避免两实例在 root._subgraphs 里共享同一子图对象）。 */
function remapEmbeddedDefs(node) {
    const raw = node.properties?.embedded_subgraph_defs_json;
    if (typeof raw !== "string" || !raw.length) return;
    const defs = safeCall(() => JSON.parse(raw), [], "解析 embedded_subgraph_defs_json");
    if (!Array.isArray(defs) || !defs.length) return;
    for (const def of defs) {
        if (!def) continue;
        // def.id（uuid）重新生成；内部数值 ID 整体重映射
        def.id = uuidv4();
        remapExportedSubgraph(def);
    }
    node.properties.embedded_subgraph_defs_json = JSON.stringify(defs);
}

/* ─── 创建/恢复子图 ─── */

/**
 * 为节点创建 / 恢复子图，并挂载到 node.subgraph。
 * 幂等：已存在非空子图时不会重复创建。
 * 复制粘贴场景：恢复数据 ID 与其它 A006 实例冲突时，先整体重映射再建图。
 *
 * opts.force：强制用当前 properties.subgraph_data_json 重建子图，忽略「已有非空子图就复用」的守卫。
 *   用于「还原记录」场景：还原时 properties 已被替换成新快照的数据，但画布上的 node.subgraph
 *   仍挂着上一次的子图。此时若走复用分支，会直接 return 旧子图，导致出现
 *   「数据换了、内部节点还是之前的」。常规挂载/框架自动恢复不要传 force。
 */
export function ensureSubgraph(node, opts = {}) {
    const graph = getNodeGraph(node);
    if (!graph || typeof graph.createSubgraph !== "function") {
        alog("当前 graph 不支持 createSubgraph");
        return null;
    }

    const saved = readSavedSubgraphData(node);
    const savedNodeCount = saved?.data?.nodes?.length ?? 0;

    if (node.subgraph && !opts.force) {
        const existingNodes = getSgNodes(node.subgraph);
        if (existingNodes.length > 0 || !saved || savedNodeCount === 0) {
            // Nodes 2.0 框架会自动恢复 subgraph，直接 return 会跳过插槽同步与文本 widgetId 绑定，
            // 导致文本框文本无法传入子图内部。此处补充执行。
            safeCall(
                () => {
                    syncSlotsInitial(node);
                    attachSlotSync(node);
                    bindTextWidgetToSlot(node);
                },
                undefined,
                "插槽同步(已有子图)"
            );
            return node.subgraph;
        }
        alog("重建子图 | 销毁当前空子图，用保存数据恢复 | nodes:", savedNodeCount);
        // 先解除旧子图插槽事件监听并清引用，再销毁：否则具名 handler 会残留在
        // 已销毁的 slot 对象上（与 workflow.js 的销毁路径保持一致）。
        safeCall(() => detachSlotSync(node), undefined, "销毁旧子图前解除插槽监听");
        safeCall(() => node.subgraph.clear?.(), undefined, "销毁旧子图");
        node.subgraph = null;
    }

    let data;
    let srcChannel = "";
    if (saved) {
        // 深拷贝：防止 createSubgraph/configure 修改传入对象污染原始引用。
        // saved.data 可能来自 JSON.parse 的畸形数据（含循环引用会被外部构造），
        // 裸调用会抛并跳过整个重建 → 与同文件其他 JSON 操作保持一致的 safeCall 兜底。
        data = safeCall(
            () => JSON.parse(JSON.stringify(saved.data)),
            undefined,
            "子图数据深拷贝"
        );
        if (!data || typeof data !== "object") {
            alog("保存数据不可用（深拷贝失败）→ 回退为空子图");
            data = buildSubgraphData("006 视频节点");
        }
        srcChannel = saved.channel;
        alog(
            `从保存数据恢复子图 | 通道: ${srcChannel}` +
            ` | nodes: ${data.nodes?.length ?? 0}` +
            ` | links: ${data.links?.length ?? 0}`
        );
    } else {
        data = buildSubgraphData("006 视频节点");
        alog("无保存数据，新建空子图");
    }

    // 复制粘贴 ID 冲突检测 → 整体重映射（槽/节点/连线/分组/计数器 + 外层端口标记 + 内嵌子图定义）
    if (hasIdConflict(node, data)) {
        alog("检测到复制粘贴 ID 冲突 → 整体重映射子图 ID");
        const idMap = remapExportedSubgraph(data);
        updateOuterPortMarkers(node, idMap);
        remapEmbeddedDefs(node);
    }

    const embeddedDefsRaw = node.properties?.embedded_subgraph_defs_json;
    if (typeof embeddedDefsRaw === "string" && embeddedDefsRaw.length > 0) {
        const embeddedDefs = safeCall(
            () => JSON.parse(embeddedDefsRaw),
            [],
            "解析 embedded_subgraph_defs_json"
        );
        restoreEmbeddedSubgraphDefs(node, graph, embeddedDefs);
    }

    const sg = safeCall(() => graph.createSubgraph(data), null, "createSubgraph");
    if (!sg) return null;
    node.subgraph = sg;

    // createSubgraph 不会调用 LGraph.configure 恢复 nodes/links，须主动调用
    if (data.nodes?.length > 0 && typeof sg.configure === "function") {
        safeCall(() => sg.configure(data), undefined, "sg.configure");
    }

    safeCall(
        () => {
            syncSlotsInitial(node);
            attachSlotSync(node);
            bindTextWidgetToSlot(node);
        },
        undefined,
        "插槽同步"
    );
    return sg;
}

/* ─── 预览持久化 ─── */

/** 持久化预览视频信息到 node.properties._a006_preview（随工作流保存）。 */
export function savePreviewProps(node, videos) {
    const arr = Array.isArray(videos) ? videos.filter((d) => d?.filename) : [];
    if (!arr.length) return;
    node.properties = node.properties || {};
    node.properties._a006_preview = arr;
}

/** 读取 A006 节点持久化的首个预览视频信息。 */
export function getFirstSavedPreview(node) {
    const savedPrev = node.properties?._a006_preview;
    return Array.isArray(savedPrev) ? savedPrev[0] : savedPrev;
}

/** 从 properties._a006_preview 恢复上次保存的预览视频。 */
export function restoreSavedPreview(node) {
    const saved = node.properties?._a006_preview;
    if (!Array.isArray(saved) || !saved.length || !saved[0]?.filename) return;

    const first = saved[0];
    setPreviewVideos(node, [videoDataToUrl(first)]);
    requestPreviewRedraw(node);
    alog("已恢复上次预览视频 |", first.filename);
}
