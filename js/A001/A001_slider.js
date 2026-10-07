/* =============================================================================
 * A001_slider.js —— A001 提升数值控件 · 滑条外观与拖拽（复刻 008_ComfyTV）
 * -----------------------------------------------------------------------------
 * 一、复刻来源（008_ComfyTV 的实现，逐项对齐）
 * -----------------------------------------------------------------------------
 *  ComfyTV 的滑条是自研 Vue 组件 src/components/widgets/ComfyTVSlider.vue：
 *    <SliderRoot> <SliderTrack> <SliderRange> </SliderTrack> <SliderThumb> </SliderRoot>
 *    + 右侧 <input type="number"> 数值框（可输入、可键盘微调）
 *    外观：轨道 4px 圆角、填充色 var(--primary-background,#4a8cff)、
 *          滑块 12px 圆形、灰白填充、轻投影。
 *
 *  「哪些提升控件用滑条」的两处判据（原文摘录，本模块按此复刻）：
 *    · CustomInputsV2.vue  isSlider(it)：
 *        if (it.ptype !== 'INT' && it.ptype !== 'FLOAT') return false
 *        const min = propNum(it,'min'), max = propNum(it,'max')
 *        return min !== undefined && max !== undefined && max - min <= 1000
 *  （注：A001 已把跨度上限上调为 4096，见下方 MAX_SPAN；此处保留 ComfyTV 原文。）
 *    · CustomParamsV2.vue  useSlider(key)：
 *        defType(key) === 'int' && cfgNum(key,'min') !== undefined
 *                                && cfgNum(key,'max') !== undefined
 *  本模块统一为：**类型为 int/float + min/max 都是有限数 + 跨度 ≤ 4096**。
 *  （两处判据的唯一差别是 ComfyTV 的 params 侧没写跨度上限；本模块取更严格的
 *    输入侧口径 —— 与用户截图里的 KSampler.denoise / cfg 同类控件一致。）
 *
 * 二、为什么不是「新建组件」而是「改造官方控件行」
 * -----------------------------------------------------------------------------
 *  A001 的提升控件走**官方投影**（见 A001_SubgraphNode.js 的 installA001WidgetProjection）：
 *  它把外层 input 槽伪造成官方 store-backed widget，由官方 Vue 网格渲染出：
 *
 *    .lg-node-widget                                  ← 一整行
 *      … widget-layout-field-label                    ← 左侧标签
 *      DIV.relative.min-w-0.flex-1                    ← ★ 控件容器（本模块改造对象）
 *        DIV.min-w-0.cursor-default.rounded-md …
 *          DIV.flex.overflow-hidden.rounded-md …      ← ★ 内框（承载填充条 + ± + input）
 *            DIV.pointer-events-none.absolute.size-full > div[style="width:N%"]  ← 官方填充条
 *            BUTTON[data-testid="decrement"]          ← 官方减号（本模块隐藏）
 *            DIV.relative.my-0.25.min-w-[4ch].flex-1.py-1.5
 *              INPUT.absolute.inset-0.truncate …      ← ★ 数值输入（保留，仅调样式）
 *            BUTTON[data-testid="increment"]          ← 官方加号（本模块隐藏）
 *
 *  ★★ 血泪前提（勿尝试别的路子）：
 *    · **不要 addDOMWidget**：A001 投影层已接管 widgets 语义，运行时插入 DOM 控件
 *      会立刻触发 Vue 全量重建 → 页面崩溃（详见 A001_grid_anchor.js 头注）。
 *    · **不要替换 input**：官方 input 承载「输入 / 键盘微调 / readonly / disabled」等
 *      既有语义，替换会破坏这些行为，且与官方状态不同步。本模块只做**外观与拖拽**，
 *      输入本身完全交还官方。
 *    · **不要改动 grid 的尺寸**：控件行高度由官方 _arrangeWidgets 弹性分配，
 *      插手会破坏节点自由伸缩（详见 A001_textarea_resize.js 的同一告诫）。
 *
 * 三、值写入路径（与 A001 的提升语义一致）
 * -----------------------------------------------------------------------------
 *  通过投影 widget 的 `value` setter 写入（A001_SubgraphNode.js projectA001PromotedWidget）：
 *      set value(next) { store.setValue(id,next); srcWidget.value = next; }
 *  即「写 store 驱动官方 UI + 直写源 widget 驱动内层节点」双通道，无需本模块另造桥。
 *  拖拽中**实时**写值（按帧节流），松手后再写一次并派发 change（落盘 + 触发行同步）。
 *
 * 四、幂等与自愈
 * -----------------------------------------------------------------------------
 *  · mount 用 data 属性做幂等守卫，重复调用无副作用；
 *  · Vue 重建控件行后标记丢失 → 由 A001_restore 中枢（统一观察器 + 巡检）重新调用
 *    refreshA001Sliders 补齐；
 *  · 注释中禁止出现反引号（本项目血泪教训：模板字符串内反引号会提前闭合字符串）。
 * ========================================================================== */

import { safeCall } from "./A001_shared.js?v=20261007a";
import { injectStyleOnce } from "../A000/A000_DomStyle.js";

/* ---------------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------------- */
const STYLE_ID = "xzg-a001-slider-style";

/** 标记：控件行已被本模块接管的容器（打在「控件容器」p4 上）。 */
const SLIDER_HOST_ATTR = "data-a001-slider";
/** 值：该容器已绑定的最小/最大值与步进（缓存，避免每次重算）。 */
const MIN_ATTR = "data-a001-slider-min";
const MAX_ATTR = "data-a001-slider-max";
const STEP_ATTR = "data-a001-slider-step";
const INT_ATTR = "data-a001-slider-int";

/** 跨度上限（用户设定：max - min <= 4096 才做滑条；原 ComfyTV 为 1000）。 */
const MAX_SPAN = 4096;

/** 默认滑条范围：控件**第一次提升**且 options 未定义 min/max 时使用（用户需求）。
 *  min=1 / max=10 / step=1。首次提升后即写入持久化记录，之后不再套用默认值。 */
const FORCE_RANGE = { min: 1, max: 10, step: 1 };

/** 持久化键：用户经「参数设置」改过的滑条范围（存在 node.properties，随工作流保存）。 */
const SLIDER_RANGE_PROP = "a001SliderRanges";

/* 颜色（对齐 ComfyTV：填充 var(--primary-background,#4a8cff)，滑块近白）。 */
const TRACK_BG = "rgba(255,255,255,.12)";
const RANGE_BG = "#4a8cff";
const THUMB_BG = "#eeeeee";

/* ---------------------------------------------------------------------------
 * 样式注入（幂等）
 * ------------------------------------------------------------------------- */
