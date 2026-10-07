/* =============================================================================
 * A001_port_capsule.js —— A001 端口胶囊（展开节点胶囊 + 连线端点对齐）
 * -----------------------------------------------------------------------------
 * 复刻目标：008_ComfyTV 的 Custom Stage / Video Stage 节点（如「视频阶段」）的
 * 端口胶囊，**外观与功能一比一**。
 * 蓝本源码（位于 008_ComfyTV 插件）：
 *   src/v2/shellCss.ts      端口胶囊全部 CSS（核心 128-226 行）
 *   src/v2/nodeDrag.ts      nudge + 展开意图（本模块改为「点击展开」）
 *   src/v2/shellChrome.ts   syncSocketY 连线对齐计算中枢
 *
 * -----------------------------------------------------------------------------
 * 一、复刻的核心思想（务必先读懂，否则会走弯路）
 * -----------------------------------------------------------------------------
 * ComfyTV 的胶囊**不是「自造一个新端口」**，而是「**给原生槽位换皮**」：
 *   - 圆点的内芯仍然是框架原生的 .lg-slot / [data-slot-key] 元素；
 *   - 只是用一个绝对定位的壳（圆点本体 / 展开面板）把它裹起来，视觉上变成
 *     「贴边圆点 + **点击**展开的面板」（原 hover 展开已改为点击展开）；
 * 这样做的好处是：**连线端点由框架原生计算，天然跟随胶囊位置**，不需要自己画线。
 *
 * 所以复刻的正确顺序是：
 *   ① 让原生槽位的**盒模型保持官方原样**（这是端点能被算准的前提）；
 *   ② 只隐藏槽位里的**文字**（span），视觉让位给胶囊壳；
 *   ③ 用 JS 把「圆点应在的垂直位置」写成 CSS 变量 --xzg-a001-cap-mid；
 *   ④ 展开/折叠切换时，用官方尺寸变化触发框架重测槽位布局。
 *
 * -----------------------------------------------------------------------------
 * 二、A001 相比 ComfyTV 的两个特殊约束（决定了本文件与 A000_Port.js 不同）
 * -----------------------------------------------------------------------------
 * 约束 1：A001 的端口区与控件网格宿主 [data-widgets-grid-node-id] 是**兄弟节点**。
 *   => ComfyTV / A000_Port.js 那种「只改 grid 的 paddingBottom 来 nudge」的手法
 *      在 A001 上单独用不行：改 grid 的 padding 不改变节点自身 size。
 *      本模块的 nudge 同时改 grid 的 padding-bottom 与节点根的 margin-bottom，
 *      靠 grid 自身 border-box 高度 0→1px 唤起框架的 widgets-grid ResizeObserver
 *      （该观察者是 signal-only：命中即 scheduleSlotLayoutSync → 官方从 DOM 重测槽位）。
 *      详见 docs/A001端口胶囊复刻调研.md 第 9.5 / 十二章。
 *
 * 约束 2：A001 的折叠态**绝不能把 .lg-slot 压成 0**。
 *   => 官方 getSlotElementRect 对 width<=0 或 height<=0 返回 null → 直接
 *      deleteSlotLayout → 端点塌到节点原点。官方自己在 ComfyTV 里选定的值是
 *      height:6px（>0 且足够小，多槽经 grid-area:1/1 重叠后几何中心收敛到桶中心）。
 *
 * -----------------------------------------------------------------------------
 * 三、几何同步：nudgeNode 的 CSS 净零高度脉冲
 * -----------------------------------------------------------------------------
 *   展开/折叠后槽位占位变了，但官方几何缓存**只在节点 position/size 变化时重测**，
 *   纯 DOM 内部 CSS 变化不触发。故对网格宿主做「+1px → 40ms 后撤销」的脉冲，
 *   同时对节点根做 -1px margin 抵消（净高度不变，肉眼无感）。
 *   ⚠️ 不要改用 node.setSize() 抖动：实测那会让 Vue 重建节点根元素，
 *      换皮类名丢失、观察器失效（详见文件末「实测踩坑」）。
 *
 * -----------------------------------------------------------------------------
 * 四、垂直居中：syncCapsuleMidpoint
 * -----------------------------------------------------------------------------
 *   以「官方槽位 .lg-slot 的实测中线」为锚点（与官方画连线的端点同源），
 *   换算成「相对节点根的布局像素」写进 --xzg-a001-cap-mid，展开态沿用折叠态缓存。
 *   ⚠️ 必须用实测位置而不是「节点高度 ÷ 2」的猜测值。
 *
 * -----------------------------------------------------------------------------
 * 五、前置依赖（强阻塞）
 * -----------------------------------------------------------------------------
 *   本模块的 CSS 选择器与几何计算都依赖 DOM 里存在 [data-widgets-grid-node-id]
 *   宿主（框架才会生成标准槽位结构）。该宿主由 A001_grid_anchor.js 保证。
 *   若宿主不存在，本模块会静默不做任何事（避免半成品外观）。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 依赖注入（避免与 A001_SubgraphNode.js 形成循环 import 的 TDZ 崩溃）
 *
 * 背景：A001_SubgraphNode.js → A001_Appearance.js → A001_workflow.js → A001_SubgraphNode.js
 * 本身已成环，若本模块再顶层 import A001_SubgraphNode.js 的 alog，会在模块初始化阶段
 * 抛 "Cannot access 'alog' before initialization"。
 * 因此本模块只导出 initPortDeps，由调用方在注入时机传入。
 * ------------------------------------------------------------------------- */
let _alog = () => {};
/* 默认兜底实现与 A001_shared.safeCall(fn, fallback, label) 签名严格对齐：
 * 避免未注入 deps 时 fallback 语义丢失（原实现只接受 1 参，存在隐性契约不一致）。 */
let _safeCall = (fn, fallback, label) => {
    try { return fn(); } catch (e) { _alog(label || "safeCall", e); return fallback; }
};

export function initPortDeps(deps) {
    if (deps && typeof deps.alog === "function") _alog = deps.alog;
    if (deps && typeof deps.safeCall === "function") _safeCall = deps.safeCall;
    return true;
}

/* ---------------------------------------------------------------------------
 * 常量：类名 / 选择器 / CSS 变量名
 * 全部带 xzg-a001 前缀，确保只作用于 A001，绝不误伤 A005/A006 等其它节点。
 * ------------------------------------------------------------------------- */
import { injectStyleOnce } from "../A000/A000_DomStyle.js";

const NODE_CLASS = "xzg-a001-node";                       // 打到节点根上
const CAP_CLASS = "xzg-a001-cap";                         // 打到「桶」（每个方向一个）
const WRAP_CLASS = "xzg-a001-cap-wrap";                   // 打到「槽位区包裹层」（桶的父）

const OPEN_CLASS = "xzg-a001-cap-open";                   // 桶展开态
const CAP_MID_VAR = "--xzg-a001-cap-mid";                 // 桶中心线（px，相对节点根）

const STYLE_ID = "xzg-a001-cap-style";

/* ---------------------------------------------------------------------------
 * CSS —— 一比一复刻自 shellCss.ts（128-226 行），变量名与配色同源
 *
 * 关键点逐条说明：
 *  .xzg-a001-cap          折叠态圆点壳：22×22 圆形、绝对定位、居中
 *  .xzg-a001-cap::after   圆点里的「+」号（复刻 shellCss 的 content:'+'）
 *  .xzg-a001-cap-open     展开态面板：纵向排列、每行「圆点 + 文字胶囊」
 *  .lg-slot span{display:none}  折叠态只藏文字，绝不把盒模型压成 0
 * ------------------------------------------------------------------------- */
