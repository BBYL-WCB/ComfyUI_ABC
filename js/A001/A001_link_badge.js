// ═══════════════════════════════════════════════════════════════
//  A001 子图节点 · 连接线中点数字徽标
//  -----------------------------------------------------------------------------
//  一、这个模块解决什么问题
//  -----------------------------------------------------------------------------
//  A001 把子图内层节点的媒体控件「提升」成左侧端口胶囊后，编辑器里可以用
//  @图片1 / @视频1 这样的引用去指代上游素材。但**画布上的连线本身没有编号**，
//  用户看不出「这条线到底对应 @ 里的哪个序号」。
//
//  本模块在 A001 节点的每条媒体连线**中点**画一个小圆点，圆内写上该连线对应的
//  @ 引用序号；圆点颜色沿用编辑器 chip 的类型配色（图片蓝 / 视频蓝渐变 / 音频青绿），
//  于是「颜色 + 数字」= @图片1 / @视频1，一眼可辨。
//
//  复刻自参考实现（002_MiniMaxH3_Easy参考/web/minimax_h3_easy_ui.js）的
//  drawLinks()：它在 gepmetry.mid 处 ctx.arc(...,5,...) 并 fillText(link.order)。
//
//  二、与参考实现的关键差异（A001 是「原生连线」，参考是「自定义连线」）
//  -----------------------------------------------------------------------------
//  · 参考实现有一套自己的 properties[LINKS_PROP] 连线数据 + 自绘贝塞尔；
//    A001 用的是 ComfyUI **官方原生连线**（graph.links / node.inputs[].link）。
//  · 因此本模块**不重画连线**，只做两件事：
//      ① 复用 a001MentionOptions(node) 拿到「@ 引用序号」（与编辑器完全同源）；
//      ② 挂钩 canvas.drawConnections，在原生连线之上叠加中点徽标。
//  · 这样连线的走向 / 选中高亮 / 拖拽等全部仍由官方负责，视觉零侵入。
//
//  三、为什么挂钩 drawConnections 而不是逐节点 onDrawForeground
//  -----------------------------------------------------------------------------
//  · onDrawForeground 是「节点局部坐标系」，而连线中点在**图坐标系**，跨节点，
//    不适合在某个节点的前景里画。
//  · 官方所有连线都画在 background canvas 层；在 drawConnections 之后叠加，
//    正好压在连线之上、又不影响节点层。
// ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import { safeCall } from "./A001_shared.js?v=20261007a";
import { a001MentionOptions } from "./A001_prompt_mentions.js?v=20261007a";

/** 判定是否 A001 子图节点（按前端类型名，与 SubgraphNode 契约一致）。 */
const A001_NODE_TYPE = "A001_SubgraphNode";

/** 媒体槽类型 → @ 引用类型（与 A001_prompt_mentions 的 MEDIA_BY_SLOT_TYPE 同口径）。 */
const SLOT_TYPE_TO_MEDIA = { IMAGE: "image", MASK: "image", VIDEO: "video", AUDIO: "audio" };

/** 圆点半径（复刻参考实现的 5）。 */
const BADGE_RADIUS = 5;

/** 类型配色（与编辑器 chip 的 .is-image / .is-video / .is-audio 保持一致）。 */
const TYPE_COLOR = {
    image: "#5aa9f0",
    video: "#2f8ef0",
    audio: "#00e2bb",
};

/** 徽标底衬色（深色描边，保证在浅色/深色连线上都清晰）。 */
const BADGE_BORDER = "rgba(0,0,0,0.55)";

/** 是否已挂钩画布（幂等）。 */
let a001BadgeCanvasHooked = false;

/** 挂钩到的画布实例（用于卸载时还原）。 */
let a001BadgeCanvasRef = null;

/** 被包装前的原始 drawConnections。 */
let a001BadgeOriginalDraw = null;

/** 判定节点是否为 A001 子图节点。 */
function isA001Node(node) {
    return node?.constructor?.comfyClass === A001_NODE_TYPE || node?.type === A001_NODE_TYPE;
}

/** 取节点所属图（优先 node.graph，回退当前图）。 */
function nodeGraph(node) {
    if (node?.graph) return node.graph;
    return safeCall(() => app?.graph || app?.rootGraph, undefined, "取当前图");
}

/** 按 id 取节点（兼容 getNodeById / _nodes_by_id）。 */
function nodeById(graph, id) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) return null;
    if (typeof graph?.getNodeById === "function") {
        const hit = safeCall(() => graph.getNodeById(numId), null, "取上游节点");
        if (hit) return hit;
    }
    return graph?._nodes_by_id?.[numId] || null;
}

/** 按 id 取连线（兼容 links 为 Map / 数组两种形态）。 */
function linkByIdOf(graph, id) {
    const links = graph?.links;
    if (!links) return null;
    if (typeof links.get === "function") return links.get(id) || null;
    return links[id] || null;
}

