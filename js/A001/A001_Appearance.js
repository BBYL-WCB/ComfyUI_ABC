// ═══════════════════════════════════════════════════════════════
//  A001_子图节点 · 外观模块（预览框 + 控件框 + 控件框按键）
//
//  本模块只负责「长什么样」，不承担任何子图逻辑。由 A001_SubgraphNode.js 导入并调用：
//    · ensureA001Panel(node)   —— 确保面板已挂到节点上（幂等，含时序补偿）
//    · disposeA001Panel(node)  —— 节点删除时移除面板，断开观察器
//
//  面板的重挂与防闪烁（双保险，互为兜底）：
//  · 启动期（DOM 尚未创建）—— ensureA001Panel 经 scheduleA001PanelRetry 自调度重试：
//    全模块共用**唯一一条**重试链（并发入口自动去重），退避间隔 100→100→200→200→500ms，
//    无固定次数上限；终止判据为「节点已释放」或「已不在图中且超出宽限窗口」。
//  · 运行期（DOM 被 Vue 重建）—— startA001PanelGuard 的 MutationObserver 同帧重挂，
//    持久生效，仅由 disposeA001Panel 显式终止。
//  · 两条路径互相兜底：守卫在宿主尚未出现时即已启动，重试链停摆也不至于无人负责。
//
//  预览框内容（本模块只负责「壳」，内容归 A001_preview.js）：
//  · 预览框内部嵌一层 .xzg-a001-mp-host（绝对定位铺满，对齐 ComfyTV 的 .v2-mp-host），
//    它是预览内容的宿主元素，由本模块创建并在每次挂载时写回 node._a001PreviewHost。
//  · 内容渲染 / 释放由 A001_preview.js 负责，本模块只在挂载完成后调一次
//    refreshA001Preview 把内容画回来（状态存在节点上，故可无损重绘）。
//
//  观感来源（不重造，能引用即引用）：
//  · 两个框   —— 沿用容器节点统一的预览框观感参数
//                （底色 CONTAINER_BG / 圆角 CORNER_RADIUS / 内边距 FRAME_PAD）
//  · 按键行   —— 沿用容器节点统一的底部按键行
//                （.xzg-a001-bottom-row / .xzg-a001-set / .xzg-a001-run）
//  · 图标     —— 沿用 Material Design Icons 类名
//                （mdi-history / mdi-restore），
//                该字体由 ComfyUI 全局提供，无需额外引入
//  · 端口     —— 复刻 008_ComfyTV「视频阶段」等节点的端口胶囊（折叠圆点 + hover 展开），
//                实现在同目录 A001_port_capsule.js；其前置依赖（保住框架测量槽位所必需的
//                控件网格宿主 [data-widgets-grid-node-id]）在 A001_grid_anchor.js。
//                两者的装配/卸载由 A001_SubgraphNode.js 的 attachA001Ports / detachA001Ports 统一收口，
//                本模块只负责「面板」，不参与端口装配。
//                （历史：早期接入公共模块 js/A000/A000_Port.js 失败，根因是 A001 的
//                  widgets 投影层隐藏控件后节点内没有网格宿主，框架无法测量槽位；
//                  该根因已由 A001_grid_anchor.js 解决。）
//
//  按键功能：记录 / 还原按键实现同名功能（相机快照），
//  逻辑集中在 A001_workflow.js（attachA001WorkflowButtons 绑定），本模块只负责建键与调用绑定。
//
//  日志与安全调用：本模块通过参数注入 alog / safeCall，不反向依赖 A001_SubgraphNode.js，
//  避免两模块互相 import 造成循环引用。
//  预览内容渲染：单向依赖 A001_preview.js（该模块处于依赖图下游，不反向引用本模块），
//  故不构成环；本模块只负责创建宿主元素与在挂载完成时触发一次重绘。
// ═══════════════════════════════════════════════════════════════

import { refreshA001Preview } from "./A001_preview.js?v=20261007a";
/* 共享工具（处于依赖图最底层，不反向引用本模块）：
 * 取「节点是否仍在图中」，作为面板重试链的终止判据之一
 * （替代原先会被并发入口快速消耗的「次数上限」，见 scheduleA001PanelRetry）。 */
import { isNodeInGraph, A001_FRAME, findNodeRoot } from "./A001_shared.js?v=20261007a";
/* 高度模型（已从本模块拆出）：startA001SizeLock 由 ensureA001Panel 调用、
 *   stopA001SizeLock 由 disposeA001Panel 调用，故需本地绑定；
 *   三者一并 re-export，供 A001_SubgraphNode.js 继续从本模块取用。 */
import {
    startA001SizeLock,
    stopA001SizeLock,
    resyncA001SizeLock,
} from "./A001_HeightModel.js?v=20261007a";
/* ★ 端口：A001 的端口胶囊走独立实现（A001_port_capsule.js + A001_grid_anchor.js，
 *   均由 A001_SubgraphNode.js 装配），不使用公共模块 A000_Port.js 的端口条，
 *   故本模块不导入 floatPortRails / getPanelPortState 等成员。 */
/* 记录 / 还原（相机快照）：实现在 A001_workflow.js。
 * 该模块单向依赖 A001_SubgraphNode.js（取 ensureSubgraph / detachSlotSync），
 * 而 A001_Appearance.js 不反向被 A001_workflow.js 引用，故不构成环。 */
import { attachA001WorkflowButtons } from "./A001_workflow.js?v=20261007a";

/* ★ A001_FRAME 已下沉到 A001_shared.js（A001_HeightModel.js 亦从那里取用），
 *   在此 import 后 re-export，保持「从本模块取 A001_FRAME」的既有语义。
 *   高度模型三入口同理：实现在 A001_HeightModel.js，本模块 re-export ——
 *   A001_SubgraphNode.js 的 import 语句因此无需改动。 */
export { A001_FRAME, startA001SizeLock, stopA001SizeLock, resyncA001SizeLock };

/**
 * 控件框内三个按键的尺寸与配色。
 * 取值逐项对齐共享层的 NS 常量表（SET_BTN_* / BTN_*），
 * 保证各节点按键外观一致。
 */
export const A001_BTN = {
    GAP: 5,                           // 按键之间的间距
    BTN_H: 30,                        // 运行按钮高
    BTN_RADIUS: 15,                   // 运行按钮圆角（BTN_H / 2，胶囊形）
    BTN_FONT_SIZE: 13,                // 运行按钮字号
    BTN_COLOR: "#1e90ff",             // 运行按钮底色
    BTN_HOVER: "#3aa0ff",             // 运行按钮 hover
    BTN_FG: "#ffffff",                // 运行按钮文字色
    ICON_BTN_SIZE: 30,                // 圆形图标按键直径
    ICON_FONT_SIZE: 17,               // 图标字号
    ICON_BG: "rgba(34,34,34,.92)",    // 图标按键底色
    ICON_BORDER: "rgba(255,255,255,.3)", // 图标按键描边
    ICON_FG: "#ffffff",               // 图标按键图标色
};

/** 运行按键「忙碌态」底色：运行中显示为灰蓝，提示再点即取消。
 *  仅表示状态，不改变按键形状与布局（外观仍为本节点既有胶囊形蓝底键）。 */
export const BTN_RUNNING_COLOR = "#5a6b7a";

/* ─── 日志/安全调用注入（由 A001_SubgraphNode.js 在装配时提供） ─── */
let alog = () => {};
let safeCall = (fn, fallback) => {
    try { return fn(); } catch (_e) { return fallback; }
};
/* 「隐藏按键」所需：切换/查询提升控件的显隐。由 A001_SubgraphNode.js 注入，
 * 保持本模块不反向 import，避免循环依赖（与 alog / safeCall 同一手法）。 */
