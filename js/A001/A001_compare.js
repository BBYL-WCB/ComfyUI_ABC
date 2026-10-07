// ═══════════════════════════════════════════════════════════════
//  A001_子图节点 · 预览框「图像 / 视频 对比」层
//
//  职责：在预览宿主（.xzg-a001-mp-host）里叠加第二份内容，用滑块分界实现
//  「主内容 vs 对比内容」的对比观感。图像与视频共用同一套外壳。
//
//  ── 技术选型（为什么用 DOM + clip-path 而不是 canvas）──────────
//  A001 预览本身是纯 DOM（<img> / <video>），而某些节点的图像对比走 canvas 重绘
//  （drawCompare + 每帧 putImageData）。若在 A001 引入 canvas 管线，需要把
//  两张图/两个视频都先解码成位图再逐帧重绘，既与现有渲染体系割裂，也会在
//  视频对比时产生持续的绘制开销。故采用纯 DOM 视频对比的方案：
//  两层同尺寸元素叠加，上层用 clip-path 裁掉分界线左侧，只露出右侧。
//  分隔条与毛玻璃圆钮用 DOM 实现（canvas 方案里是 drawFadeLine /
//  drawGlassHandle，观感参数与之等价，数值直接对齐统一 CSS）。
//
//  ── 依赖方向（严禁反向 import）────────────────────────────────
//  本模块只依赖 A001_shared.js（依赖图最底层），**不 import A001_preview.js**：
//  对比所需的 URL 由数据层（A001_preview 的 resolveA001PreviewState）算好后传入，
//  本模块只消费现成字符串。这样避免形成 A001_preview ⇄ A001_compare 静态环
//  ——项目历史事故：环上模块顶层求值早于对方 `let` 初始化时会抛 TDZ
//  （Cannot access 'alog' before initialization），导致整个 A001 扩展静默不注册。
//
//  ── 与「防闪」机制的配合（务必保持）──────────────────────────
//  1) 同源复用：buildA001CompareLayer 在「已有对比元素且 src 未变」时**不重建**
//     DOM，只更新裁剪位置与显隐 —— 与 A001_preview 的 reuseExistingPreview 同旨。
//     拉伸节点会反复走到重绘路径，一旦重建，<video> 就会重新 load（黑闪一帧）。
//  2) 面板搬移：面板被 Vue 重建时 A001_Appearance.migrateA001PreviewContent 会把
//     宿主子元素（含本层的 cmp / cut / handle）整体 appendChild 搬走，
//     并同步 host._a001Parts 引用，故媒体实例与播放位置得以保留。
//  3) 百分比定位：clip-path 与分隔条位置全用百分比 → 节点拉伸时自动跟随，
//     无需 ResizeObserver；只有媒体元数据（naturalWidth / videoWidth）就绪时
//     需要补算一次内容矩形（用于把分界线夹在画面有效区内，消除 contain 黑边偏移）。
// ═══════════════════════════════════════════════════════════════

import { alog, safeCall } from "./A001_shared.js?v=20261007a";
import { injectStyleOnce } from "../A000/A000_DomStyle.js";

/** 交互与几何常量（数值对齐容器节点同类实现）。 */
const COMPARE = {
    /** 视频主从同步容差（秒）：与 syncCompare 一致。 */
    SYNC_TOLERANCE: 0.04,
    /** 分界线吸附半径内视为「未指定滑块位置」时的默认落点比例（中点）。 */
    DEFAULT_RATIO: 0.5,
};

const CSS_STYLE_ID = "xzg-a001-compare-style";

/* ─── 样式（观感沿用统一的 .xzg-a001-video-cut / .xzg-a001-handle） ─── */

