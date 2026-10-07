/* =============================================================================
 * A001_restore.js —— A001 统一恢复中枢（一体化：标记层 + 感知层 + 调度层）
 * -----------------------------------------------------------------------------
 * 一、为什么需要它（本文件要解决的系统性问题）
 * -----------------------------------------------------------------------------
 * A001 的外观功能（端口胶囊 / 连接线端点 / 文本框高度 / 预览框高度 / 收起展开控件）
 * 本质都是「给 Vue 管理的原生 DOM 换皮 + 在节点对象上外部记账」。
 *
 * Vue 在若干时机（执行态切换、setSize、touchInputs、切图、进出子图、刷新）会重建
 * 节点 DOM，于是我们打上去的类名 / 属性 / 内联样式**全部丢失**。改造前，五个模块
 * **各自**用「各自的 MutationObserver + 各自的 setInterval 巡检」去补，带来三个结构性
 * 问题（实测确认）：
 *
 *   ① 观察器失聪死锁：A001_port_capsule 的观察器绑在**节点根元素**上；Vue 把节点根
 *      整体替换后，旧观察器永远收不到回调，而「重绑」逻辑本身要靠回调触发 →
 *      无法自救，只能等 1200ms 巡检。这是「闪一下才恢复」的最长空窗来源。
 *
 *   ② 恢复链无协调：一次「收起控件」点击会并发触发 5 条恢复链（nudge 脉冲 60ms 后
 *      施加 / reposition 同帧 / refreshPorts 同帧+双 rAF / resync 同帧 apply→setSize
 *      →onResize→又一轮 rAF / persist），时间窗重叠但互不知情 → 同一帧反复
 *      collectClusters / syncSlotPosFromDom / setSize，把空窗放大成可感知的闪动。
 *
 *   ③ 无谓写入引发互激：文本框模块每 1200ms 无条件给网格补类名、写内联 display；
 *      端口胶囊巡检每拍重算中心线并写 inline style —— 这些写入本身会唤起**其它**
 *      模块的 MutationObserver，形成跨模块的低速循环。
 *      拖动节点时尤其明显：位置每帧变 → 中心线每拍重算 → 取整抖动 1px → 写 style
 *      → 观察器唤醒 → 再算 —— 表现为「移动节点时展开控件一闪一闪」。
 *
 * 本模块把上述三者收口为一套机制：
 *
 *   标记层：节点级单一状态属性 data-a001-state（JSON），面板/节点根重建后由本层补回。
 *   感知层：**单一** MutationObserver，绑在「画布稳定层」（不会随节点重建而失聪），
 *           按 data-node-id 过滤出受影响的 A001 节点。
 *   调度层：单一 rAF 队列，把同一帧内来自各方的恢复请求**合并去重**，按
 *           「快(同帧) → 中(双 rAF) → 慢(200ms 快档 / 1200ms 兜底)」三层有序执行。
 *
 * 二、设计约束（务必遵守）
 * -----------------------------------------------------------------------------
 * · 本模块**不反向 import** 任何 A001 私有模块（避免 ESM 环 + TDZ 崩溃）。
 *   恢复动作由各模块通过 initA001Restore({ handlers }) 注册回调，本模块只负责调度。
 * · 本模块处于依赖图底层，只 import A001_shared.js。
 * · 所有对外入口幂等；任何异常走 safeCall 降级，绝不打断调用方。
 * · 注释中禁止出现反引号（本项目血泪教训：模板字符串内反引号会提前闭合字符串，
 *   导致整个模块求值失败、扩展静默不注册）。
 * ========================================================================== */

import { safeCall, alog } from "./A001_shared.js?v=20261007a";

/* ---------------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------------- */
/** 节点级单一状态属性名：承载全部「换皮标记」的快照（JSON）。
 *  ★ 为什么收敛为一个属性：改造前面板上的 data-a001-collapsed / data-a001-height
 *    与节点根上的类名分散在多处，任何一处随元素重建丢失都无人统一补回。
 *    收敛后只需「一处写入、一处校验、一处补回」。 */
