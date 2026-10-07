/* =============================================================================
 * A001_textarea_resize.js —— A001 提升文本框 · 原生纵向拖拽（照搬 Custom Stage）
 * -----------------------------------------------------------------------------
 * 目标：给 A001 提升的多行文本框加上「可纵向拖拽改变高度」的能力，
 *       **逻辑与外观严格照搬 008_ComfyTV Custom Stage**。
 *
 * -----------------------------------------------------------------------------
 * 一、Custom Stage 的做法（照搬对象）
 * -----------------------------------------------------------------------------
 *  蓝本源码：src/v2/shellCssPanels.ts
 *    .v2-panel__prompthost .comfytv-prompt-editor {
 *        resize: vertical;              // ← 浏览器原生纵向手柄（只有右下角）
 *        overflow-y: auto;
 *        max-height: 520px;
 *        min-height: 54px;
 *    }
 *    .v2-panel__prompthost .comfytv-prompt-editor::-webkit-resizer {
 *        background: linear-gradient(135deg, transparent 0 50%, ...);  // 自绘手柄斜纹
 *    }
 *  其中「拖拽改变高度」完全由**浏览器原生 resize**完成，**没有任何 JS 拖拽代码**；
 *  随后由 shellCommon.ts 的 bindPromptResize（ResizeObserver）感知高度变化并同步节点高。
 *  注意：原生 resize **只提供右下角手柄**（这是浏览器限制）。
 *
 * -----------------------------------------------------------------------------
 * 二、A001 与 Custom Stage 的唯一差异（只补两处 CSS，无任何 JS 拖拽）
 * -----------------------------------------------------------------------------
 *  A001 的提升文本框是**官方 TextareaWidget**（渲染为 <textarea>），官方对它设了
 *  resize:none，需要本模块用 CSS 覆盖成 resize:vertical；此外官方把 <textarea>
 *  放进控件网格，网格行会被 grid-template-rows 拉得比内容高，textarea 下方留白，
 *  需要一条 align-content:start 覆盖。
 *  除这两处 CSS 外，本模块不做任何拖拽/尺寸 JS —— 高度完全由浏览器原生 resize
 *  产生，节点总高的同步由 A001_Appearance 的高度归属记账（观察 host/预览框）负责，
 *  与 Custom Stage 的「原生 resize + bindPromptResize 同步节点高」一一对应。
 *
 *  「收起控件」= CSS 隐藏（元素保留，照搬 Custom Stage 的 bindPanelCollapse）：
 *    节点根挂 .xzg-a001-widgets-hidden 时，本模块的 CSS 把控件网格整批 display:none；
 *    元素从不销毁 → textarea 的内联 height 天然存活 → 收起/展开来回切换高度不丢。
 *    但「切换工作流 / Vue 重建节点根」仍会销毁 textarea，故需 properties 存档读回
 *    （见下方「高度持久化」段落）。
 *
 * -----------------------------------------------------------------------------
 * 三、安全约束
 * -----------------------------------------------------------------------------
 * · 只作用于 A001 节点内的 textarea（选择器以 .xzg-a001-node 限定）；
 * · 不改动官方 textarea 的其它尺寸逻辑，只补 resize / overflow 声明。
 * ========================================================================== */

import { safeCall } from "./A001_shared.js?v=20261007a";
import { injectStyleOnce } from "../A000/A000_DomStyle.js";

/* ---------------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------------- */
const ROOT_CLASS = "xzg-a001-node";      // A001 节点根标识（与 A001_port_capsule 一致）
const STYLE_ID = "xzg-a001-textarea-resize-style";

/* 文本框的可拖拽高度下限（布局像素）。照 Custom Stage 也设了 min-height；
 * 上限不设（Custom Stage 设了 520，这里按用户此前要求不限制，可自由拖高）。
 * 下限 80 为用户指定值。 */
const MIN_H = 80;

/* ---------------------------------------------------------------------------
 * 注入样式（幂等：用 DOM 查询判定，避免热替换时重复注入）
 *
 * 【选择器口径】.xzg-a001-node textarea
 *   A001 节点内只有「提升的多行文本框」（官方 TextareaWidget）会渲染 <textarea>，
 *   节点面板（预览框/控件框）内不含 textarea，故无需额外排除。
 * ------------------------------------------------------------------------- */
