// ═══════════════════════════════════════════════════════════════
//  A006 视频节点 · 执行展开 / 局部运行 / 预览刷新
//  · isSubgraphNode / resolveSubgraphOutputLink / getInnerNodes
//    （真执行子图：把子图内部节点展开为 ExecutableNodeDTO 参与 prompt）
//  · 「运行」按钮局部执行（上游 A006 用临时 FeedVideo 顶替，避免重算）
//  · executed / execution_cached 事件 → refreshPreview(node)：
//    视频01（视频01 口）先加载，只有视频01 有视频才去解析「对比视频」口并加载（同批、视频01 之后）；
//    对比视频口无视频时保持 null（不加载、仅显单视频）
//  ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import {
    alog,
    safeCall,
    isOurNode,
    getGraphLink,
    getInnerUiVideos,
    loadVideosFromData,
    setPreviewVideos,
    requestPreviewRedraw,
    ensureMinNodeSize,
    removeNativePreviewWidget,
    LG_MODE_NEVER,
    a006Nodes,
} from "./A006_shared.js";
import {
    getFirstSavedPreview,
    savePreviewProps,
} from "./A006_subgraph.js";

/** ExecutableNodeDTO（前端源码 Rc）构造器缓存。 */
let __a006Rc = null;

const INNER_UI_IMAGES_LIMIT = 32;

/** 从 executed 事件 detail 中提取视频/预览数据（兼容多种后端结构形态）。 */
function _extractOutputVideos(detail) {
    const o = detail?.output;
    if (Array.isArray(o?.videos)) return o.videos;
    if (Array.isArray(o?.video)) return o.video;
    if (Array.isArray(o?.images)) return o.images;
    if (Array.isArray(o) && o.length) return o;      // output 本身就是预览数组
    if (Array.isArray(detail?.videos)) return detail.videos;
    if (Array.isArray(detail?.video)) return detail.video;
    if (Array.isArray(detail?.images)) return detail.images;
    return [];
}

/** 缓存 ExecutableNodeDTO 构造器（若尚未缓存）。 */
function tryCacheRcCtor(nodesByExecutionId, nodeId) {
    if (__a006Rc) return __a006Rc;
    if (typeof nodesByExecutionId?.get !== "function") return null;
    const selfDto = nodesByExecutionId.get(String(nodeId));
    if (selfDto?.constructor) __a006Rc = selfDto.constructor;
    return __a006Rc;
}

/* ─── 执行展开钩子 ─── */

/**
 * 安装「真执行子图」钩子：isSubgraphNode / resolveSubgraphOutputLink / getInnerNodes。
 * 子图已由入口 nodeCreated 同步建好 → isSubgraphNode 恒 true。
 * 注意：不能设置 isVirtualNode=true —— 虚拟节点会被 graphToPrompt 跳过，
 * 容器永远收不到 ui.images → 预览失效。
 */
