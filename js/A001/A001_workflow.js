// ═══════════════════════════════════════════════════════════════
//  A001 子图节点 · 记录 / 还原（相机快照模式）
//
//  ★ 本模块实现「记录 / 还原」功能（相机快照模式），语义逐函数对齐，差异见下。
//
//  · 记录：直接采用 ComfyUI 框架原生序列化 node.serialize() 作为快照，
//    与工作流保存格式完全一致 —— 大小(size)、模式(mode/order/flags)、
//    插槽(inputs/outputs)、数据(widgets_values/widgets_values_named/properties)、
//    子图(subgraph_data_json)、内嵌子图(embedded_subgraph_defs_json) 全部
//    精准收录，不丢字段
//  · 不记录外层节点自身的实例信息：id（ID 标签）与 pos（画布位置）
//    属于画布布局实例，快照中排除，还原时不写回
//  · 还原：按框架 configure 语义逐字段精准写回目标节点；子图内部全部 ID
//    重新生成（节点/连线/虚拟连线分命名空间 + 内嵌子图 def id 映射），
//    主数据与内嵌子图定义共用同一重映射上下文，跨图引用保持一致；
//    全部还原完成后统一刷新画布与节点 ID 标签，避免与其它实例冲突
//  · 纯相机快照模式：只识别 format="a001_camera_snapshot" 的记录
//
//  ─── 实现要点（适配 A001 结构）───
//  1. 后端接口前缀 /a001/workflow/*（实现在 A001_SubgraphNode.py）
//  2. 快照格式串 "a001_camera_snapshot"
//  3. A001 无「文本」控件、无「视频预览原生控件」：故不保留文本、
//     不做 removeNativePreviewWidget / restoreSavedPreview / watchNativePreviewRemoval；
//     预览为 A001 自有类型（image/video/audio/text），随 properties._a001_preview
//     一起进快照、一起还原。
//  4. 子图函数从 A001_SubgraphNode.js 取（ensureSubgraph / detachSlotSync），
//     不另建 A001_subgraph.js —— A001 的子图实现本就在 A001_SubgraphNode.js 内。
//  5. 还原后刷新 UI 走 A001 的 refreshA001Preview + dirtyCanvas 语义。
// ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import { injectStyleOnce } from "../A000/A000_DomStyle.js";
import { alog, safeCall, uuidv4, isConstId, showA001Toast } from "./A001_shared.js?v=20261007a";
import { ensureSubgraph, detachSlotSync } from "./A001_SubgraphNode.js?v=20261007a";
import { refreshA001Preview } from "./A001_preview.js?v=20261007a";

/** 节点尺寸下限（与官方 LGraphNode 的 minWidth/minHeight 约定一致）。 */
const A001_MIN_W = 210;
const A001_MIN_H = 100;

/** 深拷贝：优先用结构化克隆（structuredClone，无字符串中间产物、快 2-5 倍），
 *  不可用时回退 JSON 往返。用于还原/记录路径上的 widgets_values 等纯数据拷贝。 */
function deepClone(v) {
    try {
        if (typeof structuredClone === "function") return structuredClone(v);
    } catch (_e) { /* 含不可克隆值时回退 */ }
    return JSON.parse(JSON.stringify(v));
}

/* ─── 重映射上下文 ─── */

/**
 * 节点/槽位/分组、连线、虚拟连线节点（reroute）分属三个独立命名空间，
 * 各用独立递增种子从随机高基数起步（避免与画布内现有小整数 id 冲突，
 * 也保证还原后子图节点 ID 标签为全新值）。
 * 主数据与内嵌子图定义共用同一上下文，跨图引用会命中同一映射，不会错位。
 */