const STYLE_TEXT = `
/* ── A001 提升文本框：原生纵向拖拽（照搬 008_ComfyTV Custom Stage） ──
 * resize:vertical = 浏览器原生手柄（只有右下角，与 Custom Stage 一致）；
 * 生效前提是元素可滚动（overflow-y:auto）。 */
.xzg-a001-node textarea {
    resize: vertical;
    overflow-y: auto;
    overscroll-behavior: contain;
    min-height: ${MIN_H}px;
    /* ⚠️ 不设 max-height（实测踩坑，勿加）：官方提升控件行被 grid 以 align-items:stretch
     * 撑满整行，textarea 本应自然填满该行（size-full）。一旦设 max-height 限制其高度，
     * 行仍保持 stretch 高度 → textarea 下方露出大块空白。故不设上限。 */
}

/* 右下角手柄外观：自绘两段斜纹（照搬 Custom Stage 的 ::-webkit-resizer 画法）。
 * ::-webkit-resizer 在暗色主题下默认不可见，故显式给 background。 */
.xzg-a001-node textarea::-webkit-resizer {
    background:
        linear-gradient(135deg,
            transparent 0 50%,
            rgba(255,255,255,.38) 50% 60%,
            transparent 60% 75%,
            rgba(255,255,255,.38) 75% 85%,
            transparent 85%),
        rgba(255,255,255,.06);
    border-top-left-radius: 4px;
}

/* 亮色主题手柄：斜纹用深色，保证可见。 */
html:not(.dark-theme) .xzg-a001-node textarea::-webkit-resizer {
    background:
        linear-gradient(135deg,
            transparent 0 50%,
            rgba(0,0,0,.35) 50% 60%,
            transparent 60% 75%,
            rgba(0,0,0,.35) 75% 85%,
            transparent 85%),
        rgba(0,0,0,.05);
}

/* ── 控件网格：固定高度、绝不吸收剩余空间（「节点下方大片空白」的关键修复）──
 * ★★ 为什么必须固定（实测踩坑，勿删）：
 *   官方给控件网格的类是 flex: 1 1 0%（弹性块）—— 那是给「没有自建面板」的普通节点用的。
 *   但 A001 的预览面板与网格是 node-body 里的**兄弟**，两者都 flex:1 时会**平分**剩余空间：
 *   实测节点高 1117 时，面板只拿到 424、网格却拿到 613（而网格内只有 1 行 244px）
 *   → 网格下方空 369px，加上面板自己的压缩，视觉上就是「节点下方一大片空白」。
 *   正解（对齐 Custom Stage 的「卡片是唯一弹性块」）：网格改为按内容高度 flex: 0 0 auto，
 *   把「吸收剩余高度」的职责**完全交给预览面板**（其内部预览框 flex:1）。
 *   ⚠️ 只改 flex 的 grow/shrink，绝不碰 width/flex-basis（会挤窄控件区）。 */
.xzg-a001-node .lg-node-widgets,
.xzg-a001-node [data-widgets-grid-node-id] {
    flex: 0 0 auto !important;
}

/* ── 控件网格内部：各行按「内容高度」排列，消除行间/行下空白 ──
 * 官方控件网格会用 grid-template-rows 把行显式拉高（A001 节点高较大时实测行被拉到
 * 300+px，而内容只需几十 px），行下方因此留白。加以下两条后行高 = 内容高。 */
.xzg-a001-node .xzg-a001-grid-autoh {
    align-content: start !important;
    grid-template-rows: auto !important;
}

/* ── 高度接管后：预览框保持 200px 硬下限（**不归零**，用户指定）──
 *
 * ★★ 为什么不照抄 Custom Stage 的「归零」（本项目刻意偏离，勿改回）：
 *   Custom Stage 写的是 .v2-card[data-v2-height] .v2-preview { min-height: 0 }，
 *   但它能这么写是因为它的 min 只是**卡片最小高度 170**，而它的预览内容区自然高度
 *   远大于 170 → JS 里的 Math.max(min, flexible.offsetHeight) 那层保护永远不生效，
 *   归零不归零都无所谓。
 *   A001 不同：预览框是本节点的**主视觉区**，用户明确要求它不得塌缩 ——
 *   若接管后把 min-height 归零，节点被拉矮时预览框会塌成一条线（实测压到 10px）。
 *
 * ★ 保持 200 后，「收起控件后节点不变矮」的旧 bug 不会复现（关键，勿误判）：
 *   旧 bug 的成因是 offset 被错采成 335（含 min-height 虚高），现在 offset 已修正为
 *   常量 30（标题栏高度）。推演收起：chrome 由「121+控件网格高」减到 121，
 *   preview 因本下限稳定在 200（wanted 随之稳定），h = chrome + wanted − offset
 *   → chrome 减小 200 不变 → **节点正确变矮**。
 * A001 等价写法中的「接管标记」仍由 goLive 打在面板上（供其它规则使用）。 */
.xzg-a001-panel[data-a001-height] .xzg-a001-preview {
    min-height: 200px !important;
}

/* ── 「收起控件」= CSS 隐藏（一比一照搬 008_ComfyTV Custom Stage 的 bindPanelCollapse）──
 * Custom Stage：.v2-card[data-v2-collapsed] > :not(.v2-collapse){ display:none }
 *   —— 元素**保留在 DOM 里**，只是不占位；因此 textarea 的内联 height 天然存活，
 *      不需要任何 properties 存档，展开后高度原样还在。
 *
 * ★★ 标记挂在「面板」而非「节点根」（实测踩坑，勿改回）：
 *   .lg-node 是 Vue 管理的元素，渲染时会整体重写 className，把我们的类**抹掉**
 *   （实测：收起后点画布 → 控件区域又弹出来）。而 .xzg-a001-panel 是我们自建的元素，
 *   Vue 不碰它 → 标记稳定。
 *   面板与控件网格在 node-body 里是**兄弟**且面板在前，故用兄弟选择器（波浪号）命中网格。
 *   （同时保留节点根类名版本作为兼容兜底。）
 *   ⚠️ 本段注释位于模板字符串内部：**严禁出现反引号**（血泪教训，勿再犯）。 */
.xzg-a001-panel[data-a001-collapsed] ~ [data-widgets-grid-node-id],
.xzg-a001-panel[data-a001-collapsed] ~ .lg-node-widgets,
.xzg-a001-node.xzg-a001-widgets-hidden [data-widgets-grid-node-id],
.xzg-a001-node.xzg-a001-widgets-hidden .lg-node-widgets {
    display: none !important;
}
`;

