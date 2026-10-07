import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { floatPortRails } from "./A000/A000_Port.js";
import { injectStyleOnce } from "./A000/A000_DomStyle.js";

// ═══════════════════════════════════════════════════════════════
//  A002 图片裁剪 · Nodes 2.0 DOM Widget 版
//   · addDOMWidget 挂载真实 DOM（按钮面板 + 预览 canvas + 信息行）
//   · getMinHeight 固定值；不设 getMaxHeight → 节点本体可自由拉伸
//   · 隐藏后端 Schema 原生控件（widget.hidden + options.hidden 双写）
// ═══════════════════════════════════════════════════════════════

const EXTENSION_NAME = "ABC.ImageCrop";
const NODE_TYPE = "A002_ImageCrop";

/** 布局常量 */
const DEFAULT_W = 200;   // 新建节点默认宽
const DEFAULT_H = 300;   // 新建节点默认高（含标题栏）
const MIN_W = 200;       // 宽度下限
const MIN_H = 300;       // 高度下限（含标题栏）
const TITLE_H = 30;      // 标题栏高
const PAD = 6;           // 内容区边距
const BTN_PANEL_H = 70;  // 按钮面板（三行）
const INFO_H = 20;       // 信息行高
const FRAME_EXTRA = 14;  // 新外框开销：padding(4×2) + 内部 gap(6)
/* 预览区最小高：由 MIN_H 反推，保证「标题 + 内容区」恰好等于高度下限，
 * 避免默认高度被最小高度撑回更大值。
 * 算式：MIN_H − 标题 − PAD − 按钮面板 − gap − gap − 信息行 − PAD − 外框开销
 * 例：300 − 30 − 6 − 70 − 6 − 6 − 20 − 6 − 14 = 142 */
const CANVAS_MIN_H = MIN_H - TITLE_H - PAD - BTN_PANEL_H - 6 - 6 - INFO_H - PAD - FRAME_EXTRA;
const WIDGET_MIN_H = PAD + BTN_PANEL_H + 6 + CANVAS_MIN_H + 6 + INFO_H + PAD + FRAME_EXTRA;
const MAX_CROP_DIM = 8192; // 扩展区域最大尺寸上限

/** 裁剪尺寸钳制：最小 10，最大 8192（扩展上限） */
function clampDim(v) {
    return Math.min(MAX_CROP_DIM, Math.max(10, Math.round(v)));
}

/** 裁剪边界钳制：minX/minY ≥ -8192，maxX/maxY ≤ 8192（预览画布边界） */
function clampBound(v, size) {
    return Math.max(-MAX_CROP_DIM, Math.min(MAX_CROP_DIM - size, v));
}

/** 预设比例 */
const ASPECT_RATIOS = {
    "free": { label: "自由", ratio: null },
    "1:1": { label: "1:1", ratio: 1 },
    "9:21": { label: "9:21", ratio: 9 / 21 },
    "3:4": { label: "3:4", ratio: 3 / 4 },
    "7:9": { label: "7:9", ratio: 7 / 9 },
    "2:3": { label: "2:3", ratio: 2 / 3 },
    "16:9": { label: "16:9", ratio: 16 / 9 },
    "9:16": { label: "9:16", ratio: 9 / 16 },
    "21:9": { label: "21:9", ratio: 21 / 9 },
    "2:1": { label: "2:1", ratio: 2 },
    "1:2": { label: "1:2", ratio: 0.5 },
    "custom": { label: "自定义", ratio: null },
};

/** 预设尺寸（双击比例按钮弹出） */
const PRESET_SIZES = {
    "16:9": [
        { label: "16:9", width: 960, height: 540 },
        { label: "16:9", width: 1280, height: 720 },
        { label: "16:9", width: 1920, height: 1080 },
        { label: "16:9", width: 2560, height: 1440 },
        { label: "16:9", width: 3840, height: 2160 },
    ],
    "1:1": [
        { label: "1:1", width: 768, height: 768 },
        { label: "1:1", width: 1024, height: 1024 },
        { label: "1:1", width: 1280, height: 1280 },
        { label: "1:1", width: 1536, height: 1536 },
        { label: "1:1", width: 2048, height: 2048 },
    ],
    "7:9": [
        { label: "7:9", width: 896, height: 1152 },
        { label: "7:9", width: 1120, height: 1440 },
        { label: "7:9", width: 1344, height: 1728 },
    ],
    "3:4": [
        { label: "3:4", width: 864, height: 1152 },
        { label: "3:4", width: 1104, height: 1472 },
        { label: "3:4", width: 1296, height: 1728 },
    ],
    "2:3": [
        { label: "2:3", width: 832, height: 1248 },
        { label: "2:3", width: 1024, height: 1536 },
        { label: "2:3", width: 1248, height: 1872 },
    ],
    "9:16": [
        { label: "9:16", width: 720, height: 1280 },
        { label: "9:16", width: 864, height: 1536 },
        { label: "9:16", width: 1152, height: 2048 },
    ],
    "9:21": [
        { label: "9:21", width: 576, height: 1344 },
        { label: "9:21", width: 720, height: 1680 },
        { label: "9:21", width: 864, height: 2016 },
    ],
};

/** 全局图片缓存（切换工作流恢复用；不写入工作流文件）。
 *  存 { dataURL, img }：img 为「已加载完成」的 Image 对象。
 *  切换工作流返回时可直接复用该对象同步挂载，避免「先画占位空态、onload 后再补图」的闪帧。 */
