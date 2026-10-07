// ═══════════════════════════════════════════════════════════════
//  A001_子图节点 · 收起状态与尺寸簇（拆分自 A001_SubgraphNode.js）
//
//  职责：
//    · 「收起/展开控件」状态的持久化与恢复（properties.a001_widgets_hidden）
//    · 节点尺寸读写（readA001NodeSize）与新建默认宽度落地（applyA001DefaultSize）
//    · 收起标记的 DOM 同步（syncA001HiddenClass）与端口刷新联动
//
//  ⚠️ 行为保持约束：本文件内的实现与原 A001_SubgraphNode.js 中同名成员**逐字一致**。
//     本簇涉及「刷新页面 / 重开工作流 / 撤销重做」三条状态恢复路径，
//     已被用户多次反馈调优（注释中记录了多轮血泪教训），搬迁**严禁**改动判据与时机。
//
//  依赖方向：依赖 A001_shared.js（A001 唯一共享层，底层工具）
//            + 由入口注入的外观/胶囊/滑条能力（避免与入口形成循环依赖）。
// ═══════════════════════════════════════════════════════════════

import {
    NODE_TYPE,
    alog,
    safeCall,
    dirtyCanvas,
    /* 静默版（与既有 A001_shared 的带日志版并存，编码历史差异，勿"统一"）。 */
    isNodeInGraphSilent as isNodeInGraph,
    getNodeGraphSilent as getNodeGraph,
    A001_PROMOTED_SIZE_EPS,
    A001_DEFAULT_WIDTH,
    A001_HIDDEN_PROP,
    A001_DEFAULT_COLLAPSED,
} from "./A001_shared.js?v=20261007a";

/* ════════════════════════════════════════════════
 *  跨簇依赖注入（与 initAppearanceDeps / initSlotDeps 同一范式）
 * ════════════════════════════════════════════════ */

let _deps = {
    refreshA001PortCapsule: null,
    nudgeA001PortCapsule: null,
    resyncA001SizeLock: null,
    refreshA001Sliders: null,
    repositionA001Panel: null,
    suppressA001CapsuleOpen: null,
    refreshA001PromptEditors: null,
    touchA001Inputs: null,
};

/** 由 A001_SubgraphNode.js 注入外观/胶囊/滑条能力（幂等）。 */
export function initHiddenDeps(deps) {
    if (!deps) return;
    _deps = Object.assign(_deps, deps);
}

/** 收起态 CSS 类名在本文件下方随原文一并定义（原 A001_SubgraphNode.js 的 const 声明）。 */

/**
 * ★ 安全读取节点尺寸 [w, h]。
 *
 * 坑：`node.size` 在 ComfyUI 前端是 **Vue 响应式 Proxy**，
 * `Array.isArray(node.size)` 对它返回 **false**（Proxy 不是真 Array），
 * 于是旧代码 `Array.isArray(node.size) ? node.size[0] : 0` 一律取到 0，
 * 再把 0 当尺寸喂给 setSize —— 官方随即用最小尺寸兜底，
 * 表现为「点击隐藏后节点缩成默认尺寸」。实测证据：
 *   隐藏前 size 实为 [523.81, 702.77]，旧代码读到 [0, 0]。
 * 因此这里改为「按索引直读 + 数值校验」，不依赖 isArray。
 */
function readA001NodeSize(node) {
    if (!node || node.size == null) return [0, 0];
    const raw = node.size;
    const w = Number(raw[0] ?? raw["0"]);
    const h = Number(raw[1] ?? raw["1"]);
    return [Number.isFinite(w) ? w : 0, Number.isFinite(h) ? h : 0];
}