const CAP_CSS = `
/* —— 局部变量：颜色取自 ComfyTV shellCss.ts 的默认主题值 —— */
.${NODE_CLASS}{
    --xzg-a001-cap-bg:#1e1e21;          /* shellCss --v2-socket-bg */
    --xzg-a001-cap-border:#7a7a82;      /* shellCss --v2-socket-border */
    --xzg-a001-cap-halo:rgba(255,255,255,.14);  /* shellCss --v2-slot-halo */
    --xzg-a001-cap-text:#b9b9c0;        /* shellCss --v2-text-mid */
    --xzg-a001-cap-hover:rgba(255,255,255,.08); /* shellCss --v2-hover-bg */
}

/* —— ① 槽位区包裹层：撑满节点的覆盖层（复刻 shellCss.ts:128-135）——
 * 这是「连线能对上端口」的**第一道保险**：
 *   position:absolute + inset:0 → 它铺满节点主体，自身不占流、但**绝不塌陷**；
 *   pointer-events:none        → 它只是定位参照，不拦截鼠标；
 *   桶（.xzg-a001-cap）以它为定位参照。
 * ⚠️ 漏掉这一条会导致包裹层高度塌陷为 0（实测），
 *    官方 syncNodeSlotLayoutsFromDOM 读到的槽位几何全错 → 连线端点错位。 */
.${NODE_CLASS} .${WRAP_CLASS}{
    position:absolute !important;
    inset:0 !important;
    margin:0 !important;
    padding:0 !important;
    pointer-events:none !important;
    z-index:30;
}

/* —— ② 端口桶（每个方向一个）：作为圆点与面板的「共同体」——
 * ✅ 一比一复刻 shellCss.ts:136-152 的官方做法：
 *    top: var(--xzg-a001-cap-mid) + translateY(-50%)  → top 语义 = 圆心 y
 *    display:grid + 内层 .lg-slot grid-area:1/1       → 多槽重叠成一个圆点
 * ⚠️ 不要用 width/height 去「裁掉」内部槽位：那样会改坏槽位盒模型，
 *    官方测出的端点就会与圆点错位。正解是让槽位原样保留，
 *    仅靠 grid 重叠让它们视觉上落在一格。 */
.${NODE_CLASS} .${CAP_CLASS}{
    position:absolute !important;
    left:-11px !important;                       /* 复刻 shellCss：贴左边缘 */
    top:var(--xzg-a001-cap-mid, 150px) !important;
    transform:translateY(-50%) !important;       /* top = 圆心，故取块高一半 */
    z-index:30;
    display:grid !important;                     /* 复刻 shellCss：grid 叠放 */
    place-items:center !important;
    min-width:22px;
    min-height:22px;
    padding:2px;
    margin:0 !important;
    box-sizing:border-box !important;
    border-radius:999px !important;
    background:var(--xzg-a001-cap-bg);
    border:1.5px solid var(--xzg-a001-cap-border);
    box-shadow:0 2px 8px rgba(0,0,0,.55);
    cursor:pointer;
    pointer-events:auto;
    /* 复刻 shellCss:150-158：折叠态默认隐藏，节点 hover / 选中时显形 */
    opacity:0;
    transition:opacity .15s ease;
}
.${NODE_CLASS}:hover .${CAP_CLASS},
.${NODE_CLASS}.selected .${CAP_CLASS},
.${NODE_CLASS}.lg-node--selected .${CAP_CLASS},
.${NODE_CLASS}[data-selected] .${CAP_CLASS}{
    opacity:1;
}

/* 桶内的原生槽位在折叠态重叠到同一格（复刻 shellCss:153-154） */
.${NODE_CLASS} .${CAP_CLASS} > .lg-slot{
    grid-area:1 / 1 !important;
}

/* 输出方向的桶贴右边缘（复刻 shellCss 的 .ml-auto 分左右） */
.${NODE_CLASS} .${CAP_CLASS}[data-dir="out"]{
    left:auto !important;
    right:-11px !important;
}

/* —— 圆点里的「+」号（复刻 shellCss:162-172）——
 * ★ transform:translateY(-1px) 是【光学居中】修正，不可省：
 *   '+' 字形在字盒中的视觉重心略低于几何中心（baseline 上方留白多、下方少），
 *   只靠 flex 的 align-items:center 会看起来偏下 1px 左右。
 *   公共端口模块 js/A000/A000_Port.js:28 的同款写法也带这一句，此处与之对齐。
 * ⚠️ 本段位于模板字符串内，注释中禁止出现反引号字符。 */
.${NODE_CLASS} .${CAP_CLASS}::after{
    content:'+';
    position:absolute;
    inset:0;
    display:flex;
    align-items:center;
    justify-content:center;
    font:400 15px/1 system-ui, sans-serif;
    color:var(--xzg-a001-cap-text);
    pointer-events:none;
    transform:translateY(-1px);
}

/* —— 展开态：垂直居中于中心线（复刻 shellCss:184-192）——
 * 关键：必须解除折叠态的 22×22 死尺寸与圆点居中，
 *      然后用 translateY(-50%) 让「面板垂直中心」对齐 --xzg-a001-cap-mid。 */
.${NODE_CLASS} .${CAP_CLASS}.${OPEN_CLASS}{
    opacity:1 !important;
    top:var(--xzg-a001-cap-mid, 150px) !important;
    transform:translateY(-50%) !important;       /* 面板垂直中心对齐圆心线 */
    min-width:0 !important;
    min-height:0 !important;
    display:flex !important;                     /* 复刻 shellCss:184：grid → flex */
    flex-direction:column !important;
    align-items:flex-start !important;           /* 行靠左排（复刻 shellCss:187） */
    justify-content:flex-start !important;       /* 从顶部往下排 */
    gap:5px;                                     /* 复刻 shellCss:187 */
    padding:6px;                                 /* 复刻 shellCss:188 */
    border-radius:12px !important;               /* 复刻 shellCss:189 */
    background:var(--xzg-a001-cap-bg) !important;/* 面板底与圆点同色 */
}

/* 输出方向的面板：从右边缘展开，行内容靠右对齐（复刻 shellCss:186 .ml-auto.v2-open） */
.${NODE_CLASS} .${CAP_CLASS}[data-dir="out"].${OPEN_CLASS}{
    align-items:flex-end !important;
    text-align:right;
}

/* 展开态解除 grid 叠放，槽位回归纵向排列（复刻 shellCss:193-195） */
.${NODE_CLASS} .${CAP_CLASS}.${OPEN_CLASS} > .lg-slot{
    grid-area:auto !important;
}

/* 展开后不显示「+」 */
.${NODE_CLASS} .${CAP_CLASS}.${OPEN_CLASS}::after{ display:none; }

/* —— ★ 折叠态把槽位压成 6px 并透明（复刻 shellCss.ts:173-180）——
 * 这是「连线端点正好落在圆点圆心」的**核心机制**。
 * 原理：官方从 DOM 实测槽位中心（getSlotElementRect→cachedOffset→slotLayouts），
 *      把 .lg-slot 高度压成 6px + 桶内 grid-area:1/1 叠放后，
 *      官方测出的 slot 中心 == 桶（圆点）中心 —— 端点自然与圆心重合。
 * 注意 height 必须 >0：官方 getSlotElementRect 对 width<=0||height<=0 返回 null，
 *      会直接 deleteSlotLayout（端点塌到节点原点）。6px 是官方选定的值。 */
.${NODE_CLASS} .${CAP_CLASS} .lg-slot--input,
.${NODE_CLASS} .${CAP_CLASS} .lg-slot--output{
    height:6px;
    padding:0;
    margin:0;
    opacity:0;
    transition:height .12s ease;
}
.${NODE_CLASS} .${CAP_CLASS} .lg-slot span{ display:none; }

/* —— 复刻 shellCss.ts:182：解除官方 dot 容器的 -translate-x-1/2 ——
 * ⚠️ 本机前端用的是 Tailwind v4，其 -translate-x-1/2 编译为【独立属性
 *   translate: -50%】，而不是老的 transform:translateX(-50%)。
 *   只写 transform:none 对 v4 无效（computed transform 为 none，但
 *   computed translate 仍为 -50%）→ dot 容器整体左移 6 布局像素
 *   → 官方测出的线端 / 圆点中心比桶圆心偏左。
 *   因此必须【同时】归零 transform 与 translate，X 才回到几何真值。
 * 注：本段位于 CAP_CSS 模板字符串内，注释中禁止出现反引号字符，
 *     否则会提前闭合模板串导致整段 CSS 变成 JS。 */
.${NODE_CLASS} .${CAP_CLASS} .lg-slot [class*="translate-x"]{
    transform:none !important;
    translate:none !important;
}

/* 展开态：把原生槽位也显形，形成「逐行列出端口」的面板（复刻 shellCss:199-206） */
.${NODE_CLASS} .${CAP_CLASS}.${OPEN_CLASS} .lg-slot{
    height:16px;
    opacity:1;
    display:flex;
    flex-direction:row;
    align-items:center;
    justify-content:flex-start;   /* 行内左对齐（输出侧由下一条覆盖为右对齐） */
    gap:5px;
    align-self:stretch;           /* 行撑满面板宽，保证 hover 区整行可点 */
    width:100%;
    box-sizing:border-box;
}

/* 展开态行内对齐：输入靠左、输出靠右（复刻 shellCss:186）。
 * ⚠️ 不要用 flex-direction:row-reverse 做镜像，那会颠倒 DOM 顺序。 */
.${NODE_CLASS} .${CAP_CLASS}[data-dir="out"].${OPEN_CLASS} .lg-slot{
    justify-content:flex-end;
}

/* 展开态的文字胶囊（复刻 shellCss:207-215）——用户截图里的浅色小胶囊 */
.${NODE_CLASS} .${CAP_CLASS}.${OPEN_CLASS} .lg-slot span{
    display:inline-block;
    font:500 10px/1 system-ui, sans-serif;
    color:var(--xzg-a001-cap-text);
    padding:2px 6px;
    border-radius:999px;
    background:var(--xzg-a001-cap-hover);
    white-space:nowrap;
    text-align:left;
}

/* 展开态里的小圆点（复刻 shellCss:216-225） */
.${NODE_CLASS} .${CAP_CLASS}.${OPEN_CLASS} [data-slot-key]{
    width:9px;
    height:9px;
    border-radius:999px;
    flex:none;
    background:none;
    box-shadow:0 0 0 2px var(--xzg-a001-cap-halo);
}
.${NODE_CLASS} .${CAP_CLASS}.${OPEN_CLASS} [data-slot-key] circle,
.${NODE_CLASS} .${CAP_CLASS}.${OPEN_CLASS} [data-slot-key] g{
    clip-path:none;
}

/* 展开时屏蔽原生 tooltip，避免与面板重叠（复刻 shellCss:226） */
body[data-xzg-a001-slot-hover] .p-tooltip{ display:none !important; }
`;

/* ---------------------------------------------------------------------------
 * 注入样式（用 DOM 查询判幂等：模块级布尔变量在热替换时会重复注入）
 * ------------------------------------------------------------------------- */
function injectCapsuleCss() {
    injectStyleOnce(STYLE_ID, CAP_CSS);
}

/* ---------------------------------------------------------------------------
 * nudgeNode(node) —— 1px 净零脉冲触发官方重测槽位布局
 *
 * 这是本模块**连线能不能对上端口的关键**（复刻 ComfyTV 的 nudgeSlotAnchors）。
 * 逻辑：
 *   1. 给官方网格宿主 [data-widgets-grid-node-id] 加 padding-bottom:1px、
 *      同时给节点根加 margin-bottom:-1px（净高度不变，肉眼无感）；
 *   2. 40ms 后撤销；
 *   3. 用 60ms 轮询节流，避免连续展开/收起时高频重排。
 *
 * ⚠️ 曾经的错误实现（已废弃）：调 node.setSize([w, h+1]) 再还原。
 *    实测：那会让 Vue 重建节点根元素 → NODE_CLASS 丢失 → 换皮 CSS 全失配，
 *    桶膨胀、中心线变量漂成错误值，且观察器一并失效。
 *    ComfyTV 的做法完全不碰 node.size，只做 CSS 净零高度脉冲，安全得多。
 * ------------------------------------------------------------------------- */
const _nudgePending = new Set();
let _nudgeActive = [];
let _nudgeRevertTimer = 0;
let _nudgePollTimer = 0;

/* 脉冲施加/撤销：只改 CSS 盒模型，不改 node.size。
 *
 * ★★ 净零必须做在【grid 自己】身上（实测踩坑，勿改回 root）：
 *   脉冲的原理是「grid 的 padding-bottom 0→1px」去唤起官方的 widgets-grid
 *   ResizeObserver（signal-only，命中即 scheduleSlotLayoutSync 重测槽位）。
 *   但 grid 是 node-body 里的 flex item，padding +1px 会让**整条纵向布局**
 *   都 +1px：node-body 总高变高 → 面板被挤 1px、节点根高度也 +1px 再弹回 ——
 *   这就是「展开端口胶囊时像果冻一样弹一下」。
 *   正解：给 grid 同时加 margin-bottom:-1px。flex 布局按【outer size】计算，
 *   padding 的 +1px 被 -1px 外距抵消 → node-body 总高不变、面板与节点根
 *   都不动；而 ResizeObserver 观测的是 content-box（padding 变化会改变它），
 *   故仍照常触发重测。
 *   （原先把 -1px 加在节点根 marginBottom 上是无效的：.lg-node 在画布中
 *     绝对定位，margin 影响不到 node-body 内部的布局高度。）
 *
 * ⚠️ 不要在这里「冻结面板高度」当保险（曾试过，反而更糟）：
 *   panel.getBoundingClientRect().height 是**屏幕像素**，含画布 zoom 的
 *   transform:scale；把它当布局像素写回 style.height，在 zoom≠1 时数值就错了
 *   → 面板高度被设成错误值再弹回，表现为「果冻弹一下」。要取布局像素得用
 *   offsetHeight（但既然 grid 净零已成立，这层保险本就多余，索性不要）。 */
function _nudgePoke(roots, on) {
    for (const root of roots) {
        const grid = root.querySelector("[data-widgets-grid-node-id]");
        if (!grid) continue;
        if (on) {
            grid.style.paddingBottom = "1px";
            grid.style.marginBottom = "-1px";     // ← 真正的净零：抵消 padding 增量
        } else {
            grid.style.paddingBottom = "";
            grid.style.marginBottom = "";
        }
    }
}

function nudgeNode(node) {
    if (!node || node.id == null) return;
    _safeCall(() => {
        const root = findRoot(node);
        if (!root) return;
        _nudgePending.add(root);

        if (_nudgePollTimer) return;
        const poll = () => {
            _nudgePollTimer = 0;
            /* 上一轮脉冲尚未撤销 → 稍后再试，避免叠加 */
            if (_nudgeActive.length) { _nudgePollTimer = setTimeout(poll, 60); return; }
            const roots = [];
            for (const r of _nudgePending) if (r.isConnected) roots.push(r);
            _nudgePending.clear();
            if (!roots.length) return;
            _nudgeActive = roots;
            _nudgePoke(roots, true);
            _nudgeRevertTimer = setTimeout(() => {
                _nudgeRevertTimer = 0;
                _safeCall(() => _nudgePoke(_nudgeActive, false), undefined, "撤销槽位脉冲");
                _nudgeActive = [];
                /* ★ 脉冲的作用就是「逼官方重测槽位 DOM」。
                 *  撤销后必须重跑一次上妆，保证变量落在新元素上。 */
                if (!node._a001PortCapsuleOn) return;
                const r = findRoot(node);
                if (!r) return;
                r.classList.add(NODE_CLASS);
                collectClusters(r);
                scheduleMidpointSync(node, r, true);
                _safeCall(() => syncSlotPosFromDom(node, r), undefined, "脉冲后同步端口锚点");
            }, 40);
        };
        _nudgePollTimer = setTimeout(poll, 60);
    }, undefined, "触发官方槽位重测");
}