const imageCache = new Map();
const IMAGE_CACHE_MAX = 20;
function cacheImage(id, base64, img) {
    if (imageCache.has(id)) imageCache.delete(id);
    const ready = (img && img.complete && img.naturalWidth > 0) ? img : null;
    imageCache.set(id, { dataURL: base64 || "", img: ready });
    while (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
}
function getCachedImage(id) {
    const value = imageCache.get(id);
    if (value !== undefined) {
        imageCache.delete(id);
        imageCache.set(id, value);
    }
    return value;
}

/* ─── CSS 注入 ─── */

let _cssInjected = false;
function injectCss() {
    injectStyleOnce("xzg-abc-a002-style", `
.xzg-ic-dom{width:100%;height:100%;box-sizing:border-box;margin-top:-4px;margin-bottom:-20px;padding:4px 0 0 0;display:flex;flex-direction:column;gap:0;overflow:hidden;background:transparent}
.xzg-ic-frame{flex:1;min-height:0;width:100%;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;overflow:hidden}
.xzg-ic-btns{border:1px solid #444;border-radius:6px;background:#202020;padding:4px;display:flex;flex-direction:column;gap:3px;flex-shrink:0;box-sizing:border-box}
.xzg-ic-brow{display:flex;align-items:center;gap:3px;width:100%;flex-shrink:0}
.xzg-ic-btn{border:1px solid rgba(255,255,255,.25);border-radius:3px;background:#333;color:#e6e6e6;font-size:8px;line-height:1;height:15px;padding:0 4px;display:flex;align-items:center;justify-content:center;text-align:center;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;flex:1 1 0;min-width:0}
.xzg-ic-btn:hover{filter:brightness(1.25)}
.xzg-ic-btn.xzg-ic-on{background:#4a6da7;color:#fff}
.xzg-ic-cwrap{flex:1;min-height:${CANVAS_MIN_H}px;position:relative;border:1px solid #333;border-radius:6px;background:#1f1f1f;overflow:hidden}
.xzg-ic-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
.xzg-ic-info{height:${INFO_H}px;line-height:${INFO_H}px;flex-shrink:0;font-size:8px;color:#9a9a9a;font-family:"Cascadia Mono",Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
.xzg-ic-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center}
.xzg-ic-modal{background:#262626;border:1px solid #555;border-radius:10px;padding:14px 16px;min-width:260px;box-shadow:0 8px 40px rgba(0,0,0,.5)}
.xzg-ic-mhead{color:#fff;font-size:14px;font-weight:700;margin-bottom:10px;text-align:center}
.xzg-ic-mbody{display:flex;flex-direction:column;gap:8px}
.xzg-ic-mbody input[type=number]{background:#1a1a1a;border:1px solid #444;border-radius:4px;color:#fff;padding:6px 8px;font-size:13px;width:100%;box-sizing:border-box;outline:none}
.xzg-ic-mbody input[type=number]:focus{border-color:#666}
.xzg-ic-mopt{color:#ddd;font-size:13px;padding:8px;cursor:pointer;border-radius:6px;text-align:center}
.xzg-ic-mopt:hover{background:rgba(255,255,255,.1)}
.xzg-ic-mfoot{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
`);
}

/* ─── 工具函数 ─── */

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** 单个原生控件隐藏：widget.hidden + options.hidden 双写（Nodes 2.0 Vue 读 options.hidden）
 *  multiline 拉伸控件额外幽灵化（computeSize 缩 0 高 + 清空 draw）防叠压 */
function hideNativeWidget(w) {
    if (!w) return false;
    let changed = false;
    if (!w.hidden) { w.hidden = true; changed = true; }
    w.options = w.options || {};
    if (!w.options.hidden) { w.options.hidden = true; changed = true; }
    if (w.type === "multiline" || w.inputEl) {
        w.computeSize = () => [0, -4];
        w.draw = () => {};
    }
    return changed;
}

function hideAllNativeWidgets(node) {
    const names = ["image_base64", "crop_x", "crop_y", "crop_width", "crop_height", "aspect_ratio", "fill_color"];
    let changed = false;
    for (const n of names) {
        if (hideNativeWidget(node.widgets?.find((w) => w.name === n))) changed = true;
    }
    return changed;
}

/** 初始化/迁移节点属性；从原生控件回读（工作流恢复场景） */
function initProperties(node, saved) {
    if (!node.properties) node.properties = {};
    const p = node.properties;
    const s = (saved && typeof saved === "object") ? saved : null;
    if (s) {
        for (const k of ["sourceWidth", "sourceHeight", "cropX", "cropY", "cropWidth", "cropHeight",
            "aspectRatio", "customRatioWidth", "customRatioHeight", "fillColor",
            "gridMode", "gridStep", "imageBase64Data", "imageRef"]) {
            if (s[k] !== undefined) p[k] = s[k];
        }
    }
    const D = {
        sourceWidth: 2048, sourceHeight: 2048,
        cropX: 0, cropY: 0, cropWidth: 1024, cropHeight: 1024,
        aspectRatio: "free", customRatioWidth: 1, customRatioHeight: 1,
        fillColor: "#000000", gridMode: true, gridStep: 64,
        imageBase64Data: "",
    };
    for (const [k, v] of Object.entries(D)) {
        if (p[k] === undefined) p[k] = v;
    }
    if (s) {
        // 恢复场景：把存档值同步回原生控件，保证后端执行取值一致
        for (const [name, key] of [["crop_x", "cropX"], ["crop_y", "cropY"],
            ["crop_width", "cropWidth"], ["crop_height", "cropHeight"],
            ["aspect_ratio", "aspectRatio"], ["fill_color", "fillColor"]]) {
            const w = node.widgets?.find((x) => x.name === name);
            if (w && p[key] !== undefined) w.value = p[key];
        }
    } else {
        const rd = (name, key, def) => {
            const w = node.widgets?.find((x) => x.name === name);
            if (w && w.value !== undefined && String(w.value) !== "" && String(w.value) !== String(def)) {
                p[key] = w.value;
            }
        };
        rd("crop_x", "cropX", 0);
        rd("crop_y", "cropY", 0);
        rd("crop_width", "cropWidth", 1024);
        rd("crop_height", "cropHeight", 1024);
        rd("aspect_ratio", "aspectRatio", "free");
        rd("fill_color", "fillColor", "#000000");
        // 新建节点：裁剪框默认居中于源图
        centerCropBox(node);
    }
}

/** 写回原生控件 → 触发后端执行 */
function syncToWidgets(node, deferChange = false) {
    const p = node.properties;
    const set = (name, val) => {
        const w = node.widgets?.find((x) => x.name === name);
        if (w) w.value = val;
    };
    set("crop_x", p.cropX);
    set("crop_y", p.cropY);
    set("crop_width", p.cropWidth);
    set("crop_height", p.cropHeight);
    set("aspect_ratio", p.aspectRatio);
    set("fill_color", p.fillColor);
    if (p.imageBase64Data) {
        // 拖拽热路径短路：base64 内容不变时跳过赋值，避免每帧写入 MB 级字符串
        const w = node.widgets?.find((x) => x.name === "image_base64");
        if (w && w.value !== p.imageBase64Data) w.value = p.imageBase64Data;
    }
    node.setDirtyCanvas?.(true, true);
    // 拖拽中 deferChange：把 graph.change() 推迟到 pointerup，避免每帧触发全图序列化
    if (!deferChange && node.graph && typeof node.graph.change === "function") node.graph.change();
}

/* ─── 预览绘制 ─── */

function getParams(node) {
    const p = node.properties;
    const cw = Math.max(10, p.cropWidth || 2048);
    const ch = Math.max(10, p.cropHeight || 2048);
    const minX = Math.min(0, p.cropX || 0);
    const minY = Math.min(0, p.cropY || 0);
    const maxX = Math.max(p.sourceWidth || 2048, (p.cropX || 0) + cw);
    const maxY = Math.max(p.sourceHeight || 2048, (p.cropY || 0) + ch);
    return { cw, ch, minX, minY, maxX, maxY };
}

/** 计算当前视口（scale/偏移/显示范围）。
 *  独立于画布像素尺寸：即使画布尚未完成布局（宽高 0）也能算出有效视口，
 *  避免 _view 因首次绘制被跳过而长期为 null，导致裁剪框无法拖拽。 */
function computeView(node, W, H) {
    const { minX, minY, maxX, maxY } = getParams(node);
    const dw = Math.max(1, maxX - minX);
    const dh = Math.max(1, maxY - minY);
    const vw = W >= 4 ? W : MIN_W;
    const vh = H >= 4 ? H : CANVAS_MIN_H;
    const scale = Math.min((vw - 6) / dw, (vh - 6) / dh);
    const offX = (vw - dw * scale) / 2;
    const offY = (vh - dh * scale) / 2;
    return { scale, offX, offY, minX, minY };
}

/** 惰性获取视口：仅在需要交互时确保 _view 可用（不再依赖绘制时机）。
 *  用「布局尺寸」计算，与 drawAll 的绘制坐标系保持一致。 */
function ensureView(node, g) {
    const c = g.canvas;
    const v = computeView(node, c ? c.clientWidth : 0, c ? c.clientHeight : 0);
    g._view = v;
    return v;
}

/** 重绘调度：延迟到下一帧（DOM 布局已提交后）再重画预览画布。
 *  作为官方 custom widget 的 draw 回调入口：Nodes 2.0 下节点缩放 / 画布缩放时
 *  ComfyUI 会重绘节点并调用该 draw，由此触发；用 rAF 合并同帧多次调用。 */
function syncCanvasBitmap(node, g) {
    if (!g) return;
    const canvas = g.canvas;
    if (!canvas) return;
    const run = () => {
        if (!node._xzgIc || node._xzgIc !== g) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect || rect.width < 4 || rect.height < 4) {
            /* 布局尚未就绪（首帧极早期）：下一帧再试一次，抢在首次可见渲染前把位图与图片画好。
             * 否则预览框会先以「空白 canvas（浏览器默认 300x150）」显示一帧 → 表现为闪。 */
            if (!g._syncRetry) {
                g._syncRetry = true;
                if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
                else setTimeout(run, 0);
            }
            return;
        }
        g._syncRetry = false;
        const dpr = window.devicePixelRatio || 1;
        const bw = Math.max(1, Math.round(rect.width * dpr));
        const bh = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width === bw && canvas.height === bh) return;
        drawAll(node, g, rect);
    };
    /* ★ 直接同步执行，不再内部再套一层 rAF：
     *  调用方（setupCanvas 首帧 / onResize / 端口观察器）多已在 rAF 内，直接绘制即可
     *  抢在渲染前完成；原实现内部再 rAF 会平白延后一帧，导致首帧预览框仍是空白位图。 */
    run();
}

/** 轻量尺寸巡检：每 3 帧比对一次画布位图与视觉尺寸，不一致才重画。
 *  用于覆盖"画布 zoom"场景——ComfyUI 画布缩放走整体变换，既不触发 ResizeObserver
 *  （布局尺寸未变）也不一定触发节点 widget 重绘，没有事件可监听。
 *  平时开销仅为一次 getBoundingClientRect（布局稳定时浏览器有缓存）+ 整数比较。 */
function startSizeWatch(node, g) {
    if (g._watchRaf) return;
    let frame = 0;
    const tick = () => {
        if (!node._xzgIc || node._xzgIc !== g) { g._watchRaf = null; return; }
        if ((frame++ % 3) === 0 && !document.hidden) {
            const canvas = g.canvas;
            if (canvas) {
                const rect = canvas.getBoundingClientRect();
                if (rect.width >= 4 && rect.height >= 4) {
                    const dpr = window.devicePixelRatio || 1;
                    const bw = Math.max(1, Math.round(rect.width * dpr));
                    const bh = Math.max(1, Math.round(rect.height * dpr));
                    if (canvas.width !== bw || canvas.height !== bh) drawAll(node, g, rect);
                }
            }
        }
        g._watchRaf = requestAnimationFrame(tick);
    };
    g._watchRaf = requestAnimationFrame(tick);
}