/**
 * ★ 给「新建」的 A001 子图节点落地默认宽度 250（高度交给官方 computeSize()）。
 *
 * 为什么要等一帧：`onNodeCreated` 触发时官方还没跑完尺寸初始化
 * （`computeSize()` 的固有尺寸、最小尺寸保护都在其后），此刻 setSize 会被覆盖。
 * 延后到下一帧、且**只在节点还没被反序列化改造过**时落地，既保证生效，
 * 又不会污染从工作流读出来的节点。
 *
 * 判定「是不是新节点」的三种情况：
 *   1. 从节点库新建 —— 无 `_a001Deserialized`、无 `subgraph_data_json` → 落地
 *   2. 从工作流加载 —— `configure` 已置 `_a001Deserialized` → 跳过
 *   3. 复制粘贴 —— 带上 `subgraph_data_json` → 跳过（保留用户复制时的尺寸）
 * 另加 `_a001DefaultSizeApplied` 做幂等，避免重复 setSize。
 *
 * ★★ 为什么必须靠 `_a001Deserialized`、不能只看 `subgraph_data_json`（血泪踩坑）：
 *   官方反序列化顺序是 **`onNodeCreated` → `configure`**（nodeCreated 扩展钩子在
 *   节点构造函数末尾触发，见 docs/子图提升机制调研.md:2117-2144 官方原文摘录）。
 *   即 `onNodeCreated` 触发时 `node.properties` **还是空的**，`subgraph_data_json`
 *   尚未写入 —— 此时用 properties 判「是否存档节点」形同虚设，会把从工作流加载的
 *   节点误判成新建节点。本函数的落地闭包又排在 rAF（晚于 configure），
 *   于是 configure 刚恢复好的 `node.size` 又被本函数覆盖成 250，
 *   表现为「刷新 / 切换工作流后节点宽度恢复成默认」。
 *
 * 高度处理：上一版会强制高度 350，现改为**只改宽度**，高度原样保留
 * （`setSize([250, h])` 里的 h 仍是官方算出的固有高度），
 * 从而不与「预览框最小高度 200」互相打架。
 *
 * @param {LGraphNode} node A001 子图节点
 */
function applyA001DefaultSize(node) {
    if (!node || node._a001DefaultSizeApplied) return;
    node._a001DefaultSizeApplied = true;
    if (node.properties?.subgraph_data_json) return;
    const land = () => {
        if (!isNodeInGraph(node)) return;
        /* ★ 落地闭包必须【复查】存档标记：本函数首行的判定跑在 configure 之前，
         *  而此处跑在 configure 之后（rAF），这才是唯一可靠的判据。 */
        if (node._a001Deserialized) return;
        if (node.properties?.subgraph_data_json) return;
        const [w, h] = readA001NodeSize(node);
        if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h)) return;
        /* 隐藏态自持尺寸，别和它抢。 */
        if (node._a001WidgetsHidden) return;
        /* ★ 宽度若已不同于官方初值，说明用户调过（或存档已恢复），一律不覆盖。
         *  官方初值即 A001_DEFAULT_WIDTH，只有「从未动过尺寸」的新节点才落地。 */
        if (Math.abs(w - A001_DEFAULT_WIDTH) <= A001_PROMOTED_SIZE_EPS) return;
        safeCall(() => node.setSize?.([A001_DEFAULT_WIDTH, h]), undefined, "新建默认宽度");
        dirtyCanvas(node);
        alog("新建默认宽度 |", A001_DEFAULT_WIDTH, "x", h);
    };
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        safeCall(() => window.requestAnimationFrame(() => safeCall(land, undefined, "新建默认宽度落地")),
            undefined, "新建默认宽度排程");
    } else {
        safeCall(land, undefined, "新建默认宽度（同帧）");
    }
}