const STYLE_TEXT = `
/* ── A001 提升数值控件：滑条外观（严格复刻 008_ComfyTV 的 ComfyTVSlider.vue） ──
 * 目标观感（与 ComfyTV 逐项对齐）：
 *   [ 轨道 4px 圆角 ──────●          ]    [ 44px 带边框圆角数值框 ]
 *   · .ctv-slider-root   height:18px, flex:1, align-items:center
 *   · .ctv-slider-track  height:4px, radius:9999px, bg:rgba(255,255,255,.12)
 *   · .ctv-slider-range  height:100%, radius:9999px, bg:#4a8cff
 *   · .ctv-slider-thumb  12px, radius:9999px, bg:#eee, shadow:0 1px 3px rgb(0 0 0/.4)
 *   · .ctv-slider-num    width:44px, 右对齐, 11px, border:1px solid rgba(255,255,255,.1),
 *                        radius:6px, focus 时 border-color:#4a8cff
 *   · .ctv-slider-row    display:flex, align-items:center, gap:8px
 *
 * ★★ 改造策略（官方 DOM 结构固定，只能「就位改造」）：
 *   官方内框 p2 是 [填充条层][−][p1(input)][+] 的横向 flex。我们：
 *     ① 隐藏官方 ± 与官方填充条层；
 *     ② 把 host(p4) 设为 position:relative，作为轨道与滑块的定位上下文；
 *     ③ 轨道/填充/滑块只占**左侧**（right 让出「数值框宽 + 间距」）；
 *     ④ p1（数值输入容器）改造成 ComfyTV 的 .ctv-slider-num 样式：
 *        固定 44px、带边框圆角、右对齐。
 *   ⚠️ 本段位于模板字符串内，注释中禁止出现反引号。 */

/* ── 控件行左侧「类型圆点」：保持官方原生显隐行为 ──
 * 官方把圆点容器设为 opacity-0 + group-hover:opacity-100 ——
 * 即「未选中/未悬停时隐藏，选中或悬停该控件行时才浮现」。
 * ★ 血泪教训（勿再强行常驻）：曾用 opacity:1!important 让圆点常驻，
 *   但用户要求「和原生的一样」——故此处**不加任何覆盖**，完全交给官方规则。
 *   本段仅作说明保留，不写规则。 */

/* 官方减号/加号：本模块以「拖拽轨道」替代，隐藏之（保留 DOM，不影响其既有事件）。 */
.xzg-a001-node [data-a001-slider] button[data-testid="decrement"],
.xzg-a001-node [data-a001-slider] button[data-testid="increment"] {
    display: none !important;
}

/* 官方填充条层：隐藏（改由我们自己的 track/range 绘制，避免两条叠加）。 */
.xzg-a001-node [data-a001-slider] .pointer-events-none.absolute.size-full.overflow-clip {
    display: none !important;
}

/* host（官方数值控件容器）：定位上下文；轨道的保留区 = 左侧，右侧让给「数值框 + 齿轮」。
 * --xzg-a001-slider-numw 为右侧保留区宽度占位（44px 数值框 + 8px 间距 + 20px 齿轮 + 6px 间距 = 78px）。 */
.xzg-a001-node [data-a001-slider] {
    position: relative;
    cursor: pointer;
    touch-action: none;
    --xzg-a001-slider-numw: 78px;
    --xzg-a001-slider-gearw: 26px;
}

/* 官方「内框/外框」两层（p2 / p3）：去掉官方深色底与圆角边框 ——
 * ComfyTV 的滑条区没有额外背景块，只有一条轨道（图中的观感）。
 * ★ 保留其定位与撑满行为，只清视觉（background/border），避免塌陷。 */
.xzg-a001-node [data-a001-slider] > div:not(.xzg-a001-slider-track) {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
}
.xzg-a001-node [data-a001-slider] > div:not(.xzg-a001-slider-track) > div:not(.xzg-a001-slider-range):not(.xzg-a001-slider-thumb) {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
}

/* 数值框（官方 p1 容器）：改成 ComfyTV 的 .ctv-slider-num 样式 ——
 * 固定 44px 宽、右对齐、带边框圆角小框；并让它**排到最右**（轨道在左）。
 * 用 position:absolute 靠右对齐，避免与轨道的绝对定位互相挤压。 */
.xzg-a001-node [data-a001-slider] .relative.my-0\\.25 {
    position: absolute !important;
    right: var(--xzg-a001-slider-gearw, 26px) !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    width: 44px !important;
    min-width: 44px !important;
    flex: 0 0 44px !important;
    margin: 0 !important;
    padding: 0 4px !important;
    box-sizing: border-box !important;
    height: 18px !important;
    display: flex !important;
    align-items: center !important;
    border: 1px solid rgba(255, 255, 255, .1) !important;
    border-radius: 6px !important;
    background: transparent !important;
}
.xzg-a001-node [data-a001-slider] .relative.my-0\\.25:focus-within {
    border-color: #4a8cff !important;
}

/* 数值输入本身：右对齐、等宽数字、透明底、无边框（边框由上面的容器画）。 */
.xzg-a001-node [data-a001-slider] input {
    position: static !important;
    inset: auto !important;
    width: 100% !important;
    height: 100% !important;
    text-align: right !important;
    font-size: 11px !important;
    font-variant-numeric: tabular-nums !important;
    color: #ddd !important;
    background: transparent !important;
    border: none !important;
    outline: none !important;
    padding: 0 !important;
    margin: 0 !important;
    box-sizing: border-box !important;
    cursor: text;
}
/* 去掉浏览器原生数字微调箭头（复刻 ComfyTV 的 appearance:textfield）。 */
.xzg-a001-node [data-a001-slider] input::-webkit-inner-spin-button,
.xzg-a001-node [data-a001-slider] input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
}
.xzg-a001-node [data-a001-slider] input {
    appearance: textfield;
    -moz-appearance: textfield;
}

/* 轨道：只占左侧（右侧让出 --xzg-a001-slider-numw），4px 圆角，垂直居中
 * （复刻 .ctv-slider-track；用 top:50% + margin-top 对齐中心线）。
 * ★ range 与 thumb 都作为 track 的**子元素**，百分比即以 track 宽度为基准，
 *   三者坐标系天然一致（避免「滑块按 host 宽度算、轨道按剩余宽度算」的错位）。 */
.xzg-a001-node [data-a001-slider] .xzg-a001-slider-track {
    position: absolute;
    left: 0;
    right: var(--xzg-a001-slider-numw, 52px);
    top: 50%;
    height: 4px;
    margin-top: -2px;
    border-radius: 9999px;
    background: ${TRACK_BG};
    pointer-events: none;
}

/* 填充段：宽度 = 数值进度（由 JS 写 --xzg-a001-slider-pct），位于轨道内。 */
.xzg-a001-node [data-a001-slider] .xzg-a001-slider-range {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    border-radius: 9999px;
    background: ${RANGE_BG};
    width: var(--xzg-a001-slider-pct, 0%);
    pointer-events: none;
}

/* 滑块：12px 圆形，中心对齐进度点（复刻 .ctv-slider-thumb）。 */
.xzg-a001-node [data-a001-slider] .xzg-a001-slider-thumb {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    margin-top: -6px;
    margin-left: -6px;
    border-radius: 9999px;
    background: ${THUMB_BG};
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
    pointer-events: none;
    left: var(--xzg-a001-slider-pct, 0%);
}
.xzg-a001-node [data-a001-slider].xzg-a001-slider-dragging {
    cursor: grabbing;
}

/* 禁用态（官方 readonly / disabled 时）：数值框与轨道一并降透明度。 */
.xzg-a001-node [data-a001-slider][data-a001-slider-disabled] {
    opacity: .5;
    pointer-events: none;
}

/* ── 数值框右侧「参数设置」齿轮按钮（复刻 A003 的 .xzg-us-gear） ──
 * 位置：排在数值框**右侧**（用户要求「数值后面」）。数值框右缘 = host 右侧，
 * 故齿轮贴在 host 最右，数值框整体左移让出齿轮位（见下方 right 偏移）。
 * 尺寸/配色逐项对齐 A003：20px、圆角 6px、深底、浅字。 */
.xzg-a001-node [data-a001-slider] .xzg-a001-slider-gear {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    right: 0;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, .3);
    border-radius: 6px;
    background: rgba(34, 34, 34, .92);
    color: #ddd;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    z-index: 3;
    box-sizing: border-box;
}
.xzg-a001-node [data-a001-slider] .xzg-a001-slider-gear:hover {
    filter: brightness(1.25);
}

/* ── 参数设置面板（复刻 A003 的 .xzg-us-settings）──
 * ⚠️ 本面板不放在官方控件行内（会打乱官方网格），而是**追加到官方控件网格
 *    （.lg-node-widgets，display:grid）的末尾**，故必须 grid-column: 1 / -1 跨满整行，
 *    否则只会落在第 1 列（实测宽 107px 而非整行 367px）。
 * ★ 左侧缩进：官方控件行虽从网格左缘起，但**其标签文字实际右移了一段**（实测
 *   「视频尺寸系数」文字 left 比控件行 left 大 21px）。面板为 grid 行且自带 16px 的
 *   列内偏移，故净 margin 用 5px 即可让外框与其它控件文字左缘对齐（实测 239+16+5=260）。
 *   右侧保持与控件行右缘齐平。 */
.xzg-a001-node .xzg-a001-slider-panel {
    display: none;
    grid-column: 1 / -1;
    margin: 0 0 0 12px;
    flex-direction: column;
    gap: 8px;
    border: 1px solid #444;
    border-radius: 20px;
    background: #222;
    /* 上下 4px、左右 12px。 */
    padding: 4px 12px;
    box-sizing: border-box;
    width: auto;
    font-size: 12px;
}
.xzg-a001-node .xzg-a001-slider-panel.xzg-a001-slider-open {
    display: flex;
}
.xzg-a001-node .xzg-a001-slider-prow {
    display: flex;
    align-items: center;
    gap: 10px;
}
.xzg-a001-node .xzg-a001-slider-pfields {
    display: flex;
    flex: 1;
    min-width: 0;
    gap: 10px;
}
/* 单行排布：每组为「标签 + 输入框」横向并排（标签在左、输入框在右）。 */
.xzg-a001-node .xzg-a001-slider-pcell {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 4px;
}
.xzg-a001-node .xzg-a001-slider-pcell > label {
    flex-shrink: 0;
    font-size: 12px;
    color: #aaa;
    text-align: right;
    white-space: nowrap;
}
.xzg-a001-node .xzg-a001-slider-pinp {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    text-align: center;
    height: 16px;
    padding: 0 2px;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #fff;
    font-size: 12px;
    font-family: inherit;
    outline: none;
}
.xzg-a001-node .xzg-a001-slider-pinp::-webkit-outer-spin-button,
.xzg-a001-node .xzg-a001-slider-pinp::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
}
.xzg-a001-node .xzg-a001-slider-pinp:focus {
    border-color: #4a8cff;
}
`;

