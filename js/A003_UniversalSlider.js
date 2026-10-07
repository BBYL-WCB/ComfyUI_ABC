import { app } from "../../scripts/app.js";
import { floatPortRails, releasePortNode } from "./A000/A000_Port.js";
import { injectStyleOnce } from "./A000/A000_DomStyle.js";

// ═══════════════════════════════════════════════
//  A003 万能滑条 · 浮点/整数双模式切换，超宽范围滑条
//  Nodes 2.0 方案：addDOMWidget 挂载真实 DOM 滑条，
//  隐藏后端 Schema 原生控件（数值 / 输出类型），
//  ⚙ 按钮切换滑条下方的内嵌设置框
//  （类型/参数），平时隐藏。
// ═══════════════════════════════════════════════

const EXTENSION_NAME = "ABC.UniversalSlider";
const NODE_TYPE = "UniversalSlider";

/** 最小节点尺寸 */
const MIN_W = 240;
const MIN_H = 35;
/** 标题栏高度：widget 从标题下方开始 */
const TITLE_H = 30;
/** 内容区距节点边框的边距 */
const PAD = 6;
/** 设置框自然高度估算（未测量前的兜底值） */
const SETTINGS_H_EST = 210;

/* ─── 数值工具函数 ─── */

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const snap = (v, mn, step) => (step > 0 ? Math.round((v - mn) / step) * step + mn : v);
const fmt = (v, isInt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return isInt ? "0" : "0.00";
    return isInt ? String(Math.round(n)) : n.toFixed(2);
};
function castVal(v, isInt) {
    if (isInt) return parseInt(Math.round(v), 10);
    return parseFloat(Number(v).toFixed(2));
}
function calcValue(v, mn, mx, step, isInt) {
    v = snap(v, mn, step);
    v = clamp(v, mn, mx);
    return castVal(v, isInt);
}
/* ─── CSS 注入 ─── */

function injectDomCss() {
    injectStyleOnce("xzg-abc-a003-style", `
/* 节点内滑条（纵向：上=滑条行，下=设置框） */
.xzg-us-dom{width:100%;height:100%;box-sizing:border-box;padding:6px;display:flex;flex-direction:column;align-items:stretch;gap:6px;overflow:hidden}
.xzg-us-mainrow{display:flex;flex-direction:row;align-items:center;gap:6px;flex:1;min-height:0;width:100%;box-sizing:border-box;padding-right:10px}
.xzg-us-top{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-shrink:0;min-height:0}
.xzg-us-main-val{color:var(--xzg-val-color,#fff);font-family:"Cascadia Mono",Consolas,monospace;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.8);white-space:nowrap}
.xzg-us-gear{width:20px;height:20px;flex-shrink:0;border:1px solid rgba(255,255,255,.3);border-radius:6px;background:rgba(34,34,34,.92);color:#ddd;cursor:pointer;font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0}
.xzg-us-gear:hover{filter:brightness(1.25)}
.xzg-us-trackwrap{position:relative;flex:1;display:flex;align-items:center;min-height:24px;cursor:pointer}
.xzg-us-main-range{-webkit-appearance:none;appearance:none;width:100%;height:100%;background:transparent;margin:0;cursor:pointer;position:relative;z-index:2}
.xzg-us-main-range::-webkit-slider-runnable-track{height:var(--xzg-track-h,6px);border-radius:calc(var(--xzg-track-h,6px)/2);background:linear-gradient(to right,var(--xzg-track-color,#e8c547) var(--xzg-fill-pct,0%),#1a1a1a var(--xzg-fill-pct,0%));box-shadow:0 1px 2px rgba(0,0,0,.5)}
.xzg-us-main-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:var(--xzg-thumb-size,20px);height:var(--xzg-thumb-size,20px);border-radius:50%;background:var(--xzg-thumb-color,#f5f0e8);border:1px solid rgba(0,0,0,.35);margin-top:calc((var(--xzg-track-h,6px) - var(--xzg-thumb-size,20px))/2);box-shadow:0 2px 4px rgba(0,0,0,.4)}
.xzg-us-main-range::-moz-range-track{height:var(--xzg-track-h,6px);border-radius:calc(var(--xzg-track-h,6px)/2);background:#1a1a1a;box-shadow:0 1px 2px rgba(0,0,0,.5)}
.xzg-us-main-range::-moz-range-progress{height:var(--xzg-track-h,6px);border-radius:calc(var(--xzg-track-h,6px)/2);background:var(--xzg-track-color,#e8c547)}
.xzg-us-main-range::-moz-range-thumb{width:var(--xzg-thumb-size,20px);height:var(--xzg-thumb-size,20px);border-radius:50%;background:var(--xzg-thumb-color,#f5f0e8);border:1px solid rgba(0,0,0,.35);box-shadow:0 2px 4px rgba(0,0,0,.4)}
/* 节点内设置框（滑条下方，默认隐藏） */
.xzg-us-settings{display:none;flex-direction:column;gap:8px;border:1px solid #444;border-radius:6px;background:#222;padding:8px;flex-shrink:0;width:100%;box-sizing:border-box}
.xzg-us-settings.xzg-us-open{display:flex}
.xzg-us-row{display:flex;align-items:center;gap:10px}
.xzg-us-rlbl{width:60px;font-size:12px;color:#aaa;flex-shrink:0}
.xzg-us-inp{flex:1;min-width:0;box-sizing:border-box;background:#1a1a1a;border:1px solid #444;border-radius:4px;padding:6px 8px;color:#fff;font-size:12px;outline:none;font-family:inherit}
.xzg-us-inp::-webkit-outer-spin-button,.xzg-us-inp::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.xzg-us-inp[type=number]{-moz-appearance:textfield}
.xzg-us-inp:focus{border-color:#666}
.xzg-us-radio-wrap{flex:1;display:flex;gap:4px;align-items:center}
.xzg-us-radio-label{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;color:#fff;font-size:12px;padding:6px;border-radius:4px;background:#3a3a3a;border:none;transition:background .15s}
.xzg-us-radio-label:hover{background:#444}
.xzg-us-radio-label input[type="radio"]{display:none}
.xzg-us-radio-label.xzg-us-radio-checked{background:#e8c547;color:#222;font-weight:700}
    `);
}

