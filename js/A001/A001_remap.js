// ═══════════════════════════════════════════════════════════════
//  A001_子图节点 · id 重映射簇（拆分自 A001_SubgraphNode.js）
//
//  职责：解决 ComfyUI v0.38.x 起的「复制粘贴 / 反序列化后子图丢失」问题 ——
//  官方只对官方子图定义内的 node.id 重映射（patchLinkNodeIds 仅同步 origin/target），
//  完全不碰 link.id / reroute.id，也绕过 A001 的私有 subgraph_data_json 通道。
//  本簇基于 rootGraph.state（与官方同源）为 node/link/reroute/group/subgraph 统一
//  分配全局唯一新号，并同步全部引用。
//
//  ⚠️ 行为保持约束：本文件内的实现与原 A001_SubgraphNode.js 中同名成员**逐字一致**。
//     这段逻辑是本项目最敏感的区域之一（多轮浏览器实测才收敛），
//     搬迁时**严禁**调整取号顺序、判据与引用同步范围。
//
//  依赖方向：只依赖 A001_shared.js（A001 唯一共享层）。
// ═══════════════════════════════════════════════════════════════

import {
    alog,
    safeCall,
    getNodeGraphSilent as getNodeGraph,
    uuidv4,
    SG_INPUT_NODE_ID,
    SG_OUTPUT_NODE_ID,
} from "./A001_shared.js?v=20261007a";

/** 复制粘贴 ID 冲突检测 → 整体重映射（槽/节点/连线/分组/reroute + 计数器
 *   + 外层端口标记 + 提升端口 + 内嵌子图定义），并把重映射后的数据写回 properties，
 *   否则刷新/保存时又退回旧 ID。调用点注释见 ensureSubgraph 内。
 *
 *  ★ 只做一次（2026-10-05）：
 *    configure 已对 info.properties.subgraph_data_json 执行同一套重映射并置 __a001RemapDone；
 *    ensureSubgraph 随后从 properties 读到的就是「已重映射」的数据。若此处再重映射一次，
 *    会给全部 id 再分配一轮新号 → 「私有通道 data 的 id」与「官方按 info.properties 建好的
 *    实例 id」分叉，污染序列化并使按 id 精确匹配的回灌静默失配。故以节点级标记去重。
 *
 *  ★ 旧注释曾写「检测到官方具备 normalizeSubgraphDefinitions 即直接跳过」——经复核**不可行**：
 *    官方 normalize 只 remint node.id（patchLinkNodeIds 仅同步 origin/target），不碰
 *    link.id / reroute.id，且完全绕过 A001 的私有 subgraph_data_json；直接跳过会让
 *    link/reroute id 与 rootGraph 注册表冲突（实测复制粘贴 link 52→14→7→0）。故保留重映射。 */
export function remapSubgraphOnIdConflict(node, data) {
    if (node?.__a001RemapDone) return false;
    /* ★★ 复制粘贴 id 重映射（重写版，浏览器实测 2026-10-03）：
     *  完全模仿官方 _deserializeItems 里的 remapClipboardSubgraphNodeIds 思路，
     *  但补上官方漏掉的两类 id —— link.id 与 reroute.id：
     *    官方只对 e.subgraphs 里的 node.id 重映射（patchLinkNodeIds 仅同步 origin/target），
     *    而 A001 的子图走私有通道 properties.subgraph_data_json，被官方机制完全绕过；
     *    且 A001 自建的 graph.createSubgraph→normalizeSubgraphDefinitions 也只 remint node id。
     *    结果：link/reroute id 与 rootGraph 已注册冲突 → replaceLink/registerReroute 拒绝
     *    → 连续粘贴 52→14→7→0。
     *  本函数基于 rootGraph.state（与官方同源）为 data 的 node/link/reroute/group
     *  统一分配全局唯一新 id，并同步全部引用，保证与官方机制不冲突。 */
    const graph = getNodeGraph(node);
    const root = graph?.rootGraph || graph || app?.rootGraph || app?.graph;
    safeCall(() => remapA001ClipboardData(data, root), undefined, "复制粘贴 id 重映射");
    safeCall(() => {
        node.properties = node.properties || {};
        node.properties.subgraph_data_json = JSON.stringify(data);
    }, undefined, "重映射数据回写");
    /* ★ 置位：同一次反序列化内，ensureSubgraph 不再重复重映射。 */
    node.__a001RemapDone = true;
    return true;
}