function injectCss() {
    safeCall(() => {
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
    }, undefined, "注入 A001 滑条样式");
}

/* ---------------------------------------------------------------------------
 * 判据：是否应换成滑条（复刻 ComfyTV 的 isSlider）
 *
 * @param {object} widget 投影 widget（有 .type / .options / .value）
 * @returns {boolean}
 * ------------------------------------------------------------------------- */
function isA001SliderWidget(widget) {
    if (!widget) return false;
    const t = String(widget.type ?? "").toLowerCase();
    if (t !== "int" && t !== "float") return false;
    return sliderRangeOf(widget) !== null;
}

/**
 * 取滑条的 [min, max, step, isInt]（不满足判据返回 null）。
 *
 * ★ 数据来源：投影 widget 的 options（A001_SubgraphNode.projectA001PromotedWidget
 *   把源 widget 的 options 原样透出）。ComfyUI 的 INT/FLOAT widget options 通常带
 *   min/max/step/precision；实测 megapixels 的 options 为
 *   {min:0.1, max:16, round:0.1, step:1, step2:0.1, precision:1}。
 *
 * ★ 跨度判据：max - min <= 4096（用户设定，较 ComfyTV 的 1000 放宽），
 *   否则（如 seed 的 0~2^64）不做滑条。
 *
 * ★ 默认范围（用户需求）：控件 options 未定义 min/max 时，用默认 1~10 / 步长 1。
 *   该默认只在「第一次提升」时写入（见 ensureInitialRange），首次后会持久化，
 *   之后保留用户改过的值，不再套用默认。
 */
function sliderRangeOf(widget) {
    return safeCall(() => {
        const o = widget?.options || {};
        const isInt = String(widget.type ?? "").toLowerCase() === "int";
        let min = Number(o.min);
        let max = Number(o.max);
        /* 无有效范围 → 默认 1~10 / 步长 1（值可能超出，由 paintSlider 进度夹取，不报错）。 */
        if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
            min = FORCE_RANGE.min;
            max = FORCE_RANGE.max;
            return { min, max, step: FORCE_RANGE.step, isInt, fallback: true };
        }
        if (max - min > MAX_SPAN) return null;
        /* 步进：优先 options.step；int 恒为 1；float 回退 0.01（复刻 ComfyTV 的
         * `step ?? (ptype==='INT' ? 1 : 0.01)`）。 */
        let step = Number(o.step);
        if (!Number.isFinite(step) || step <= 0) step = isInt ? 1 : 0.01;
        return { min, max, step, isInt };
    }, null, "读滑条范围");
}

/* ---------------------------------------------------------------------------
 * 「参数设置」齿轮 + 面板（复刻 A003 的万能滑条设置，但改滑条范围而非节点属性）
 *
 * 目标（用户需求）：
 *   · 数值框右侧一个齿轮按钮；点击展开面板；面板可改 最小/最大/步长。
 *   · 改完立即作用到该提升控件的滑条范围，并随工作流保存。
 *
 * ★ 与 A003 的本质差异（决定了实现方式）：
 *   A003 是**独立节点**，min/max/step 存在 node.properties；
 *   而 A001 的滑条是**官方提升控件**，其范围来自官方 widget.options。
 *   故这里改写 widget.options.{min,max,step}（实测可写、refresh 后滑条即采用新范围），
 *   并把用户改过的范围另存到 node.properties（键 a001SliderRanges），
 *   以便刷新/重载工作流后回填（避免被官方默认值覆盖）。
 * ------------------------------------------------------------------------- */

/** 每个 widget 的稳定标识：用其名字（提升控件名字唯一）。 */
function sliderKeyOf(widget) {
    return String(widget?.name ?? "");
}

/** 读取用户自定义范围的持久化表（挂在 node.properties）。
 *  ★ create=false（默认）时**不创建**属性：无记录返回空对象字面量。
 *    原实现无条件写入 {} —— 而 refreshA001Sliders 会对**每个**控件（含非滑条）
 *    调用本函数，导致每个 A001 节点的 properties 都被塞进 a001SliderRanges:{}
 *    并随工作流序列化（脏属性）。写路径显式传 create=true。 */
function readRangeStore(node, create = false) {
    const p = node?.properties;
    if (!p || typeof p !== "object") return {};
    const store = p[SLIDER_RANGE_PROP];
    if (store && typeof store === "object") return store;
    if (!create) return {};
    p[SLIDER_RANGE_PROP] = {};
    return p[SLIDER_RANGE_PROP];
}

/**
 * ★ 首次提升：为「无范围」控件写入并固化默认滑条范围（用户需求：
 *   「默认值只在第 1 次提升时使用」）。
 *
 * 规则（仅当该控件尚无持久化记录、且 options 无有效 min/max 时执行一次）：
 *   · 写入默认范围（1~10 / 步长 1）并固化为记录（写 node.properties，随工作流保存）；
 *   · 此后 applyStoredRange 会优先回填该记录，默认值不再生效 ——
 *     用户后续经齿轮修改的范围得以保留，不会被默认值顶掉。
 *
 * ★ 自带有效 min/max 的控件**不处理**（保持原行为：用其自身范围，不写记录）。
 *
 * @returns {boolean} 是否发生了首次固化
 */
