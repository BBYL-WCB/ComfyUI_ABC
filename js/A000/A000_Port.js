// ═══════════════════════════════════════════════════════════════
//  A000 端口效果 · 共享模块
//  · 从 A005 / A006 抽离的「端口悬浮」效果，统一为 xzg-port-* 前缀供两节点复用
//    （聚合胶囊 `.xzg-port-slots` + hover 展开 + 隐藏 tooltip + ComfyTV nudge 锚点）
//  · 通用签名 floatPortRails(node, g, opts)：
//      node  —— 当前节点（tick 内存活判定用 opts.alive）
//      g     —— 节点的 DOM widget 状态对象（port 状态字段统一挂在 g 上）
//      opts  —— 可选 { card, alive }
//                card: 卡片根元素（用于 nudge 的 marginBottom 抵消，默认 g.el）
//                alive: () => boolean，返回 false 则停止轮询（默认恒 true）
//  ═══════════════════════════════════════════════════════════════

import { injectStyleOnce } from "./A000_DomStyle.js";

/* ─── CSS 注入（统一 xzg-port 前缀，幂等） ─── */

/** 注入端口效果所需的通用样式（各节点可重复调用，仅注入一次）。 */
export function injectPortCss() {
    injectStyleOnce("xzg-abc-port-style", `
.xzg-port-band{ position:absolute; top:0; left:0; right:0; bottom:0; z-index:20; margin:0; pointer-events:none; }
.xzg-port-slots{ position:absolute; top:50%; transform:translateY(-50%); display:grid; place-items:center; pointer-events:auto; min-width:20px; min-height:20px; padding:2px; opacity:0; border-radius:999px; background:rgba(20,22,26,.92); border:1.5px solid rgba(255,255,255,.2); box-shadow:0 2px 8px rgba(0,0,0,.55); transition:opacity .15s ease, background .15s ease; }
/* 平时隐藏，仅节点 hover / 选中 时显形（与 A001 端口胶囊一致）。
 * 选中态选择器覆盖各家前端写法：.selected / .lg-node--selected / [data-selected]。 */
.xzg-port-node:hover .xzg-port-slots,
.xzg-port-node.selected .xzg-port-slots,
.xzg-port-node.lg-node--selected .xzg-port-slots,
.xzg-port-node[data-selected] .xzg-port-slots,
.xzg-port-node .xzg-port-slots.xzg-port-open,
.xzg-port-node .xzg-port-slots.xzg-port-open.xzg-port-in,
.xzg-port-node .xzg-port-slots.xzg-port-open.xzg-port-out{ opacity:1; }
.xzg-port-slots.xzg-port-in{ left:0; }
.xzg-port-slots.xzg-port-out{ right:0; left:auto; }
.xzg-port-slots::after{ content:'+'; position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font:400 15px/1 system-ui,sans-serif; color:#e6e6e6; pointer-events:none; transform:translateY(-1px); }
.xzg-port-slots .lg-slot--input,.xzg-port-slots .lg-slot--output{ height:0; padding:0; margin:0; opacity:0; overflow:hidden; transition:height .12s ease,opacity .15s ease; }
.xzg-port-slots .lg-slot span{ display:none; }
.xzg-port-slots.xzg-port-open{ display:flex; flex-direction:column; gap:3px; padding:6px; border-radius:12px; }
.xzg-port-slots.xzg-port-in.xzg-port-open{ align-items:flex-start; }
.xzg-port-slots.xzg-port-out.xzg-port-open{ align-items:flex-end; }
.xzg-port-slots.xzg-port-open::after{ content:''; }
.xzg-port-slots.xzg-port-open .lg-slot{ height:16px; opacity:1; overflow:visible; display:flex; flex-direction:row; align-items:center; gap:5px; }
.xzg-port-slots.xzg-port-open .lg-slot span{ display:inline-block; font:500 10px/1 system-ui,sans-serif; color:#ddd; padding:2px 6px; border-radius:999px; background:rgba(255,255,255,.08); white-space:nowrap; pointer-events:none; }
.xzg-port-slots.xzg-port-open [data-slot-key]{ width:7px; height:7px; border-radius:999px; flex:none; background:none; box-shadow:0 0 0 2px rgba(96,165,250,.6); }
.xzg-port-slots.xzg-port-open [data-slot-key] circle,.xzg-port-slots.xzg-port-open [data-slot-key] g{ clip-path:none; }
/* 复刻 ComfyTV body[data-v2-slot-hover]：展开连线时隐藏 tooltip */
body[data-xzg-port-slot-hover] .p-tooltip{ display:none !important; }

/* ── 端口区「从渲染起就不占流」──
 * 原实现靠 JS 上妆时才把端口区改成绝对定位；而 Vue 重建节点 DOM 后（切换工作流 /
 * 进出子图 / 拉伸），端口区会先以「占流」状态渲染一帧，随后才被 JS 改为绝对定位，
 * 造成 node-body 高度跳变（实测 604→600，4px）→ 用户看到「闪一下」。
 * 这里用 :has() 直接命中「含 ABC DOM widget 的节点」的端口区，在 CSS 层就提前绝对定位，
 * 与 Vue 渲染同帧生效，无需等 JS —— 彻底消除那一帧跳变。
 * 选择器限定到 [data-testid^="node-body"]:has(.xzg-ic-dom)，只作用于 A002，绝不影响其它节点。 */
[data-testid^="node-body"]:has(.xzg-ic-dom) > div:has(.lg-slot):not([data-testid="node-widgets"]){
    position:absolute !important;
    inset:0 !important;
    margin:0 !important;
}
`);
}