/** 取节点某方向的锚点坐标（兼容 getInputPos/getOutputPos 与旧版 getConnectionPos）。 */
function connectionPos(node, isInput, slotIndex) {
    const normalize = (point) => (
        Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
            ? [point[0], point[1]]
            : null
    );
    const modern = isInput
        ? normalize(safeCall(() => node?.getInputPos?.(slotIndex), null, "取输入锚点"))
        : normalize(safeCall(() => node?.getOutputPos?.(slotIndex), null, "取输出锚点"));
    if (modern) return modern;
    const out = [0, 0];
    if (typeof node?.getConnectionPos === "function") {
        const legacy = safeCall(() => node.getConnectionPos(isInput, slotIndex, out), null, "取旧版锚点");
        const normalized = normalize(legacy) || normalize(out);
        if (normalized) return normalized;
    }
    /* 最后兜底：按 LiteGraph 常规布局估算（标题高度 + 槽位间距）。 */
    const slotY = 40 + Math.max(0, slotIndex) * 20;
    return isInput
        ? [Number(node?.pos?.[0] || 0), Number(node?.pos?.[1] || 0) + slotY]
        : [Number(node?.pos?.[0] || 0) + Number(node?.size?.[0] || 160), Number(node?.pos?.[1] || 0) + slotY];
}

/** 三次贝塞尔在 t 处的点（控制点与官方连线一致：水平 ±80 偏移）。 */
function cubicPoint(start, end, t) {
    const cp1x = start[0] + 80;
    const cp2x = end[0] - 80;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    return [
        a * start[0] + b * cp1x + c * cp2x + d * end[0],
        a * start[1] + b * start[1] + c * end[1] + d * end[1],
    ];
}

/**
 * 构造「本条连线 → @ 引用序号」的索引。
 *
 * 复用 a001MentionOptions(node)（与编辑器 @ 菜单同源），把每个候选映射到它
 * 在 inputs 中的**槽位下标**，再用槽位下标定位连线。
 *
 * @returns {Map<number, {ordinal:number, type:string}>}
 *          key = inputs 数组下标（即输入槽序号），value = 序号与媒体类型
 */
function buildBadgeIndex(node) {
    const index = new Map();
    const options = safeCall(() => a001MentionOptions(node), [], "收集 @ 引用候选");
    if (!options?.length) return index;

    /* 逐个媒体输入槽：反查其 link 的 origin，去 options 里匹配序号。 */
    let slotIndex = -1;
    for (const inp of node?.inputs || []) {
        slotIndex += 1;
        if (inp?.link == null) continue;
        const mediaType = SLOT_TYPE_TO_MEDIA[String(inp.type || "").toUpperCase()];
        if (!mediaType) continue;
        const graph = nodeGraph(node);
        const link = linkByIdOf(graph, inp.link);
        if (!link || link.origin_id == null) continue;
        const sourceId = Number(link.origin_id);
        const sourceSlot = Number(link.origin_slot) || 0;
        const hit = options.find(
            (opt) => opt.type === mediaType
                && Number(opt.sourceId) === sourceId
                && Number(opt.sourceSlot) === sourceSlot
        );
        if (hit) index.set(slotIndex, { ordinal: Number(hit.ordinal) || 1, type: mediaType });
    }
    return index;
}

/* ★ 徽标索引缓存（性能）：drawConnections 每帧都会回调本模块，而 buildBadgeIndex
 *   内部要跑 a001MentionOptions（含上游节点 DOM 查询）。@ 序号只由「输入槽的连线
 *   结构」决定，故用结构签名做缓存键；签名不变即直接复用，节点被 GC 时条目随
 *   WeakMap 消失，无泄漏。 */
const BADGE_INDEX_CACHE = new WeakMap();

/** 结构签名：仅取输入槽的 link / 类型 / 上游端点，不查上游节点内容（廉价）。 */
function badgeIndexSig(node) {
    const graph = nodeGraph(node);
    const parts = [];
    for (const inp of node?.inputs || []) {
        if (inp?.link == null) { parts.push("-"); continue; }
        const link = linkByIdOf(graph, inp.link);
        parts.push(`${inp.link}:${link?.origin_id ?? ""}:${link?.origin_slot ?? ""}:${String(inp.type || "").toUpperCase()}`);
    }
    return parts.join("|");
}

/** 取（可能命中缓存的）徽标索引；签名变化才重建。 */
function getBadgeIndex(node) {
    const sig = badgeIndexSig(node);
    const cached = BADGE_INDEX_CACHE.get(node);
    if (cached && cached.sig === sig) return cached.index;
    const index = buildBadgeIndex(node);
    BADGE_INDEX_CACHE.set(node, { sig, index });
    return index;
}