function createRemapContext() {
    const nodeMap = new Map();
    const linkMap = new Map();
    const rerouteMap = new Map();
    /* ★ 往复取号（2026-10-06）：取值域 [1000, 1000000]。
     *  递增超过 1000000 后转为递减；递减低于 1000 后转回递增，循环往复；
     *  每次跳过已用 id，保证同一画布同一 ID 不冲突。 */
    const ID_LOW = 1000;
    const ID_HIGH = 1000000;
    /* 收集当前画布（含所有子图）已用的 node/link/reroute id。 */
    const usedNode = new Set(), usedLink = new Set(), usedReroute = new Set();
    (() => {
        const root = (typeof app !== "undefined" && app && (app.rootGraph || app.graph)) || null;
        if (!root) return;
        const seen = new Set();
        const walk = (g, depth) => {
            if (!g || depth > 8 || seen.has(g)) return;
            seen.add(g);
            const nodes = g._nodes || g.nodes || [];
            for (const n of nodes) if (n && n.id != null) usedNode.add(String(n.id));
            const addMap = (m, set) => {
                if (!m) return;
                if (typeof m.keys === "function") { for (const k of m.keys()) set.add(String(k)); }
                else if (typeof m === "object") { for (const k of Object.keys(m)) set.add(String(k)); }
            };
            addMap(g.links, usedLink);
            addMap(g.floatingLinks, usedLink);
            addMap(g.reroutes, usedReroute);
            try {
                if (g.subgraphs && typeof g.subgraphs.values === "function") {
                    for (const x of g.subgraphs.values()) walk(x, depth + 1);
                }
            } catch (_e) { /* 忽略 */ }
        };
        try { walk(root, 0); } catch (_e) { /* 忽略 */ }
    })();
    const makeSeq = (seed, usedSet) => {
        let cursor = Number(seed);
        if (!Number.isInteger(cursor)) cursor = ID_LOW;
        let dir = 1;
        if (cursor >= ID_HIGH) { cursor = ID_HIGH; dir = -1; }
        else if (cursor < ID_LOW) { cursor = ID_LOW - 1; dir = 1; }
        const span = ID_HIGH - ID_LOW + 1;
        const take = () => {
            for (let i = 0; i < span; i++) {
                if (dir > 0) { cursor += 1; if (cursor > ID_HIGH) { dir = -1; cursor = ID_HIGH; } }
                else { cursor -= 1; if (cursor < ID_LOW) { dir = 1; cursor = ID_LOW; } }
                if (!usedSet.has(String(cursor))) { usedSet.add(String(cursor)); return cursor; }
            }
            let v = cursor;
            while (usedSet.has(String(v))) v += 1;
            usedSet.add(String(v));
            cursor = v;
            return v;
        };
        take.current = () => cursor;
        return take;
    };
    /* ★ id 判定与类型保持（2026-10-06）：纯数字与「纯数字字符串」
     *  都走往复取号（避免 id 变为字符串后绕过往复规则）；
     *  取号后保持原类型：原值为字符串则返回字符串，否则返回数字。 */
    const isNumericId = (v) => typeof v === "number" || /^\d+$/.test(String(v));
    const asSameType = (v, n) => (typeof v === "string" ? String(n) : n);
    const nextNodeId = makeSeq(100000 + Math.floor(Math.random() * 300001), usedNode);
    const nextLinkId = makeSeq(700000 + Math.floor(Math.random() * 290001), usedLink);
    const nextRerouteId = makeSeq(400000 + Math.floor(Math.random() * 300001), usedReroute);
    const mapNode = (v) => {
        if (v == null || isConstId(v)) return v;
        const k = String(v);
        if (nodeMap.has(k)) return nodeMap.get(k);
        const nv = isNumericId(v) ? asSameType(v, nextNodeId()) : uuidv4();
        nodeMap.set(k, nv);
        return nv;
    };
    const mapLink = (v) => {
        if (v == null) return v;
        const k = String(v);
        if (linkMap.has(k)) return linkMap.get(k);
        const nv = isNumericId(v) ? asSameType(v, nextLinkId()) : uuidv4();
        linkMap.set(k, nv);
        return nv;
    };
    const mapReroute = (v) => {
        if (v == null) return v;
        const k = String(v);
        if (rerouteMap.has(k)) return rerouteMap.get(k);
        const nv = isNumericId(v) ? asSameType(v, nextRerouteId()) : uuidv4();
        rerouteMap.set(k, nv);
        return nv;
    };
    const state = () => ({
        lastNodeId: nextNodeId.current(),
        lastLinkId: nextLinkId.current(),
        lastRerouteId: nextRerouteId.current(),
    });
    return { mapNode, mapLink, mapReroute, state };
}

/**
 * 把记录的子图数据整体重映射 ID：
 *  · 内嵌子图节点 type 中引用的旧 def id 一并替换（defIdMap: 旧id→新id）；
 *    若本数据自身就是内嵌子图定义（defIdMap 含其 id），则用 defIdMap 中的新 id，
 *    保证主数据节点 type 与注册的子图 id 指向同一新值
 *  · 连线 link.parentId 引用的是 reroute 的 id（不是 link id），必须走 reroute 命名空间，
 *    同时重映射 reroutes 数组（id / parentId / linkIds），否则还原后虚拟链路断裂、子图失效
 *  · ctx 为可选共享上下文；不传则内部新建（用于离线/单次调用场景）
 */