/* ─── 属性默认值 ─── */

function initProperties(node) {
    if (!node.properties) node.properties = {};
    const p = node.properties;
    // 兼容旧工作流：曾自定义过轨道颜色的节点保留原色
    if (p.sliderColor !== undefined && p.trackColor === undefined) p.trackColor = p.sliderColor;
    // 迁移旧版节点：仅把旧默认(4)对齐到新默认(6)；用户已显式自定义的轨道高度一律保留，不做覆盖
    if (p.trackHeight === 4) p.trackHeight = 6;
    const D = {
        sliderType: "float", sliderMin: 0, sliderMax: 10, sliderStep: 1,
        trackHeight: 6,
        trackColor: "#e8c547",
    };
    for (const [k, v] of Object.entries(D)) {
        if (p[k] === undefined) p[k] = v;
    }
}

/* ─── DOM 滑条 ─── */

/** 单个 widget 隐藏：同时置 widget.hidden 与 widget.options.hidden
 *  （Nodes 2.0 Vue 渲染读 options.hidden，legacy 布局读 widget.hidden，二者都要） */
function hideNativeWidget(w) {
    if (!w) return false;
    let changed = false;
    if (!w.hidden) { w.hidden = true; changed = true; }
    w.options = w.options || {};
    if (!w.options.hidden) { w.options.hidden = true; changed = true; }
    return changed;
}

/** 隐藏后端 Schema 原生控件（数值/输出类型），并返回引用 */
function findAndHideWidgets(node) {
    let changed = false;
    let dw = node.widgets ? node.widgets.find((w) => w.name === "数值") : null;
    if (hideNativeWidget(dw)) changed = true;
    let ot = node.widgets ? node.widgets.find((w) => w.name === "输出类型") : null;
    if (!ot && !node._xzgUsComboAdded) {
        /* ★ 幂等兜底（2026-10-06）：findAndHideWidgets 会被 refreshDomSlider 在
         *  拖动滑条时每帧调用。若某次 find 未命中（原生控件晚于本函数创建、或
         *  Vue 重建控件行的时序窗口），原实现会**每帧** addWidget 一个新 combo →
         *  widget 堆积。加节点级标记，整节点只兜底创建一次。 */
        node._xzgUsComboAdded = true;
        ot = node.addWidget("combo", "输出类型", "float", function () {}, { values: ["float", "int"] });
    }
    if (hideNativeWidget(ot)) changed = true;
    return { dw, ot, changed };
}

