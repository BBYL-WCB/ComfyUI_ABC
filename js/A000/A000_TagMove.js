import { app } from "../../../scripts/app.js";
import { injectStyleOnce } from "./A000_DomStyle.js";

// ═══════════════════════════════════════════════════════════════
//  A000-2  标题徽章
//   · Nodes 2.0 下对所有节点自动生效（无需登记）
//  · 背景：ComfyUI 前端内置 Comfy.NodeBadge 扩展会生成
//      #节点ID / 生命周期 / 节点来源
//    徽章。在新版前端（Nodes 2.0）中，节点由 Vue 以 DOM 渲染：
//      标题栏  .lg-node-header
//      徽章栏  div.mt-auto（位于节点 body 末尾，被 mt-auto 顶到底部）
//    画布 LGraphNode.drawBadges 在该模式下不再被调用，因此只能走 DOM 方案。
//  · 目标：把徽章栏从节点底部搬进标题栏右侧插槽，与标题同一行、垂直居中显示。
//  · 实现：
//      1) 定位节点的徽章栏（.lg-node 内、带 mt-auto 且含徽章胶囊的那个 div）
//      2) 将其移入 .lg-node-header 末尾（标题栏右侧插槽）
//      3) 改写内联样式，使其在标题栏内右对齐、不再撑高 body
//      4) MutationObserver 监听 Vue 重渲染，重建后自动重新搬运
//  · 生效范围：Nodes 2.0 下对所有带徽章栏的节点自动生效（无需登记）。
// ═══════════════════════════════════════════════════════════════

/** 本次搬运打上的标记，避免重复处理。 */
const MOVED_ATTR = "data-abc-title-badge";

/** A000-2 总开关：Nodes 2.0 下是否把「节点ID/节点来源」徽章搬进标题栏（默认开）。
 *  在 ABC设置 注入式开关控制；状态随 A000-ABCsettings.json 持久化。 */
let titleBadgeEnabled = true;

/** 供 A000_SettingsPage.js 读写总开关（状态随 A000-ABCsettings.json 持久化）。 */
export function setTitleBadgeEnabled(v) { titleBadgeEnabled = !!v; }
export function getTitleBadgeEnabled() { return titleBadgeEnabled; }

/** 徽章内层标签（「#5」与「000_ComfyUI_ABC」）的高度：原为 Tailwind h-6（24px），改为 12px。 */
const BADGE_CHIP_HEIGHT = 12;

/** 徽章内层分隔竖线的高度：原为 Tailwind h-4（16px），改为 10px。 */
const BADGE_DIVIDER_HEIGHT = 10;

/** 注入一次性 CSS：分别设定内层标签与分隔线的高度（幂等，见 A000_DomStyle）。 */
function injectCss() {
    injectStyleOnce("xzg-abc-title-badge-style", `
/* ── ABC 标题徽章：内层标签 24px(h-6) → 12px ── */
[${MOVED_ATTR}] > div > div {
    height: ${BADGE_CHIP_HEIGHT}px !important;
    max-height: ${BADGE_CHIP_HEIGHT}px !important;
    min-height: 0 !important;
    box-sizing: border-box !important;
}
/* 内层标签上下内边距归零，文字垂直居中 */
[${MOVED_ATTR}] > div > div {
    padding-top: 0 !important;
    padding-bottom: 0 !important;
}
/* 分隔竖线：16px(h-4) → 10px，居中显示 */
[${MOVED_ATTR}] > div > div[class*="border-r"] {
    height: ${BADGE_DIVIDER_HEIGHT}px !important;
    max-height: ${BADGE_DIVIDER_HEIGHT}px !important;
    align-self: center !important;
}
`);
}

/** 定位徽章栏：类名含 mt-auto 且内部有徽章胶囊节点的 div。 */
function findBadgeBar(nodeEl) {
    const bars = nodeEl.querySelectorAll("div.mt-auto");
    for (const bar of bars) {
        // 徽章胶囊：圆角容器 + 内部至少一个文本胶囊
        if (bar.querySelector("div.rounded-full")) return bar;
    }
    return bars.length === 1 ? bars[0] : null;
}

/** 取标题栏 */
function findHeader(nodeEl) {
    return nodeEl.querySelector(".lg-node-header");
}

/** 取标题栏内与标题同行的 flex 行容器（标题栏第一个子元素）。 */
function findHeaderRow(header) {
    // 结构：<div class="lg-node-header"><div class="flex ... justify-between ...">…</div></div>
    const row = header.firstElementChild;
    if (row && getComputedStyle(row).display.includes("flex")) return row;
    return header;
}

/** 把徽章栏搬进标题栏，并改写样式使其与标题同行右对齐。 */
function moveBadgeIntoHeader(nodeEl) {
    const bar = findBadgeBar(nodeEl);
    const header = findHeader(nodeEl);
    if (!bar || !header) return false;

    // 已经在标题栏里就只做一次样式校正
    if (bar.parentElement === header || header.contains(bar)) {
        applyInlineStyle(bar);
        bar.setAttribute(MOVED_ATTR, "1");
        return true;
    }

    findHeaderRow(header).appendChild(bar);
    bar.setAttribute(MOVED_ATTR, "1");
    applyInlineStyle(bar);
    return true;
}

