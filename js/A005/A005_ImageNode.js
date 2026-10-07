// ═══════════════════════════════════════════════════════════════
//  A005 图片节点 · Nodes 2.0 DOM Widget 版（入口）
//  · addDOMWidget 挂载真实 DOM（预览画布 + 文本框 + 运行按钮），
//    布局参数（尺寸 / 圆角 / 间距 / 颜色）统一由 A005_shared.js 的 NODE_SIZE 提供，本文件不写裸值
//  · getMinHeight 固定值；不设 getMaxHeight → 节点本体可自由拉伸
//  · 底部不预留手柄区：DOM 高度 100% 填满节点
//  · 隐藏后端「文本」原生控件（widget.hidden + options.hidden 双写 + 幽灵化），
//    由 DOM 内 textarea 接管（值实时同步回后端 widget，保证序列化与插槽绑定）
//  · 保留：双击进入子图 / 对比图悬停滑块 / 执行展开（子图内部节点参与 prompt）
//  ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import {
    alog,
    safeCall,
    getTextWidget,
    hideNativeWidget,
    NODE_TYPE,
    NODE_SIZE,
    a005Nodes,
} from "./A005_shared.js";
import {
    ensureSubgraph,
    restoreSavedPreview,
    collectEmbeddedSubgraphDefs,
    bindTextWidgetToSlot,
    detachSlotSync,
} from "./A005_subgraph.js";
import {
    attachExecutionHooks,
    queueRunNodeOnly,
} from "./A005_exec.js";
import {
    attachWorkflowButtons,
} from "./A005_workflow.js";
import { floatPortRails, releasePortNode } from "../A000/A000_Port.js";

// 节点尺寸常量统一在 A005_shared.js 的 NODE_SIZE 定义，此处只解构使用
const S = NODE_SIZE;
const { MIN_W, TITLE_H, WIDGET_MIN_H, MIN_H, SETTINGS_H, TEXT_MIN_H, GAP } = S;

/* ─── CSS 注入 ─── */

let _cssInjected = false;
function injectCss() {
    if (_cssInjected) return;
    _cssInjected = true;
    const style = document.createElement("style");
    style.textContent = `
.xzg-a005-dom{width:100%;height:100%;box-sizing:border-box;padding:${S.PAD_TOP}px ${S.PAD_SIDE}px;display:flex;flex-direction:column;overflow:hidden;background:transparent}
.xzg-a005-frame{width:100%;height:100%;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:${S.GAP}px;box-sizing:border-box;overflow:hidden;background:${S.CONTAINER_BG};border-radius:${S.CORNER_RADIUS}px;padding:${S.FRAME_PAD}px}
.xzg-a005-preview{flex:5 1 0;min-height:${S.PREVIEW_MIN_H}px;position:relative;border:none;border-radius:${S.CORNER_RADIUS}px;background:${S.SURFACE_BG};overflow:hidden}
.xzg-a005-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
.xzg-a005-text-wrap{flex:2 1 0;min-height:${S.TEXT_MIN_H}px;position:relative;display:flex;width:100%;box-sizing:border-box}
.xzg-a005-text{flex:1 1 0;width:100%;box-sizing:border-box;background:${S.SURFACE_BG};border:none;border-radius:${S.TEXT_RADIUS}px;color:${S.TEXT_FG};caret-color:${S.TEXT_FG};font-size:${S.TEXT_FONT_SIZE}px;line-height:${S.TEXT_LINE_HEIGHT};padding:${S.TEXT_PAD}px;resize:none;outline:none;font-family:inherit}
.xzg-a005-text::placeholder{color:${S.TEXT_PLACEHOLDER};opacity:1}
.xzg-a005-bottom{display:flex;flex-direction:column;gap:${S.GAP}px;width:100%;flex-shrink:0;box-sizing:border-box}
.xzg-a005-bottom-row{display:flex;flex-direction:row;align-items:center;gap:${S.GAP}px;width:100%;box-sizing:border-box}
.xzg-a005-set{width:${S.SET_BTN_SIZE}px;height:${S.SET_BTN_SIZE}px;flex:0 0 ${S.SET_BTN_SIZE}px;box-sizing:border-box;border:1px solid ${S.SET_BTN_BORDER};border-radius:50%;background:${S.SET_BTN_BG};color:${S.TEXT_FG};cursor:pointer;font-size:${S.SET_BTN_FONT_SIZE}px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0}
.xzg-a005-set:hover{filter:brightness(1.25)}
.xzg-a005-txt{width:${S.SET_BTN_SIZE}px;height:${S.SET_BTN_SIZE}px;flex:0 0 ${S.SET_BTN_SIZE}px;box-sizing:border-box;border:1px solid ${S.SET_BTN_BORDER};border-radius:50%;background:${S.SET_BTN_BG};color:${S.TEXT_FG};cursor:pointer;font-size:${S.SET_BTN_FONT_SIZE}px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0}
.xzg-a005-txt:hover{filter:brightness(1.25)}
.xzg-a005-txt.xzg-a005-txt-on{background:${S.BTN_COLOR};color:#fff}
.xzg-a005-run{height:${S.BTN_H}px;flex:1 1 0;min-width:0;box-sizing:border-box;border:none;border-radius:${S.BTN_RADIUS}px;background:${S.BTN_COLOR};color:${S.BTN_FG};font-size:${S.BTN_FONT_SIZE}px;line-height:1;display:flex;align-items:center;justify-content:center;text-align:center;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xzg-a005-run:hover{background:${S.BTN_HOVER}}
.xzg-a005-settings{display:none;flex-direction:column;height:${S.SETTINGS_BOX_H}px;margin-top:0;flex-shrink:0;width:100%;box-sizing:border-box;border:1px solid ${S.SETTINGS_BOX_BORDER};border-radius:${S.SETTINGS_BOX_RADIUS}px;background:${S.SETTINGS_BOX_BG};padding:${S.SETTINGS_BOX_PAD}px;gap:${S.GAP}px}
.xzg-a005-settings.xzg-a005-open{display:flex}
.xzg-a005-set-row{display:flex;flex-direction:row;gap:${S.GAP}px;width:100%;box-sizing:border-box}
/* 文本框隐藏态：整块不参与 flex 布局（flex-basis 归零 + 不显示 + 不占最小高） */
.xzg-a005-text-wrap.xzg-a005-notext{display:none;flex:0 0 0;min-height:0}
.xzg-a005-set-btn{flex:1 1 0;height:${S.SET_BTN_SM_H}px;min-width:0;box-sizing:border-box;border:1px solid ${S.SET_BTN_SM_BORDER};border-radius:${S.SET_BTN_SM_RADIUS}px;background:${S.SET_BTN_SM_BG};color:${S.SET_BTN_SM_FG};font-size:${S.SET_BTN_SM_FONT_SIZE}px;line-height:1;display:flex;align-items:center;justify-content:center;text-align:center;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xzg-a005-set-btn:hover{background:${S.SET_BTN_SM_HOVER}}
`;    document.head.appendChild(style);
}