let toggleWidgetsHidden = () => false;
let isWidgetsHidden = () => false;
/* 「运行按键」所需：触发执行 / 查询运行态。同样由 A001_SubgraphNode.js 注入。
 * 运行键的功能复刻自 008_ComfyTV 的 Custom Stage 运行按键（见 A001_run.js 头注），
 * 外观仍沿用本节点的胶囊形蓝底按键，不复刻对方样式。 */
let runNode = () => {};
let queryRunState = () => ({ running: false, text: "运行", title: "运行", progress: 0 });
/* 「加载开关」按键所需：查询/切换「是否允许 ComfyTV 等外部工具识别展开本节点」。
 * 同样由 A001_SubgraphNode.js 注入（与 toggleWidgetsHidden 同一手法），
 * 功能实现在新建的 A001_disguise.js（便于整体移除该功能）。 */
let isComfyTVEnabled = () => false;
let toggleComfyTV = () => false;

/**
 * 注入宿主提供的工具函数（打破循环依赖）。
 * @param {{alog: Function, safeCall: Function,
 *          toggleA001WidgetsHidden: Function, isA001WidgetsHidden: Function,
 *          runA001Node: Function, queryA001RunState: Function,
 *          isA001ComfyTVEnabled: Function, toggleA001ComfyTVEnabled: Function}} deps
 */
export function initAppearanceDeps(deps) {
    if (typeof deps?.alog === "function") alog = deps.alog;
    if (typeof deps?.safeCall === "function") safeCall = deps.safeCall;
    if (typeof deps?.toggleA001WidgetsHidden === "function") {
        toggleWidgetsHidden = deps.toggleA001WidgetsHidden;
    }
    if (typeof deps?.isA001WidgetsHidden === "function") {
        isWidgetsHidden = deps.isA001WidgetsHidden;
    }
    if (typeof deps?.runA001Node === "function") {
        runNode = deps.runA001Node;
    }
    if (typeof deps?.queryA001RunState === "function") {
        queryRunState = deps.queryA001RunState;
    }
    if (typeof deps?.isA001ComfyTVEnabled === "function") {
        isComfyTVEnabled = deps.isA001ComfyTVEnabled;
    }
    if (typeof deps?.toggleA001ComfyTVEnabled === "function") {
        toggleComfyTV = deps.toggleA001ComfyTVEnabled;
    }
}

/**
 * 把运行按键的展示态刷成当前运行态（运行中显示进度、可取消）。
 * 面板会被 Vue 重建，故每次构建按键时都要据节点实际状态回填。
 * @param {HTMLElement} btn 运行按键元素
 * @param {object} node 节点
 */
export function refreshA001RunButton(btn, node) {
    if (!btn) return;
    const st = safeCall(
        () => queryRunState(node),
        { running: false, text: "运行", title: "运行", progress: 0 },
        "查询运行态"
    );
    const running = !!st?.running;
    const wantText = running ? String(st.text || "取消") : "运行";
    const wantTitle = String(st.title || (running ? "点击取消当前执行" : "运行"));
    /* ★ 脏值短路：progress 事件在采样期每步一发，若每步都写 textContent/title
     *  会触发按钮文本重排（甚至经面板回流间接唤醒对比层 RO）。仅在文案/状态
     *  真变化时才写 DOM。 */
    if (btn.dataset.a001RunSig === `${wantText}|${wantTitle}`) return;
    btn.dataset.a001RunSig = `${wantText}|${wantTitle}`;
    btn.textContent = wantText;
    btn.title = wantTitle;
    /* 忙碌态：底色变暗（灰蓝），提示「再点即取消」；空闲态恢复原色。
     * 外观仍用本节点既有配色体系，仅做状态色区分。 */
    btn.style.background = running ? BTN_RUNNING_COLOR : A001_BTN.BTN_COLOR;
    btn.dataset.running = running ? "1" : "0";
}

/* ══════════════════════════════════════════════
 *  DOM 定位
 *  ══════════════════════════════════════════════ */

/**
 * 找到节点的 node-body 元素（面板的挂载父级）。
 *
 * 这个层级很关键：面板须挂进 node-body 内部，才能与节点内容区同宽并被
 * Vue 的重建逻辑覆盖到；若挂在 .lg-node 下，它与 node-body
 * （实际层级为 .lg-node > c0 > node-body）是兄弟分支而非父子，宽度与定位都会失准。
 */
function findNodeBody(node) {
    const root = findNodeRoot(node);
    if (!root) return null;
    /* ★ 缓存范式对齐 findNodeRoot：Vue 重建节点 DOM 会换出新 body，
     *  故命中条件必须是「仍连接 且 仍隶属于当前 root」。 */
    const cached = node._a001DomBody;
    if (cached?.isConnected && cached.parentElement === root) return cached;
    const body = root.querySelector('[data-testid^="node-body"]') || root.querySelector(".lg-node-body") || null;
    node._a001DomBody = body;
    return body;
}

/**
 * 找「控件网格轨道」——直属 node-body 且包含控件网格的那个子元素。
 *
 * 【为什么必须这样找（实测踩坑）】面板要插在网格**之前**，才能保证「显示控件时
 * 网格变高不会把面板推下去」。但网格宿主 [data-widgets-grid-node-id] 与
 * .lg-node-widgets **往往不是 node-body 的直属子级**（中间还包了一层容器），
 * 原实现要求「网格直属 host」才算命中，不满足时退化成 appendChild →
 * 面板被追加到网格**之后** → 显示控件时网格撑高，预览框与按键框整体下移
 * （隐藏时又随网格塌缩回原位），即用户反馈的现象。
 * 正解：从网格元素向上回溯到「父级就是 host」的那一层，以它为插入锚点 ——
 * 面板仍是 host 的直属子级（宽度 calc(100%) 基准正确），且稳定落在网格轨道之前。
 *
 * @returns {Element|null} 可作插入锚点的元素；找不到返回 null（调用方保持面板原位）
 */
function findGridTrack(host, grid) {
    if (!host || !grid) return null;
    let el = grid;
    while (el && el.parentElement && el.parentElement !== host) el = el.parentElement;
    return el && el.parentElement === host ? el : null;
}

/**
 * 只把面板搬到「网格轨道之前」（幂等，不动模式判定、不碰预览内容）。
 *
 * 【为什么要独立成函数】面板位置在多个时机都可能被打乱：
 *   · 首次挂载时网格 DOM 尚未就绪 → 先 appendChild 占位，之后要搬回前面；
 *   · 工作流加载 / 切图时 Vue 重排 node-body 子级顺序；
 *   · 控件显隐（网格高度 0 ⇄ 112px）前后。
 * 只要面板落在网格**之后**，网格一撑高就会把预览框与按键框整体推下去
 * （隐藏时又随网格塌缩回位）——即用户反馈的「面板跟着控件显隐上下移动」。
 * 故提供这个轻量入口，供守卫与控件显隐路径同帧调用；不触发 flow/cover 重判定，
 * 避免在网格高度为 0 的瞬间被误判成「文档流不成立」而切到绝对定位。
 *
 * @returns {boolean} 是否执行了移动
 */
export function repositionA001Panel(node) {
    const el = node?._a001Panel;
    if (!el || !el.isConnected) return false;
    const host = el.parentElement;
    if (!host) return false;
    const grid = host.querySelector?.(".lg-node-widgets")
        || host.querySelector?.("[data-widgets-grid-node-id]");
    const track = findGridTrack(host, grid);
    if (!track) return false;
    if (el.nextElementSibling === track) return false;
    return !!safeCall(() => {
        host.insertBefore(el, track);
        return true;
    }, false, "面板位置校正");
}

