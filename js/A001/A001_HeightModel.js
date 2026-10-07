// ═══════════════════════════════════════════════════════════════
//  A001_子图节点 · 高度模型
//
//  职责单一：把节点高度拆成「chrome + wanted - offset」并按绝对值重算，
//  解决「拖高文本框会压缩预览框」—— 即节点高 = chrome 变化 + 预览框高度保持。
//
//  本节由 A001_Appearance.js 拆分而来（原先「面板装配 + 高度模型」混在 1764 行内）：
//    · 出边仅 A001_FRAME（视觉常量）与 findNodeRoot（节点根定位），两者已下沉到
//      A001_shared.js —— 故本模块对包内其它模块零依赖，不存在循环依赖风险；
//    · 对外的 startA001SizeLock / stopA001SizeLock / resyncA001SizeLock 由
//      A001_Appearance.js re-export，外部调用方（A001_SubgraphNode.js）无需改动。
//
//  本区块代码为原实现逐字搬迁：未改任何逻辑、常量、时序、日志文案。
// ═══════════════════════════════════════════════════════════════

import { A001_FRAME, findNodeRoot, alog, safeCall } from "./A001_shared.js?v=20261007a";

/* ══════════════════════════════════════════════
 *  高度模型 —— 一比一移植 008_ComfyTV Custom Stage 的 bindCardHeight
 *
 *  【模型（绝对值 · 单入口 · 幂等）】
 *      节点高 = chrome + wanted - offset
 *        · chrome = card.offsetHeight - flexible.offsetHeight
 *          「卡片内除预览框外的所有固定块」合计（标题 / 控件网格 / 文本框 / 按键框…）
 *        · offset = card.offsetHeight - node.size[1]
 *          卡片比节点高的「常量差」（DOM 空间与节点空间的换算）
 *        · wanted = max(min, flexible.offsetHeight) —— 预览框的「期望高度」
 *      因为全程用绝对值重算，apply() 调两次 = 调一次，天生幂等、不会重复累加。
 *
 *  【两级触发（照抄 Custom Stage 的 onResize）】
 *      · chromeOf() 变了            → 内容变化（控件显隐 / 文本框拖高…）→ apply()
 *      · chromeOf() 没变、节点高变了 → 用户拉伸节点 → sample()（刷新基线）
 *      这两条把「内容变化」与「用户拉伸」天然分开，互不干扰。
 *
 *  【live 闸门（照抄 goLive）】
 *      面板挂载后内容还会异步成型；在用户真正操作之前**绝不接管节点高度**，
 *      以免把工作流保存时的高度改掉。触发源：pointerdown(capture) + onConnectionsChange。
 *
 *  【A001 的等价物映射】
 *      card     = 面板的父元素（node-body，下称 host）
 *      flexible = 预览框 .xzg-a001-preview（唯一弹性块）
 *      panel    = .xzg-a001-panel（内含 预览框 + 按键框，是 chrome 的一部分）
 *      控件网格 = 官方 .lg-node-widgets（chrome 的另一部分，永不被 JS 强改 flex）
 *
 *  【面板内顺序】预览框 → 按键框 → 控件网格（预览框在上、按键框在下）。
 *
 *  【为什么能解决「拖高文本框会压缩预览框」】
 *      文本框属于 chrome → 它变高 → chromeOf 变大 → apply() 把节点加高到
 *      「新 chrome + wanted」→ 预览框高度 = wanted 保持不变。
 * ══════════════════════════════════════════════ */

/** 判定两次高度差是否达到需要处理的程度（亚像素抖动忽略）。与 Custom Stage 的 <1 同口径。 */
const A001_SIZE_LOCK_EPS = 1;

/** ★★ DOM 重建冻结窗（ms）：节点根/面板被 Vue 重建（进出子图、刷新、执行态切换）后的
 *  短暂窗口内，禁止 sample() 改写 wanted。
 *
 *  【为什么必须冻结（血泪教训，勿删）】
 *    重建瞬间的测量是「旧 DOM 的 chrome」与「新 node.size」的错配组合，读到的预览框高度
 *    是过渡值（实测同一节点：真实基线 473，重建窗口内被采成 674 并写进 wanted →
 *    节点被永久改成 761）。时间窗失效后，apply() 已把 node.size 收敛为
 *    「chrome + wanted」，此时再采样读到的就是 wanted 本身，幂等无害。 */
const A001_REBUILD_FREEZE_MS = 1200;

/** 取节点的 [宽, 高]（兼容 size / _size / properties）。与 A001_SubgraphNode 同口径。 */
function readSizeLockNodeSize(node) {
    return safeCall(() => {
        const s = node?.size;
        if (Array.isArray(s) && s.length >= 2) return [Number(s[0]) || 0, Number(s[1]) || 0];
        if (s && Number.isFinite(s[0]) && Number.isFinite(s[1])) return [Number(s[0]), Number(s[1])];
        return [Number(node?.size?.[0]) || 0, Number(node?.size?.[1]) || 0];
    }, [0, 0], "读节点尺寸(高度模型)");
}

/**
 * ★★ 高度模型入口 —— 一比一移植 Custom Stage 的 bindCardHeight（实测踩坑，勿省）：
 *
 *   Custom Stage 原文：
 *     const laidOut    = () => card.offsetHeight > 0
 *     const measurable = () => laidOut() && flexible.offsetHeight > 0
 *     const chromeOf   = () => card.offsetHeight - flexible.offsetHeight
 *     const sample = () => {
 *       chrome  = chromeOf()
 *       offset  = card.offsetHeight - node.size[1]
 *       wanted  = Math.max(min, flexible.offsetHeight)
 *       applied = node.size[1]
 *     }
 *     const goLive = () => { if (live || !measurable()) return; live = true; sample() }
 *     const apply  = () => {
 *       goLive()
 *       if (!live || !laidOut()) return
 *       chrome = chromeOf()
 *       const h = chrome + wanted - offset
 *       applied = h
 *       if (Math.abs(h - node.size[1]) < 1) return
 *       node.setSize([node.size[0], h])
 *       app.graph?.setDirtyCanvas?.(true, true)
 *     }
 *     card.dataset.v2Height = '1'
 *     card.addEventListener('pointerdown', goLive, { capture: true })
 *     anyNode.onConnectionsChange = function(...){ goLive(); return prev?.apply(this, ...) }
 *     onResize = () => {
 *       if (!laidOut()) return
 *       if (!live) { chrome = chromeOf(); return }
 *       if (chromeOf() !== chrome) apply()
 *       else if (measurable() && Math.abs(node.size[1] - applied) >= 1) sample()
 *     }
 *     useResizeObserver(card, onResize); useResizeObserver(flexible, onResize)
 *     return apply
 *
 *   本函数返回的闭包即 A001 的 `apply`，挂到 node._a001SyncHeight，作为
 *   **唯一**的高度同步入口（收起/展开、外部改尺寸后都调它）。
 *
 *   与 Custom Stage 的唯一差异：`card` 用「面板的父元素（node-body）」，
 *   因为 A001 的面板与官方控件网格是**兄弟**（Custom Stage 是自建单卡片）。
 *   chromeOf() 因此天然涵盖「标题 + 控件框 + 控件网格 + 文本框」等全部固定块。
 */