/* ══════════════════════════════════════════════
 *  「收起控件」状态的持久化（存档键 + 读写）
 *
 *  需求：只有用户**点击按键**时才改变状态，其余任何时候都保持住 ——
 *  包括刷新页面、重开工作流、撤销/重做（节点对象被复用）。
 *
 *  实现：只把布尔开关写进 `node.properties`（litegraph 会随工作流一起序列化），
 *  加载时读回并重新打上 CSS 类。
 *
 *  ★ 本轮重构：不再存「尺寸记账」（_a001HiddenRestore / widgetsH 一并删除）——
 *    因为高度已由 A001_Appearance 的 bindCardHeight 模型统一掌管：
 *    收起 = 控件网格 CSS 隐藏（chrome 变小）→ apply() 自动调节点高；
 *    展开 = 反向。**高度本身由 litegraph 随 node.size 一起保存**，无需任何旁路记账。
 *
 *  ⚠️ 读回时机有坑：官方反序列化顺序是 `onNodeCreated → configure`，
 *     而 `node.properties` 是在 configure **之后**才被还原的，因此不能在
 *     configure 钩子里直接读 —— 必须排到双 rAF 之后再读（见 scheduleA001HiddenRestore）。
 *
 *  没有存档键时：
 *  · 新建节点 → 应用「初始默认收起」（见 A001_DEFAULT_COLLAPSED）——
 *    该默认值**只属于新建节点**，由 restoreA001HiddenState 落地时按
 *    「非反序列化节点」判定后写入，不靠构造期兜底；
 *  · 旧存档 / 撤销重做 / 节点对象复用 → 一律「保持现状」，绝不被强行改写。
 *  ══════════════════════════════════════════════ */
/* A001_HIDDEN_PROP / A001_DEFAULT_COLLAPSED 位于 A001_shared.js（本文件顶部 import）。 */

/** 把当前收起开关写进 properties（只在用户点击导致状态变化时调用）。 */
function persistA001HiddenState(node) {
    return safeCall(() => {
        if (!node) return false;
        if (!node.properties || typeof node.properties !== "object") node.properties = {};
        node.properties[A001_HIDDEN_PROP] = !!node._a001WidgetsHidden;
        return true;
    }, false, "持久化控件收起状态");
}

/**
 * 从 properties 读回收起状态（幂等）。
 * 只改「状态 + DOM 类名」，**不动节点尺寸** —— 尺寸由 litegraph 原样恢复。
 */
export function restoreA001HiddenState(node) {
    return safeCall(() => {
        if (!node || !isNodeInGraph(node)) return false;
        const props = (node.properties && typeof node.properties === "object") ? node.properties : {};
        /* ── 分支 A：存档里**确实存在**该键 → 按存档值恢复。 ──
         *  撤销/重做、节点对象复用、工作流加载等路径都走这里，一律以存档为准。 */
        const hasSavedKey = Object.prototype.hasOwnProperty.call(props, A001_HIDDEN_PROP);
        /* ── 分支 B：**无存档键** → 只在「新建节点」时应用默认收起。 ──
         *  ★ 判据 `_a001Deserialized`：官方反序列化顺序为 `onNodeCreated → configure`，
         *    本函数排到双 rAF 之后才执行，此时 configure 早已置位该标记。故：
         *      · 工作流加载 / 复制粘贴 → _a001Deserialized=true → 保持现状（展开），
         *        绝不把旧存档「无键」的节点强行改成收起，与既有存档表现一致；
         *      · 从节点库新建 → 无标记 → 应用 A001_DEFAULT_COLLAPSED（默认收起）。
         *  另加 `_a001WidgetsHidden === undefined` 兜底：状态已被别处显式设定过
         *  （如撤销/重做复用节点、用户已点过按键）则不再覆盖，尊重现状。 */
        let hidden;
        let fromDefault = false;
        if (hasSavedKey) {
            hidden = props[A001_HIDDEN_PROP] === true;
        } else if (!node._a001Deserialized && node._a001WidgetsHidden === undefined) {
            hidden = A001_DEFAULT_COLLAPSED;
            fromDefault = true;
        } else {
            return false;
        }
        /* ★ 按最终状态同步 DOM 类名：Vue 刚重建的节点根也必须被重新打上类名，
         *  否则收起态会「看起来展开了」。 */
        node._a001WidgetsHidden = hidden;
        /* ★★ 先抑制端口胶囊展开（在切换布局之前）。
         *  为什么必须在这里、且必须在布局变动之前：
         *    控件展开会让网格从 0 长到整块高，把「端口桶」推着移动；若指针恰停在
         *    桶将经过的位置，浏览器会补发 pointerenter → 胶囊莫名跟着展开
         *    （用户反馈：「展开控件 端口胶囊也有时跟着展开」）。
         *    抑制窗口覆盖整个展开过渡（.12s）+ 官方重测 + 收尾，默认 320ms。
         *    这道显式抑制与 A001_port_capsule 内的「幻影 hover 过滤」互为双保险。 */
        safeCall(() => _deps.suppressA001CapsuleOpen(node), undefined, "抑制存档恢复时的胶囊展开");
        syncA001HiddenClass(node);
        _deps.touchA001Inputs(node);          // 敲 inputs 触发 Vue 重算控件行
        dirtyCanvas(node);
        /* ★ 默认收起是「初始状态」而非用户操作：同步写盘一次，让后续保存 / 复制粘贴
         *  都带上显式键，避免「新建时收起、保存后又按无键默认值翻回展开」的歧义。 */
        if (fromDefault) safeCall(() => persistA001HiddenState(node), undefined, "写入默认收起状态");
        /* 按键图标/tooltip 此时画的是「显示态」，必须回填一次（出口由外观模块挂在节点上）。 */
        safeCall(() => node._a001SyncHideBtn?.(), undefined, "刷新收起按键状态");
        alog(
            fromDefault ? "新建节点：已应用默认「控件收起」态"
                : (hidden ? "已按存档恢复为「控件收起」态" : "已按存档恢复为「控件展开」态")
        );
        return true;
    }, false, "恢复控件收起状态");
}