const STATE_ATTR = "data-a001-state";

/** 快档巡检间隔（发现异常后，下拍切到快档尽快续上）。 */
const FAST_MS = 200;
/** 兜底巡检间隔（全健康时的低频扫描；也是后台标签页下 rAF 暂停时的最后保障）。 */
const SLOW_MS = 1200;

/** 恢复层级：同帧 → 双 rAF → 延迟。数字越小越先执行。 */
const TIER_SYNC = 0;
const TIER_RAF = 1;
const TIER_LATE = 2;

/* ---------------------------------------------------------------------------
 * 模块级状态
 * ------------------------------------------------------------------------- */

/** 受管节点集合（节点在图中且已装配 A001 外观）。 */
const NODES = new Set();

/** 待恢复请求：node → Map<tier, Set<taskName>>。同一帧内同 tier 同任务只执行一次。 */
const _pending = new Map();

/** rAF 句柄（单一队列；不存在则说明当前没有待执行任务）。 */
let _flushRaf = 0;
/** 延迟档的定时器句柄。 */
let _lateTimer = 0;

/** 单一 MutationObserver（绑画布稳定层）。 */
let _mo = null;
let _moTarget = null;

/** 巡检定时器与当前间隔。 */
let _beatTimer = 0;
let _beatMs = 0;

/** 各模块注册的恢复任务表： taskName → (node) => void */
const _tasks = new Map();

/** 是否已初始化（幂等）。 */
let _inited = false;

/* ---------------------------------------------------------------------------
 * 依赖注入（由 A001_SubgraphNode.js 在 queueMicrotask 中调用）
 * ------------------------------------------------------------------------- */

/**
 * 注册各模块的恢复任务。
 *
 * @param {object} handlers 形如：
 *   {
 *     capsule:  (node) => void,   // 端口胶囊：补类名 + 重绑 hover + 重写锚点
 *     slotPos:  (node) => void,   // 连接线端点：同 syncSlotPosFromDom
 *     textarea: (node) => void,   // 文本框：补类名 + 读回高度 + 挂 RO
 *     panel:    (node) => void,   // 面板：补挂 / 校正位置 / 补标记
 *     height:   (node) => void,   // 高度模型：补 data-a001-height + 收敛
 *     hiddenCls:(node) => void,   // 收起标记：补 data-a001-collapsed + 网格 display
 *   }
 *   未注册的任务在调度时自动跳过（降级安全）。
 */
export function initA001Restore(handlers) {
    if (!handlers || typeof handlers !== "object") return false;
    for (const k of Object.keys(handlers)) {
        if (typeof handlers[k] === "function") _tasks.set(k, handlers[k]);
    }
    return true;
}

/* ---------------------------------------------------------------------------
 * 节点级状态属性（标记层）
 * ------------------------------------------------------------------------- */

/** 读节点上承载的换皮状态快照（缺省返回空对象）。 */
export function readA001UiState(node) {
    return safeCall(() => {
        const raw = node?.getAttribute?.(STATE_ATTR)
            || node?.querySelector?.("[data-a001-state]")?.getAttribute(STATE_ATTR);
        if (!raw) return {};
        const v = JSON.parse(raw);
        return v && typeof v === "object" ? v : {};
    }, {}, "读 A001 UI 状态快照");
}

/**
 * 把换皮状态快照写到「承载元素」上。
 *
 * ★ 承载元素的选择（实测踩坑，勿改）：
 *   优先写「我们的面板」（.xzg-a001-panel，Vue 不碰它的 class/属性，稳定）；
 *   面板不存在时退回节点根（节点根类名会被 Vue 重写，属性一般保留）。
 *   两处都写一次，读时任一命中即可 —— 面板重建、节点根重建都能兜住。
 */