function injectCompareCss() {
    /* 对比层媒体：容器尺寸/位置由 updateA001CompareLayer 逐帧写入 inline style
     * （锁定为「主图实际画面矩形」，使对比图与主图共用同一显示区域）；
     * 此处只给初始兜底值与 object-fit。不写 inset 简写，避免与 inline 冲突。
     * pointer-events:none —— 交互统一由宿主（host）接管，避免挡住主视频控件。 */
    injectStyleOnce(CSS_STYLE_ID, `
.xzg-a001-mp-cmp{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;z-index:2}
/* 分隔条：2px 渐隐竖线（中间实白、上下淡出），随滑块 x 平移 */
.xzg-a001-mp-cut{position:absolute;top:0;bottom:0;width:2px;pointer-events:none;z-index:3;display:none;transform:translateX(-50%);background:linear-gradient(to bottom,rgba(255,255,255,0),rgba(255,255,255,0.95) 28%,rgba(255,255,255,0.95) 72%,rgba(255,255,255,0))}
/* 毛玻璃圆钮：backdrop blur + 半透明白底 + 上端高光 + 白描边 + 左右 chevron。
 * 尺寸固定 16px（比传统方案的小一半，视觉最轻、几乎不遮挡画面）；
 * 内部 chevron、留白与描边按 16px 等比收紧（4px 箭头 + 3px 边距 + 1.5px 描边），
 * 沿用 24px 的 7px/4px/2px 会让箭头挤出圆外并互相挤压。 */
.xzg-a001-mp-handle{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;pointer-events:none;z-index:4;display:none;transform:translate(-50%,-50%);border:1.5px solid rgba(255,255,255,0.95);background:radial-gradient(circle at 50% 22%,rgba(255,255,255,0.32),rgba(255,255,255,0) 70%),rgba(255,255,255,0.16);-webkit-backdrop-filter:blur(9px) saturate(1.5);backdrop-filter:blur(9px) saturate(1.5);box-shadow:0 2px 8px rgba(0,0,0,0.35)}
.xzg-a001-mp-handle .ch{position:absolute;top:50%;width:4px;height:4px;transform:translateY(-50%) rotate(45deg)}
.xzg-a001-mp-handle .ch-l{left:3px;border-left:1.5px solid #fff;border-bottom:1.5px solid #fff;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.4))}
.xzg-a001-mp-handle .ch-r{right:3px;border-right:1.5px solid #fff;border-top:1.5px solid #fff;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.4))}
`);
}

/* ─── 内部工具 ─── */

/** 取当前对比状态（始终从 node 读最新，避免闭包里的旧引用）。 */
function currentCmpState(node) {
    return node?._a001PreviewState?.cmp || null;
}

/** 释放媒体元素（清 src 并 load，避免脱离文档后继续解码）。 */
function releaseCmpMedia(el) {
    if (!el) return;
    if (el.tagName === "VIDEO" || el.tagName === "AUDIO") {
        safeCall(() => {
            el.pause?.();
            el.removeAttribute("src");
            el.load?.();
        }, undefined, "释放对比媒体");
    } else if (el.tagName === "IMG") {
        safeCall(() => { el.removeAttribute("src"); }, undefined, "释放对比图片");
    }
}

/** 建对比层媒体元素（与主内容同尺寸同 object-fit，故内容矩形重合）。 */
function buildCompareMedia(kind, url) {
    if (kind === "video") {
        const v = document.createElement("video");
        v.className = "xzg-a001-mp-cmp";
        v.src = url;
        v.muted = true;            // 声音永远来自主视频（对比只是画面参照）
        v.loop = false;            // 短视频播完停末帧，不循环
        v.playsInline = true;
        v.autoplay = false;
        v.controls = false;        // 控件只给主视频，对比层保持纯净
        v.preload = "metadata";
        return v;
    }
    const img = document.createElement("img");
    img.className = "xzg-a001-mp-cmp";
    img.src = url;
    img.alt = "";
    return img;
}

/**
 * 计算主内容的「实际画面矩形」（相对宿主）。
 *
 * 【为什么必须算】两层都是 object-fit:contain，媒体宽高比与宿主不一致时会留黑边；
 * 若分界线按宿主宽度取百分比，就会飘到黑边上（与画面分界对不上）。
 * 蓝本：updateVideoPreview 用 videoWidth/videoHeight 反算并 clamp。
 * 元数据未就绪（尺寸为 0）→ 返回 null，调用方跳过 clamp（不阻断显示）。
 */
function contentRectOf(el, W, H) {
    if (!el || !(W > 0) || !(H > 0)) return null;
    const isVideo = el.tagName === "VIDEO";
    const nw = isVideo ? (el.videoWidth || 0) : (el.naturalWidth || 0);
    const nh = isVideo ? (el.videoHeight || 0) : (el.naturalHeight || 0);
    if (!(nw > 0) || !(nh > 0) || !isFinite(nw) || !isFinite(nh)) return null;
    const scale = Math.min(W / nw, H / nh);
    const cw = nw * scale;
    const ch = nh * scale;
    return { x: (W - cw) / 2, y: (H - ch) / 2, w: cw, h: ch };
}

