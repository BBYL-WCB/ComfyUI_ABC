// ═══════════════════════════════════════════════════════════════
//  A006 视频节点 · Nodes 2.0 DOM Widget 版（入口）
//  · addDOMWidget 挂载真实 DOM（预览画布 + 文本框 + 运行按钮），
//    布局参数（尺寸 / 圆角 / 间距 / 颜色）统一由 A006_shared.js 的 NODE_SIZE 提供，本文件不写裸值
//  · getMinHeight 固定值；不设 getMaxHeight → 节点本体可自由拉伸
//  · 底部不预留手柄区：DOM 高度 100% 填满节点
//  · 隐藏后端「文本」原生控件（widget.hidden + options.hidden 双写 + 幽灵化），
//    由 DOM 内 textarea 接管（值实时同步回后端 widget，保证序列化与插槽绑定）
//  · 保留：双击进入子图 / 对比视频悬停滑块 / 执行展开（子图内部节点参与 prompt）
//  ═══════════════════════════════════════════════════════════════
import { app } from "../../../scripts/app.js";
import {
    alog,
    safeCall,
    getTextWidget,
    hideNativeWidget,
    watchNativePreviewRemoval,
    NODE_TYPE,
    NODE_SIZE,
    a006Nodes,
} from "./A006_shared.js";
import {
    ensureSubgraph,
    restoreSavedPreview,
    collectEmbeddedSubgraphDefs,
    bindTextWidgetToSlot,
    detachSlotSync,
} from "./A006_subgraph.js";
import {
    attachExecutionHooks,
    queueRunNodeOnly,
} from "./A006_exec.js";
import {
    attachWorkflowButtons,
} from "./A006_workflow.js";
import { floatPortRails, releasePortNode } from "../A000/A000_Port.js";
// 节点尺寸常量统一在 A006_shared.js 的 NODE_SIZE 定义，此处只解构使用
const S = NODE_SIZE;
const { MIN_W, TITLE_H, WIDGET_MIN_H, MIN_H, SETTINGS_H, TEXT_MIN_H, GAP } = S;
/* ─── CSS 注入 ─── */
let _cssInjected = false;
function injectCss() {
    if (_cssInjected) return;
    _cssInjected = true;
    const style = document.createElement("style");
    style.textContent = `
.xzg-a006-dom{width:100%;height:100%;box-sizing:border-box;padding:${S.PAD_TOP}px ${S.PAD_SIDE}px;display:flex;flex-direction:column;overflow:hidden;background:transparent}
.xzg-a006-frame{width:100%;height:100%;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:${S.GAP}px;box-sizing:border-box;overflow:hidden;background:${S.CONTAINER_BG};border-radius:${S.CORNER_RADIUS}px;padding:${S.FRAME_PAD}px}
.xzg-a006-preview{flex:5 1 0;min-height:${S.PREVIEW_MIN_H}px;position:relative;border:none;border-radius:${S.CORNER_RADIUS}px;background:${S.SURFACE_BG};overflow:hidden}
.xzg-a006-video{position:absolute;inset:0;width:100%;height:100%;display:none;object-fit:contain;background:transparent;touch-action:none}
.xzg-a006-video.xzg-a006-video-cmp{pointer-events:none;z-index:2}
.xzg-a006-video-cut{position:absolute;top:0;bottom:0;width:2px;pointer-events:none;z-index:3;display:none;transform:translateX(-50%);background:linear-gradient(to bottom,rgba(255,255,255,0),rgba(255,255,255,0.95) 28%,rgba(255,255,255,0.95) 72%,rgba(255,255,255,0))}
/* 毛玻璃圆钮（复刻 A002）：backdrop blur + 半透明白底 + 上端高光 + 白描边 + 左右 chevron */
.xzg-a006-handle{position:absolute;top:50%;width:32px;height:32px;border-radius:50%;pointer-events:none;z-index:4;display:none;transform:translate(-50%,-50%);border:2px solid rgba(255,255,255,0.95);background:radial-gradient(circle at 50% 22%,rgba(255,255,255,0.32),rgba(255,255,255,0) 70%),rgba(255,255,255,0.16);-webkit-backdrop-filter:blur(9px) saturate(1.5);backdrop-filter:blur(9px) saturate(1.5);box-shadow:0 2px 8px rgba(0,0,0,0.35)}
.xzg-a006-handle .ch{position:absolute;top:50%;width:8px;height:8px;transform:translateY(-50%) rotate(45deg)}
.xzg-a006-handle .ch-l{left:6px;border-left:2px solid #fff;border-bottom:2px solid #fff;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.4))}
.xzg-a006-handle .ch-r{right:6px;border-right:2px solid #fff;border-top:2px solid #fff;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.4))}
.xzg-a006-text-wrap{flex:2 1 0;min-height:${S.TEXT_MIN_H}px;position:relative;display:flex;width:100%;box-sizing:border-box}
.xzg-a006-text{flex:1 1 0;width:100%;box-sizing:border-box;background:${S.SURFACE_BG};border:none;border-radius:${S.TEXT_RADIUS}px;color:${S.TEXT_FG};caret-color:${S.TEXT_FG};font-size:${S.TEXT_FONT_SIZE}px;line-height:${S.TEXT_LINE_HEIGHT};padding:${S.TEXT_PAD}px;resize:none;outline:none;font-family:inherit}
.xzg-a006-text::placeholder{color:${S.TEXT_PLACEHOLDER};opacity:1}
.xzg-a006-bottom{display:flex;flex-direction:column;gap:${S.GAP}px;width:100%;flex-shrink:0;box-sizing:border-box}
.xzg-a006-bottom-row{display:flex;flex-direction:row;align-items:center;gap:${S.GAP}px;width:100%;box-sizing:border-box}
.xzg-a006-set{width:${S.SET_BTN_SIZE}px;height:${S.SET_BTN_SIZE}px;flex:0 0 ${S.SET_BTN_SIZE}px;box-sizing:border-box;border:1px solid ${S.SET_BTN_BORDER};border-radius:50%;background:${S.SET_BTN_BG};color:${S.TEXT_FG};cursor:pointer;font-size:${S.SET_BTN_FONT_SIZE}px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0}
.xzg-a006-set:hover{filter:brightness(1.25)}
.xzg-a006-txt{width:${S.SET_BTN_SIZE}px;height:${S.SET_BTN_SIZE}px;flex:0 0 ${S.SET_BTN_SIZE}px;box-sizing:border-box;border:1px solid ${S.SET_BTN_BORDER};border-radius:50%;background:${S.SET_BTN_BG};color:${S.TEXT_FG};cursor:pointer;font-size:${S.SET_BTN_FONT_SIZE}px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0}
.xzg-a006-txt:hover{filter:brightness(1.25)}
.xzg-a006-txt.xzg-a006-txt-on{background:${S.BTN_COLOR};color:#fff}
.xzg-a006-run{height:${S.BTN_H}px;flex:1 1 0;min-width:0;box-sizing:border-box;border:none;border-radius:${S.BTN_RADIUS}px;background:${S.BTN_COLOR};color:${S.BTN_FG};font-size:${S.BTN_FONT_SIZE}px;line-height:1;display:flex;align-items:center;justify-content:center;text-align:center;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xzg-a006-run:hover{background:${S.BTN_HOVER}}
.xzg-a006-settings{display:none;flex-direction:column;height:${S.SETTINGS_BOX_H}px;margin-top:0;flex-shrink:0;width:100%;box-sizing:border-box;border:1px solid ${S.SETTINGS_BOX_BORDER};border-radius:${S.SETTINGS_BOX_RADIUS}px;background:${S.SETTINGS_BOX_BG};padding:${S.SETTINGS_BOX_PAD}px;gap:${S.GAP}px}
.xzg-a006-settings.xzg-a006-open{display:flex}
.xzg-a006-set-row{display:flex;flex-direction:row;gap:${S.GAP}px;width:100%;box-sizing:border-box}
/* 设置框内开关行：左滑块开关 + 右文字 */
.xzg-a006-chk-row{display:flex;flex-direction:row;align-items:center;gap:${S.GAP}px;width:100%;height:${S.SET_BTN_SM_H}px;box-sizing:border-box;cursor:pointer;user-select:none}
.xzg-a006-chk-box{position:relative;width:${S.TOGGLE_W}px;height:${S.TOGGLE_H}px;flex:0 0 ${S.TOGGLE_W}px;box-sizing:border-box;border:1px solid ${S.TOGGLE_OFF_BORDER};border-radius:${S.TOGGLE_H / 2}px;background:${S.TOGGLE_OFF};transition:background .15s,border-color .15s}
.xzg-a006-chk-box::after{content:"";position:absolute;top:1px;left:1px;width:${S.TOGGLE_KNOB}px;height:${S.TOGGLE_KNOB}px;border-radius:50%;background:${S.TOGGLE_KNOB_COLOR};transition:transform .15s}
.xzg-a006-chk-row.xzg-a006-chk-on .xzg-a006-chk-box{background:${S.TOGGLE_ON};border-color:${S.TOGGLE_ON}}
.xzg-a006-chk-row.xzg-a006-chk-on .xzg-a006-chk-box::after{transform:translateX(${S.TOGGLE_W - S.TOGGLE_KNOB - 4}px)}
.xzg-a006-chk-label{flex:1 1 0;min-width:0;font-size:${S.SET_BTN_SM_FONT_SIZE}px;line-height:1;color:${S.SET_BTN_SM_FG};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 文本框隐藏态：整块不参与 flex 布局（flex-basis 归零 + 不显示 + 不占最小高） */
.xzg-a006-text-wrap.xzg-a006-notext{display:none;flex:0 0 0;min-height:0}
.xzg-a006-set-btn{flex:1 1 0;height:${S.SET_BTN_SM_H}px;min-width:0;box-sizing:border-box;border:1px solid ${S.SET_BTN_SM_BORDER};border-radius:${S.SET_BTN_SM_RADIUS}px;background:${S.SET_BTN_SM_BG};color:${S.SET_BTN_SM_FG};font-size:${S.SET_BTN_SM_FONT_SIZE}px;line-height:1;display:flex;align-items:center;justify-content:center;text-align:center;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xzg-a006-set-btn:hover{background:${S.SET_BTN_SM_HOVER}}
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
function clearTextA006(node) {
    const g = node?._xzgA006;
    if (!g || !g.text) return;
    if (g.text.value === "") return;
    g.text.value = "";
    g.text.dispatchEvent(new Event("input", { bubbles: true }));
    node.graph?.change?.();
    node.setDirtyCanvas?.(true, true);
    alog("已清空文本框");
}
/* ─── 视频预览刷新（直接用 <video> 元素，替代原 canvas 位图绘制） ─── */
/** 刷新视频预览：主视频全幅铺满（contain），悬停预览区时右侧叠加对比视频（clip-path 滑块裁剪）。 */
function updateVideoPreview(node, g) {
    const vids = node._a006Vids || [];
    const mainSrc = vids.length ? vids[vids.length - 1] : null;
    const cmpUrl = node._a006CompareUrl || null;
    // 主视频
    if (mainSrc) {
        if (g.vidMain._cur !== mainSrc) {
            g.vidMain.src = mainSrc; g.vidMain._cur = mainSrc;
            g.vidMain.load();   // 预加载视频首帧，但默认不自动播放（保持暂停）
        }
        g.vidMain.style.display = "block";
        // 同一源保持当前播放/暂停状态（默认不自动播放，点击后播放）
    } else {
        g.vidMain.style.display = "none";
        if (g.vidMain._cur) { g.vidMain.removeAttribute("src"); g.vidMain._cur = null; }
    }
    // 对比视频：仅当有对比源 && 指针悬停在预览区 && 有主视频时才叠加右侧
    const showCompare = !!cmpUrl && !!mainSrc && node._a006OverPreview;
    if (showCompare) {
        if (g.vidCmp._cur !== cmpUrl) {
            g.vidCmp.src = cmpUrl; g.vidCmp._cur = cmpUrl;
            g.vidCmp.load();   // 加载对比视频，确保即使暂停也能渲染出当前帧
        }
        g.vidCmp.style.display = "block";
        const rect = g.preview.getBoundingClientRect();
        const W = rect.width || 1;
        const H = rect.height || 1;
        const oex = (typeof node._a006SliderX === "number") ? node._a006SliderX : W / 2;
        // 基于主视频内容矩形对齐（object-fit:contain 消除黑边偏移），让浮条贴住画面分界
        let cutX = Math.min(Math.max(oex, 0), W);
        const vw = g.vidMain.videoWidth || 0;
        const vh = g.vidMain.videoHeight || 0;
        if (vw > 0 && vh > 0 && isFinite(vw) && isFinite(vh)) {
            const scale = Math.min(W / vw, H / vh);
            const cw = vw * scale, ch = vh * scale;
            const cx = (W - cw) / 2;
            cutX = Math.min(Math.max(oex, cx), cx + cw);
        }
        const leftPct = Math.max(0, Math.min(100, (cutX / W) * 100));
        g.vidCmp.style.clipPath = `inset(0 0 0 ${leftPct}%)`;
        // 分隔浮条（渐隐）：用百分比定位到裁剪边，随画布缩放自动等比对齐、不漂移
        if (g.cmpGuide) {
            g.cmpGuide.style.display = "block";
            g.cmpGuide.style.left = `${leftPct}%`;
        }
        // 毛玻璃圆钮：贴在分割线中点，随一起移动
        if (g.cmpHandle) {
            g.cmpHandle.style.display = "block";
            g.cmpHandle.style.left = `${leftPct}%`;
        }
        // 主从同步：以主视频(视频01)为轴，对比跟随；短视频到末帧停留
        syncCompare(node, g);
    } else {
        g.vidCmp.style.display = "none";
        g.vidCmp.style.clipPath = "";
        if (g.cmpGuide) g.cmpGuide.style.display = "none";
        if (g.cmpHandle) g.cmpHandle.style.display = "none";
    }
}
/* ─── 视频对比交互（复刻 A002 滑动模式：悬停显示、按住才拖拽、松开停止） ─── */
/**
 * · 悬停（pointerenter）即在预览区显示分割线/圆钮，但不移动滑块位置；
 * · 按住（pointerdown）在点击处吸附并开始拖拽，拖动时实时更新滑块 x；
 * · 松开（pointerup/cancel）停止跟随拖拽；离开预览区关闭对比（保留滑块 x，下次进入恢复在此处）。
 * · 滑块 x 以 preview 本地坐标记录，刷新时 clamp 并换算为百分比；
 * · 主视频播放期间 timeupdate 把当前时间同步给对比视频，保证同帧对比不错位。
 */
/** 对比视频主从同步：以主视频(视频01)为进度轴；短视频播放到末尾帧后停留，等待长视频走完。 */
function syncCompare(node, g) {
    if (!g || !g.vidCmp || !g.vidCmp._cur) return;
    try {
        const t = (g.vidMain._ready && isFinite(g.vidMain.currentTime)) ? g.vidMain.currentTime : 0;
        if (Math.abs(g.vidCmp.currentTime - t) > 0.04) g.vidCmp.currentTime = t;
        const cDur = (g.vidCmp.duration && isFinite(g.vidCmp.duration)) ? g.vidCmp.duration : Infinity;
        const atEnd = isFinite(cDur) && t >= cDur - 0.03;
        if (g.vidMain.paused || atEnd) {
            g.vidCmp.pause();   // 长轴暂停 或 短视频已到末尾 → 停留最后一帧
        } else if (g.vidCmp.paused) {
            g.vidCmp.play().catch(() => {});
        }
    } catch (_e) {}
}

function attachVideoCompare(node, g) {
    if (node._a006VidCompareHooked) return;
    node._a006VidCompareHooked = true;
    node._a006CompareUrl = null;  // 第 2 个对比视频 URL（或 null）
    node._a006SliderX = null;     // 滑块 x（preview 本地 px）；null = 中点
    node._a006OverPreview = false;    // 指针是否在预览区
    node._a006Dragging = false;       // 是否处于按住拖拽中
    const area = g.preview;
    area.style.cursor = "crosshair";
    const overArea = (clientX, clientY) => {
        const rect = area.getBoundingClientRect();
        if (!rect || rect.width < 1 || rect.height < 1) return false;
        return (clientX >= rect.left && clientX <= rect.right &&
                clientY >= rect.top && clientY <= rect.bottom);
    };
    // clamp 到预览区内的本地 x
    const snap = (clientX) => {
        const r = area.getBoundingClientRect();
        return Math.max(0, Math.min(r.width, clientX - r.left));
    };
    // 悬停显示：仅切换 over 态（分割线/圆钮可见），不移动滑块
    const setOver = (over) => {
        if (node._a006OverPreview !== over) {
            node._a006OverPreview = over;
            updateVideoPreview(node, g);
        }
    };
    area.addEventListener("pointerenter", () => setOver(true));
    // 悬停只显示；按住拖拽中才实时跟随指针移动滑块
    area.addEventListener("pointermove", (e) => {
        if (node._a006Dragging) {
            const x = snap(e.clientX);
            if (node._a006SliderX !== x) {
                node._a006SliderX = x;
                updateVideoPreview(node, g);
            }
        } else {
            setOver(true);
        }
    });
    // 按下即在点击处吸附并开始拖拽（复刻 A002）
    area.addEventListener("pointerdown", (e) => {
        node._a006Dragging = true;
        node._a006OverPreview = true;
        const x = snap(e.clientX);
        if (node._a006SliderX !== x) {
            node._a006SliderX = x;
            updateVideoPreview(node, g);
        }
        try { area.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });
    const stopDrag = () => { node._a006Dragging = false; };
    area.addEventListener("pointerup", stopDrag);
    area.addEventListener("pointercancel", stopDrag);
    // 离开预览区 → 关闭对比（保留 sliderX，下次进入恢复在分界处）
    area.addEventListener("pointerleave", () => {
        node._a006Dragging = false;
        setOver(false);
    });
    // 主视频元数据就绪 → 仅标记就绪，不自动播放（等待用户点击后再播放）
    g.vidMain.addEventListener("loadedmetadata", () => {
        g.vidMain._ready = true;
    });
    // 播放期间：把主视频当前时间同步给对比视频，避免对比画面错位
    g.vidMain.addEventListener("timeupdate", () => {
        if (!node._a006OverPreview) return;
        syncCompare(node, g);
    });
}
/* ─── DOM 挂载 ─── */
function setupCanvasResize(node, g) {
    if (typeof ResizeObserver !== "undefined") {
        // rAF 合并：节点拖动/拉伸时 RO 每帧同步触发，updateVideoPreview 内读 getBoundingClientRect 又写
        // canvas.width/height，若每帧直绘会抖动。同一帧只重绘一次。
        let roRaf = null;
        g._ro = new ResizeObserver(() => {
            if (roRaf) return;
            roRaf = requestAnimationFrame(() => {
                roRaf = null;
                try { node._a006Redraw?.(); } catch (e) { alog("RO 重绘失败:", e); }
            });
        });
        g._ro.observe(g.preview);
    }
}
function setupDomA006(node) {
    // 幂等：已挂载则跳过
    if (node._xzgA006) return;
    injectCss();
    // Nodes 2.0 新建节点：后端 schema 原生控件由 Vue 在构造函数之后创建。
    // 等「文本」出现再挂载（每 100ms 重试，最多约 1.5s），否则原生控件会重新显示。
    if (!node.widgets || !node.widgets.some((w) => w.name === "文本")) {
        const tries = (node._xzgA006Tries = (node._xzgA006Tries || 0) + 1);
        if (tries <= 15) setTimeout(() => setupDomA006(node), 100);
        return;
    }
    node._xzgA006Tries = 0;
    // 隐藏后端「文本」原生控件（双写 + 幽灵化），UI 由 DOM 内 textarea 接管
    hideNativeWidget(getTextWidget(node));
    const el = document.createElement("div");
    el.className = "xzg-a006-dom";
    const frame = document.createElement("div");
    frame.className = "xzg-a006-frame";
    el.appendChild(frame);
    const preview = document.createElement("div");
    preview.className = "xzg-a006-preview";
    const vidMain = document.createElement("video");
    vidMain.className = "xzg-a006-video";
    vidMain.muted = false; vidMain.loop = true; vidMain.playsInline = true; vidMain.autoplay = false; vidMain.controls = true;   // 声音永远来自视频01插槽（视频01 暂停时对比也暂停以保留主音频轨）
    preview.appendChild(vidMain);
    const vidCmp = document.createElement("video");
    vidCmp.className = "xzg-a006-video xzg-a006-video-cmp";
    vidCmp.muted = true; vidCmp.loop = false; vidCmp.playsInline = true; vidCmp.autoplay = false;   // 对比视频静音、不循环：短视频播完停留末帧
    preview.appendChild(vidCmp);
    // 对比分隔浮条（渐隐竖线）+ 毛玻璃圆钮：位于滑块 x 处，标出主视频 / 对比视频分界
    const cmpGuide = document.createElement("div");
    cmpGuide.className = "xzg-a006-video-cut";
    preview.appendChild(cmpGuide);
    const cmpHandle = document.createElement("div");
    cmpHandle.className = "xzg-a006-handle";
    cmpHandle.innerHTML = '<span class="ch ch-l"></span><span class="ch ch-r"></span>';
    preview.appendChild(cmpHandle);
    frame.appendChild(preview);
    // textarea 需独立 wrapper：提示词小助手把工具栏挂到 textarea.parentElement 的右下角，
    // 若直接挂 frame 上会跑到「运行」按钮旁边；包一层后挂载点 = 文本框自身区域
    const textWrap = document.createElement("div");
    textWrap.className = "xzg-a006-text-wrap";
    const text = document.createElement("textarea");
    text.className = "xzg-a006-text";
    text.spellcheck = false;
    textWrap.appendChild(text);
    frame.appendChild(textWrap);
    // 底部：设置按键（圆形，直径见 NODE_SIZE.SET_BTN_SIZE）+ 运行按键（flex 拉伸，随节点变宽）
    // 设置框（高见 NODE_SIZE.SETTINGS_BOX_H，默认隐藏）位于运行键下方，展开时节点向下增高 SETTINGS_H
    const bottom = document.createElement("div");
    bottom.className = "xzg-a006-bottom";
    const bottomRow = document.createElement("div");
    bottomRow.className = "xzg-a006-bottom-row";
    const txtBtn = document.createElement("button");
    txtBtn.type = "button";
    txtBtn.className = "xzg-a006-txt";
    txtBtn.title = "隐藏/显示文本框";
    txtBtn.innerHTML = '<i class="mdi mdi-text-box" aria-hidden="true"></i>';
    txtBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    bottomRow.appendChild(txtBtn);
    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "xzg-a006-set";
    setBtn.title = "A006 设置";
    setBtn.innerHTML = '<i class="mdi mdi-cog" aria-hidden="true"></i>';
    setBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    bottomRow.appendChild(setBtn);
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "xzg-a006-run";
    runBtn.textContent = "运行";
    runBtn.title = "只运行本节点空间内的节点（不含下游节点）";
    runBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    bottomRow.appendChild(runBtn);
    bottom.appendChild(bottomRow);
    // 设置框（点 ⚙ 展开，位于运行键下方）
    const settingsBox = document.createElement("div");
    settingsBox.className = "xzg-a006-settings";
    // 设置框第 1 行：清除按键（独占一行，清空文本框内文字）
    const clrRow = document.createElement("div");
    clrRow.className = "xzg-a006-set-row";
    const clrBtn = document.createElement("button");
    clrBtn.type = "button";
    clrBtn.className = "xzg-a006-set-btn";
    clrBtn.innerHTML = `清除---<span style="font-size:${S.SET_BTN_SM_FONT_SIZE_SUB}px">文本框内文字</span>`;
    clrBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    clrRow.appendChild(clrBtn);
    settingsBox.appendChild(clrRow);
    // 设置框第 2 行：记录 / 还原 两个按键
    const setRow = document.createElement("div");
    setRow.className = "xzg-a006-set-row";
    const recBtn = document.createElement("button");
    recBtn.type = "button";
    recBtn.className = "xzg-a006-set-btn";
    recBtn.textContent = "记录";
    recBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    setRow.appendChild(recBtn);
    const rstBtn = document.createElement("button");
    rstBtn.type = "button";
    rstBtn.className = "xzg-a006-set-btn";
    rstBtn.textContent = "还原";
    rstBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    setRow.appendChild(rstBtn);
    settingsBox.appendChild(setRow);
    bottom.appendChild(settingsBox);
    frame.appendChild(bottom);
    const widget = node.addDOMWidget("xzg_a006_ui", "video_node_dom", el, {
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
    const g = { el, frame, preview, vidMain, vidCmp, cmpGuide, cmpHandle, text, textWrap, runBtn, txtBtn, setBtn, settingsBox, clrBtn, recBtn, rstBtn, widget,
        settingsOpen: false, textHidden: false, _closedH: null, _autoCloseTimer: null, _autoCloseLeave: null, _autoCloseEnter: null,
        _ro: null, _portMO: null, _portTimer: null, _portNodeMO: null, _portNodeEl: null, _portObservedBody: null,
        _prevMOs: null, _prevHosts: null };
    node._xzgA006 = g;
    node._a006Redraw = () => updateVideoPreview(node, g);
    // 记录 / 还原 按键（设置框内）
    attachWorkflowButtons(node, g);
    // 清除按键 → 清空文本框内文字（DOM textarea + 后端 widget 同步清空）
    clrBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        clearTextA006(node);
    });
    // 文本按键 → 切换文本框显隐（状态持久化在 node.properties）
    txtBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        setTextHiddenA006(node, !g.textHidden);
    });
    // 恢复上次的文本框显隐状态（默认不隐藏）
    setTextHiddenA006(node, g.textHidden === true, true);

    // 设置按键 ⚙ → 打开/关闭设置框（对齐 A003：_closedH 记录关闭高度，节点仅向下增高，宽度不动）
    setBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSettingsA006(node);
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
    attachVideoCompare(node, g);
    // 移除框架自动挂上的原生视频预览（它自带一个带控件的 DOM 播放器，会与自有播放器互相遮挡）
    watchNativePreviewRemoval(node, g);
    // 恢复上次预览视频（主视频；对比视频只在执行后 refreshPreview 与主视频同批加载）
    restoreSavedPreview(node);
    // 端口条悬浮 → 内容外框可置顶
    floatPortRails(node, g, { alive: () => !!node._xzgA006 });
    // 节点过小时撑到最小高度
    if ((node.size?.[1] ?? 0) < MIN_H) {
        try { node.setSize(node.computeSize()); } catch (e) { alog("最小尺寸兜底失败:", e); }
    }
    requestAnimationFrame(() => {
        node._a006Redraw?.();
        app.canvas?.setDirty?.(true, true);
    });
    // Nodes 2.0 的 Vue 可能多次重建原生控件：挂载后短暂持续隐藏（约 3 秒后自动停止）
    let guard = 0;
    const guardTimer = setInterval(() => {
        if (!node._xzgA006 || ++guard > 15) { clearInterval(guardTimer); return; }
        // 仅当隐藏状态实际变化时强制重绘
        if (hideNativeWidget(getTextWidget(node))) app.canvas?.setDirty?.(true, true);
    }, 200);
    g._guardTimer = guardTimer;   // record guard timer; cleared in onRemoved
    alog("setupDomA006 完成 | subgraph:", !!node.subgraph);
}
/* ─── 文本框显示/隐藏（设置框「隐藏文本框」勾选项驱动） ─── */
/**
 * 切换文本框显隐。
 * · silent=true 仅应用状态、不回写 properties 与保存（用于挂载时恢复）
 * · 隐藏时把文本框占位（TEXT_MIN_H + GAP）从节点高度中扣除，避免留空洞；
 *   显示时按需补回，保证节点高度始终贴合内容。
 */
function setTextHiddenA006(node, hidden, silent) {
    const g = node._xzgA006;
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
    g.textWrap.classList.toggle("xzg-a006-notext", hidden);
    g.txtBtn?.classList.toggle("xzg-a006-txt-on", hidden);
    if (changed) {
        node.setSize([w, h]);
        // 设置框若处于展开态，_closedH 需同步，否则收起时会跳回旧高度
        if (g._closedH != null) g._closedH = hidden ? Math.max(g._closedH - (TEXT_MIN_H + GAP), MIN_H) : g._closedH + (TEXT_MIN_H + GAP);
    }
    if (!silent) {
        node.properties = node.properties || {};
        node.properties.a006_text_hidden = hidden;
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
function toggleSettingsA006(node) {
    const g = node._xzgA006;
    if (!g || !g.settingsBox) return;
    g.settingsOpen = !g.settingsOpen;
    g.settingsBox.classList.toggle("xzg-a006-open", g.settingsOpen);
    updateNodeHeightForSettingsA006(node);
    if (g.settingsOpen) armAutoCloseA006(node);
    else disarmAutoCloseA006(node);
    alog("设置框:", g.settingsOpen ? "开" : "关");
}
/** 鼠标离开节点 DOM（el）后延迟自动收起设置框；短暂离开再回来取消（对齐 A003） */
function armAutoCloseA006(node) {
    const g = node._xzgA006;
    if (!g || !g.el) return;
    disarmAutoCloseA006(node);
    const leave = () => {
        if (g._autoCloseTimer != null) return; // 已在倒计时中
        g._autoCloseTimer = setTimeout(() => {
            g._autoCloseTimer = null;
            if (node._xzgA006?.settingsOpen) toggleSettingsA006(node);
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
function disarmAutoCloseA006(node) {
    const g = node._xzgA006;
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
function updateNodeHeightForSettingsA006(node) {
    const g = node._xzgA006;
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
    name: "ABC.VideoNode",
    // 新建节点：先同步建子图（保证 isSubgraphNode 恒真、执行展开稳定），再挂 DOM
    // （Nodes 2.0 的 nodeCreated 在构造函数内触发，node.type 尚未赋值，须用 comfyClass）
    nodeCreated(node) {
        if (node.constructor?.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
            try {
                ensureSubgraph(node);
            } catch (e) {
                alog("nodeCreated ensureSubgraph 失败:", e);
            }
            setupDomA006(node);
        }
    },
    // 工作流加载/反序列化路径可能不触发 nodeCreated，补挂一次（幂等）
    loadedGraphNode(node) {
        if (node.type === NODE_TYPE) setupDomA006(node);
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
                setupDomA006(this);
            } catch (e) { alog("A006 节点初始化失败(子图/DOM):", e); }
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
            if (!this._xzgA006) setupDomA006(this);
            if (this._xzgA006) {
                const g = this._xzgA006;
                const w = getTextWidget(this);
                if (w && typeof w.value === "string") g.text.value = w.value;
                // 恢复「隐藏文本框」勾选状态（properties 随工作流持久化，默认 false）
                setTextHiddenA006(this, this.properties?.a006_text_hidden === true, true);
                restoreSavedPreview(this);
                floatPortRails(this, g, { alive: () => !!this._xzgA006 });
                requestAnimationFrame(() => this._a006Redraw?.());
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
            a006Nodes.delete(this);
            detachSlotSync(this);   // 解除子图插槽事件监听，防节点删除后残留回调泄漏
            if (this._a006InnerUiVideos) this._a006InnerUiVideos.clear();
            this._a006InnerUiVideos = null;
            disarmAutoCloseA006(this);
            const g = this._xzgA006;
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
                if (g._portNodeMO) { try { g._portNodeMO.disconnect(); } catch (_) {} }
                g._portNodeMO = null;
                g._portNodeEl = null;
                g._portObservedBody = null;
                if (g._guardTimer) clearInterval(g._guardTimer);
                g._guardTimer = null;
                if (g._prevMOs) for (const mo of g._prevMOs) mo.disconnect();
                g._prevMOs = null;
                g._prevHosts = null;
                if (g._wfBtnCleanup) { try { g._wfBtnCleanup(); } catch (_e) { /* 忽略 */ } }
                this._xzgA006 = null;
            }
            this._a006Redraw = null;
        };
    },
});
