/* =============================================================================
 * A001_grid_anchor.js —— A001 控件网格锚点（连线对齐的前置阻塞点）
 * -----------------------------------------------------------------------------
 * 一、这个文件解决什么问题
 * -----------------------------------------------------------------------------
 * A001 为了让节点外观「干净」，用 installA001WidgetProjection 把全部原生控件
 * 投影成了外部接口（inputs 上的 widgetId），于是 node.widgets 在隐藏态下为空。
 *
 * 实测闭合的因果链（详见 docs/A001端口胶囊复刻调研.md 第二章补·1）：
 *
 *   node.widgets 为空（实测 widgetsCount = 0）
 *     → 前端框架判定「本节点没有控件可渲染」，不挂载 Vue 组件 NodeWidgets
 *     → 不生成 .lg-node-widgets 容器 → DOM 里没有 [data-widgets-grid-node-id] 宿主
 *     → 框架的 useVueElementTracking(nodeId, "widgets-grid") 注册不成功
 *     → store.syncNodeSlotLayoutsFromDOM 首行门槛（registry 必须已有该 nodeId）不过
 *     → slotLayouts 里永远没有 A001 的条目
 *     → getSlotPosition 退回「按 NODE_SLOT_HEIGHT 理论推算」
 *     → 连线端点与胶囊圆点错位
 *
 * 也就是说：**网格宿主不只影响控件，它是官方测量槽位布局的唯一入口**。
 * 没有它，任何端口胶囊都注定拉不上线。
 *
 * 二、做法（调研文档「方案 A2」）
 * -----------------------------------------------------------------------------
 * 往 A001 自己的投影白名单 _a001ExtraWidgets 里塞一个 type:"hidden" 的零尺寸
 * 锚点控件。它之所以能长期存活，靠的是 A001_SubgraphNode.js 里 installA001WidgetProjection
 * 定义的三条既有语义（本模块只利用，不修改）：
 *
 *   1. 投影 getter 会把 _a001ExtraWidgets 里的成员 **永远追加** 到返回数组，
 *      不受 _a001WidgetsHidden（隐藏开关）影响 → node.widgets 永不为空。
 *   2. 投影 setter 的重置条件是 v.filter(w => !w?._a001Projected)，
 *      锚点没有 _a001Projected 标记，所以不会被剔掉。
 *   3. 锚点 type 为 "hidden" 时，官方 DOMWidgetImpl.computeLayoutSize 有后门：
 *        if (this.type === 'hidden') return { minHeight:0, maxHeight:0, minWidth:0 }
 *      于是它进入网格后不占任何行高（0 尺寸轨道）。
 *
 * 三、绝对不要做的事（实测踩坑，血泪）
 * -----------------------------------------------------------------------------
 * ❌ **不要走 node.addDOMWidget()**。
 *    实测：在运行时补插一个 DOM 控件会立刻触发 Vue 全量重建，页面直接崩溃：
 *      TypeError: Cannot read properties of undefined (reading 'graph')
 *    这也是 A001_Appearance.js 头注里「本模块不用 addDOMWidget」的原因。
 *    A001 的投影层已接管 widgets 语义，只允许通过 _a001ExtraWidgets 白名单注入。
 *
 * 四、与 A000_Port.js 的关系
 * -----------------------------------------------------------------------------
 * js/A000/A000_Port.js 已复刻了 ComfyTV 的整套端口胶囊机制，A002/A003
 * 都在用，但 A001 用不了它：A000_Port.js 的 nudge 是去改 [data-widgets-grid-node-id]
 * 的 paddingBottom，而 A001 的端口区与网格宿主是**兄弟节点**，改 grid 的 padding
 * 不会改变节点自身 size，官方 watcher 不触发（详见调研文档 9.5）。
 * 所以 A001 必须走「注入锚点保住宿主 + CSS 净零高度脉冲触发重测」这条独立路线。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 模块级状态：锚点的全局唯一标记与幂等守卫
 * ------------------------------------------------------------------------- */
const ANCHOR_FLAG = "_xzgA001GridAnchor";     // 锚点控件的身份标记
const ANCHOR_NAME = "xzg_a001_grid_anchor";   // 锚点在 widgets 里的名字（调试用）

/* 记录本次会话已经处理过的节点，避免重复注入（WeakSet 随节点回收自动释放） */
const ATTACHED = new WeakSet();

/* ---------------------------------------------------------------------------
 * 构造零尺寸 hidden 锚点控件
 *
 * 这个对象刻意做得极简：只满足「是个合法 widget 对象」即可。
 * 它不需要 draw / computeSize / serializeValue 的真实行为，因为：
 *   - type:"hidden" 让官方按零尺寸布局；
 *   - 它的存在意义只有一条——让 node.widgets 数组非空，从而框架为 A001
 *     挂载 NodeWidgets 组件、生成 [data-widgets-grid-node-id] 宿主。
 * ------------------------------------------------------------------------- */