function ensureInitialRange(node, widget) {
    return safeCall(() => {
        /* 仅处理 int/float 数值控件（prompt/combo 等一律跳过）。 */
        const ty = String(widget?.type ?? "").toLowerCase();
        if (ty !== "int" && ty !== "float") return false;
        const store = readRangeStore(node);
        const key = sliderKeyOf(widget);
        if (store[key] && typeof store[key] === "object") return false; // 非首次：已有记录
        const o = widget.options || (widget.options = {});
        let min = Number(o.min);
        let max = Number(o.max);
        const hasRange = Number.isFinite(min) && Number.isFinite(max) && max > min;
        /* 自带范围 → 不干预（不写记录，沿用原逻辑）。 */
        if (hasRange) return false;
        /* 首次提升且无范围 → 使用默认值并固化。 */
        const isInt = String(widget.type ?? "").toLowerCase() === "int";
        o.min = FORCE_RANGE.min;
        o.max = FORCE_RANGE.max;
        if (!(Number(o.step) > 0)) o.step = isInt ? 1 : FORCE_RANGE.step;
        /* ★ 只在确实要固化记录时才创建持久化表（读路径不写属性）。 */
        readRangeStore(node, true)[key] = { min: FORCE_RANGE.min, max: FORCE_RANGE.max, step: Number(o.step) > 0 ? Number(o.step) : FORCE_RANGE.step };
        return true;
    }, false, "首次固化默认滑条范围");
}

/**
 * 把用户自定义范围应用到 widget.options（在 refresh 前调用，用于回填持久化值）。
 * 返回是否发生了应用。
 */
function applyStoredRange(node, widget) {
    return safeCall(() => {
        const store = readRangeStore(node);
        const rec = store[sliderKeyOf(widget)];
        if (!rec || typeof rec !== "object") return false;
        const o = widget.options || (widget.options = {});
        if (Number.isFinite(Number(rec.min))) o.min = Number(rec.min);
        if (Number.isFinite(Number(rec.max))) o.max = Number(rec.max);
        if (Number.isFinite(Number(rec.step)) && Number(rec.step) > 0) o.step = Number(rec.step);
        return true;
    }, false, "应用已存滑条范围");
}

/**
 * 把面板输入写入 widget.options + node.properties，并刷新滑条。
 *
 * 校验（复刻 A003 的 applySettings 语义）：
 *   · min/max 必须为有限数；min>max 自动交换；
 *   · step 必须 >0，否则回退原值；
 *   · int 类型时 min/max/step 取整（step 至少 1）。
 */
function applySliderSettings(node, widget, host, vals) {
    return safeCall(() => {
        const o = widget.options || (widget.options = {});
        const isInt = String(widget.type ?? "").toLowerCase() === "int";
        let mn = Number(vals.min);
        let mx = Number(vals.max);
        let st = Number(vals.step);
        if (!Number.isFinite(mn)) mn = Number(o.min);
        if (!Number.isFinite(mx)) mx = Number(o.max);
        if (mn > mx) { const t = mn; mn = mx; mx = t; }
        if (!Number.isFinite(st) || st <= 0) st = Number(o.step) > 0 ? Number(o.step) : (isInt ? 1 : 0.01);
        if (isInt) {
            mn = Math.round(mn);
            mx = Math.round(mx);
            st = Math.max(1, Math.round(st));
        }
        o.min = mn;
        o.max = mx;
        o.step = st;
        /* 数值越界时夹回范围内（复刻 A003 的自动扩范围反向逻辑：这里取夹取）。 */
        const cur = Number(widget.value);
        if (Number.isFinite(cur)) {
            const clamped = Math.min(mx, Math.max(mn, cur));
            if (clamped !== cur) widget.value = clamped;
        }
        /* 持久化（随工作流保存）。 */
        readRangeStore(node, true)[sliderKeyOf(widget)] = { min: mn, max: mx, step: st };
        /* 立即刷新该行滑条（范围变了要重绘轨道/进度）。 */
        mountSliderRow(widget, host.closest(".lg-node-widget") || null);
        if (host._xzgA001SliderPanel) refreshSliderPanel(node, widget, host);
        /* 触发图变更（让工作流标记为已修改、参与序列化）。 */
        const g = node?.graph;
        if (g && typeof g.change === "function") safeCall(() => g.change(), undefined, "滑条范围变更通知");
    }, false, "应用滑条参数设置");
}

/** 构建/刷新面板内输入框的值（打开面板时调用）。 */
function refreshSliderPanel(node, widget, host) {
    const ui = host?._xzgA001SliderPanel;
    if (!ui) return;
    safeCall(() => {
        const o = widget.options || {};
        ui.min.value = o.min ?? "";
        ui.max.value = o.max ?? "";
        ui.step.value = o.step ?? "";
    }, undefined, "回填滑条面板");
}

/** 关闭面板。 */
function closeSliderPanel(host) {
    const ui = host?._xzgA001SliderPanel;
    if (!ui) return;
    ui.box.classList.remove("xzg-a001-slider-open");
    host.classList.remove("xzg-a001-slider-panel-open");
    /* 一并解除「鼠标离开节点自动收起」监听。 */
    disarmSliderAutoClose(host);
}

/**
 * 取滑条所属的「节点根」元素（自动收起与同节点面板互斥都用它做范围判定）。
 *
 * ★★ 为什么必须有 [data-node-id] 兜底（血泪教训，勿改回只认 .xzg-a001-node）：
 *   `.xzg-a001-node` 是 A001 端口胶囊模块打上去的**换皮类名**，Vue 重建节点 DOM
 *   后会随旧元素一起消失，要等恢复中枢（A001_restore）巡检才补回来。若用户正好在这个
 *   窗口期点开设置框，closest('.xzg-a001-node') 返回 null → armSliderAutoClose 静默
 *   return → 面板开着却**永不自动收起**（用户反馈的「自动关闭失效了」）。
 *   `[data-node-id]` 是官方节点根属性，节点 DOM 存在即存在，任何时刻都能取到，
 *   故作为稳定兜底。两种选择器取到的都是同一个节点根元素，语义完全一致。
 */
function sliderNodeRoot(host) {
    return host?.closest?.(".xzg-a001-node") || host?.closest?.("[data-node-id]") || null;
}

/**
 * 武装「鼠标离开节点即自动收起」。
 *
 * ★ 复刻 A003 的行为（用户需求）：设置框打开后，鼠标一旦离开整个节点就自动关闭。
 * ★ 用**两种**机制兜底，确保真实/合成场景都可靠：
 *     ① 节点根的 mouseleave —— 常规路径，指针进入过节点再离开时触发；
 *     ② document 的 mousemove（捕获）—— 兜底：若指针移动到节点之外，也立即收起。
 *        （解决「指针从未真正进入节点」时 mouseleave 永不触发的问题，实测必须。）
 *     节点根由 sliderNodeRoot 取得（.xzg-a001-node 缺失时回退官方 [data-node-id]）。
 * ★ 监听存到 host 上，关闭/卸载时务必移除，避免泄漏与重复绑定。
 */