/* ─── 端口条悬浮 ─── */

/**
 * 同步节点根元素上的 xzg-port-node 信号 class（端口条悬浮等既有规则依赖它）。
 * 供 floatPortRails 及其 MutationObserver 调用，保证 Vue 重建后状态不丢。
 */
function syncPortLabelClass(node, g, ln) {
    const el = ln || g?._portNodeEl;
    if (!el || !el.classList) return;
    if (!el.classList.contains("xzg-port-node")) el.classList.add("xzg-port-node");
}

/* ─── 复刻 ComfyTV nudge（008_ComfyTV/src/v2/nodeDrag.ts） ─── */
/**
 * 完全照抄 ComfyTV 的 nudgeSlotAnchors 机制：
 * · poke()：临时改 widgets-grid 的 paddingBottom 1px + **同一 grid 上** marginBottom -1px 净零。
 *   padding 变化必然改变 grid 的 content box 尺寸 → 框架全局 ResizeObserver 必定触发
 *   → 元素带 data-widgets-grid-node-id → 直接 scheduleSlotLayoutSync
 *   → 框架用 getBoundingClientRect() 实测 DOM 圆点 → batchUpdateSlotLayouts → 连线端点更新。
 *   无需劫持 getConnectionPos、无需写 slot.pos，连线锚点完全交给框架自测。
 * · 双计时器：nudgeTimer 60ms 批量合并执行 poke(true)；nudgeRevert 40ms 后 poke(false) 恢复。
 *
 * ★★ 净零必须做在【grid 自己】身上（实测踩坑，勿改回 card）：
 *   脉冲原理是「grid padding-bottom 0→1px」唤起官方 widgets-grid ResizeObserver（signal-only）。
 *   但 grid 是 flex 子项，padding +1px 会让整条纵向布局都 +1px：node-body 总高变高
 *   → 预览框被挤 1px、随后弹回 —— 用户看到面板「闪一下/抖一下」（A002 实测掉 20px）。
 *   正解：给 grid 同时加 margin-bottom:-1px。flex 布局按【outer size】计算，
 *   padding 的 +1px 被 -1px 外距抵消 → node-body 总高不变；而 ResizeObserver 观测
 *   content-box（padding 变化会改变它），故仍照常触发重测。
 *   （原先把 -1px 加在卡片/节点根上无效：那是另一层元素，影响不到 grid 的布局高度。）
 */
