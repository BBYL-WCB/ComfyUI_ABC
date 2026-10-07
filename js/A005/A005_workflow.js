// ═══════════════════════════════════════════════════════════════
//  A005 图片节点 · 记录 / 还原（相机快照模式）
//  · 记录：直接采用 ComfyUI 框架原生序列化 node.serialize() 作为快照，
//    与工作流保存格式完全一致 —— 大小(size)、模式(mode/order/flags)、
//    插槽(inputs/outputs)、数据(widgets_values/widgets_values_named/properties)、
//    子图(subgraph_data_json)、内嵌子图(embedded_subgraph_defs_json)、
//    预览(_a005_preview) 全部精准收录，不丢字段
//  · 不记录外层节点自身的实例信息：id（ID 标签）与 pos（画布位置）
//    属于画布布局实例，快照中排除，还原时不写回
//  · 还原：按框架 configure 语义逐字段精准写回目标节点；子图内部全部 ID
//    重新生成（节点/连线/虚拟连线分命名空间 + 内嵌子图 def id 映射），
//    主数据与内嵌子图定义共用同一重映射上下文，跨图引用（如
//    previewExposures.sourceNodeId 指向内嵌子图内部节点）保持一致；
//    全部还原完成后统一刷新画布与节点 ID 标签，避免与其它实例冲突
//  · 纯相机快照模式：只识别 format="a005_camera_snapshot" 的记录，
//    不再兼容旧工作流格式（历史旧记录一律清除，不参与还原）
//  ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import {
    alog,
    safeCall,
    uuidv4,
    NODE_SIZE,
    isConstId,
} from "./A005_shared.js";
import {
    ensureSubgraph,
    restoreSavedPreview,
    detachSlotSync,
} from "./A005_subgraph.js";

const { MIN_W, MIN_H } = NODE_SIZE;

/* ─── 重映射上下文 ─── */

/**
 * 节点/槽位/分组、连线、虚拟连线节点（reroute）分属三个独立命名空间，
 * 各用独立递增种子从随机高基数起步（避免与画布内现有小整数 id 冲突，
 * 也保证还原后子图节点 ID 标签为全新值）。
 * 主数据与内嵌子图定义共用同一上下文：previewExposures.sourceNodeId 等
 * 跨图引用（指向内嵌子图内部节点）会命中同一映射，不会错位。
 */