function drawAll(node, g, rectOverride = null) {
    const canvas = g.canvas;
    // 尺寸用 getBoundingClientRect 取「视觉尺寸」（已含 ComfyUI 画布 zoom）：
    // 位图按「视觉尺寸 × DPR」设置，节点缩放或画布放大后位图分辨率都足够，画面保持清晰。
    // 交互侧 ensureView / toImg 同样基于 getBoundingClientRect，绘制与命中判定坐标系严格一致。
    // rectOverride：调用方已测过 rect 时直接复用，省一次强制布局（reflow）。
    const rect = rectOverride || canvas.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) {
        g._view = computeView(node, rect ? rect.width : 0, rect ? rect.height : 0);
        return;
    }
    const dpr = window.devicePixelRatio || 1;
    // 绘制坐标系用「布局尺寸」（不含画布 zoom）：内容与句柄都按布局尺寸绘制，
    // 由下方 setTransform 统一放大，因此随画布 zoom 等比缩放、视觉比例恒定
    // （若直接用 rect 尺寸作坐标系，画布缩小时内容被压缩而句柄固定，比例会失衡）。
    const W = Math.max(1, canvas.clientWidth || Math.round(rect.width));
    const H = Math.max(1, canvas.clientHeight || Math.round(rect.height));
    // 位图 = 「视觉尺寸」× DPR（已含画布 zoom），保证缩放后逐像素清晰
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
    }
    const ctx = canvas.getContext("2d");
    // 缩放系数 = 位图 / 布局尺寸 = 画布 zoom × DPR
    ctx.setTransform(bw / W, 0, 0, bh / H, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const p = node.properties;
    const { cw, ch, minX, minY, maxX, maxY } = getParams(node);
    const dw = maxX - minX;
    const dh = maxY - minY;
    g._view = computeView(node, W, H);
    const { scale, offX, offY } = g._view;

    // 扩展区域背景 + 网格（深灰矩形 #363636 + 64px 灰色网格；四周各外扩 1px、无圆角）
    ctx.fillStyle = "rgba(54,54,54,0.8)";
    ctx.fillRect(offX - 1, offY - 1, dw * scale + 2, dh * scale + 2);
    ctx.strokeStyle = "rgba(80,80,80,1)";
    ctx.lineWidth = 0.4;
    // 一次性构建整张网格路径并单次 stroke：相比逐条 beginPath/stroke 大幅降低绘制开销
    ctx.beginPath();
    const gridL = offX;
    const gridR = offX + dw * scale;
    const gridT = offY;
    const gridB = offY + dh * scale;
    /* ★ 网格相位以【图像坐标 0（图像原点）】为基准，每 64 画布单位一条 ——
     *   与裁剪框的网格吸附基准（Math.round(x/step)*step，也以 0 为基准）严格一致，
     *   保证「裁剪框边界」永远落在网格线上。
     *   不要以扩展区左上角 offX 为基准：offX 对应图像坐标 minX，minX 不是 64 倍数时
     *   （如工作流恢复的任意 cropX），网格相位会与裁剪框格点错开。 */
    const imgX0 = offX + (0 - minX) * scale;
    const imgY0 = offY + (0 - minY) * scale;
    /* 起点：从图像原点向左/上回退到第一个 ≤ 网格区左/上边界的 64 格点 */
    const firstNx = Math.floor((gridL - imgX0) / (64 * scale));
    for (let n = firstNx; imgX0 + n * 64 * scale <= gridR; n++) {
        /* ★ 与裁剪框/背景块用同一套纯数学坐标：不做 Math.round/+0.5 像素对齐。
         *   +0.5 是为「1px 整数线宽」做像素中心对齐用的；现在线宽是 0.4 亚像素，
         *   再加 0.5 反而让网格线与裁剪框边界差 0.5px 而错位。 */
        const gx = imgX0 + n * 64 * scale;
        if (gx < gridL - 0.5) continue;
        ctx.moveTo(gx, gridT);
        ctx.lineTo(gx, gridB);
    }
    const firstNy = Math.floor((gridT - imgY0) / (64 * scale));
    for (let n = firstNy; imgY0 + n * 64 * scale <= gridB; n++) {
        const gy = imgY0 + n * 64 * scale;
        if (gy < gridT - 0.5) continue;
        ctx.moveTo(gridL, gy);
        ctx.lineTo(gridR, gy);
    }
    ctx.stroke();

    // 源图（原始版样式：深色底 + 图片）
    const sX = offX + (0 - minX) * scale;
    const sY = offY + (0 - minY) * scale;
    const sW = (p.sourceWidth || 2048) * scale;
    const sH = (p.sourceHeight || 2048) * scale;
    ctx.fillStyle = "rgba(28,28,28,0.9)";
    ctx.fillRect(sX, sY, sW, sH);
    if (p.sourceImageObj && p.sourceImageObj.complete && p.sourceImageObj.naturalWidth > 0) {
        try {
            ctx.drawImage(p.sourceImageObj, sX, sY, sW, sH);
        } catch (e) {
            drawPlaceholder(ctx, sX, sY, sW, sH, scale, sX, sY);
        }
    } else {
        /* 基准传「图像原点」(sX,sY)，与扩展区网格线、裁剪框吸附基准三者一致 */
        drawPlaceholder(ctx, sX, sY, sW, sH, scale, sX, sY);
    }

    // 裁切框
    drawCropBox(ctx, node, g, offX, offY, scale, minX, minY);

    // 无图占位文字（两行，字号随节点/画布宽度缩放，绘制在裁剪框前面，居中）
    if (!(p.sourceImageObj && p.sourceImageObj.complete && p.sourceImageObj.naturalWidth > 0)) {
        const fs = Math.max(14, Math.round(W * 0.06));
        ctx.fillStyle = "rgba(255,255,255,0.1)";
        ctx.font = fs + "px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const cX = sX + sW / 2;
        const cY = sY + sH / 2;
        ctx.fillText("拖入图片", cX, cY - fs * 0.6);
        ctx.fillText("或 点击「加载图片」", cX, cY + fs * 0.6);
    }

    // 信息行（与原始版格式一致：原图 尺寸 | 裁切 尺寸，超出原图时标注已扩展）
    const sw = p.sourceWidth || 2048;
    const sh = p.sourceHeight || 2048;
    const extended = (minX < 0 || minY < 0 || maxX > sw || maxY > sh);
    g.info.textContent = `原图: ${sw}×${sh} | 裁切: ${cw}×${ch}${extended ? " (已扩展)" : ""}`;
}

function drawPlaceholder(ctx, x, y, w, h, scale, baseX, baseY) {
    // 原始版样式：半透明灰底 + 白色网格线
    ctx.fillStyle = "rgba(100,100,100,0.3)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(80,80,80,1)";
    ctx.lineWidth = 0.4;
    const sc = scale || 0.05;
    /* ★ 网格相位以【图像坐标 0（图像原点）】为基准（baseX/baseY 即图像原点的屏幕坐标），
     *   每 64 画布单位一条 —— 与扩展区网格线、以及裁剪框的吸附基准三者完全一致，
     *   保证无图占位网格线与裁剪框边界对得上。 */
    const imgX0 = baseX;
    const imgY0 = baseY;
    const firstNx = Math.floor((x - imgX0) / (64 * sc));
    const firstNy = Math.floor((y - imgY0) / (64 * sc));
    ctx.beginPath();
    for (let n = firstNx; imgX0 + n * 64 * sc <= x + w; n++) {
        /* 与扩展区网格线/裁剪框/背景块统一：纯数学坐标，不做 +0.5 像素对齐 */
        const px = imgX0 + n * 64 * sc;
        if (px < x - 0.5) continue;
        ctx.moveTo(px, y);
        ctx.lineTo(px, y + h);
    }
    for (let n = firstNy; imgY0 + n * 64 * sc <= y + h; n++) {
        const py = imgY0 + n * 64 * sc;
        if (py < y - 0.5) continue;
        ctx.moveTo(x, py);
        ctx.lineTo(x + w, py);
    }
    ctx.stroke();
}