function remapSubgraphData(data, defIdMap, ctx) {
    if (!data || typeof data !== "object") return data;
    const maps = ctx || createRemapContext();
    const mapNode = maps.mapNode;
    const mapLink = maps.mapLink;
    const mapReroute = maps.mapReroute;
    const replaceType = (t) => {
        if (typeof t !== "string" || !defIdMap?.size) return t;
        let out = t;
        for (const [oldId, newId] of defIdMap) {
            const o = String(oldId);
            // token 边界替换：只在整段相等或首尾/非标识符字符包裹时替换，
            // 避免 "a" 命中 "ab" 这类子串误替换（拆分/重组均按边界切分）。
            if (!o) continue;
            if (out === o) {
                out = String(newId);
                continue;
            }
            const parts = out.split(o);
            if (parts.length > 1) out = parts.join(String(newId));
        }
        return out;
    };

    // 子图自身 id：内嵌子图定义走 defIdMap（保持与主数据节点 type 引用一致），否则生成新 uuid
    if (data.id != null && !isConstId(data.id)) {
        const k = String(data.id);
        data.id = defIdMap?.has(k) ? defIdMap.get(k) : uuidv4();
    }

    // 插槽（inputNode / outputNode 槽位）
    for (const slot of [...(data.inputs || []), ...(data.outputs || [])]) {
        if (!slot) continue;
        if (slot.id != null) slot.id = mapNode(slot.id);
        if (Array.isArray(slot.linkIds)) slot.linkIds = slot.linkIds.map(mapLink);
    }

    // 节点
    for (const n of data.nodes || []) {
        if (!n) continue;
        if (n.id != null) n.id = mapNode(n.id);
        if (n.type) n.type = replaceType(n.type);
        for (const inp of n.inputs || []) {
            if (inp && inp.link != null) inp.link = mapLink(inp.link);
        }
        for (const out of n.outputs || []) {
            if (out && Array.isArray(out.links)) out.links = out.links.map(mapLink);
        }
        // 内嵌子图内部预览源引用：sourceNodeId 指向内嵌子图内部节点 id，
        // 共享上下文下与内嵌子图定义的重映射命中同一映射，不会错位
        const px = n.properties?.previewExposures;
        if (Array.isArray(px)) {
            for (const exp of px) {
                if (exp && exp.sourceNodeId != null) {
                    const v = /^\d+$/.test(String(exp.sourceNodeId))
                        ? Number(exp.sourceNodeId)
                        : exp.sourceNodeId;
                    exp.sourceNodeId = mapNode(v);
                }
            }
        }
    }

    // 连线：兼容旧数组 [id, origin_id, origin_slot, target_id, target_slot, type]
    //       与 Nodes 2.0 对象 {id, origin_id, origin_slot, target_id, target_slot, type, parentId}
    for (const l of data.links || []) {
        if (Array.isArray(l)) {
            if (l.length < 6) continue;
            l[0] = mapLink(l[0]);
            l[1] = mapNode(l[1]);
            l[3] = mapNode(l[3]);
        } else if (l && typeof l === "object") {
            if (l.id != null) l.id = mapLink(l.id);
            if (l.origin_id != null) l.origin_id = mapNode(l.origin_id);
            if (l.target_id != null) l.target_id = mapNode(l.target_id);
            // parentId 引用的是 reroute 的 id（虚拟连线节点），必须走 reroute 命名空间，
            // 不能随 link 命名空间重映射，否则与 reroutes 数组重映射后对不上
            if (l.parentId != null) l.parentId = mapReroute(l.parentId);
        }
    }

    // 分组
    for (const gr of data.groups || []) {
        if (!gr) continue;
        if (gr.id != null) gr.id = mapNode(gr.id);
        if (Array.isArray(gr.nodes)) gr.nodes = gr.nodes.map(mapNode);
    }

    // 虚拟连线节点（reroute）：id / parentId 走 reroute 命名空间，linkIds 走 link 命名空间
    for (const r of data.reroutes || []) {
        if (!r) continue;
        if (r.id != null) r.id = mapReroute(r.id);
        if (r.parentId != null) r.parentId = mapReroute(r.parentId);
        if (Array.isArray(r.linkIds)) r.linkIds = r.linkIds.map(mapLink);
    }

    // 计数器同步到本次重映射后的新种子，避免还原后新建节点/连线/虚拟节点复用旧 id
    data.state = data.state || {};
    const st = maps.state();
    data.state.lastNodeId = st.lastNodeId;
    data.state.lastLinkId = st.lastLinkId;
    data.state.lastRerouteId = st.lastRerouteId;

    return data;
}