/** 排一次「读回存档状态」——保证 properties 已被官方反序列化还原。
 *
 * ★★ 为什么不能只用双 rAF（实测踩坑，勿改回）：
 *   官方反序列化顺序是 onNodeCreated → configure，而 `node.properties` 在 configure
 *   **之后**才被还原，故必须推迟读取。原实现只排双 rAF，但**浏览器在标签页不可见
 *   （后台标签 / 窗口未激活 / 自动化环境）时会暂停 rAF** → 回调永不执行 →
 *   收起状态永远恢复不了（用户反馈「收起控件无法持久化」的直接成因）。
 *   故改为「双 rAF + setTimeout 兜底」双通道，谁先到谁执行（restore 幂等，重复无害）。 */
function scheduleA001HiddenRestore(node) {
    if (!node || node._a001HiddenRestoreScheduled) return;
    node._a001HiddenRestoreScheduled = true;
    const done = () => { node._a001HiddenRestoreScheduled = false; };
    const run = () => {
        done();
        restoreA001HiddenState(node);
    };
    /* 通道一：双 rAF（可见时最贴近「渲染完成后」）。 */
    if (typeof requestAnimationFrame === "function") {
        safeCall(() => requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!node._a001HiddenRestoreScheduled) return;   // setTimeout 已先跑过
            run();
        })), undefined, "隐藏态恢复排程（rAF）");
    }
    /* 通道二：setTimeout 兜底（不受页面可见性影响，保证一定执行）。 */
    safeCall(() => setTimeout(() => {
        if (!node._a001HiddenRestoreScheduled) return;       // rAF 已先跑过
        run();
    }, 48), undefined, "隐藏态恢复排程（setTimeout 兜底）");
}

/**
 * ★ 切换「提升控件」在节点面板上的显隐（状态持久化于 properties）。
 *
 * 官方隐藏机制实证（未压缩源码，取自前端产物 sourcemap）：
 *   · litegraphService.ts —— 官方给控件设隐藏时是双写：
 *       Object.assign(widget.options, { hidden: inputSpec.hidden })
 *       if (inputSpec.hidden !== undefined) widget.hidden = inputSpec.hidden
 *   · LGraphNode.ts `isWidgetVisible()` —— `widget.hidden` 参与可见性判定
 *   · LGraphNode.ts `getLayoutWidgets()` —— `filter(w => !w.hidden)`
 *   · domWidget.ts `isVisible()` —— `!this.hidden && ...`
 *   即：`options.hidden` 供 Nodes 2.0（Vue）判定，`widget.hidden` 供画布层判定。
 *
 * 本节点采用【更彻底且零副作用】的做法：直接从投影层停止产出控件行
 * （见 installA001WidgetProjection 的 widgets getter）。
 * 好处是外层端口槽（input.widget / widgetId 载体）原样保留 —— 不像官方
 * 子图提升那样需要改数据，隐藏只是「渲染层不产出」，随时可无损恢复。
 *
 * @param {LGraphNode} node A001 子图节点
 * @param {boolean} [hide] 省略则取反当前状态
 * @returns {boolean} 切换后的隐藏状态
 */