function armSliderAutoClose(host) {
    if (!host || host._xzgA001AutoCloseRoot) return;
    const root = sliderNodeRoot(host);
    if (!root) return;
    const onLeave = () => safeCall(() => closeSliderPanel(host), undefined, "鼠标离开节点自动收起设置框");
    const onMove = (ev) => safeCall(() => {
        const t = ev.target;
        if (t && (t === root || root.contains(t))) return;
        closeSliderPanel(host);
    }, undefined, "指针移到节点外自动收起设置框");
    root.addEventListener("mouseleave", onLeave);
    document.addEventListener("mousemove", onMove, true);
    host._xzgA001AutoCloseRoot = root;
    host._xzgA001AutoCloseHandler = onLeave;
    host._xzgA001AutoCloseMove = onMove;
}

/** 解除自动收起监听。 */
function disarmSliderAutoClose(host) {
    if (!host) return;
    const root = host._xzgA001AutoCloseRoot;
    const fn = host._xzgA001AutoCloseHandler;
    const mv = host._xzgA001AutoCloseMove;
    if (root && fn) safeCall(() => root.removeEventListener("mouseleave", fn), undefined, "解绑设置框自动收起");
    if (mv) safeCall(() => document.removeEventListener("mousemove", mv, true), undefined, "解绑设置框指针兜底");
    host._xzgA001AutoCloseRoot = null;
    host._xzgA001AutoCloseHandler = null;
    host._xzgA001AutoCloseMove = null;
}

/** 打开/关闭面板（切换）。 */
function toggleSliderPanel(node, widget, host) {
    const ui = host?._xzgA001SliderPanel;
    if (!ui) return;
    if (ui.box.classList.contains("xzg-a001-slider-open")) {
        closeSliderPanel(host);
        return;
    }
    /* 本节点内其它行若开着面板，先关掉（避免多面板并存），并解除它们的自动收起监听。 */
    const root = sliderNodeRoot(host);
    if (root) {
        root.querySelectorAll(".xzg-a001-slider-panel.xzg-a001-slider-open").forEach((b) => {
            b.classList.remove("xzg-a001-slider-open");
        });
        root.querySelectorAll("[data-a001-slider]").forEach((h) => {
            if (h !== host) disarmSliderAutoClose(h);
        });
    }
    refreshSliderPanel(node, widget, host);
    ui.box.classList.add("xzg-a001-slider-open");
    host.classList.add("xzg-a001-slider-panel-open");
    /* 鼠标离开节点即自动收起。 */
    armSliderAutoClose(host);
}

/**
 * 创建该行的「齿轮 + 面板」（幂等）。
 *
 * 面板挂载位置：**不在官方控件行内**（会打乱官方网格导致错位），而是追加到
 * 本行的父容器（.lg-node-widget 所在网格的父级）末尾——但更稳妥的是追加到
 * 节点根（.xzg-a001-node）的内容区末尾，用绝对定位锚在本行下方。
 * 这里采用「追加到本行 row 之后」的方案：官方网格是 grid-cols-subgrid，
 * 追加元素会另起一行，正好落在滑条行下方，随节点增长自然排布，无需绝对定位。
 */
function mountSliderGear(host, widget) {
    if (!host || host._xzgA001SliderGear) return;
    const row = host.closest(".lg-node-widget");
    if (!row) return;

    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "xzg-a001-slider-gear";
    gear.title = "滑条 参数设置";
    gear.innerHTML = '<i class="mdi mdi-cog" aria-hidden="true"></i>';
    host.appendChild(gear);

    /* 面板：作为本行 row 的兄弟节点追加到同一父容器（另起一行显示）。 */
    const box = document.createElement("div");
    box.className = "xzg-a001-slider-panel";

    const prow = document.createElement("div");
    prow.className = "xzg-a001-slider-prow";
    const fields = document.createElement("div");
    fields.className = "xzg-a001-slider-pfields";

    const mkCell = (label, value, attrs) => {
        const cell = document.createElement("div");
        cell.className = "xzg-a001-slider-pcell";
        const lb = document.createElement("label");
        lb.textContent = label;
        const inp = document.createElement("input");
        inp.type = "number";
        inp.className = "xzg-a001-slider-pinp";
        inp.value = value;
        if (attrs) Object.entries(attrs).forEach(([k, v]) => inp.setAttribute(k, v));
        cell.append(lb, inp);
        return { cell, inp };
    };
    const o = widget.options || {};
    const minCell = mkCell("最小", o.min ?? "", { step: "any" });
    const maxCell = mkCell("最大", o.max ?? "", { step: "any" });
    const stepCell = mkCell("步长", o.step ?? "", { step: "any", min: "0.0001" });
    fields.append(minCell.cell, maxCell.cell, stepCell.cell);
    prow.appendChild(fields);
    box.appendChild(prow);

    const readAndApply = () => applySliderSettings(host._xzgA001SliderNode || null, widget, host, {
        min: minCell.inp.value,
        max: maxCell.inp.value,
        step: stepCell.inp.value,
    });
    [minCell, maxCell, stepCell].forEach(({ inp }) => {
        inp.addEventListener("change", (e) => { e.stopPropagation(); readAndApply(); });
    });

    /* 面板事件不冒泡到画布/节点（避免触发选中、拖拽等）。 */
    box.addEventListener("pointerdown", (e) => e.stopPropagation());
    box.addEventListener("mousedown", (e) => e.stopPropagation());
    box.addEventListener("wheel", (e) => e.stopPropagation());

    /* ★ 面板必须**紧跟在所属滑条行之后**插入（而非追加到网格末尾）。
     *   血泪教训：原先用 parent.appendChild(box)，当滑条下面还有别的提升控件时，
     *   设置框会被排到整个网格的最底部（远离它所属的滑条），用户反馈「设置框不在
     *   滑条控件下面」。改用 insertAdjacentElement("afterend") 精确插在该行之后：
     *   网格为 display:grid，DOM 顺序即行序，面板紧跟滑条行、跨满整行。 */
    row.insertAdjacentElement("afterend", box);
    host._xzgA001SliderRow = row;

    gear.addEventListener("pointerdown", (e) => e.stopPropagation());
    gear.addEventListener("mousedown", (e) => e.stopPropagation());
    gear.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleSliderPanel(host._xzgA001SliderNode || null, widget, host);
    });

    host._xzgA001SliderGear = gear;
    host._xzgA001SliderPanel = { box, min: minCell.inp, max: maxCell.inp, step: stepCell.inp };
}

/* ---------------------------------------------------------------------------
 * 定位「控件容器」与「数值输入」
 *
 * 从官方控件行（.lg-node-widget）里找出承载数值控件的容器：
 *   · 行内有 input 且不是 textarea（多行文本已被编辑器接管，本模块不管）；
 *   · 容器 = input 向上第 4 层（实测链路：input < p1 < p2 < p3 < p4.relative.min-w-0.flex-1）。
 *     但层级可能随官方改版变化，故用「稳健回退」：从 input 向上找第一个
 *     「同为 flex 兄弟、且不含额外 input」的定位祖先（见 findSliderHost）。
 * ------------------------------------------------------------------------- */

/** 官方控件行内是否存在「非 textarea 的 input」。 */
function rowHasNumberInput(row) {
    if (!row?.querySelector) return false;
    const inputs = row.querySelectorAll("input");
    for (const el of inputs) {
        const ty = String(el.type || "text").toLowerCase();
        if (ty !== "checkbox" && ty !== "radio") return true;
    }
    return false;
}