/* ─── 记录（相机快照） ─── */

/** 轻量 toast 提示：2.4s 自动消失（幂等：重复调用先清理旧实例）。
 *  ★ 实现已提取到 A001_shared.js 的 showA001Toast：本模块与
 *    A001_run.js:notifyA001Toast 原先各有一份完全同构的实现（jscpd 91 tokens 克隆簇）。
 *    本模块的差异在此包装中保留：try/catch 静默（原语义：提示失败不影响主流程）。 */
function showToastA001(text) {
    try { showA001Toast(text); } catch (_e) { /* 提示失败不影响主流程 */ }
}

async function onRecord(node) {
    if (!node.subgraph) { alog("记录失败：节点子图不存在"); return; }
    // 相机快照：直接复用框架原生序列化（与 ComfyUI 工作流保存格式完全一致），
    // 布局/大小/位置/插槽/数据/子图/内嵌子图/预览全部包含，不丢字段
    const snap = safeCall(() => node.serialize(), null, "记录: 节点序列化");
    if (!snap || !snap.properties?.subgraph_data_json) {
        alog("记录失败：节点序列化缺失子图数据");
        return;
    }
    const title = node.title && String(node.title).trim() ? String(node.title).trim() : "未命名";
    const snapshot = {
        format: "a001_camera_snapshot",
        version: 2,
        capturedAt: Date.now(),
        node: deepClone(snap),
    };
    // 不记录外层节点自身的 ID 标签：节点 id 属于画布实例，对还原无意义，
    // 快照中排除后还原时不会污染目标节点的 ID 标签
    delete snapshot.node.id;
    // 不记录外层节点自身的位置：pos 属于画布布局实例，
    // 快照中排除后还原时目标节点保持当前位置
    delete snapshot.node.pos;
    // 不记录预览框内容：预览属于「运行产物」而非「工作流结构」，
    // 记录/还原只应搬运结构（布局/插槽/子图/控件），不应搬运上一次的运行结果。
    // 预览的持久化载体是 node.properties._a001_preview（见 A001_preview.js:saveA001Preview），
    // 此处从快照中剔除，还原时目标节点自身的预览不受本次记录影响。
    if (snapshot.node.properties) delete snapshot.node.properties._a001_preview;

    try {
        const resp = await fetch("/a001/workflow/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, data: snapshot }),
        });
        if (!resp.ok) { const t = await resp.text().catch(() => ""); alog("记录失败:", resp.status, t || "后端错误"); return; }
        const res = await resp.json();
        if (res.name) {
            alog("已记录(相机快照) →", res.name);
            showToastA001("已记录 ✓ " + res.name);
        }
        else alog("记录失败:", res.error);
    } catch (e) {
        alog("记录失败:", e);
    }
}

/* ─── 还原 ─── */

async function onRestore(node) {
    let workflows;
    try {
        const resp = await fetch("/a001/workflow/list");
        if (!resp.ok) { const t = await resp.text().catch(() => ""); alog("读取记录列表失败:", resp.status, t || "后端错误"); return; }
        workflows = (await resp.json()).workflows || [];
        // 还原记录按名称递增排列：以记录名称作为排序键，中文按拼音顺序，数字按自然序。
        workflows.sort((a, b) =>
            String(a.title ?? a.name ?? "").localeCompare(
                String(b.title ?? b.name ?? ""),
                "zh-Hans-CN",
                { numeric: true }
            )
        );
    } catch (e) {
        alog("读取记录列表失败:", e);
        return;
    }
    if (!workflows.length) {
        alog("暂无记录可还原");
        showToastA001("暂无记录可还原");
        return;
    }
    showWorkflowPicker(workflows, async (wf) => {
        try {
            const resp = await fetch("/a001/workflow/load", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: wf.name }),
            });
            if (!resp.ok) { const t = await resp.text().catch(() => ""); alog("加载记录失败:", resp.status, t || "后端错误"); return; }
            const data = await resp.json();
            if (!data || data.error) {
                alog("加载记录失败:", data?.error || "unknown");
                return;
            }
            // 纯相机快照模式：只识别本格式
            if (data.format !== "a001_camera_snapshot") {
                alog("该记录不是相机快照格式，已忽略（旧记录请重新记录）");
                showToastA001("记录格式不匹配，已忽略");
                return;
            }
            // 还原后把「记录条目名」写回节点标题（与弹窗列表所见一致）
            applySnapshotToNode(node, data, wf.title || wf.name);
        } catch (e) {
            alog("加载记录失败:", e);
        }
    });
}