/** A001 子图数据的全局唯一 id 重映射：模仿官方 remapClipboardSubgraphNodeIds，
 *  并对 node/link/reroute/group 四类 id 做完整重分配 + 引用同步。
 *
 *  与官方一致地使用 rootGraph.state 水位（mintNodeId/observeNodeId 语义）：
 *    · 先 observeNodeId：把 rootGraph 上全部既有 node id 纳入水位与已用集合；
 *    · 新 id = ++state.lastNodeId（循环直到不在已用集合），天然全局唯一；
 *    · link/reroute/group 分别用各自 state 计数器，同理分配。
 *  返回 {nodeMap, linkMap, rerouteMap, groupMap} 供调用方（如外层端口标记）使用。 */
export function remapA001ClipboardData(data, root) {
    const res = {
        nodeMap: new Map(), linkMap: new Map(), rerouteMap: new Map(), groupMap: new Map(),
        /* ★ subgraphIdMap：旧子图 id → 新子图 id。
         *  调用方据此把「引用该子图」的节点 type 同步为新 id（内嵌原生子图场景）。 */
        subgraphIdMap: new Map(),
    };
    if (!data || typeof data !== "object" || !root) return res;
    const st = root.state || (root.state = { lastNodeId: 0, lastLinkId: 0, lastGroupId: 0, lastRerouteId: 0 });
    // ① 收集 rootGraph（含全部子图）已用的 node/link/reroute/group id
    const usedNode = new Set();
    const usedLink = new Set();
    const usedReroute = new Set();
    const usedGroup = new Set();
    const seen = new Set();
    const addLinks = (m, s) => {
        if (!m) return;
        if (typeof m.keys === "function") { for (const k of m.keys()) s.add(String(k)); }
        else if (typeof m === "object") { for (const k of Object.keys(m)) s.add(String(k)); }
    };
    const walk = (g, depth) => {
        if (!g || depth > 8 || seen.has(g)) return;
        seen.add(g);
        for (const n of g._nodes || g.nodes || []) if (n?.id != null) usedNode.add(String(n.id));
        addLinks(g.links, usedLink);
        addLinks(g.floatingLinks, usedLink);
        addLinks(g.reroutes, usedReroute);
        for (const gr of g.groups || g._groups || []) if (gr?.id != null) usedGroup.add(String(gr.id));
        try { if (g.subgraphs) for (const x of g.subgraphs.values()) walk(x, depth + 1); } catch (_e) { /* 忽略 */ }
    };
    walk(root, 0);
    // 水位对齐：把已用最大值抬到 state（等价官方 observeNodeId/observeLinkId）
    const bump = (set, key) => {
        let max = Number(st[key]) || 0;
        for (const v of set) { const n = Number(v); if (Number.isInteger(n) && n > max) max = n; }
        st[key] = max;
    };
    bump(usedNode, "lastNodeId");
    bump(usedLink, "lastLinkId");
    bump(usedReroute, "lastRerouteId");
    bump(usedGroup, "lastGroupId");
    /* ② 取号器（往复取号，2026-10-06）：
     *  取值域 [1000, 1000000]。递增超过 1000000 后转为递减；
     *  递减低于 1000 后转回递增，循环往复。
     *  每次取号跳过已用集合中的 id，保证同一画布同一 ID 不冲突；
     *  区间耗尽则兜底单调递增突破（避免死循环）。 */
    const ID_LOW = 1000;
    const ID_HIGH = 1000000;
    const makeMint = (usedSet, startVal, stateKey) => {
        let cursor = Number(startVal);
        if (!Number.isInteger(cursor)) cursor = ID_LOW;
        let dir = 1;
        if (cursor >= ID_HIGH) { cursor = ID_HIGH; dir = -1; }
        else if (cursor < ID_LOW) { cursor = ID_LOW - 1; dir = 1; }
        return () => {
            const span = ID_HIGH - ID_LOW + 1;
            for (let i = 0; i < span; i++) {
                if (dir > 0) {
                    cursor += 1;
                    if (cursor > ID_HIGH) { dir = -1; cursor = ID_HIGH; }
                } else {
                    cursor -= 1;
                    if (cursor < ID_LOW) { dir = 1; cursor = ID_LOW; }
                }
                if (!usedSet.has(String(cursor))) {
                    usedSet.add(String(cursor));
                    st[stateKey] = cursor;
                    return cursor;
                }
            }
            for (let i = 0; i < 1e7; i++) { const v = ++st[stateKey]; if (!usedSet.has(String(v))) { usedSet.add(String(v)); return v; } }
            return ++st[stateKey];
        };
    };
    const mintNode = makeMint(usedNode, st.lastNodeId, "lastNodeId");
    const mintLink = makeMint(usedLink, st.lastLinkId, "lastLinkId");
    const mintReroute = makeMint(usedReroute, st.lastRerouteId, "lastRerouteId");
    const mintGroup = makeMint(usedGroup, st.lastGroupId, "lastGroupId");
    const isSentinel = (v) => {
        if (v === SG_INPUT_NODE_ID || v === SG_OUTPUT_NODE_ID) return true;
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) && n < 0;
    };

    /* ★ id 判定与类型保持（2026-10-06）：纯数字与「纯数字字符串」
     *  都走往复取号（避免 id 变为字符串后绕过往复规则）；
     *  取号后保持原类型：原值为字符串则返回字符串，否则返回数字。 */
    const isNumericId = (v) => typeof v === "number" || /^\d+$/.test(String(v));
    const asSameType = (v, n) => (typeof v === "string" ? String(n) : n);
    /* ②.5 subgraph 自身 id 重分配（★ v0.38.x「粘贴后子图无法识别」根因之一）。
     *  官方 normalizeSubgraphDefinitionIds 对**UUID 形状**的子图 id 一律保留不动
     *  （只替换 legacy 非 UUID id），随后 createNormalizedSubgraph 执行
     *      this.subgraphs.set(id, subgraph)
     *  —— 若粘贴数据的 id 与源节点相同，就会用同一个 key 互相覆盖：
     *     · rootGraph.subgraphs 里该 id 只留最后一份；
     *     · 官方 registerSubgraphNodeDef 以该 id 注册节点类，类的闭包 subgraph
     *       指向被覆盖后的实例；
     *     · 于是「进入子图」进入的是别的实例，内层 SubgraphNode 的 type 解析错位
     *       → 子图无法识别 / 标题与退出入口消失。
     *  故这里为 subgraph 自身分配全新 uuid。数字 id（官方 mint 序号）不属于
     *  本函数管辖范围（那是 node/link 的取号器），保持不变。 */
    if (data.id != null && typeof data.id === "string" && data.id.length
        && !/^\d+$/.test(data.id)) {
        const oldSgId = String(data.id);
        data.id = uuidv4();
        res.subgraphIdMap.set(oldSgId, data.id);
    }
    // ③ 分配：节点（含槽位）/ 连线 / reroute / 分组
    const mapNode = (v) => {
        if (v == null || isSentinel(v)) return v;
        const k = String(v);
        if (res.nodeMap.has(k)) return res.nodeMap.get(k);
        const nv = isNumericId(v) ? asSameType(v, mintNode()) : uuidv4();
        res.nodeMap.set(k, nv); return nv;
    };
    const mapLink = (v) => {
        if (v == null || isSentinel(v)) return v;
        const k = String(v);
        if (res.linkMap.has(k)) return res.linkMap.get(k);
        const nv = isNumericId(v) ? asSameType(v, mintLink()) : uuidv4();
        res.linkMap.set(k, nv); return nv;
    };
    const mapReroute = (v) => {
        if (v == null || isSentinel(v)) return v;
        const k = String(v);
        if (res.rerouteMap.has(k)) return res.rerouteMap.get(k);
        const nv = isNumericId(v) ? asSameType(v, mintReroute()) : uuidv4();
        res.rerouteMap.set(k, nv); return nv;
    };
    const mapGroup = (v) => {
        if (v == null || isSentinel(v)) return v;
        const k = String(v);
        if (res.groupMap.has(k)) return res.groupMap.get(k);
        const nv = isNumericId(v) ? asSameType(v, mintGroup()) : uuidv4();
        res.groupMap.set(k, nv); return nv;
    };
    // 第一遍：为所有 id 建立映射
    for (const s of [...(data.inputs || []), ...(data.outputs || [])]) if (s?.id != null) mapNode(s.id);
    for (const n of data.nodes || []) if (n?.id != null) mapNode(n.id);
    for (const l of data.links || []) if (l?.id != null) mapLink(l.id);
    for (const l of data.floatingLinks || []) if (l?.id != null) mapLink(l.id);
    for (const g of data.groups || []) if (g?.id != null) mapGroup(g.id);
    for (const r of data.reroutes || []) if (r?.id != null) mapReroute(r.id);
    // 第二遍：写回全部字段与引用
    for (const s of [...(data.inputs || []), ...(data.outputs || [])]) {
        if (s?.id != null) s.id = mapNode(s.id);
        if (Array.isArray(s?.linkIds)) s.linkIds = s.linkIds.map(mapLink);
    }
    for (const n of data.nodes || []) {
        if (n?.id != null) n.id = mapNode(n.id);
        for (const inp of n?.inputs || []) {
            if (inp?.link != null) inp.link = mapLink(inp.link);
            if (inp?.slot != null && typeof inp.slot === "string") inp.slot = mapNode(inp.slot);
        }
        for (const out of n?.outputs || []) {
            if (Array.isArray(out?.links)) out.links = out.links.map(mapLink);
            if (out?.slot != null && typeof out.slot === "string") out.slot = mapNode(out.slot);
        }
        if (n?.group != null && Number.isFinite(n.group)) n.group = mapGroup(n.group);
        if (n?.properties?.previewExposures && Array.isArray(n.properties.previewExposures)) {
            for (const exp of n.properties.previewExposures) {
                if (exp && exp.sourceNodeId != null) {
                    const v = /^\d+$/.test(String(exp.sourceNodeId)) ? Number(exp.sourceNodeId) : exp.sourceNodeId;
                    exp.sourceNodeId = mapNode(v);
                }
            }
        }
    }
    for (const l of data.links || []) {
        if (l?.id != null) l.id = mapLink(l.id);
        if (l?.origin_id != null) l.origin_id = mapNode(l.origin_id);
        if (l?.target_id != null) l.target_id = mapNode(l.target_id);
        if (l?.parentId != null) l.parentId = mapReroute(l.parentId);
    }
    for (const l of data.floatingLinks || []) {
        if (l?.id != null) l.id = mapLink(l.id);
        if (l?.origin_id != null) l.origin_id = mapNode(l.origin_id);
        if (l?.target_id != null) l.target_id = mapNode(l.target_id);
        if (l?.parentId != null) l.parentId = mapReroute(l.parentId);
    }
    for (const g of data.groups || []) {
        if (g?.id != null) g.id = mapGroup(g.id);
        if (Array.isArray(g?.nodes)) g.nodes = g.nodes.map(mapNode);
    }
    for (const r of data.reroutes || []) {
        if (r?.id != null) r.id = mapReroute(r.id);
        if (r?.parentId != null) r.parentId = mapReroute(r.parentId);
        if (Array.isArray(r?.linkIds)) r.linkIds = r.linkIds.map(mapLink);
    }
    // ④ state 与 rootGraph 对齐（避免后续新建复用旧 id 或 id 空间耗尽）
    data.state = data.state || {};
    data.state.lastNodeId = st.lastNodeId;
    data.state.lastLinkId = st.lastLinkId;
    data.state.lastGroupId = st.lastGroupId;
    data.state.lastRerouteId = st.lastRerouteId;
    alog(`复制粘贴 id 重映射：node ${res.nodeMap.size} / link ${res.linkMap.size} / reroute ${res.rerouteMap.size} / group ${res.groupMap.size}（基于 rootGraph.state 全局唯一）`);
    return res;
}