export function writeA001UiState(node, patch) {
    if (!node || !patch || typeof patch !== "object") return false;
    return !!safeCall(() => {
        const panel = node._a001Panel;
        const root = node._a001DomRoot?.isConnected
            ? node._a001DomRoot
            : (node.id != null ? document.querySelector(`[data-node-id="${node.id}"]`) : null);
        /* 只读不写：原实现用「先写一次、再合并写第二次」的方式取值，
         *  同一份 JSON 要对 root 连写两遍（panel 亦同）。改为纯读取基线。 */
        const read = (el) => {
            const raw = el?.getAttribute?.(STATE_ATTR);
            if (!raw) return null;
            try { return JSON.parse(raw) || {}; } catch (_e) { return {}; }
        };
        /* 基线：根上的现有快照 → 面板上的 → 空；合并 patch 后两处各写一次。 */
        const base = read(root) || read(panel) || {};
        const finalObj = Object.assign({}, base, patch);
        const json = JSON.stringify(finalObj);
        if (root?.setAttribute) root.setAttribute(STATE_ATTR, json);
        if (panel?.setAttribute) panel.setAttribute(STATE_ATTR, json);
        return true;
    }, false, "写 A001 UI 状态快照");
}

/* ---------------------------------------------------------------------------
 * 恢复调度（调度层）
 * ------------------------------------------------------------------------- */

/**
 * 请求恢复某节点的某些任务。
 *
 * 同一帧内对 (node, tier, task) 去重；不同 tier 分别入队，
 * 由 flush 按 tier 从小到大有序执行（快档先跑，慢档兜底）。
 *
 * @param {object} node A001 节点
 * @param {string|string[]} tasks 任务名（须已在 initA001Restore 注册）
 * @param {number} [tier] 层级，默认 TIER_SYNC
 */
export function requestA001Restore(node, tasks, tier) {
    if (!node || typeof node.id === "undefined") return;
    const list = Array.isArray(tasks) ? tasks : [tasks];
    const t = Number.isFinite(tier) ? tier : TIER_SYNC;
    return !!safeCall(() => {
        let byTier = _pending.get(node);
        if (!byTier) { byTier = new Map(); _pending.set(node, byTier); }
        let set = byTier.get(t);
        if (!set) { set = new Set(); byTier.set(t, set); }
        for (const name of list) if (name) set.add(name);
        _scheduleFlush(t);
        return true;
    }, false, "请求 A001 恢复");
}

/** 按 tier 排程 flush：同帧档走 rAF，延迟档走 setTimeout。 */
function _scheduleFlush(tier) {
    if (tier === TIER_LATE) {
        if (_lateTimer) return;
        _lateTimer = setTimeout(() => {
            _lateTimer = 0;
            _flush();
        }, 200);
        return;
    }
    if (_flushRaf) return;
    if (typeof requestAnimationFrame === "function") {
        _flushRaf = requestAnimationFrame(() => {
            _flushRaf = 0;
            _flush();
            /* 中档（双 rAF）：紧接一帧再跑一次，覆盖「Vue 在本帧异步 patch」的情况。 */
            if (typeof requestAnimationFrame === "function") {
                _flushRaf = requestAnimationFrame(() => {
                    _flushRaf = 0;
                    _flush();
                });
            }
        });
    } else {
        _flushRaf = setTimeout(() => { _flushRaf = 0; _flush(); }, 16);
    }
}

/** 执行队列：按 tier 升序，逐节点跑该节点待办的各任务（任务内自带幂等）。 */
function _flush() {
    if (!_pending.size) return;
    const snapshot = Array.from(_pending.entries());
    _pending.clear();
    for (const [node, byTier] of snapshot) {
        /* 节点已不在图中 → 丢弃（等巡检清理）。 */
        const g = node.graph;
        if (!g || !(g._nodes || []).includes(node)) continue;
        const tiers = Array.from(byTier.keys()).sort((a, b) => a - b);
        for (const tier of tiers) {
            const names = byTier.get(tier);
            for (const name of names) {
                const fn = _tasks.get(name);
                if (typeof fn !== "function") continue;
                safeCall(() => fn(node), undefined, `恢复任务:${name}`);
            }
        }
    }
}

/* ---------------------------------------------------------------------------
 * 感知层：单一 MutationObserver（绑画布稳定层）
 * ------------------------------------------------------------------------- */