/* ─── 端口条悬浮 ───
 * 实现已抽离到 js/A000/A000_Port.js（与 A002/A003 共用同一份 xzg-port-* 实现），
 * 此处仅保留调用点，不再维护私有副本。 */

/* ─── 文本框 ↔ 后端 widget 同步 ─── */

function bindTextArea(node, g) {
    const w = getTextWidget(node);
    if (w && typeof w.value === "string") g.text.value = w.value;
    g.text.addEventListener("input", () => {
        const w2 = getTextWidget(node);
        if (w2 && w2.value !== g.text.value) {
            w2.value = g.text.value;
            node.graph?.change?.();
            node.setDirtyCanvas?.(true, true);
        }
    });
}

/** 清空文本框内文字：DOM textarea 与后端 widget 同步清空（与 bindTextArea 的同步方向一致）。 */
function clearTextA005(node) {
    const g = node?._xzgA005;
    if (!g || !g.text) return;
    if (g.text.value === "") return;
    g.text.value = "";
    g.text.dispatchEvent(new Event("input", { bubbles: true }));
    node.graph?.change?.();
    node.setDirtyCanvas?.(true, true);
    alog("已清空文本框");
}

/* ─── 预览绘制 ─── */

/** 单图 contain 适配到画布（居中、取整，避免亚像素模糊）；图片直角不裁切圆角。 */
function drawImageContain(ctx, img, W, H) {
    if (!img || !img.complete || !img.naturalWidth) return;
    const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const dw = Math.round(img.naturalWidth * scale);
    const dh = Math.round(img.naturalHeight * scale);
    const dx = Math.round((W - dw) / 2);
    const dy = Math.round((H - dh) / 2);
    ctx.drawImage(img, dx, dy, dw, dh);
}

/* ── 对比样式工具：从 A002_ImageComparer 复刻（渐隐分割线 + 毛玻璃圆钮） ── */

/** 渐隐分割线：2px 竖线，中间实白、上下两端淡出。 */
function drawFadeLine(ctx, barX, H) {
    if (!ctx) return;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.28, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.72, "rgba(255,255,255,0.95)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 6;
    ctx.fillStyle = grad;
    ctx.fillRect(barX - 1, 0, 2, H);
    ctx.restore();
}

