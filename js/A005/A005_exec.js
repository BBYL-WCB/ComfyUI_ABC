// ═══════════════════════════════════════════════════════════════
//  A005 图片节点 · 执行展开 / 局部运行 / 预览刷新
//  · isSubgraphNode / resolveSubgraphOutputLink / getInnerNodes
//    （真执行子图：把子图内部节点展开为 ExecutableNodeDTO 参与 prompt）
//  · 「运行」按钮局部执行（上游 A005 用临时 FeedImage 顶替，避免重算）
//  · executed / execution_cached 事件 → refreshPreview(node)：
//    主图（图片01 口）先加载，有主图才加载对比图（同批、主图之后）；
//    对比图口无图时保持 null（不加载、仅显单图）
//  ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import {
    alog,
    safeCall,
    isOurNode,
    getGraphLink,
    getInnerUiImages,
    loadImagesFromData,
    setPreviewImages,
    requestPreviewRedraw,
    ensureMinNodeSize,
    LG_MODE_NEVER,
    a005Nodes,
} from "./A005_shared.js";
import {
    getFirstSavedPreview,
    savePreviewProps,
} from "./A005_subgraph.js";

/** ExecutableNodeDTO（前端源码 Rc）构造器缓存。 */
let __a005Rc = null;

const INNER_UI_IMAGES_LIMIT = 32;

/** 缓存 ExecutableNodeDTO 构造器（若尚未缓存）。 */
function tryCacheRcCtor(nodesByExecutionId, nodeId) {
    if (__a005Rc) return __a005Rc;
    if (typeof nodesByExecutionId?.get !== "function") return null;
    const selfDto = nodesByExecutionId.get(String(nodeId));
    if (selfDto?.constructor) __a005Rc = selfDto.constructor;
    return __a005Rc;
}

/* ─── 执行展开钩子 ─── */

/**
 * 安装「真执行子图」钩子：isSubgraphNode / resolveSubgraphOutputLink / getInnerNodes。
 * 子图已由入口 nodeCreated 同步建好 → isSubgraphNode 恒 true。
 * 注意：不能设置 isVirtualNode=true —— 虚拟节点会被 graphToPrompt 跳过，
 * 容器永远收不到 ui.images → 预览失效。
 */