/** 把相机快照精准还原到目标节点（对齐框架 configure 语义）。
 *  restoreTitle：记录条目名，还原后无条件覆盖到节点标题。 */
function applySnapshotToNode(node, snapshot, restoreTitle) {
    const nd = snapshot?.node;
    if (!nd || !nd.properties?.subgraph_data_json) {
        alog("还原失败：快照无节点数据");
        return;
    }
    // 不还原节点 ID 标签：快照中的 id 一律忽略，目标节点保持自身 id
    // （id 属于画布实例，对还原无意义）。
    // title 也不同步快照里的值，而是在末尾改用「记录条目名」覆盖。
    if (nd.id != null) delete nd.id;
    if (nd.title != null) delete nd.title;
    const subgraphData = safeCall(
        () => JSON.parse(nd.properties.subgraph_data_json),
        null,
        "还原: 解析子图数据"
    );
    if (!subgraphData) { alog("还原失败：子图数据损坏"); return; }

    // 1) 内嵌子图定义：整体换新 id（旧id→新id 映射用于替换 type 引用）
    const embeddedRaw = nd.properties.embedded_subgraph_defs_json;
    const embeddedDefs = embeddedRaw
        ? safeCall(() => JSON.parse(embeddedRaw), [], "还原: 解析内嵌子图")
        : [];
    const defIdMap = new Map();
    const ctx = createRemapContext();
    const remappedDefs = embeddedDefs.map((d) => {
        const copy = deepClone(d);
        if (copy.id != null) {
            const newId = uuidv4();
            defIdMap.set(String(copy.id), newId);
        }
        return remapSubgraphData(copy, defIdMap, ctx);
    });

    // 2) 主数据重映射（与内嵌子图共用同一重映射上下文，跨图引用一致）
    const newData = remapSubgraphData(deepClone(subgraphData), defIdMap, ctx);

    // 3) 外层节点字段精准还原：大小 / 模式 / 颜色（不还原 pos —— 画布位置
    //    属于布局实例，目标节点保持当前位置；id/title 已在前面排除）
    if (Array.isArray(nd.size) && nd.size.length === 2) {
        const rw = Number(nd.size[0]);
        const rh = Number(nd.size[1]);
        if (Number.isFinite(rw) && Number.isFinite(rh)) {
            try { node.setSize([Math.max(rw, A001_MIN_W), Math.max(rh, A001_MIN_H)]); } catch (e) { /* 忽略 */ }
        }
    }
    if (nd.flags && typeof nd.flags === "object") node.flags = nd.flags;
    if (typeof nd.order === "number") node.order = nd.order;
    if (typeof nd.mode === "number") node.mode = nd.mode;
    if (nd.color != null) node.color = nd.color;
    if (nd.bgcolor != null) node.bgcolor = nd.bgcolor;

    // 4) 数据精准还原：widgets_values（跳过 serialize:false 的 DOM widget）
    if (Array.isArray(nd.widgets_values)) {
        let vi = 0;
        for (const wid of node.widgets || []) {
            /* 注：wid.serialize 通常是原型方法，`=== false` 仅在显式布尔串行化标记时命中，
             *  真正生效的是 options.serialize === false；两者都保留以覆盖不同前端版本。 */
            if (!wid || wid.options?.serialize === false || wid.serialize === false) continue;
            if (vi < nd.widgets_values.length) {
                if (wid.value !== nd.widgets_values[vi]) {
                    try { wid.value = nd.widgets_values[vi]; } catch (e) { /* 忽略 */ }
                }
            }
            vi++;
        }
        node.widgets_values = deepClone(nd.widgets_values);
    }
    if (nd.widgets_values_named && typeof nd.widgets_values_named === "object") {
        node.widgets_values_named = deepClone(nd.widgets_values_named);
    }

    // 5) properties 精准还原：除子图两条外全量复制，再写入重映射结果
    //    进入覆盖前先留内存快照：下方 ensureSubgraph 失败时按此回滚，避免
    //    "properties 已是新数据、node.subgraph 仍是旧子图"的不自洽态在保存时永久丢数据。
    const rollback = {
        properties: node.properties ? Object.assign({}, node.properties) : null,
        widgetsValues: Array.isArray(node.widgets_values) ? deepClone(node.widgets_values) : null,
        widgetsValuesNamed: node.widgets_values_named ? Object.assign({}, node.widgets_values_named) : null,
        widgetVals: (node.widgets || []).map((w) => { try { return w?.value; } catch (_e) { return undefined; } }),
        size: Array.isArray(node.size) ? [...node.size] : null,
        flags: node.flags ? Object.assign({}, node.flags) : null,
        order: node.order,
        mode: node.mode,
        color: node.color,
        bgcolor: node.bgcolor,
    };
    // 预览框内容【不参与还原】：预览是上一次的运行产物，不属于工作流结构。
    //   · 记录端已从快照剔除该字段（见 onRecord）；
    //   · 此处再取一次目标节点自身的预览记录，覆盖 properties 后原样写回，
    //     保证「即使旧格式快照里残留了 _a001_preview 也不会污染目标节点」，
    //     还原后目标节点保留自己原有的预览框内容，不被记录内容替换。
    const keepPreview = node.properties ? node.properties._a001_preview : undefined;
    node.properties = Object.assign({}, nd.properties || {});
    delete node.properties.subgraph_data_json;
    delete node.properties.embedded_subgraph_defs_json;
    node.properties.subgraph_data_json = JSON.stringify(newData);
    if (remappedDefs.length) {
        node.properties.embedded_subgraph_defs_json = JSON.stringify(remappedDefs);
    } else {
        delete node.properties.embedded_subgraph_defs_json;
    }
    // 写回目标节点自身原有的预览记录（不还原预览框内容）
    if (keepPreview !== undefined) node.properties._a001_preview = keepPreview;
    else delete node.properties._a001_preview;

    // 6) 按新数据重建子图，成功后才销毁旧子图。
    //    顺序不可反：若先销毁再重建，一旦重建失败会留下「旧子图已死、新子图未生」的半死态，
    //    且 _a001SyncedSg 仍指向已销毁对象，后续插槽同步全部失效。
    const oldSg = node.subgraph;
    // 先解除旧子图的插槽监听，避免新子图建立过程中旧回调仍在增删外层端口
    if (oldSg) safeCall(() => detachSlotSync(node), undefined, "还原: 解除旧子图插槽监听");
    // 强制重建：还原时 properties 已换成新快照数据，必须让 node.subgraph 跟着换血。
    // 不传 force 会被「已有非空子图即复用」的守卫拦下，出现"内部节点还是之前的"。
    const sg = ensureSubgraph(node, { force: true });
    if (!sg) {
        // 回滚已覆盖的字段，恢复还原前状态（子图未变，字段也必须跟着回退）
        if (rollback.properties) node.properties = rollback.properties;
        if (rollback.widgetsValues) node.widgets_values = rollback.widgetsValues;
        if (rollback.widgetsValuesNamed) node.widgets_values_named = rollback.widgetsValuesNamed;
        if (rollback.size) safeCall(() => node.setSize(rollback.size), undefined, "还原回滚: 尺寸");
        if (rollback.flags) node.flags = rollback.flags;
        if (typeof rollback.order === "number") node.order = rollback.order;
        if (typeof rollback.mode === "number") node.mode = rollback.mode;
        node.color = rollback.color;
        node.bgcolor = rollback.bgcolor;
        const wl = node.widgets || [];
        for (let i = 0; i < wl.length && i < rollback.widgetVals.length; i++) {
            if (rollback.widgetVals[i] !== undefined) {
                try { wl[i].value = rollback.widgetVals[i]; } catch (_e) { /* 忽略 */ }
            }
        }
        safeCall(() => node.graph?.change?.(), undefined, "还原回滚: 通知变更");
        alog("还原失败：子图重建失败（已回滚到还原前状态）");
        showToastA001("还原失败：子图重建失败");
        return;
    }
    if (oldSg && oldSg !== sg) {
        safeCall(() => oldSg.clear?.(), undefined, "还原: 销毁旧子图");
    }

    // 7) 节点标题写回记录条目名（无条件覆盖）。
    //    放在子图重建成功之后：若重建失败提前 return，标题保持原样，避免"标题变了但内容没换"的错位。
    if (restoreTitle != null) {
        const t = String(restoreTitle).trim();
        if (t) {
            try { node.title = t; } catch (e) { alog("还原: 写入节点标题失败", e); }
        }
    }

    // 8) 刷新 UI：预览 / 画布（子图为全新 ID）。
    //    A001 预览为自有实现（image/video/audio/text），随快照还原后直接重绘。
    safeCall(() => refreshA001Preview(node), undefined, "还原: 重绘预览");

    // 若当前画布正打开被销毁的旧子图，切换回新子图视图
    let sgCanvas = null;
    try {
        const canvas = app.canvas;
        if (canvas && oldSg && canvas.graph === oldSg && sg && typeof canvas.openSubgraph === "function") {
            canvas.openSubgraph(sg, node);
            sgCanvas = canvas;
        }
    } catch (e) { /* 忽略 */ }
    // 全部还原完成后统一刷新画布，节点 ID 标签随之重绘为新 ID。
    // 注：app.graph.setDirtyCanvas(true, true) 已同时覆盖 graph 与 canvas 两层，
    //     原实现再调 app.canvas.setDirty(true, true) 属语义重叠，故合并为一次。
    app.graph?.setDirtyCanvas?.(true, true);
    if (sgCanvas) safeCall(() => sgCanvas.setDirty?.(true, true), undefined, "还原: 刷新子图画布");
    if (sg) safeCall(() => sg.setDirtyCanvas?.(true, true), undefined, "还原: 刷新子图状态");
    alog(
        "还原完成(相机快照) | 子图节点:", newData.nodes?.length,
        "| 连线:", newData.links?.length
    );
    showToastA001("已还原 ✓ " + String(restoreTitle ?? ""));
}