/**
 * 从 input 向上找「滑条容器」。
 * 判据：该祖先的父链上第一个拥有「同层兄弟 input 之外的定位上下文」的块。
 * 稳健做法：向上最多 6 层，取**第一个**满足「其宽度明显大于 input 且包含 input」的祖先。
 * 实测稳定命中 p4（DIV.relative.min-w-0.flex-1）。
 */
function findSliderHost(input) {
    let cur = input?.parentElement;
    for (let i = 0; i < 6 && cur; i++) {
        const cls = String(cur.className || "");
        /* p4 的特征：relative + flex-1 + min-w-0（官方数值控件的容器三连）。 */
        if (cls.indexOf("relative") >= 0 && cls.indexOf("flex-1") >= 0 && cls.indexOf("min-w-0") >= 0) {
            return cur;
        }
        cur = cur.parentElement;
    }
    /* 回退：input 的第 4 层祖先（实测链路），仍取不到则用第 3 层。 */
    let fallback = input?.parentElement;
    for (let i = 0; i < 3 && fallback; i++) fallback = fallback.parentElement;
    return fallback || null;
}

/* ---------------------------------------------------------------------------
 * 进度 ↔ 数值 换算
 * ------------------------------------------------------------------------- */
function pctOf(value, range) {
    if (!range) return 0;
    const p = (Number(value) - range.min) / (range.max - range.min);
    if (!Number.isFinite(p)) return 0;
    return Math.max(0, Math.min(1, p));
}

/** 把进度换算回数值（带步进对齐；int 取整）。 */
function valueOfPct(pct, range) {
    const raw = range.min + pct * (range.max - range.min);
    if (range.isInt) return Math.round(raw);
    /* 浮点：按 step 对齐到小数位，避免 0.30000000000000004 这类脏值。 */
    const step = range.step;
    const snapped = Math.round(raw / step) * step;
    /* 去掉浮点误差（保留 6 位有效小数）。 */
    return Number(snapped.toFixed(6));
}

/* ---------------------------------------------------------------------------
 * 单行上妆（幂等）
 * ------------------------------------------------------------------------- */

/**
 * 取该行当前的数值：优先投影 widget.value，无效时回退官方 input 的显示值。
 *
 * ★ 为什么要回退（实测踩坑，勿删）：
 *   `widget.value` 走投影 getter 读官方 store。**首次上妆时**（attachA001Ports 阶段）
 *   store 可能尚未 register/hydrate → 读到 undefined → pctOf 得 NaN → 进度写成 0%
 *   （实测：input 明明显示 2.6，填充却停在 0%）。官方 input 的值由官方渲染链保证，
 *   作为兜底最可靠。
 */
function readRowValue(widget, host) {
    const v = Number(widget?.value);
    if (Number.isFinite(v)) return v;
    const raw = Number(readInputValue(host));
    return Number.isFinite(raw) ? raw : null;
}

/**
 * 把滑条的进度变量写到「轨道」上（range 与 thumb 都是 track 的子元素，
 * 故百分比以 track 宽度为基准，三者坐标系一致）。
 * track 尚未创建时退回写 host（首帧竞态的兜底）。
 */
function paintSlider(host, widget, range, value) {
    if (!host) return;
    const v = Number.isFinite(Number(value)) ? Number(value) : readRowValue(widget, host);
    if (v == null) return;
    const pct = pctOf(v, range) * 100;
    const target = host.querySelector(".xzg-a001-slider-track") || host;
    target.style.setProperty("--xzg-a001-slider-pct", pct + "%");
}

/**
 * 取「轨道」元素（进度换算的坐标系）。
 * ★ 必须用 track 而非 host：轨道右侧让出了数值框宽度，
 *   若用 host 宽度换算，点击/拖拽位置与实际填充会系统性偏移（实测确认）。
 */
function sliderTrackOf(host) {
    return host?.querySelector?.(".xzg-a001-slider-track") || null;
}

/** 读取官方 input 内的当前显示值（用于外部改值后的回填比对）。 */
function readInputValue(host) {
    const inp = host?.querySelector?.("input");
    return inp ? inp.value : null;
}

/**
 * 为一行控件上妆为滑条（幂等）。
 *
 * @param {object} widget 投影 widget
 * @param {HTMLElement} row 官方控件行（.lg-node-widget）
 * @returns {boolean} 是否成功接管
 */
function mountSliderRow(widget, row) {
    return safeCall(() => {
        if (!row) return false;
        const range = sliderRangeOf(widget);
        if (!range) return false;
        const input = row.querySelector("input");
        if (!input) return false;
        const host = findSliderHost(input);
        if (!host || host === row) return false;

        injectCss();

        /* 幂等：同范围已接管 → 只刷新进度，不重建子元素。 */
        const already = host.getAttribute(SLIDER_HOST_ATTR) === "1";
        const cached = already
            && Number(host.getAttribute(MIN_ATTR)) === range.min
            && Number(host.getAttribute(MAX_ATTR)) === range.max;
        if (cached) {
            paintSlider(host, widget, range, widget.value);
            watchInputValue(host, widget, range);
            mountSliderGear(host, widget);
            return true;
        }

        /* 记录范围（供拖拽闭包与后续比对）。 */
        host.setAttribute(SLIDER_HOST_ATTR, "1");
        host.setAttribute(MIN_ATTR, String(range.min));
        host.setAttribute(MAX_ATTR, String(range.max));
        host.setAttribute(STEP_ATTR, String(range.step));
        host.setAttribute(INT_ATTR, range.isInt ? "1" : "0");
        /* 禁用态（官方把 input 设为 readonly/disabled 时整体降透明）。 */
        host.setAttribute("data-a001-slider-disabled", input.disabled ? "1" : "");
        if (!input.disabled) host.removeAttribute("data-a001-slider-disabled");

        /* 自绘「轨道 / 填充段 / 滑块」（若尚未存在）。
         * 结构对齐 ComfyTV 的 SliderRoot 内三层：
         *   .xzg-a001-slider-track（轨道底）
         *     .xzg-a001-slider-range（紫色填充，宽度=进度）
         *   .xzg-a001-slider-thumb（圆滑块，中心=进度点） */
        if (!host.querySelector(".xzg-a001-slider-track")) {
            const track = document.createElement("div");
            track.className = "xzg-a001-slider-track";
            host.appendChild(track);
        }
        const trackEl = host.querySelector(".xzg-a001-slider-track");
        if (!trackEl.querySelector(".xzg-a001-slider-range")) {
            const rangeEl = document.createElement("div");
            rangeEl.className = "xzg-a001-slider-range";
            trackEl.appendChild(rangeEl);
        }
        if (!trackEl.querySelector(".xzg-a001-slider-thumb")) {
            const thumb = document.createElement("div");
            thumb.className = "xzg-a001-slider-thumb";
            trackEl.appendChild(thumb);
        }
        paintSlider(host, widget, range, widget.value);

        /* 数值框右侧「参数设置」齿轮（幂等）。 */
        mountSliderGear(host, widget);

        /* 绑拖拽（幂等：用标记位）。 */
        if (host._xzgA001SliderBound !== true) {
            host._xzgA001SliderBound = true;
            bindSliderDrag(host, widget);
        }
        /* 监听官方 input 变化 → 刷新进度：
         *   用户在数值框里直接输入、或用键盘微调时，官方会改 input.value，
         *   此时必须让填充/滑块跟上（否则只有数字变、滑条不动）。 */
        watchInputValue(host, widget, range);
        return true;
    }, false, "A001 滑条上妆");
}