/* ---------------------------------------------------------------------------
 * syncCapsuleMidpoint(root, cluster) —— 计算桶的垂直中心线，写 CSS 变量
 *
 * ✅ 一比一复刻 ComfyTV shellChrome.ts 的 syncSocketY 算法：
 *     scale = rootRect.height / root.offsetHeight      ← 屏幕高度 ÷ 布局高度 = 画布 zoom
 *     y     = (锚点中线屏幕y - 节点根屏幕y) / scale     ← 换算回「相对节点根」的布局像素
 *   锚点取「官方槽位 .lg-slot 的中线」—— 与官方画连线的端点同源，
 *   故胶囊圆心与线端点天然重合（这是「连接线对得上端口」的根本保证）。
 *
 * ⚠️ 实测踩坑（必读）：
 *   ① 必须除以 zoom。曾用 offsetHeight/2 当基准（=「节点垂直中心」的猜测值），
 *      既不随端口真实位置走，也会被 hover 时的高度变化带偏。
 *   ② 展开态与折叠态的高度不同，锚点必须取「折叠态」的槽位位置。
 *      展开时槽位变成纵向列表，中线会变 → 故展开态沿用折叠态缓存值。
 * ------------------------------------------------------------------------- */
function syncCapsuleMidpoint(root, cluster, _force, nodeArg) {
    if (!root?.tagName || !cluster?.parentElement) return;

    const owner = nodeArg || resolveNode(root);
    const isOpen = cluster.classList?.contains(OPEN_CLASS);

    let mid = NaN;

    if (isOpen && typeof owner?._xzgA001CapMidCache === "number" && owner._xzgA001CapMidCache > 0) {
        /* 展开态：沿用折叠态缓存（面板自己是绝对定位，不影响锚点真值） */
        mid = owner._xzgA001CapMidCache;
    } else {
        /* 折叠态：胶囊钉在「**预览框高度的垂直中心**」（需求指定）。
         * 目标 = 预览框 .xzg-a001-preview 的垂直中线，换算成「相对包裹层 wrap」的布局像素。
         * 桶是相对「包裹层」（node-body 内的槽位区，absolute inset:0）定位的，
         * 故最终要减去包裹层顶部相对节点根的偏移。
         * ⚠️ 不要退回「读 .lg-slot 实测中线」的旧做法 —— 那会把胶囊贴到槽位区顶部。
         *    连线端点不受影响：锚点写的是圆点 DOM 实测位置（syncSlotPosFromDom），
         *    胶囊移到哪，线端点就跟到哪。
         * ⚠️ 若节点内没有预览框（异常/极早期），退回「节点垂直中心」兜底。 */
        const rootRect = root.getBoundingClientRect();
        const rh = root.offsetHeight;
        const wrap = cluster.parentElement;
        if (rh > 0 && rootRect.height > 0 && wrap) {
            /* scale = 屏幕高 ÷ 布局高 = 画布缩放比（复刻 shellChrome.ts 的算法） */
            const scale = rootRect.height / rh || 1;
            const wrapTopRel = (wrap.getBoundingClientRect().top - rootRect.top) / scale;
            /* 预览框垂直中线相对节点根的布局 Y；取不到则退回节点垂直中心（rh/2）。 */
            const previewEl = root.querySelector?.(".xzg-a001-preview");
            let targetRel = rh / 2;
            if (previewEl) {
                const pr = previewEl.getBoundingClientRect();
                if (pr.height > 0) {
                    targetRel = (pr.top + pr.height / 2 - rootRect.top) / scale;
                }
            }
            mid = Math.round(targetRel - wrapTopRel);   /* 取整，避免亚像素抖动 */
        }
        /* 兜底：取不到几何时退回节点中心（仅在首帧极端情况下会走到） */
        if (!Number.isFinite(mid) || mid <= 0) {
            if (!rh) return;
            mid = rh / 2;
        }
        if (owner) owner._xzgA001CapMidCache = mid;
    }

    /* 变量丢失（元素被重建）时强制写入。
     *
     * ★★ 严格差异判定（修复「移动节点时展开控件一闪一闪」，勿放松阈值）：
     *   拖动节点时中心线每拍都会因浮点相位差产生 ±0.3px 级抖动；若照旧写入
     *   inline style，就会唤起本模块/其它模块的 MutationObserver → 又一轮重算 →
     *   表现为持续闪烁。这里把阈值收紧到 0.5px 并要求「空值/跨度变化」才写，
     *   同时用四舍五入后的值比较，彻底消除拖动期的无意义写入。
     *   force 参数已废弃（保留形参仅为兼容既有调用点）：任何「值没变」的情况都不再
     *   写 DOM —— 无谓写入只会制造 mutation 唤醒观察器，对观感只有坏处。 */
    const hasVar = !!cluster.style.getPropertyValue(CAP_MID_VAR);
    const prevRaw = cluster._xzgA001CapMid;
    const prev = typeof prevRaw === "number" ? prevRaw : NaN;
    /* 取整后再比较：拖动期的亚像素抖动不触发写入。 */
    const midRounded = Math.round(mid);
    const prevRounded = Number.isFinite(prev) ? Math.round(prev) : NaN;
    /* 变量已存在且取整后的值没变 → 一律不写（force 也不例外，
     * 因为无谓写入只会制造 mutation 去唤醒观察器，绝不会改善外观）。 */
    if (hasVar && Number.isFinite(prevRounded) && prevRounded === midRounded) return;

    cluster._xzgA001CapMid = midRounded;
    /* 标记「本次 style 变化是本模块自己写的」，让观察器跳过自激那一轮。
     * ★ 用单调时间戳代替「布尔 + setTimeout 复位」：原来两处（此处与观察器回调）
     *   共用同一布尔位并各自起 80ms 定时器，会互相提前清除对方的保护窗口 →
     *   自激窗口被击穿形成低速反馈环。时间戳无复位竞态。 */
    if (owner) owner._xzgA001CapSelfWriteUntil = (performance?.now?.() ?? Date.now()) + 80;
    cluster.style.setProperty(CAP_MID_VAR, `${midRounded}px`);
}

/* ---------------------------------------------------------------------------
 * syncSlotPosFromDom(node, root) —— 自行写回 slot.pos（连线跟随的**决定性**一环）
 *
 * 背景（本轮实测闭合）：
 *   官方 getSlotPosition 的取值顺序是
 *     ① layoutStore.getSlotLayout(key)      ← 有则用它
 *     ② calculateInputSlotPos/OutputSlotPos ← 用 slot.pos（静态属性）
 *   而 A001 上实测：layoutStore **没有** A001 的槽位条目（nudge 脉冲无论
 *   改 grid 的 padding 还是 minHeight，getInputPos 都不跟随 DOM 变化），
 *   于是官方一直读 ② —— 而 slot.pos 是首帧固化值（= 折叠态桶中心 [0,120]），
 *   展开胶囊后圆点已经移位，端点却仍停在旧值上 → **线不跟随**（用户症状）。
 *
 * 因此这里按官方同一套算法自行写回 slot.pos / layoutStore：
 *     scale  = 节点根 DOM 宽 ÷ node.size[0]
 *     relY   = (圆点中心屏幕 Y − 节点根顶部屏幕 Y) ÷ scale − NODE_TITLE_HEIGHT
 *     x      = (圆点中心屏幕 X − 节点根左边缘屏幕 X) ÷ scale
 *     pos    = (x, relY)            ← 相对 node.pos 的画布偏移
 *
 * ⚠️ **必须减 NODE_TITLE_HEIGHT（标题栏高度，默认 30）**：DOM 的节点根（.lg-node）
 *    顶部包含标题栏，而 litegraph 的 node.pos 指向节点**主体**顶部（标题在其上方）。
 *    官方 syncNodeSlotLayoutsFromDOM 写的也是 `(rect.top - nodeRect.top)/scale - NODE_TITLE_HEIGHT`。
 *    实测教训：漏减这一项会得到恒定 30 画布单位（≈16.5 屏幕像素 @scale .55）的 Y 偏移。
 * 抖动阈值 0.05 画布单位，避免无意义写入与重绘。
 * ------------------------------------------------------------------------- */
function dirtyCanvas(node) {
    _safeCall(() => node?.graph?.setDirtyCanvas?.(true, true), undefined, "端口重绘");
}

/* ---------------------------------------------------------------------------
 * 直接写官方布局缓存 layoutStore —— 「连线跟随」的最后一块拼图（实测确认）
 *
 * 【官方新版调用链（实测还原自 settingStore bundle）】
 *   node.getSlotPosition(idx, isInput)
 *     → getSlotPosition(node, idx, isInput)
 *        → 若 graph.vueNodesMode 为真 → getVueSlotPosition(node, idx, isInput)
 *           → getRenderedSlotOffset(node, idx, isInput)
 *              → layoutStore.getSlotOffset(rootGraphId, nodeId, idx,
 *                                          'input'|'output', mode)
 *           → 命中则 [pos.x + off.x, pos.y + off.y]；未命中则走
 *             calculateVueSlotPosition 兜底（把端点堆到槽位区默认位置）
 *
 * 官方 getSlotOffset 实现（原文压缩产物）：
 *   getSlotOffset(e,t,n,r,i){
 *       let a = this.slotOffsets.get(makeScopedLayoutKey(e,t));
 *       return a?.mode === i ? a.byDirection[r].get(n) ?? null : null
 *   }
 *   ——★ 快照带 mode，只有 snapshot.mode === 请求 mode 才返回偏移，否则 null。
 *
 * 官方写入方法：
 *   updateNodeSlotOffsets(rootGraphId, nodeId, slots, mode)
 *     slots = [{ type:'input'|'output', index, position:{x,y} }]
 *     mode  = node.flags.collapsed ? 'collapsed' : 'expanded'
 *
 * ★★ 血泪教训（本轮根因，勿改回）：
 *   旧实现按「具备 getSlotLayout + updateSlotLayout」去识别 layoutStore —— 那是
 *   **上一代 API**，本机 bundle 里这两个方法根本不存在（实测均为 undefined）。
 *   于是 findLayoutStore() 恒返回 null，pushSlotLayouts 从未真正写入过任何东西，
 *   连线端点只能吃官方首帧固化的重合值 → 「展开胶囊后连线不分散到对应端口」。
 *
 * 该 store 未挂在 window / pinia 上（是模块单例），打包后导出名被压缩，**绝不能
 * 硬编码**。故仍按「方法特征」动态识别，但判据换成新 API：同时具备 getSlotOffset
 * 与 updateNodeSlotOffsets。识别结果缓存在 Promise 里；拿不到时静默降级。
 * ------------------------------------------------------------------------- */
let _layoutStorePromise = null;