/** 毛玻璃圆钮（半径随对比区高度缩放，HANDLE_R_FACTOR=0.02）：
 *  局部 blur + 半透明白底 + 上端高光 + 白描边 + 左右 chevron。 */
function drawGlassHandle(ctx, srcCanvas, W, H, cx, cy, dpr) {
    if (!ctx || !srcCanvas) return;
    const R = Math.max(10, H * 0.02);
    const margin = 10;
    const half = R + margin;
    const scLeft = Math.max(0, cx - half);
    const scTop = Math.max(0, cy - half);
    const scW = Math.min(W, cx + half) - scLeft;
    const scH = Math.min(H, cy + half) - scTop;
    if (scW <= 0 || scH <= 0) return;

    const pb = Math.max(1, Math.ceil(scW * dpr));
    const ph = Math.max(1, Math.ceil(scH * dpr));
    const off = document.createElement("canvas");
    off.width = pb;
    off.height = ph;
    const octx = off.getContext("2d");
    octx.drawImage(srcCanvas, scLeft * dpr, scTop * dpr, pb, ph, 0, 0, pb, ph);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    ctx.filter = "blur(9px) saturate(1.5)";
    ctx.drawImage(off, scLeft, scTop, scW, scH);
    ctx.filter = "none";
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(scLeft, scTop, scW, scH);
    const hg = ctx.createRadialGradient(cx, cy - R * 0.45, R * 0.1, cx, cy, R);
    hg.addColorStop(0, "rgba(255,255,255,0.32)");
    hg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R - 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.lineWidth = Math.max(1, R * 0.14);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = Math.max(1, R * 0.18);
    const cH = R * 0.3;
    const cIn = R * 0.15;
    const cOut = R * 0.45;
    ctx.beginPath();
    ctx.moveTo(cx - cIn, cy - cH);
    ctx.lineTo(cx - cOut, cy);
    ctx.lineTo(cx - cIn, cy + cH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + cIn, cy - cH);
    ctx.lineTo(cx + cOut, cy);
    ctx.lineTo(cx + cIn, cy + cH);
    ctx.stroke();
    ctx.restore();
}

/** 双图对比：主图全幅垫底，对比图仅在滑块分界线右侧裁剪覆盖，分界线画一条白线。 */
function drawCompare(ctx, base, cmp, W, H, sliderX) {
    const fit = (img) => {
        if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return null;
        const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight);
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h, img };
    };
    const baseFit = fit(base);
    const cmpFit = fit(cmp);
    if (!baseFit && !cmpFit) return;
    const sX = Number.isFinite(sliderX) ? Math.min(Math.max(sliderX, 0), W) : W / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    if (baseFit) ctx.drawImage(baseFit.img, baseFit.x, baseFit.y, baseFit.w, baseFit.h);

    if (cmpFit && sX < cmpFit.x + cmpFit.w) {
        const winLeft = Math.max(0, cmpFit.x, sX);
        const winRight = Math.min(W, cmpFit.x + cmpFit.w);
        if (winRight > winLeft) {
            const srcX = ((winLeft - cmpFit.x) / cmpFit.w) * cmpFit.img.naturalWidth;
            const srcW = ((winRight - winLeft) / cmpFit.w) * cmpFit.img.naturalWidth;
            ctx.drawImage(
                cmpFit.img,
                srcX, 0, srcW, cmpFit.img.naturalHeight,
                winLeft, cmpFit.y, winRight - winLeft, cmpFit.h
            );
        }
    }

    if (sX >= 0 && sX <= W) {
        drawFadeLine(ctx, sX, H);
        drawGlassHandle(ctx, ctx.canvas, W, H, sX, H / 2, window.devicePixelRatio || 1);
    }
    ctx.restore();
}

/** 绘制预览画布：主图（+ 悬停时双图对比），图片内容为直角不裁切圆角。 */
function drawPreview(node, g) {
    const canvas = g.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(rect.width);
    const H = Math.round(rect.height);
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const imgs = node._a005Imgs || [];
    const mainImg = imgs[imgs.length - 1];
    const cmpImg = node._a005CompareImg || null;
    if (mainImg && mainImg.complete && mainImg.naturalWidth) {
        const cmpOk = cmpImg && cmpImg.complete && cmpImg.naturalWidth;
        if (cmpOk && node._a005OverImg) {
            drawCompare(ctx, mainImg, cmpImg, W, H, node._a005SliderX);
        } else {
            drawImageContain(ctx, mainImg, W, H);
        }
    }
}

/* ─── 预览画布交互（对比图悬停滑块） ─── */