function createAnchorWidget(node) {
    const anchor = {
        /* 身份标记：本模块与 A001_SubgraphNode.js 的投影 setter 靠「有无 _a001Projected」
         * 区分归属，锚点不打这个标记，因此不会被 setter 误删。 */
        [ANCHOR_FLAG]: true,

        name: ANCHOR_NAME,
        type: "hidden",              // ← 官方后门：布局高度归零
        options: { hidden: true, serialize: false },

        /* value 用访问器而非数据属性：框架在部分路径会尝试写 widget.value，
         * 用「只读恒 0」的访问器可保证它永远不会被意外赋成别的值。 */
        get value() { return 0; },
        set value(_v) { /* 锚点无值，忽略 */ },

        /* 以下方法都是「占位实现」，保证框架调用时不抛错 */
        computeSize: () => [0, 0],
        computeLayoutSize: () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 }),
        draw: () => {},
        serializeValue: () => undefined,
        setValue: () => {},
        setSize: () => {},
        onRemove: () => {},
    };

    /* 挂回节点引用，便于 detach 时精确摘除 */
    Object.defineProperty(anchor, "_xzgA001GridAnchorOwner", {
        value: node,
        enumerable: false,
        configurable: true,
        writable: true,
    });

    return anchor;
}

/* ---------------------------------------------------------------------------
 * 兜底 CSS：为锚点所在的行「压平高度」
 *
 * 依赖官方 computeLayoutSize 的零尺寸后门是主路径；但不同 ComfyUI 前端版本对
 * hidden 控件的处理不完全一致（部分版本仍会分配一个最小行高）。这里用 CSS
 * 做第二道保险：把锚点本身以及它所在的那条 .lg-node-widget 轨道高度归零，
 * 保证它绝不会在面板里留下一条可见空隙。
 * ------------------------------------------------------------------------- */
import { injectStyleOnce } from "../A000/A000_DomStyle.js";

const ANCHOR_STYLE_ID = "xzg-a001-grid-anchor-style";

function injectAnchorCss() {
    injectStyleOnce(ANCHOR_STYLE_ID, `
/* 锚点本体：永不显示、不参与指针命中 */
.xzg-a001-grid-anchor{ display:none !important; }

/* 锚点所在的那条控件轨道：高度与间距归零（只针对含锚点的轨道，不波及其他控件） */
.lg-node .lg-node-widget:has(> .xzg-a001-grid-anchor),
.lg-node .lg-node-widget:has(.xzg-a001-grid-anchor),
[data-widgets-grid-node-id] > div:has(.xzg-a001-grid-anchor){
    height:0 !important;
    min-height:0 !important;
    max-height:0 !important;
    margin:0 !important;
    padding:0 !important;
    overflow:hidden !important;
}
`);
}

/* ---------------------------------------------------------------------------
 * attachA001GridAnchor(node) —— 为节点注入网格锚点（幂等）
 *
 * 幂等保证有两层：
 *   1. ATTACHED WeakSet：节点已处理过就直接返回，避免重复走一遍数组操作；
 *   2. 数组内容层：即使 WeakSet 因为某些原因被绕过，下面也会按身份标记去重。
 * ------------------------------------------------------------------------- */
export function attachA001GridAnchor(node, deps) {
    if (!node || node.id == null) return false;
    /* ★ 命中 ATTACHED 时仍做一次「数组内容自检」：节点对象被复用（撤销/重做）后
     *  _a001ExtraWidgets 可能已被投影 setter 替换成不含锚点的新数组，
     *  若直接 return 则锚点永久丢失 → node.widgets 为空 → 端口胶囊彻底失效且不自愈。 */
    if (ATTACHED.has(node)) {
        const ok = Array.isArray(node._a001ExtraWidgets)
            && node._a001ExtraWidgets.some((w) => w && w[ANCHOR_FLAG] === true);
        if (ok) return true;
        ATTACHED.delete(node);
    }

    const alog = deps?.alog || (() => {});
    const safeCall = deps?.safeCall || ((fn) => { try { return fn(); } catch (e) { return undefined; } });

    return !!safeCall(() => {
        /* 1. 确保白名单数组存在。
         *    注意：如果 installA001WidgetProjection 已经跑过，这里通常已有数组；
         *    若没有，就建一个空数组交给投影 getter/setter 接管。 */
        if (!Array.isArray(node._a001ExtraWidgets)) node._a001ExtraWidgets = [];

        /* 2. 去重检测：已经注入过就不再重复 */
        const has = node._a001ExtraWidgets.some(
            (w) => w && w[ANCHOR_FLAG] === true
        );
        if (!has) {
            node._a001ExtraWidgets.push(createAnchorWidget(node));
            alog("[A001_grid_anchor] 已注入网格锚点");
        }

        injectAnchorCss();

        /* 3. 给宿主节点打标记，供 CSS / 调试 / 胶囊模块判断「宿主已就绪」 */
        node._xzgA001AnchorOn = true;
        ATTACHED.add(node);

        /* 4. 给锚点对应的 DOM 补上类名（锚点渲染成元素后才有；用 rAF 等一帧） */
        scheduleAnchorDomTag(node, safeCall);

        return true;
    }, undefined, "注入网格锚点");
}