function findLayoutStore() {
    if (_layoutStorePromise) return _layoutStorePromise;
    _layoutStorePromise = (async () => {
        try {
            const urls = performance.getEntriesByType("resource")
                .map((e) => e.name)
                .filter((n) => n.indexOf("/assets/") >= 0 && n.slice(-3) === ".js");
            /* 主 bundle 优先；再兜底试少量其它 chunk（题目不在多，在于快速失败）。 */
            const ordered = urls
                .filter((u) => u.indexOf("settingStore") >= 0)
                .concat(urls.filter((u) => u.indexOf("settingStore") < 0).slice(0, 8));
            for (const u of ordered) {
                try {
                    const mod = await import(u);
                    for (const k of Object.keys(mod)) {
                        const v = mod[k];
                        if (v && typeof v === "object"
                            && typeof v.getSlotOffset === "function"
                            && typeof v.updateNodeSlotOffsets === "function") {
                            _alog("[A001_port_capsule] 已接入官方 layoutStore（新 API）");
                            return v;
                        }
                    }
                } catch (_e) { /* 单个 chunk 失败不影响整体 */ }
            }
        } catch (_e) { /* 整体失败：降级 */ }
        _alog("[A001_port_capsule] 未取到 layoutStore，仅写 slot.pos（降级）");
        return null;
    })();
    return _layoutStorePromise;
}

/** 取节点所属 rootGraph 的 id（官方 makeScopedLayoutKey 的第一段）。 */
function rootGraphIdOf(node) {
    return _safeCall(() => {
        const g = node?.graph;
        return g?.rootGraph?.id ?? g?.id ?? null;
    }, null, "取 rootGraphId");
}

/**
 * 把 DOM 实测到的槽位几何写进官方 layoutStore（幂等，官方自带相等短路）。
 *
 * ★ 坐标口径（与官方严格对齐，勿改）：
 *   官方 getVueSlotPosition 做的是 `[node.pos[0] + off.x, node.pos[1] + off.y]`，
 *   即 **off 是「相对 node.pos（节点主体左上角）」的画布单位偏移**。
 *   本函数的 entries[].rx/ry 正是这个口径（由 syncSlotPosFromDom 算出），
 *   故直接透传为 position，**不要再叠加 node.pos**。
 *
 * ★ mode 必须是 `"expanded"`：官方 getSlotOffset 严格校验
 *   `snapshot.mode === 请求mode`，否则返回 null → 端点塌回默认位置。
 *   A001 的「胶囊展开」是 hover 行为，`node.flags.collapsed` 恒为 false，
 *   官方请求的 mode 因此恒为 "expanded"。若节点真被 litegraph 折叠
 *   （flags.collapsed === true），官方请求 "collapsed"，此时按折叠态写入即不会命中，
 *   端点交给官方兜底计算——这也是正确行为（折叠节点本就不显示各行端口）。
 *
 * @param {object} node
 * @param {Array<{key:string,index:number,isInput:boolean,rx:number,ry:number}>} entries
 */
function pushSlotLayouts(node, entries) {
    const rgId = rootGraphIdOf(node);
    const nodeId = node?.id;
    if (rgId == null || nodeId == null || !entries.length) return;

    /* 节点被 litegraph 折叠时不写快照（官方按 "collapsed" 查，写进去也不会命中）。 */
    if (node?.flags?.collapsed) return;

    findLayoutStore().then((ls) => {
        if (!ls) return;
        const slots = [];
        for (const it of entries) {
            slots.push({
                type: it.isInput ? "input" : "output",
                index: it.index,
                position: { x: it.rx, y: it.ry },
            });
        }
        /* ★ 真差分判定（性能 + 杜绝重绘反馈环）：
         *  先按官方 getSlotOffset 读回现有快照逐项比对，仅在几何真变化时才写入。
         *  （官方 updateNodeSlotOffsets 内部虽也有相等短路，但它整批比对；
         *    这里先读可避免无谓的整批写入与 queueGeometryChange。） */
        let changed = false;
        for (const s of slots) {
            const prev = _safeCall(
                () => ls.getSlotOffset(rgId, nodeId, s.index, s.type, "expanded"),
                undefined, "读官方槽位偏移"
            );
            if (!prev
                || Math.abs(prev.x - s.position.x) >= 0.05
                || Math.abs(prev.y - s.position.y) >= 0.05) {
                changed = true;
                break;
            }
        }
        if (!changed) return;
        _safeCall(
            () => ls.updateNodeSlotOffsets(rgId, nodeId, slots, "expanded"),
            undefined, "写官方槽位偏移"
        );
        dirtyCanvas(node);
    }).catch(() => { /* 降级：仅 slot.pos 生效 */ });
}

function syncSlotPosFromDom(node, root) {
    const sizeW = node?.size?.[0];
    const rr = root?.getBoundingClientRect?.();
    /* 注意：node.size 在 Nodes 2.0 里可能是普通数组、Float32Array 或类数组对象，
     * 一律用 node.size?.[0] 取值，**不要**用 Array.isArray 判定（会误判为空）。 */
    if (!(sizeW > 0) || !(rr && rr.width > 0)) return 0;

    const scale = rr.width / sizeW;
    if (!(scale > 0)) return 0;

    /* 标题栏高度（默认 30）：DOM 节点根顶部含标题栏，而 node.pos 指向节点主体顶部，
     * 官方同款换算同样要减这一项，否则整体 Y 偏 30 画布单位（实测教训）。 */
    const titleH = Number(_safeCall(() => window.LiteGraph?.NODE_TITLE_HEIGHT, undefined, "取标题栏高")) || 30;

    const byKey = new Map();
    for (const el of root.querySelectorAll("[data-slot-key]")) {
        const k = el.getAttribute("data-slot-key");
        if (k && !byKey.has(k)) byKey.set(k, el);
    }
    if (!byKey.size) return 0;

    let n = 0;
    /* 同时收集给官方 layoutStore 用的条目：官方 getSlotPosition **优先**读它，
     * 只写 slot.pos 会被它遮蔽（实测），故两处必须一起写。 */
    const entries = [];
    const write = (slots, tag) => {
        if (!Array.isArray(slots)) return;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            const el = byKey.get(`${node.id}-${tag}-${i}`);
            if (!slot || !el) continue;
            const r = el.getBoundingClientRect();
            if (!(r.width > 0) && !(r.height > 0)) continue;
            const x = (r.left + r.width / 2 - rr.left) / scale;
            const y = (r.top + r.height / 2 - rr.top) / scale - titleH;
            /* 位置没变也要收集 —— layoutStore 里可能仍留着首帧的旧几何。 */
            entries.push({ key: `${node.id}-${tag}-${i}`, index: i, isInput: tag === "in", rx: x, ry: y });
            const prev = slot.pos;
            if (prev && Math.abs(prev[0] - x) < 0.05 && Math.abs(prev[1] - y) < 0.05) continue;
            slot.pos = [x, y];
            n++;
        }
    };
    write(node.inputs, "in");
    write(node.outputs, "out");

    if (n) dirtyCanvas(node);
    if (entries.length) pushSlotLayouts(node, entries);
    return n;
}

/* 由节点根反查 node 对象（用于拿到 _xzgA001CapSelfWriteUntil 抑制窗口标记位） */
function resolveNode(root) {
    const id = root?.getAttribute?.("data-node-id");
    if (id == null) return null;
    const nodes = window?.app?.graph?._nodes || [];
    for (const n of nodes) {
        if (String(n.id) === String(id)) return n;
    }
    return null;
}

/* ---------------------------------------------------------------------------
 * 查找节点根 DOM（与 A001_Appearance.js 的 findNodeRoot 同源策略）
 * ------------------------------------------------------------------------- */
function findRoot(node) {
    /* ⚠️ 实测踩坑（必读）：Vue 重建节点根元素后，旧引用可能仍然 isConnected
     * （Vue 复用宿主 div 只重置 class），此时若直接返回缓存，就会拿到
     * 「丢了 NODE_CLASS 的根」→ 换皮 CSS 全失配。
     * 故：缓存元素虽连接但已丢失 NODE_CLASS 时，视为失效，重新查询。 */
    const cached = node?._a001DomRoot;
    if (cached?.isConnected && (!node._a001PortCapsuleOn || cached.classList.contains(NODE_CLASS))) {
        return cached;
    }
    const id = node?.id;
    if (id == null) return null;
    /* ★ 清洗 id 再拼选择器：node.id 可能来自工作流/剪贴板，含特殊字符会破坏选择器语法。 */
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "");
    if (!safeId) return null;
    /* 合并为单次查询：`[data-node-id="N"]` 已覆盖 `.lg-node[data-node-id="N"]`，
     * 原实现三次串行 document.querySelector 属冗余（cache miss 时每节点多两次全文档查询）。 */
    const root = document.querySelector(`[data-node-id="${safeId}"]`);
    if (root) node._a001DomRoot = root;
    return root;
}

/* ---------------------------------------------------------------------------
 * 查找「端口桶」DOM —— 框架为节点生成的输入/输出槽位容器
 *
 * 官方 DOM 层级实测为三层（与 ComfyTV 逐层同构）：
 *   G1「节点主体」                     ← 相当于 ComfyTV 的 [data-testid^="node-body-"]
 *     P1「槽位区」flex min-w-0 justify-between  ← 相当于 ComfyTV 的 > div:first-child
 *       C0「桶」flex flex-col + 若干 .lg-slot    ← 相当于 ComfyTV 的 > div
 * ComfyTV 的做法：
 *   · P1 → position:absolute; inset:0; pointer-events:none （撑满覆盖层，**不塌陷**）
 *   · C0 → position:absolute; top:var(--v2-socket-y)       （桶，脱离流）
 * 只对 C0 绝对定位而漏掉 P1 的 inset:0 时，P1 会因内容全部脱离流而塌陷成 0 高
 * → 官方从 DOM 读到的槽位几何全错 → 连线端点与端口错位。故此处必须同时给 P1 打类名。
 *
 * ⚠️ 只处理「槽位区」里的槽位：控件行（.lg-node-widgets 内的 dot-only InputSlot）
 *    也是 .lg-slot--input，但它们属于控件网格，不是端口胶囊的对象，必须排除，
 *    否则每个控件行左侧都会多出一个圆点胶囊。
 * ------------------------------------------------------------------------- */
function collectClusters(root) {
    const out = [];
    const pairs = [
        ["in", ".lg-slot--input, .lg-slot[data-slot-type='input']"],
        ["out", ".lg-slot--output, .lg-slot[data-slot-type='output']"],
    ];
    for (const [dir, sel] of pairs) {
        const slots = root.querySelectorAll(sel);
        for (const slot of slots) {
            /* 排除控件网格内的槽位（提升控件行 / 锚点行） */
            if (typeof slot.closest === "function" && slot.closest(".lg-node-widgets")) continue;
            const cluster = slot.parentElement;
            if (!cluster || cluster === root) continue;
            /* 包裹层 = 桶的父元素（复刻 ComfyTV 的 node-body > div:first-child） */
            const wrap = cluster.parentElement;
            if (wrap && wrap !== root && !wrap.classList.contains(NODE_CLASS)) {
                wrap.classList.add(WRAP_CLASS);
            }
            if (out.includes(cluster)) continue;
            cluster.dataset.dir = dir;
            cluster.classList.add(CAP_CLASS);
            out.push(cluster);
        }
    }
    return out;
}

/* ---------------------------------------------------------------------------
 * 「布局变动抑制」常量
 *
 * ★ 历史背景（已随「改点击展开」而弱化，但抑制机制仍保留）：
 *   原先胶囊靠 pointerenter（hover）展开，而 pointerenter 会在「指针不动、
 *   元素自己被布局推到指针底下」时也触发 —— 点「展开/收起控件」按键时，
 *   控件网格从 0 长到整块高会把桶推到指针下，浏览器补发 pointerenter → 胶囊莫名展开。
 *   为此设了「幻影 hover 过滤」（指针未移动即忽略）+ suppressA001CapsuleOpen 双防线。
 *   现在展开改为「点击」，pointerenter 不再参与展开，幻影问题自然消失；
 *   但 suppressA001CapsuleOpen 仍保留 —— 它在布局大变动时**收起已展开的桶**，
 *   避免用户点「收起控件」后面板残留（见其函数注释）。
 * ------------------------------------------------------------------------- */