export function startA001SizeLock(node) {
    if (typeof ResizeObserver === "undefined" || !node) return;
    const previewEl = node._a001Panel?.querySelector?.(".xzg-a001-preview");
    /* ★★ host 必须取 **`.lg-node`（节点根）**，不能取 node-body（实测踩坑，勿改回）——
     *   这是「节点下方一大片空白」的最终修复点：
     *     · `.lg-node` 的 CSS 高度**不受 node.size 约束**（height:auto，由内容撑开）；
     *       litegraph 只改它的 transform 位置，不写 height。
     *     · 因此「DOM 高度 ⇄ node.size」的换算基准只能是 `.lg-node` 本身：
     *         chromeOf() = root.offsetHeight − 预览框.offsetHeight
     *         offset    = root.offsetHeight − node.size[1]
     *       两者相消后 h 恰等于 root 应有的高度，节点框与面板**严丝合缝**。
     *     · 早先用 node-body 作 host 时：body 只是 root 的子层，root 还多出
     *       「标题栏 + 边框」共 56px；而 offset 记的是 body−node.size，导致
     *       h 算出来比 root 实际需要的高度**小 30px** → 节点框底部空出 30px，
     *       叠上面板自身溢出，视觉上就是「节点下方一大片空白」。 */
    const hostEl = findNodeRoot(node) || node._a001Panel?.parentElement;
    if (!previewEl || !hostEl) return;

    let lock = node._a001SizeLock;
    if (!lock) {
        lock = {
            ro: null, previewEl: null, hostEl: null,
            /* 照搬 Custom Stage 的六个状态量。 */
            chrome: -1, wanted: 0, offset: 0, applied: -1, live: false,
            /* offset 是否已采（全程只采一次，见 sample 的自噬保护说明）。 */
            offsetCaptured: false,
            /* DOM 重建冻结窗的截止时间戳（0 = 无冻结；见 A001_REBUILD_FREEZE_MS）。 */
            _rebuildUntil: 0,
            /* goLive 闸门的配套清理句柄（boundCard=卡片层；boundCanvas=画布层）。 */
            goLiveHandler: null, boundCard: null, connPrev: null, connPatched: false,
            canvasPointerHandler: null, boundCanvas: null,
            /* computeSize 钉住（照抄 stopNativeAutoGrow）的配套清理句柄。 */
            computeSizePinned: false, computeSizePrev: null,
            /* 稳定采样（settleA001Offset）的轮询句柄与上轮读数。 */
            _settleTimer: 0, _settleDomH: null,
            /* offset 首采（settleA001CaptureOffset）的轮询句柄与上轮读数。 */
            _capTimer: 0, _capDomH: null,
            /* 外部同步（resyncA001SizeLock）的推迟校正定时器。 */
            _resyncTimer: 0,
            /* apply 闭包本体（＝ Custom Stage 的返回值）。 */
            apply: null,
        };
        node._a001SizeLock = lock;
        lock.ro = new ResizeObserver(() => safeCall(() => onA001SizeLockChange(node), undefined, "高度模型回调"));
        /* 定义 apply / sample / goLive（闭包捕获 lock 与 node）。 */
        defineA001HeightOps(node, lock);
        /* 外部同步出口（等价 Custom Stage 的 __comfytvSyncHeight）：
         * ★ 必须走 runA001Resync 的双判据，**不能直接 apply** ——
         *   否则「用户拉伸过节点后点收起/展开」会用旧 wanted 把用户的尺寸打回去
         *   （实测：拉伸到 620 后 sync 被打回 351）。 */
        node._a001SyncHeight = () => safeCall(() => runA001Resync(node, lock), undefined, "高度模型同步");
    }
    /* 重绑观察目标（host / previewEl 可能已被 Vue 重建换新元素）。
     * ★ 判据必须包含「host 是否已升级为真正的节点根」：首次装配时 DOM 可能尚未就绪，
     *   findNodeRoot 返回 null → 退化成 parentElement(node-body)；等 DOM 就绪后
     *   必须把它升级回 .lg-node，否则 offset 口径错误、预留出「节点下方大片空白」。 */
    const hostIsRoot = hostEl.getAttribute?.("data-node-id") != null;
    if (lock.previewEl !== previewEl || lock.hostEl !== hostEl
        || (hostIsRoot && lock.hostEl?.getAttribute?.("data-node-id") == null)) {
        safeCall(() => lock.ro.disconnect(), undefined, "高度模型重绑");
        lock.previewEl = previewEl;
        lock.hostEl = hostEl;
        /* ★ 元素被换新 = DOM 重建 → 开启冻结窗，期间 sample() 不得改写 wanted
         *   （否则会采到「旧 chrome × 新 node.size」的过渡值并永久失真）。 */
        if (lock.wanted > 0) lock._rebuildUntil = Date.now() + A001_REBUILD_FREEZE_MS;
        /* 观察 host 与预览框：任一变化即按两级判据处理（照抄 useResizeObserver 两处）。 */
        safeCall(() => lock.ro.observe(hostEl, { box: "content-box" }), undefined, "观察 host");
        safeCall(() => lock.ro.observe(previewEl, { box: "content-box" }), undefined, "观察预览框");
        /* goLive：host 被 Vue 换成新元素后，原 pointerdown 监听绑在旧元素上，必须重绑。 */
        safeCall(() => bindA001SizeLockGoLive(node), undefined, "重绑 live 闸门");
        /* host 换了 → 既有基线全部作废，重新采样（否则 offset/chrome 口径仍是旧的）。
         * 未 live 时不采样：保持「用户未操作前不接管」的语义，只等 goLive 时建立基线。 */
        if (lock.live) safeCall(() => lock.sample?.(), undefined, "重绑后重新采样基线");
    }
}