/* ---------------------------------------------------------------------------
 * scheduleAnchorDomTag —— 把 .xzg-a001-grid-anchor 类名打到锚点的 DOM 上
 *
 * 锚点控件被框架渲染后，会生成一个带 data-widget-name / 文本名 的元素。
 * 我们用 ANCHOR_NAME 与之匹配，打上类名，交给上面的兜底 CSS 压平。
 * 用 rAF 是因为 Vue 渲染是异步的，注入当帧 DOM 还不存在。
 * ------------------------------------------------------------------------- */
function scheduleAnchorDomTag(node, safeCall) {
    const tag = () => {
        safeCall(() => {
            const root = node._a001DomRoot
                || document.querySelector(`[data-node-id="${node.id}"]`)
                || document.querySelector(`.lg-node[data-node-id="${node.id}"]`);
            if (!root) return;
            const els = root.querySelectorAll(
                `[data-widget-name="${ANCHOR_NAME}"], .lg-node-widget`
            );
            for (const el of els) {
                const name = el.getAttribute?.("data-widget-name") || "";
                const text = el.textContent || "";
                if (name === ANCHOR_NAME || text.trim() === ANCHOR_NAME) {
                    el.classList.add("xzg-a001-grid-anchor");
                }
            }
        }, undefined, "标记锚点 DOM");
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(tag);
    else setTimeout(tag, 16);
}

/* ---------------------------------------------------------------------------
 * detachA001GridAnchor(node) —— 摘除锚点（节点删除 / 停用时调用）
 *
 * 只摘自己塞进去的那一个，不碰 A001 投影层产生的任何东西。
 * ------------------------------------------------------------------------- */
export function detachA001GridAnchor(node, deps) {
    if (!node) return false;
    /* ★ 先无条件从 ATTACHED 摘除：即便后续数组操作抛错，也不会把节点留在
     *  「已处理」集合里 —— 否则节点对象复用后 attach 会误判为已注入而永久丢失锚点。 */
    ATTACHED.delete(node);
    const safeCall = deps?.safeCall || ((fn) => { try { return fn(); } catch (e) { return undefined; } });

    return !!safeCall(() => {
        if (Array.isArray(node._a001ExtraWidgets)) {
            node._a001ExtraWidgets = node._a001ExtraWidgets.filter(
                (w) => !(w && w[ANCHOR_FLAG] === true)
            );
        }
        node._xzgA001AnchorOn = false;
        return true;
    }, undefined, "摘除网格锚点");
}

/* ---------------------------------------------------------------------------
 * inspectA001GridAnchor(node) —— 自检 / 诊断（命令行或控制台调用）
 *
 * 返回一个纯数据快照，方便判断链路走到哪一步断掉。字段含义：
 *   anchorInjected —— 白名单里有没有锚点
 *   widgetsCount   —— node.widgets.length（关键：必须 ≥ 1）
 *   gridHost       —— DOM 里有没有 [data-widgets-grid-node-id]（关键：必须为 true）
 * ------------------------------------------------------------------------- */
export function inspectA001GridAnchor(node) {
    const out = {
        nodeId: node?.id ?? null,
        anchorInjected: false,
        widgetsCount: null,
        gridHost: false,
        gridHostCount: 0,
    };
    if (!node) return out;

    try {
        if (Array.isArray(node._a001ExtraWidgets)) {
            out.anchorInjected = node._a001ExtraWidgets.some(
                (w) => w && w[ANCHOR_FLAG] === true
            );
        }
        if (Array.isArray(node.widgets)) out.widgetsCount = node.widgets.length;

        const root = node._a001DomRoot
            || document.querySelector(`[data-node-id="${node.id}"]`)
            || document.querySelector(`.lg-node[data-node-id="${node.id}"]`);
        if (root) {
            const hosts = root.querySelectorAll("[data-widgets-grid-node-id]");
            out.gridHostCount = hosts.length;
            out.gridHost = hosts.length > 0;
        }
    } catch (e) {
        out.error = String(e && e.message ? e.message : e);
    }
    return out;
}

export default {
    attachA001GridAnchor,
    detachA001GridAnchor,
    inspectA001GridAnchor,
};