export function attachExecutionHooks(node) {
    if (node._a006ExecHooked) return;
    node._a006ExecHooked = true;
    a006Nodes.add(node);

    node.isSubgraphNode = function () {
        return !!this.subgraph;
    };

    /** 把外层输出插槽映射到子图内部喂给 outputNode 的节点与链路。 */
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
            const sgId = outer?._a006SubgraphSlotId;
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

    /** 展开子图内部所有节点（含嵌套 A006 与虚拟 io 节点）为 ExecutableNodeDTO。 */
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

/** 创建一个临时 A006_FeedVideo 节点，挂载 src 的第一个已保存预览视频。创建失败返回 null。 */
function createTempFeedNode(LG, graph, src) {
    const prev = getFirstSavedPreview(src);
    if (!prev || !prev.filename) {
        alog("上游 A006 无已保存视频，该输入保持实时执行 | id:", src.id);
        return null;
    }
    const temp = LG?.createNode?.("A006_FeedVideo");
    if (!temp) {
        alog("A006_FeedVideo 未注册（请重启 ComfyUI），该输入保持实时执行");
        return null;
    }
    temp.title = "A006 供视频(临时)";
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
 * 局部执行：只运行当前 A006（含子图内部节点 + 外部非 A006 依赖链）。
 * 上游其它 A006 节点用临时 FeedVideo 顶替其上次预览视频，避免重新计算。
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
let _a006RunChain = Promise.resolve();

/** 排队执行局部运行（供 UI 按钮调用）。 */
export function queueRunNodeOnly(node) {
    _a006RunChain = _a006RunChain
        .then(() => runNodeOnly(node))
        .catch((e) => alog("部分执行失败:", e));
}

/* ─── 预览刷新（executed / execution_cached 事件） ─── */

/**
 * 刷新单个 A006 节点预览：视频01 + 对比视频同批加载（同一 refreshPreview）。
 * 1) 视频01（视频01 口）→ feed 广播视频；
 * 2) 只有视频01 有视频才去解析「对比视频」口并加载（同批、视频01 之后）；对比视频口无视频 → 保持 null，仅显单视频。
 */
export function refreshPreview(node) {
    if (!node?.subgraph) return;

    // 1) 视频01（视频01 口）：优先取插槽精确源；无命中时回退最近产出的视频
    let video01Data = null;
    const video01Res = safeCall(
        () => node.resolveSubgraphOutputLink?.(
            node.subgraph?.outputs?.find?.((o) => o.name === "视频01")?.id
        ),
        null,
        "refreshPreview.video01Resolve"
    );
    const video01FeedId = video01Res?.link?.origin_id;
    if (video01FeedId !== undefined && video01FeedId !== null) {
        video01Data = getInnerUiVideos(node, video01FeedId);
    }
    if (!Array.isArray(video01Data) || !video01Data.length) {
        const latest = node._a006LatestVideos;
        video01Data = Array.isArray(latest) ? latest : [];
        if (video01Data.length) alog("视频01 源无命中，回退次最近产出视频 |", video01Data.length);
    }
    const video01Urls = loadVideosFromData(video01Data, () => requestPreviewRedraw(node));

    // 2) 对比视频：只有视频01 有视频才去解析「对比视频」口并加载（同批、视频01 之后）；
    //    对比视频口无视频 → 保持 null、仅显单视频
    let cmpUrl = null;
    if (video01Urls.length > 0) {
        const cmpRes = safeCall(
            () => node.resolveSubgraphOutputLink?.(
                node.subgraph?.outputs?.find?.((o) => o.name === "对比视频")?.id
            ),
            null,
            "refreshPreview.cmpResolve"
        );
        const cmpFeedId = cmpRes?.link?.origin_id;
        const cmpData = cmpFeedId !== undefined && cmpFeedId !== null
            ? getInnerUiVideos(node, cmpFeedId)
            : [];
        const cmpUrls = loadVideosFromData(cmpData, () => requestPreviewRedraw(node));
        if (cmpUrls.length) cmpUrl = cmpUrls[0];
    }
    node._a006CompareUrl = cmpUrl;

    setPreviewVideos(node, video01Urls);
    savePreviewProps(node, video01Data);
    ensureMinNodeSize(node);
    // 清掉框架挂上的原生视频预览控件（异步挂载的由 DOM 观察器兜底移除）
    removeNativePreviewWidget(node);
    requestPreviewRedraw(node);
    alog(
        `预览刷新 | 视频01: ${video01Urls.length}` +
        ` | 对比视频: ${cmpUrl ? 1 : 0}` +
        ` | 对比视频口: ${video01Urls.length > 0 ? "已查" : "跳过(视频01无视频)"}`
    );
}

/**
 * 安装全局预览刷新监听（幂等）。
 * execId 可能为容器自身 id，或 "容器id:子图内feedId"。
 */
export function installPreviewRefresh() {
    if (window.__a006ExecutedHooked) return;
    window.__a006ExecutedHooked = true;

    /** 为匹配 execId 的 A006 节点刷新预览（统一走 refreshPreview）。 */
    function showForExecId(execId) {
        if (typeof execId !== "string") return;
        // 应急处置 hot path 优化：execId 形如 "外层id" 或 "外层id:内层id"，
        // 先按外层 id 前缀快速过滤，仅对可能匹配的节点做成本较高的 resolveSubgraphOutputLink 解析，
        // 避免每次 executed 事件都对全部 A006 节点做链路解析（大图/多 A006 场景的热点）。
        const colonIdx = execId.indexOf(":");
        const outerPrefix = colonIdx > 0 ? execId.slice(0, colonIdx) : execId;
        for (const an of a006Nodes) {
            if (!an || an.id == null || !an.subgraph) continue;
            const selfId = String(an.id);
            if (selfId !== outerPrefix && execId !== selfId) continue;

            // 任一输出槽（视频01 / 对比视频）的 feed 广播都视为该节点产出了视频 → 触发刷新。
            // 原实现只匹配「视频01」槽：对比视频 feed 广播到位时永远不触发 refreshPreview，
            // 首次运行对比视频要等第二次执行才被「视频01 事件」顺带取到。这里补全两槽，首次运行即生效。
            let matched = execId === selfId;
            if (!matched) {
                for (const name of ["视频01", "对比视频"]) {
                    const res = safeCall(
                        () => an.resolveSubgraphOutputLink?.(
                            an.subgraph?.outputs?.find?.((o) => o.name === name)?.id
                        ),
                        undefined,
                        "resolveSubgraphOutputLink"
                    );
                    const feedId = res?.link?.origin_id;
                    if (feedId != null && execId === `${selfId}:${feedId}`) { matched = true; break; }
                }
            }
            if (!matched) continue;

            refreshPreview(an);
            alog(`预览回灌触发 | execId: ${execId} | 节点: ${selfId}`);
        }
    }

    // 节点执行完成 → ① 缓存子图内产出节点的广播视频，② 触发预览刷新
    api.addEventListener("executed", ({ detail }) => safeCall(
        () => {
            if (!detail) return;
            const execNodeStr = String(detail.node);
            // 广播来自 A006 子图内部节点（execId = "外层id:内层id"）→ 缓存其视频，
            // 供 SaveImage/PreviewImage 等"执行产出图"feed 的主视频/对比视频取视频使用。
            const colIdx = execNodeStr.indexOf(":");
            const evtVideos = _extractOutputVideos(detail);
            const outerForEvt = colIdx > 0 ? execNodeStr.slice(0, colIdx) : execNodeStr;
            for (const an of a006Nodes) {
                if (String(an.id) !== outerForEvt || !an.subgraph) continue;
                if (colIdx > 0 && evtVideos.length) {
                    // 子图内部节点广播 → 按内层 id 缓存（供「视频01」源精确取数）
                    an._a006InnerUiVideos = an._a006InnerUiVideos || new Map();
                    const m = an._a006InnerUiVideos;
                    m.set(String(execNodeStr.slice(colIdx + 1)), evtVideos);
                    while (m.size > INNER_UI_IMAGES_LIMIT) {
                        m.delete(m.keys().next().value);
                    }
                }
                // 兜底源：最近一次收到的视频（子图内部或容器自身的插槽输出），供播放器回退
                if (evtVideos.length) an._a006LatestVideos = evtVideos;
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