function drawCropBox(ctx, node, g, offsetX, offsetY, scale, displayMinX, displayMinY) {
    const p = node.properties;
    const x1 = offsetX + (p.cropX - displayMinX) * scale;
    const y1 = offsetY + (p.cropY - displayMinY) * scale;
    const x2 = x1 + p.cropWidth * scale;
    const y2 = y1 + p.cropHeight * scale;
    const imgX1 = offsetX + (0 - displayMinX) * scale;
    const imgY1 = offsetY + (0 - displayMinY) * scale;
    const imgX2 = imgX1 + (p.sourceWidth || 2048) * scale;
    const imgY2 = imgY1 + (p.sourceHeight || 2048) * scale;

    // 裁切框外遮罩（压暗原图未选中区域）
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    if (y1 > imgY1) ctx.fillRect(imgX1, imgY1, imgX2 - imgX1, y1 - imgY1);
    if (y2 < imgY2) ctx.fillRect(imgX1, y2, imgX2 - imgX1, imgY2 - y2);
    if (x1 > imgX1) ctx.fillRect(imgX1, Math.max(y1, imgY1), x1 - imgX1, Math.min(y2, imgY2) - Math.max(y1, imgY1));
    if (x2 < imgX2) ctx.fillRect(x2, Math.max(y1, imgY1), imgX2 - x2, Math.min(y2, imgY2) - Math.max(y1, imgY1));

    // 裁切框本体（复刻分辨率大师 frame 样式：蓝紫半透明填充 + 描边）
    ctx.fillStyle = "rgba(150,150,250,0.1)";
    ctx.strokeStyle = "rgba(150,150,250,0.7)";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.rect(x1, y1, x2 - x1, y2 - y1);
    ctx.fill();
    ctx.stroke();

    // 三分构图线
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    const gw = (x2 - x1) / 3;
    const gh = (y2 - y1) / 3;
    for (let i = 1; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(x1 + gw * i, y1); ctx.lineTo(x1 + gw * i, y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y1 + gh * i); ctx.lineTo(x2, y1 + gh * i); ctx.stroke();
    }

    // 8 个句柄：4 角（白）+ 4 边中点（上下粉、左右蓝）
    const hover = g && g.hover;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const handles = [
        { key: "nw", x: x1, y: y1, base: "#FFF", on: "#E8E8FF" },
        { key: "ne", x: x2, y: y1, base: "#FFF", on: "#E8E8FF" },
        { key: "sw", x: x1, y: y2, base: "#FFF", on: "#E8E8FF" },
        { key: "se", x: x2, y: y2, base: "#FFF", on: "#E8E8FF" },
        { key: "n", x: cx, y: y1, base: "#F89", on: "#FAB" },
        { key: "s", x: cx, y: y2, base: "#F89", on: "#FAB" },
        { key: "w", x: x1, y: cy, base: "#89F", on: "#5AF" },
        { key: "e", x: x2, y: cy, base: "#89F", on: "#5AF" },
    ];
    for (const h of handles) {
        const on = hover === h.key;
        ctx.fillStyle = on ? h.on : h.base;
        ctx.strokeStyle = on ? "#FFF" : "#000";
        ctx.lineWidth = 0.4;
        ctx.beginPath();
        ctx.arc(h.x, h.y, on ? 3 : 2, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
    }
}

/* ─── 命中检测与拖拽 ─── */

function toImg(g, px, py) {
    const v = g._view;
    return { x: (px - v.offX) / v.scale + v.minX, y: (py - v.offY) / v.scale + v.minY };
}

/** 把鼠标事件换算到画布「布局坐标系」（绘制坐标系基于布局尺寸，需按画布 zoom 反算）。 */
function eventToLocal(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? (canvas.clientWidth / rect.width) : 1;
    const sy = rect.height > 0 ? (canvas.clientHeight / rect.height) : 1;
    return { px: (e.clientX - rect.left) * sx, py: (e.clientY - rect.top) * sy };
}

function getHandleAtPoint(node, imgX, imgY, scale) {
    const p = node.properties;
    const hs = 10 / scale;
    const x1 = p.cropX, y1 = p.cropY;
    const x2 = x1 + p.cropWidth, y2 = y1 + p.cropHeight;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    // 8 个句柄：4 角 + 4 边中点（命中半径 hs，随缩放换算到图像坐标）
    if (Math.abs(imgX - x1) < hs && Math.abs(imgY - y1) < hs) return "nw";
    if (Math.abs(imgX - x2) < hs && Math.abs(imgY - y1) < hs) return "ne";
    if (Math.abs(imgX - x1) < hs && Math.abs(imgY - y2) < hs) return "sw";
    if (Math.abs(imgX - x2) < hs && Math.abs(imgY - y2) < hs) return "se";
    if (Math.abs(imgX - cx) < hs && Math.abs(imgY - y1) < hs) return "n";
    if (Math.abs(imgX - cx) < hs && Math.abs(imgY - y2) < hs) return "s";
    if (Math.abs(imgX - x1) < hs && Math.abs(imgY - cy) < hs) return "w";
    if (Math.abs(imgX - x2) < hs && Math.abs(imgY - cy) < hs) return "e";
    if (imgX >= x1 && imgX <= x2 && imgY >= y1 && imgY <= y2) return "move";
    return null;
}

function getCursorForHandle(handle) {
    const cursors = {
        "nw": "nwse-resize", "se": "nwse-resize",
        "ne": "nesw-resize", "sw": "nesw-resize",
        "n": "ns-resize", "s": "ns-resize",
        "w": "ew-resize", "e": "ew-resize",
        "move": "move",
    };
    return cursors[handle] || "default";
}

function updateCropByDrag(node, drag, imgX, imgY) {
    const p = node.properties;
    const dx = imgX - drag.startX;
    const dy = imgY - drag.startY;
    const h = drag.handle;
    let nx = drag.sX, ny = drag.sY, nw = drag.sW, nh = drag.sH;

    let ratio = ASPECT_RATIOS[p.aspectRatio]?.ratio;
    if (p.aspectRatio === "custom" && p.customRatioWidth && p.customRatioHeight) {
        ratio = p.customRatioWidth / p.customRatioHeight;
    }

    // 8 方向：4 角同时改宽高，4 边中点只改单一维度，框内平移
    if (h === "move") { nx = drag.sX + dx; ny = drag.sY + dy; }
    else if (h === "nw") { nx = drag.sX + dx; ny = drag.sY + dy; nw = drag.sW - dx; nh = drag.sH - dy; }
    else if (h === "ne") { ny = drag.sY + dy; nw = drag.sW + dx; nh = drag.sH - dy; }
    else if (h === "sw") { nx = drag.sX + dx; nw = drag.sW - dx; nh = drag.sH + dy; }
    else if (h === "se") { nw = drag.sW + dx; nh = drag.sH + dy; }
    else if (h === "n") { ny = drag.sY + dy; nh = drag.sH - dy; }
    else if (h === "s") { nh = drag.sH + dy; }
    else if (h === "w") { nx = drag.sX + dx; nw = drag.sW - dx; }
    else if (h === "e") { nw = drag.sW + dx; }

    if (ratio && h !== "move") {
        if (h === "n" || h === "s") {
            // 等比时上下边拖动，水平居中保持
            nw = Math.round(nh * ratio);
            if (h === "n") nx = drag.sX + (drag.sW - nw) / 2;
        } else if (h === "w" || h === "e") {
            nh = Math.round(nw / ratio);
            if (h === "w") ny = drag.sY + (drag.sH - nh) / 2;
        } else {
            nh = Math.round(nw / ratio);
        }
    }
    if (nw < 10) nw = 10;
    if (nh < 10) nh = 10;
    if (nw > MAX_CROP_DIM) nw = MAX_CROP_DIM;
    if (nh > MAX_CROP_DIM) nh = MAX_CROP_DIM;

    if (p.gridMode) {
        const step = p.gridStep;
        nx = Math.round(nx / step) * step;
        ny = Math.round(ny / step) * step;
        nw = Math.round(nw / step) * step;
        nh = Math.round(nh / step) * step;
        if (nw > MAX_CROP_DIM) nw = MAX_CROP_DIM;
        if (nh > MAX_CROP_DIM) nh = MAX_CROP_DIM;
    }
    nx = clampBound(nx, nw);
    ny = clampBound(ny, nh);
    p.cropX = Math.round(nx);
    p.cropY = Math.round(ny);
    p.cropWidth = Math.round(nw);
    p.cropHeight = Math.round(nh);
}

/* ─── 画布交互 ─── */

function setupCanvas(node, g) {
    const canvas = g.canvas;
    canvas.addEventListener("pointerdown", (e) => {
        const { px, py } = eventToLocal(canvas, e);
        // 惰性补齐视口：首次按下时若尚未绘制过，现场计算，避免裁剪框无响应
        const v = ensureView(node, g);
        const img = toImg(g, px, py);
        const handle = getHandleAtPoint(node, img.x, img.y, v.scale);
        if (handle) {
            g.drag = {
                handle,
                startX: img.x, startY: img.y,
                sX: node.properties.cropX, sY: node.properties.cropY,
                sW: node.properties.cropWidth, sH: node.properties.cropHeight,
            };
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
            e.preventDefault();
            e.stopPropagation();
        } else {
            g.drag = null;
        }
    });

    canvas.addEventListener("pointermove", (e) => {
        const { px, py } = eventToLocal(canvas, e);
        const v = ensureView(node, g);
        const img = toImg(g, px, py);
        if (g.drag) {
            updateCropByDrag(node, g.drag, img.x, img.y);
            syncToWidgets(node, true); // 拖拽中延迟 graph.change，pointerup 时统一触发
            drawAll(node, g);
            e.preventDefault();
        } else {
            const handle = getHandleAtPoint(node, img.x, img.y, v.scale);
            canvas.style.cursor = handle ? getCursorForHandle(handle) : "default";
            // hover 手感：悬停句柄时高亮（move / 无命中不高亮），仅在状态变化时重绘
            const hover = (handle && handle !== "move") ? handle : null;
            if (g.hover !== hover) {
                g.hover = hover;
                drawAll(node, g);
            }
        }
    });

    const endDrag = () => {
        if (g.drag) {
            g.drag = null;
            canvas.style.cursor = "default";
            syncToWidgets(node);
            drawAll(node, g);
        }
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    // 移出画布：清除 hover 高亮
    canvas.addEventListener("pointerleave", () => {
        if (!g.drag && g.hover) {
            g.hover = null;
            drawAll(node, g);
        }
    });

    // 兜底：ResizeObserver 观察画布容器 cwrap 与根 DOM el。
    // 官方 custom widget 的 draw 在节点缩放时可能只被调用到"中间态"，之后布局才稳定却不再触发；
    // cwrap/el 是普通流式元素，尺寸变化必定触发 RO，借此补一次同步（脏检查保证尺寸未变时不重画）。
    if (typeof ResizeObserver !== "undefined") {
        let roPending = false;
        g.ro = new ResizeObserver(() => {
            if (roPending) return;
            roPending = true;
            requestAnimationFrame(() => { roPending = false; syncCanvasBitmap(node, g); });
        });
        g.ro.observe(g.cwrap);
        g.ro.observe(g.el);
    }
    // 首帧绘制
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => syncCanvasBitmap(node, g));
    }
    // 启动轻量尺寸巡检（覆盖画布 zoom 等无事件可监听的场景）
    startSizeWatch(node, g);
}