/**
 * 图片对比交互（复刻 A002_ImageComparer 的滑动模式）：
 * · 悬停（pointerenter）即在图片区显示分割线/圆钮，但不移动滑块位置；
 * · 按住（pointerdown）在点击处吸附并开始拖拽，拖动时实时更新滑块 x；
 * · 松开（pointerup/cancel）停止跟随拖拽；离开图片区关闭对比（保留滑块 x，下次进入恢复在此处）。
 * · 滑块 x 以画布本地坐标记录，绘制时 clamp 到画布（= 图片区）内；
 * · 状态变化才重绘。
 */
function attachImageCompare(node, g) {
    if (node._a005ImgCompareHooked) return;
    node._a005ImgCompareHooked = true;
    node._a005CompareImg = null;   // 第 2 张对比图（HTMLImageElement 或 null）
    node._a005SliderX = null;      // 滑块 x（canvas 本地坐标）；null = 中点
    node._a005OverImg = false;     // 指针是否在图片区（预览外框）内
    node._a005Dragging = false;    // 是否处于按住拖拽中

    const area = g.preview;
    const canvas = g.canvas;
    canvas.style.cursor = "crosshair";

    const overImageArea = (clientX, clientY) => {
        const rect = area.getBoundingClientRect();
        if (!rect || rect.width < 1 || rect.height < 1) return false;
        return (
            clientX >= rect.left && clientX <= rect.right &&
            clientY >= rect.top && clientY <= rect.bottom
        );
    };

    // clamp 到画布（canvas 铺满图片区）内的本地 x
    const snap = (clientX) => {
        const cRect = canvas.getBoundingClientRect();
        return Math.max(0, Math.min(cRect.width, clientX - cRect.left));
    };

    // 悬停显示：仅切换 over 态（分割线/圆钮可见），不移动滑块
    const setOver = (over) => {
        if (node._a005OverImg !== over) {
            node._a005OverImg = over;
            drawPreview(node, g);
        }
    };

    area.addEventListener("pointerenter", () => setOver(true));
    // 悬停只显示；按住拖拽中才实时跟随指针移动滑块
    area.addEventListener("pointermove", (e) => {
        if (node._a005Dragging) {
            const x = snap(e.clientX);
            if (node._a005SliderX !== x) {
                node._a005SliderX = x;
                drawPreview(node, g);
            }
        } else {
            setOver(true);
        }
    });
    // 按下即在点击处吸附并开始拖拽（复刻 A002）
    area.addEventListener("pointerdown", (e) => {
        node._a005Dragging = true;
        node._a005OverImg = true;
        const x = snap(e.clientX);
        if (node._a005SliderX !== x) {
            node._a005SliderX = x;
            drawPreview(node, g);
        }
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });
    const stopDrag = () => { node._a005Dragging = false; };
    area.addEventListener("pointerup", stopDrag);
    area.addEventListener("pointercancel", stopDrag);
    // 离开图片区 → 关闭对比（保留 sliderX，下次进入恢复在分界处）
    area.addEventListener("pointerleave", () => {
        node._a005Dragging = false;
        setOver(false);
    });
}

/* ─── DOM 挂载 ─── */

function setupCanvasResize(node, g) {
    if (typeof ResizeObserver !== "undefined") {
        // rAF 合并：节点拖动/拉伸时 RO 每帧同步触发，drawPreview 内读 getBoundingClientRect 又写
        // canvas.width/height，若每帧直绘会抖动。同一帧只重绘一次。
        let roRaf = null;
        g._ro = new ResizeObserver(() => {
            if (roRaf) return;
            roRaf = requestAnimationFrame(() => {
                roRaf = null;
                try { drawPreview(node, g); } catch (e) { alog("RO 重绘失败:", e); }
            });
        });
        g._ro.observe(g.preview);
    }
}