function createRemapContext() {
    const nodeMap = new Map();
    const linkMap = new Map();
    const rerouteMap = new Map();
    let nSeed = 1000000 + Math.floor(Math.random() * 8000000);      // node 命名空间
    let lSeed = 100000000 + Math.floor(Math.random() * 800000000);  // link 命名空间（错开）
    let rSeed = 10000000 + Math.floor(Math.random() * 80000000);    // reroute 命名空间（再错开）
    const mapNode = (v) => {
        if (v == null || isConstId(v)) return v;
        const k = String(v);
        if (nodeMap.has(k)) return nodeMap.get(k);
        const nv = typeof v === "number" ? ++nSeed : uuidv4();
        nodeMap.set(k, nv);
        return nv;
    };
    const mapLink = (v) => {
        if (v == null) return v;
        const k = String(v);
        if (linkMap.has(k)) return linkMap.get(k);
        const nv = typeof v === "number" ? ++lSeed : uuidv4();
        linkMap.set(k, nv);
        return nv;
    };
    const mapReroute = (v) => {
        if (v == null) return v;
        const k = String(v);
        if (rerouteMap.has(k)) return rerouteMap.get(k);
        const nv = typeof v === "number" ? ++rSeed : uuidv4();
        rerouteMap.set(k, nv);
        return nv;
    };
    const state = () => ({
        lastNodeId: nSeed + 1,
        lastLinkId: lSeed + 1,
        lastRerouteId: rSeed + 1,
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

/** 轻量 toast 提示：body 挂载，2.4s 自动消失（幂等：重复调用先清理旧实例）。 */
function showToastA005(text) {
    try {
        const old = document.querySelector(".xzg-a005-toast");
        if (old) old.remove();
        const t = document.createElement("div");
        t.className = "xzg-a005-toast";
        t.textContent = text;
        t.style.cssText = "position:fixed;left:50%;top:56px;transform:translateX(-50%);z-index:99999;background:rgba(20,22,26,.96);border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:8px 18px;font:500 13px/1 system-ui,sans-serif;color:#e6e6e6;box-shadow:0 4px 18px rgba(0,0,0,.55);pointer-events:none;animation:xzg-a005-toast-in .18s ease;transition:opacity .25s ease";
        const styleId = "xzg-a005-toast-style";
        if (!document.getElementById(styleId)) {
            const s = document.createElement("style");
            s.id = styleId;
            s.textContent = "@keyframes xzg-a005-toast-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}";
            document.head.appendChild(s);
        }
        document.body.appendChild(t);
        setTimeout(() => {
            t.style.opacity = "0";
            setTimeout(() => t.remove(), 260);
        }, 2400);
    } catch (_e) { /* 提示失败不影响主流程 */ }
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
        format: "a005_camera_snapshot",
        version: 2,
        capturedAt: Date.now(),
        node: JSON.parse(JSON.stringify(snap)),
    };
    // 不记录外层节点自身的 ID 标签：节点 id 属于画布实例，对还原无意义，
    // 快照中排除后还原时不会污染目标节点的 ID 标签
    delete snapshot.node.id;
    // 不记录外层节点自身在画布上的位置：pos 属于画布布局实例，
    // 快照中排除后还原时目标节点保持当前位置
    delete snapshot.node.pos;

    try {
        const resp = await fetch("/a005/workflow/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, data: snapshot }),
        });
        if (!resp.ok) { const t = await resp.text().catch(() => ""); alog("记录失败:", resp.status, t || "后端错误"); return; }
        const res = await resp.json();
        if (res.name) { alog("已记录(相机快照) →", res.name); showToastA005("已记录 ✓ " + res.name); }
        else alog("记录失败:", res.error);
    } catch (e) {
        alog("记录失败:", e);
    }
}

/* ─── 还原 ─── */

/** 从记录文件名尾部提取数字序号：title.json → 1；title_2.json → 2；
 *  只认「.json 结尾前的最后一段数字」；无数字视为首份 1。 */
function parseSnapshotSeq(name) {
    if (!name) return 1;
    const m = String(name).match(/_?(\d+)\.json$/);
    if (m) return parseInt(m[1], 10) || 1;
    return 1;
}


async function onRestore(node) {
    let workflows;
    try {
        const resp = await fetch("/a005/workflow/list");
        if (!resp.ok) { const t = await resp.text().catch(() => ""); alog("读取记录列表失败:", resp.status, t || "后端错误"); return; }
        workflows = (await resp.json()).workflows || [];
        // 还原记录按数字顺序排列：以文件名末尾数字后缀作为排序键（无后缀视为首份=1）。
        // 同名记录 title.json、title_2.json、title_3.json… 按版本序号升序展示，方便按记录顺序还原。
        workflows.sort((a, b) => {
            const na = parseSnapshotSeq(a.name);
            const nb = parseSnapshotSeq(b.name);
            if (na !== nb) return na - nb;
            return String(a.name).localeCompare(String(b.name), "zh");
        });
    } catch (e) {
        alog("读取记录列表失败:", e);
        return;
    }
    if (!workflows.length) {
        alog("暂无记录可还原");
        return;
    }
    showWorkflowPicker(workflows, async (wf) => {
        try {
            const resp = await fetch("/a005/workflow/load", {
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
            // 纯相机快照模式：只识别本格式，旧工作流记录不再支持
            if (data.format !== "a005_camera_snapshot") {
                alog("该记录不是相机快照格式，已忽略（旧记录请重新记录）");
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
        const copy = JSON.parse(JSON.stringify(d));
        if (copy.id != null) {
            const newId = uuidv4();
            defIdMap.set(String(copy.id), newId);
        }
        return remapSubgraphData(copy, defIdMap, ctx);
    });

    // 2) 主数据重映射（与内嵌子图共用同一重映射上下文，跨图引用一致）
    const newData = remapSubgraphData(JSON.parse(JSON.stringify(subgraphData)), defIdMap, ctx);

    // 3) 外层节点字段精准还原：大小 / 模式 / 颜色（不还原 pos —— 画布位置
    //    属于布局实例，目标节点保持当前位置；id/title 已在前面排除）
    if (Array.isArray(nd.size) && nd.size.length === 2) {
        const rw = Number(nd.size[0]);
        const rh = Number(nd.size[1]);
        if (Number.isFinite(rw) && Number.isFinite(rh)) {
            try { node.setSize([Math.max(rw, MIN_W), Math.max(rh, MIN_H)]); } catch (e) { /* 忽略 */ }
        }
    }
    if (nd.flags && typeof nd.flags === "object") node.flags = nd.flags;
    if (typeof nd.order === "number") node.order = nd.order;
    if (typeof nd.mode === "number") node.mode = nd.mode;
    if (nd.color != null) node.color = nd.color;
    if (nd.bgcolor != null) node.bgcolor = nd.bgcolor;

    // 4) 数据精准还原：widgets_values（跳过 serialize:false 的 DOM widget）
    if (Array.isArray(nd.widgets_values)) {
        node.widgets_values = JSON.parse(JSON.stringify(nd.widgets_values));
        let vi = 0;
        for (const wid of node.widgets || []) {
            if (!wid || wid.options?.serialize === false || wid.serialize === false) continue;
            if (vi < node.widgets_values.length && wid.value !== node.widgets_values[vi]) {
                try { wid.value = node.widgets_values[vi]; } catch (e) { /* 忽略 */ }
            }
            vi++;
        }
    }
    if (nd.widgets_values_named && typeof nd.widgets_values_named === "object") {
        node.widgets_values_named = JSON.parse(JSON.stringify(nd.widgets_values_named));
    }

    // 5) properties 精准还原：除子图两条外全量复制，再写入重映射结果
    //    进入覆盖前先留内存快照：下方 ensureSubgraph 失败时按此回滚，避免
    //    "properties 已是新数据、node.subgraph 仍是旧子图"的不自洽态在保存时永久丢数据。
    const rollback = {
        properties: node.properties ? Object.assign({}, node.properties) : null,
        widgetsValues: Array.isArray(node.widgets_values) ? JSON.parse(JSON.stringify(node.widgets_values)) : null,
        widgetsValuesNamed: node.widgets_values_named ? Object.assign({}, node.widgets_values_named) : null,
        widgetVals: (node.widgets || []).map((w) => { try { return w?.value; } catch (_e) { return undefined; } }),
        size: Array.isArray(node.size) ? [...node.size] : null,
        flags: node.flags ? Object.assign({}, node.flags) : null,
        order: node.order,
        mode: node.mode,
        color: node.color,
        bgcolor: node.bgcolor,
    };
    node.properties = Object.assign({}, nd.properties || {});
    delete node.properties.subgraph_data_json;
    delete node.properties.embedded_subgraph_defs_json;
    node.properties.subgraph_data_json = JSON.stringify(newData);
    if (remappedDefs.length) {
        node.properties.embedded_subgraph_defs_json = JSON.stringify(remappedDefs);
    } else {
        delete node.properties.embedded_subgraph_defs_json;
    }

    // 6) 按新数据重建子图，成功后才销毁旧子图。
    //    顺序不可反：若先销毁再重建，一旦重建失败会留下「旧子图已死、新子图未生」的半死态，
    //    且 _a005SyncedSg 仍指向已销毁对象，后续插槽同步全部失效。
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

    // 8) 刷新 UI：文本框 / 预览 / 画布 + 节点 ID 标签（子图为全新 ID）
    const g = node._xzgA005;
    if (g) {
        const textVal = Array.isArray(nd.widgets_values) ? String(nd.widgets_values[0] ?? "") : "";
        if (g.text) g.text.value = textVal;
        safeCall(() => restoreSavedPreview(node), undefined, "还原: 恢复预览");
        if (typeof node._a005Redraw === "function") node._a005Redraw();
    }
    // 若当前画布正打开被销毁的旧子图，切换回新子图视图
    let sgCanvas = null;
    try {
        const canvas = app.canvas;
        if (canvas && oldSg && canvas.graph === oldSg && sg && typeof canvas.openSubgraph === "function") {
            canvas.openSubgraph(sg, node);
            sgCanvas = canvas;
        }
    } catch (e) { /* 忽略 */ }
    // 全部还原完成后统一刷新画布，节点 ID 标签随之重绘为新 ID
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
    if (sgCanvas) safeCall(() => sgCanvas.setDirty?.(true, true), undefined, "还原: 刷新子图画布");
    if (sg) safeCall(() => sg.setDirtyCanvas?.(true, true), undefined, "还原: 刷新子图状态");
    alog(
        "还原完成(相机快照) | 子图节点:", newData.nodes?.length,
        "| 连线:", newData.links?.length,
        "| 文本:", Array.isArray(nd.widgets_values) && String(nd.widgets_values[0]) ? "有" : "空"
    );
}

/* ─── 记录选择弹窗 ─── */

let _pickerCssInjected = false;
function ensurePickerCss() {
    if (_pickerCssInjected) return;
    _pickerCssInjected = true;
    const style = document.createElement("style");
    style.textContent = `
.xzg-a005-picker-mask{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:inherit}
.xzg-a005-picker{min-width:340px;max-width:480px;max-height:70vh;display:flex;flex-direction:column;background:#222;border:1px solid #444;border-radius:20px;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden}
.xzg-a005-picker-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #333;color:#e6e6e6;font-size:14px;font-weight:600}
.xzg-a005-picker-close{background:none;border:none;color:#999;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px}
.xzg-a005-picker-close:hover{color:#fff}
.xzg-a005-picker-list{overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:4px}
.xzg-a005-picker-item{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;box-sizing:border-box;padding:8px 10px;background:#2a2a2a;border:1px solid #333;border-radius:10px;color:#ddd;cursor:pointer;font-size:13px;text-align:left}
.xzg-a005-picker-item:hover{background:#3a3a3a;border-color:#555}
.xzg-a005-picker-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto}
.xzg-a005-picker-del{width:20px;height:20px;flex:0 0 20px;box-sizing:border-box;border:1px solid #555;border-radius:50%;background:transparent;color:#999;cursor:pointer;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0}
.xzg-a005-picker-del:hover{background:#c0392b;border-color:#c0392b;color:#fff}
.xzg-a005-picker-empty{color:#888;text-align:center;padding:14px;font-size:13px}
`;
    document.head.appendChild(style);
}

/* ─── 记录删除 ─── */

/** 删除一条记录（调用后端删除接口）。 */
async function deleteWorkflow(name) {
    try {
        const resp = await fetch("/a005/workflow/delete", {
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
    mask.className = "xzg-a005-picker-mask";

    const panel = document.createElement("div");
    panel.className = "xzg-a005-picker";

    const head = document.createElement("div");
    head.className = "xzg-a005-picker-head";
    const title = document.createElement("span");
    title.textContent = "选择要还原的记录";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "xzg-a005-picker-close";
    close.textContent = "✕";
    close.addEventListener("click", () => closeWorkflowPicker());
    head.append(title, close);

    const list = document.createElement("div");
    list.className = "xzg-a005-picker-list";

    const showEmpty = () => {
        list.innerHTML = "";
        const empty = document.createElement("div");
        empty.className = "xzg-a005-picker-empty";
        empty.textContent = "暂无记录";
        list.appendChild(empty);
    };

    for (const it of items) {
        const row = document.createElement("div");
        row.className = "xzg-a005-picker-item";
        row.tabIndex = 0;
        const t = document.createElement("span");
        t.className = "xzg-a005-picker-title";
        t.textContent = it.title || it.name;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "xzg-a005-picker-del";
        del.textContent = "✕";
        del.title = "删除该记录";
        del.addEventListener("click", async (e) => {
            e.stopPropagation();
            const ok = await deleteWorkflow(it.name);
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

/** 绑定「记录 / 还原」按键（在 setupDomA005 挂载 g 后调用）。 */
export function attachWorkflowButtons(node, g) {
    if (!g) return;
    // 幂等守卫：setupDomA005 重入时直接用旧 DOM 重新绑定 → 每重入一次点击就多发一次请求
    // （点一次「记录」写出 N 份重复文件）。旧 DOM 仍挂着的监听随旧 elements 一起被替换，
    // 因此这里「已绑定过同一 DOM」直接跳过。
    if (g._wfBtnBoundEl === g.recBtn && g._wfBtnBoundEl2 === g.rstBtn) return;
    if (g._wfBtnCleanup) { try { g._wfBtnCleanup(); } catch (_e) { /* 忽略 */ } }
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
    g._wfBtnBoundEl = g.recBtn || null;
    g._wfBtnBoundEl2 = g.rstBtn || null;
    g._wfBtnCleanup = () => {
        if (g.recBtn) g.recBtn.removeEventListener("click", onRecClick);
        if (g.rstBtn) g.rstBtn.removeEventListener("click", onRstClick);
        g._wfBtnCleanup = null;
        g._wfBtnBoundEl = null;
        g._wfBtnBoundEl2 = null;
    };
}