/* ══════════════════════════════════════════════
 *  面板装配
 *  ══════════════════════════════════════════════ */

/**
 * 在节点内容区插入面板：上方「预览框」+ 下方「控件框」。
 *
 * 【观感来源】沿用容器节点统一的 .xzg-a001-frame
 *   （width:100%; flex:1 1 auto; min-height:0; background:CONTAINER_BG;
 *    border-radius:CORNER_RADIUS; padding:FRAME_PAD）。
 *   另有 .xzg-a001-dom 外层负责左右留白，其 padding 为 0 却内缩外框，
 *   这里 A001 无该层，故两个框自身用 width:calc(100% - 2*SIDE_GAP) + margin:0 auto
 *   实现同样的「左右各留 5px」，由 CSS 派生，不读自身尺寸。
 *   外层 .xzg-a001-panel 为 flex column，用 gap 控制两框之间的间距。
 *
 * 【为什么不用 addDOMWidget】经 addDOMWidget 挂载会作为一条轨道进入 .lg-node-widgets
 * 网格，新增一条 grid 轨道并改变 _arrangeWidgets 的高度分配，使内容行高错位；
 * 这里改用纯标记元素手工插入，不进入控件网格，因而也不会有 widget 外层容器的
 * 默认内边距（那正是「节点和框之间多出间隙」的来源）。
 *
 * 【兜底策略：优先进文档流，失败才脱离】
 *   首选把面板作为 node-body 的直接子级插在 .lg-node-widgets **之前**，
 *   由文档流驱动宽度与高度：
 *     - 插在网格之前，「面板 + 网格」才是节点内容主轴。若放网格之后，面板会被算成
 *       「内容末端」，官方 _arrangeWidgets 分配剩余高度时失去参照，拉伸会互相挤压。
 *     - 预览框高度交给 CSS 的 flex:1 1 auto + min-height:0，控件框固定 CONTROLS_H，
 *       宽度用百分比跟随父级内容宽度，全程不读自身尺寸 → 不构成尺寸反馈环。
 *   但 node-body 若是块级（非 flex）容器，flex:1 与 min-height:0 均无效，面板会塌成
 *   0 高。故插入后**实测**高度，低于可行阈值即判定「文档流方案不成立」，退化为
 *   贴合式：面板上移到 .lg-node 并 position:absolute 定位，宽高由节点矩形减去左右间隔
 *   决定（top 起点需扣掉标题栏，由 findNodeBody 的实测位置算出）。
 *   两条路线都不依赖「读自身尺寸再写自身尺寸」，故都不会振荡。
 */

/* 面板重试链的退避阶梯（ms）：前几次快速试（覆盖绝大多数正常时序），
 * 之后拉长到 500ms，使「DOM 迟迟未就绪」的长期等待不再高频轮询。 */
const A001_PANEL_RETRY_DELAYS = [100, 100, 200, 200, 500];

/* 节点「尚未入图」的宽限窗口（ms）：
 * nodeCreated 早于节点真正入图，若一见「不在图中」就停链，新建节点会漏挂。
 * 故在宽限期内即使不在图中也继续重试；超过宽限仍未入图才判定节点已删并停链。 */
const A001_PANEL_GRAPH_GRACE_MS = 5000;

/**
 * 调度一次面板重试（本模块唯一的重试排程出口）。
 *
 * 【为什么要独立成函数】原先的重试计数写在 ensureA001Panel 内，被 5 个并发入口
 * （nodeCreated / loadedGraphNode / onNodeCreated / onResize / MO 回调）共享同一
 * 计数器与同一个定时器变量，导致：
 *   1. 30 次预算被并发入口以约 3 倍速消耗，约 1s 即耗尽（而非宣称的 3s）；
 *   2. 后到的入口会覆盖 _a001PanelTriesTimer，产生无人能清的孤儿定时器。
 * 现改为「单一重试链」：只要链上已有待执行的定时器，任何入口再次调用都直接返回，
 * 由该定时器在回调末尾自行续链，入口再多也只会有一条链。
 *
 * 【终止判据】不再依赖固定次数上限，改为：
 *   · _a001PanelDisposed（节点已删 / 已释放）→ 立即停；
 *   · 节点已不在图中且超出宽限窗口 → 判定节点已删，停链，避免泄漏；
 *   · 节点在图中 → 持续重试（无次数上限），因为节点确实存在，只是 DOM 未就绪。
 * 节点存活期间若因宽限耗尽而停链，仍由 startA001PanelGuard 的观察器兜底重挂。
 */
function scheduleA001PanelRetry(node) {
    if (node._a001PanelDisposed) return;
    // ★ 单一去重：链上已有待执行的定时器 → 不再另起一条，防止并发入口各自为政。
    if (node._a001PanelRetryTimer) return;
    const now = Date.now();
    if (!node._a001PanelFirstTryAt) node._a001PanelFirstTryAt = now;
    const inGraph = safeCall(() => isNodeInGraph(node), true, "面板重试存活判据");
    if (!inGraph && now - node._a001PanelFirstTryAt > A001_PANEL_GRAPH_GRACE_MS) {
        // 超出宽限且确实不在图中：判定节点已删，停止续链（dispose 时还会再清一次）。
        return;
    }
    const step = node._a001PanelRetryCount || 0;
    node._a001PanelRetryCount = step + 1;
    const delay = A001_PANEL_RETRY_DELAYS[Math.min(step, A001_PANEL_RETRY_DELAYS.length - 1)];
    node._a001PanelRetryTimer = setTimeout(() => {
        node._a001PanelRetryTimer = null;
        // 节点可能已在重试期间被删除（dispose 会置终止标记）。
        if (node._a001PanelDisposed) return;
        safeCall(() => ensureA001Panel(node), undefined, "面板重试");
    }, delay);
}