function setupDomA005(node) {
    // 幂等：已挂载则跳过
    if (node._xzgA005) return;
    injectCss();

    // Nodes 2.0 新建节点：后端 schema 原生控件由 Vue 在构造函数之后创建。
    // 等「文本」出现再挂载（每 100ms 重试，最多约 1.5s），否则原生控件会重新显示。
    if (!node.widgets || !node.widgets.some((w) => w.name === "文本")) {
        const tries = (node._xzgA005Tries = (node._xzgA005Tries || 0) + 1);
        if (tries <= 15) setTimeout(() => setupDomA005(node), 100);
        return;
    }
    node._xzgA005Tries = 0;

    // 隐藏后端「文本」原生控件（双写 + 幽灵化），UI 由 DOM 内 textarea 接管
    hideNativeWidget(getTextWidget(node));

    const el = document.createElement("div");
    el.className = "xzg-a005-dom";
    const frame = document.createElement("div");
    frame.className = "xzg-a005-frame";
    el.appendChild(frame);

    const preview = document.createElement("div");
    preview.className = "xzg-a005-preview";
    const canvas = document.createElement("canvas");
    canvas.className = "xzg-a005-canvas";
    preview.appendChild(canvas);
    frame.appendChild(preview);

    // textarea 需独立 wrapper：提示词小助手把工具栏挂到 textarea.parentElement 的右下角，
    // 若直接挂 frame 上会跑到「运行」按钮旁边；包一层后挂载点 = 文本框自身区域
    const textWrap = document.createElement("div");
    textWrap.className = "xzg-a005-text-wrap";
    const text = document.createElement("textarea");
    text.className = "xzg-a005-text";
    text.spellcheck = false;
    textWrap.appendChild(text);
    frame.appendChild(textWrap);

    // 底部：设置按键（圆形，直径见 NODE_SIZE.SET_BTN_SIZE）+ 运行按键（flex 拉伸，随节点变宽）
    // 设置框（高见 NODE_SIZE.SETTINGS_BOX_H，默认隐藏）位于运行键下方，展开时节点向下增高 SETTINGS_H
    const bottom = document.createElement("div");
    bottom.className = "xzg-a005-bottom";

    const bottomRow = document.createElement("div");
    bottomRow.className = "xzg-a005-bottom-row";
    const txtBtn = document.createElement("button");
    txtBtn.type = "button";
    txtBtn.className = "xzg-a005-txt";
    txtBtn.title = "A005 隐藏/显示文本框";
    txtBtn.innerHTML = '<i class="mdi mdi-text-box" aria-hidden="true"></i>';
    txtBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    bottomRow.appendChild(txtBtn);
    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "xzg-a005-set";
    setBtn.title = "A005 设置";
    setBtn.innerHTML = '<i class="mdi mdi-cog" aria-hidden="true"></i>';
    setBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    bottomRow.appendChild(setBtn);

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "xzg-a005-run";
    runBtn.textContent = "运行";
    runBtn.title = "只运行本节点空间内的节点（不含下游节点）";
    runBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    bottomRow.appendChild(runBtn);

    bottom.appendChild(bottomRow);

    // 设置框（点 ⚙ 展开，位于运行键下方）
    const settingsBox = document.createElement("div");
    settingsBox.className = "xzg-a005-settings";

    // 设置框第 1 行：清除按键（独占一行，清空文本框内文字）
    const clrRow = document.createElement("div");
    clrRow.className = "xzg-a005-set-row";

    const clrBtn = document.createElement("button");
    clrBtn.type = "button";
    clrBtn.className = "xzg-a005-set-btn";
    clrBtn.innerHTML = `清除---<span style="font-size:${S.SET_BTN_SM_FONT_SIZE_SUB}px">文本框内文字</span>`;
    clrBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    clrRow.appendChild(clrBtn);

    settingsBox.appendChild(clrRow);

    // 设置框第 2 行：记录 / 还原 两个按键
    const setRow = document.createElement("div");
    setRow.className = "xzg-a005-set-row";

    const recBtn = document.createElement("button");
    recBtn.type = "button";
    recBtn.className = "xzg-a005-set-btn";
    recBtn.textContent = "记录";
    recBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    setRow.appendChild(recBtn);

    const rstBtn = document.createElement("button");
    rstBtn.type = "button";
    rstBtn.className = "xzg-a005-set-btn";
    rstBtn.textContent = "还原";
    rstBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    setRow.appendChild(rstBtn);

    settingsBox.appendChild(setRow);
    bottom.appendChild(settingsBox);

    frame.appendChild(bottom);

    const widget = node.addDOMWidget("xzg_a005_ui", "image_node_dom", el, {
        serialize: false,
        hideOnZoom: false,
        // 高度固定值：不依赖 node.size（防自动增高反馈环）
        // 不设 getMaxHeight → 节点本体可自由拉伸；底部不预留手柄区，DOM 填满 100%
        getMinHeight: () => WIDGET_MIN_H,
        // 显式 computeSize：Nodes 1.0（LiteGraph）的 DOM widget 布局依赖 computeSize，
        // 缺失时占高视为 0，后续控件会叠压在本面板上。返回固定高度，不读 node.size（避免反馈环）。
        computeSize: () => [MIN_W, WIDGET_MIN_H],
    });
    // Nodes 2.0 Vue 布局下 widgets_start_y 不生效，保留惯例值即可
    node.widgets_start_y = TITLE_H;

    const g = { el, frame, preview, canvas, text, textWrap, runBtn, txtBtn, setBtn, settingsBox, clrBtn, recBtn, rstBtn, widget,
        settingsOpen: false, textHidden: false, _closedH: null, _autoCloseTimer: null, _autoCloseLeave: null, _autoCloseEnter: null,
        _ro: null, _portMO: null, _portTimer: null, _portNodeMO: null, _portNodeEl: null, _portObservedBody: null };
    node._xzgA005 = g;
    node._a005Redraw = () => drawPreview(node, g);

    // 记录 / 还原 按键（设置框内）
    attachWorkflowButtons(node, g);

    // 清除按键 → 清空文本框内文字（DOM textarea + 后端 widget 同步清空）
    clrBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        clearTextA005(node);
    });

    // 文本按键 → 切换文本框显隐（状态持久化在 node.properties）
    txtBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        setTextHiddenA005(node, !g.textHidden);
    });
    // 恢复上次的文本框显隐状态（默认不隐藏）
    setTextHiddenA005(node, g.textHidden === true, true);

    // 设置按键 ⚙ → 打开/关闭设置框（对齐 A003：_closedH 记录关闭高度，节点仅向下增高，宽度不动）
    setBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSettingsA005(node);
    });

    // 双击进入子图
    node.onDblClick = function (e, pos, canvas) {
        const sg = this.subgraph || ensureSubgraph(this);
        if (sg && canvas && typeof canvas.openSubgraph === "function") {
            canvas.openSubgraph(sg, this);
        } else {
            alog("无法进入子图");
        }
    };

    // 真执行子图钩子（展开内部节点参与 prompt）
    attachExecutionHooks(node);

    // 文本框 ↔ 后端 widget 同步
    bindTextArea(node, g);

    // 运行按钮（局部执行）
    runBtn.onclick = () => queueRunNodeOnly(node);

    // 预览画布
    setupCanvasResize(node, g);
    attachImageCompare(node, g);

    // 恢复上次预览图（主图；对比图只在执行后 refreshPreview 与主图同批加载）
    restoreSavedPreview(node);

    // 端口条悬浮 → 内容外框可置顶
    floatPortRails(node, g, { alive: () => !!node._xzgA005 });

    // 节点过小时撑到最小高度
    if ((node.size?.[1] ?? 0) < MIN_H) {
        try { node.setSize(node.computeSize()); } catch (e) { alog("最小尺寸兜底失败:", e); }
    }
    requestAnimationFrame(() => {
        drawPreview(node, g);
        app.canvas?.setDirty?.(true, true);
    });

    // Nodes 2.0 的 Vue 可能多次重建原生控件：挂载后短暂持续隐藏（约 3 秒后自动停止）
    let guard = 0;
    const guardTimer = setInterval(() => {
        if (!node._xzgA005 || ++guard > 15) { clearInterval(guardTimer); return; }
        // 仅当隐藏状态实际变化时强制重绘
        if (hideNativeWidget(getTextWidget(node))) app.canvas?.setDirty?.(true, true);
    }, 200);
    g._guardTimer = guardTimer;

    alog("setupDomA005 完成 | subgraph:", !!node.subgraph);
}