/* ─── 图片加载 ─── */

/** 图片就绪后提交到节点：写入尺寸/base64、可选居中、同步 widget 并重绘。
 *  抽出此函数以便「复用缓存中已加载的 Image」时同步调用（不重新解码，避免闪帧）。 */
function commitImage(node, g, img, dataURL, keepCrop = false) {
    const p = node.properties;
    p.sourceWidth = img.naturalWidth || img.width;
    p.sourceHeight = img.naturalHeight || img.height;
    p.sourceImageObj = img;
    if (dataURL) p.imageBase64Data = dataURL;
    if (!keepCrop) {
        p.cropWidth = clampDim(p.sourceWidth);
        p.cropHeight = clampDim(p.sourceHeight);
        // 新加载图片：裁剪框默认居中于图片
        centerCropBox(node);
        p.aspectRatio = "custom";
        p.customRatioWidth = p.sourceWidth;
        p.customRatioHeight = p.sourceHeight;
        // 上传到 ComfyUI input 目录并记录引用，供工作流持久化
        // （工作流只存 {filename, subfolder, type} 引用，不内嵌 base64，避免文件膨胀）
        uploadImageRef(dataURL).then((ref) => {
            if (!ref) return;
            if (!node._xzgIc || node._xzgIc !== g) return;
            p.imageRef = ref;
            if (node.graph && typeof node.graph.change === "function") node.graph.change();
        });
    }
    p.cropWidth = clampDim(p.cropWidth ?? p.sourceWidth);
    p.cropHeight = clampDim(p.cropHeight ?? p.sourceHeight);
    p.cropX = clampBound(p.cropX ?? 0, p.cropWidth);
    p.cropY = clampBound(p.cropY ?? 0, p.cropHeight);
    syncToWidgets(node);
    updateRatioHighlight(node, g);
    drawAll(node, g);
    // 缓存 base64 + 已加载 Image 对象，供下次切换工作流返回时同步复用
    cacheImage(node.id, p.imageBase64Data, img);
}

/** 加载图片到预览区。
 *  keepCrop=true 时保留现有裁剪状态（工作流恢复路径），
 *  避免异步 onload 把已恢复的 cropX/cropY/aspectRatio 重新居中覆盖掉。 */
function applyImage(node, g, dataURL, keepCrop = false) {
    const img = new Image();
    img.onload = () => {
        if (!node._xzgIc || node._xzgIc !== g) return;
        commitImage(node, g, img, dataURL, keepCrop);
    };
    img.src = dataURL;
}

function loadImageFromFile(node, g) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => applyImage(node, g, ev.target.result);
        reader.readAsDataURL(file);
    };
    input.click();
}

function restoreImage(node, g) {
    const p = node.properties;
    // 反序列化会把 Image 对象序列化成 {}（空对象），这里清理掉这个无效引用，
    // 避免被当成「有图」而跳过占位绘制、或污染后续判断
    if (p.sourceImageObj && !(p.sourceImageObj.complete && p.sourceImageObj.naturalWidth > 0)) {
        p.sourceImageObj = null;
    }
    const cached = imageCache.has(node.id) ? getCachedImage(node.id) : null;

    // 优先复用缓存中「已加载完成的 Image 对象」：同步挂载，首帧即有图，
    // 避免切换工作流返回时先绘制占位空态、待异步 onload 后再补图造成的闪帧。
    if (cached && cached.img && cached.img.complete && cached.img.naturalWidth > 0) {
        commitImage(node, g, cached.img, cached.dataURL, true);
        return;
    }

    let src = null;
    if (cached && cached.dataURL && cached.dataURL.trim()) {
        src = cached.dataURL;
    } else if (p.imageBase64Data && p.imageBase64Data.trim()) {
        src = p.imageBase64Data;
    } else {
        const w = node.widgets?.find((x) => x.name === "image_base64");
        if (w && w.value && String(w.value).trim()) src = String(w.value).trim();
    }

    // 引用模式：widget 里存的是 "ref:" + JSON（对齐官方 LoadImage）
    if (src && src.startsWith("ref:")) {
        try {
            const ref = JSON.parse(src.slice(4));
            if (ref && ref.filename) {
                // 把引用写回 properties，供后续序列化复用
                p.imageRef = { filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" };
                loadImageFromRef(node, g, p.imageRef);
                return;
            }
        } catch (e) {
            // JSON 解析失败：兜底当作 base64 处理（极端情况）
        }
    }

    if (src) {
        // 恢复路径：保留已存档的裁剪位置与比例
        applyImage(node, g, src, true);
    } else if (p.imageRef && p.imageRef.filename) {
        // 工作流只存了引用：按 /view 从 input 目录重新拉取图片（官方 LoadImage 同款持久化）
        loadImageFromRef(node, g, p.imageRef);
    } else {
        drawAll(node, g);
    }
}

/** 把 dataURL 上传到 ComfyUI input 目录（官方 /upload/image），返回 {filename, subfolder, type}。
 *  用于让「手动加载的图片」随工作流持久化：工作流只存引用，图片文件留在 input 目录。 */
async function uploadImageRef(dataURL) {
    try {
        const blob = await (await fetch(dataURL)).blob();
        const name = "ABC_A002_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8)
            + (blob.type === "image/jpeg" ? ".jpg" : ".png");
        const fd = new FormData();
        fd.append("image", blob, name);
        fd.append("type", "input");
        fd.append("subfolder", "ABC_A002");
        fd.append("overwrite", "true");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!resp.ok) return null;
        const j = await resp.json();
        return { filename: j.name, subfolder: j.subfolder || "", type: j.type || "input" };
    } catch (e) {
        return null;
    }
}

/** 按持久化引用从 /view 重新加载图片，加载后写回 base64 供后端执行。 */
function loadImageFromRef(node, g, ref) {
    const q = api.apiURL(`/view?filename=${encodeURIComponent(ref.filename)}`
        + `&subfolder=${encodeURIComponent(ref.subfolder || "")}`
        + `&type=${encodeURIComponent(ref.type || "input")}`);
    fetch(q)
        .then((r) => { if (!r.ok) throw new Error("view " + r.status); return r.blob(); })
        .then((blob) => new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(blob);
        }))
        .then((dataURL) => {
            if (!node._xzgIc || node._xzgIc !== g) return;
            applyImage(node, g, dataURL, true);
        })
        .catch(() => { if (node._xzgIc === g) drawAll(node, g); });
}

function setupDnd(node, g) {
    const el = g.el;
    el.addEventListener("dragover", (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
        }
    });
    el.addEventListener("drop", (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (!file || !file.type.startsWith("image/")) return;
        e.preventDefault();
        e.stopPropagation();
        const reader = new FileReader();
        reader.onload = (ev) => applyImage(node, g, ev.target.result);
        reader.readAsDataURL(file);
    });
}

/* ─── 裁剪操作 ─── */

/** 把裁剪框在源图内居中（超出源图时向两侧等量扩展） */
function centerCropBox(node) {
    const p = node.properties;
    p.cropX = clampBound(Math.round(((p.sourceWidth || 2048) - p.cropWidth) / 2), p.cropWidth);
    p.cropY = clampBound(Math.round(((p.sourceHeight || 2048) - p.cropHeight) / 2), p.cropHeight);
}

function setCropSize(node, w, h, g) {
    const p = node.properties;
    p.cropWidth = clampDim(w);
    p.cropHeight = clampDim(h);
    // 尺寸变化后裁剪框默认居中于源图
    centerCropBox(node);
    syncToWidgets(node);
    drawAll(node, g);
}