export function ensureA001Panel(node) {
    if (typeof document === "undefined" || node?.id == null) return;
    /* ★ 复位终端标记：disposeA001Panel 会把 _a001PanelDisposed 永久置 true，
     *  但 ComfyUI 会复用节点对象（撤销/重做、切图、动态加载工作流），此时
     *  onRemoved 已把它标成 disposed，复用后面板一旦脱离 DOM，
     *  「重试挂载」与「MutationObserver 同帧重挂」两条路径都会被该标记挡死，
     *  表现为「UI 有时不显示」且永不恢复。此处作为唯一(重)挂载入口，在节点
     *  仍存活时把它清回 false，等价于「节点重新入图/复用后恢复挂载能力」。 */
    node._a001PanelDisposed = false;
    const root = findNodeRoot(node);
    const body = findNodeBody(node);
    const host = body || root;
    if (!host) {
        /* 【时序补偿】新建节点 / 刷新 / 切换工作流时，nodeCreated 与 onNodeCreated
         * 均早于 Vue 渲染出节点 DOM（.lg-node / node-body），此刻查不到宿主元素。
         * 若此处直接 return，面板将永远不被挂载——正是「刷新后框消失」的成因。
         * 故改为自调度重试（scheduleA001PanelRetry：单一链 + 退避间隔 + 图存活判据），
         * 直到 DOM 就绪；该链不再有固定次数上限，节点在图中即持续尝试。
         * 本机制沿用 100ms×15 次重试的做法，
         * 差异在于：原实现等待的是原生控件、本节点等待的是节点 DOM。
         *
         * ★ 关键改进：在此处**提前启动面板守卫**（原实现只在挂载成功后才启动）。
         * 若重试链因故停摆（宽限耗尽、定时器被回收、宿主始终未出现），
         * 守卫仍能凭 DOM 变动把面板救回来，消除「重试耗尽后彻底无人负责」的空窗。
         * 守卫观察的是稳定层（画布容器），此时节点根尚不存在也照样有效。 */
        startA001PanelGuard(node);
        scheduleA001PanelRetry(node);
        return;
    }
    /* 宿主已就绪 → 收束重试链：清掉待执行的定时器并复位退避阶梯，
     * 使后续若再次脱离 DOM（运行期重建），能从阶梯头部重新快速尝试。 */
    node._a001PanelRetryCount = 0;
    node._a001PanelFirstTryAt = 0;
    if (node._a001PanelRetryTimer) {
        clearTimeout(node._a001PanelRetryTimer);
        node._a001PanelRetryTimer = null;
    }
    let el = node._a001Panel;
    // 与端口标记同理：Vue 重建节点 DOM 会换出新节点根，旧面板随之脱离，必须重建。
    const attached = !!el && el.isConnected && (root?.contains(el) ?? false);
    if (!attached) {
        el = document.createElement("div");
        el.className = "xzg-a001-panel";
        el.style.cssText = [
            "box-sizing:border-box",
            "display:flex",
            "flex-direction:column",
            // 面板只作衬底，只需能看见，不应拦截端口/控件的鼠标交互。
            "pointer-events:none",
            /* ★★ order:-1 —— 结构性保证「面板永远排在控件网格之前」（实测踩坑，勿删）：
             *  仅靠 DOM 顺序（insertBefore）不可靠：Vue 在 patch node-body 子级时会
             *  重排它管理的网格节点，可能把网格挪到面板**之前**；我们的同帧校正只是
             *  在跟 Vue 赛跑，赢一次输一次。order 让 flex 布局完全无视 DOM 顺序 ——
             *  面板恒排第一，网格（order 默认 0）恒在其后。
             *  故「显示控件 → 网格撑高 112px」只占用网格自己的空间，
             *  不再把预览框与按键框整体推下去。
             *  注：order 只对 flex/grid 容器生效；若 node-body 非 flex，
             *  面板本就无法走文档流（会退化为 cover 绝对定位），此属性无害。 */
            "order:-1",
        ].join(";");
        // 预览框：占满剩余高度，底色 #171717、圆角 20、内边距 10。
        // ★ min-height 分两段（一比一照抄 Custom Stage）：
        //   未接管高度前用 PREVIEW_MIN_H 兜底（防塌成一条线）；
        //   一旦高度模型 goLive，面板会带上 data-a001-height，CSS 把 min-height 归 0，
        //   高度完全交给 JS 的绝对值模型 —— 否则常驻 min-height 会顶住 wanted，永远调不准。
        const preview = document.createElement("div");
        preview.className = "xzg-a001-preview";
        preview.style.cssText = [
            "box-sizing:border-box",
            `border-radius:${A001_FRAME.RADIUS}px`,
            `background:${A001_FRAME.BG}`,
            `padding:${A001_FRAME.PAD}px`,
            "flex:1 1 auto",
            `min-height:${A001_FRAME.PREVIEW_MIN_H}px`,
            // 预览内容宿主（mp-host）用绝对定位铺满内边区，故本框须为定位上下文。
            // 同时裁掉内容溢出，保证圆角内不露头。
            "position:relative",
            "overflow:hidden",
        ].join(";");
        /* ★ 面板被 Vue 重建 → 预览宿主换新元素。先把旧宿主里的内容搬过来，
         *  否则渲染层会全量重绘：<video>/<audio> 重建 + 重新 load → 框内黑闪一帧。 */
        const prevHost = node._a001PreviewHost;
        const newHost = buildA001PreviewHost(node);
        migrateA001PreviewContent(prevHost, newHost);
        preview.appendChild(newHost);
        // 控件框：固定高度，底色 #222222（与预览框区分），内部横排三个按键。
        const controls = document.createElement("div");
        controls.className = "xzg-a001-controls";
        controls.style.cssText = [
            "box-sizing:border-box",
            `border-radius:${A001_FRAME.RADIUS}px`,
            `background:${A001_FRAME.CONTROLS_BG}`,
            `padding:${A001_FRAME.PAD}px`,
            `height:${A001_FRAME.CONTROLS_H}px`,
            "flex:0 0 auto",
            "display:flex",
            "flex-direction:row",
            "align-items:center",
            `gap:${A001_BTN.GAP}px`,
        ].join(";");
        controls.appendChild(buildA001Buttons(node));
        /* 面板内两框的上下顺序：预览框在上、按键框在下（用户指定，勿颠倒）。
         * 即最终排布为「预览框 → 按键框 → 控件网格」。 */
        el.appendChild(preview);
        el.appendChild(controls);
        el.style.gap = `${A001_FRAME.GAP}px`;
        node._a001Panel = el;
        node._a001PanelMode = null;   // null=待判定 / "flow" / "cover"
        /* ★ 面板是**新建**的元素 → 收起标记（data-a001-collapsed）必须按当前状态补一次，
         *  否则「收起态下 Vue 重建面板」会让控件区域重新露出来（标记随旧元素一起没了）。
         *  面板是我们自建、Vue 不碰，故此标记一旦打上即稳定（不会像节点根类那样被覆盖）。 */
        if (safeCall(() => isWidgetsHidden(node), false, "查询收起态")) {
            el.setAttribute("data-a001-collapsed", "");
        }
    }
    /* ★ 面板内两框顺序的「每次装配校正」（幂等）：
     *   面板元素会被复用（attached 为真时不会重建），若只在创建分支里排一次顺序，
     *   历史遗留的旧面板（或曾被外部改动过的 DOM）会一直保持错误顺序。
     *   这里每轮装配都按「预览框 → 按键框」校正一次，不满足即用 appendChild 重排
     *   （appendChild 对已存在子节点是「移动」语义，不会克隆，代价极低）。 */
    safeCall(() => {
        const pv = el.querySelector(":scope > .xzg-a001-preview");
        const ct = el.querySelector(":scope > .xzg-a001-controls");
        if (!pv || !ct) return;
        if (pv.nextElementSibling !== ct) {
            el.appendChild(pv);
            el.appendChild(ct);
        }
    }, undefined, "校正面板内两框顺序（预览框在上）");
    const grid = host.querySelector?.(".lg-node-widgets")
        || host.querySelector?.("[data-widgets-grid-node-id]");
    if (node._a001PanelMode !== "cover") {
        /* 首选：文档流垫底（插在控件网格轨道之前，网格未出现则落在内容末尾）。
         * 锚点用 findGridTrack 回溯到「直属 host 的网格轨道」——不能只认
         * .lg-node-widgets 直属 host，否则会退化成 appendChild 把面板插到网格之后，
         * 导致「显示控件时面板被网格撑高推下去」。 */
        const track = findGridTrack(host, grid);
        if (track) {
            /* 面板必须紧邻网格轨道之前。这里用「严格位置判定」而非只判
             * previousElementSibling：面板可能因历史路径（如曾是 appendChild）
             * 停在网格之后，那种情况下也必须搬回前面，否则显示控件时被推下去。 */
            if (el.parentElement !== host || el.nextElementSibling !== track) {
                host.insertBefore(el, track);
            }
        } else if (el.parentElement !== host) {
            /* 网格轨道尚未出现（DOM 未就绪）：先挂到末尾占位，
             * 后续重试会因上面分支命中而搬到网格轨道之前。 */
            host.appendChild(el);
        }
        el.style.position = "";
        el.style.inset = "";
        el.style.margin = "0 auto";
        el.style.width = `calc(100% - ${A001_FRAME.SIDE_GAP * 2}px)`;
        el.style.height = "";
        el.style.flex = "1 1 auto";
        el.style.minHeight = "0";
        el.style.order = "-1";   // 每轮装配都补一次，防止被外部改写后失效
        // 实测文档流高度是否成立：块级父容器下 flex:1 + min-height:0 会塌成 0。
        const h = el.getBoundingClientRect?.().height || 0;
        if (h < A001_FRAME.FLOW_MIN_H) node._a001PanelMode = "cover";
        else {
            startA001PanelGuard(node);
            // 切图后画布容器可能已换，重绑（模块级单例）观察目标，保证下次重建仍能被捕获。
            ensurePanelGuardMO();
            // ★ 启动「预览框 / 控件网格」高度解耦记账（移植 Custom Stage 的 bindCardHeight 思路），
            //   保证两者高度互不影响：控件变化只改节点总高，预览框高度锁定；拉伸节点只改预览框。
            safeCall(() => startA001SizeLock(node), undefined, "启动高度解耦记账");
            // 面板（含预览宿主）已就位 → 把既有预览状态画回来。
            // 状态存在 node._a001PreviewState 上、不存 DOM，故面板重建后可无损恢复。
            safeCall(() => refreshA001Preview(node), undefined, "面板就绪后重绘预览");
            return;
        }
    }
    // 退化：贴合节点矩形，左右仍各留 SIDE_GAP；top 用 node-body 实测位置
    // （即标题栏下沿）作为起点，避免盖住标题。
    if (!root) return;
    if (el.parentElement !== root) root.appendChild(el);
    const rootRect = root.getBoundingClientRect?.();
    const bodyRect = body?.getBoundingClientRect?.();
    const top = rootRect && bodyRect ? Math.max(0, Math.round(bodyRect.top - rootRect.top)) : 0;
    el.style.position = "absolute";
    el.style.width = `calc(100% - ${A001_FRAME.SIDE_GAP * 2}px)`;
    el.style.margin = "0 auto";
    el.style.left = "0";
    el.style.right = "0";
    el.style.top = `${top}px`;
    el.style.bottom = "0";
    el.style.height = "auto";
    el.style.flex = "none";
    el.style.minHeight = "";
    startA001PanelGuard(node);
    ensurePanelGuardMO();
    safeCall(() => refreshA001Preview(node), undefined, "面板就绪后重绘预览");
}