/**
 * ★ host 自愈：把观察基准升级为真正的 `.lg-node`（幂等）。
 *
 * 为什么需要独立入口：`startA001SizeLock` 只在 `ensureA001Panel` 走 flow 分支时被调用，
 * 而那一刻 DOM 往往还没渲染出来 —— `findNodeRoot` 返回 null，于是 host 退化成
 * node-body 并被记住；之后 DOM 就绪却**再也没人重绑**，导致 offset 口径永久错误
 * （节点下方预留出 30px 空白）。故在每个高度同步入口（goLive / apply）先自愈一次。
 */
function refreshA001SizeLockHost(node) {
    const lock = node?._a001SizeLock;
    if (!lock) return;
    const root = findNodeRoot(node);
    if (!root) return;
    if (lock.hostEl === root) return;
    /* 只在 host 尚未是节点根、或根已被 Vue 换新时升级/重绑。 */
    const curIsRoot = lock.hostEl?.getAttribute?.("data-node-id") != null;
    if (curIsRoot && lock.hostEl?.isConnected) return;
    safeCall(() => {
        lock.ro?.disconnect?.();
        lock.hostEl = root;
        const previewEl = node._a001Panel?.querySelector?.(".xzg-a001-preview");
        if (previewEl) lock.previewEl = previewEl;
        /* ★ 节点根被 Vue 换新 = DOM 重建 → 开启冻结窗，期间 sample() 不得改写 wanted
         *   （否则会采到「旧 chrome × 新 node.size」的过渡值并永久失真）。 */
        if (lock.wanted > 0) lock._rebuildUntil = Date.now() + A001_REBUILD_FREEZE_MS;
        lock.ro?.observe?.(root, { box: "content-box" });
        if (previewEl) lock.ro?.observe?.(previewEl, { box: "content-box" });
        bindA001SizeLockGoLive(node);
        /* ★ host 换了「元素」（Vue 重建节点根）→ 旧的 offset 是按旧元素的几何算的，必须作废
         *   并允许重采一次；否则新元素的换算基准错误，高度会系统性偏移。
         *   ★ 必须走 settleA001CaptureOffset 重采（不能只重置 flag）：offset 已不在 sample 内，
         *     仅重置 flag 会导致 offset 永远停在旧值。重采同样等 DOM 稳定，避免采到变形瞬间值。 */
        lock.offsetCaptured = false;
        lock._capDomH = null;
        if (lock.live) {
            lock.sample?.();
            settleA001CaptureOffset(node, lock);
        }
    }, undefined, "host 自愈为节点根");
}

/**
 * 定义 sample / apply / goLive 三个闭包（照抄 Custom Stage bindCardHeight 内部函数）。
 * 写进 lock，供 onResize 与外部同步入口调用。
 */