const _nudgePending = new Map();   // root -> card（保留字段，抵消已改在 grid 上）
let _nudged = [];
const _poke = (entries, on) => {
    for (const { root } of entries) {
        if (!root || typeof root.querySelector !== "function") continue;
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
};
let _nudgeRevert = null;
const _scheduleRevert = () => {
    if (_nudgeRevert) clearTimeout(_nudgeRevert);
    _nudgeRevert = setTimeout(() => {
        _nudgeRevert = null;
        _poke(_nudged, false);
        _nudged = [];
    }, 40);
};
let _nudgeTimer = null;

/** 触发节点端口锚点重测。root 为 node-body（或其父），card 为卡片根元素。 */
export function nudgeSlotAnchors(root, card) {
    if (root) _nudgePending.set(root, card);
    if (_nudgeTimer) clearTimeout(_nudgeTimer);
    _nudgeTimer = setTimeout(() => {
        _nudgeTimer = null;
        // 上一批还在恢复中：等恢复完（40ms）再处理新请求
        if (_nudged.length) { nudgeSlotAnchors(); return; }
        const entries = [..._nudgePending.entries()]
            .filter(([r]) => r && r.isConnected)
            .map(([r, c]) => ({ root: r, card: c }));
        _nudgePending.clear();
        if (!entries.length) return;
        _nudged = entries;
        _poke(entries, true);
        _scheduleRevert();
    }, 60);
}

/* ─── 端口胶囊：点击展开/收起（对齐 A001_port_capsule 的点击意图） ─── */
/**
 * 给端口聚合胶囊绑定「点击展开/收起」（原为 hover 展开，现改为与 A001 一致的点击语义）：
 * · 单击圆点 → 展开该桶（同时收起同节点其它桶）
 * · 再次单击同一圆点 → 收起
 * · 点击面板之外任意位置 → 收起（document 捕获阶段）
 * 说明：hover 展开会在「指针未动、元素被布局推到指针下」时被浏览器补发 pointerenter
 *       而误展开；点击语义更稳定可控。
 * ⚠️ 本函数会被 apply() 反复调用（观察器 / tick），故用 dataset 标记保证只绑定一次。
 */
function bindClusterClickIntent(node, g, card, root) {
    for (const c of root.querySelectorAll(".xzg-port-in, .xzg-port-out")) {
        if (c.dataset.xzgPortClick === "1") continue;
        c.dataset.xzgPortClick = "1";
        const onPointerDown = (e) => {
            /* 只处理左键（右键留给官方上下文菜单）。 */
            if (e.button !== 0) return;
            /* 刻意不 preventDefault / stopPropagation：圆点内芯是官方槽位，
             * 用户仍可能从它拖出连线，阻断会破坏官方拖线。 */
            const isOpen = c.classList.contains("xzg-port-open");
            if (isOpen) {
                c.classList.remove("xzg-port-open");
                if (document.body) document.body.removeAttribute("data-xzg-port-slot-hover");
            } else {
                /* 同节点其它桶先收起，避免同时展开两端造成抖动 */
                for (const o of root.querySelectorAll(".xzg-port-open")) {
                    if (o !== c) o.classList.remove("xzg-port-open");
                }
                c.classList.add("xzg-port-open");
                if (document.body) document.body.setAttribute("data-xzg-port-slot-hover", "1");
            }
            nudgeSlotAnchors(root, card);
        };
        /* 具名句柄存元素上，供 detach 精确解绑（匿名监听无法 removeEventListener）。 */
        c._xzgPortClickHandlers = { onPointerDown };
        /* 用捕获阶段：官方槽位内部可能对 pointerdown 做 stopPropagation，
         * 冒泡阶段会漏掉点击；捕获阶段先于目标/冒泡执行，保证必定收到。 */
        c.addEventListener("pointerdown", onPointerDown, true);
    }
    ensureClusterOutsideCloseHook();
}

/* ── 点击「面板之外」收起：document 级捕获监听（全局安装一次） ── */
let _clusterOutsideCloseHooked = false;
function ensureClusterOutsideCloseHook() {
    if (_clusterOutsideCloseHooked || typeof document === "undefined") return;
    _clusterOutsideCloseHooked = true;
    document.addEventListener("pointerdown", (e) => {
        /* 仅在「点击发生在任何已展开胶囊之外」时收起：目标位于某桶内 → 交给桶自身处理。 */
        const t = e.target;
        if (t && typeof t.closest === "function" && t.closest(".xzg-port-in, .xzg-port-out")) return;
        const open = document.querySelectorAll(".xzg-port-open");
        if (!open.length) return;
        if (document.body) document.body.removeAttribute("data-xzg-port-slot-hover");
        for (const c of open) c.classList.remove("xzg-port-open");
        /* 收起后需让框架重测锚点（连线端点回到折叠态圆点）。 */
        for (const [id, n] of _portMOBindings) {
            const gg = n && n._xzgIc;
            if (!gg) continue;
            const el = gg.el;
            const body = el && el.closest && el.closest('[data-testid^="node-body"]');
            const root2 = body && body.closest && body.closest("[data-node-id]");
            if (root2) nudgeSlotAnchors(root2, gg.el);
        }
    }, true);
}

/* ─── 端口观察器：模块级单例（绑画布稳定层） ───
 * 观察器**不能**绑 node-body：Vue 在切换工作流 / 进出子图 / 拉伸后会整体重建 node-body，
 * 绑在其上的观察器随即失聪，恢复只能等 500ms 轮询 → 胶囊空窗约 1 秒，用户表现为「闪一下」。
 * 改绑画布稳定层后观察器始终存活，回调里重新定位并上妆，把恢复窗口压到同帧。
 * N 个节点各起一个画布级观察器开销大，故改为「单例 + nodeId 注册表」按需分发。
 * （与 A001_port_capsule.js 的做法同源） */
let _portMO = null;
let _portMOTarget = null;
const _portMOBindings = new Map();   // String(nodeId) -> node

/** 按 data-node-id 把 mutations 分组（单次遍历，供分发给各节点）。 */
function _portGroupMutations(mutations) {
    const byId = new Map();
    for (const m of mutations) {
        const t = m.target;
        const el = (t && t.closest) ? t : (t && t.parentElement);
        if (!el || !el.closest) continue;
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
function _ensurePortMO(target) {
    if (_portMO && _portMOTarget === target && _portMOTarget.isConnected) return;
    if (_portMO) { try { _portMO.disconnect(); } catch (e) { /* 忽略 */ } }
    _portMO = new MutationObserver((mutations) => {
        const byId = _portGroupMutations(mutations);
        if (!byId.size) return;
        for (const [id, ms] of byId) {
            const n = _portMOBindings.get(id);
            const fn = n && n._xzgPortOnMutations;
            if (typeof fn === "function") { try { fn(ms); } catch (e) { /* 忽略 */ } }
        }
    });
    _portMOTarget = target;
    _portMO.observe(target, { childList: true, subtree: true });
}

/* ─── 端口条悬浮 ─── */

/**
 * 端口条悬浮：Nodes 2.0 节点 body 顶部有「输入/输出端口条」占位，
 * 会挡住内容外框置顶。改为绝对定位悬浮：输出端口条 → 右上，输入端口条 → 左上。
 * 持续轻量轮询重应用（新建/加载/拖动尺寸时 Vue 可能重渲染覆盖回 static），
 * 直到 opts.alive() 返回 false（节点删除/不再活跃）；间隔 500ms 降频到 2000ms，开销极低。
 */
export function floatPortRails(node, g, opts = {}) {
    injectPortCss();
    const card = opts.card || g.el;                       // 卡片根元素（nudge 抵消用）
    const alive = opts.alive || (() => true);             // 存活判定（false → 停止轮询）
    const bodyEl = () => {
        /* 优先用 DOM widget 反查（最准）。 */
        const el = g.el;
        if (el && typeof el.closest === "function") {
            const b = el.closest('[data-testid^="node-body"]');
            if (b && b.isConnected) return b;
        }
        /* 回退：DOM widget 尚未插入时（Vue 分步 patch），用节点 id 直接定位节点根。
         * 这样 node-body 一出现就能上妆，抢在浏览器渲染之前把端口区改为绝对定位，
         * 避免「先以占流渲染一帧再切换」造成的布局跳动。 */
        const id = node?.id;
        if (id == null) return null;
        const safe = String(id).replace(/[^A-Za-z0-9_-]/g, "");
        if (!safe) return null;
        const root = document.querySelector('[data-node-id="' + safe + '"]');
        return root ? root.querySelector('[data-testid^="node-body"]') : null;
    };
    const findBands = (b) => {
        const bands = [];
        if (!b) return bands;
        for (const c of b.children) {
            if (typeof c === "object" && c && typeof c.classList !== "undefined" && typeof c.querySelector === "function" && c.querySelector(".lg-slot")) {
                c.classList.add("xzg-port-slots");
                const hasIn = c.querySelector(".lg-slot--input");
                const hasOut = c.querySelector(".lg-slot--output");
                if (hasIn && !hasOut) c.classList.add("xzg-port-in");
                else if (hasOut && !hasIn) c.classList.add("xzg-port-out");
                bands.push(c);
            }
        }
        return bands;
    };
    const apply = () => {
        const b = bodyEl();
        if (!b || !b.isConnected) return "";
        const ln = b.closest(".lg-node");
        if (ln) syncPortLabelClass(node, g, ln);
        // 记录当前节点根元素：Vue 重建后元素会变，据此重绑 class 观察器
        if (ln && g._portNodeEl !== ln) {
            if (g._portNodeMO) g._portNodeMO.disconnect();
            g._portNodeEl = ln;
            g._portNodeMO = new MutationObserver(() => {
                if (!g._portNodeEl || !g._portNodeEl.isConnected) return;
                syncPortLabelClass(node, g, g._portNodeEl);
            });
            g._portNodeMO.observe(ln, { attributes: true, attributeFilter: ["class"] });
        }
        b.style.position = "relative";
        // 找 band：node-body 顶层中唯一含 .lg-slot 的容器（输入/输出子桶的父）
        let band = null;
        for (const ch of b.children) {
            if (typeof ch === "object" && ch && typeof ch.querySelector === "function" && ch.querySelector(".lg-slot")) { band = ch; break; }
        }
        if (!band) return "";
        band.classList.add("xzg-port-band");
        const bands = findBands(band);
        if (!bands.length) return "";
        // root 取 node-body 最近的 [data-node-id]（无则退回 node-body 本身）
        const root = (b.closest?.("[data-node-id]") || b);
        bindClusterClickIntent(node, g, card, root);
        let sig = "";
        // 左右双胶囊：band 由 CSS 铺满作为定位父级，输入/输出子桶各成独立胶囊
        // （.xzg-port-in 贴左、.xzg-port-out 贴右），折叠 + 点击展开全交给 CSS。
        // 连线锚点不在此写：与 ComfyTV 一致，完全依赖框架 ResizeObserver
        // （nudge 改 grid paddingBottom 1px → 框架自动重测 DOM 圆点）。
        for (const sl of bands) {
            const hasIn = sl.querySelector(".lg-slot--input");
            const hasOut = sl.querySelector(".lg-slot--output");
            const pureIn = !!hasIn && !hasOut;
            const pureOut = !!hasOut && !hasIn;
            sig += (pureIn ? "i" : pureOut ? "o" : "m") + "=" + "|";
        }
        return sig;
    };
    apply();

    /* ── 观察器绑「画布稳定层」（见模块顶部说明）：node-body 重建后仍存活，
     *    回调里重新定位并上妆，把胶囊恢复窗口从天级压到同帧。 ── */
    const obsTarget = () => {
        /* 用 document.body 作观察目标：它永远稳定 —— 切换工作流 / 进出子图 /
         * 画布容器替换都不会让它失效，观察器因此不会「失聪」，
         * 能在 Vue 插入 node-body 的同一批微任务里上妆，抢在首帧渲染之前；
         * 若改用画布容器或 node-body，一旦被 Vue 整体替换观察器就失效，
         * 只能等宏任务重试，首帧会以「端口区占流」渲染出来（预览框被压 20px → 闪）。
         * 分组的 el.closest('[data-node-id]') 过滤保证只处理节点内的变更。 */
        return document.body;
    };
    if (!node._xzgPortOnMutations) {
        node._xzgPortOnMutations = (mutations) => {
            if (!alive()) {
                _portMOBindings.delete(String(node.id));
                node._xzgPortOnMutations = null;
                return;
            }
            /* 防自激：上妆会改 class，会再次唤醒观察器 → 用短窗口挡住自己那一轮 */
            const now = performance?.now?.() ?? Date.now();
            if (g._portSelfWriteUntil && now < g._portSelfWriteUntil) return;
            /* 忽略「全部发生在内容区（DOM widget 内部）」的变更：
             * 预览/编辑器内部重绘与端口条几何无关，照常 apply 只会引发无谓重排与闪动。 */
            const host = g.el;
            let relevant = false;
            for (const m of mutations) {
                const t = m.target;
                const el = (t && t.closest) ? t : (t && t.parentElement);
                if (!el || !el.closest) continue;
                if (host && host.contains(el)) continue;
                relevant = true;
                break;
            }
            if (!relevant) return;
            g._portSelfWriteUntil = (performance?.now?.() ?? Date.now()) + 80;
            apply();
        };
    }
    const rebindObserver = () => {
        const t = obsTarget();
        if (!t) return;
        _portMOBindings.set(String(node.id), node);
        _ensurePortMO(t);
    };
    rebindObserver();

    /* 快速重试链：节点刚创建 / DOM 刚重建时 apply 可能扑空，
     * 密集补几拍把胶囊恢复窗口压到百毫秒内（与 A001 同款）。 */
    if (g._portFastTimers) for (const t of g._portFastTimers) clearTimeout(t);
    g._portFastTimers = [0, 16, 50, 120, 260, 520, 900].map((ms) => setTimeout(() => {
        if (!alive()) return;
        apply();
        rebindObserver();
    }, ms));

    clearInterval(g._portTimer);
    g._portTimer = null;
    let stable = 0;
    let interval = 500;
    const tick = () => {
        if (!alive()) {
            clearInterval(g._portTimer);
            g._portTimer = null;
            /* 节点已不再活跃：从单例观察器注册表摘除，并停掉快速重试链 */
            _portMOBindings.delete(String(node.id));
            node._xzgPortOnMutations = null;
            if (g._portFastTimers) { for (const t of g._portFastTimers) clearTimeout(t); g._portFastTimers = null; }
            return;
        }
        /* 后台标签页：存活判定（廉价）照常执行，跳过 apply()/重绑观察器等 DOM 操作 */
        if (document.hidden) return;
        const sig = apply();
        rebindObserver();
        if (sig && sig === g._portSig) {
            stable++;
            // 稳定后不彻底停表：从 500ms 降频到 2000ms 继续兜底，
            // 防止后续操作触发 Vue 重建导致标记类/悬浮样式丢失而无人补回
            if (stable === 20 && interval === 500) {
                clearInterval(g._portTimer);
                interval = 2000;
                g._portTimer = setInterval(tick, interval);
            }
        } else {
            const changed = sig !== g._portSig;
            stable = 0;
            g._portSig = sig;
            // 端口条结构/存在性变化（Vue 重建、进出子图、切换画布）→
            // 连线锚点完全依赖框架实测 DOM 圆点，须主动 nudge 触发框架重测，
            // 否则线端点仍停留在旧几何位置，视觉上「线分开了」。
            if (changed) {
                requestAnimationFrame(() => {
                    const b2 = bodyEl();
                    if (!b2 || !b2.isConnected) return;
                    const root = (b2.closest?.("[data-node-id]") || b2);
                    nudgeSlotAnchors(root, card);
                });
            }
        }
    };
    g._portTimer = setInterval(tick, interval);
}
/* ─── 端口效果释放（节点删除时调用） ───
 * 统一回收 floatPortRails 在节点上留下的全部资源，避免观察器/定时器泄漏：
 *   · g._portTimer      —— 降频兜底轮询
 *   · g._portFastTimers —— 快速重试链的 timeouts
 *   · g._portNodeMO     —— 节点根元素 class 观察器
 *   · node._xzgPortOnMutations —— 单例观察器的分发回调
 *   · _portMOBindings   —— 单例观察器的 nodeId 注册表（本模块私有，只能在此摘除）
 * 与 A001_port_capsule 的释放出口同源；幂等，可安全重复调用。
 */
export function releasePortNode(node, g) {
    if (g) {
        if (g._portTimer) { clearInterval(g._portTimer); g._portTimer = null; }
        if (g._portFastTimers) {
            for (const t of g._portFastTimers) clearTimeout(t);
            g._portFastTimers = null;
        }
        if (g._portNodeMO) { try { g._portNodeMO.disconnect(); } catch (e) { /* 忽略 */ } g._portNodeMO = null; }
        g._portNodeEl = null;
        g._portSig = "";
    }
    if (node) {
        node._xzgPortOnMutations = null;
        if (node.id != null) _portMOBindings.delete(String(node.id));
    }
}