/**
 * 监听官方数值框的变化与键盘事件，把进度刷新到最新值（幂等，每行一份）。
 *
 * ★ 为什么必须监听（实测必须）：
 *   本模块只负责「外观 + 拖拽」，数值的权威是官方 input。用户改 input 后，
 *   若我们不跟随，进度条会与数字脱节（例如数字 8、滑块停在 0%）。
 */
function watchInputValue(host, widget, range) {
    const input = host?.querySelector?.("input");
    if (!input || input._xzgA001SliderWatched) return;
    input._xzgA001SliderWatched = true;
    const sync = () => safeCall(() => {
        const v = Number(input.value);
        if (Number.isFinite(v)) {
            const r = {
                min: Number(host.getAttribute(MIN_ATTR)),
                max: Number(host.getAttribute(MAX_ATTR)),
            };
            paintSlider(host, widget, r, v);
        }
    }, undefined, "数值框变化刷新滑条进度");
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    input.addEventListener("blur", sync);
    host._xzgA001SliderInputSync = sync;
}

/* ---------------------------------------------------------------------------
 * 拖拽交互（复刻 ComfyTV：轨道按下 → 跟手 → 松手 commit）
 *
 * ★ 值写入走投影 widget 的 value setter（双通道：store + 源 widget）。
 * ★ 实时写值但**按帧节流**（rAF 合并），避免一次拖拽触发上百次 store 写入。
 * ★ 松手后再写一次并派发 change 事件（模拟官方输入提交语义：落盘 + 行高同步）。
 * ------------------------------------------------------------------------- */
function bindSliderDrag(host, widget) {
    let dragging = false;
    let pendingVal = null;

    /** 由指针坐标求数值。
     * ★ 用「轨道」的 rect（不是 host）：轨道右侧让出了数值框宽度，
     *   用 host 宽度会让拖到最右时数值到不了 max、且位置系统性偏右。 */
    const valueFromPointer = (clientX) => {
        const track = sliderTrackOf(host);
        const r = (track || host).getBoundingClientRect();
        if (!(r.width > 0)) return null;
        const range = {
            min: Number(host.getAttribute(MIN_ATTR)),
            max: Number(host.getAttribute(MAX_ATTR)),
            step: Number(host.getAttribute(STEP_ATTR)) || 0.01,
            isInt: host.getAttribute(INT_ATTR) === "1",
        };
        const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        return valueOfPct(pct, range);
    };

    /** 立即把数值写进投影 widget（驱动官方 UI + 内层节点）。 */
    const commitValue = (v, final) => {
        if (v == null) return;
        safeCall(() => {
            widget.value = v;
            /* 官方 input 同步显示（不触发其 change，避免重复回流）。 */
            const inp = host.querySelector("input");
            if (inp && String(inp.value) !== String(v)) inp.value = String(v);
            const range = {
                min: Number(host.getAttribute(MIN_ATTR)),
                max: Number(host.getAttribute(MAX_ATTR)),
            };
            paintSlider(host, widget, range, v);
        }, undefined, final ? "滑条松手写值" : "滑条拖拽写值");
        if (final) {
            /* 松手：派发官方 change，触发其落盘/行同步等既有链路。 */
            safeCall(() => {
                const inp = host.querySelector("input");
                if (inp) inp.dispatchEvent(new Event("change", { bubbles: true }));
            }, undefined, "滑条松手派发 change");
        }
    };

    const onMove = (ev) => {
        if (!dragging) return;
        const v = valueFromPointer(ev.clientX);
        if (v == null) return;
        pendingVal = v;
        /* ★ 同步写值（不再走 rAF）。
         *   血泪教训：rAF 在「后台标签 / 被节流 / 无渲染帧」时会被挂起，
         *   曾导致拖拽全程无任何写入（实测 inputVal 始终不变）；且松手时
         *   若取消待写帧还会把终值丢掉。拖拽事件的频率本就有限（浏览器
         *   对 pointermove 有合并），同步写足够轻，且绝对可靠。 */
        commitValue(v, false);
    };

    /** 结束拖拽：复位状态并摘掉 window 上的监听（幂等，返回本次是否真的在拖拽中）。
     *  ★ 供 pointerup / mouseup / pointercancel 三路共用 —— 原实现只监听前两者，
     *    指针被系统取消（触摸中断 / 切窗 / 指针捕获丢失）时不触发，dragging 永久卡 true
     *    且 window 监听常驻，该滑条此后无法再拖拽。 */
    const endDrag = () => {
        if (!dragging) return false;
        dragging = false;
        host.classList.remove("xzg-a001-slider-dragging");
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        return true;
    };

    const onUp = (ev) => {
        if (!endDrag()) return;
        safeCall(() => {
            if (ev && ev.clientX != null) {
                const v = valueFromPointer(ev.clientX);
                if (v != null) pendingVal = v;
            }
        }, undefined, "滑条松手取终值");
        const pv = pendingVal;
        pendingVal = null;
        commitValue(pv, true);
    };

    /** 指针被系统取消（触摸中断 / 切窗 / 指针捕获丢失）：只清理，不提交终值
     *  （没有可信的抬起坐标；拖拽过程中的实时写入已生效）。 */
    const onCancel = () => {
        if (!endDrag()) return;
        pendingVal = null;
    };

    const onDown = (ev) => {
        /* 去重：同一次按下可能先后收到 pointerdown 与 mousedown 两种事件，
         * 已在拖拽中则忽略后到者（避免重复初始化与重复写值）。 */
        if (dragging) return;
        /* 只响应主键；且不拦截落在 input 上的按下（让用户能正常编辑数值）。 */
        if (ev.button != null && ev.button !== 0) return;
        const tgt = ev.target;
        if (tgt && tgt.tagName === "INPUT") return;
        /* 齿轮按钮 / 设置面板内的交互一律不参与拖拽（否则点齿轮会顺带改值）。 */
        if (tgt && tgt.closest && tgt.closest(".xzg-a001-slider-gear, .xzg-a001-slider-panel")) return;
        /* ★ 监听器挂在 window 捕获阶段（见下方说明），故需自行判断「事件是否落在
         *   本滑条 host 内」。用 contains 判定，兼容 target 是 host 的任意后代。 */
        if (!tgt || !host.contains(tgt)) return;
        if (host.hasAttribute("data-a001-slider-disabled")) return;
        /* ★ 只在「轨道」的水平范围内才起拖拽（复刻 ComfyTV：数值框区不参与拖拽）。
         *  允许越出轨道上下边界（竖直容差），保证手感宽松、易于命中。 */
        const track = sliderTrackOf(host);
        if (track) {
            const tr = track.getBoundingClientRect();
            if (ev.clientX < tr.left - 6 || ev.clientX > tr.right + 6) return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        dragging = true;
        host.classList.add("xzg-a001-slider-dragging");
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onCancel, true);
        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", onUp, true);
        const v = valueFromPointer(ev.clientX);
        if (v != null) pendingVal = v;
        if (v != null) commitValue(v, false);
    };

    /* ★ 必须把按下事件挂在 **window 的捕获阶段**，且**同时监听 pointerdown 与 mousedown**。
     *   血泪教训（实测四段式结论）：
     *     ① 绑在 host「冒泡」阶段 → 收不到：官方内框在冒泡途中 stopPropagation；
     *     ② 绑在 host「捕获」阶段 → 仍收不到：官方在 host 与内框之间的祖先层捕获即截断；
     *     ③ 只绑 window 的 pointerdown 捕获 → 合成/部分鼠标序列下**只发 mousedown、不发
     *        pointerdown**（实测 win-cap 未触发、win-md 触发），拖拽全程无响应；
     *     ④ window 捕获 + pointerdown/mousedown 双监听 → 成功覆盖两种事件序列。
     *   onDown 内部用 host.contains(target) 过滤、并用 dragging 去重（同一次按下若
     *   先后收到 pointer 与 mouse 两种事件，第二次因 input 判定/dragging 已真而无害）。 */
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("mousedown", onDown, true);
    host._xzgA001SliderHandlers = { onDown, onMove, onUp, onCancel, endDrag };
}