/** 内联样式：使徽章栏在标题栏内右对齐、不撑高 body，且绝不溢出节点右边界。 */
function applyInlineStyle(bar) {
    const s = bar.style;
    s.marginTop = "0";
    s.marginLeft = "auto";
    s.width = "auto";
    // 允许收缩：空间不足时压缩徽章而不是溢出节点
    s.flex = "0 1 auto";
    s.minWidth = "0";
    s.alignSelf = "center";
    s.alignItems = "center";
    s.paddingLeft = "0";
    s.paddingRight = "0";
    s.overflow = "hidden";
    s.maxWidth = "60%";
    s.pointerEvents = "auto";
    // 放开 h-5(20px) 对高度的压缩，让内层标签 12px 完整显示
    s.height = "auto";
    s.maxHeight = "none";

    // 内层胶囊与文字同样允许收缩，防止内容宽度把徽章撑回溢出状态
    const cap = bar.firstElementChild;
    if (cap) {
        cap.style.minWidth = "0";
        cap.style.overflow = "hidden";
        for (const chip of cap.children) {
            chip.style.minWidth = "0";
            chip.style.overflow = "hidden";
            chip.style.flexShrink = "1";
            chip.style.whiteSpace = "nowrap";
            chip.style.textOverflow = "ellipsis";
        }
    }
}

/** 处理单个节点 DOM：开关开 → 搬运进标题栏；关 → 还原到节点底部默认位置。 */
function processNodeEl(nodeEl) {
    if (!nodeEl?.classList?.contains("lg-node")) return;
    try {
        if (titleBadgeEnabled) moveBadgeIntoHeader(nodeEl);
        else restoreBadgeToBody(nodeEl);
    } catch (_e) { /* 忽略单个节点异常 */ }
}

/** 关闭开关时：把已搬进标题栏的徽章还原到节点 body 末尾（Vue 默认位置）。
 *  Vue 重建后的节点本就在底部且不携带标记，此处只处理当前仍被搬动的节点。 */
function restoreBadgeToBody(nodeEl) {
    const bar = nodeEl.querySelector(`[${MOVED_ATTR}]`);
    if (!bar) return;
    const body = nodeEl.querySelector(".lg-node-body") || nodeEl;
    if (bar.parentElement) bar.parentElement.removeChild(bar);
    body.appendChild(bar);
    bar.removeAttribute(MOVED_ATTR);
    bar.style.cssText = "";
}

/** 扫描画布上所有节点 DOM。 */
function scanAll() {
    const root = app.canvas?.canvas?.parentElement ?? document;
    const nodes = root?.querySelectorAll?.(".lg-node");
    if (!nodes) return;
    for (const el of nodes) processNodeEl(el);
}

let _observer = null;
let _scanPending = false;

/** 用 rAF 合帧调度一次全画布扫描：一次性大量 DOM 变更只触发一帧扫描。 */
function scheduleScan() {
    if (_scanPending) return;
    _scanPending = true;
    requestAnimationFrame(() => {
        _scanPending = false;
        scanAll();
    });
}

/** 启动 MutationObserver，处理 Vue 重渲染后的徽章栏。 */
function startObserver() {
    if (_observer) return;
    const root = app.canvas?.canvas?.parentElement ?? document.body;
    if (!root) return;

    _observer = new MutationObserver((records) => {
        for (const r of records) {
            const t = r.target;
            if (t?.closest?.(".lg-node")) return scheduleScan();
            /* ★ 只有「新增元素属于某个 .lg-node」时才需要重扫徽章：
             *   预览图、进度条、日志、toast 等画布外新增与徽章搬运无关；
             *   原先「任何 addedNodes 都 schedule」会让生成过程中高频全画布扫描。 */
            const added = r.addedNodes;
            if (!added?.length) continue;
            for (const n of added) {
                if (n?.nodeType !== 1) continue;
                if (n.classList?.contains("lg-node") || n.closest?.(".lg-node")) return scheduleScan();
            }
        }
    });
    _observer.observe(root, { childList: true, subtree: true });

    scheduleScan();
}

/** 安装：启动观察器并调度一次扫描（rAF 合帧，避免多入口同步重复全量扫描）。 */
function install() {
    if (typeof document === "undefined") return;
    injectCss();
    startObserver();
    scheduleScan();
}

// ── A000-2 扩展注册（与 A000-1 同文件，但各自独立注册入口）──
app.registerExtension({
    name: "ABC.TitleBadge",
    setup() {
        install();
        setTimeout(install, 500);
        setTimeout(install, 1500);
    },
    nodeCreated() { install(); },
    loadedGraphNode() { install(); },
});

export { install as installTitleBadge, scanAll };