/** 用节点状态刷新滑条 UI（min/max/step/值/颜色/数值文本） */
function refreshDomSlider(node) {
    const g = node._xzgUs;
    if (!g) return;
    // Nodes 2.0 的原生控件可能晚于 setupDomSlider 创建：每次刷新重新隐藏并补挂引用
    const { dw: ndw, ot: not } = findAndHideWidgets(node);
    if (!g.dw && ndw) g.dw = ndw;
    if (!g.ot && not) g.ot = not;
    const p = node.properties;
    const isInt = p.sliderType === "int";
    const v = g.dw ? Number(g.dw.value) : 0;

    let mn = Number(p.sliderMin), mx = Number(p.sliderMax);
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) { mn = 0; mx = 100; }
    // 自动扩范围：让滑条始终能表示真实值（解决工作流载入值超出 [min,max] 时的失配）
    if (v < mn) { mn = v; p.sliderMin = mn; }
    if (v > mx) { mx = v; p.sliderMax = mx; }
    if (mn === mx) mx = mn + 1;

    g.range.min = mn;
    g.range.max = mx;
    // 步进：整数模式固定 1；浮点模式用步长（默认 0.01，支持小数点后 2 位）
    g.range.step = isInt ? 1 : (Number(p.sliderStep) > 0 ? Number(p.sliderStep) : 0.01);
    const cv = clamp(v, mn, mx);
    g.range.value = cv;
    const pct = mx !== mn ? ((cv - mn) / (mx - mn)) * 100 : 0;

    g.el.style.setProperty("--xzg-fill-pct", pct + "%");
    g.el.style.setProperty("--xzg-track-h", (p.trackHeight || 6) + "px");
    g.el.style.setProperty("--xzg-track-color", p.trackColor || "#e8c547");
    g.el.style.setProperty("--xzg-thumb-size", (p.thumbSize || 20) + "px");
    g.el.style.setProperty("--xzg-thumb-color", p.thumbColor || "#f5f0e8");
    g.el.style.setProperty("--xzg-val-color", p.valueColor || "#ffffff");
    g.val.textContent = fmt(v, isInt);
    if (g.syncFont) g.syncFont();
}

/** 同步「输出类型」原生控件（决定后端返回 int / float） */
function syncOutputType(node) {
    const g = node._xzgUs;
    if (!g || !g.ot) return;
    g.ot.value = node.properties.sliderType === "int" ? "int" : "float";
}