function defineA001HeightOps(node, lock) {
    const laidOut = () => (lock.hostEl?.offsetHeight || 0) > 0;
    const measurable = () => laidOut() && (lock.previewEl?.offsetHeight || 0) > 0;
    const chromeOf = () => (lock.hostEl?.offsetHeight || 0) - (lock.previewEl?.offsetHeight || 0);

    /* sample：把当前 DOM 与节点尺寸对齐成基线（幂等，不写 node.size）。
     *
     * ★★ offset 已**从此函数移出**（关键修复，勿改回在 sample 里首采）：
     *   `offset = host.offsetHeight − node.size[1]` 只有在「预览框处于接管态（min-height 已归零）
     *   且 DOM 稳定」时才成立。而 goLive 里 sample 发生在**打 data-a001-height 之前** ——
     *   那一刻预览框仍被 CSS min-height:200px 撑着，host 高度里含了这 200px 虚高，于是：
     *     新建节点 node.size=[250,26]，host≈361 → offset 被错误采成 335（正确值应为 105）。
     *   打完标记后 min-height 归零、DOM 塌到 131，offset 却永久锁死为 335 →
     *   高度换算系统性偏差（预览框高度不对）+ apply 反复写错 size → RO 持续回调 → 高频闪。
     *   故 offset 改由 captureOffset() 在「标记已生效 + DOM 稳定」后单独采一次。
     *   chrome / wanted / applied 不受影响（chrome 变形前后恒为 121，与采样时机无关）。 */
    const sample = () => {
        const c = lock.hostEl, p = lock.previewEl;
        if (!c || !p) return;
        /* ★★ 采样前置闸门（血泪教训：进出子图后预览框高度被打回默认 200，勿删！）
         * -------------------------------------------------------------------------
         * 背景：退出子图时 Vue 会重建节点 DOM —— 新面板元素上 data-a001-height 会
         *   短暂丢失，于是 CSS 兜底 `.xzg-a001-panel .xzg-a001-preview{min-height:200px}`
         *   立即生效、把预览框撑到 200；此刻若有人调 sample()，wanted 就被写成
         *   max(200, 200)=200，用户原来的高度被**永久覆盖**（实测 423/336 → 287/200）。
         * 三道闸门（不满足「可信采样」时只放弃本次采样、保留既有基线）：
         *   ① 可测量性：host 或预览框 offsetHeight ≤ 0（节点被隐藏 / 进出子图当帧）→ 放弃；
         *      否则 chrome 会被算成 0、wanted 被算成 200。
         *   ② 接管态：测量到的预览框所属面板若已脱离接管态（无 data-a001-height，
         *      正被 CSS 兜底撑着），且我们已有基线（wanted>0）→ 读到的不是用户高度，放弃。
         *   ③ 重建冻结窗：DOM 刚被 Vue 重建后的 _rebuildUntil 窗口内（见该常量头注），
         *      读到的是「旧 chrome × 新 node.size」的过渡值 → 一律放弃。
         * 注：首次 goLive 建立基线时 wanted=0 → 闸门②③均放行，语义不变。 */
        const ch = c.offsetHeight || 0;
        const ph = p.offsetHeight || 0;
        if (ch <= 0 || ph <= 0) return;
        /* ③ 重建冻结窗：DOM 刚被 Vue 重建（进出子图等）时不采信测量值，
         *    只保留既有基线（详见 A001_REBUILD_FREEZE_MS 头注）。 */
        if (lock.wanted > 0 && Date.now() < (lock._rebuildUntil || 0)) return;
        const livePanel = safeCall(() => p.closest?.(".xzg-a001-panel"), null, "取预览框所属面板");
        if (lock.wanted > 0 && livePanel && !livePanel.hasAttribute("data-a001-height")) return;
        const [_, nh] = readSizeLockNodeSize(node);
        lock.chrome = ch - ph;
        /* ★★ wanted = 预览框实测高度，但**不得低于 PREVIEW_MIN_H(200)**（用户指定，勿改回裸值）：
         *   预览框是本节点主视觉区，必须常驻 ≥200px。CSS 已用
         *   `.xzg-a001-panel[data-a001-height] .xzg-a001-preview { min-height:200px }`
         *   兜底，这里再取 max 作为 JS 侧双保险（例如布局塌陷帧读到偏小值时）。
         *
         *   ⚠️ 与「旧 bug：收起控件后节点不变矮」的区别（关键，勿误判为回归）：
         *     旧 bug 的成因是 offset 被错采成 335（含 min-height 虚高），
         *     导致 h = chrome + max(200, preview) − 335 恒定不变。现在 offset 已修正为
         *     常量 30，收起控件改变的是 **chrome**（控件网格高度），wanted 稳定在 200 →
         *     h 随 chrome 减小而减小 → **节点正确变矮**。
         *     故此处加下限是安全的，且正与 Custom Stage 的 Math.max(min, flexible) 同构。 */
        lock.wanted = Math.max(A001_FRAME.PREVIEW_MIN_H, ph);
        lock.applied = nh;
    };

    /* captureOffset：确定「节点根 DOM 相对 node.size 的固定偏移」（幂等，只定一次）。
     *
     * ★★ 语义与取值（实测踩坑，勿改回「host − nodeH」的裸差值）：
     *   我们希望高度模型的等式是：
     *       node.size[1] = chrome + wanted − offset
     *   而真实 DOM 稳态关系恒为（实测 5 组尺寸全部吻合）：
     *       host.offsetHeight = node.size[1] + NODE_TITLE_HEIGHT(30)
     *       chrome = host − preview
     *   两式联立（wanted 采的就是 preview）解得：offset ≡ 30（标题栏高度）。
     *
     *   ⚠️ 为什么不能用 `host.offsetHeight − node.size[1]` 直接测：
     *     host 的实际高度 = max(node.size[1] + 30, 面板内容自然高度)。
     *     新建节点 node.size[1]=26 时面板内容已有 131 → 落在**饱和区**，
     *     此时差值是 105（=30+75 溢出），而不是 30。用它在接管后算高度会系统性偏差，
     *     并让 apply 反复写错 size → RO 持续回调 → 拉伸时高频闪。
     *     （实测映射：26/100→host 恒 131；200→230；300→330；426→456。饱和区只在小于面板高时出现。）
     *   故直接取标题栏高度这个**结构性常量**，并做一次饱和区校验用于自检。
     *   采过即锁定（offsetCaptured）；仅当 host 被 Vue 替换时由 refreshA001SizeLockHost 作废重定。 */
    const captureOffset = () => {
        const c = lock.hostEl;
        if (!c || lock.offsetCaptured) return;
        /* 标题栏高度取官方常量（与 litegraph 同源），取不到回退 30。 */
        const titleH = Number(
            safeCall(() => window.LiteGraph?.NODE_TITLE_HEIGHT, undefined, "取标题栏高")
        );
        lock.offset = Number.isFinite(titleH) && titleH > 0 ? titleH : 30;
        lock.offsetCaptured = true;
    };

    /* goLive：建立基线并接管高度（幂等）。
     *
     * ★★ 本函数现在等价于 Custom Stage 的 `apply()` 首行调用（实测踩坑，勿改回「仅用户操作才 live」）：
     *   原实现照抄了 Custom Stage 的 goLive 闸门（只有 pointerdown / onConnectionsChange 才 live），
     *   但 Custom Stage 的真正入口是 `apply()` —— 它在每次 DOM 变化（ResizeObserver）时被调用，
     *   首行就是 `goLive()`，因此**内容一变化就自动接管**，从不依赖用户交互。
     *   我们早先把「无用户交互」当成「不接管」，于是：
     *     · 用户点「收起控件」→ 节点高度完全不动（用户反馈「收起控件后点画布，控件区域又弹出来」）；
     *     · 只有先点一下画布（触发 live 闸门）才生效 —— 交互顺序决定结果，不符合一比一复刻。
     *   故改为：只要 DOM 可测量就建立基线并接管（幂等）；node.size 由绝对值模型重算，
     *   工作流保存的高度在加载那一帧即被归一化为「chrome + wanted」，与 Custom Stage 一致。
     * ★ 同时给面板打 data-a001-height —— CSS 据此把预览框 min-height 归 0
     *   （一比一照抄 Custom Stage 的 card.dataset.v2Height = '1'）。
     *
     * ★★ 顺序铁律（实测踩坑，勿调换）：
     *   ① 先 sample() 建立基线（此刻 offset 才可信：DOM 还是 node.size 的自然映射）；
     *   ② 再置 live=true 并打 data-a001-height（此后模型开始改写 node.size）。
     *   若先置 live 再采样，sample 的 offsetCaptured 分支虽能兜住，但 data-a001-height
     *   会让预览框 min-height 立刻归 0、DOM 当帧就变，采到的 chrome 已经是变形后的值。 */
    const goLive = () => {
        /* ★★ 已 live 时不能直接 return（修复「data-a001-height 永不补回」，勿改回）：
         *   原实现首行 `if (lock.live || ...) return` 会连「补标记」这一步一起跳过。
         *   而 lock.live 存在【节点对象】上、data-a001-height 存在【面板元素】上 ——
         *   面板被 Vue 重建后属性随旧元素一起消失，但 live 仍是 true → 属性永远补不回来
         *   → 预览框被 PREVIEW_MIN_H(200px) 硬下限顶住 → 高度模型与 DOM 长期打架
         *   （表现为「节点高度偶尔弹一下 / 收起后不变矮」）。
         *   故：已 live 时仍要「补齐标记」，只是不再重复采样与钉 computeSize。 */
        if (lock.live) {
            safeCall(() => {
                const panel = node._a001Panel;
                if (panel?.isConnected && !panel.hasAttribute("data-a001-height")) {
                    panel.setAttribute("data-a001-height", "");
                }
            }, undefined, "补齐高度接管标记");
            return;
        }
        if (!measurable()) return;
        /* ★ 先自愈 host（升级为 .lg-node），确保 offset/chrome 口径正确 —— 见其注释。 */
        safeCall(() => refreshA001SizeLockHost(node), undefined, "goLive 前自愈 host");
        /* ① 建立基线：此刻只采 chrome / wanted / applied，**不采 offset**（见 sample 头注）。
         *   为什么仍要在打标记之前采：chrome 变形前后恒等（预览框不在 chrome 里），
         *   wanted 此刻受 min-height 影响不可靠，但下面 captureOffset 后会由 apply 修正。 */
        sample();
        /* ② 接管：置 live，并标记高度接管（预览框 min-height 归 0）。 */
        lock.live = true;
        safeCall(() => node._a001Panel?.setAttribute("data-a001-height", ""),
            undefined, "标记高度接管");
        /* ★★ ③ offset 首采 —— 必须在 data-a001-height 生效之后（关键修复，勿调换到 sample 里）：
         *   标记生效会让预览框 min-height 归 0、DOM 当帧塌缩，offset 的换算基准只有在
         *   这个「接管态稳态」下才正确（新建节点：错采 335 → 正确 105）。
         *   但标记的 CSS 生效与 DOM 重排是异步的，故用「轮询到 DOM 稳定」再采：
         *   连续两次读到相同 host 高度即视为稳定（与 settleA001Offset 同判据，
         *   且不受页面可见性影响 —— 后台标签页 rAF 会被暂停，不能用 rAF）。 */
        safeCall(() => settleA001CaptureOffset(node, lock), undefined, "goLive 后稳定采样 offset");
        /* ★★ 钉住 computeSize（一比一照抄 Custom Stage 的 stopNativeAutoGrow，实测踩坑）：
         *   官方的 computeSize() 只算「标题 + 控件网格」，**不知道我们的预览面板存在**；
         *   一旦接管高度后官方仍按 computeSize 自动调尺寸，就会与 bindCardHeight 模型
         *   正面打架（表现为「刚调好高度又被弹回去 / 上下抖」）。
         *   Custom Stage：node.computeSize = () => [node.size[0], node.size[1]]
         *   即「尺寸只由我（高度模型）说了算」。这里在 goLive 时钉一次，
         *   并在 stopA001SizeLock 里还原（节点对象会被复用）。 */
        if (!lock.computeSizePinned) {
            lock.computeSizePinned = true;
            lock.computeSizePrev = node.computeSize;
            safeCall(() => {
                node.computeSize = () => [node.size[0], node.size[1]];
            }, undefined, "钉住 computeSize（高度模型独占）");
        }
        /* ★★ goLive 后立即收敛一次（必需，实测踩坑）：
         *   Custom Stage 靠 ResizeObserver 在 DOM 变化时触发 apply，故它的 goLive 只需 sample；
         *   但我们的环境里 RO/rAF 在标签页不可见时会被暂停，单靠 RO 可能永不触发 apply
         *   → 用户点了节点、模型 live 了，节点高度却仍是旧值（实测 nodeH 停在 26）。
         *   故 goLive 建立基线后**主动 apply 一次**，保证「一交互即接管」。
         *   用 lock.apply?.() 延迟取用：apply 在下方才定义（闭包 TDZ），此刻尚未赋值，
         *   但 goLive 是运行时调用、届时 apply 已就绪。 */
        safeCall(() => runA001Resync(node, lock), undefined, "goLive 后立即收敛");
        /* ★ 再启动稳定收敛：goLive 时 DOM 往往未稳定，待 DOM 停止变化后再 apply 一次
         *   （用 setTimeout，不受页面可见性影响）。offset 已首采锁定，这里只收敛、不重采。 */
        lock._settleDomH = null;
        safeCall(() => settleA001Offset(node, lock), undefined, "goLive 后稳定收敛");
    };

    /* apply：绝对值重算节点高（幂等）。 */
    const apply = () => {
        goLive();
        if (!lock.live || !laidOut()) return;
        /* ★★ offset 未采到前**绝不写 node.size**（关键修复，勿删）：
         *   offset 是「DOM↔画布单位」的换算基准，未采到时为 0。若此时按
         *   h = chrome + wanted − 0 反算，会得到一个荒谬的大高度（新建节点实测 361），
         *   把节点瞬间撑大；等 offset 采到后再缩回 → 用户看到「拉伸/接管瞬间剧烈闪一下」。
         *   故 offsetCaptured 为假时直接返回：等 settleA001CaptureOffset 采到后由它主动 apply。 */
        if (!lock.offsetCaptured) return;
        /* ★ 每次同步前自愈 host（幂等、开销极低）：Vue 重建节点根后能自动切到新元素。 */
        safeCall(() => refreshA001SizeLockHost(node), undefined, "apply 前自愈 host");
        const c = lock.hostEl, p = lock.previewEl;
        if (!c || !p) return;
        /* ★★ 这里**不**校准 offset（实测踩坑，勿加）：
         *   setSize 当帧 DOM 尚未重排，`c.offsetHeight` 还是旧值而 `node.size` 已是新值，
         *   据此重算 offset 会越算越小、正反馈发散（实测把节点从 256 一路吹到 1176）。
         *   任何「企图在 apply 内自我校准」的方案都绕不开这个时序陷阱，
         *   故 offset 只在**确定 DOM 已稳定**的时机采样（见 captureOffset 与 settleA001CaptureOffset）。 */
        lock.chrome = chromeOf();
        const [w, nh] = readSizeLockNodeSize(node);
        const h = lock.chrome + lock.wanted - lock.offset;
        lock.applied = h;
        if (Math.abs(h - nh) < A001_SIZE_LOCK_EPS) return;
        safeCall(() => node.setSize?.([w, Math.max(1, Math.ceil(h))]), undefined, "高度模型 apply");
        if (typeof node.graph?.setDirtyCanvas === "function") {
            safeCall(() => node.graph.setDirtyCanvas(true, true), undefined, "高度模型重绘");
        }
    };

    lock.laidOut = laidOut;
    lock.measurable = measurable;
    lock.chromeOf = chromeOf;
    lock.sample = sample;
    lock.captureOffset = captureOffset;
    lock.goLive = goLive;
    lock.apply = apply;
}