/** 数值夹取。 */
function clampNum(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
}

/* ─── 几何更新（不重建 DOM） ─── */

/**
 * 刷新对比层的裁剪位置与显隐。
 *
 * 显隐规则：**只要存在对比源就常显**分界线与圆钮（与「悬停才显示」
 * 不同，理由见下），使用户一运行就能看出「这个预览有对比」。
 *
 * 【为什么不采用悬停显示】悬停显示依赖鼠标事件落到预览元素上，
 * 而 A001 的预览框有个特殊约束：面板 .xzg-a001-panel 为「不拦截端口/控件交互」
 * 设了 pointer-events:none，该属性可继承，图像元素又是 none，导致图像区域根本
 * 收不到指针事件（video 因自身设了 auto 才恰好可用）。若沿用「悬停才显示」，
 * 图像对比会一直不可见（实测反馈「图像连接2个插槽后没有产生对比」）。
 * 故这里改为常显，同时由 buildA001CompareLayer 在有对比源时把宿主显式设为
 * pointer-events:auto，让拖拽交互真正可用。
 */
export function updateA001CompareLayer(node, host, cmpState) {
    if (!node || !host) return;
    const parts = host._a001Parts;
    if (!parts?.cmp || !parts.cut || !parts.handle) return;
    const show = !!cmpState?.url;
    if (!show) {
        safeCall(() => {
            parts.cmp.style.display = "none";
            parts.cmp.style.clipPath = "";
            parts.cut.style.display = "none";
            parts.handle.style.display = "none";
        }, undefined, "隐藏对比层");
        return;
    }
    safeCall(() => {
        const rect = host.getBoundingClientRect();
        const W = rect.width || 1;
        const H = rect.height || 1;
        /* ★★ 尺寸方式对齐 A002_ImageComparer.js 的 drawImage（L63-93）：
         *  两张图各自 object-fit:contain 到**同一个框**（宿主）并各自居中 ——
         *  A002 的注释口径是「其余与基图共用同框中线对齐」，即不把任何一张图
         *  锁进对方的显示矩形，两图只共享「框」与「中线」。
         *  · 容器：铺满宿主（与主图 buildImage / buildVideo 的 100%×100% 同规则）
         *  · 容器与裁剪边都用百分比 → 拉伸时自动跟随；仅当「宿主宽高比变化使
         *    contain 结果改变、百分比基准随之变化」时需要一步重算，由 hookHostResize 兜住 */
        parts.cmp.style.left = "0";
        parts.cmp.style.top = "0";
        parts.cmp.style.width = "100%";
        parts.cmp.style.height = "100%";
        parts.cmp.style.right = "auto";
        parts.cmp.style.bottom = "auto";
        // 滑块位置：未指定过则落在中点（本地 px）；与其它节点同口径只夹在框内
        let cutX = typeof node._a001CmpSliderX === "number"
            ? node._a001CmpSliderX
            : W * COMPARE.DEFAULT_RATIO;
        cutX = clampNum(cutX, 0, W);
        const hostPct = clampNum((cutX / W) * 100, 0, 100);
        /* ★★★ 裁剪矩形与 A002_ImageComparer.drawImage 的 ctx.clip() 严格一一对应。
         *
         *  A002 的裁剪（L81-91）：
         *      winRight = dx + tw                        // 图乙绘制区右边界
         *      winLeft  = clamp(cropX, dx, winRight)     // 分界线夹进图乙绘制区
         *      ctx.rect(winLeft, dy, visW, th); ctx.clip();
         *  → 裁剪矩形 = (winLeft, dy) 到 (winRight, dy + th)
         *    即【左边界=分界线（夹进图乙绘制区）、上下边界=图乙自己的 dy / dy+th】。
         *
         *  本实现用 clip-path 的百分比表达同一个矩形（元素自身尺寸为基准）：
         *      左  : clipLeft%   = winLeft / W
         *      上  : clipTop%    = dy / H
         *      下  : clipBottom% = (H - dy - th) / H
         *  其中 W/H 是宿主尺寸（对比层铺满宿主 → 元素尺寸 == 宿主尺寸），
         *  dx/dy/tw/th 由 contentRectOf(对比层) 算出 —— 它就是 CSS object-fit:contain
         *  的结果，与 A002 手算的 contain 公式完全同源（同一 ia/wa 判据）。
         *
         *  ⚠️ 只写 inset(0 0 0 X%) 时的偏差（实测反馈「对比尺寸不对」）：
         *     上下被裁到 0~H（整个宿主），而 A002 只裁 dy~dy+th；
         *     当对比图上下有黑边（th < H）时，分界线右侧会多露出黑边区域。
         *  ⚠️ 也曾错把「内容矩形内的比例」当左边界百分比：那会把左边界基准从
         *     W 换成 tw，滑块一偏离内容区中点，裁剪边就与竖线错开。
         */
        const cmpRect = contentRectOf(parts.cmp, W, H);
        let clipLeft = clampNum(cutX / W, 0, 1) * 100;
        let clipTop = 0;
        let clipBottom = 0;
        if (cmpRect) {
            /* ① 左边界：winLeft = clamp(cutX, dx, dx + tw)，再除以 W 转百分比。 */
            const winLeft = clampNum(cutX, cmpRect.x, cmpRect.x + cmpRect.w);
            clipLeft = clampNum((winLeft / W) * 100, 0, 100);
            /* ② 上下边界：对应 A002 的 dy 与 dy+th。 */
            clipTop = clampNum((cmpRect.y / H) * 100, 0, 100);
            clipBottom = clampNum(((H - cmpRect.y - cmpRect.h) / H) * 100, 0, 100);
        }
        /* ★ 脏值短路（性能）：几何与上次完全一致时直接返回，避免拉伸/巡检路径
         *   每帧都重写 clipPath / left 等样式触发样式重算。 */
        const sig = `${clipLeft.toFixed(2)}|${clipTop.toFixed(2)}|${clipBottom.toFixed(2)}|${hostPct.toFixed(2)}|${W.toFixed(1)}|${H.toFixed(1)}`;
        if (host._a001CmpSig === sig) return;
        host._a001CmpSig = sig;
        parts.cmp.style.display = "block";
        /* 四值 inset = 左 winLeft、上 dy、下 dy+th（右 0，因 winRight 即元素右边界）。 */
        parts.cmp.style.clipPath =
            `inset(${clipTop}% 0 ${clipBottom}% ${clipLeft}%)`;
        parts.cut.style.display = "block";
        parts.cut.style.left = `${hostPct}%`;
        parts.handle.style.display = "block";
        parts.handle.style.left = `${hostPct}%`;
    }, undefined, "更新对比层几何");
}