/** 为节点挂载 DOM 滑条 widget */
function setupDomSlider(node) {
    // 幂等：节点已在（重复创建/工作流加载）时跳过，避免重复挂载 widget
    if (node._xzgUs) return;
    injectDomCss();
    initProperties(node);

    // Nodes 2.0 新建节点：后端 schema 原生控件（数值/输出类型）在构造函数之后才由 Vue 创建。
    // 若在控件存在前就挂载，原生控件会隐藏失败并重新显示，且 addDOMWidget 挂载的 DOM 可能被
    // Vue 随后按 schema 重建 widgets 时清掉 → 只看到原生控件、看不到自定义滑条。
    // 因此先等「数值」控件出现再执行挂载（每 100ms 重试，最多约 1.5s）。
    if (!node.widgets || !node.widgets.some((w) => w.name === "数值")) {
        const tries = (node._xzgUsTries = (node._xzgUsTries || 0) + 1);
        if (tries <= 15) {
            // 覆盖旧定时器：nodeCreated / loadedGraphNode / onNodeCreated 三个入口都会进来，
            // 不清理会让多个重试链叠加（与 A002 setupDomImageCrop 对齐）
            if (node._xzgRetryTimer) clearTimeout(node._xzgRetryTimer);
            node._xzgRetryTimer = setTimeout(() => setupDomSlider(node), 100);
        }
        return;
    }
    node._xzgUsTries = 0;
    node._xzgRetryTimer = null;

    const { dw, ot } = findAndHideWidgets(node);
    const p = node.properties;
    ot.value = p.sliderType === "int" ? "int" : "float";

    const el = document.createElement("div");
    el.className = "xzg-us-dom";

    // 第一行：滑条 + 数值 + ⚙（横向）
    const mainrow = document.createElement("div");
    mainrow.className = "xzg-us-mainrow";

    const wrap = document.createElement("div");
    wrap.className = "xzg-us-trackwrap";
    const range = document.createElement("input");
    range.type = "range";
    range.className = "xzg-us-main-range";
    wrap.appendChild(range);
    mainrow.appendChild(wrap);

    const top = document.createElement("div");
    top.className = "xzg-us-top";
    const val = document.createElement("span");
    val.className = "xzg-us-main-val";
    const gear = document.createElement("button");
    gear.className = "xzg-us-gear";
    gear.type = "button";
    gear.title = "万能滑条 设置";
    gear.innerHTML = '<i class="mdi mdi-cog" aria-hidden="true"></i>';
    top.append(val, gear);
    mainrow.appendChild(top);

    el.appendChild(mainrow);

    const widget = node.addDOMWidget("xzg_us_ui", "universal_slider_dom", el, {
        serialize: false,
        hideOnZoom: false,
        // 布局高度策略（兼容 Nodes 2.0 与 legacy 画布）：
        // - getMinHeight：关闭时固定为内容自然高度；打开设置框时附加设置框高度。
        //   注意不能依赖 node.size，否则 legacy 画布拉伸会形成自增反馈环（自动变高、不能缩小）；
        // - getMaxHeight 跟随节点高度，供 Nodes 2.0 的 distributeSpace 分配，使滑条铺满内容区。
        getMinHeight: () => {
            const base = Math.max(5, MIN_H - TITLE_H);
            const g = node._xzgUs;
            return g && g.settingsOpen ? base + (g._openExtraH || SETTINGS_H_EST) : base;
        },
        getMaxHeight: () => Math.max(5, (node.size?.[1] ?? MIN_H) - TITLE_H),
    });
    // widget 从标题栏下方开始，覆盖整个内容区
    node.widgets_start_y = TITLE_H;

    const g = { el, val, gear, range, wrap, mainrow, widget, dw, ot,
                settingsOpen: false, _openExtraH: 0 };
    node._xzgUs = g;

    // 第二行：滑条下方的内嵌设置框（平时隐藏）
    const settingsBox = buildSettingsBox(node);
    g.settingsBox = settingsBox;
    el.appendChild(settingsBox);

    // ⚙ 齿轮 → 打开/关闭设置框
    gear.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSettings(node);
    });

    // 滑条拖动 → 写回「数值」原生控件
    // input（拖动中）仅更新 UI，graph.change() 推迟到 change（松开）一次性触发，
    // 避免拖动过程中每次 input 都做整幅工作流序列化/脏标记（高频全图序列化）。
    const applyRange = () => {
        const v = calcValue(Number(range.value), p.sliderMin, p.sliderMax, p.sliderStep, p.sliderType === "int");
        if (dw) dw.value = v;
        refreshDomSlider(node);
        node.setDirtyCanvas(true, true);
    };
    const commitRange = () => {
        if (node.graph && typeof node.graph.change === "function") node.graph.change();
    };
    range.addEventListener("input", applyRange);
    range.addEventListener("change", commitRange);

    // 字号：数值/齿轮固定大小（14px），不随节点缩放；仅当数值过宽时按比例缩小兜底
    const syncFont = () => {
        const fontFace = '"Cascadia Mono",Consolas,monospace';
        let size = 14;
        const availW = Math.max(60, (el.clientWidth || MIN_W) - PAD * 2);
        const ctx2d = syncFont._ctx || (syncFont._ctx = document.createElement("canvas").getContext("2d"));
        ctx2d.font = `600 ${size}px ${fontFace}`;
        const w = ctx2d.measureText(val.textContent || "0.00").width;
        const maxW = availW * 0.9;
        if (w > maxW) size = Math.max(9, Math.floor(size * (maxW / w)));
        if (val.style.fontSize !== size + "px") {
            val.style.fontSize = size + "px";
            gear.style.fontSize = size + "px";
        }
    };
    g.syncFont = syncFont;

    if (typeof ResizeObserver !== "undefined") {
        let roRaf = null;
        let roLastW = -1;
        const roTick = () => {
            roRaf = null;
            try {
                const w = el.clientWidth | 0;
                if (w === roLastW) return;   // 高度变化不影响字号，跳过
                roLastW = w;
                syncFont();
            } catch (e) { /* 忽略 */ }
        };
        g.ro = new ResizeObserver(() => {
            if (roRaf) return;              // 本帧已在排队，合并
            roRaf = requestAnimationFrame(roTick);
        });
        g.ro.observe(el);
    }
    refreshDomSlider(node);
    // 首次挂载后强制重绘，确保覆盖层定位与字号正确
    requestAnimationFrame(() => {
        syncFont();
        app.canvas?.setDirty?.(true, true);
    });
    // Nodes 2.0 的 Vue 可能多次重建原生控件：挂载后短暂持续隐藏（约 3 秒后自动停止）
    let guard = 0;
    g._guardTimer = setInterval(() => {
        if (!node._xzgUs || ++guard > 15) { clearInterval(g._guardTimer); g._guardTimer = null; return; }
        // 仅当隐藏状态实际变化时强制重绘
        if (findAndHideWidgets(node).changed) app.canvas?.setDirty?.(true, true);
    }, 200);
    // 端口条悬浮 → 内容外框可置顶（A000 Port 共享模块）
    floatPortRails(node, g, { alive: () => !!node._xzgUs });
}