export function attachExecutionHooks(node) {
    if (node._a005ExecHooked) return;
    node._a005ExecHooked = true;
    a005Nodes.add(node);

    node.isSubgraphNode = function () {
        return !!this.subgraph;
    };

    /** 把输出插槽映射到子图内部喂给 outputNode 的节点与链路。 */
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
            const sgId = outer?._a005SubgraphSlotId;
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

    /** 展开子图内部所有节点（含嵌套 A005 与虚拟 io 节点）为 ExecutableNodeDTO。 */
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
                        inner.getInnerNodes(nodesByExecutionId, path, out, new Set(seen));
                    } else {
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

/* ─── 「运行」按钮局部执行 ─── */

/** 收集 node 的上游闭包节点 ID（遇到 skipIds 视为终点）。 */
function collectUpstreamClosure(graph, node, skipIds) {
    const keep = new Set([node.id]);
    const stack = [node];
    while (stack.length) {
        const n = stack.pop();
        for (const inp of n.inputs || []) {
            if (inp.link == null) continue;
            const link = getGraphLink(graph, inp.link);
            if (!link) continue;
            const srcId = link.origin_id;
            if (skipIds.has(srcId) || keep.has(srcId)) continue;
            const src = graph.getNodeById(srcId);
            if (src) {
                keep.add(srcId);
                stack.push(src);
            }
        }
    }
    return keep;
}

/** 创建一个临时 A005_FeedImage 节点，挂载 src 的第一张已保存预览图。创建失败返回 null。 */
function createTempFeedNode(LG, graph, src) {
    const prev = getFirstSavedPreview(src);
    if (!prev || !prev.filename) {
        alog("上游 A005 无已保存图片，该输入保持实时执行 | id:", src.id);
        return null;
    }
    const temp = LG?.createNode?.("A005_FeedImage");
    if (!temp) {
        alog("A005_FeedImage 未注册（请重启 ComfyUI），该输入保持实时执行");
        return null;
    }
    temp.title = "A005 供图(临时)";
    const feedParams = {
        filename: prev.filename,
        subfolder: prev.subfolder || "",
        path_type: prev.type || "temp",
    };
    for (const w of temp.widgets || []) {
        if (feedParams[w.name] !== undefined) w.value = feedParams[w.name];
    }
    temp.pos = [src.pos[0], src.pos[1] - 220];
    graph.add(temp);
    return { temp };
}

/**
 * 局部执行：只运行当前 A005（含子图内部节点 + 外部非 A005 依赖链）。
 * 上游其它 A005 节点用临时 FeedImage 顶替其上次预览图，避免重新计算。
 */
async function runNodeOnly(node) {
    const graph = node.graph;
    if (!graph || !Array.isArray(graph.nodes)) return;
    const LG = window.LiteGraph;

    /** @type {Array<{temp:object, slotIdx:number, originNode:object, originSlot:number}>} */
    const tempNodes = [];
    const skipIds = new Set();

    for (const inp of node.inputs || []) {
        if (inp.link == null) continue;
        const link = getGraphLink(graph, inp.link);
        if (!link) continue;
        const src = graph.getNodeById(link.origin_id);
        if (!src || src.id === node.id || !isOurNode(src)) continue;

        const created = createTempFeedNode(LG, graph, src);
        if (!created) continue;
        const { temp } = created;
        const slotIdx = node.inputs.indexOf(inp);
        // 先登记再断线：disconnectInput 成功后若 connect 抛错，finally 仍能按此条目恢复原连线，
        // 避免"原连线已断且未被记录"造成永久丢线。
        tempNodes.push({ temp, inp, slotIdx, originNode: src, originSlot: link.origin_slot });
        const okDisc = safeCall(() => node.disconnectInput(slotIdx), false, "断开原连线");
        if (okDisc === false) {
            tempNodes.pop();
            safeCall(() => graph.remove(temp), undefined, "删除临时 FeedNode");
            continue;
        }
        const okConn = safeCall(() => temp.connect(0, node, slotIdx), false, "接临时连线");
        if (okConn === false) {
            safeCall(() => src.connect(link.origin_slot, node, node.inputs.indexOf(inp)), undefined, "回滚原连线");
            tempNodes.pop();
            safeCall(() => graph.remove(temp), undefined, "删除临时 FeedNode");
            continue;
        }
        skipIds.add(src.id);
    }

    const keepIds = collectUpstreamClosure(graph, node, skipIds);

    const modeSnapshot = graph.nodes.map((n) => ({ n, mode: n.mode }));
    for (const { n } of modeSnapshot) {
        if (!keepIds.has(n.id)) n.mode = LG_MODE_NEVER;
    }
    try {
        await app.queuePrompt(0, 1);
    } finally {
        for (const { n, mode } of modeSnapshot) n.mode = mode;
        for (const { temp, inp, originNode, originSlot } of tempNodes) {
            // 临时连线期间用户可能增删端口，slotIdx 会失效 → 用输入对象实例回查当前下标
            const idx = (node.inputs || []).indexOf(inp);
            if (idx >= 0) {
                safeCall(() => node.disconnectInput(idx), undefined, "断开临时连线");
                safeCall(() => originNode.connect(originSlot, node, idx), undefined, "恢复原连线");
            }
            safeCall(() => graph.remove(temp), undefined, "删除临时 FeedNode");
        }
        graph.change?.();
    }
}

/** 串行化多次「运行」按钮点击：避免静音快照相互污染。 */
let _a005RunChain = Promise.resolve();

/** 排队执行局部运行（供 UI 按钮调用）。 */
export function queueRunNodeOnly(node) {
    _a005RunChain = _a005RunChain
        .then(() => runNodeOnly(node))
        .catch((e) => alog("部分执行失败:", e));
}

/* ─── 预览刷新（executed / execution_cached 事件） ─── */

/**
 * 刷新单个 A005 节点预览：主图 + 对比图同批加载（同一 refreshPreview）。
 * 1) 主图（图片01 口）→ feed 广播图；
 * 2) 有主图后才加载对比图（子图「对比图」口 feed 广播图）；对比图口无图 → 保持 null，仅显单图。
 */
export function refreshPreview(node) {
    if (!node?.subgraph) return;

    // 1) 主图（图片01 口）
    const mainRes = safeCall(
        () => node.resolveSubgraphOutputLink?.(
            node.subgraph?.outputs?.find?.((o) => o.name === "图片01")?.id
        ),
        null,
        "refreshPreview.mainResolve"
    );
    const mainFeedId = mainRes?.link?.origin_id;
    const mainImages = mainFeedId !== undefined && mainFeedId !== null
        ? getInnerUiImages(node, mainFeedId)
        : [];
    const mainImgs = loadImagesFromData(mainImages, () => requestPreviewRedraw(node));

    // 2) 对比图：图片01 有图才加载（同批、主图之后）；无图不加载、保持单图
    let cmpImg = null;
    if (mainImgs.length > 0) {
        const cmpRes = safeCall(
            () => node.resolveSubgraphOutputLink?.(
                node.subgraph?.outputs?.find?.((o) => o.name === "对比图")?.id
            ),
            null,
            "refreshPreview.cmpResolve"
        );
        const cmpFeedId = cmpRes?.link?.origin_id;
        const cmpImages = cmpFeedId !== undefined && cmpFeedId !== null
            ? getInnerUiImages(node, cmpFeedId)
            : [];
        const cmpImgs = loadImagesFromData(cmpImages, () => requestPreviewRedraw(node));
        if (cmpImgs.length) cmpImg = cmpImgs[0];
    }
    node._a005CompareImg = cmpImg;

    setPreviewImages(node, mainImgs);
    savePreviewProps(node, mainImages);
    ensureMinNodeSize(node);
    requestPreviewRedraw(node);
    alog(
        `预览刷新 | 主图: ${mainImgs.length}` +
        ` | 对比图: ${cmpImg ? 1 : 0}` +
        ` | 对比图口: ${mainImgs.length > 0 ? "已查" : "跳过(主图无)"}`
    );
}

/**
 * 安装全局预览刷新监听（幂等）。
 * execId 可能为容器自身 id，或 "容器id:子图内feedId"。
 */
export function installPreviewRefresh() {
    if (window.__a005ExecutedHooked) return;
    window.__a005ExecutedHooked = true;

    /** 为匹配 execId 的 A005 节点刷新预览（统一走 refreshPreview）。 */
    function showForExecId(execId) {
        if (typeof execId !== "string") return;
        // 应急处置 hot path 优化：execId 形如 "外层id" 或 "外层id:内层id"，
        // 先按外层 id 前缀快速过滤，仅对可能匹配的节点做成本较高的 resolveSubgraphOutputLink 解析，
        // 避免每次 executed 事件都对全部 A005 节点做链路解析（大图/多 A005 场景的热点）。
        const colonIdx = execId.indexOf(":");
        const outerPrefix = colonIdx > 0 ? execId.slice(0, colonIdx) : execId;
        for (const an of a005Nodes) {
            if (!an || an.id == null || !an.subgraph) continue;
            const selfId = String(an.id);
            if (selfId !== outerPrefix && execId !== selfId) continue;

            const res = safeCall(
                () => an.resolveSubgraphOutputLink?.(
                    an.subgraph?.outputs?.find?.((o) => o.name === "图片01")?.id
                ),
                undefined,
                "resolveSubgraphOutputLink"
            );
            const feedId = res?.link?.origin_id;
            if (feedId === undefined || feedId === null) continue;

            const targetSelf = selfId;
            const targetFeed = `${selfId}:${feedId}`;
            if (execId !== targetSelf && execId !== targetFeed) continue;

            refreshPreview(an);
            alog(`预览回灌触发 | execId: ${execId} | 节点: ${targetSelf}`);
        }
    }

    // 节点执行完成 → ① 缓存子图内产出节点的广播图片，② 触发预览刷新
    api.addEventListener("executed", ({ detail }) => safeCall(
        () => {
            if (!detail) return;
            const execNodeStr = String(detail.node);
            // 广播来自 A005 子图内部节点（execId = "外层id:内层id"）→ 缓存其图片，
            // 供 SaveImage/PreviewImage 等"执行产出图"feed 的主图/对比图取图使用。
            const colIdx = execNodeStr.indexOf(":");
            if (colIdx > 0) {
                const outerId = execNodeStr.slice(0, colIdx);
                const innerId = execNodeStr.slice(colIdx + 1);
                const images = Array.isArray(detail.output?.images) ? detail.output.images : [];
                if (images.length) {
                    for (const an of a005Nodes) {
                        if (String(an.id) !== outerId || !an.subgraph) continue;
                        an._a005InnerUiImages = an._a005InnerUiImages || new Map();
                        const m = an._a005InnerUiImages;
                        m.set(String(innerId), images);
                        while (m.size > INNER_UI_IMAGES_LIMIT) {
                            m.delete(m.keys().next().value);
                        }
                    }
                }
            }
            showForExecId(execNodeStr);
        },
        undefined,
        "executed 预览回灌"
    ));

    // 服务端缓存命中 → 广播 execution_cached（同样触发预览刷新）
    api.addEventListener("execution_cached", ({ detail }) => safeCall(
        () => {
            if (!detail) return;
            const ids = Array.isArray(detail.nodes) ? detail.nodes.map(String) : [];
            for (const id of ids) showForExecId(id);
        },
        undefined,
        "execution_cached 预览回灌"
    ));
}

// 模块加载即安装（幂等）
installPreviewRefresh();