/* 抑制窗口**上限**（自适应）：几何稳定即提前解除，通常远早于此值。
 * 留足上限是为了覆盖「Vue 重建 + 高度过渡」的长尾变动链 —— 真正的解除时机
 * 由几何指纹巡检决定（见 startCapSuppressWatch），不由这个数字决定。 */
const SUPPRESS_DEFAULT_MS = 900;
/* 连续多少帧几何指纹不变，即判定「布局已稳定」，可提前解除抑制。 */
const SUPPRESS_STABLE_FRAMES = 4;

/* ---------------------------------------------------------------------------
 * 点击展开意图绑定（由 hover 改为 click）
 *
 * 展开：单击圆点 → 加 OPEN_CLASS → nudgeNode（盒模型变了要重测）+ 同步中线/槽位
 * 收起：① 再次单击同一圆点；② 点击面板**之外**任意位置（document 捕获阶段）
 * 说明：原 hover 展开（pointerenter/leave + 幻影过滤）已整体移除，语义更纯粹、
 *       不会因布局变动补发的 pointerenter 误展开。
 * ------------------------------------------------------------------------- */
function bindClusterClickIntent(node, root, cluster) {
    if (cluster.dataset.xzgA001Click === "1") return;
    cluster.dataset.xzgA001Click = "1";

    const onPointerDown = (e) => {
        /* 只处理左键（右键留给官方上下文菜单）。 */
        if (e.button !== 0) return;
        /* ★ 刻意**不**调用 preventDefault / stopPropagation：
         *  圆点内芯是官方槽位，用户仍可能从它拖出连线。若在此阻断事件，
         *  会破坏官方拖线。我们只是「顺带切换面板显隐」，不与官方争事件。 */
        const isOpen = cluster.classList.contains(OPEN_CLASS);
        if (isOpen) {
            closeCluster(node, root, cluster);   // 再次点击同一圆点 → 收起
        } else {
            openCluster(node, root, cluster);    // 点击圆点 → 展开（同时收起其它桶）
        }
    };
    /* 具名句柄存元素上，供 detach 精确解绑（匿名监听无法 removeEventListener）。 */
    cluster._xzgA001ClickHandlers = { onPointerDown };
    /* ★ 用**捕获阶段**监听：官方槽位内部（.lg-slot / .group slot）可能对 pointerdown
     *  做 stopPropagation，冒泡阶段会漏掉点击（实测：有时第一次点击无效）。
     *  捕获阶段先于目标/冒泡执行，保证圆点的点击必定被我们收到。 */
    cluster.addEventListener("pointerdown", onPointerDown, true);
    /* ★ 登记本节点参与「点击外部收起」，并在首次绑定时安装全局监听（幂等）。 */
    ensureCapsuleOutsideCloseHook();
}

/** 展开某个桶：同时收起该节点的其它桶（保证同节点只开一个），并触发官方重测。 */
function openCluster(node, root, cluster) {
    if (!cluster || !root) return;
    /* 同节点其它桶先收起，避免同时展开左右两端造成布局抖动。 */
    const others = root.querySelectorAll(`.${CAP_CLASS}.${OPEN_CLASS}`);
    for (const o of others) {
        if (o !== cluster) {
            o.classList.remove(OPEN_CLASS);
        }
    }
    document.body.setAttribute("data-xzg-a001-slot-hover", "1");
    if (!cluster.classList.contains(OPEN_CLASS)) {
        cluster.classList.add(OPEN_CLASS);
        nudgeNode(node);                 // ← 展开改变了槽位占位，必须触发官方重测
        scheduleMidpointSync(node, root);
        /* ★ 决定性一步：写回各槽位的 slot.pos，让连线端点跟到圆点上。
         *  延迟 180ms 是为了等 .lg-slot 的 height 过渡（.12s）跑完。 */
        scheduleSlotPosSync(node, root);
    }
}

/** 收起某个桶，并同步中线 / 槽位（幂等）。 */
function closeCluster(node, root, cluster) {
    if (!cluster) return;
    document.body.removeAttribute("data-xzg-a001-slot-hover");
    cluster.classList.remove(OPEN_CLASS);
    nudgeNode(node);                     // ← 收起同样要重测
    if (root) {
        scheduleMidpointSync(node, root);
        scheduleSlotPosSync(node, root); // ← 同上：端点回到折叠态圆心
    }
}

/* ── 点击「面板之外」收起：document 级捕获监听（全局安装一次） ── */
let _capsuleOutsideCloseHooked = false;

