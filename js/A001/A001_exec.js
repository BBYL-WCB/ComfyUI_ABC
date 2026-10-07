// ═══════════════════════════════════════════════════════════════
//  A001 子图节点 · 执行展开（真执行子图）
//  · isSubgraphNode / resolveSubgraphOutputLink / getInnerNodes
//    （把子图内部节点展开为 ExecutableNodeDTO 参与 prompt）
//
//  官方能力引用（不重造，能引用即引用）：
//  · graphToPrompt 内部按鸭子类型探测 node.getInnerNodes 并调用：
//        let e = t.getInnerNodes ? t.getInnerNodes(new Map) : [t];
//    出处：comfyui_frontend_package/static/assets/settingStore-CwNB8aKw.js
//    （压缩产物，未能逐行引用，故只引用其函数名 getInnerNodes 与调用形态）
//    另见本项目 docs/子图提升机制调研.md 第 9.6 节逐字实录。
//  · ExecutableNodeDTO（前端源码别名 Rc）为压缩产物未导出，
//    只能从官方传入的 nodesByExecutionId 里反查已有实例的 constructor 获得。
//
//  ★ 关键约束：绝不能设置 isVirtualNode=true。
//    官方 graphToPrompt 中有 `for (let t of e) t.isVirtualNode && t.applyToGraph?.()`，
//    虚拟节点会被特殊路径处理，容器收不到 executed 广播 → 预览失效。
//    本结论来自 A005/A006 实测（A005_exec.js / A006_exec.js 同款注释）。
//
//  · 内嵌原生子图定义（本节点子图里再放一个官方 SubgraphNode）：
//    存 properties.embedded_subgraph_defs_json，恢复时 leaf-first 注册
//    UUID node type，内层 SubgraphNode 才不会变成未知节点。
//    蓝本：A005_subgraph.js:97-154 / A006_subgraph.js:97-154（本项目同款实现）。
//    官方能力引用：LGraph.createSubgraph(def) / Subgraph.asSerialisable() /
//    Subgraph.configure(def) / LGraphNode.isSubgraphNode()。
//  ═══════════════════════════════════════════════════════════════

import { alog, safeCall } from "./A001_shared.js?v=20261007a";

/* ─── 内嵌 ComfyUI 原生子图定义 ─── */

/** 判断某节点是否是一个「活的 ComfyUI 原生子图节点」（SubgraphNode，带 .subgraph）。
 *  与 A005_subgraph.js:100-102 / A006_subgraph.js:100-102 同构。 */
function isEmbeddedNativeSubgraphNode(n) {
    return !!n && typeof n.isSubgraphNode === "function" && n.isSubgraphNode() && !!n.subgraph;
}

/** 获取子图内部节点列表（兼容 _nodes / nodes 两种属性名）。 */
function getSgNodes(sg) {
    if (!sg) return [];
    return sg._nodes || sg.nodes || [];
}

/** 收集子图内所有内嵌原生子图定义（ExportedSubgraph 数组），递归、按 id 去重。
 *  官方 Subgraph.asSerialisable() 导出，不自造结构。
 *  与 A005_subgraph.js:105-127 同构。 */
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

/** 恢复前把内嵌原生子图定义注册进 rootGraph（leaf-first，深层 SubgraphNode 才能识别）。
 *  两段式：先全部 createSubgraph 建出来，再统一 configure 灌数据。
 *  若在第一轮就 configure，深层定义自身的 UUID 依赖尚未注册 → 内层节点变未知节点。
 *  官方 LGraph.createSubgraph(def)：能力探测后调用。
 *  与 A005_subgraph.js:130-154 同构。 */
export function restoreEmbeddedSubgraphDefs(node, graph, defs) {
    if (!Array.isArray(defs) || !defs.length) return;
    const root = node?.rootGraph || graph?.rootGraph || graph;
    if (!root || typeof root.createSubgraph !== "function") {
        alog("restoreEmbeddedSubgraphDefs: 无可用 rootGraph.createSubgraph");
        return;
    }
    /* ★ 预建 id→def 索引：第二轮原用 defs.find(...) 逐条线性查找（O(n²)），
     *  改用 Map 后为 O(1)。 */
    const defById = new Map();
    for (const def of defs) {
        if (!def || def.id == null) continue;
        const key = String(def.id);
        if (!defById.has(key)) defById.set(key, def);
    }
    const created = new Map();
    for (const [sid, def] of defById) {
        if (created.has(sid)) continue;
        const existing = (typeof root.subgraphs?.get === "function")
            ? root.subgraphs.get(def.id)
            : undefined;
        const sg = existing
            || safeCall(() => root.createSubgraph(def), null, "restoreEmbedded.createSubgraph");
        if (sg) created.set(sid, sg);
    }
    for (const [sid, sg] of created) {
        const def = defById.get(sid);
        /* ★ 门槛放宽：原判据只看 nodes/links，仅含 groups/inputs/outputs 的内嵌子图
         *  会被跳过 configure，导致其分组/槽元数据丢失（退化为空壳）。 */
        if (def && (def.nodes?.length || def.links?.length
            || def.groups?.length || def.inputs?.length || def.outputs?.length)) {
            safeCall(() => sg.configure?.(def), undefined, "restoreEmbedded.sg.configure");
        }
    }
}

/** ExecutableNodeDTO（前端源码 Rc）构造器缓存。 */
let __a001Rc = null;