function injectCss() {
    safeCall(() => {
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
    }, undefined, "注入文本框原生拖拽样式");
}

/* ---------------------------------------------------------------------------
 * 高度持久化（本轮加回，针对「切换工作流后 textarea 高度恢复默认」）
 *
 * 背景：拖拽改变的高度写在内联 style.height 上，随 DOM 元素一起销毁。
 *   · 收起/展开（CSS 隐藏）—— 元素保留 → 内联 height 天然存活，无需存档；
 *   · 切换工作流 / Vue 重建节点根 —— textarea 元素被销毁重建 → 内联 height 丢失。
 * 故这里加回「高度写 properties，元素重建时读回」：
 *   · key 用「textarea 在节点内所有 textarea 中的索引」—— 索引与提升槽位顺序一致，
 *     在节点生命周期内稳定（prompt 通常是唯一一个多行文本，索引恒为 0）；
 *   · 用 ResizeObserver 监听高度变化（原生 resize 手柄拖拽会改变 offsetHeight），
 *     变化即写入 node.properties["a001_textarea_heights"]（litegraph 会随工作流序列化）；
 *   · 元素重建后（切换工作流 / Vue 重渲染），巡检时把存档高度写回新 textarea。
 *
 * 为什么用 ResizeObserver 而非 textarea 的原生事件：
 *   原生 resize 没有事件；change/input 只在值变化时触发，与高度无关。
 *   ResizeObserver 能精确感知「拖拽手柄改变高度」这一动作。
 * ------------------------------------------------------------------------- */

const HEIGHTS_PROP = "a001_textarea_heights";

/** 读已存档的 textarea 高度表（幂等，缺省返回空对象）。 */
function readHeights(node) {
    return safeCall(() => {
        const p = node?.properties;
        const v = p?.[HEIGHTS_PROP];
        return v && typeof v === "object" ? v : {};
    }, {}, "读 textarea 高度存档");
}

/** 把某个 textarea 的高度写进存档（含 0/默认值时清理该条目）。 */
function writeHeight(node, index, h) {
    return safeCall(() => {
        if (!node || index == null) return false;
        const heights = readHeights(node);
        const rounded = Math.round(h);
        if (rounded > 0) heights[String(index)] = rounded;
        else delete heights[String(index)];
        if (!node.properties || typeof node.properties !== "object") node.properties = {};
        node.properties[HEIGHTS_PROP] = heights;
        return true;
    }, false, "写 textarea 高度存档");
}