/**
 * ★★ 轮询到 DOM 稳定后，采一次 offset（goLive 专用，仅一次）。
 *
 *  **为什么必须等稳定再采**：
 *    打上 data-a001-height 后预览框 min-height 归 0，DOM 会当帧塌缩；
 *    此刻立刻读 host.offsetHeight 可能仍是塌缩前的旧值，采到的 offset 依然偏大。
 *    故轮询到「连续两次 host 高度相同」再采，与 settleA001Offset 同判据。
 *
 *  **为什么不用 rAF**：后台标签页 rAF 会被暂停（实测 pendingRaf 永不执行），
 *    用 setTimeout 轮询才不受页面可见性影响。
 *
 *  **采到后立即 apply 一次收敛**：offset 从旧的错误值变为正确值，节点高度会随之修正，
 *    必须马上按新 offset 重算一次，否则要等下一次 RO 回调才生效（表现为「闪一下才对」）。
 */
function settleA001CaptureOffset(node, lock, attempt = 0) {
    if (!node || !lock || attempt > 12) return;      // 最多约 12×30ms ≈ 360ms
    if (lock.offsetCaptured) return;                 // 已被别处采过（幂等）
    const c = lock.hostEl;
    if (!c?.isConnected) return;
    const domH = c.offsetHeight;
    const prevDomH = lock._capDomH;
    lock._capDomH = domH;
    const stable = prevDomH != null && Math.abs(domH - prevDomH) < A001_SIZE_LOCK_EPS;
    if (!stable) {
        if (lock._capTimer) return;
        lock._capTimer = setTimeout(() => {
            lock._capTimer = 0;
            settleA001CaptureOffset(node, lock, attempt + 1);
        }, 30);
        return;
    }
    lock._capDomH = null;
    safeCall(() => lock.captureOffset?.(), undefined, "稳定后采样 offset");
    /* offset 变了 → 立即按新基准收敛一次（sample 刷新 wanted，apply 重算 node.size）。 */
    safeCall(() => lock.sample?.(), undefined, "采样后刷新基线");
    safeCall(() => lock.apply?.(), undefined, "采样后收敛高度");
}