/* ─── 记录选择弹窗 ─── */

function ensurePickerCss() {
    injectStyleOnce("xzg-a001-picker-style", `
.xzg-a001-picker-mask{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:inherit}
.xzg-a001-picker{min-width:340px;max-width:480px;max-height:70vh;display:flex;flex-direction:column;background:#222;border:1px solid #444;border-radius:20px;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden}
.xzg-a001-picker-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #333;color:#e6e6e6;font-size:14px;font-weight:600}
.xzg-a001-picker-close{background:none;border:none;color:#999;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px}
.xzg-a001-picker-close:hover{color:#fff}
.xzg-a001-picker-list{overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:4px}
.xzg-a001-picker-item{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;box-sizing:border-box;padding:8px 10px;background:#2a2a2a;border:1px solid #333;border-radius:10px;color:#ddd;cursor:pointer;font-size:13px;text-align:left}
.xzg-a001-picker-item:hover{background:#3a3a3a;border-color:#555}
.xzg-a001-picker-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto}
.xzg-a001-picker-del{width:20px;height:20px;flex:0 0 20px;box-sizing:border-box;border:1px solid #555;border-radius:50%;background:transparent;color:#999;cursor:pointer;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0}
.xzg-a001-picker-del:hover{background:#c0392b;border-color:#c0392b;color:#fff}
.xzg-a001-picker-empty{color:#888;text-align:center;padding:14px;font-size:13px}
`);
}