function resetCrop(node, g) {
    const p = node.properties;
    p.cropWidth = clampDim(1024);
    p.cropHeight = clampDim(1024);
    p.sourceWidth = 2048;
    p.sourceHeight = 2048;
    // 重置后裁剪框默认居中
    centerCropBox(node);
    p.imageBase64Data = "";
    // 仅解引用，不改动 Image 的 src：该对象可能仍被 imageCache 复用，清空 src 会破坏其他节点/后续恢复
    p.sourceImageObj = null;
    imageCache.delete(node.id);
    p.aspectRatio = "free";
    p.customRatioWidth = 1;
    p.customRatioHeight = 1;
    p.fillColor = "#000000";
    p.gridMode = true;
    p.gridStep = 64;
    syncToWidgets(node);
    updateRatioHighlight(node, g);
    drawAll(node, g);
}

function setAspectRatio(node, key, g) {
    const p = node.properties;
    p.aspectRatio = key;
    const ratio = ASPECT_RATIOS[key]?.ratio;
    if (ratio) {
        const cx = p.cropX + p.cropWidth / 2;
        const cy = p.cropY + p.cropHeight / 2;
        const nh = Math.round(p.cropWidth / ratio);
        p.cropHeight = clampDim(nh);
        p.cropY = clampBound(Math.round(cy - nh / 2), p.cropHeight);
    }
    syncToWidgets(node);
    updateRatioHighlight(node, g);
    drawAll(node, g);
}

function swapWidthHeight(node, g) {
    const p = node.properties;
    const cw = p.cropWidth, ch = p.cropHeight;
    const cx = p.cropX + cw / 2, cy = p.cropY + ch / 2;
    p.cropWidth = clampDim(ch);
    p.cropHeight = clampDim(cw);
    p.cropX = clampBound(Math.round(cx - ch / 2), p.cropWidth);
    p.cropY = clampBound(Math.round(cy - cw / 2), p.cropHeight);
    const newRatio = ch / cw;
    let matched = null;
    for (const [key, value] of Object.entries(ASPECT_RATIOS)) {
        if (key !== "free" && key !== "custom" && value.ratio && Math.abs(value.ratio - newRatio) < 0.001) {
            matched = key;
            break;
        }
    }
    if (matched) {
        p.aspectRatio = matched;
    } else {
        p.aspectRatio = "custom";
        p.customRatioWidth = ch;
        p.customRatioHeight = cw;
    }
    syncToWidgets(node);
    updateRatioHighlight(node, g);
    drawAll(node, g);
}

function toggleGridMode(node, g) {
    const p = node.properties;
    p.gridMode = !p.gridMode;
    if (p.gridMode) {
        const step = p.gridStep;
        p.cropWidth = Math.min(MAX_CROP_DIM, Math.max(10, Math.round(p.cropWidth / step) * step));
        p.cropHeight = Math.min(MAX_CROP_DIM, Math.max(10, Math.round(p.cropHeight / step) * step));
        p.cropX = clampBound(Math.round(p.cropX / step) * step, p.cropWidth);
        p.cropY = clampBound(Math.round(p.cropY / step) * step, p.cropHeight);
    }
    syncToWidgets(node);
    updateRatioHighlight(node, g);
    drawAll(node, g);
}

/** 「颜色」按钮显示当前填充色，并按亮度切换文字颜色保证可读 */
function syncFillColorBtn(node, g) {
    if (!g.colorBtn) return;
    let c = node.properties.fillColor || "#000000";
    // 非标准 #rrggbb（如空/异常格式）时回退黑色，避免 r/g/b 为 NaN 污染文字颜色判定
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) c = "#000000";
    g.colorBtn.style.background = c;
    const r = parseInt(c.slice(1, 3), 16);
    const gg = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * gg + 0.114 * b) / 255;
    g.colorBtn.style.color = lum > 0.55 ? "#000" : "#fff";
}

function pickFillColor(node, g) {
    const input = document.createElement("input");
    input.type = "color";
    input.value = node.properties.fillColor || "#000000";
    input.style.cssText = "position:fixed;opacity:0;pointer-events:none;left:0;top:0;width:0;height:0";
    document.body.appendChild(input);
    const cleanup = () => input.remove();
    input.addEventListener("input", () => {
        node.properties.fillColor = input.value;
        syncFillColorBtn(node, g);
        syncToWidgets(node);
        drawAll(node, g);
    });
    input.addEventListener("change", cleanup);
    input.click();
    setTimeout(() => { if (input.isConnected) input.remove(); }, 60000);
}

/* ─── 弹窗 ─── */

function showModal(title, bodyFn) {
    const overlay = document.createElement("div");
    overlay.className = "xzg-ic-overlay";
    const box = document.createElement("div");
    box.className = "xzg-ic-modal";
    const head = document.createElement("div");
    head.className = "xzg-ic-mhead";
    head.textContent = title;
    const body = document.createElement("div");
    body.className = "xzg-ic-mbody";
    const foot = document.createElement("div");
    foot.className = "xzg-ic-mfoot";
    const ok = document.createElement("button");
    ok.className = "xzg-ic-btn";
    ok.textContent = "确定";
    const cancel = document.createElement("button");
    cancel.className = "xzg-ic-btn";
    cancel.textContent = "取消";
    const close = () => overlay.remove();
    cancel.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    bodyFn(body);
    foot.append(cancel, ok);
    box.append(head, body, foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return { close, ok, body };
}

function showPresetSizes(node, ratioKey, g) {
    const list = PRESET_SIZES[ratioKey] || [
        { label: ASPECT_RATIOS[ratioKey].label, width: 1024, height: 1024 },
        { label: ASPECT_RATIOS[ratioKey].label, width: 1024, height: 1024 },
    ];
    const m = showModal(ASPECT_RATIOS[ratioKey].label, (body) => {
        for (const s of list) {
            const opt = document.createElement("div");
            opt.className = "xzg-ic-mopt";
            opt.textContent = `${s.label} (${s.width}×${s.height})`;
            opt.addEventListener("click", () => {
                setCropSize(node, s.width, s.height, g);
                m.close();
            });
            body.appendChild(opt);
        }
    });
    m.ok.addEventListener("click", () => m.close());
}

function showGridStepDialog(node, g) {
    const p = node.properties;
    let stepInp = null;
    const m = showModal("网格步长", (body) => {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = 8;
        inp.step = 8;
        inp.value = p.gridStep;
        body.appendChild(inp);
        stepInp = inp;
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:6px;";
        [32, 64, 128].forEach((v) => {
            const b = document.createElement("button");
            b.className = "xzg-ic-btn";
            b.textContent = String(v);
            b.addEventListener("click", () => { inp.value = v; });
            row.appendChild(b);
        });
        body.appendChild(row);
    });
    m.inp = stepInp;
    m.ok.addEventListener("click", () => {
        let v = parseInt(m.inp.value, 10);
        if (!Number.isFinite(v) || v < 8) v = 64;
        p.gridStep = v;
        p.cropX = clampBound(Math.round(p.cropX / v) * v, p.cropWidth);
        p.cropY = clampBound(Math.round(p.cropY / v) * v, p.cropHeight);
        p.cropWidth = Math.min(MAX_CROP_DIM, Math.max(10, Math.round(p.cropWidth / v) * v));
        p.cropHeight = Math.min(MAX_CROP_DIM, Math.max(10, Math.round(p.cropHeight / v) * v));
        syncToWidgets(node);
        updateRatioHighlight(node, g);
        drawAll(node, g);
        m.close();
    });
}

function setCustomRatio(node, g) {
    const p = node.properties;
    let ratioW = null, ratioH = null;
    const m = showModal("自定义比例", (body) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;align-items:center;";
        const mkInp = (val) => {
            const i = document.createElement("input");
            i.type = "number";
            i.min = 0.1;
            i.step = 0.1;
            i.value = val;
            return i;
        };
        ratioW = mkInp(p.customRatioWidth || 1);
        ratioH = mkInp(p.customRatioHeight || 1);
        row.append(ratioW, document.createTextNode(":"), ratioH);
        body.appendChild(row);
    });
    m.ratioW = ratioW;
    m.ratioH = ratioH;
    m.ok.addEventListener("click", () => {
        let rw = parseFloat(m.ratioW.value);
        let rh = parseFloat(m.ratioH.value);
        if (!Number.isFinite(rw) || rw <= 0) rw = 1;
        if (!Number.isFinite(rh) || rh <= 0) rh = 1;
        p.customRatioWidth = rw;
        p.customRatioHeight = rh;
        p.aspectRatio = "custom";
        const ratio = rw / rh;
        const cx = p.cropX + p.cropWidth / 2;
        const cy = p.cropY + p.cropHeight / 2;
        const nh = Math.round(p.cropWidth / ratio);
        p.cropHeight = clampDim(nh);
        p.cropY = Math.round(cy - nh / 2);
        syncToWidgets(node);
        updateRatioHighlight(node, g);
        drawAll(node, g);
        m.close();
    });
}

/* ─── 按钮面板 ─── */