/**
 * 构建预览内容宿主（.xzg-a001-mp-host）。
 *
 * 【为什么要多这一层】对齐 ComfyTV 预览框的结构分层
 *   （.v2-preview → .v2-mp-host(inset:0) → 内容）。
 * 宿主绝对定位铺满预览框内边区，使内容可以「铺满 + object-fit:contain」自适应，
 * 全程不需要读取自身尺寸 —— 这是面板不振荡的前提。
 *
 * 【为什么用 absolute 而不是让内容直接当 preview 的子级】
 * preview 自身是 flex item（flex:1 1 auto），若内容直接作为其子级参与布局，
 * 内容的固有尺寸会反过来影响 preview 的弹性分配，形成尺寸反馈。
 * 加一层绝对定位宿主可彻底切断这条反馈链。
 *
 * 每次面板重建都会产出**新的**宿主元素，故这里同步写回 node._a001PreviewHost，
 * 供 A001_preview.js 的渲染层取用。
 */
function buildA001PreviewHost(node) {
    const host = document.createElement("div");
    host.className = "xzg-a001-mp-host";
    host.style.cssText = [
        "position:absolute",
        "inset:0",
        "overflow:hidden",
        /* 内容居中：图片/视频靠 object-fit:contain 自铺满，
         * 音频是无固有尺寸的行内控件，必须靠 flex 才能上下左右居中。 */
        "display:flex",
        "align-items:center",
        "justify-content:center",
    ].join(";");
    node._a001PreviewHost = host;
    return host;
}

/**
 * 面板被 Vue 整棵重建时，把旧预览宿主里的内容「搬」到新宿主。
 *
 * 【为什么必须搬而不是交给重绘】宿主换了新元素后，若让渲染层全量重绘，
 * <video>/<audio> 会被销毁重建并重新 load —— 表现为预览框内黑闪一帧、
 * 音频进度归零（实测「拉伸节点时框内闪烁」）。appendChild 搬移可保留
 * 媒体实例与播放位置；配合 A001_preview.js 的同源复用判定，
 * 整条重绘路径都不会重建媒体元素。
 */
function migrateA001PreviewContent(from, to) {
    if (!from || !to || from === to) return;
    for (const child of Array.from(from.children)) {
        /* 占位提示不搬：有内容时它本就该消失，交给渲染层按需重建。 */
        if (child.classList?.contains("xzg-a001-mp-hint")) continue;
        to.appendChild(child);
    }
    /* 同步宿主上的 kind 与底色，让渲染层的复用判定得以命中。 */
    to.dataset.kind = from.dataset.kind || "";
    to.style.background = from.style.background || "";
    /* ★ 搬移分界线/圆钮（对比层）之外的额外一步：把对比层的元素引用也交给新宿主。
     *  子元素虽已整体搬走，但 `_a001Parts` 记的是元素引用与它们所属的宿主关系，
     *  不同步的话新宿主上 _a001Parts 为空，A001_compare 会以为没有对比层而重复新建
     *  （旧元素成为孤儿、交互绑到新元素上，表现为拖动分界线无反应）。 */
    if (from._a001Parts) {
        to._a001Parts = from._a001Parts;
        from._a001Parts = null;
    }
    /* ★ 对比层的监听/观察器句柄是挂在「旧宿主元素」上的（_a001CmpHooked /
     *  _a001CmpHandlers / _a001CmpRO），它们不会随子元素搬移而转移。若不同步处理，
     *  新宿主仍无交互钩子、旧宿主的 RO 成为孤儿：表现为面板被 Vue 重建后
     *  对比线拖不动、几何不随拉伸重算。此处把旧宿主的交互态作废，
     *  让 A001_compare 在新宿主上重新绑定（buildA001CompareLayer 已幂等）。 */
    safeCall(() => {
        from._a001CmpRO?.disconnect?.();
        from._a001CmpRO = null;
        from._a001CmpHandlers = null;
        from._a001CmpHooked = false;
        to._a001CmpHooked = false;
        to._a001CmpRO = null;
        to._a001CmpSig = undefined;
    }, undefined, "迁移对比层交互态");
}

/**
 * 重挂守卫（MutationObserver 同帧重挂）：一旦面板脱离节点根，立即重挂。
 *
 * 【为什么用 MutationObserver 而不是 200ms 轮询】
 * Nodes 2.0 的 Vue 在「切换工作流 / 进出子图」时会**整棵重建**节点 DOM
 * （.lg-node 及其内部 node-body 的**元素引用被替换**，见 A000_Port.js 的同类实测结论），
 * 我们手工插进 node-body 的面板元素随之被连根移除，随后才被重新挂上，
 * 中间那段空窗就是肉眼看到的「框闪一下才出现」。
 *
 * 轮询（每 200ms 检查一次）只能在「下一个周期」才发现脱离并补救，
 * 因此空窗最少也有一个周期、最长两个周期，无法消除闪烁。
 * MutationObserver 的回调是微任务：在 Vue 插入新 .lg-node 的**同一帧内**即被派发，
 * 这时立刻重挂，面板可在该帧渲染前就位，视觉上空窗被压到不可见。
 *
 * 【存活判据】不使用 node.graph 作为终止条件——进出子图时它可能瞬时为空，
 * 会被误判为「节点已删」而永久停摆（这正是原轮询版留下的隐患）。
 * 改为只由 disposeA001Panel（节点 onRemoved / 删除时）显式断开来终止，
 * 即真正的「持久化」：在节点存活期间始终生效。
 *
 * 【观察目标】固定取「稳定层」——画布容器（app.canvas.canvas.parentElement）。
 * 它是整个画布 DOM 的长期宿主，切图 / Vue 重建节点时该层依然存活，因而不会失聪。
 * 原实现优先取 root.parentElement（节点根的直接父级），看似更近，但节点根被整体
 * 换掉时其父级也可能被 Vue 一并替换，观察器会静默失效（disconnect 后不再有任何
 * 回调），表现为「刷新后再也不重挂」。故改为锚定稳定层，并加目标失效自愈。
 */