/* ─── 记录删除 ─── */

/** 删除一条记录（调用后端删除接口）。 */
async function deleteWorkflow(name) {
    try {
        const resp = await fetch("/a001/workflow/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
        if (!resp.ok) { const t = await resp.text().catch(() => ""); alog("删除失败:", resp.status, t || "后端错误"); return false; }
        const res = await resp.json();
        if (res.ok) {
            alog("已删除记录:", name);
            return true;
        }
        alog("删除失败:", res.error);
        return false;
    } catch (e) {
        alog("删除失败:", e);
        return false;
    }
}

/** 当前打开的选择弹窗（防并发叠加：同时只保留一个）。 */
let _activePicker = null;

/** 关闭当前选择弹窗（移除 DOM + 解绑 ESC）。 */
function closeWorkflowPicker() {
    if (!_activePicker) return;
    const { mask, onKey } = _activePicker;
    _activePicker = null;
    document.removeEventListener("keydown", onKey, true);
    mask.remove();
}

/** 简易选择弹窗：列出记录文件，点击某项回调，每项带 ✕ 删除按钮。 */
function showWorkflowPicker(items, onPick) {
    ensurePickerCss();
    closeWorkflowPicker();
    const mask = document.createElement("div");
    mask.className = "xzg-a001-picker-mask";

    const panel = document.createElement("div");
    panel.className = "xzg-a001-picker";

    const head = document.createElement("div");
    head.className = "xzg-a001-picker-head";
    const title = document.createElement("span");
    title.textContent = "选择要还原的记录";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "xzg-a001-picker-close";
    close.textContent = "✕";
    close.addEventListener("click", () => closeWorkflowPicker());
    head.append(title, close);

    const list = document.createElement("div");
    list.className = "xzg-a001-picker-list";

    const showEmpty = () => {
        list.innerHTML = "";
        const empty = document.createElement("div");
        empty.className = "xzg-a001-picker-empty";
        empty.textContent = "暂无记录";
        list.appendChild(empty);
    };

    for (const it of items) {
        const row = document.createElement("div");
        row.className = "xzg-a001-picker-item";
        row.tabIndex = 0;
        const t = document.createElement("span");
        t.className = "xzg-a001-picker-title";
        t.textContent = it.title || it.name;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "xzg-a001-picker-del";
        del.textContent = "✕";
        del.title = "删除该记录";
        del.addEventListener("click", async (e) => {
            e.stopPropagation();
            const ok = await deleteWorkflow(it.name);
            /* 请求期间弹窗可能已被关闭（mask 脱离 DOM），此时不应再操作脱离元素。 */
            if (!mask.isConnected) return;
            if (ok) {
                row.remove();
                if (!list.childElementCount) showEmpty();
            }
        });
        row.append(t, del);
        row.addEventListener("click", () => {
            closeWorkflowPicker();
            onPick(it);
        });
        list.appendChild(row);
    }

    panel.append(head, list);
    mask.appendChild(panel);
    // 点击遮罩空白处关闭（点击面板内部不关）
    mask.addEventListener("mousedown", (e) => {
        if (e.target === mask) closeWorkflowPicker();
    });
    // ESC 关闭（捕获阶段拦截，避免画布层处理）
    const onKey = (e) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            closeWorkflowPicker();
        }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(mask);
    _activePicker = { mask, onKey };
}