function updateRatioHighlight(node, g) {
    const p = node.properties;
    if (g.ratioBtns) {
        for (const [key, btn] of Object.entries(g.ratioBtns)) {
            btn.classList.toggle("xzg-ic-on", key === p.aspectRatio);
        }
    }
    if (g.gridBtn) {
        g.gridBtn.textContent = p.gridStep === 64 ? "网格" : String(p.gridStep);
        g.gridBtn.classList.toggle("xzg-ic-on", p.gridMode);
    }
    if (g.customBtn) {
        g.customBtn.textContent = p.aspectRatio === "custom" ? `${p.customRatioWidth}:${p.customRatioHeight}` : "自定义";
    }
}

function buildButtons(node, g) {
    // 显式 3 行：行内 flex 排布，行间由面板纵向 gap 分隔，与节点宽度无关
    const brow = () => {
        const row = document.createElement("div");
        row.className = "xzg-ic-brow";
        g.btns.appendChild(row);
        return row;
    };
    const mk = (text, opts) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "xzg-ic-btn";
        b.textContent = text;
        if (opts.title) b.title = opts.title;
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        if (opts.onDbl) {
            // 双击防抖：单击延迟执行 onClick，若 250ms 内出现第二次点击则只触发 onDbl
            let clickTimer = null;
            b.addEventListener("click", (e) => {
                e.stopPropagation();
                if (clickTimer) clearTimeout(clickTimer);
                clickTimer = setTimeout(() => {
                    clickTimer = null;
                    if (opts.onClick) opts.onClick();
                }, 250);
            });
            b.addEventListener("dblclick", (e) => {
                e.stopPropagation();
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                opts.onDbl();
            });
        } else {
            b.addEventListener("click", (e) => {
                e.stopPropagation();
                if (opts.onClick) opts.onClick();
            });
        }
        return b;
    };

    // 第一行：功能按钮（与原始版一致：加载图片/重置/颜色/自定义）
    const row1 = brow();
    row1.appendChild(mk("加载图片", { title: "从文件加载图片", onClick: () => loadImageFromFile(node, g) }));
    row1.appendChild(mk("重置", { onClick: () => resetCrop(node, g) }));
    g.colorBtn = mk("颜色", { title: "扩展区域填充色", onClick: () => pickFillColor(node, g) });
    syncFillColorBtn(node, g);
    row1.appendChild(g.colorBtn);
    g.customBtn = mk("自定义", { title: "输入自定义宽高比", onClick: () => setCustomRatio(node, g) });
    row1.appendChild(g.customBtn);

    // 第二行：比例按钮（与原始版一致：16:9/1:1/7:9/3:4/自由）
    g.ratioBtns = {};
    const row2 = brow();
    ["16:9", "1:1", "7:9", "3:4"].forEach((k) => {
        g.ratioBtns[k] = mk(ASPECT_RATIOS[k].label, {
            title: "点击应用比例，双击选预设尺寸",
            onClick: () => setAspectRatio(node, k, g),
            onDbl: () => showPresetSizes(node, k, g),
        });
        row2.appendChild(g.ratioBtns[k]);
    });
    /* 「自由」是纯功能按键：仅单击应用「无比例约束」，不挂双击预设（无固定比例，预设无意义） */
    g.ratioBtns["free"] = mk(ASPECT_RATIOS["free"].label, {
        title: "自由比例",
        onClick: () => setAspectRatio(node, "free", g),
    });
    row2.appendChild(g.ratioBtns["free"]);

    // 第三行：网格 + 更多比例 + 变换（与原始版一致：网格/2:3/9:16/9:21/变换）
    const row3 = brow();
    g.gridBtn = mk("网格", {
        title: "网格吸附（双击设置步长）",
        onClick: () => toggleGridMode(node, g),
        onDbl: () => showGridStepDialog(node, g),
    });
    row3.appendChild(g.gridBtn);
    ["2:3", "9:16", "9:21"].forEach((k) => {
        g.ratioBtns[k] = mk(ASPECT_RATIOS[k].label, {
            title: "点击应用比例，双击选预设尺寸",
            onClick: () => setAspectRatio(node, k, g),
            onDbl: () => showPresetSizes(node, k, g),
        });
        row3.appendChild(g.ratioBtns[k]);
    });
    row3.appendChild(mk("变换", { title: "交换宽高", onClick: () => swapWidthHeight(node, g) }));
    updateRatioHighlight(node, g);
}

/* ─── DOM 挂载 ─── */

function setupDomImageCrop(node) {
    // 幂等：已挂载则跳过
    if (node._xzgIc) return;
    injectCss();
    // 传入序列化存档（工作流恢复时由 configure 标记，新建节点为 null）
    initProperties(node, node._xzgSavedProps || null);

    // Nodes 2.0 新建节点：后端 schema 原生控件由 Vue 在构造函数之后创建。
    // 等「crop_x」出现再挂载（每 100ms 重试，最多约 1.5s），否则原生控件会重新显示。
    if (!node.widgets || !node.widgets.some((w) => w.name === "crop_x")) {
        const tries = (node._xzgIcTries = (node._xzgIcTries || 0) + 1);
        if (tries <= 15) {
            // 句柄存 node，供 onRemoved 提前中断（节点已删除时不再空转重试）
            if (node._xzgRetryTimer) clearTimeout(node._xzgRetryTimer);
            node._xzgRetryTimer = setTimeout(() => setupDomImageCrop(node), 100);
        }
        return;
    }
    node._xzgIcTries = 0;

    hideAllNativeWidgets(node);

    const el = document.createElement("div");
    el.className = "xzg-ic-dom";
    // 统一外框：把按钮面板与预览画布装进同一个框内
    const frame = document.createElement("div");
    frame.className = "xzg-ic-frame";
    el.appendChild(frame);
    const btns = document.createElement("div");
    btns.className = "xzg-ic-btns";
    frame.appendChild(btns);
    const cwrap = document.createElement("div");
    cwrap.className = "xzg-ic-cwrap";
    const canvas = document.createElement("canvas");
    canvas.className = "xzg-ic-canvas";
    cwrap.appendChild(canvas);
    frame.appendChild(cwrap);
    const info = document.createElement("div");
    info.className = "xzg-ic-info";
    el.appendChild(info);

    const widget = node.addDOMWidget("xzg_ic_ui", "image_crop_dom", el, {
        serialize: false,
        hideOnZoom: false,
        // 高度固定值：不依赖 node.size（防自动增高反馈环）
        getMinHeight: () => WIDGET_MIN_H,
    });
    // Nodes 2.0 Vue 布局下 widgets_start_y 不生效，保留惯例值即可
    node.widgets_start_y = TITLE_H;

    const g = { el, btns, cwrap, canvas, info, widget, drag: null, ro: null, ratioBtns: null, gridBtn: null, colorBtn: null, customBtn: null, _view: null, hover: null };
    node._xzgIc = g;

    // Nodes 2.0（Vue）下 addDOMWidget 的 canvas 尺寸变化不会触发官方重绘回调，
    // ResizeObserver 对绝对定位的 canvas 也不可靠，导致缩放节点后位图不重算、画面发虚。
    // 这里（复刻分辨率大师机制）额外注册一个官方 canvas widget 作为"重绘驱动源"：
    //   · 高度占用 0，不影响 DOM 面板布局；
    //   · 其 draw(ctx,node,width,y,height) 由 ComfyUI 在节点每次重绘时调用；
    //   · 官方会在节点尺寸变化后重绘节点 → draw 被触发 → 我们把 DOM 里的预览 canvas
    //     按当前 clientWidth/Height 重设位图并重画，尺寸永远与布局一致。
    if (node.addCustomWidget) {
        const driver = {
            name: "xzg_ic_driver",
            type: "xzg_ic_driver",
            value: null,
            serialize: false,
            options: { serialize: false },
            computeSize() { return [0, 0]; },
            draw() {
                // 每次官方重绘都被调用：校正位图尺寸 + 重画（drawAll 内部按需设位图）
                syncCanvasBitmap(node, g);
            },
        };
        try { node.addCustomWidget(driver); } catch (e) { /* 忽略 */ }
        g.driver = driver;
    }

    buildButtons(node, g);
    setupCanvas(node, g);
    setupDnd(node, g);
    // 恢复图片延后到本帧末（同步栈结束）执行：
    // 反序列化场景下 nodeCreated 早于 configure —— 此刻 node.properties 尚未被基类写入，
    // 立即恢复只会先画出「占位空态」，随后 configure 才恢复出真实图片再画一次，两次绘制跨帧 → 闪。
    // 延后到本帧末，configure（同步）已完成、properties 已恢复，可一次性画出真实图片；
    // 新建节点无 configure，则此处正常绘制「占位空态」。
    setTimeout(() => { if (node._xzgIc === g) restoreImage(node, g); }, 0);
    syncToWidgets(node);
    // 端口条悬浮 → 内容外框可置顶（Vue 渲染端口条稍晚，函数内部有轮询补应用）
    floatPortRails(node, g, { alive: () => !!node._xzgIc });

    // 节点过小时撑到最小尺寸
    if ((node.size?.[0] ?? 0) < MIN_W || (node.size?.[1] ?? 0) < MIN_H) {
        try { node.setSize(node.computeSize()); } catch (e) { /* 忽略 */ }
    }
    requestAnimationFrame(() => {
        syncCanvasBitmap(node, g);
        app.canvas?.setDirty?.(true, true);
    });

    // Nodes 2.0 的 Vue 可能多次重建原生控件：挂载后短暂持续隐藏（约 3 秒后自动停止）。
    // 句柄存到 node 上，供 onRemoved 显式 clearInterval（防删除后残留悬空定时器）。
    // 同时每次兜底同步画布位图：覆盖“节点刚创建/恢复时布局尚未稳定”的首帧尺寸偏差。
    let guard = 0;
    const guardTimer = setInterval(() => {
        if (!node._xzgIc || ++guard > 15) { clearInterval(guardTimer); node._xzgGuardTimer = null; return; }
        // 仅当隐藏状态实际变化时强制重绘（Nodes 2.0 Vue 重建后通常已隐藏）
        if (hideAllNativeWidgets(node)) app.canvas?.setDirty?.(true, true);
        syncCanvasBitmap(node, g);
    }, 200);
    node._xzgGuardTimer = guardTimer;
}