/* ── 面板守卫：模块级单例观察器（2026-10-05 收敛）──
 * 改造前：每个节点各 new 一个 MutationObserver 观察同一个「画布稳定层」子树，
 *   N 个节点 = N 个观察器同时盯同一批 DOM 变更，回调数 O(N×M)。
 * 现改为「模块级唯一观察器 + 节点注册表」：一次回调内只遍历已注册的节点，
 *   各节点原有判定逻辑逐字保留；「观察目标失效自愈」上提为模块级（单例重绑）。 */
let _panelGuardMO = null;
let _panelGuardTarget = null;
let _panelGuardRebinding = false;
const _panelGuardNodes = new Set();

/** 取画布稳定层（原各节点 stableTarget 的同一口径）。 */
function _panelGuardStableTarget() {
    /* 取画布容器；取不到（极早期 / 非标准布局）退回 body。
     * body 虽最稳，但观察 body + subtree 的回调面最大，故仅作最后兜底。 */
    try {
        const c = app?.canvas?.canvas?.parentElement;
        if (c) return c;
    } catch (_e) { /* 画布尚未就绪，退回 body */ }
    return document.body;
}

/** 起 / 重绑单例观察器（幂等；目标失效时自动重绑）。 */
function ensurePanelGuardMO() {
    if (_panelGuardRebinding) return;
    const t = _panelGuardStableTarget();
    if (!t) return;
    if (_panelGuardMO && _panelGuardTarget === t && _panelGuardTarget.isConnected) return;
    _panelGuardRebinding = true;
    try {
        if (_panelGuardMO) safeCall(() => _panelGuardMO.disconnect(), undefined, "重绑面板观察器");
        _panelGuardMO = new MutationObserver((mutations) => {
            for (const node of Array.from(_panelGuardNodes)) {
                const fn = node._a001PanelGuardOnMutations;
                if (typeof fn !== "function") continue;
                safeCall(() => fn(mutations), undefined, "面板守卫回调");
            }
        });
        _panelGuardTarget = t;
        _panelGuardMO.observe(t, { childList: true, subtree: true });
    } catch (_e) { /* 重绑失败忽略，不影响已挂面板 */ } finally {
        _panelGuardRebinding = false;
    }
}

function startA001PanelGuard(node) {
    if (!node || node._a001PanelGuardMO) return;
    /* ★ 哨兵沿用 _a001PanelGuardMO（值改为 true），避免改动外部既有判据；
     *   真实观察器已上提为模块级单例 _panelGuardMO。 */
    node._a001PanelGuardMO = true;
    node._a001PanelGuardOnMutations = () => {
        // 节点已从图中移除 → 由 disposeA001Panel 负责清理，此处不再重挂
        if (node._a001PanelDisposed) return;
        /* ★ 观察目标失效自愈（模块级）：Vue 若把画布容器也一并换掉，观察器会静默失聪
         *  （disconnect 后不再有任何回调），再无人能触发重绑。
         *  故每次回调先确认当前观察目标仍连通，失效则立即重绑到新容器。 */
        if (!_panelGuardTarget?.isConnected) {
            safeCall(() => ensurePanelGuardMO(), undefined, "面板观察目标自愈重绑");
        } else if (_panelGuardTarget === document.body) {
            /* ★ 兜底降级后的自动升级：早期画布容器尚未就绪时会退回观察 body，
             *  回调面最大。一旦画布容器出现即重绑过去，把观察面收窄回稳定层。 */
            const c = safeCall(() => app?.canvas?.canvas?.parentElement, null, "取画布容器");
            if (c && c !== _panelGuardTarget) {
                safeCall(() => ensurePanelGuardMO(), undefined, "面板观察目标升级重绑");
            }
        }
        /* ★ panel 健康检查前置（性能优化）：本观察器同时观察子节点增删（subtree），
         * 挂在稳定层上，因而面板内部任何绘制变化都会回调。绝大多数回调其实
         * 「面板仍健康」，此时无需付出 findNodeRoot 的 querySelector 查询成本。
         * 故先做最廉价的 isConnected 判断：面板仍在文档中 → 直接返回；
         * 只有确实脱离文档（DOM 被重建）时才去找节点根做归属校验。
         * 判据等价性：原逻辑要求「isConnected 且 root.contains(panel)」才早退，
         * 现在脱离文档必不满足原条件 → 仍会走重建分支；仍连着文档时，
         * 归属校验交由随后的 root 判断兜底（root 为 null 时同样直接返回）。 */
        const panel = node._a001Panel;
        if (panel?.isConnected) {
            const root = findNodeRoot(node);
            if (!root || root.contains(panel)) {
                /* ★★ 位置校正（实测踩坑，勿删）：面板必须紧邻「网格轨道之前」。
                 *  Vue 重排控件网格时可能把面板甩到网格**之后** —— 此时面板仍在
                 *  root 内，旧判据（只看 isConnected + contains）会认为健康并早退，
                 *  于是位置永久错乱：显示控件时网格撑高 112px，面板被整体推下去
                 *  （隐藏时又随网格塌缩回位），正是「预览框与按键框一起下移」。
                 *  复用 repositionA001Panel：只搬位置，不触发 flow/cover 重判定。 */
                safeCall(() => repositionA001Panel(node), undefined, "面板位置校正");
                return;
            }
        } else {
            const root = findNodeRoot(node);
            if (!root) return;
        }
        // DOM 被重建：清掉旧引用与「已判定」标记，从头重挂
        node._a001PanelMode = null;
        safeCall(() => ensureA001Panel(node), undefined, "面板同帧重挂");
    };
    _panelGuardNodes.add(node);
    ensurePanelGuardMO();
}

/* ══════════════════════════════════════════════
 *  控件框按键
 *  ══════════════════════════════════════════════ */