/* ─── 文本框显示/隐藏（设置框「隐藏文本框」勾选项驱动） ─── */

/**
 * 切换文本框显隐。
 * · silent=true 仅应用状态、不回写 properties 与保存（用于挂载时恢复）
 * · 隐藏时把文本框占位（TEXT_MIN_H + GAP）从节点高度中扣除，避免留空洞；
 *   显示时按需补回，保证节点高度始终贴合内容。
 */
function setTextHiddenA005(node, hidden, silent) {
    const g = node._xzgA005;
    if (!g || !g.textWrap) return;
    hidden = hidden === true;
    const w = node.size?.[0] ?? MIN_W;
    let h = node.size?.[1] ?? 0;
    // 仅在实际切换时调整高度，避免重复切换导致高度累积漂移
    const changed = g.textHidden !== hidden;
    if (changed) {
        const delta = TEXT_MIN_H + GAP;
        h = hidden ? Math.max(h - delta, MIN_H) : h + delta;
    }
    g.textHidden = hidden;
    g.textWrap.classList.toggle("xzg-a005-notext", hidden);
    g.txtBtn?.classList.toggle("xzg-a005-txt-on", hidden);
    if (changed) {
        node.setSize([w, h]);
        // 设置框若处于展开态，_closedH 需同步，否则收起时会跳回旧高度
        if (g._closedH != null) g._closedH = hidden ? Math.max(g._closedH - (TEXT_MIN_H + GAP), MIN_H) : g._closedH + (TEXT_MIN_H + GAP);
    }
    if (!silent) {
        node.properties = node.properties || {};
        node.properties.a005_text_hidden = hidden;
        node.graph?.change?.();
    }
    try { if (typeof node.arrange === "function") node.arrange(); } catch (e) { /* 忽略 */ }
    // 文本框显隐只影响 DOM 显示层：原生「文本」控件仍保持幽灵化（维持 widgetId 绑定链），
    // 「文本」输入端口与子图内文本插槽均不受影响。此处幂等重述，防 arrange 触发 Vue 重建后丢状态。
    hideNativeWidget(getTextWidget(node));
    bindTextWidgetToSlot(node);
    node.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
    alog("文本框:", hidden ? "隐藏" : "显示");
}