export function toggleA001WidgetsHidden(node, hide) {
    if (!node) return false;
    const next = typeof hide === "boolean" ? hide : !node._a001WidgetsHidden;
    node._a001WidgetsHidden = next;
    /* ★★ 唯一动作：切 CSS 类（元素保留）+ 触发一次高度同步。
     *
     *  为什么不再需要任何「尺寸记账 / 重采样」旁路（本轮彻底重构）：
     *    高度完全由 A001_Appearance 的 bindCardHeight 模型（绝对值、单入口）掌管 ——
     *    收起只是让「控件网格」在 chrome 里从 h 变成 0（CSS display:none），
     *    chromeOf() 自然减少 h，apply() 自动把节点高调到「新 chrome + wanted」，
     *    预览框 wanted 保持不变。展开时反向亦然。
     *    旧实现自建 _a001HiddenRestore 记账 + commitA001HiddenResize + resync 三路，
     *    与主模型互相覆盖，正是「改这里坏那里、高度始终不对」的根因，故整体删除。
     *
     *  顺序很关键：先切类（DOM 立即可量）→ 再同步（apply 读到的是收起后的 chrome）。 */
    /* ★★ 先抑制端口胶囊展开（必须在布局变动之前）：
     *  控件展开把网格从 0 长到整块高，会推着「端口桶」移动；若指针恰停在桶将经过的
     *  位置，浏览器会补发 pointerenter → 胶囊跟着展开（用户反馈的现象）。
     *  抑制窗口覆盖展开过渡 + 官方重测；与胶囊内的「幻影 hover 过滤」互为双保险。 */
    safeCall(() => _deps.suppressA001CapsuleOpen(node), undefined, "抑制控件显隐时的胶囊展开");
    syncA001HiddenClass(node);
    alog(next ? "已收起控件" : "已展开控件");
    /* ★ 控件行 CSS 隐藏后，网格宿主是「同一元素、高度变化」，不会触发 Vue 重建节点 DOM，
     *  也就没有信号唤起官方的 widgets-grid ResizeObserver；补一次净零脉冲让官方重测槽位。 */
    safeCall(() => _deps.nudgeA001PortCapsule(node), undefined, "控件显隐后触发槽位重测");
    /* ★ 同帧校正面板位置（幂等）：面板必须恒在网格轨道之前。 */
    safeCall(() => _deps.repositionA001Panel(node), undefined, "控件显隐后校正面板位置");
    /* ★ 刷新端口胶囊（同帧 + 双 rAF）：兜住「官方确实重建了槽位 DOM」的路径。 */
    refreshPortsAfterHiddenToggle(node);
    /* ★ 状态变化即写盘：刷新 / 重开工作流后按 properties 原样恢复。 */
    persistA001HiddenState(node);
    /* ★★ 高度同步：唯一入口，且**当帧立即**执行（勿改回「推迟一帧 / 依赖用户交互」）。
     *
     *  为什么必须当帧同步（实测踩坑，勿改回）：
     *    toggle 前若高度模型尚未 live（用户收起时还没点过画布），收起后节点高度会**纹丝不动**——
     *    直到用户点一下画布，ResizeObserver 才回调、模型才接管并突然变矮（观感就是
     *    「点击画布后控件区域又弹出来」）。Custom Stage 没有这个问题：它的收起按键在
     *    卡片内部，pointerdown 必然先命中卡片 → goLive 早已完成，故它的同步从不迟到。
     *    A001 的收起按键在自建面板里，pointerdown 只到面板、到不了画布层闸门，故这里
     *    显式补一次同步：此时 host 的 pointerdown 监听仍在，goLive 会在 apply() 内自动完成
     *    （已 live 则幂等跳过），随后即把节点高调到「新 chrome + wanted」。 */
    safeCall(() => _deps.resyncA001SizeLock(node), undefined, "收起/展开后同步高度");
    /* ★ @文本编辑器：控件整批显隐后必须重挂 ——
     *  隐藏时控件行被 Vue 回收（编辑器 wrap 作为行子元素随之脱离），
     *  显示时行会重建但**不含** wrap；且隐藏态下装配入口是直接跳过的，
     *  故此处不补挂就会「显示控件后编辑器消失且无人修复」。
     *  必须排到双 rAF（等 Vue 重排出新行）再刷，编辑器内部另有重试链兜底。 */
    const raf = typeof window !== "undefined" ? window.requestAnimationFrame : null;
    if (typeof raf === "function") {
        safeCall(() => {
            raf(() => raf(() => {
                if (!isNodeInGraph(node)) return;
                _deps.refreshA001PromptEditors(node);
                /* ★ 控件整批显隐会重建控件行 → 滑条自绘元素一并丢失，同时机补一次。 */
                _deps.refreshA001Sliders(node);
            }));
        }, undefined, "控件显隐后刷新编辑器排程");
    }
    return next;
}