/* ─── 视频主从同步 ─── */

/**
 * 视频对比播放同步：以主视频为进度轴，对比视频跟随。
 * 短视频播到末尾帧后停留，等主视频走完（与 syncCompare 同款语义）。
 */
function syncA001ComparePlayback(node, host) {
    const parts = host?._a001Parts;
    const main = parts?.main;
    const cmp = parts?.cmp;
    if (!main || !cmp) return;
    if (main.tagName !== "VIDEO" || cmp.tagName !== "VIDEO") return;
    safeCall(() => {
        const t = isFinite(main.currentTime) ? main.currentTime : 0;
        if (Math.abs(cmp.currentTime - t) > COMPARE.SYNC_TOLERANCE) {
            cmp.currentTime = t;
        }
        const cDur = (cmp.duration && isFinite(cmp.duration)) ? cmp.duration : Infinity;
        const atEnd = isFinite(cDur) && t >= cDur - COMPARE.SYNC_TOLERANCE;
        if (main.paused || atEnd) {
            cmp.pause();          // 主轴暂停 或 短视频已到末尾 → 停留最后一帧
        } else if (cmp.paused) {
            cmp.play().catch(() => {});
        }
    }, undefined, "对比视频同步");
}

/** 给主视频挂 timeupdate 同步（幂等：同一元素只挂一次）。 */
function hookMainPlaybackSync(node, host) {
    const main = host?._a001Parts?.main;
    if (!main || main.tagName !== "VIDEO" || main._a001CmpSyncHooked) return;
    main._a001CmpSyncHooked = true;
    /* ★ 保存 handler 引用：匿名函数无移除路径，主元素被复用时无法解绑。 */
    const onTimeUpdate = () => {
        safeCall(() => syncA001ComparePlayback(node, host), undefined, "对比视频同步");
    };
    main.addEventListener("timeupdate", onTimeUpdate);
    main._a001CmpSyncHandler = onTimeUpdate;
}