/* ---------------------------------------------------------------------------
 * 对外入口
 * ------------------------------------------------------------------------- */

/**
 * refreshA001Sliders(node) —— 扫描该节点全部提升控件行，给符合判据的上滑条。
 * 幂等、可重复调用（供装配、恢复中枢、尺寸刷新等路径统一调用）。
 */
export function refreshA001Sliders(node) {
    if (!node) return 0;
    return safeCall(() => {
        const widgets = node.widgets || [];
        /* 逐行匹配：官方按 node.widgets 顺序渲染 .lg-node-widget。 */
        const root = node._a001DomRoot?.isConnected
            ? node._a001DomRoot
            : (node.id != null ? document.querySelector('[data-node-id="' + node.id + '"]') : null);
        if (!root) return 0;
        const rows = root.querySelectorAll(".lg-node-widget");
        let n = 0;
        for (let i = 0; i < widgets.length && i < rows.length; i++) {
            const w = widgets[i];
            /* ★ 首次提升：为「无范围」的数值控件写入并固化默认范围（1~10/步长1）。
             *   只在第一次生效，之后由 applyStoredRange 回填持久化记录。 */
            ensureInitialRange(node, w);
            /* 用户若经「参数设置」改过范围，先回填到 widget.options，
             * 再进判据/挂载 —— 保证刷新、重载工作流后自定义范围仍生效。 */
            applyStoredRange(node, w);
            if (!isA001SliderWidget(w)) continue;
            /* 先把 node 引用挂到该行 host 上（须在 mountSliderRow 之前：
             * 齿轮的 change 回调要用它做持久化与图变更通知）。 */
            const hostEl = rows[i].querySelector("input")
                ? findSliderHost(rows[i].querySelector("input"))
                : null;
            if (hostEl) hostEl._xzgA001SliderNode = node;
            if (mountSliderRow(w, rows[i])) n++;
        }
        return n;
    }, 0, "刷新 A001 滑条");
}

/**
 * detachA001Sliders(node) —— 卸载（节点删除时调用）。
 * 摘掉自绘元素、拖拽监听与标记；官方 DOM 原样恢复（我们只隐藏了 ± 与官方填充条，
 * 这些是 CSS 行为，移除 [data-a001-slider] 即自动恢复）。
 */
export function detachA001Sliders(node) {
    if (!node) return false;
    return !!safeCall(() => {
        const root = node._a001DomRoot?.isConnected
            ? node._a001DomRoot
            : (node.id != null ? document.querySelector('[data-node-id="' + node.id + '"]') : null);
        if (root) {
            const hosts = root.querySelectorAll("[" + SLIDER_HOST_ATTR + "]");
            for (const host of hosts) {
                const h = host._xzgA001SliderHandlers;
                if (h) {
                    safeCall(() => window.removeEventListener("pointerdown", h.onDown, true), undefined, "解绑滑条按下");
                    window.removeEventListener("mousedown", h.onDown, true);
                    window.removeEventListener("pointermove", h.onMove, true);
                    window.removeEventListener("pointerup", h.onUp, true);
                    window.removeEventListener("pointercancel", h.onCancel, true);
                    window.removeEventListener("mousemove", h.onMove, true);
                    window.removeEventListener("mouseup", h.onUp, true);
                    /* 拖拽进行中被卸载：显式收尾，避免 dragging 卡在 true。 */
                    safeCall(() => h.endDrag?.(), undefined, "卸载时收尾滑条拖拽");
                    host._xzgA001SliderHandlers = null;
                }
                host._xzgA001SliderBound = false;
                const inp = host.querySelector("input");
                if (inp && host._xzgA001SliderInputSync) {
                    safeCall(() => {
                        inp.removeEventListener("input", host._xzgA001SliderInputSync);
                        inp.removeEventListener("change", host._xzgA001SliderInputSync);
                        inp.removeEventListener("blur", host._xzgA001SliderInputSync);
                        inp._xzgA001SliderWatched = false;
                    }, undefined, "解绑数值框监听");
                    host._xzgA001SliderInputSync = null;
                }
                /* 整体移除自绘轨道（range 与 thumb 都在其内，一并回收）。 */
                safeCall(() => host.querySelector(".xzg-a001-slider-track")?.remove(), undefined, "移除滑条轨道");
                safeCall(() => host.querySelector(".xzg-a001-slider-range")?.remove(), undefined, "移除滑条填充");
                safeCall(() => host.querySelector(".xzg-a001-slider-thumb")?.remove(), undefined, "移除滑条滑块");
                /* 移除齿轮按钮与其面板。 */
                safeCall(() => host.querySelector(".xzg-a001-slider-gear")?.remove(), undefined, "移除滑条齿轮");
                safeCall(() => host._xzgA001SliderPanel?.box?.remove(), undefined, "移除滑条面板");
                disarmSliderAutoClose(host);
                host._xzgA001SliderRow = null;
                host._xzgA001SliderGear = null;
                host._xzgA001SliderPanel = null;
                host._xzgA001SliderNode = null;
                host.removeAttribute(SLIDER_HOST_ATTR);
                host.removeAttribute(MIN_ATTR);
                host.removeAttribute(MAX_ATTR);
                host.removeAttribute(STEP_ATTR);
                host.removeAttribute(INT_ATTR);
                host.removeAttribute("data-a001-slider-disabled");
                host.style.removeProperty("--xzg-a001-slider-pct");
            }
        }
        return true;
    }, false, "卸载 A001 滑条");
}

/* 控制台诊断入口（与 inspectA001PromptEditor 同一风格）：
 *   window.inspectA001Slider(node) 返回该节点的滑条上妆概况，便于排查。
 *   window.refreshA001Sliders(node) 手动触发一次上妆（诊断用）。 */
safeCall(() => {
    if (typeof globalThis === "undefined") return;
    globalThis.refreshA001Sliders = (node) => {
        const n = node || (typeof app !== "undefined" && app?.graph?._nodes?.find((x) => x?._a001Panel));
        return refreshA001Sliders(n);
    };
    globalThis.inspectA001Slider = (node) => {
        const n = node || (typeof app !== "undefined" && app?.graph?._nodes?.find((x) => x?._a001Panel));
        if (!n) return null;
        const widgets = n.widgets || [];
        const root = n._a001DomRoot?.isConnected
            ? n._a001DomRoot
            : (n.id != null ? document.querySelector('[data-node-id="' + n.id + '"]') : null);
        const rows = root ? root.querySelectorAll(".lg-node-widget") : [];
        return {
            nodeId: n.id,
            rows: rows.length,
            widgets: widgets.map((w, i) => ({
                i,
                name: w?.name,
                type: w?.type,
                isSlider: isA001SliderWidget(w),
                range: sliderRangeOf(w),
                hostMarked: !!(rows[i] && rows[i].querySelector("[" + SLIDER_HOST_ATTR + "]")),
            })),
            mounted: root ? root.querySelectorAll("[" + SLIDER_HOST_ATTR + "]").length : 0,
        };
    };
}, undefined, "挂载滑条诊断入口");

export default {
    refreshA001Sliders,
    detachA001Sliders,
};