/* ─── 设置框开关（节点向下增高 SETTINGS_H，宽度保持不动） ─── */

function toggleSettingsA005(node) {
    const g = node._xzgA005;
    if (!g || !g.settingsBox) return;
    g.settingsOpen = !g.settingsOpen;
    g.settingsBox.classList.toggle("xzg-a005-open", g.settingsOpen);
    updateNodeHeightForSettingsA005(node);
    if (g.settingsOpen) armAutoCloseA005(node);
    else disarmAutoCloseA005(node);
    alog("设置框:", g.settingsOpen ? "开" : "关");
}

/** 鼠标离开节点 DOM（el）后延迟自动收起设置框；短暂离开再回来取消（对齐 A003） */
function armAutoCloseA005(node) {
    const g = node._xzgA005;
    if (!g || !g.el) return;
    disarmAutoCloseA005(node);
    const leave = () => {
        if (g._autoCloseTimer != null) return; // 已在倒计时中
        g._autoCloseTimer = setTimeout(() => {
            g._autoCloseTimer = null;
            if (node._xzgA005?.settingsOpen) toggleSettingsA005(node);
        }, 500);
    };
    const enter = () => {
        if (g._autoCloseTimer != null) {
            clearTimeout(g._autoCloseTimer);
            g._autoCloseTimer = null;
        }
    };
    g.el.addEventListener("mouseleave", leave);
    g.el.addEventListener("mouseenter", enter);
    g._autoCloseLeave = leave;
    g._autoCloseEnter = enter;
}

/** 移除自动关闭监听并清除倒计时 */
function disarmAutoCloseA005(node) {
    const g = node._xzgA005;
    if (!g) return;
    if (g.el && g._autoCloseLeave) {
        g.el.removeEventListener("mouseleave", g._autoCloseLeave);
        g.el.removeEventListener("mouseenter", g._autoCloseEnter);
    }
    if (g._autoCloseTimer != null) {
        clearTimeout(g._autoCloseTimer);
        g._autoCloseTimer = null;
    }
    g._autoCloseLeave = g._autoCloseEnter = null;
}

/** 根据设置框开关状态调整节点高度：打开 → 向下增高 SETTINGS_H；关闭 → 复原（宽度始终不动） */
function updateNodeHeightForSettingsA005(node) {
    const g = node._xzgA005;
    if (!g || !g.settingsBox) return;
    const w = node.size?.[0] ?? MIN_W;
    let h = node.size?.[1] ?? 0;
    if (g.settingsOpen) {
        if (g._closedH == null) g._closedH = h;
        h = Math.max(h, g._closedH + SETTINGS_H);
    } else {
        if (g._closedH != null) { h = g._closedH; g._closedH = null; }
    }
    node.setSize([w, h]);
    try {
        if (typeof node.arrange === "function") node.arrange();
    } catch (e) { /* 忽略 */ }
    app.canvas?.setDirty?.(true, true);
}

/* ─── 扩展注册 ─── */