function ensureCapsuleOutsideCloseHook() {
    if (_capsuleOutsideCloseHooked || typeof document === "undefined") return;
    _capsuleOutsideCloseHooked = true;
    const onDocPointerDown = (e) => {
        /* 仅在「点击发生在任何已展开胶囊之外」时收起，避免把展开操作本身当成外部点击。
         * 用 closest 判定：目标位于某桶内 → 交给桶自身的 pointerdown 处理，不在此收起。 */
        const t = e.target;
        if (t && typeof t.closest === "function" && t.closest(`.${CAP_CLASS}`)) return;
        closeAllOpenClusters();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
}

/** 收起页面上所有已展开的桶（点击外部 / 全局场景使用）。 */
function closeAllOpenClusters() {
    if (typeof document === "undefined") return;
    const open = document.querySelectorAll(`.${CAP_CLASS}.${OPEN_CLASS}`);
    if (!open.length) return;
    document.body.removeAttribute("data-xzg-a001-slot-hover");
    for (const c of open) {
        c.classList.remove(OPEN_CLASS);
        /* 找到其所属节点以便触发官方重测（root 通过 data-node-id 反查）。 */
        const rootEl = c.closest(`.${NODE_CLASS}`);
        const nid = rootEl && rootEl.getAttribute("data-node-id");
        const node = nid != null ? _findNodeById(nid) : null;
        if (node && rootEl) {
            nudgeNode(node);
            scheduleMidpointSync(node, rootEl);
            scheduleSlotPosSync(node, rootEl);
        }
    }
}

/** 由 data-node-id 反查活节点（供外部点击收起时触发官方重测）。
 *  覆盖根图与所有子图（A004 等节点可能位于子图内）；全部失败则返回 null。 */
function _findNodeById(id) {
    const g0 = (typeof window !== "undefined" && window?.app?.graph) ? window.app.graph : null;
    if (!g0) return null;
    const root = g0.rootGraph || g0;
    const seen = new Set();
    const stack = [root, g0];
    while (stack.length) {
        const g = stack.pop();
        if (!g || seen.has(g)) continue;
        seen.add(g);
        let hit = null;
        try { if (typeof g.getNodeById === "function") hit = g.getNodeById(id); } catch (e) { /* 忽略 */ }
        if (!hit) {
            const ns = g._nodes || g.nodes || [];
            for (const n of ns) { if (n && String(n.id) === String(id)) { hit = n; break; } }
        }
        if (hit) return hit;
        for (const n of (g._nodes || g.nodes || [])) {
            if (n && n.subgraph) stack.push(n.subgraph);
        }
    }
    return null;
}

/** 解绑某个桶上的点击监听与遗留定时器（幂等）。 */
function unbindClusterClickIntent(cluster) {
    if (!cluster) return;
    cluster._xzgA001SuppressedEnter = false;
    if (cluster._xzgA001LeaveTimer) {
        clearTimeout(cluster._xzgA001LeaveTimer);
        cluster._xzgA001LeaveTimer = null;
    }
    const h = cluster._xzgA001ClickHandlers;
    if (h) {
        cluster.removeEventListener("pointerdown", h.onPointerDown, true);
        cluster._xzgA001ClickHandlers = null;
    }
    cluster.dataset.xzgA001Click = "";
    /* 解绑时顺带收起（桶可能正处于展开态），避免残留 OPEN_CLASS 影响重新上妆。 */
    if (cluster.classList.contains(OPEN_CLASS)) {
        cluster.classList.remove(OPEN_CLASS);
    }
}

/**
 * suppressA001CapsuleOpen(node, ms) —— 布局大变动前后「收起已展开的桶」。
 *
 * ★ 现状（改为点击展开后）：
 *   展开已不再由 hover 触发，故不再需要「过滤幻影 pointerenter」这道防线；
 *   本函数保留的实际价值是**在布局大变动时把已展开的桶收起** —— 用户点
 *   「展开/收起控件」会引发控件网格从 0 长到整块高、槽位占位与圆点位置整体变化，
 *   若此刻面板仍开着，其锚点与尺寸都会错位。故此处显式收口，保证观感稳定。
 *
 * ★ 窗口长度**自适应**，不是固定时长：
 *   固定窗口（原 320ms）盖不住长尾变动链 ——「收起/展开控件」会连续触发 nudge 脉冲、
 *   setSize、Vue 重排控件行、滑条/编辑器重挂，桶被推移的时刻可能晚于 320ms。
 *   故这里给足上限，同时逐帧巡检几何指纹：连续数帧不变即判定布局稳定、**立即**收口，
 *   兼顾「挡得住」与「不迟钝」。
 *
 * @param {object} node A001 节点
 * @param {number} [ms] 抑制窗口上限，默认 SUPPRESS_DEFAULT_MS（布局稳定会提前解除）
 */
export function suppressA001CapsuleOpen(node, ms) {
    if (!node) return false;
    return !!_safeCall(() => {
        const root = findRoot(node);
        if (!root) return false;
        const cap = Number.isFinite(ms) ? ms : SUPPRESS_DEFAULT_MS;
        const now = performance?.now?.() ?? Date.now();
        node._xzgA001CapSuppressUntil = now + cap;
        /* 抑制窗口内已展开的桶：立即收起并重算中心线，回到「圆点」形态。 */
        const clusters = root.querySelectorAll(`.${CAP_CLASS}`);
        for (const c of clusters) {
            c._xzgA001SuppressedEnter = false;   // 新一轮抑制：清掉上一轮的待复核标记
            if (c.classList.contains(OPEN_CLASS)) {
                c.classList.remove(OPEN_CLASS);
                /* 收起态几何变了 → 重算一次中心线（幂等）。 */
                syncCapsuleMidpoint(root, c, true, node);
            }
        }
        startCapSuppressWatch(node, cap);
        return true;
    }, false, "抑制端口胶囊展开");
}

/**
 * startCapSuppressWatch(node, capMs) —— 逐帧巡检，布局稳定后提前解除抑制窗口。
 *
 * 判据用 _capsuleGeomSig（节点根与各桶的 offsetHeight / offsetTop）：
 * 它是「布局像素」，与画布 zoom 无关，只有真正的布局变化才会改变 —— 因此高度
 * 过渡跑完、Vue 重排结束后它自然恒定，不会像 getBoundingClientRect 那样在
 * 缩放动画期连续微变导致判不稳定。
 *
 * 兜底：超过 capMs 仍未稳定则强制收口；节点被删 / 根丢失则立即收口
 * （避免窗口残留，让后续的真实悬停被白白挡掉）。
 */
function startCapSuppressWatch(node, capMs) {
    const raf = typeof window !== "undefined" ? window.requestAnimationFrame : null;
    if (typeof raf !== "function") return;
    if (node._xzgA001CapWatchRaf) {
        /* 上一轮巡检还在跑：取消它，改由本轮重新计时（幂等，避免两轮并存）。 */
        const cancel = (typeof cancelAnimationFrame === "function") ? cancelAnimationFrame : clearTimeout;
        _safeCall(() => cancel(node._xzgA001CapWatchRaf), undefined, "取消上一轮抑制巡检");
        node._xzgA001CapWatchRaf = 0;
    }
    const start = performance?.now?.() ?? Date.now();
    let lastSig = null;
    let stable = 0;
    const step = () => {
        node._xzgA001CapWatchRaf = 0;
        const root = findRoot(node);
        if (!root) {                                  // 节点被删 / DOM 没了：直接解除
            node._xzgA001CapSuppressUntil = 0;
            return;
        }
        const now = performance?.now?.() ?? Date.now();
        const sig = _capsuleGeomSig(root);
        if (sig === lastSig) stable += 1; else { stable = 1; lastSig = sig; }
        if (stable >= SUPPRESS_STABLE_FRAMES || (now - start) >= capMs) {
            node._xzgA001CapSuppressUntil = now;      // 布局已稳定 → 立即收口
            releaseSuppressedHover(node, root);       // 收尾：清理抑制期间登记的标记
            return;
        }
        node._xzgA001CapWatchRaf = raf(step);
    };
    node._xzgA001CapWatchRaf = raf(step);
}

/**
 * releaseSuppressedHover(node, root) —— 抑制窗口解除时的收尾。
 *
 * ★ 已改为「点击展开」：不再有「被布局变动补发的悬停意图」需要补开，
 *   故此处只清理抑制期间在桶上登记的标记；函数名保留以兼容既有调用点。
 */
function releaseSuppressedHover(node, root) {
    /* 已改为「点击展开」：不再存在「被抑制挡下的悬停意图」需要补开，
     * 此处只清理抑制期间登记的标记（保留函数名以兼容既有调用点）。 */
    _safeCall(() => {
        const clusters = root.querySelectorAll(`.${CAP_CLASS}`);
        for (const c of clusters) {
            if (c._xzgA001SuppressedEnter) c._xzgA001SuppressedEnter = false;
        }
    }, undefined, "解除抑制后清理标记（点击展开模式下无补开动作）");
}

/* ---------------------------------------------------------------------------
 * _capsuleGeomSig(root) —— 端口几何指纹（用于「零写入」判据）
 *
 * 由「节点根布局高 + 每个桶的布局高/偏移」拼成字符串。巡检只在指纹变化时
 * 才排程重算中心线，从而让健康（几何未变）节点在巡检中**完全不写 DOM**。
 *
 * ★ 为什么用 offsetHeight 而非 getBoundingClientRect：
 *   rect 含画布 zoom 的 transform:scale（屏幕像素），缩放动画期间会连续微变，
 *   导致指纹抖动 → 每拍都判「变了」→ 又回到高频重算。offsetHeight 是布局像素，
 *   与 zoom 无关，只有真正的布局变化才会改变它。
 * ------------------------------------------------------------------------- */
function _capsuleGeomSig(root) {
    return _safeCall(() => {
        const rh = root?.offsetHeight || 0;
        const clusters = root.querySelectorAll(`.${CAP_CLASS}`);
        let s = String(rh);
        for (const c of clusters) {
            s += "|" + (c.offsetHeight || 0) + ":" + (c.offsetTop || 0);
        }
        return s;
    }, "", "取端口几何指纹");
}

/* ---------------------------------------------------------------------------
 * 排程一次中心线同步（rAF 批处理，避免同帧多次读写引发布局抖动）
 * force = true 时忽略「差值小于 0.5px 就跳过」的优化，强制重写变量。
 * ------------------------------------------------------------------------- */
function scheduleMidpointSync(node, root, force) {
    if (node._xzgA001CapSyncRaf) return;
    const run = () => {
        node._xzgA001CapSyncRaf = 0;
        _safeCall(() => {
            const r = (root?.isConnected ? root : null) || findRoot(node);
            if (!r) return;
            const clusters = r.querySelectorAll(`.${CAP_CLASS}`);
            for (const c of clusters) syncCapsuleMidpoint(r, c, force, node);
        }, undefined, "同步胶囊中心线");
    };
    if (typeof requestAnimationFrame === "function") {
        node._xzgA001CapSyncRaf = requestAnimationFrame(run);
    } else {
        node._xzgA001CapSyncRaf = setTimeout(run, 16);
    }
}

/* ---------------------------------------------------------------------------
 * scheduleSlotPosSync —— 延迟一拍再写 slot.pos
 *
 * 展开/收起的行高过渡是 .12s，立即测量会拿到过渡中的中间几何，
 * 故默认等 180ms 再写；随后 geometry 稳定，端点正好落在圆点圆心。
 * ------------------------------------------------------------------------- */
function scheduleSlotPosSync(node, root, delay) {
    if (!node?._a001PortCapsuleOn) return;
    /* ★ 同键覆盖 + 存句柄：展开/收起连点会排队多个同义定时器（都只写同一个 slot.pos），
     *  只保留最后一次即可；由 detachA001PortCapsule 统一 clearTimeout。 */
    if (node._a001SlotPosSyncTimer) clearTimeout(node._a001SlotPosSyncTimer);
    node._a001SlotPosSyncTimer = setTimeout(() => {
        node._a001SlotPosSyncTimer = 0;
        if (!node._a001PortCapsuleOn) return;
        const r = (root?.isConnected ? root : null) || findRoot(node);
        if (!r) return;
        _safeCall(() => syncSlotPosFromDom(node, r), undefined, "同步端口锚点");
    }, typeof delay === "number" ? delay : 180);
}

/* ---------------------------------------------------------------------------
 * DOM 观察器：框架异步渲染，槽位/尺寸会变，需要持续跟几何
 * ------------------------------------------------------------------------- */

/** 预览框选择器：该子树内的样式变更与槽位几何无关（对比层拖动会高频改写它）。 */
const PREVIEW_SEL = ".xzg-a001-preview";

/**
 * 判断一批变更是否**全部**发生在预览框内部。
 * 保守策略：只要有一条来自预览框之外就返回 false（照常走完整重算），
 * 保证「节点重排 / 槽位重建」这类真正需要跟随的变更不会被误忽略。
 */
function _allMutationsInPreview(mutations) {
    if (!mutations?.length) return false;
    for (const m of mutations) {
        const t = m.target;
        /* target 可能是文本节点（无 closest），回退到其父元素。 */
        const el = t?.closest ? t : t?.parentElement;
        if (!el?.closest) return false;
        if (!el.closest(PREVIEW_SEL)) return false;
    }
    return true;
}

/**
 * 起「节点根观察器」—— **绑在画布稳定层，不绑节点根**（本轮一体化改造的关键修复）。
 *
 * ★★ 为什么必须改绑画布层（实测踩坑，勿改回节点根）：
 *   原实现 `obs.observe(root, ...)` 把观察器绑在**节点根元素**上。Vue 一旦把节点根
 *   **整体替换**（执行态切换 / setSize / touchInputs / 切图都会触发），旧观察器所观测
 *   的元素就永久脱离文档 —— 从此**再也收不到任何回调**；而「检测到根被替换 → 重绑」
 *   这段逻辑本身要靠回调触发 → **死锁**。唯一出口只剩 1200ms 全局巡检，
 *   这正是「拉伸/收起后闪一下才恢复」的最长空窗来源。
 *   改绑画布稳定层后：节点根无论如何重建，稳定层始终在文档中、观察器始终存活，
 *   每次回调里重新 findRoot 即可发现新根并续上，空窗压到同帧。
 *
 * ★ 过滤：只关心「变更目标所属的节点」是否是本节点，避免其它节点的重排唤醒本节点。
 *   同时忽略本模块自己写 inline style 引发的那一轮（防自激，同原实现）。
 */
/* ── 端口观察器：模块级单例（2026-10-05 收敛）──
 * 改造前：每个节点各 new 一个 MutationObserver 观察同一个「画布稳定层」子树，
 *   N 个节点 = N 个观察器同时盯同一批 DOM 变更，且每个都要各自遍历 mutations 做
 *   closest 过滤 → 回调与过滤总成本 O(N×M)。
 * 现改为「模块级唯一观察器 + nodeId 注册表」：单例回调先按 data-node-id 把 mutations
 *   分组，只把「属于该节点」的那批分发给它，未受影响的节点完全不执行。
 *   各节点原有判定逻辑逐字保留（原先的 mine 过滤已由分组代劳，故移除）。 */
let _capMO = null;
let _capMOTarget = null;
const _capMOBindings = new Map();   // String(nodeId) -> node

/** 按 data-node-id 把 mutations 分组（单次遍历，供分发给各节点）。 */
function _capGroupMutations(mutations) {
    const byId = new Map();
    for (const m of mutations) {
        const t = m.target;
        const el = t?.closest ? t : t?.parentElement;
        if (!el?.closest) continue;
        const owner = el.closest("[data-node-id]");
        if (!owner) continue;
        const id = String(owner.getAttribute("data-node-id"));
        let arr = byId.get(id);
        if (!arr) { arr = []; byId.set(id, arr); }
        arr.push(m);
    }
    return byId;
}

/** 起 / 重绑单例观察器（幂等；目标失效时自动重绑）。 */
function _ensureCapMO(target) {
    if (_capMO && _capMOTarget === target && _capMOTarget.isConnected) return;
    if (_capMO) _safeCall(() => _capMO.disconnect(), undefined, "断开旧端口观察器");
    _capMO = new MutationObserver((mutations) => {
        const byId = _capGroupMutations(mutations);
        if (!byId.size) return;
        for (const [id, ms] of byId) {
            const bound = _capMOBindings.get(id);
            const fn = bound?._xzgA001CapOnMutations;
            if (typeof fn !== "function") continue;
            _safeCall(() => fn(ms), undefined, "端口观察器重算中心线");
        }
    });
    _capMOTarget = target;
    _capMO.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class"],
    });
}

function startObserver(node /*, root */) {
    /* 目标层：画布容器（与 A001_Appearance 的面板守卫、A001_restore 同口径）。 */
    const target = _safeCall(() => {
        const c = window?.app?.canvas?.canvas?.parentElement;
        if (c) return c;
        return document.body;
    }, null, "取端口观察目标（画布稳定层）");
    if (!target) return;

    /* ★ 首次为节点登记的按节点回调（幂等）。哨兵沿用 _xzgA001CapObserver（值为 true），
     *   以免改动外部既有判据；真实观察器已上提为模块级单例 _capMO。 */
    if (!node._xzgA001CapObserver) {
        node._xzgA001CapObserver = true;
        node._xzgA001CapOnMutations = (mutations) => {
            /* 防自激：本模块也会往桶元素写 inline style（--xzg-a001-cap-mid），
             * 那会再次唤醒观察器。用短抑制窗口挡住「自己造成的」那一轮。 */
            const nowMs = performance?.now?.() ?? Date.now();
            if (node._xzgA001CapSelfWriteUntil && nowMs < node._xzgA001CapSelfWriteUntil) return;
            /* 再排除「全部变更都在预览框内」的情况（对比层拖动会高频改它，与槽位无关）。 */
            if (_allMutationsInPreview(mutations)) return;

            node._xzgA001CapSelfWriteUntil = (performance?.now?.() ?? Date.now()) + 80;
            _safeCall(() => {
                const r = findRoot(node);
                if (!r || !node._a001PortCapsuleOn) return;
                /* 根被替换 / 类名或胶囊丢失 → 整轮重建（tick 内含补类名、绑 hover、
                 * 写中心线、同步 slot.pos，全部幂等），使外观与交互同帧续上。 */
                const lost = !r.classList.contains(NODE_CLASS) || !r.querySelector(`.${CAP_CLASS}`);
                if (lost) {
                    tick(node);
                    return;
                }
                r.classList.add(NODE_CLASS);
                collectClusters(r);              // 元素被重建 → 类名要补回
                scheduleMidpointSync(node, r, true);
                _safeCall(() => syncSlotPosFromDom(node, r), undefined, "重建后同步端口锚点");
            }, undefined, "端口观察器重算中心线");
        };
    }
    _capMOBindings.set(String(node.id), node);
    node._xzgA001CapObsTarget = target;
    /* 兼容旧字段：guardBeat 以 _xzgA001CapObservedRoot 判断「是否已观测到根」，
     * 该语义现在改为「观察器已就绪」，用当前根填充以免干扰既有判据。 */
    node._xzgA001CapObservedRoot = findRoot(node);
    _ensureCapMO(target);
}