/**
 * 控件显隐后刷新端口胶囊（同帧 + 双 rAF 各一次，幂等）。
 *
 * ★★ 为什么必须显式刷（实测踩坑，勿删）：
 *   控件显隐会走 `touchA001Inputs`（敲 inputs 触发 Vue 重算控件行）与 `setSize`
 *   （改节点尺寸）——这两条都会让 Vue 重建节点槽位 DOM，而胶囊是「给原生槽位换皮」
 *   的产物：节点根一旦被重建，NODE_CLASS / CAP_CLASS 全部丢失 → 胶囊失效，
 *   只能等 1.2s 的全局巡检自愈（表现为「显示控件时端口胶囊偶尔失效一会儿」）。
 *   同帧那次覆盖「DOM 已就绪」；双 rAF 那次覆盖「Vue 异步渲染完成」，
 *   refreshA001PortCapsule 内部自带「根换了 / 类名丢了 → 走 tick 重建」判定，幂等。
 */
function refreshPortsAfterHiddenToggle(node) {
    if (!node) return;
    safeCall(() => _deps.refreshA001PortCapsule(node), undefined, "控件显隐后刷新胶囊（同帧）");
    const raf = typeof window !== "undefined" ? window.requestAnimationFrame : null;
    if (typeof raf !== "function") return;
    safeCall(() => {
        raf(() => raf(() => {
            const g = getNodeGraph(node);
            if (!g || !(g._nodes || []).includes(node)) return;
            _deps.refreshA001PortCapsule(node);
            /* 尺寸变了 → 槽位几何也变，刷新后同步一次端口锚点（胶囊内部会一并处理）。 */
        }));
    }, undefined, "控件显隐后刷新胶囊（双 rAF）");
}

/** 查询「提升控件」当前是否处于隐藏状态（状态由 properties 持久保持）。 */
export function isA001WidgetsHidden(node) {
    return !!node?._a001WidgetsHidden;
}