app.registerExtension({
    name: "ABC.ImageNode",
    // 新建节点：先同步建子图（保证 isSubgraphNode 恒真、执行展开稳定），再挂 DOM
    // （Nodes 2.0 的 nodeCreated 在构造函数内触发，node.type 尚未赋值，须用 comfyClass）
    nodeCreated(node) {
        if (node.constructor?.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
            try {
                ensureSubgraph(node);
            } catch (e) {
                alog("nodeCreated ensureSubgraph 失败:", e);
            }
            setupDomA005(node);
        }
    },
    // 工作流加载/反序列化路径可能不触发 nodeCreated，补挂一次（幂等）
    loadedGraphNode(node) {
        if (node.type === NODE_TYPE) setupDomA005(node);
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // 把「节点源标签 + 节点ID标签」移入节点标题栏（注册类型，幂等）

        /* ══ onNodeCreated：最小尺寸兜底 + 补挂 DOM（子图已在扩展钩子同步建好） ══ */
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            try {
                if (!this.subgraph) ensureSubgraph(this);
                setupDomA005(this);
            } catch (e) { alog("A005 节点初始化失败(子图/DOM):", e); }
            this.setSize(this.computeSize());
            this.setDirtyCanvas(true, true);
            return r;
        };

        /* ══ computeSize：最小尺寸保证 ══ */
        const origCS = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (width) {
            let r = origCS ? origCS.apply(this, arguments) : null;
            if (!r) r = [MIN_W, MIN_H];
            if (r[0] < MIN_W) r[0] = MIN_W;
            if (r[1] < MIN_H) r[1] = MIN_H;
            return r;
        };

        /* ══ configure：工作流恢复后重建子图（含复制粘贴 ID 重映射）+ 恢复状态 ══ */
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);
            try {
                ensureSubgraph(this);
            } catch (e) {
                alog("configure ensureSubgraph 失败:", e);
            }
            if (!this._xzgA005) setupDomA005(this);
            if (this._xzgA005) {
                const g = this._xzgA005;
                const w = getTextWidget(this);
                if (w && typeof w.value === "string") g.text.value = w.value;
                // 恢复「隐藏文本框」勾选状态（properties 随工作流持久化，默认 false）
                setTextHiddenA005(this, this.properties?.a005_text_hidden === true, true);
                restoreSavedPreview(this);
                floatPortRails(this, g, { alive: () => !!this._xzgA005 });
                requestAnimationFrame(() => drawPreview(this, g));
            }
        };

        /* ══ serialize：先写 properties.subgraph_data_json（主通道） ══ */
        const origSerialize = nodeType.prototype.serialize;
        nodeType.prototype.serialize = function () {
            const exported = safeCall(
                () => this.subgraph?.asSerialisable?.(),
                undefined,
                "serialize: subgraph.asSerialisable"
            );
            if (exported) {
                this.properties = this.properties || {};
                this.properties.subgraph_data_json = JSON.stringify(exported);
                const embeddedDefs = safeCall(
                    () => collectEmbeddedSubgraphDefs(this.subgraph),
                    [],
                    "serialize: 收集内嵌子图定义"
                );
                if (embeddedDefs.length) {
                    this.properties.embedded_subgraph_defs_json = JSON.stringify(embeddedDefs);
                }
            }
            return origSerialize ? origSerialize.apply(this, arguments) : undefined;
        };

        /* ══ onConnectionsChange：连线建立/断开后重算端口锚点 ══ */
        // 首次给本节点接线时，端口条刚被悬浮定位、几何已变，
        // 但 drawConnections 可能已用旧几何算过锚点 → 连线起点错位。
        // 这里在连线变化后主动打脏背景层，强制下一帧重算 getConnectionPos。
        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
            const self = this;
            // 双帧兜底：本帧结束后布局已稳定，再打一次脏，确保锚点用最终几何重算
            try { this.setDirtyCanvas?.(true, true); } catch (_) {}
            try { this.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
            requestAnimationFrame(() => {
                try { self.setDirtyCanvas?.(true, true); } catch (_) {}
                try { self.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
            });
        };

        /* ══ onRemoved：清理 ══ */
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (onRemoved) onRemoved.apply(this, arguments);
            a005Nodes.delete(this);
            detachSlotSync(this);   // 解除子图插槽事件监听，防节点删除后残留回调泄漏
            if (this._a005InnerUiImages) this._a005InnerUiImages.clear();
            this._a005InnerUiImages = null;
            disarmAutoCloseA005(this);
            const g = this._xzgA005;
            if (g) {
                if (g._ro) g._ro.disconnect();
                g._ro = null;
                /* ★ 端口效果统一走共享模块的释放出口（2026-10-06）：
                 *  原实现只 clearInterval(g._portTimer)，会绕过 A000_Port 注册表
                 *  _portMOBindings 的摘除路径（该路径只在 tick 内 alive() 为 false
                 *  时触发，而 tick 已被这里停掉）→ 每删一个节点永久残留一条
                 *  id→node 强引用，且 _xzgPortOnMutations 闭包把整棵已卸载 DOM 钉住。
                 *  另：原 if (g._portMO) 分支是**死代码** —— 单例观察器存在模块级
                 *  _portMO，从不挂到 g 上。 */
                releasePortNode(this, g);
                if (g._guardTimer) clearInterval(g._guardTimer);
                g._guardTimer = null;
                if (g._portNodeMO) { try { g._portNodeMO.disconnect(); } catch (_) {} }
                g._portNodeMO = null;
                g._portNodeEl = null;
                g._portObservedBody = null;
                if (g._wfBtnCleanup) { try { g._wfBtnCleanup(); } catch (_e) { /* 忽略 */ } }
                this._xzgA005 = null;
            }
            this._a005Redraw = null;
        };
    },
});