/**
 * ★★ 等 DOM 稳定后再收敛一次高度（**不再校准 offset**）。
 *
 *  **为什么不能直接在 apply/goLive 里收敛**（实测踩坑，勿改回）：
 *    setSize 当帧 DOM 尚未重排 —— 此刻 `host.offsetHeight` 还是旧值、`node.size` 已是新值，
 *    此时算出的目标高必然偏差，连续 apply 会把节点尺寸一路推走（正反馈发散）。
 *
 *  **为什么不用 rAF / ResizeObserver**：
 *    浏览器在标签页不可见/未激活时会暂停 rAF、RO 回调也可能不派发
 *    （实测 pendingRaf 一直挂着不执行），收敛就永远不发生。
 *    故改用 **setTimeout 轮询 + 稳定判据**：连续两次读到相同的 host 高度即视为已稳定
 *    （等价于 RO 的「尺寸停止变化」语义，且不受页面可见性影响）。
 *
 *  **为什么这里不采 offset**（与 sample 的自噬保护同一理由）：
 *    进入本函数时模型多半已 live，DOM 高度已是「模型的输出」，此刻
 *    `host.offsetHeight − node.size[1]` 是自噬值，采信即发散
 *    （实测：收起一次 node.size 从 649 掉到 1）。offset 已由 sample 首采锁定，这里只收敛。
 */
function settleA001Offset(node, lock, attempt = 0) {
    if (!node || !lock || attempt > 12) return;      // 最多约 12×30ms ≈ 360ms
    const c = lock.hostEl;
    if (!c?.isConnected) return;
    const domH = c.offsetHeight;
    const prevDomH = lock._settleDomH;
    lock._settleDomH = domH;
    /* 稳定判据：本轮 host 高度与上一轮相同 → DOM 已停止变化。 */
    const stable = prevDomH != null && Math.abs(domH - prevDomH) < A001_SIZE_LOCK_EPS;
    if (!stable) {
        if (lock._settleTimer) return;
        lock._settleTimer = setTimeout(() => {
            lock._settleTimer = 0;
            settleA001Offset(node, lock, attempt + 1);
        }, 30);
        return;
    }
    lock._settleDomH = null;
    /* 已稳定：按当前基线收敛一次（apply 幂等，重复调用无副作用）。 */
    safeCall(() => lock.apply?.(), undefined, "稳定后收敛高度");
}

/**
 * goLive 闸门（照抄 Custom Stage，并按 A001 的结构补一个触发源）：
 *   · pointerdown（capture）绑在【节点卡片】上 —— 照抄 Custom Stage；
 *   · pointerdown（capture）绑在【画布层】上 —— **A001 必需，见下方实测说明**；
 *   · onConnectionsChange —— 用户给节点连线（未必有 pointerdown）。
 * 触发后建立基线并接管高度；在此之前绝不改 node.size，保住已保存的工作流高度。
 *
 * ★★ 为什么必须补「画布层」这一个触发源（实测踩坑，勿删）：
 *   Custom Stage 的卡片是 addDOMWidget 挂进官方网格的，**用户操作节点必然命中卡片 DOM**，
 *   故它只需把 pointerdown 绑在 card 上即可。
 *   但 A001 的「拖右下角手柄拉伸节点」是在 **canvas 画布层**完成的 ——
 *   pointerdown 根本不会冒泡到 node-body（我们卡片所在的 DOM 子树）里。
 *   实测证据：新建 A001 节点后 node.size = [140, 26]，而面板 DOM 已有 361px 高；
 *   拖手柄只改画布矩形、对 DOM 的 pointerdown 监听毫无触发 →
 *   goLive 永不触发 → 高度模型永不接管 → **整个节点无法自由拉伸**（用户反馈现象）。
 *   修法：再把监听挂到画布容器（app.canvas.canvas.parentElement）的捕获阶段，
 *   并判断事件坐标是否落在本节点的画布矩形内 —— 命中即视为「用户在本节点上操作」。
 */