/** 取某个 textarea 的存档高度（无则返回 0）。 */
function savedHeight(node, index) {
    const v = readHeights(node)[String(index)];
    return Number.isFinite(v) ? v : 0;
}

/* ---------------------------------------------------------------------------
 * 单个 textarea 的处理：只为「锚点 CSS 作用域 + 修正会被 Vue 覆盖的声明」服务
 * ------------------------------------------------------------------------- */

/** 处理一个 textarea（幂等）：补样式校正 + 读回存档高度 + 挂高度变化监听。
 *
 * @param {object} node 节点
 * @param {HTMLElement} textarea 目标 textarea
 * @param {number} index textarea 在节点内所有 textarea 中的索引（持久化 key）
 */
function applyToTextarea(node, textarea, index) {
    safeCall(() => {
        if (textarea.style.resize === "none") textarea.style.resize = "";
        if (textarea.style.overflowY === "hidden") textarea.style.overflowY = "";
    }, undefined, "校正 textarea 原生拖拽声明");
    /* ★ 读回存档高度：仅当该 textarea 尚无内联高度时写回（内联高度优先 —— 它可能是
     *   用户刚拖出来的值；存档只在元素重建后、内联高度丢失时兜底）。 */
    if (index != null && !textarea.style.height) {
        const h = savedHeight(node, index);
        if (h > 0) {
            /* 读回时钳到下限：旧存档可能低于 MIN_H（如早先 24 / 50），不钳制会让
             * 「最低 80」在元素重建后失效。 */
            safeCall(() => { textarea.style.height = `${Math.max(MIN_H, h)}px`; },
                undefined, "读回 textarea 存档高度");
        }
    }
    /* ★ 挂高度变化监听（每元素一份，幂等判据用 data 属性）：
     *   拖拽手柄改变 textarea 高度 → ResizeObserver 回调 → 写 properties 存档。 */
    if (typeof ResizeObserver !== "undefined" && index != null && !textarea.dataset.a001HeightObserved) {
        textarea.dataset.a001HeightObserved = "1";
        /* ★ 先回收本节点上「目标已脱离 DOM」的旧 observer：
         *   Vue 重建 textarea 时旧元素不再 isConnected，但它的 ResizeObserver 仍强引用
         *   旧元素（形成不可回收环）；而 detach 只能查到当前 DOM 里的 textarea，
         *   够不到旧元素 → 反复重建即持续泄漏。此处就地按「目标已脱离」回收。 */
        const ros = node._a001HeightROs || (node._a001HeightROs = new Set());
        for (const old of Array.from(ros)) {
            if (old._a001El?.isConnected) continue;
            safeCall(() => old.disconnect(), undefined, "回收脱离 DOM 的高度监听");
            ros.delete(old);
        }
        const ro = new ResizeObserver(() => {
            const h = textarea.offsetHeight;
            if (h > 0) safeCall(() => writeHeight(node, index, h), undefined, "监听写 textarea 高度");
        });
        ro.observe(textarea);
        /* 同时记到 textarea（随元素检索）与节点级登记表（detach 统一断开，含旧元素）。 */
        ro._a001El = textarea;
        ros.add(ro);
        textarea._a001HeightRO = ro;
    }
}

/* ---------------------------------------------------------------------------
 * 巡检：Vue 会重建 textarea 元素，需要为新元素补齐。
 * ★ 一体化改造后本模块**不再自持巡检**：重建感知与兜底巡检统一由
 *   A001_restore.js 的「单一观察器 + 单一巡检」负责（见 attachA001TextareaResize 注释）。
 *   本文件只保留 scanNode 作为「被中枢调用的恢复动作」。
 * ------------------------------------------------------------------------- */

function nodeRoot(node) {
    const cached = node?._a001DomRoot;
    if (cached?.isConnected) return cached;
    if (node?.id == null) return null;
    return document.querySelector(`[data-node-id="${node.id}"]`);
}