/**
 * 监听宿主尺寸变化 → 重算对比层几何（幂等：每个宿主元素只挂一次）。
 *
 * 【为什么仍保留】裁剪边按「对比图内容矩形」换算成百分比 —— 若宿主宽高比变化
 * （例如节点被拉得很扁），对比图的 contain 结果随之改变，百分比基准也变，
 * 必须重算一次才能让裁剪边继续贴合画面分界。纯百分比定位能自动跟随尺寸，
 * 但跟随不了「宽高比变化导致的 contain 结果变化」，故这里仍需一步重算。
 * rAF 合并：ResizeObserver 在拖动拉伸时逐帧触发，合并成每帧一次写入。
 * 改的是对比元素的 inline 样式（绝对定位，不影响宿主尺寸）→ 不会自激。
 */
function hookHostResize(node, host) {
    if (!host || host._a001CmpRO) return;
    if (typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            safeCall(
                () => updateA001CompareLayer(node, host, currentCmpState(node)),
                undefined,
                "宿主尺寸变化重算对比层"
            );
        });
    });
    ro.observe(host);
    host._a001CmpRO = ro;
}

/* ─── 交互（悬停显示 + 按住拖拽，复刻 A002 起的滑动模式） ─── */

/**
 * 把交互绑到宿主上（幂等：每个宿主元素只绑一次）。
 *
 * · 按住（pointerdown）→ 在点击处吸附并开始拖拽（视频控件条区域避让）；
 * · 拖动（pointermove）→ 仅在拖拽中实时跟随；
 * · 松开（pointerup / pointercancel）→ 停止跟随；
 * · 离开（pointerleave）→ 仅停止拖拽；分界线与圆钮**常显**（见 updateA001CompareLayer
 *   的说明：A001 预览框受 pointer-events 继承影响，不能延用悬停显隐）。
 */