function bindA001SizeLockGoLive(node) {
    const lock = node?._a001SizeLock;
    const card = lock?.hostEl;
    if (!lock || !card) return;
    /* 先摘旧监听（幂等重绑）。 */
    if (lock.boundCard && lock.goLiveHandler) {
        safeCall(() => lock.boundCard.removeEventListener("pointerdown", lock.goLiveHandler, true),
            undefined, "摘除旧 live 闸门监听（卡片）");
    }
    if (lock.boundCanvas && lock.canvasPointerHandler) {
        safeCall(() => lock.boundCanvas.removeEventListener("pointerdown", lock.canvasPointerHandler, true),
            undefined, "摘除旧 live 闸门监听（画布）");
    }
    const handler = () => {
        safeCall(() => lock.goLive?.(), undefined, "live 闸门");
        /* ★ 接管成功后统一摘除画布层监听：原实现只在「画布监听自身被命中」时才解绑，
         *   若 live 由本卡片路径或 onConnectionsChange 触发，画布监听会长期空跑 ——
         *   与下方注释承诺的「命中并成功接管 → 零后续开销」不符。
         *   unbindA001CanvasGoLive 幂等（无 boundCanvas 时直接返回）。 */
        if (lock.live) safeCall(() => unbindA001CanvasGoLive(node), undefined, "摘除 live 闸门监听（画布）");
    };
    lock.goLiveHandler = handler;
    lock.boundCard = card;
    safeCall(() => card.addEventListener("pointerdown", handler, true), undefined, "绑定 live 闸门监听（卡片）");

    /* ★ 画布层监听：命中本节点矩形即 goLive。 */
    const canvasHost = resolveA001CanvasHost();
    if (canvasHost) {
        const onCanvasPointerDown = (e) => {
            const l = node._a001SizeLock;
            if (!l || l.live) return;          // 已接管 → 监听自身卸载
            if (!a001PointerHitsNode(node, e)) return;
            safeCall(() => l.goLive?.(), undefined, "live 闸门（画布）");
            if (l.live) unbindA001CanvasGoLive(node);   // 命中并成功接管 → 立即解绑，零后续开销
        };
        lock.canvasPointerHandler = onCanvasPointerDown;
        lock.boundCanvas = canvasHost;
        safeCall(() => canvasHost.addEventListener("pointerdown", onCanvasPointerDown, true),
            undefined, "绑定 live 闸门监听（画布）");
    }

    if (!lock.connPatched) {
        lock.connPatched = true;
        const prev = node.onConnectionsChange;
        lock.connPrev = typeof prev === "function" ? prev : null;
        node.onConnectionsChange = function (...args) {
            safeCall(() => lock.goLiveHandler?.(), undefined, "连线变化触发 live 闸门");
            return lock.connPrev ? lock.connPrev.apply(this, args) : undefined;
        };
    }
}

/** 取画布容器（稳定层）。与 A001_Appearance 的 startA001PanelGuard 同口径。 */
function resolveA001CanvasHost() {
    return safeCall(() => {
        const c = app?.canvas?.canvas?.parentElement;
        if (c) return c;
    }, null, "取画布容器（live 闸门）") || null;
}

/** 摘除画布层的 goLive 监听（接管成功 / 释放时调用，幂等）。 */
function unbindA001CanvasGoLive(node) {
    const lock = node?._a001SizeLock;
    if (!lock?.boundCanvas || !lock.canvasPointerHandler) return;
    safeCall(() => lock.boundCanvas.removeEventListener("pointerdown", lock.canvasPointerHandler, true),
        undefined, "摘除 live 闸门监听（画布）");
    lock.boundCanvas = null;
    lock.canvasPointerHandler = null;
}

/**
 * 判断一次画布 pointerdown 是否落在本节点的画布矩形内。
 *
 * 节点矩形来自 litegraph 的 node.pos / node.size（画布逻辑坐标），
 * 指针坐标需先换算到画布逻辑空间：canvas.ds.offset/scale（与 nodeDrag.ts 同手法）。
 * 取不到 ds 时退化用 canvas 元素的 clientRect 做屏幕空间判定，尽量不误判。
 */
function a001PointerHitsNode(node, e) {
    if (!node || !e) return false;
    return !!safeCall(() => {
        const canvas = app?.canvas;
        const [x, y] = node.pos || [];
        const [w, h] = node.size || [];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return false;
        const expected = (v) => Number.isFinite(v) && v > 0;
        if (!expected(w) || !expected(h)) return false;
        const ds = canvas?.ds;
        const canvasEl = canvas?.canvas;
        if (!ds || !canvasEl) return false;
        const rect = canvasEl.getBoundingClientRect?.();
        if (!rect) return false;
        /* 屏幕坐标 → 画布逻辑坐标：与 litegraph 的 canvasToGraph 同口径。 */
        const scale = ds.scale || 1;
        const gx = (e.clientX - rect.left) / scale - (ds.offset?.[0] || 0);
        const gy = (e.clientY - rect.top) / scale - (ds.offset?.[1] || 0);
        /* 放宽 8px 容差：手柄/边框位于矩形边缘，稍微出界也算命中。 */
        const TOL = 8;
        return gx >= x - TOL && gx <= x + w + TOL && gy >= y - TOL && gy <= y + h + TOL;
    }, false, "判定指针是否命中本节点");
}