function scanNode(node) {
    const root = nodeRoot(node);
    if (!root) return;
    /* 作用域类名可能因 Vue 重建节点根而丢失，每次巡检补一次（幂等）。 */
    root.classList?.add(ROOT_CLASS);
    /* ★ 「控件收起」标记自愈：Vue 重建 DOM 会抹掉节点根上的类、并重置网格的内联 display。
     *   本模块不 import A001_SubgraphNode.js（避免环），故在此独立补一遍同样语义的标记：
     *     ① 面板（我们自建、Vue 不碰）打 data-a001-collapsed —— 稳定，供 CSS 兄弟选择器命中；
     *     ② 网格内联 display:none —— 不经选择器，最稳。
     *   只在「确实处于收起态」时补；展开态则清除，保证幂等。 */
    /* ★ 网格查询只做一次（原先收起分支与下方各查一遍，同一轮共查两次）。
     *   querySelectorAll 返回静态 NodeList，元素引用不随后续属性写入而变。 */
    const grids = root.querySelectorAll(".lg-node-widgets, [data-widgets-grid-node-id]");
    if (node._a001WidgetsHidden) {
        root.classList?.add("xzg-a001-widgets-hidden");
        const panel = node._a001Panel;
        if (panel?.isConnected) panel.setAttribute("data-a001-collapsed", "");
        for (const g of grids) g.style.setProperty("display", "none", "important");
    }
    /* ★★ 网格「按内容高度排列」类：**无条件**给所有控件网格补上（幂等 + 自愈）。
     *   早先只在「存在 textarea」时才加 —— 但空文本/无文本框的提升控件同样需要它：
     *   否则 grid-template-rows 会把唯一的行拉到整格高，行下方留下大片空白
     *   （这正是用户反馈「节点下方大片空白」的成因之一）。 */
    for (const g of grids) {
        safeCall(() => g.classList?.add("xzg-a001-grid-autoh"),
            undefined, "控件网格按内容高度排列");
    }
    const areas = root.querySelectorAll("textarea");
    for (let i = 0; i < areas.length; i++) applyToTextarea(node, areas[i], i);
}

/**
 * 对外暴露的单次巡检入口（供统一恢复中枢 A001_restore.js 的 textarea 任务调用）。
 * 语义与内部 scanNode 完全一致（幂等）。
 */
export function scanA001Textarea(node) {
    return safeCall(() => scanNode(node), undefined, "文本框恢复扫描");
}

/* ---------------------------------------------------------------------------
 * attach / detach
 * ------------------------------------------------------------------------- */

/** 为节点启用文本框原生纵向拖拽（幂等）。 */
export function attachA001TextareaResize(node /* , deps */) {
    if (!node || node.id == null) return false;
    injectCss();
    safeCall(() => nodeRoot(node)?.classList?.add(ROOT_CLASS), undefined, "标记 A001 文本框作用域");
    /* 立即扫一次（DOM 可能已就绪），并启动巡检（DOM 重建后自愈）。 */
    safeCall(() => scanNode(node), undefined, "文本框首次巡检");
    /* ★★ 一体化改造：**不再每节点起 1200ms 巡检**。
     *   原实现对每个节点各起一个 setInterval 无条件重扫，既费开销，又与端口胶囊
     *   的巡检叠加成「多路并发重建」——同一帧内互相唤起观察器，是「偶尔闪一下」的
     *   结构性成因之一。
     *   现在文本框的重建完全交给统一恢复中枢（A001_restore.js）：
     *     · 单一 MutationObserver（绑画布稳定层，不易失聪）负责即时感知；
     *     · 单一巡检负责兜底，且只在「textarea 接线丢失」时才请求 textarea 恢复
     *       （判据见 _evaluateNode 的 ③b）。
     *   此处仅做一次装配时的即时扫描（DOM 已就绪的情况）。 */
    return true;
}

/** 停用并清理（节点删除时调用）。 */
export function detachA001TextareaResize(node) {
    if (!node) return false;
    /* 断开所有登记过的 ResizeObserver（节点删除后不应再写 properties）。
     * ★ 必须按节点级登记表断开：只遍历当前 DOM 的 textarea 会漏掉已被 Vue 重建、
     *   脱离 DOM 的旧元素 —— 那些 observer 仍在观察它们，构成泄漏。 */
    safeCall(() => {
        const ros = node._a001HeightROs;
        if (ros) {
            for (const ro of ros) safeCall(() => ro.disconnect(), undefined, "断开文本框高度监听");
            ros.clear();
        }
        const root = nodeRoot(node);
        if (!root) return;
        for (const ta of root.querySelectorAll("textarea")) {
            ta._a001HeightRO = null;
        }
        root.classList?.remove(ROOT_CLASS);
        root.classList?.remove("xzg-a001-widgets-hidden");
    }, undefined, "摘除 A001 文本框作用域类名与监听");
    return true;
}

export default {
    attachA001TextareaResize,
    detachA001TextareaResize,
};