/**
 * 构建控件框内的五个按键：隐藏 / 加载开关 / 记录 / 还原 / 运行。
 *
 * 【本轮只做外观，不绑功能】除「隐藏」「运行」外的按键均无点击行为，
 * 仅呈现底部按键行的样貌。
 * 结构与文案、图标、配色逐项沿用统一的底部按键行
 *   （.xzg-a001-bottom-row / .xzg-a001-set / .xzg-a001-run），
 * 使各节点的按键视觉一致；图标沿用 Material Design Icons 类名
 *   （mdi-eye-off / mdi-history / mdi-restore），
 * 该字体由 ComfyUI 全局提供，无需额外引入。
 * 返回值为一行容器（flex row），宽度撑满控件框，由「运行」键自动占据剩余宽度。
 *
 * ★ 文本按键已移除（2026-09-26）：原「清空文本」（mdi-text-box）按键及其功能
 *   已按需求整体删除（含 A001_SubgraphNode.js 的 clearA001TextWidgets）。
 *
 * 「收起/展开控件」按键（本项目新增，排在记录按键之前）：
 *   切换「已提升到节点面板上的控件」整体收起 / 展开。
 *   语义参考 008_ComfyTV Custom Stage 的 bindPanelCollapse：
 *     · 用 chevron 箭头图标表示当前可执行的动作（收起 → 上箭头；展开 → 下箭头）；
 *     · 文案随状态切换（收起控件 / 展开控件）；
 *     · 状态写进节点 properties 持久化（见 A001_SubgraphNode.js 的
 *       persistA001HiddenState / restoreA001HiddenState）。
 *   仅在**用户点击**时改变状态；刷新 / 重开工作流 / 撤销重做后按存档原样保持。
 *   实现走 A001_SubgraphNode.js 的投影层开关（node._a001WidgetsHidden），
 *   不改动外层端口槽与 widgetId 载体，故可无损来回切换。
 *   图标随状态切换：展开中 → mdi-chevron-up（点击即收起）；收起中 → mdi-chevron-down（点击即展开）。
 *
 * 「加载开关」按键（本项目新增，排在记录按键之前）：
 *   控制本节点能否被 ComfyTV 等外部工具「识别展开」。
 *   开 → 保存时把 A001 伪装成原生子图形态，外部工具可完整展开内层节点；
 *   关（默认）→ 保存为普通 A001 形态，外部工具不识别。
 *   状态写入 node.properties._a001ComfyTVEnabled（随工作流持久化），
 *   图标随状态切换：开 → mdi-toggle-switch（实心胶囊、蓝色）；关 → mdi-toggle-switch-off（空心、默认色）。
 *   逻辑实现在新建的 A001_disguise.js（便于整体移除该功能）。
 *
 * 「记录」按键（本项目新增，排在还原按键之前）：
 *   预留位，图标 mdi-history。本轮只做外观、不绑功能（无 click 监听）。
 *
 * 「还原」按键（本项目新增，排在运行按键之前）：
 *   预留位，图标 mdi-restore。本轮只做外观、不绑功能（无 click 监听）。
 */
export function buildA001Buttons(node) {
    const row = document.createElement("div");
    row.className = "xzg-a001-btn-row";
    row.style.cssText = [
        "display:flex",
        "flex-direction:row",
        "align-items:center",
        `gap:${A001_BTN.GAP}px`,
        "width:100%",
        "box-sizing:border-box",
    ].join(";");

    // 收起/展开控件按键：圆形，箭头图标（chevron），语义参考 008_ComfyTV Custom Stage
    // 的「面板收起/展开」（bindPanelCollapse：用 chevron 表示可收起/展开，文案随状态切换）。
    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "xzg-a001-btn-icon xzg-a001-btn-hide";
    applyA001ButtonStyle(hideBtn);
    // 面板会被 Vue 重建，按键状态每次据节点实际状态回填
    const syncHideBtn = () => {
        const hidden = !!safeCall(() => isWidgetsHidden(node), false);
        // 文案：控件可见时点击=收起；已收起时点击=展开（对齐 Custom Stage 的
        // v2.panelCollapse / v2.panelExpand 语义）。
        hideBtn.title = hidden ? "展开控件" : "收起控件";
        // 图标：可见（可收起）→ 向上箭头 chevron-up；已收起（可展开）→ 向下箭头 chevron-down。
        hideBtn.innerHTML = hidden
            ? '<i class="mdi mdi-chevron-down" aria-hidden="true"></i>'
            : '<i class="mdi mdi-chevron-up" aria-hidden="true"></i>';
    };
    syncHideBtn();
    /* ★ 把刷新出口挂到节点上：加载存档恢复隐藏态时（A001_SubgraphNode 的
     *   restoreA001HiddenState）状态会被改动，而按键此时早已按「显示态」画好，
     *   需要回调一次让图标/tooltip 跟上。面板重建时会重新赋值，天然指向最新按键。 */
    node._a001SyncHideBtn = syncHideBtn;
    hideBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        safeCall(() => toggleWidgetsHidden(node), false);
        syncHideBtn();
    });
    row.appendChild(hideBtn);

    // 加载开关按键：圆形，图标 mdi-toggle-switch（排在记录按键之前）
    // ★ 功能：控制本节点能否被 ComfyTV 等外部工具**识别展开**。
    //   开 → 保存时把 A001 伪装成原生子图形态（ComfyTV 可完整展开内层节点）；
    //   关 → 保存为普通 A001 形态，外部工具不识别。
    //   状态写入 node.properties._a001ComfyTVEnabled，随工作流持久化；
    //   逻辑实现在新建的 A001_disguise.js（便于整体移除该功能）。
    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "xzg-a001-btn-icon xzg-a001-btn-load";
    applyA001ButtonStyle(loadBtn);
    // 面板会被 Vue 重建，按键状态每次据节点实际状态回填（与收起按键同款）
    const syncLoadBtn = () => {
        const on = !!safeCall(() => isComfyTVEnabled(node), false);
        loadBtn.title = on ? "ComfyTV 识别：开（点击关闭）" : "ComfyTV 识别：关（点击开启）";
        // 图标随状态切换：开 → toggle-switch（实心胶囊）；关 → toggle-switch-off（空心胶囊）。
        loadBtn.innerHTML = on
            ? '<i class="mdi mdi-toggle-switch" aria-hidden="true"></i>'
            : '<i class="mdi mdi-toggle-switch-off" aria-hidden="true"></i>';
        // 开时胶囊实心蓝色（取运行键同款蓝，配色统一）；关时恢复默认图标色。
        loadBtn.style.color = on ? A001_BTN.BTN_COLOR : A001_BTN.ICON_FG;
    };
    syncLoadBtn();
    /* 把刷新出口挂到节点上：与收起按键同款，供外观态被外部改动后回调刷新。 */
    node._a001SyncLoadBtn = syncLoadBtn;
    loadBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        safeCall(() => toggleComfyTV(node), false);
        syncLoadBtn();
    });
    row.appendChild(loadBtn);

    // 记录按键：圆形，图标 mdi-history（排在还原按键之前）
    // ★ 已绑功能：把当前节点状态记录为一份「相机快照」。
    const recordBtn = document.createElement("button");
    recordBtn.type = "button";
    recordBtn.className = "xzg-a001-btn-icon xzg-a001-btn-record";
    recordBtn.title = "记录";
    recordBtn.innerHTML = '<i class="mdi mdi-history" aria-hidden="true"></i>';
    applyA001ButtonStyle(recordBtn);
    row.appendChild(recordBtn);

    // 还原按键：圆形，图标 mdi-restore
    // ★ 已绑功能：从记录列表中选择一份快照还原到本节点。
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "xzg-a001-btn-icon xzg-a001-btn-reset";
    resetBtn.title = "还原";
    resetBtn.innerHTML = '<i class="mdi mdi-restore" aria-hidden="true"></i>';
    applyA001ButtonStyle(resetBtn);
    row.appendChild(resetBtn);

    // 绑定「记录 / 还原」功能（幂等；面板被 Vue 重建后新按钮会重新绑定）
    safeCall(
        () => attachA001WorkflowButtons(node, recordBtn, resetBtn),
        undefined,
        "绑定记录/还原按键"
    );

    // 运行按键：胶囊形、flex 撑满剩余宽度（对应 .xzg-a001-run）
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "xzg-a001-btn-run";
    runBtn.textContent = "运行";
    runBtn.title = "运行";
    runBtn.style.cssText = [
        `height:${A001_BTN.BTN_H}px`,
        "flex:1 1 0",
        "min-width:0",
        "box-sizing:border-box",
        "border:none",
        `border-radius:${A001_BTN.BTN_RADIUS}px`,
        `background:${A001_BTN.BTN_COLOR}`,
        `color:${A001_BTN.BTN_FG}`,
        `font-size:${A001_BTN.BTN_FONT_SIZE}px`,
        "line-height:1",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "text-align:center",
        "cursor:pointer",
        "user-select:none",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
        "pointer-events:auto",
    ].join(";");
    runBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    /* hover 底色随状态变化：空闲 → 亮蓝，运行中 → 略亮的灰蓝（base 由回填函数写入） */
    runBtn.addEventListener("mouseenter", () => {
        runBtn.style.background = runBtn.dataset.running === "1"
            ? BTN_RUNNING_COLOR
            : A001_BTN.BTN_HOVER;
    });
    runBtn.addEventListener("mouseleave", () => {
        runBtn.style.background = runBtn.dataset.running === "1"
            ? BTN_RUNNING_COLOR
            : A001_BTN.BTN_COLOR;
    });
    /* ★ 运行按键功能（复刻 008_ComfyTV Custom Stage 运行键的行为语义）：
     *  未运行 → 局部执行本节点（含上游可达节点）；
     *  运行中 → 再点即取消（待执行删除 / 运行中中断）。
     *  外观不复刻，仍为本节点原有的胶囊形蓝底按键。 */
    runBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        safeCall(() => runNode(node), undefined, "运行按键");
        // 点击后立即回填一次，避免等下一次事件才有反馈
        safeCall(() => refreshA001RunButton(runBtn, node), undefined, "运行按键回填");
        /* ★ 点击运行会走 graphToPrompt（含子图展开，遍历全部内层节点），官方在这个
         *  过程中会切换节点的执行态 class → Vue 重渲染节点 DOM → 端口胶囊的换皮
         *  类名（NODE_CLASS / CAP_CLASS）随之丢失，表现为「点运行时整个节点闪一下」。
         *  这里主动补一次刷新（同帧 + 双 rAF，幂等），把恢复从 1.2s 巡检提前到当帧。
         *  用 Appearance 侧注入的出口，避免本模块反向 import A001_SubgraphNode。 */
        safeCall(() => node._a001RefreshPorts?.(), undefined, "运行后刷新端口胶囊");
    });
    // 记录宿主节点与按键，供 A001_SubgraphNode.js 在运行态变化时定向刷新
    runBtn._a001Node = node;
    node._a001RunBtn = runBtn;
    refreshA001RunButton(runBtn, node);
    row.appendChild(runBtn);

    return row;
}