/** 取画布稳定层（不会随节点重建而失聪）。与 A001_Appearance 的面板守卫同口径。 */
function _canvasHost() {
    return safeCall(() => {
        const c = window?.app?.canvas?.canvas?.parentElement;
        if (c) return c;
        return document.body;
    }, null, "取画布稳定层");
}

/** 起观察器（幂等；目标失效时自动重绑）。 */
function _ensureObserver() {
    const target = _canvasHost();
    if (!target) return;
    if (_mo && _moTarget === target && _moTarget.isConnected) return;
    safeCall(() => {
        if (_mo) _mo.disconnect();
        _mo = new MutationObserver((mutations) => {
            /* ★ 只挑出「可能影响 A001 外观」的变更，避免画布全量变动都触发重算。 */
            let touched = null;
            for (const m of mutations) {
                const el = m.target?.closest?.("[data-node-id]") || m.target?.parentElement?.closest?.("[data-node-id]");
                const id = el?.getAttribute?.("data-node-id");
                if (!id) continue;
                if (!touched) touched = new Set();
                touched.add(String(id));
            }
            if (!touched) return;
            for (const node of NODES) {
                if (!touched.has(String(node.id))) continue;
                /* 交给巡检判据决定是否真的要恢复（避免无谓重建）。 */
                _evaluateNode(node);
            }
        });
        _moTarget = target;
        _mo.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    }, undefined, "起统一观察器");
}

/* ---------------------------------------------------------------------------
 * 进出子图 → 主动重挂滑条
 * ------------------------------------------------------------------------- */

/** 是否已绑定画布图切换监听（幂等）。 */
let _graphSwitchWatched = false;

/**
 * 绑定「进出子图」事件，主动重挂滑条。
 *
 * 【为什么需要】进出子图时 Vue 会整体重建节点 DOM，A001 自绘的滑条
 *   （轨道/填充/滑块 + data-a001-slider 标记）随旧元素一起销毁。若仅靠巡检兜底，
 *   要等慢档周期（1200ms）且受「其它恢复项」前置条件阻塞，用户会看到滑条「消失」。
 *   官方在进出子图时派发 canvas 事件（实现在 LiteGraph canvas 上）：
 *     · subgraph-opened            —— 进入子图
 *     · litegraph:set-graph        —— 切换画布图（进入/退出都触发）
 *   这里监听二者，事件后短暂延迟（等 Vue 完成 DOM patch）再对全部受管节点
 *   主动重挂滑条，使滑条即时恢复，不依赖巡检。
 *
 * 【幂等】只绑一次；绑定的 canvas 元素变化时会自动重绑。
 */
function _ensureGraphSwitchWatch() {
    const canvas = safeCall(() => window?.app?.canvas?.canvas, null, "取画布元素");
    if (!canvas || typeof canvas.addEventListener !== "function") return;
    /* ★ 目标 canvas 未变 → 幂等返回；变了 → 先摘掉旧元素上的两个监听再重绑。
     *   原实现只判断 _graphSwitchWatched 就直接 return，而上面的注释写着
     *   「绑定的 canvas 元素变化时会自动重绑」—— 实际并不存在重绑路径：
     *   画布元素一旦被整体替换，subgraph-opened / litegraph:set-graph 永久失聪，
     *   主动重挂滑条退化为慢档巡检（用户看到滑条「消失」）。 */
    if (_graphSwitchWatched && _canvasElWatched === canvas) return;
    if (_canvasElWatched && _graphSwitchHandler) {
        safeCall(() => {
            _canvasElWatched.removeEventListener("subgraph-opened", _graphSwitchHandler);
            _canvasElWatched.removeEventListener("litegraph:set-graph", _graphSwitchHandler);
        }, undefined, "解绑旧画布图切换监听");
    }
    _graphSwitchWatched = true;
    _canvasElWatched = canvas;
    const onSwitch = () => {
        /* 等 Vue 重建 DOM 完成（双 rAF + 一个延迟档），再重挂滑条。 */
        safeCall(() => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                for (const node of NODES) {
                    if (!node) continue;
                    const g = node.graph;
                    if (!g || !(g._nodes || []).includes(node)) continue;
                    requestA001Restore(node, ["slider"], TIER_LATE);
                }
            }));
        }, undefined, "进出子图重挂滑条排程");
    };
    safeCall(() => {
        canvas.addEventListener("subgraph-opened", onSwitch);
        canvas.addEventListener("litegraph:set-graph", onSwitch);
    }, undefined, "绑定画布图切换监听");
    _graphSwitchHandler = onSwitch;
}