/** 在给定中点画一个带数字的徽标。 */
function drawBadge(ctx, mid, ordinal, type, highlighted) {
    const color = TYPE_COLOR[type] || TYPE_COLOR.image;
    ctx.save();
    /* 底衬黑边：先在连线之上压一圈深色，保证圆点在任意底色上都可读。 */
    ctx.beginPath();
    ctx.arc(mid[0], mid[1], BADGE_RADIUS + 1.2, 0, Math.PI * 2);
    ctx.fillStyle = BADGE_BORDER;
    ctx.fill();
    /* 圆点本体：类型配色；节点被选中时用高亮白，与官方选中态一致。 */
    ctx.beginPath();
    ctx.arc(mid[0], mid[1], BADGE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = highlighted ? "#ffffff" : color;
    ctx.fill();
    /* 圆内数字：高亮时黑字压在白底，平时白字压在彩底。 */
    ctx.fillStyle = highlighted ? "#222" : "#fff";
    ctx.font = "bold 7px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(ordinal), mid[0], mid[1] + 0.3);
    ctx.restore();
}

/** 判定节点（及其上游）是否处于选中态。 */
function isHighlighted(canvas, targetNode, sourceNode) {
    return Boolean(
        targetNode?.selected
        || sourceNode?.selected
        || canvas?.selectedItems?.has?.(targetNode)
        || canvas?.selectedItems?.has?.(sourceNode)
        || canvas?.selected_nodes?.[targetNode?.id]
        || canvas?.selected_nodes?.[sourceNode?.id]
    );
}

/** 遍历全图，为所有 A001 节点的媒体连线绘制中点徽标。 */
function drawLinkBadges(canvas, ctx) {
    const graph = canvas?.graph || safeCall(() => app?.graph, undefined, "取画布图");
    const nodes = graph?._nodes;
    if (!Array.isArray(nodes) || !ctx) return;

    /* 低缩放 / 低质量渲染时跳过（与参考实现同口径），避免糊成一团。 */
    const scale = canvas?.ds?.scale ?? 1;
    if (scale < 0.6) return;

    for (const targetNode of nodes) {
        if (!isA001Node(targetNode)) continue;
        const badges = getBadgeIndex(targetNode);
        if (!badges.size) continue;

        const slotIndexes = [...badges.keys()];
        for (const slotIndex of slotIndexes) {
            const inp = targetNode?.inputs?.[slotIndex];
            if (!inp || inp.link == null) continue;
            const graphRef = nodeGraph(targetNode);
            const link = linkByIdOf(graphRef, inp.link);
            if (!link || link.origin_id == null) continue;
            const sourceNode = nodeById(graphRef, link.origin_id);
            if (!sourceNode) continue;

            const source = connectionPos(sourceNode, false, Number(link.origin_slot) || 0);
            const target = connectionPos(targetNode, true, slotIndex);
            if (!source || !target) continue;

            const mid = cubicPoint(source, target, 0.5);
            const info = badges.get(slotIndex);
            drawBadge(ctx, mid, info.ordinal, info.type, isHighlighted(canvas, targetNode, sourceNode));
        }
    }
}

/**
 * 挂钩画布 drawConnections（幂等）。
 *
 * 官方 drawConnections 负责画所有连线；我们在其之后、于同一 ctx 上叠加徽标。
 * 注意只在**背景层**叠加一次：ComfyUI 的 drawConnections 可能在前景/背景多次被调，
 * 用 connectionContext 与 bgctx 的相等性判定，避免重复绘制（参考实现同做法）。
 */
export function installA001LinkBadges() {
    const canvas = safeCall(() => app?.canvas, undefined, "取画布");
    if (!canvas || typeof canvas.drawConnections !== "function") return false;

    /* 画布实例变了（重开工作流等）：先卸载旧钩子再重装。 */
    if (a001BadgeCanvasHooked && a001BadgeCanvasRef === canvas) return true;
    if (a001BadgeCanvasHooked && a001BadgeCanvasRef && a001BadgeCanvasRef !== canvas) {
        safeCall(() => uninstallA001LinkBadges(), undefined, "卸载旧画布徽标钩子");
    }

    const original = canvas.drawConnections;
    a001BadgeOriginalDraw = original;
    a001BadgeCanvasRef = canvas;
    a001BadgeCanvasHooked = true;

    canvas.drawConnections = function a001DrawConnectionsWithBadges(ctx) {
        const result = original?.apply(this, arguments);
        const connectionContext = ctx || this.bgctx || this.ctx;
        /* 只在背景层叠加一次。 */
        const onBackgroundLayer = connectionContext?.canvas === this?.bgcanvas
            || connectionContext === this?.bgctx
            || !this?.bgcanvas;
        if (connectionContext && onBackgroundLayer) {
            safeCall(() => drawLinkBadges(this, connectionContext), undefined, "绘制连线徽标");
        }
        return result;
    };
    return true;
}

/** 卸载画布钩子（还原原始 drawConnections）。 */
export function uninstallA001LinkBadges() {
    const canvas = a001BadgeCanvasRef;
    if (canvas && a001BadgeOriginalDraw) {
        canvas.drawConnections = a001BadgeOriginalDraw;
    }
    a001BadgeCanvasHooked = false;
    a001BadgeCanvasRef = null;
    a001BadgeOriginalDraw = null;
    return true;
}

export default {
    installA001LinkBadges,
    uninstallA001LinkBadges,
};