/** 为圆形图标按键统一套用样式与交互（对齐 .xzg-a001-txt / .xzg-a001-set）。 */
function applyA001ButtonStyle(btn) {
    btn.style.cssText = [
        `width:${A001_BTN.ICON_BTN_SIZE}px`,
        `height:${A001_BTN.ICON_BTN_SIZE}px`,
        `flex:0 0 ${A001_BTN.ICON_BTN_SIZE}px`,
        "box-sizing:border-box",
        `border:1px solid ${A001_BTN.ICON_BORDER}`,
        "border-radius:50%",
        `background:${A001_BTN.ICON_BG}`,
        `color:${A001_BTN.ICON_FG}`,
        "cursor:pointer",
        `font-size:${A001_BTN.ICON_FONT_SIZE}px`,
        "line-height:1",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "padding:0",
        "pointer-events:auto",
    ].join(";");
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("mouseenter", () => { btn.style.filter = "brightness(1.25)"; });
    btn.addEventListener("mouseleave", () => { btn.style.filter = ""; });
}

/**
 * 移除面板（节点删除时调用）。
 * 守卫用 MutationObserver 持久化生效，此处必须显式断开，
 * 否则节点删除后回调仍会尝试重挂，造成泄漏。
 */
export function disposeA001Panel(node) {
    if (!node) return;
    // 置终止标记：让已在队列中的观察回调直接返回，不再重挂
    node._a001PanelDisposed = true;
    if (node._a001PanelGuardMO) {
        /* ★ 单例观察器：只从注册表摘除本节点；注册表空了再顺手断掉共享实例。 */
        _panelGuardNodes.delete(node);
        node._a001PanelGuardOnMutations = null;
        node._a001PanelGuardMO = null;
        if (!_panelGuardNodes.size && _panelGuardMO) {
            safeCall(() => _panelGuardMO.disconnect(), undefined, "断开空置的面板观察器");
            _panelGuardMO = null;
            _panelGuardTarget = null;
        }
    }
    node._a001PanelGuardRebind = null;
    /* ★ 观察目标引用一并释放：它指向画布容器 DOM，不清则节点删除后仍强引用。
     *  （守卫本身已 disconnect，此处只断引用。） */
    node._a001PanelGuardTarget = null;
    /* ★ 停止高度解耦记账：断开 ResizeObserver 并清引用，
     *  否则节点删除后观察器仍持有已脱离的面板/网格 DOM，无法 GC。 */
    safeCall(() => stopA001SizeLock(node), undefined, "释放高度解耦记账");
    /* ★ 重试链收束：清定时器 + 复位退避阶梯与宽限起点，
     *  避免节点对象被复用（撤销恢复）时沿用上一轮的退避进度。 */
    if (node._a001PanelRetryTimer) {
        clearTimeout(node._a001PanelRetryTimer);
        node._a001PanelRetryTimer = null;
    }
    node._a001PanelRetryCount = 0;
    node._a001PanelFirstTryAt = 0;
    /* ★ 端口：A001 不再使用 A000_Port.js 的端口条（改用 A001_port_capsule.js），
     *  此处仅清掉旧版本可能残留在节点上的状态对象引用，避免节点对象复用（撤销恢复）时被误用。 */
    node._a001Port = null;
    safeCall(() => node?._a001Panel?.remove?.(), undefined, "移除节点面板");
    node._a001Panel = null;
    node._a001PanelMode = null;
    /* ★ 预览宿主随面板 DOM 一起脱离，此处必须清掉引用：
     *  既避免渲染层往 detached 元素里画内容，也解除对已脱离 DOM 子树的强引用。
     *  预览状态（_a001PreviewState）不在此清理——节点对象被复用（撤销恢复）时
     *  仍可凭它重绘；真正的资源释放在 onRemoved → disposeA001Preview 里做。 */
    node._a001PreviewHost = null;
    /* ★ 一并释放 DOM 引用缓存：由 findNodeRoot / findNodeBody 写入，
     *  若不清理则节点删除后仍强引用已脱离的 DOM 子树，无法 GC。 */
    node._a001DomRoot = null;
    node._a001DomBody = null;
    /* ★ 清掉按键与预览提示的元素引用：它们是本模块写入节点对象的字段，
     *  不清则节点删除后仍强引用已脱离的 <button> DOM 子树；且节点对象被复用
     *  （撤销/重做）时，运行态刷新会刷到「看不见的旧按钮」上。 */
    node._a001RunBtn = null;
    node._a001SyncHideBtn = null;
    node._a001SyncLoadBtn = null;
    node._a001PreviewHint = null;
    /* ★ 一并清掉 dirtyCanvas 的同帧去重标志（与 A001_SubgraphNode 的 onRemoved 一致）：
     *  该标志由 rAF 回调负责复位，若节点在此之间被删除且对象后续被复用，
     *  残留的 pending=true 会让 dirtyCanvas 永久跳过重绘。 */
    node._a001DirtyPending = false;
}