/* ─── 设置框（节点内 · 滑条下方折叠框） ─── */

/** 构建内嵌设置框 DOM，并缓存面板控件引用 */
function buildSettingsBox(node) {
    const g = node._xzgUs;
    const p = node.properties;

    const box = document.createElement("div");
    box.className = "xzg-us-settings";

    function addRow(labelText, control) {
        const r = document.createElement("div");
        r.className = "xzg-us-row";
        const l = document.createElement("label");
        l.className = "xzg-us-rlbl";
        l.textContent = labelText;
        r.append(l, control);
        box.appendChild(r);
        return r;
    }

    function mkInp(type, value, attrs) {
        const i = document.createElement("input");
        i.className = "xzg-us-inp";
        i.type = type;
        if (value !== undefined && value !== null) i.value = value;
        if (attrs) Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
        return i;
    }

    // 类型：整数 / 浮点
    const radioWrap = document.createElement("div");
    radioWrap.className = "xzg-us-radio-wrap";
    let selectedType = p.sliderType;
    const typeLabels = [];
    const updateTypeUI = (type) => {
        selectedType = type;
        typeLabels.forEach(({ opt, label }) => {
            if (opt === type) label.classList.add("xzg-us-radio-checked");
            else label.classList.remove("xzg-us-radio-checked");
        });
    };
    ["int", "float"].forEach((opt) => {
        const label = document.createElement("label");
        label.className = "xzg-us-radio-label" + (p.sliderType === opt ? " xzg-us-radio-checked" : "");
        label.textContent = opt === "int" ? "整数" : "浮点";
        label.addEventListener("click", () => { updateTypeUI(opt); applySettings(node); });
        typeLabels.push({ opt, label });
        radioWrap.appendChild(label);
    });
    addRow("类型", radioWrap);

    // 参数：最小 / 最大 / 步长
    const paramWrap = document.createElement("div");
    paramWrap.style.cssText = "display:flex;gap:6px;flex:1;min-width:0;";
    function mkParamCell(labelText, value, attrs) {
        const cell = document.createElement("div");
        cell.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;";
        const lbl = document.createElement("label");
        lbl.textContent = labelText;
        lbl.style.cssText = "font-size:10px;color:#aaa;text-align:center;";
        const inp = mkInp("number", value, attrs);
        inp.style.textAlign = "center";
        inp.style.padding = "4px 2px";
        inp.style.width = "100%";
        inp.style.boxSizing = "border-box";
        cell.append(lbl, inp);
        return { cell, inp };
    }
    const minCell = mkParamCell("最小", p.sliderMin, { step: "any" });
    const maxCell = mkParamCell("最大", p.sliderMax, { step: "any" });
    const stepCell = mkParamCell("步长", p.sliderStep, { step: "any", min: "0.0001" });
    paramWrap.append(minCell.cell, maxCell.cell, stepCell.cell);
    addRow("参数", paramWrap);
    // 直接生效：参数修改后（失焦/回车）立即应用
    [minCell, maxCell, stepCell].forEach(({ inp }) =>
        inp.addEventListener("change", () => applySettings(node)));

    g.settingsUi = { selectedType, updateTypeUI, minCell, maxCell, stepCell };
    return box;
}