/* ─── 按键绑定入口 ─── */

/**
 * 绑定「记录 / 还原」按键。
 * 按键不集中挂在一个容器对象上，故直接接收两个按钮元素；
 * 幂等守卫与解绑语义完全遵循 attachWorkflowButtons 的约定
 * （面板被 Vue 重建后新旧按钮元素不同，避免重复绑定导致一次点击发多次请求）。
 */
export function attachA001WorkflowButtons(node, recBtn, rstBtn) {
    if (!node) return;
    const g = node._a001WfBtns || (node._a001WfBtns = {});
    g.recBtn = recBtn || null;
    g.rstBtn = rstBtn || null;
    // 幂等守卫：面板重建时旧按钮元素已脱离，此处「已绑定过同一 DOM」直接跳过
    if (g._boundEl === g.recBtn && g._boundEl2 === g.rstBtn) return;
    unbindA001WorkflowButtons(node);
    const onRecClick = (e) => {
        e.stopPropagation();
        onRecord(node);
    };
    const onRstClick = (e) => {
        e.stopPropagation();
        onRestore(node);
    };
    if (g.recBtn) g.recBtn.addEventListener("click", onRecClick);
    if (g.rstBtn) g.rstBtn.addEventListener("click", onRstClick);
    g._boundEl = g.recBtn;
    g._boundEl2 = g.rstBtn;
    g._cleanup = () => {
        if (g.recBtn) g.recBtn.removeEventListener("click", onRecClick);
        if (g.rstBtn) g.rstBtn.removeEventListener("click", onRstClick);
    };
}

/** 解绑「记录 / 还原」按键（面板重建前 / 节点删除时调用）。 */
export function unbindA001WorkflowButtons(node) {
    const g = node?._a001WfBtns;
    if (!g) return;
    if (g._cleanup) { try { g._cleanup(); } catch (_e) { /* 忽略 */ } }
    g._cleanup = null;
    g._boundEl = null;
    g._boundEl2 = null;
}