/** 已绑定监听画布的 canvas 元素（用于目标变化时重绑）。 */
let _canvasElWatched = null;
let _graphSwitchHandler = null;

/* ---------------------------------------------------------------------------
 * 巡检 / 判据
 * ------------------------------------------------------------------------- */

/**
 * 评估单个节点是否需要恢复；需要则按任务请求（默认同帧档）。
 *
 * ★ 判据必须「先读后写」：只在确实丢失时才请求恢复，
 *   全健康时零写入 —— 这是消除「跨模块互激 / 移动节点闪动」的关键。
 */
function _evaluateNode(node) {
    if (!node?._a001PortCapsuleOn && !node?._a001Panel) return;
    const root = safeCall(() => {
        const cached = node._a001DomRoot;
        if (cached?.isConnected) return cached;
        return node.id != null ? document.querySelector(`[data-node-id="${node.id}"]`) : null;
    }, null, "找节点根");
    if (!root) return;

    const need = [];
    /* ① 端口胶囊：节点根类名 + 桶元素 + 观察器根一致 */
    if (node._a001PortCapsuleOn) {
        const lostCap = !root.classList.contains("xzg-a001-node") || !root.querySelector(".xzg-a001-cap");
        if (lostCap) { need.push("capsule"); need.push("slotPos"); }
    }
    /* ② 面板：存在性 + 归属 + 顺序 */
    if (node._a001Panel && (!node._a001Panel.isConnected || !root.contains(node._a001Panel))) {
        need.push("panel");
    }
    /* ③ 换皮状态快照：面板/节点根上任一处存在即可 */
    const panel = node._a001Panel;
    if (panel?.isConnected && !root.hasAttribute(STATE_ATTR) && !panel.hasAttribute(STATE_ATTR)) {
        need.push("height");
        need.push("hiddenCls");
        need.push("textarea");
    }
    /* ③b 文本框接线独立判据（不依赖状态快照）：Vue 重建 textarea 元素后，
     *    新建的 textarea 上没有 a001HeightObserved 标记 → 存档高度与拖拽监听都会丢。
     *    这正是原先文本框模块「各自 1200ms 巡检」要兜的场景；现由本中枢统一兜。
     *    注：本模块作用域类名与端口胶囊同为 xzg-a001-node，故只用 textarea 上的
     *    接线标记判定，避免与胶囊类名混淆。 */
    else if (panel?.isConnected) {
        const ta = root.querySelector("textarea");
        if (ta && !ta.dataset.a001HeightObserved) need.push("textarea");
    }
    /* ④ 收起态：面板标记与实际开关不一致 */
    if (panel?.isConnected && node._a001WidgetsHidden) {
        if (!panel.hasAttribute("data-a001-collapsed")) { need.push("hiddenCls"); }
    }
    /* ⑤ 滑条：提升的数值控件行在 Vue 重建后，我们自绘的「轨道/填充/滑块」会随旧元素
     *    一起销毁（标记与子元素都在官方控件行内）。判据：行内有数值 input，但其
     *    滑条容器还没有 data-a001-slider 标记 → 需要（重新）上妆。
     *    注：本中枢不 import A001_slider.js（架构约定：只依赖 A001_shared），
     *    故此处只用 DOM 标记做「是否需要」的门槛判断，具体上妆由任务回调完成。 */
    if (panel?.isConnected && !need.length) {
        const rows = root.querySelectorAll(".lg-node-widget");
        for (const row of rows) {
            if (!row.querySelector("input")) continue;
            if (row.querySelector("[data-a001-slider]")) continue;
            /* 该行有 input 但没有滑条容器 → 可能是「本应上滑条但丢了」。
             * 无 min/max 的控件（如 seed / combo）也会命中这里，但任务回调内部
             * 会再次用判据过滤（不符合则零副作用），故这里放宽不漏。 */
            need.push("slider");
            break;
        }
    }
    if (!need.length) return;
    requestA001Restore(node, need, TIER_SYNC);
}