function bindCompareInteractions(node, host) {
    if (!host || host._a001CmpHooked) return;
    host._a001CmpHooked = true;

    const snapX = (clientX) => {
        const r = host.getBoundingClientRect();
        return clampNum(clientX - r.left, 0, r.width || 1);
    };
    const refresh = () => updateA001CompareLayer(node, host, currentCmpState(node));

    const onMove = (e) => {
        if (!node._a001CmpDragging) return;
        /* 拖拽中同样阻止冒泡：避免事件继续上行让画布/节点把本次移动当成拖动。 */
        e.stopPropagation();
        const x = snapX(e.clientX);
        if (node._a001CmpSliderX !== x) {
            node._a001CmpSliderX = x;
            refresh();
        }
    };
    const onDown = (e) => {
        /* ★ 视频底部控件条区域不抢占：主视频带 controls（播放/进度/音量），
         *  用户在控件条上按下是想操作播放，若照样吸附拖拽，每次点播放键都会
         *  把分界线吸到点击处 —— 故按控件条高度（约 48px）避让，其余区域
         *  （画面本体）照常吸附拖拽。属本节点的体验改进。
         *  注意：本条 return 必须早于下面的 stopPropagation —— 控件条要让事件正常上行，
         *  否则播放控件会失去响应。 */
        const main = host._a001Parts?.main;
        if (main && main.tagName === "VIDEO" && e.target === main) {
            const r = main.getBoundingClientRect();
            if (r.height > 0 && e.clientY >= r.bottom - 48) return;
        }
        /* ★★ 必须阻止冒泡（实测踩坑）：宿主位于 .lg-node 内部，pointerdown 会继续
         *  上行到节点主体 / 画布，被官方判为「按住节点拖动」——表现为「拖动对比线时
         *  整节点跟着一起移动」，并因节点位移触发端口胶囊重算，看起来像胶囊闪了一下。
         *  preventDefault 另用于抑制图片的原生拖拽（拖出 ghost 图）与文本选择。 */
        e.stopPropagation();
        e.preventDefault?.();
        node._a001CmpDragging = true;
        node._a001CmpSliderX = snapX(e.clientX);
        refresh();
        try { host.setPointerCapture(e.pointerId); } catch (_e) { /* 忽略 */ }
    };
    const stopDrag = (e) => {
        node._a001CmpDragging = false;
        /* 抬起同样阻止冒泡：避免画布收到 pointerup 前的移动事件后补触发一次节点拖拽。 */
        e?.stopPropagation?.();
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointerup", stopDrag);
    host.addEventListener("pointercancel", stopDrag);
    host.addEventListener("pointerleave", stopDrag);
    /* ★ 保存同一批 handler 实例：原实现注册的是匿名箭头函数，没有任何移除路径，
     *   dispose 只清 host._a001CmpHooked → 宿主被复用时监听逐次叠加、refresh 重复触发。
     *   现集中存到宿主上，由 disposeA001Compare 按同一批实例解绑。 */
    host._a001CmpHandlers = { move: onMove, down: onDown, stop: stopDrag };
}

/* ─── 对外主入口 ─── */

/**
 * 确保对比层 DOM 与目标状态一致（幂等）。
 *
 * 复用判定：已有对比元素且 `src` 未变 → **只更新，不重建**
 * （重建会让 <video> 重新 load → 黑闪一帧，这是已修复过的回归点）。
 * 主元素引用由 A001_preview 在建好主内容后写入 `host._a001Parts.main`。
 *
 * @param {object} node A001 子图节点
 * @param {HTMLElement} host 预览宿主（.xzg-a001-mp-host）
 * @param {{kind:string,url:string}|null} cmpState 对比状态；null = 无对比
 */
export function buildA001CompareLayer(node, host, cmpState) {
    if (!node || !host) return;
    injectCompareCss();
    safeCall(() => {
        const parts = (host._a001Parts = host._a001Parts || {});
        /* 无对比源 → 不建层，但把已有层藏起来（保留 DOM，下次同源可复用）。 */
        if (!cmpState?.url) {
            updateA001CompareLayer(node, host, null);
            return;
        }
        const wantSrc = cmpState.url;
        const sameKind = parts.cmp && (
            (cmpState.kind === "video" && parts.cmp.tagName === "VIDEO") ||
            (cmpState.kind === "image" && parts.cmp.tagName === "IMG")
        );
        const sameSrc = parts.cmp && (parts.cmp.getAttribute("src") || "") === wantSrc;
        if (!(sameKind && sameSrc)) {
            /* 源变了（或首次建）→ 换掉对比元素本体。 */
            if (parts.cmp) {
                releaseCmpMedia(parts.cmp);
                safeCall(() => parts.cmp.remove(), undefined, "移除旧对比元素");
            }
            parts.cmp = buildCompareMedia(cmpState.kind, wantSrc);
            /* 插在主内容之后、分隔条之前（DOM 顺序决定层叠，z-index 另有兜底）。 */
            host.appendChild(parts.cmp);
        }
        /* 分隔条与圆钮只建一次（随宿主生命周期存活）。 */
        if (!parts.cut) {
            parts.cut = document.createElement("div");
            parts.cut.className = "xzg-a001-mp-cut";
            host.appendChild(parts.cut);
        }
        if (!parts.handle) {
            parts.handle = document.createElement("div");
            parts.handle.className = "xzg-a001-mp-handle";
            parts.handle.innerHTML = '<span class="ch ch-l"></span><span class="ch ch-r"></span>';
            host.appendChild(parts.handle);
        }
        /* ★★★ 元数据就绪后补算几何 —— 主内容与【对比元素】都要挂（实测重大遗漏）。
         *
         * 原实现只给主内容挂了回调，对比元素没有 —— 这是「四值裁剪改了却毫无效果」的根因：
         *   · 对比元素刚创建时 naturalWidth / videoWidth 还是 0（媒体尚未加载完）；
         *   · 此时 contentRectOf(对比元素) 返回 null → clipTop/clipBottom 退化为 0，
         *     即等价于旧的单值 inset，四值逻辑【从未真正生效】；
         *   · 该结果又被写进 _a001CmpSig 短路缓存，之后没有事件再触发重算，
         *     于是永远停在退化值上（用户看到的现象：改了没用、和之前一样）。
         * 修法：对比元素同样监听元数据事件 → 到位后重算一次几何。
         * 注意 hook 标记写在各自元素上，避免复用同一元素时重复挂监听。 */
        const onMeta = () => updateA001CompareLayer(node, host, currentCmpState(node));
        for (const el of [parts.main, parts.cmp]) {
            if (!el || el._a001CmpMetaHooked) continue;
            el._a001CmpMetaHooked = true;
            /* <img> 只发 load；<video> 发 loadedmetadata（首帧尺寸可用的最早时刻）。
             * 两个都挂，交由 updateA001CompareLayer 的脏值短路去重。 */
            el.addEventListener("loadedmetadata", onMeta);
            el.addEventListener("load", onMeta);
            /* ★ 保存 handler 引用（main / cmp 两个元素共用同一实例）供 dispose 解绑。 */
            el._a001CmpMetaHandler = onMeta;
            /* ★ 缓存命中时不会再触发 load/loadedmetadata（事件已过），
             *   故立即补算一次；若确实还没就绪，contentRectOf 返回 null、
             *   几何退化为单值，等事件到达再纠正。 */
            safeCall(() => onMeta(), undefined, "对比层几何即时补算");
        }
        hookMainPlaybackSync(node, host);
        hookHostResize(node, host);
        bindCompareInteractions(node, host);
        /* ★ 交互可用性（关键）：面板 .xzg-a001-panel 为「不拦截端口/控件」设了
         *  pointer-events:none，而该属性会被子元素继承 —— 宿主与图像元素都收不到
         *  指针事件，图像对比既不能拖拽也看不到任何反馈。
         *  有对比源时把宿主显式设为 auto（覆盖继承），无对比时还原为空（回到原状，
         *  预览区仍可穿透、不影响节点拖动与端口交互）。 */
        const wantPE = cmpState?.url ? "auto" : "";
        if (host.style.pointerEvents !== wantPE) host.style.pointerEvents = wantPE;
        /* 十字光标只在有对比源时启用；单内容状态保持默认光标，不做无谓暗示。 */
        const wantCursor = cmpState?.url ? "crosshair" : "";
        if (host.style.cursor !== wantCursor) host.style.cursor = wantCursor;
        updateA001CompareLayer(node, host, cmpState);
    }, undefined, "构建对比层");
}

/**
 * 释放对比层（节点删除时调用）。
 *
 * 只清本模块的引用与交互标志；DOM 本体（cmp / cut / handle）由
 * A001_preview.disposeA001Preview 统一遍历宿主子元素释放媒体资源，
 * 这里不重复处理，避免两边都 removeChild 造成竞态。
 */
export function disposeA001Compare(node) {
    if (!node) return;
    node._a001CmpDragging = false;
    node._a001CmpSliderX = null;
    const host = node._a001PreviewHost;
    if (host) {
        const parts = host._a001Parts;
        if (parts) {
            /* ★ 先解绑媒体元素上的同步监听，再释放媒体资源：
             *   原先 handler 为匿名函数、无处移除，仅靠元素被丢弃回收；
             *   宿主 / 主元素被复用时监听会逐次叠加（重复同步、重复几何重算）。 */
            safeCall(() => {
                const main = parts.main;
                if (main?._a001CmpSyncHandler) {
                    main.removeEventListener("timeupdate", main._a001CmpSyncHandler);
                    main._a001CmpSyncHandler = null;
                    main._a001CmpSyncHooked = false;
                }
                for (const el of [main, parts.cmp]) {
                    if (!el?._a001CmpMetaHandler) continue;
                    el.removeEventListener("loadedmetadata", el._a001CmpMetaHandler);
                    el.removeEventListener("load", el._a001CmpMetaHandler);
                    el._a001CmpMetaHandler = null;
                    el._a001CmpMetaHooked = false;
                }
            }, undefined, "解绑对比层媒体监听");
            releaseCmpMedia(parts.cmp);
            parts.cmp = null;
            parts.cut = null;
            parts.handle = null;
        }
        /* 断开宿主尺寸监听，避免节点删除后仍对已脱离的宿主做重算。 */
        safeCall(() => {
            host._a001CmpRO?.disconnect?.();
            host._a001CmpRO = null;
        }, undefined, "断开对比层尺寸监听");
        /* ★ 解绑交互监听：原先只清标志、监听留在宿主上，宿主复用时重复叠加。 */
        safeCall(() => {
            const h = host._a001CmpHandlers;
            if (!h) return;
            host.removeEventListener("pointermove", h.move);
            host.removeEventListener("pointerdown", h.down);
            host.removeEventListener("pointerup", h.stop);
            host.removeEventListener("pointercancel", h.stop);
            host.removeEventListener("pointerleave", h.stop);
            host._a001CmpHandlers = null;
        }, undefined, "解绑对比层交互");
        host._a001CmpHooked = false;
        host.style.cursor = "";
        host.style.pointerEvents = "";
    }
    alog("对比层已释放");
}

export default {
    buildA001CompareLayer,
    updateA001CompareLayer,
    disposeA001Compare,
};