/** 「控件收起」时打在**面板**上的属性名与兼容类名。
 *
 *  ★★ 为什么标记改挂「面板」而不是节点根（实测踩坑，勿改回）：
 *    `.lg-node` 是 **Vue 管理的元素** —— 它会在每次渲染时整体重写 `className`
 *    （实测：点击画布后，节点根的 class 被 Vue 覆盖，我们的 `xzg-a001-widgets-hidden`
 *    **被抹掉**，于是「收起控件后点画布，控件区域又弹出来」）。
 *    而 `.xzg-a001-panel` 是**我们自己 createElement 建的**元素，Vue 不碰它的 class/属性，
 *    标记挂上去就稳定。Custom Stage 的 `data-v2-collapsed` 正是挂在它自建的 panel 上，
 *    同一思路。
 *
 *  面板与控件网格在 node-body 里是**兄弟**（面板 order:-1 且 DOM 位置在前），
 *  故 CSS 用兄弟选择器 `~` 即可从面板标记命中网格（见 A001_textarea_resize.js 的样式）。 */
const A001_HIDDEN_ATTR = "data-a001-collapsed";
/** 节点根上的兼容类名（保留：部分旧 CSS 与巡检仍引用它）。 */
const A001_HIDDEN_CLASS = "xzg-a001-widgets-hidden";

/**
 * 把「控件收起」标记同步到 DOM（幂等）。
 *
 * ★★ 为什么不用「改投影列表」（实测踩坑，勿改回）：
 *   早先收起时直接从投影层停止产出控件行 → Vue **卸载**整批控件 DOM ——
 *   textarea 被销毁、内联高度丢失、槽位 DOM 重建、网格宿主可能整体消失。
 *   Custom Stage 的 bindPanelCollapse 走的是「元素保留 + CSS 隐藏」，
 *   故这里照搬：只打标记，由 CSS 整批隐藏控件网格。
 *
 * 双写目标：
 *   · `.xzg-a001-panel` 上的 `data-a001-collapsed`（**主标记**，Vue 不覆盖，稳定）；
 *   · 节点根上的 `.xzg-a001-widgets-hidden`（兼容类，可能被 Vue 抹掉，仅作兜底）。
 * 找不到 DOM 时静默返回（后续巡检 / 面板重建会再补一次，幂等）。
 */
export function syncA001HiddenClass(node) {
    if (!node) return false;
    const hidden = !!node._a001WidgetsHidden;
    return !!safeCall(() => {
        /* 主标记：我们的面板（Vue 不管理，稳定）。 */
        const panel = node._a001Panel;
        if (panel?.isConnected) {
            if (hidden) panel.setAttribute(A001_HIDDEN_ATTR, "");
            else panel.removeAttribute(A001_HIDDEN_ATTR);
        }
        /* ★ 双保险：直接给控件网格设内联 display —— 不经任何 CSS 选择器，
         *   因此不依赖「面板与网格是否兄弟」这一结构假设（实测最稳）。
         *   网格由 Vue 管理，若其重建会带回默认值，由巡检 / 本函数再次补齐（幂等）。 */
        /* ★ 清洗 id 再拼选择器：node.id 可能来自工作流/剪贴板，含特殊字符会破坏选择器语法。 */
        const gridNodeId = node.id != null ? String(node.id).replace(/[^A-Za-z0-9_-]/g, "") : "";
        const rootForGrid = node._a001DomRoot?.isConnected
            ? node._a001DomRoot
            : (gridNodeId ? document.querySelector(`[data-node-id="${gridNodeId}"]`) : null);
        if (rootForGrid) {
            const grids = rootForGrid.querySelectorAll(".lg-node-widgets, [data-widgets-grid-node-id]");
            for (const g of grids) {
                if (hidden) g.style.setProperty("display", "none", "important");
                else g.style.removeProperty("display");
            }
        }
        /* 兼容标记：节点根类名（可能被 Vue 覆盖，故不作为唯一依据）。 */
        let root = rootForGrid;
        if (root) root.classList.toggle(A001_HIDDEN_CLASS, hidden);
        return true;
    }, false, "同步控件收起标记");
}

/* ════════════════════════════════════════════════
 *  导出（拆分后对外入口；原文件中这些符号为模块私有，现需供入口与其他模块调用）
 * ════════════════════════════════════════════════ */
export {
    readA001NodeSize,
    applyA001DefaultSize,
    persistA001HiddenState,
    scheduleA001HiddenRestore,
    refreshPortsAfterHiddenToggle,
};