/** 缓存 ExecutableNodeDTO 构造器（若尚未缓存）。
 *  自举策略：官方首次调用时传入的是空 Map，查不到就跳过；
 *  但只要任意一次成功从 Map 中拿到已有 DTO，其 constructor 即被缓存复用。
 *  与 A005_exec.js:37-43 / A006_exec.js:51-57 同构。 */
function tryCacheRcCtor(nodesByExecutionId, nodeId) {
    if (__a001Rc) return __a001Rc;
    if (typeof nodesByExecutionId?.get !== "function") return null;
    const selfDto = nodesByExecutionId.get(String(nodeId));
    if (selfDto?.constructor) __a001Rc = selfDto.constructor;
    return __a001Rc;
}

/* ─── 执行展开钩子 ─── */

/**
 * 安装「真执行子图」钩子：isSubgraphNode / resolveSubgraphOutputLink / getInnerNodes。
 * 子图已由入口 nodeCreated 同步建好 → isSubgraphNode 恒 true。
 * 幂等：重复调用直接返回。
 */
export function attachExecutionHooks(node) {
    if (!node || node._a001ExecHooked) return;
    node._a001ExecHooked = true;

    /* 子图身份契约：官方据此渲染「进入子图」入口并参与执行展开。
     * A001_SubgraphNode.js 已在 nodeType.prototype 上装过同名方法（原型级，供所有实例），
     * 这里再挂实例级方法，确保即使原型链被替换也能作答。 */
    node.isSubgraphNode = function () {
        return !!this.subgraph;
    };

    /** 把输出插槽映射到子图内部喂给 outputNode 的节点与链路。
     *  用于「该显示哪个内层节点的产物」的精确溯源。
     *  与 A005_exec.js:63-93 同构，仅私有标记改为 _a001SubgraphSlotId。 */
    node.resolveSubgraphOutputLink = function (slotRef) {
        const sub = this.subgraph;
        const slots = sub?.outputNode?.slots;
        if (!slots) {
            alog("resolveSubgraphOutputLink: outputNode.slots 不存在");
            return null;
        }
        const indexOfSg = (id) => {
            if (id == null) return -1;
            const arr = sub?.outputs;
            if (!Array.isArray(arr)) return -1;
            return arr.findIndex((o) => String(o.id) === String(id));
        };
        let idx = -1;
        if (typeof slotRef === "string") {
            idx = indexOfSg(slotRef);
        } else if (typeof slotRef === "number") {
            const outer = this.outputs?.[slotRef];
            const sgId = outer?._a001SubgraphSlotId;
            idx = sgId != null ? indexOfSg(sgId) : slotRef;
        }
        const slot = idx >= 0 ? slots[idx] : null;
        if (!slot) return null;
        const links = typeof slot.getLinks === "function" ? slot.getLinks() : [];
        const link = links.at(0);
        if (link && typeof link.resolve === "function") {
            return link.resolve(sub);
        }
        alog("resolveSubgraphOutputLink: 输出插槽", slotRef, "内部无直连");
        return null;
    };

    /** 展开子图内部所有节点（含嵌套 A001 与虚拟 io 节点）为 ExecutableNodeDTO。
     *  四个参数全部给默认值，保证官方任何调用形态都不炸。
     *  与 A005_exec.js:96-150 同构。 */
    node.getInnerNodes = function (
        nodesByExecutionId = new Map(),
        subgraphNodePath = [],
        out = [],
        seen = new Set()
    ) {
        if (seen.has(this)) {
            alog("getInnerNodes 循环引用，中断展开");
            return out;
        }
        seen.add(this);
        const path = [...subgraphNodePath, this.id];

        // 反查宿主图：仅用于构造容器自身的 DTO。
        // 旧版前端可能无此方法，故 try/catch 降级为 undefined。
        let hostGraph;
        try {
            hostGraph = this.rootGraph
                ?.resolveSubgraphIdPath?.(path.map(String))
                ?.at(-1);
        } catch (_e) {
            hostGraph = undefined;
        }

        const RcCtor = tryCacheRcCtor(nodesByExecutionId, this.id);
        if (!RcCtor) {
            alog("getInnerNodes: 当前阶段无 Rc 且未缓存，跳过");
            return out;
        }

        // 构造自身 DTO 并登记：这一步同时完成自举闭环——
        // 把自身 DTO 塞进 Map，供后续 tryCacheRcCtor 反查 constructor。
        try {
            const selfDto = new RcCtor(this, subgraphNodePath, nodesByExecutionId, hostGraph);
            nodesByExecutionId.set(selfDto.id, selfDto);
        } catch (e) {
            alog("getInnerNodes: 构造自身 DTO 失败:", e);
            return out;
        }

        const innerList = this.subgraph?.nodes;
        if (!Array.isArray(innerList)) return out;
        for (const inner of innerList) {
            safeCall(
                () => {
                    if (typeof inner.getInnerNodes === "function") {
                        // 嵌套容器（A001 自身 / 官方 SubgraphNode）→ 递归展开
                        inner.getInnerNodes(nodesByExecutionId, path, out, new Set(seen));
                    } else {
                        // 叶子节点（普通节点 / 虚拟 io 节点）→ 包一层 DTO 收进结果
                        // ★ 第 4 参数传 this（容器），与容器自身用 hostGraph 不同
                        const dto = new RcCtor(inner, path, nodesByExecutionId, this);
                        nodesByExecutionId.set(dto.id, dto);
                        out.push(dto);
                    }
                },
                undefined,
                `getInnerNodes 处理 ${inner?.type ?? "?"}`
            );
        }
        return out;
    };
}