/** ⚙ 齿轮：打开或关闭设置框 */
function toggleSettings(node) {
    let g = node._xzgUs;
    if (!g) {
        setupDomSlider(node);
        g = node._xzgUs;
    }
    if (!g) return;
    if (g.settingsOpen) closeSettings(node);
    else openSettings(node);
}

function openSettings(node) {
    const g = node._xzgUs;
    if (!g) return;
    syncSettingsToPanel(node);
    g.settingsOpen = true;
    g.settingsBox.classList.add("xzg-us-open");
    updateNodeHeightForSettings(node);
    // 待 DOM 布局稳定后按真实高度再校正一次节点高度
    requestAnimationFrame(() => {
        if (node._xzgUs?.settingsOpen) updateNodeHeightForSettings(node);
    });
    // 鼠标离开节点内容区 → 延迟自动收起设置槽并收缩节点
    armAutoClose(node);
}

function closeSettings(node) {
    const g = node._xzgUs;
    if (!g) return;
    // 数据已直接生效，关闭时无需还原
    g.settingsOpen = false;
    g.settingsBox.classList.remove("xzg-us-open");
    updateNodeHeightForSettings(node);
    disarmAutoClose(node);
}

/** 鼠标离开节点内容区（el）后自动收起设置槽；短暂离开再回来会取消 */
function armAutoClose(node) {
    const g = node._xzgUs;
    if (!g || !g.el) return;
    disarmAutoClose(node);
    const leave = () => {
        if (g._autoCloseTimer != null) return; // 已在倒计时中
        g._autoCloseTimer = setTimeout(() => {
            g._autoCloseTimer = null;
            if (node._xzgUs?.settingsOpen) closeSettings(node);
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
function disarmAutoClose(node) {
    const g = node._xzgUs;
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

/** 打开时把属性同步到面板控件 */
function syncSettingsToPanel(node) {
    const g = node._xzgUs;
    if (!g || !g.settingsUi) return;
    const p = node.properties;
    const ui = g.settingsUi;
    ui.updateTypeUI(p.sliderType);
    ui.minCell.inp.value = p.sliderMin;
    ui.maxCell.inp.value = p.sliderMax;
    ui.stepCell.inp.value = p.sliderStep;
}

/** 读取面板值并立即应用 */
function applySettings(node) {
    const g = node._xzgUs;
    if (!g || !g.settingsUi) return;
    const p = node.properties;
    const ui = g.settingsUi;

    let type = ui.selectedType;
    let mn = parseFloat(ui.minCell.inp.value);
    let mx = parseFloat(ui.maxCell.inp.value);
    let step = parseFloat(ui.stepCell.inp.value);

    if (isNaN(mn)) mn = p.sliderMin;
    if (isNaN(mx)) mx = p.sliderMax;
    if (mn > mx) { const t = mn; mn = mx; mx = t; }
    if (isNaN(step) || step <= 0) step = p.sliderStep;
    if (type === "int") {
        mn = Math.round(mn);
        mx = Math.round(mx);
        step = Math.max(1, Math.round(step));
    }

    // 当前值：沿用节点自身「数值」控件的值（clamp/snap 到新参数范围）
    let cur = Number(g.dw ? g.dw.value : 0);
    if (isNaN(cur)) cur = 0;
    cur = calcValue(cur, mn, mx, step, type === "int");

    p.sliderType = type;
    p.sliderMin  = mn;
    p.sliderMax  = mx;
    p.sliderStep = step;

    if (g.dw) g.dw.value = cur;
    syncOutputType(node);
    refreshDomSlider(node);
    node.setDirtyCanvas(true, true);
    if (node.graph && typeof node.graph.change === "function") node.graph.change();
}

/** 根据设置框开关状态调整节点高度（打开撑高、关闭复原） */
function updateNodeHeightForSettings(node) {
    const g = node._xzgUs;
    if (!g || !g.settingsBox) return;
    const box = g.settingsBox;
    const w = node.size?.[0] ?? MIN_W;
    let h = node.size?.[1] ?? MIN_H;
    if (g.settingsOpen) {
        if (g._closedH == null) g._closedH = h;
        const extra = box.offsetHeight || SETTINGS_H_EST;
        g._openExtraH = extra;
        h = Math.max(h, MIN_H + extra);
    } else {
        if (g._closedH != null) {
            h = g._closedH;
            g._closedH = null;
        }
        h = Math.max(h, MIN_H);
    }
    node.setSize([w, h]);
    try {
        if (typeof node.arrange === "function") node.arrange();
    } catch (e) { /* 忽略 */ }
    app.canvas?.setDirty?.(true, true);
}

/* ─── 扩展注册 ─── */

app.registerExtension({
    name: EXTENSION_NAME,
    // 新建节点：直接挂 DOM 滑条
    // Nodes 2.0：nodeCreated 在构造函数内触发，此时 node.type 尚未赋值，须用 comfyClass 判断
    nodeCreated(node) {
        if (node.constructor?.comfyClass === NODE_TYPE || node.type === NODE_TYPE) setupDomSlider(node);
    },
    // 工作流加载/反序列化路径可能不触发 nodeCreated，补挂一次（幂等）
    loadedGraphNode(node) {
        if (node.type === NODE_TYPE) setupDomSlider(node);
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;


        /* ══ onNodeCreated：确保最小尺寸 + 兜底补挂 DOM 滑条 ══ */
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            // Nodes 2.0：createNode 在 node.type 赋值后才调用 onNodeCreated，此处兜底补挂（幂等）
            try { setupDomSlider(this); } catch (e) { /* 忽略 */ }
            this.setSize(this.computeSize());
            this.setDirtyCanvas(true, true);
            return r;
        };

        /* ══ computeSize：最小尺寸保证 + 设置框展开时保留展开高度 ══ */
        const origCS = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (width) {
            let r = origCS ? origCS.apply(this, arguments) : null;
            if (!r) r = [MIN_W, MIN_H];
            if (r[0] < MIN_W) r[0] = MIN_W;
            // 设置框展开时最小高度需包含展开区；否则后续 computeSize 重算会把展开的设置框压没
            const extra = this._xzgUs?.settingsOpen ? (this._xzgUs._openExtraH || SETTINGS_H_EST) : 0;
            const needH = Math.max(MIN_H, MIN_H + extra);
            if (r[1] < needH) r[1] = needH;
            return r;
        };

        /* ══ onWidgetChanged：数值被外部修改时同步滑条 ══ */
        const origOWC = nodeType.prototype.onWidgetChanged;
        nodeType.prototype.onWidgetChanged = function (name, value, widget) {
            const r = origOWC ? origOWC.apply(this, arguments) : undefined;
            if (name === "数值" && this._xzgUs) {
                syncOutputType(this);
                refreshDomSlider(this);
            }
            return r;
        };

        /* ══ configure：工作流恢复后同步滑条状态 ══ */
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);
            if (this._xzgUs) {
                initProperties(this);
                syncOutputType(this);
                refreshDomSlider(this);
            }
        };

        /* ══ onRemoved：清理（ResizeObserver/guardTimer/自动收起监听 防泄漏） ══ */
        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (origRemoved) origRemoved.apply(this, arguments);
            const g = this._xzgUs;
            if (g) {
                if (g.ro) g.ro.disconnect();
                g.ro = null;
                if (g._guardTimer) clearInterval(g._guardTimer);
                g._guardTimer = null;
                /* ★ 端口效果统一走共享模块的释放出口（2026-10-06）：
                 *  releasePortNode 接管 _portTimer / _portFastTimers / _portNodeMO
                 *  以及 A000_Port 注册表 _portMOBindings 的摘除（原来只 clearInterval，
                 *  绕过了注册表清理路径）。原 if (g._portMO) 分支是死代码
                 *  —— 单例观察器存在模块级，从不挂到 g 上。 */
                releasePortNode(this, g);
                disarmAutoClose(this);
                this._xzgUs = null;
            }
            if (this._xzgRetryTimer) { clearTimeout(this._xzgRetryTimer); this._xzgRetryTimer = null; }
            if (this._xzgUsTries) this._xzgUsTries = 0;
        };
    },
});