/* ---------------------------------------------------------------------------
 * applyCapsule(node) —— 单次「上妆」：找桶 + 换皮 + 绑事件 + 算中心线
 * 可重复调用（幂等），框架重渲染后由 tick 再调一次即可。
 * ------------------------------------------------------------------------- */
function applyCapsule(node, force) {
    const root = findRoot(node);
    if (!root) return false;

    /* 前置依赖：网格宿主必须存在，否则说明 A001_grid_anchor 未生效，
     * 此时框架不会生成标准槽位结构，硬上妆只会做出错位外观 → 静默退出。 */
    if (!root.querySelector("[data-widgets-grid-node-id]")) return false;

    root.classList.add(NODE_CLASS);

    const clusters = collectClusters(root);
    if (!clusters.length) return false;

    for (const cluster of clusters) {
        bindClusterClickIntent(node, root, cluster);
        /* force=true：首次上妆 / 抖动后校正时强制写变量，
         * 因为元素可能是 Vue 刚重建的（没有 inline style）。 */
        syncCapsuleMidpoint(root, cluster, force, node);
    }
    /* ★ 每轮上妆都校准一次 slot.pos：把连线端点钉到圆点上（幂等，带 0.05 抖动阈值）。 */
    _safeCall(() => syncSlotPosFromDom(node, root), undefined, "上妆后同步端口锚点");
    return true;
}

/* ---------------------------------------------------------------------------
 * tick(node) —— 多次重试的兜底调度
 *
 * 框架渲染是异步的（Vue 挂载 + 测量 + 布局），单次 apply 可能扑空。
 * 成功后仍保留轻量重试，覆盖「节点尺寸变化后框架重建槽位」的情况。
 * ------------------------------------------------------------------------- */
const TICK_DELAYS = [0, 16, 50, 120, 260, 520, 900];

function tick(node) {
    if (!node?._a001PortCapsuleOn) return;
    _safeCall(() => {
        const root = findRoot(node);
        /* ★★ 一体化改造：健康即早退（勿改回无条件 applyCapsule(force=true)）。
         *   原实现每一拍都强制重写上妆 + 强制写中心线（force=true），于是装配后的
         *   TICK_DELAYS 七拍会做 7 次无谓写入 —— 每写一次就唤起观察器再来一轮，
         *   这是「刚加载 / 刚展开时闪一下」的成因之一。
         *   现在：只有当「根缺失 / 类名或胶囊丢失 / 几何指纹变化」时才真正重排。
         *   健康节点在 0~900ms 的重试窗口内**零写入**。 */
        if (root) {
            const lost = !root.classList.contains(NODE_CLASS) || !root.querySelector(`.${CAP_CLASS}`);
            const sig = _capsuleGeomSig(root);
            if (!lost && node._xzgA001CapGeomSig === sig) {
                /* 已健康且几何未变：仅确认观察器在位（幂等、无写入）后早退。 */
                startObserver(node);
                return;
            }
            node._xzgA001CapGeomSig = sig;
        }
        const ok = applyCapsule(node, root ? false : true);
        const r2 = root || findRoot(node);
        if (!r2) return;
        /* ⚠️ 每一拍都无条件「补类名 + 挂观察器」，保证下一轮 DOM 重建能被感知。
         * 注：观察器现已改绑画布稳定层（见 startObserver 头注），此处不再传 root。 */
        r2.classList.add(NODE_CLASS);
        collectClusters(r2);
        startObserver(node);
        if (!ok) scheduleMidpointSync(node, r2, true);
    }, undefined, "端口胶囊上妆");
}

function scheduleTicks(node) {
    if (node._xzgA001CapTicks) {
        for (const t of node._xzgA001CapTicks) clearTimeout(t);
    }
    node._xzgA001CapTicks = TICK_DELAYS.map((ms) => setTimeout(() => tick(node), ms));
    scheduleLateTicks(node);
}

/* 长尾重试间隔（ms）：TICK_DELAYS 只覆盖前 0.9s，而三个已知失效场景
 * （显示控件后切工作流 / 进出子图 / 刷新网页）里 Vue 重建节点 DOM 可能更晚 ——
 * 首轮队列会全部扑空，胶囊失效直到 1.2s 巡检才发现。这条长尾链把窗口铺到约 4s，
 * 每拍成本极低（一次 findRoot + 类名检查，健康即早退）。 */
const LATE_TICK_DELAYS = [1200, 1800, 2600, 3600];

/**
 * 长尾重试链（幂等，成功即停）。
 * 「成功」判据 = 已观测到节点根且胶囊类名在位，此后不再重排后续拍。
 */
function scheduleLateTicks(node) {
    if (!node || node._xzgA001CapLateTimers) return;
    const timers = [];
    node._xzgA001CapLateTimers = timers;
    LATE_TICK_DELAYS.forEach((ms, i) => {
        timers.push(setTimeout(() => {
            if (!node._a001PortCapsuleOn) return;
            /* 已就位（根在且类名在）→ 停链，不必再刷。 */
            const root = findRoot(node);
            if (root && root.classList.contains(NODE_CLASS)
                && root.querySelector(`.${CAP_CLASS}`)) {
                node._xzgA001CapLateTimers = null;
                return;
            }
            tick(node);
            if (i === LATE_TICK_DELAYS.length - 1) node._xzgA001CapLateTimers = null;
        }, ms));
    });
}

/* ---------------------------------------------------------------------------
 * 存活节点集合 + 全局单例巡检（比「每节点一个 timer」健壮得多）
 *
 * 为什么必须改成全局集合：
 *   1. 每个节点各起一个 setInterval，节点一多定时器就多；
 *   2. **更关键**：若某次 detach 之后节点对象被复用（撤销/重做、切工作流、切子图、
 *      进出子图）却没有再走到 attach 钩子，旧实现里 guard 已随 detach 一起"自杀"，
 *      胶囊就**永久失效** —— 这正是「偶尔端口胶囊会失效」的成因。
 *      改成常驻巡检后，只要节点仍在图里、且处于「未启用」状态，就会自动重新装配。
 *
 * 清理规则（防集合无限增长）：只有「持续不在图内」超过 ORPHAN_GRACE_MS 才摘除。
 * ⚠️ 不要改成「一拍不在图就摘除」——那正是胶囊偶尔永久失效的成因，见 guardBeat 内注释。
 * ------------------------------------------------------------------------- */
const LIVE_NODES = new Set();
/* 巡检间隔（ms）：正常态低频（省开销），一旦发现有节点「根被替换 / 胶囊丢失」
 * 就切到高频，把失效窗口从 1.2s 压到 200ms 量级 —— 三个已知失效场景
 * （显示控件后切工作流 / 进出子图 / 刷新网页）都属于「节点根被 Vue 整体重建」，
 * 单靠 1.2s 的固定间隔会有一段肉眼可见的空窗。 */
const GUARD_INTERVAL_MS = 1200;
const GUARD_FAST_MS = 200;
/* 离图宽限期：节点处于「不在图内」的状态持续超过此值，才从存活集合摘除。
 * 给撤销 / 重做、跨图切换（进出子图）、删除后恢复等场景留出自愈窗口。 */
const ORPHAN_GRACE_MS = 8000;
let _guardTimer = 0;
/* 当前巡检间隔，用于在快/慢档之间切换时重建定时器。 */
let _guardIntervalMs = GUARD_INTERVAL_MS;

function registerLiveNode(node) {
    if (!node) return;
    node._a001PortsOrphanSince = 0;
    LIVE_NODES.add(node);
    /* 新节点入册时切到快档：装配初期 DOM 常不稳定，需要密集跟几拍。 */
    ensureGuardTimer(GUARD_FAST_MS);
}

/**
 * 确保巡检定时器以指定间隔运行（幂等：间隔未变则不重建）。
 * 定时器为全局单例，所有存活节点共用一条链。
 */
function ensureGuardTimer(ms) {
    if (_guardTimer && _guardIntervalMs === ms) return;
    if (_guardTimer) clearInterval(_guardTimer);
    _guardIntervalMs = ms;
    _guardTimer = setInterval(guardBeat, ms);
}

function guardBeat() {
    /* 本拍是否发现「需要重建」的异常 —— 决定下拍用快档还是慢档。 */
    let unhealthy = false;
    for (const node of Array.from(LIVE_NODES)) {
        /* 注：LIVE_NODES 只登记真实节点对象（registerLiveNode 已挡掉 falsy），
         * 故不存在 null 分支；真正需要清理的是「已持续离图的死节点」，见下方。 */
        /* ★「真的还在图里」用 graph._nodes 反查（与 A001_shared.isNodeInGraph 同口径）：
         *  仅看 node.graph 不够 —— 节点被删除后进撤销栈、或跨图切换（进出子图）瞬间，
         *  node.graph 可能为空、也可能仍指向旧图。 */
        const g = node.graph;
        const inGraph = !!g && (g._nodes || []).includes(node);
        if (!inGraph) {
            /* ★★ 关键修复（「偶尔端口胶囊失效」的成因）：
             *  这里【不能】一拍离图就摘除。真删除的节点会留在撤销栈里，用户一撤销，
             *  同一个 node 对象就重新入图；若在它离图的那一拍就把对象摘掉，
             *  撤销恢复后再没有任何人负责重建胶囊 → 刷新前永久失效（偶发、难复现）。
             *  改为：持续离图超过 ORPHAN_GRACE_MS 才摘除 —— 真删除必然超时被清理
             *  （集合不会无限增长），瞬时离图则保留自愈能力。原「detach 满 8 秒无条件
             *  摘除」的规则同理删除：节点还在图里时，它必须留在集合中等待自愈。 */
            if (!node._a001PortsOrphanSince) node._a001PortsOrphanSince = Date.now();
            if (Date.now() - node._a001PortsOrphanSince > ORPHAN_GRACE_MS) {
                LIVE_NODES.delete(node);
            }
            continue;
        }
        node._a001PortsOrphanSince = 0;
        /* 后台标签页：保留廉价的存在性判定与离图宽限清理，跳过胶囊重建/几何同步
         * 等 DOM 级操作（后台无人可见，切回前台后下一拍立即自愈）。 */
        if (document.hidden) continue;
        _safeCall(() => {
            /* ① 自愈核心：仍在图里却没启用（被 detach 过 / 某次装配失败）→ 重新装配。 */
            if (!node._a001PortCapsuleOn) {
                unhealthy = true;
                attachA001PortCapsule(node);
                return;
            }
            /* ② 已启用：检查根元素与类名是否还在。
             * ★ 这里必须每拍都做「根替换检测」而不是只依赖观察器回调：
             *   观察器绑在节点根元素上，Vue 把节点根**整体替换**后旧观察器就失聪了
             *   （回调里虽有重绑逻辑，但失聪后根本收不到回调 → 死锁，只能等巡检）。
             *   guardBeat 直接 findRoot 对比，不依赖任何回调，是这个死锁的唯一出口。
             *   三个已知失效场景（显示控件后切工作流 / 进出子图 / 刷新网页）都属此类。 */
            const root = findRoot(node);
            if (!root) { unhealthy = true; return; }
            const rebind = root !== node._xzgA001CapObservedRoot;
            const lost = !root.classList.contains(NODE_CLASS) || !root.querySelector(`.${CAP_CLASS}`);
            if (rebind || lost) {
                unhealthy = true;
                tick(node);      // 重建后：补类名 + 重绑 hover + 重挂观察器 + 重写锚点
                return;
            }
            /* 根与类名都在：**不再每拍无条件重算中心线**。
             * ★ 一体化改造（勿改回无条件 scheduleMidpointSync）：
             *   原实现在每一拍都对每个健康节点重算并写 --xzg-a001-cap-mid，
             *   而同步写 style 会唤起观察器 → 又触发一轮重算；虽经取整抑制，
             *   在「节点被拉伸 / 内部重排」等几何真变时仍表现为 1px 抖动（闪一下）。
             *   现在改为「几何指纹变了才重算」：读节点根布局高 + 桶布局高，
             *   与上次记录比对，一致即完全零写入。
             *   几何变化的**即时**感知由观察器（绑画布稳定层）与 onResize 负责，
             *   巡检只作兜底，无需高频重算。 */
            const sig = _capsuleGeomSig(root);
            if (node._xzgA001CapGeomSig !== sig) {
                node._xzgA001CapGeomSig = sig;
                scheduleMidpointSync(node, root);
            }
        }, undefined, "端口胶囊全局巡检");
    }
    /* ★ 自适应频率：有异常 → 下拍快档（尽快续上重建）；全健康 → 回低频省开销。
     *  必须在遍历结束后统一切换，避免同一拍内反复重建定时器。 */
    if (LIVE_NODES.size === 0) {
        if (_guardTimer) { clearInterval(_guardTimer); _guardTimer = 0; }
        return;
    }
    ensureGuardTimer(unhealthy ? GUARD_FAST_MS : GUARD_INTERVAL_MS);
}