/**
 * 拍一次巡检（兜底通道；rAF 在后台标签会被暂停，故必须保留定时器）。
 * 自适应：本拍发现异常 → 下拍切快档；全健康 → 回慢档。
 */
function _beat() {
    _ensureObserver();
    let unhealthy = false;
    for (const node of Array.from(NODES)) {
        const g = node.graph;
        const inGraph = !!g && (g._nodes || []).includes(node);
        if (!inGraph) {
            /* 与端口胶囊同口径：不立即摘除，给撤销/切图留宽限。 */
            if (!node._a001RestoreOrphanSince) node._a001RestoreOrphanSince = Date.now();
            if (Date.now() - node._a001RestoreOrphanSince > 8000) NODES.delete(node);
            continue;
        }
        node._a001RestoreOrphanSince = 0;
        /* ★★ 子图身份守护（每拍必查，不参与「UI 缺失」判据）：
         *  官方「进入子图」入口由 Vue NodeFooter 以 `!!node.isSubgraphNode()` 判定，
         *  而 A001 的 isSubgraphNode() 只答 `!!this.subgraph`。故只要 node.subgraph
         *  丢失（复制粘贴/反序列化的时序竞态、createSubgraph 失败等），入口、
         *  面包屑、执行展开会一并消失，且不会触发任何 UI 级缺失判据。
         *  这里作为兜底通道无条件补建，使系统可自愈（幂等：已建好立即返回）。 */
        const guard = _tasks.get("subgraph");
        if (guard) safeCall(() => guard(node), undefined, "恢复:子图身份");
        /* 后台标签页：保留廉价的离图清理与子图身份自愈，跳过 UI 缺失评估与恢复动作
         * （恢复动作是 DOM 级操作，后台无人可见，切回前台后下一拍立即补上）。 */
        if (document.hidden) continue;
        const before = _pending.size;
        _evaluateNode(node);
        if (_pending.size > before) unhealthy = true;
    }
    if (!NODES.size) {
        if (_beatTimer) { clearInterval(_beatTimer); _beatTimer = 0; }
        return;
    }
    _ensureBeat(unhealthy ? FAST_MS : SLOW_MS);
}

function _ensureBeat(ms) {
    if (_beatTimer && _beatMs === ms) return;
    if (_beatTimer) clearInterval(_beatTimer);
    _beatMs = ms;
    _beatTimer = setInterval(_beat, ms);
}

/* ---------------------------------------------------------------------------
 * 对外主入口
 * ------------------------------------------------------------------------- */

/** 登记一个受管节点（幂等）。各模块装配完成后调用。 */
export function registerA001Node(node) {
    if (!node || typeof node.id === "undefined") return false;
    NODES.add(node);
    _ensureObserver();
    /* 进出子图时主动重挂滑条（不依赖慢档巡检）。 */
    _ensureGraphSwitchWatch();
    if (!_inited) { _inited = true; alog("[A001_restore] 统一恢复中枢已启用"); }
    _ensureBeat(SLOW_MS);
    return true;
}

/** 注销（节点删除时调用）。 */
export function unregisterA001Node(node) {
    if (!node) return false;
    NODES.delete(node);
    _pending.delete(node);
    return true;
}

/** 立即对某节点做一次完整评估 + 恢复（供外部在已知变更后主动调用）。 */
export function kickA001Restore(node) {
    if (!node) return false;
    _ensureObserver();
    _evaluateNode(node);
    return true;
}