/* ─── 扩展注册 ─── */

app.registerExtension({
    name: EXTENSION_NAME,
    // 新建节点：直接挂 DOM（Nodes 2.0 的 nodeCreated 在构造函数内触发，node.type 尚未赋值，须用 comfyClass）
    nodeCreated(node) {
        if (node.constructor?.comfyClass === NODE_TYPE || node.type === NODE_TYPE) setupDomImageCrop(node);
    },
    // 工作流加载/反序列化路径可能不触发 nodeCreated，补挂一次（幂等）
    loadedGraphNode(node) {
        if (node.type === NODE_TYPE) setupDomImageCrop(node);
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;


        /* ══ onNodeCreated：默认尺寸 + 最小尺寸兜底 + 补挂 DOM ══ */
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            try { setupDomImageCrop(this); } catch (e) { /* 忽略 */ }
            /* 新建节点默认尺寸：onNodeCreated 早于 configure，此刻无法直接区分
             * 「新建」与「工作流恢复」。故先挂一个本帧末的判定：
             *   · 若 configure 被调用过（恢复场景）→ 标记已清除，绝不覆盖工作流保存的尺寸；
             *   · 若到本帧末仍未 configure（新建场景）→ 设为默认尺寸。
             * 这样既给新建节点默认尺寸，又不会破坏恢复时的尺寸、不引入尺寸跳变。 */
            this._xzgPendingDefaultSize = true;
            setTimeout(() => {
                if (!this._xzgPendingDefaultSize) return;
                this._xzgPendingDefaultSize = false;
                if (!this._xzgIc) return;
                try { this.setSize([DEFAULT_W, DEFAULT_H]); } catch (e) { /* 忽略 */ }
                this.setDirtyCanvas?.(true, true);
            }, 0);
            this.setDirtyCanvas(true, true);
            return r;
        };

        /* ══ computeSize：默认尺寸 + 最小尺寸保证 ══ */
        const origCS = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (width) {
            let r = origCS ? origCS.apply(this, arguments) : null;
            /* 默认尺寸：新建节点无历史尺寸时给 DEFAULT_W × DEFAULT_H */
            if (!r) r = [DEFAULT_W, DEFAULT_H];
            if (r[0] < MIN_W) r[0] = MIN_W;
            if (r[1] < MIN_H) r[1] = MIN_H;
            return r;
        };

        /* ══ onResize：节点缩放时立即按最新尺寸重设画布位图 ══
         *  这是比 ResizeObserver 更早、更可靠的时机：ComfyUI 拖动节点尺寸时每帧调用，
         *  在此同步重画可避免"位图停留在旧尺寸被 CSS 拉伸"造成的发糊。 */
        const origOnResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const r = origOnResize ? origOnResize.apply(this, arguments) : undefined;
            const g = this._xzgIc;
            if (g) drawAll(this, g);
            return r;
        };

        /* ══ onWidgetChanged：原生控件被外部修改时同步 UI ══ */
        const origOWC = nodeType.prototype.onWidgetChanged;
        nodeType.prototype.onWidgetChanged = function (name, value, widget) {
            const r = origOWC ? origOWC.apply(this, arguments) : undefined;
            if (this._xzgIc && ["crop_x", "crop_y", "crop_width", "crop_height", "aspect_ratio", "fill_color"].includes(name)) {
                const map = {
                    crop_x: "cropX", crop_y: "cropY",
                    crop_width: "cropWidth", crop_height: "cropHeight",
                    aspect_ratio: "aspectRatio", fill_color: "fillColor",
                };
                this.properties[map[name]] = value;
                drawAll(this, this._xzgIc);
                updateRatioHighlight(this, this._xzgIc);
            }
            return r;
        };

        /* ══ configure：工作流恢复后重建状态 ══ */
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            // 记下反序列化数据：此时 node.properties 尚未被基类写入，
            // 作为“是否为工作流恢复”的唯一可靠依据（新建节点无此数据）。
            this._xzgSavedProps = (info && typeof info === "object" && info.properties && typeof info.properties === "object")
                ? info.properties
                : null;
            // 恢复场景：取消「新建默认尺寸」判定，绝不覆盖工作流保存的尺寸
            this._xzgPendingDefaultSize = false;
            if (onConfigure) onConfigure.apply(this, arguments);
            if (!this._xzgIc) setupDomImageCrop(this);
            if (this._xzgIc) {
                initProperties(this, this._xzgSavedProps);
                this._xzgSavedProps = null;
                restoreImage(this, this._xzgIc);
                updateRatioHighlight(this, this._xzgIc);
                syncFillColorBtn(this, this._xzgIc);
                drawAll(this, this._xzgIc);
                // Vue 重建 body 会把端口条样式覆盖回 static：配置恢复后重新悬浮
                floatPortRails(this, this._xzgIc, { alive: () => !!this._xzgIc });
            }
        };

        /* ══ onSerialize：有持久化引用时把引用编码进 widget（对齐官方 LoadImage） ══
         *  - 已拿到 imageRef → 把 image_base64 widget 替换为 "ref:" + JSON，
         *    工作流只存引用不内嵌 base64，后端 API 执行也能按引用从 input 目录读图。
         *  - 尚无 imageRef（上传未完成/失败）→ 保留 base64 兜底，避免图片丢失。 */
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            if (onSerialize) onSerialize.apply(this, arguments);
            const p = this.properties;
            const b64 = p?.imageBase64Data;
            // 连同已加载的 Image 对象一起缓存：切换工作流返回时可同步复用，避免闪帧
            if (b64 && b64.trim()) cacheImage(this.id, b64, p.sourceImageObj);
            const ref = p && p.imageRef;
            const hasRef = !!(ref && ref.filename);
            if (!hasRef) return;
            const refStr = "ref:" + JSON.stringify({
                filename: ref.filename,
                subfolder: ref.subfolder || "",
                type: ref.type || "input",
            });
            if (o.widgets_values && Array.isArray(o.widgets_values)) {
                const idx = this.widgets?.findIndex((w) => w.name === "image_base64");
                if (idx !== undefined && idx >= 0 && idx < o.widgets_values.length) {
                    o.widgets_values[idx] = refStr;
                }
            }
            // Nodes 2.0 还会输出一份「按名索引」的 widgets_values_named，必须一并替换，
            // 否则 base64 会从这里泄漏进工作流文件（实测可致工作流膨胀到 MB 级）
            if (o.widgets_values_named && typeof o.widgets_values_named === "object") {
                o.widgets_values_named.image_base64 = refStr;
            }
            if (o.properties) {
                o.properties.imageBase64Data = "";
                // 删除 Image 引用：Image 无法序列化（会变成 {}），留着既产生无用数据、又会污染恢复时的「有图」判断
                delete o.properties.sourceImageObj;
            }
        };

        /* ══ onRemoved：清理 ══ */
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (onRemoved) onRemoved.apply(this, arguments);
            const g = this._xzgIc;
            if (g) {
                if (g.ro) g.ro.disconnect();
                g.ro = null;
                if (g._watchRaf) cancelAnimationFrame(g._watchRaf);
                g._watchRaf = null;
                if (g._portMO) g._portMO.disconnect();
                g._portMO = null;
                if (g._portNodeMO) g._portNodeMO.disconnect();
                g._portNodeMO = null;
                if (g._portTimer) clearInterval(g._portTimer);
                g._portTimer = null;
                this._xzgIc = null;
            }
            if (this._xzgRetryTimer) { clearTimeout(this._xzgRetryTimer); this._xzgRetryTimer = null; }
            if (this._xzgGuardTimer) { clearInterval(this._xzgGuardTimer); this._xzgGuardTimer = null; }
            if (this.properties) this.properties.sourceImageObj = null;
            // 不删除 imageCache：切换工作流也会触发 onRemoved，删掉会导致返回时缓存失效、
            // 退回 /view 网络加载而闪帧；改由 LRU 上限（IMAGE_CACHE_MAX）自动淘汰。
        };
    },
});