/* ---------------------------------------------------------------------------
 * attachA001PortCapsule(node, deps) —— 对外主入口（幂等）
 *
 * 注意：本函数必须**在 attachA001GridAnchor 之后**调用，
 * 否则首次 applyCapsule 会因找不到网格宿主而直接返回 false。
 * ------------------------------------------------------------------------- */
export function attachA001PortCapsule(node, deps) {
    if (!node || node.id == null) return false;
    if (deps) initPortDeps(deps);
    if (node._a001PortCapsuleOn) {
        /* 已开启：只补一次重试，不重复初始化 */
        scheduleTicks(node);
        /* ★ 去重 + 存句柄：attachA001Ports 会被多个生命周期钩子反复调用，
         *  原写法每次新增一个裸定时器，节点删除后仍会触发（无配对清理）。 */
        if (node._a001CapNudgeTimer) clearTimeout(node._a001CapNudgeTimer);
        node._a001CapNudgeTimer = setTimeout(() => {
            node._a001CapNudgeTimer = 0;
            if (node._a001PortCapsuleOn) nudgeNode(node);
        }, 200);
        return true;
    }

    return !!_safeCall(() => {
        injectCapsuleCss();
        node._a001PortCapsuleOn = true;

        /* 首次上妆 + 延时重试队列 */
        scheduleTicks(node);
        /* ★ 登记进存活集合：由全局巡检兜底「进出子图 / 切换画布 / DOM 重建 /
         *   被 detach 后对象复用却未重挂」等全部已知失效场景（自愈）。 */
        registerLiveNode(node);

        /* 装配后做一次初始脉冲：展开过程的槽位变化需要官方重测，
         * 200ms 是为了等框架首轮测量完成后再抖动，避免被覆盖掉。 */
        if (node._a001CapNudgeTimer) clearTimeout(node._a001CapNudgeTimer);
        node._a001CapNudgeTimer = setTimeout(() => {
            node._a001CapNudgeTimer = 0;
            if (node._a001PortCapsuleOn) nudgeNode(node);
        }, 200);

        _alog("[A001_port_capsule] 端口胶囊已装配");
        return true;
    }, undefined, "装配端口胶囊");
}

/* ---------------------------------------------------------------------------
 * detachA001PortCapsule(node) —— 卸载（节点删除时调用）
 * ------------------------------------------------------------------------- */
export function detachA001PortCapsule(node) {
    if (!node) return false;
    return !!_safeCall(() => {
        if (node._xzgA001CapTicks) {
            for (const t of node._xzgA001CapTicks) clearTimeout(t);
            node._xzgA001CapTicks = null;
        }
        /* ★ 一并清掉长尾重试链：否则节点删除后仍有定时器对着已脱离的节点跑 tick。 */
        if (node._xzgA001CapLateTimers) {
            for (const t of node._xzgA001CapLateTimers) clearTimeout(t);
            node._xzgA001CapLateTimers = null;
        }
        /* ★ 清掉槽位锚点同步 / 装配脉冲两个定时器（本次补上的配对清理）。 */
        if (node._a001SlotPosSyncTimer) {
            clearTimeout(node._a001SlotPosSyncTimer);
            node._a001SlotPosSyncTimer = 0;
        }
        if (node._a001CapNudgeTimer) {
            clearTimeout(node._a001CapNudgeTimer);
            node._a001CapNudgeTimer = 0;
        }
        /* ★ 不从存活集合摘除：节点对象可能被复用（撤销/重做、切图、进出子图）
         *   而不再走 attach 钩子；留着它，全局巡检才能在「仍在图中但未启用」时
         *   自动重新装配（自愈）。真正删除的节点由巡检按「持续离图超宽限期」清理。 */
        if (node._xzgA001CapObserver) {
            /* ★ 单例观察器：只从注册表摘除本节点（不再 disconnect 共享实例）。 */
            _capMOBindings.delete(String(node.id));
            node._xzgA001CapObserver = null;
            node._xzgA001CapOnMutations = null;
        }
        node._xzgA001CapObservedRoot = null;
        if (node._xzgA001CapSyncRaf) {
            if (typeof cancelAnimationFrame === "function") {
                cancelAnimationFrame(node._xzgA001CapSyncRaf);
            } else {
                clearTimeout(node._xzgA001CapSyncRaf);
            }
            node._xzgA001CapSyncRaf = 0;
        }
        /* ★ 抑制巡检一并停掉：否则节点删除后 rAF 仍会多跑几帧做无用查询；
         *   同时清空抑制窗口，避免同一节点对象被复用（撤销/重做）时残留抑制态。 */
        if (node._xzgA001CapWatchRaf) {
            const cancelWatch = (typeof cancelAnimationFrame === "function") ? cancelAnimationFrame : clearTimeout;
            _safeCall(() => cancelWatch(node._xzgA001CapWatchRaf), undefined, "停止抑制巡检");
            node._xzgA001CapWatchRaf = 0;
        }
        node._xzgA001CapSuppressUntil = 0;
        /* ★ 只摘除本节点的脉冲登记，不整体清空 _nudgePending / 不打断全局轮询：
         *  原实现无条件 clear 全局 timer 与 Set，会让**其它节点**排队中的重测
         *  永久丢失（跨节点串扰）。此处仅移除属于本节点根的元素。 */
        const rootForNudge = findRoot(node);
        if (rootForNudge) _nudgePending.delete(rootForNudge);
        if (_nudgeActive.length) {
            _nudgeActive = _nudgeActive.filter((r) => r !== rootForNudge);
            if (rootForNudge) _nudgePoke([rootForNudge], false);
        }
        /* 清掉中心线缓存，避免节点对象被复用（撤销恢复）时沿用旧值 */
        node._xzgA001CapMidCache = undefined;
        node._xzgA001CapObservedRoot = null;
        if (rootForNudge) {
            rootForNudge.classList.remove(NODE_CLASS);
            rootForNudge.style.marginBottom = "";
            const clusters = rootForNudge.querySelectorAll(`.${CAP_CLASS}`);
            for (const c of clusters) {
                unbindClusterClickIntent(c);
                c.classList.remove(CAP_CLASS, OPEN_CLASS);
                c.removeAttribute("data-dir");
                c.style.removeProperty(CAP_MID_VAR);
                c._xzgA001CapMid = undefined;
            }
            for (const w of rootForNudge.querySelectorAll(`.${WRAP_CLASS}`)) {
                /* 包裹层类名也一并摘掉：若本模块被整体停用，节点应回到原生端口外观。
                 * 用 style 复位而非 removeProperty，避免残留 !important 之外的样式。 */
                w.classList.remove(WRAP_CLASS);
            }
        }
        document.body.removeAttribute("data-xzg-a001-slot-hover");
        node._a001PortCapsuleOn = false;
        return true;
    }, undefined, "卸载端口胶囊");
}

/* ---------------------------------------------------------------------------
 * refreshA001PortCapsule(node) —— 外部触发的一次重算（供尺寸变化后调用）
 * ------------------------------------------------------------------------- */
export function refreshA001PortCapsule(node) {
    if (!node?._a001PortCapsuleOn) return false;
    _safeCall(() => {
        const root = findRoot(node);
        /* ★ 拉伸（onResize）时 Vue 常会重建槽位 DOM：原实现只补类名与中心线、
         *  不重新上妆，于是胶囊的 hover 绑定与几何会短暂缺失，表现为「闪一下」
         *  再靠 1.2s 巡检恢复。这里与巡检同口径判定「根换了 / 类名或胶囊丢了」，
         *  命中即走 tick 同帧重建；DOM 还没建好也走 tick（含 0~900ms 重试队列）。 */
        if (!root) {
            tick(node);
            return;
        }
        const rebind = root !== node._xzgA001CapObservedRoot;
        const lost = !root.classList.contains(NODE_CLASS) || !root.querySelector(`.${CAP_CLASS}`);
        if (rebind || lost) {
            tick(node);
            return;
        }
        root.classList.add(NODE_CLASS);
        collectClusters(root);
        startObserver(node);
        scheduleMidpointSync(node, root, true);
        /* 尺寸变化后槽位几何变了 → 重新写 slot.pos（连线端点的数据源）。 */
        _safeCall(() => syncSlotPosFromDom(node, root), undefined, "刷新后同步端口锚点");
    }, undefined, "刷新端口胶囊");
    return true;
}

/**
 * nudgeA001PortCapsule(node) —— 供其它模块主动触发一次「净零高度脉冲」。
 *
 * 唯一用途：A001 的「收起/展开控件」改为 CSS 隐藏（元素保留、不卸载）后，
 * 官方网格宿主的高度是**同一元素、同一时刻**在变（0 ⇄ 112px），既不会
 * 触发 Vue 重建节点 DOM，也不会更换元素引用 —— 于是没有任何信号去唤起
 * 官方的 widgets-grid ResizeObserver 重测槽位布局，端口胶囊会停留在旧几何。
 * 这里直接把本模块内部已有的 nudgeNode（CSS 净零脉冲，不碰 node.size）
 * 暴露出去，让收起/展开路径补一次重测信号，与展开/收起端口的做法完全一致。
 */
export function nudgeA001PortCapsule(node) {
    return nudgeNode(node);
}

export default {
    initPortDeps,
    attachA001PortCapsule,
    detachA001PortCapsule,
    refreshA001PortCapsule,
    nudgeA001PortCapsule,
};