/** 停止并释放高度模型（节点删除 / 面板释放时调用）。 */
export function stopA001SizeLock(node) {
    const lock = node?._a001SizeLock;
    if (!lock) return;
    /* 清掉稳定采样 / 外部同步的挂起定时器（否则节点已删、回调仍会跑）。 */
    if (lock._settleTimer) {
        clearTimeout(lock._settleTimer);
        lock._settleTimer = 0;
    }
    if (lock._resyncTimer) {
        clearTimeout(lock._resyncTimer);
        lock._resyncTimer = 0;
    }
    /* offset 首采的挂起定时器同样要清（否则节点已删、回调仍会跑）。 */
    if (lock._capTimer) {
        clearTimeout(lock._capTimer);
        lock._capTimer = 0;
    }
    lock._settleDomH = null;
    lock._capDomH = null;
    /* 摘掉 live 闸门监听（卡片 + 画布）、还原 onConnectionsChange
     * （节点对象会被复用，不还原会层层叠加）。 */
    if (lock.boundCard && lock.goLiveHandler) {
        safeCall(() => lock.boundCard.removeEventListener("pointerdown", lock.goLiveHandler, true),
            undefined, "摘除 live 闸门监听（卡片）");
    }
    safeCall(() => unbindA001CanvasGoLive(node), undefined, "摘除 live 闸门监听（画布）");
    if (lock.connPatched) {
        safeCall(() => { node.onConnectionsChange = lock.connPrev || undefined; },
            undefined, "还原 onConnectionsChange");
    }
    /* 还原 computeSize（照抄 stopNativeAutoGrow 的可逆版本；不还原会把钉住的闭包留给复用节点）。 */
    if (lock.computeSizePinned) {
        safeCall(() => { node.computeSize = lock.computeSizePrev || node.computeSize; },
            undefined, "还原 computeSize");
    }
    safeCall(() => lock.ro?.disconnect?.(), undefined, "断开高度模型观察器");
    node._a001SizeLock = null;
    node._a001SyncHeight = null;
}

/**
 * 外部主动同步一次高度（等价于 Custom Stage 的 `anyNode.__comfytvSyncHeight?.()`）。
 *
 * 用途：收起/展开控件、外改尺寸后，**唯一**的同步入口 —— 不再需要任何
 * 「自建记账 / 重采样」旁路，避免多套逻辑互相覆盖。
 * 推迟一帧执行：调用点（如点击收起）当帧 DOM 尚未完成重排，立即 apply 会拿到旧 chrome。
 */
export function resyncA001SizeLock(node) {
    const lock = node?._a001SizeLock;
    if (!lock) return;
    safeCall(() => node._a001SyncHeight?.(), undefined, "高度模型重采样同步");
}

/**
 * 一次「外部同步」：按与 onResize 相同的双判据处理（幂等）。
 *
 * ★★ 为什么必须在 DOM 稳定后跑（实测踩坑，勿删）：
 *   `chromeOf() = host.offsetHeight − 预览框.offsetHeight` 在 DOM 重排**中途**是瞬态值：
 *   用户拉伸后若立刻读，host 与 preview 可能一先一后地变，差值与稳态不一致
 *   （实测稳态 141，瞬态读到 121）→ 被误判成「内容变化」→ 走 apply() 用**旧 wanted**
 *   把用户刚拉出来的尺寸打回去（表现为「收起/展开控件后节点弹回旧高度」）。
 *   故这里在推迟到 DOM 稳定后再判；校正 pass 已稳定，判据才可靠。
 */
function runA001Resync(node, lock) {
    if (!node || !lock || !lock.live) return;
    safeCall(() => refreshA001SizeLockHost(node), undefined, "同步前自愈 host");
    const p = lock.previewEl;
    if (p?.isConnected) {
        const [_, nh] = readSizeLockNodeSize(node);
        const chromeSame = Math.abs((lock.chromeOf?.() ?? -1) - lock.chrome) < A001_SIZE_LOCK_EPS;
        /* chrome 未变、节点高变了 → 用户拉伸 → 采纳新的预览框高度为 wanted。 */
        if (chromeSame && Math.abs(nh - lock.applied) >= A001_SIZE_LOCK_EPS) {
            safeCall(() => lock.sample?.(), undefined, "外部同步→sample（用户拉伸）");
            return;
        }
    }
    safeCall(() => lock.apply?.(), undefined, "高度模型重采样同步");
}

/**
 * 高度变化回调 —— 对齐 Custom Stage bindCardHeight 的 onResize，但**判据加容差**：
 *   · 尚未 live（用户还没操作过）→ 只刷新 chrome 基线，**绝不接管节点高度**；
 *   · chromeOf() 变了            → 内容变化 → apply()（把节点高调到 chrome + wanted）；
 *   · chromeOf() 没变、节点高变了 → 用户拉伸 → sample()（刷新基线）。
 *
 * ★★ 为什么 chromeOf() 的比较必须带容差（关键修复，勿改回 `!==`）：
 *   chromeOf() = host.offsetHeight − preview.offsetHeight，两者都是**整数像素**，
 *   但在「拉伸 / Vue 重排 / 子像素缩放」过程中，host 与 preview 会一先一后地变，
 *   差值是瞬态浮点值。原实现用严格 `!==` 判定「内容变化」→ 每一拍都被判成变化
 *   → 反复 apply → 改 node.size → DOM 再变 → RO 再回调 → **正反馈高频闪**
 *   （实测：节点被持续改写尺寸、尺寸漂成 452.0954… 这类小数）。
 *   改为与 runA001Resync 同口径的「差值 ≥ A001_SIZE_LOCK_EPS 才算变化」，
 *   与其它判据保持一致，打断这个反馈环。
 */
function onA001SizeLockChange(node) {
    const lock = node?._a001SizeLock;
    if (!lock || node._a001PanelDisposed) return;
    if (!lock.laidOut?.()) return;
    if (!lock.live) {
        /* 未 live：只跟住 chrome 基线，不写 node.size（等 goLive 接管）。 */
        lock.chrome = lock.chromeOf?.() ?? -1;
        return;
    }
    const chromeNow = lock.chromeOf?.() ?? -1;
    const chromeChanged = Math.abs(chromeNow - lock.chrome) >= A001_SIZE_LOCK_EPS;
    if (chromeChanged) {
        safeCall(() => lock.apply?.(), undefined, "高度模型 onResize→apply");
    } else if (lock.measurable?.()) {
        const [_, nh] = readSizeLockNodeSize(node);
        if (Math.abs(nh - lock.applied) >= A001_SIZE_LOCK_EPS) {
            safeCall(() => lock.sample?.(), undefined, "高度模型 onResize→sample");
        }
    }
}
