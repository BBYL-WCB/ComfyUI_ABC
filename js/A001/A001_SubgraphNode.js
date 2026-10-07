// ═══════════════════════════════════════════════════════════════
//  A001_子图节点 · 空壳子图容器
//  · 子图创建/恢复、子图数据序列化
//  · 以 isSubgraphNode() 声明子图身份，由 ComfyUI 原生渲染「进入子图」入口
//
//  官方能力引用约定（不重造，能引用即引用）：
//  · LGraph.createSubgraph(def)  —— 官方原生子图工厂，返回 Subgraph 实例
//  · Subgraph.asSerialisable()   —— 官方原生导出，返回 ExportedSubgraph
//  · Subgraph.configure(def)     —— 官方原生二次恢复（灌入 nodes/links/groups）
//  · Subgraph.clear()            —— 官方原生清空
//  · LGraphNode.prototype.isSubgraphNode() —— 官方子图身份契约，原生据此渲染入口
//  说明：本节点是普通 LGraphNode（非官方 SubgraphNode 类），故只能"持有子图即
//        声明为子图节点"；官方 SubgraphNode 恒 true、LGraphNode 基类恒 false。
//  ═══════════════════════════════════════════════════════════════
import { app } from "../../../scripts/app.js";
import {
    ensureA001Panel,
    repositionA001Panel,
    disposeA001Panel,
    initAppearanceDeps,
    refreshA001RunButton,
    resyncA001SizeLock,
} from "./A001_Appearance.js?v=20261007a";
import {
    attachA001Preview,
    detachA001Preview,
    disposeA001Preview,
    installA001PreviewRefresh,
    refreshA001Preview,
} from "./A001_preview.js?v=20261007a";
import {
    attachExecutionHooks,
    collectEmbeddedSubgraphDefs,
    restoreEmbeddedSubgraphDefs,
} from "./A001_exec.js?v=20261007a";
import {
    attachA001Run,
    detachA001Run,
    initRunDeps,
    installA001RunHooks,
    queryA001RunState,
    runA001Node,
} from "./A001_run.js?v=20261007a";
/* 记录 / 还原按键解绑：节点删除时摘掉 click 监听（绑定侧在 A001_Appearance.js，
 * 通过 A001_workflow.js 的 attachA001WorkflowButtons 完成）。
 * ★ 注意：A001_workflow.js 反向 import 本模块的 ensureSubgraph / detachSlotSync，
 *   二者形成 ESM 循环；因双方都只在「函数体内」使用对方导出（无顶层立即求值），
 *   循环可正常解析，不影响模块初始化。 */
import { unbindA001WorkflowButtons } from "./A001_workflow.js?v=20261007a";
/* 端口胶囊（复刻 008_ComfyTV「视频阶段」等节点的端口外观与交互）
 * 及其**前置依赖**「控件网格锚点」。
 * 两者都不 import 其它 A001 模块（不构成循环依赖），只导出函数，可安全静态引入。
 * ★ 装配顺序不可颠倒：先锚点（保住宿主 [data-widgets-grid-node-id]），
 *   再胶囊（换皮上妆）；宿主没起来时胶囊会静默不上妆，避免做出错位外观。 */
import { attachA001GridAnchor, detachA001GridAnchor } from "./A001_grid_anchor.js?v=20261007a";
import {
    attachA001PortCapsule,
    detachA001PortCapsule,
    refreshA001PortCapsule,
    nudgeA001PortCapsule,
    suppressA001CapsuleOpen,
} from "./A001_port_capsule.js?v=20261007a";
/* 提升文本框控件 · 右下角拖拽手柄（复刻 008_ComfyTV Custom Stage 的
 * resize:vertical + ::-webkit-resizer 观感）。作用于官方 <textarea>，
 * 不 import 其它 A001 模块，可安全静态引入。 */
import {
    attachA001TextareaResize,
    detachA001TextareaResize,
    scanA001Textarea,
} from "./A001_textarea_resize.js?v=20261007a";
/* ★ @文本编辑器（复刻 002_MiniMaxH3_Easy参考 的 prompt 富文本编辑器 + @媒体引用）。
 *  挂在「提升上来的多行文本控件」位置：定位官方控件行 → 隐藏其 textarea →
 *  原位插入自研 contenteditable 编辑器（**不走 addDOMWidget**，见该模块头注）。
 *  本模块只静态 import 其对外入口；其所需的本模块私有能力经 initPromptDeps 注入。
 *  ★ 依赖 URL 带版本查询串：浏览器对 ES module 按 URL 做内存缓存，且 ComfyUI 的
 *    /extensions 加载不带 cache-busting；不带版本号时改动子模块后刷新页面仍可能
 *    命中旧模块。带上版本号可强制浏览器重新拉取本文件及其依赖图。
 *    （版本号按需递增即可，仅影响缓存判据，不影响功能。） */
import {
    initPromptDeps,
    attachA001PromptEditor,
    refreshA001PromptEditors,
    flushA001PromptEditors,
    detachA001PromptEditor,
    detachA001PromptEditorSlot,
    inspectA001PromptEditor,
} from "./A001_prompt_editor.js?v=20261007a";
/* 反提升时清理该槽的 doc 存档（属于编辑器数据层，单独从 core 取用，
 * 避免为一个纯数据操作再额外包一层编辑器模块的转发）。 */
import { a001DropPromptRecord } from "./A001_prompt_core.js?v=20261007a";
/* ★ 媒体源变化监听：给 LoadImage/LoadVideo/LoadAudio 装上「素材变了」回调，
 *  用于在上游换图后刷新编辑器里 @ 引用的缩略图（详见该模块同名函数注释）。 */
import { a001InstallMediaSourceWatch } from "./A001_prompt_mentions.js?v=20261007a";
/* ★ 连接线中点数字徽标：在 A001 媒体连线的中点画「@引用序号」圆点，
 *  颜色按媒体类型区分（图片蓝 / 视频蓝 / 音频青绿），与编辑器 @ 引用一一对应。
 *  详见 A001_link_badge.js 顶部说明。 */
import { installA001LinkBadges } from "./A001_link_badge.js?v=20261007a";
/* ★ 提升数值控件 · 滑条（复刻 008_ComfyTV 的 ComfyTVSlider）：
 *  给「提升上来的 INT/FLOAT 控件（带 min/max 且跨度≤4096）」换上「轨道 + 紫色填充 +
 *  圆形滑块 + 右侧数值框」的外观，并绑拖拽交互。判据与交互均逐项对齐 ComfyTV。
 *  本模块只改造官方控件行的外观与拖拽，**不用 addDOMWidget、不替换官方 input**
 *  （原因见 A001_slider.js 头注的血泪前提）。 */
import {
    refreshA001Sliders,
    detachA001Sliders,
} from "./A001_slider.js?v=20261007a";
/* 统一恢复中枢（本轮一体化改造新增）：
 * 把「端口胶囊 / 连接线端点 / 文本框 / 预览面板 / 高度模型 / 收起标记」六项恢复
 * 收口到一处 —— 单一观察器 + 单一 rAF 调度 + 分层恢复。
 * 本模块只在此处静态 import（它处于依赖图底层，不反向依赖任何 A001 私有模块）。 */
import {
    initA001Restore,
    registerA001Node,
    unregisterA001Node,
    requestA001Restore,
} from "./A001_restore.js?v=20261007a";
/* ★ 原生子图伪装（开关版）：保存时把「加载开关」已打开的 A001 序列化成
 * 顶层 definitions.subgraphs + type=UUID 形态，使 Custom Stage 等外部工具能像识别
 * 自带子图一样「完全展开、识别内层所有节点」；加载时再据 properties['Node name for S&R']
 * 还原回 A001。仅在序列化产物上改写，不触碰活节点，A001 画布功能零损失。
 * ★ 功能做成「开关型」：见 A001_disguise.js 头部说明。
 * ★ 整个功能集中在 A001_disguise.js，移除该功能时删本 import + setup 里的 install +
 *   beforeConfigureGraph 钩子 + initAppearanceDeps 里的两项注入即可。 */
import {
    installA001Disguise,
    onBeforeConfigureGraph,
    isA001ComfyTVEnabled,
    toggleA001ComfyTVEnabled,
    scheduleA001ComfyTVSwitchSync,
} from "./A001_disguise.js?v=20261007a";
/* ★ 共享工具与常量（2026-10-07 起统一从 A001_shared.js 取；原独立的
 *  A001_SubgraphNode_shared.js 因与本文件重复 9 个符号且造成 getNodeGraph
 *  同名两义，已并入 A001_shared.js 并删除）。
 *  对外仍由本模块 re-export，保证既有 `from "./A001_SubgraphNode.js?v=20261007a"` 调用方无需改动。
 *  改动过的模块须同步递增 ?v=，否则浏览器 ES module 缓存会继续用旧模块。 */
import {
    NODE_TYPE,
    A001_TAG as TAG,
    SG_INPUT_NODE_ID,
    SG_OUTPUT_NODE_ID,
    isConstId,
    alog,
    safeCall,
    dirtyCanvas,
    uuidv4,
    /* 静默版：与 A001_shared 的带日志版 getNodeGraph 并存，逐字保留本文件原行为。 */
    getNodeGraphSilent as getNodeGraph,
    isNodeInGraphSilent as isNodeInGraph,
    buildA001SourceRef,
    getSgNodes,
    A001_PROMOTED_SIZE_EPS,
    A001_DEFAULT_WIDTH,
    A001_HIDDEN_PROP,
    A001_DEFAULT_COLLAPSED,
} from "./A001_shared.js?v=20261007a";

/* re-export：保持对外 API 不变（NODE_TYPE 与 UUID 工具被外部模块引用）。 */
export { NODE_TYPE, TAG, uuidv4, alog, safeCall, dirtyCanvas, getNodeGraph, isNodeInGraph };

/** 取 widgetValueStore（Pinia）。ComfyUI 把它挂在 window.comfyAPI 上，
 * 但不同版本命名不一，这里按优先级逐个探测，全部失败则返回 null（调用方降级）。
 *
 * ★ 实测补充：window.comfyAPI 上已【不再】直接暴露
 * widgetValueStore（comfyAPI.widgetValueStore === undefined），官方把该 store
 * 实例化后注册进 Vue app 的 Pinia 容器，注册名为 "widgetValue"，
 * 取法：document.querySelector("#vue-app").__vue_app__.config.globalProperties
 *       .$pinia._s.get("widgetValue")
 * （Pinia 内部 Map _s 以注册名为键存所有 store 实例；该实例具备
 *   registerWidget / getWidget / setValue / deleteWidget / getNodeWidgets /
 *   clearGraph 全套方法，与旧 comfyAPI.widgetValueStore.useWidgetValueStore()
 *   返回的是同一个 store。）因此探测链在旧路径全部落空后，补一条 Pinia 直取。 */
/* ★ 探测结果缓存（性能优化）：本函数被 widgets getter 每条投影槽调用一次，
 * 属 Vue 渲染热路径；而本机前端前 3 条候选恒落空，每次都必然走到第 4 条
 * document.querySelector("#vue-app") 全文档查询。命中后固化，避免重复查询。
 *
 * ⚠️ 只缓存「命中」不缓存「null」：页面启动早期 Vue 尚未挂载时返回 null 是
 * 合法降级（调用方据此走无 store 分支），若把 null 也永久缓存，则首次调用
 * 之后永远取不到 store，回流功能整体失效 —— 这是本缓存唯一的坑。 */
let A001_STORE_CACHE = null;

function a001WidgetValueStore() {
    /* 缓存有效性校验：store 被 Pinia 销毁/替换后 registerWidget 会消失，需重新探测。 */
    if (A001_STORE_CACHE && typeof A001_STORE_CACHE.registerWidget === "function") {
        return A001_STORE_CACHE;
    }
    A001_STORE_CACHE = null;
    const api = typeof window !== "undefined" ? window.comfyAPI : null;
    const cands = [
        () => api?.widgetValueStore?.useWidgetValueStore?.(),
        () => api?.widgetValue?.useWidgetValueStore?.(),
        () => api?.stores?.useWidgetValueStore?.(),
        /* 新版前端：store 实例注册在 Pinia 容器里（注册名 "widgetValue"）。 */
        () => document?.querySelector?.("#vue-app")?.__vue_app__
            ?.config?.globalProperties?.$pinia?._s?.get("widgetValue"),
    ];
    for (const f of cands) {
        const s = safeCall(f, null, "取 widgetValueStore");
        if (s && typeof s.registerWidget === "function") {
            A001_STORE_CACHE = s;
            return s;
        }
    }
    return null;
}

/** ★ 已挂回流监听的 store 实例集合（WeakSet 去重，避免重复注册 $onAction）。 */
const A001_REFLOW_BOUND_STORES = new WeakSet();

/**
 * ★★ 回流反查表：widgetId → { node, input }（性能优化）。
 *
 * 【为什么需要】原实现每次 setValue 都遍历全图 `graph._nodes` × 每节点 `inputs`
 * 做 O(节点数×槽数) 扫描。而 setValue 由官方 UI 的**每次打字 / 每次拖动滑条**触发
 * （官方 Vue 控件输入即写 store），是最高频的回调之一：50 节点 × 5 槽的工作流，
 * 每次按键就是 250 次比较，连续拖滑条可达每秒上万次。
 *
 * 【生命周期】在 bindOfficialPromotedWidget 登记、unbindOfficialPromotedWidget /
 * demote / reconcile 去重分支注销；节点删除时由 releaseA001NodeReflow 按节点批量清理，
 * 避免表随节点增删无限增长（否则这里就成了新的泄漏点）。
 */
const A001_REFLOW_INDEX = new Map();

/** 登记一条回流反查（幂等）。 */
function registerA001ReflowTarget(id, node, input) {
    if (!id) return;
    A001_REFLOW_INDEX.set(id, { node, input });
}

/** 注销一条回流反查。 */
function unregisterA001ReflowTarget(id) {
    if (id) A001_REFLOW_INDEX.delete(id);
}

/** ★ 节点删除时按节点批量清理回流反查（防止 Map 随节点增删累积）。 */
function releaseA001NodeReflow(node) {
    if (!node) return;
    for (const [id, entry] of A001_REFLOW_INDEX) {
        if (entry?.node === node) A001_REFLOW_INDEX.delete(id);
    }
}

/**
 * ★★★ 官方 store → 内层源控件的回流桥（2026-09-23 新增，修复「节点外文字传不进节点内部」）。
 *
 * 【为什么必须加这一层】（浏览器实测钉死，见 docs 第 18 章）
 *   投影描述符的 set value / callback 在 store 存在时【只】调 store.setValue() 就 return，
 *   原以为「store 会替我们回流」，但实测证明不成立：
 *     ① 直调 state.callback(v)      → 源控件立即回流 ✅
 *     ② store.setValue(id, v)       → 源控件纹丝不动 ❌（state.callback 调用次数 = 0）
 *     ③ 真实键盘输入（模拟 textarea input 事件）→ store 更新、callback 次数 = 0 ❌
 *   即：**官方 Vue 组件输入时只写 store，从不调用我们挂在 state 上的 callback**。
 *   而 store 存在（上一轮修好探测链）之后，投影 setter 的 fallback 直写 src 分支又不再执行，
 *   两条路都断 → 外层文字传不到内层。（store 为 null 时反而能传，故此前未暴露。）
 *   另实测：_a001SourceWidget.callback 恒为 undefined，故唯一生效路径就是 src.value = v。
 *
 * 【方案】用官方 Pinia 能力 store.$onAction 订阅 setValue（实测能拿到完整 [id, value] 参数），
 *   按 widgetId 查 A001_REFLOW_INDEX 反查本模块登记的宿主槽，写入其 _a001SourceWidget.value。
 *   - 只对「本模块登记过」的 id 生效（表内不含其他节点的 id），不干扰其他节点。
 *   - 值相等短路，避免与投影 setter 的直写互相触发形成循环。
 *   - 监听挂在 store 实例上、幂等注册（WeakSet 去重）。
 *
 * @param {object} store a001WidgetValueStore() 返回的 store 实例
 * @returns {boolean} 是否挂载（或此前已挂载）
 */
function bindA001StoreReflow(store) {
    if (!store || typeof store.$onAction !== "function") return false;
    if (A001_REFLOW_BOUND_STORES.has(store)) return true;
    A001_REFLOW_BOUND_STORES.add(store);
    safeCall(() => {
        store.$onAction((ctx) => {
            if (ctx?.name !== "setValue") return;
            /* ★ 零成本短路：反查表为空说明当前无任何提升控件，
             *  非 A001 节点（原生节点）每次 setValue 都进本回调也无谓消耗，直接返回。 */
            if (A001_REFLOW_INDEX.size === 0) return;
            const [id, value] = ctx.args || [];
            if (typeof id !== "string") return;
            /* 反查宿主槽：仅处理本模块登记的提升控件（表内条目）。 */
            const entry = A001_REFLOW_INDEX.get(id);
            if (!entry) return;
            const inp = entry.input;
            const src = inp?._a001SourceWidget;
            if (!src) return;
            /* 值相等短路：防止「投影写 store → 监听写 src → 又回流」的循环。 */
            if (src.value === value) return;
            safeCall(() => { src.value = value; }, undefined, "回流写内层源控件");
            safeCall(() => src.callback?.(value, entry.node), undefined, "回流触发源 callback");
        });
    }, undefined, "注册 store $onAction 回流监听");
    return true;
}

/* ════════════════════════════════════════════════
 *  · 提升控件 widgetId（对齐原生 [graphId]:[nodeId]:[name]）
 *  ════════════════════════════════════════════════ */

/**
 * 生成提升控件 widgetId（对齐原生 widgetId(graphId, nodeId, name)：
 * 三段以 ':' 连接，后两段 encodeURIComponent。graphId 缺失时逐级回退，
 * 保证第一段非空：原生 widgetValueStore 以 [graphId]:[nodeId]:[name] 为键，
 * 空 graphId 会产生不可用键。
 */
function a001WidgetId(graphId, nodeId, name) {
    const gid = graphId ?? nodeId ?? "";
    return [gid, encodeURIComponent(String(nodeId)), encodeURIComponent(name)].join(":");
}

/** 取节点 widgetId 的 graphId 段（对齐原生 getWidgetId 的取法）。 */
function a001HostGraphId(node) {
    return node?.graph?.id ?? node?.rootGraph?.id ?? null;
}

/* 注：原 parseA001WidgetId（a001WidgetId 的逆函数）已删除——全模块零调用。
 * 若将来需要解析 widgetId，按 [graphId]:[nodeId]:[name] 三段 split(":") + decodeURIComponent。 */

/* ════════════════════════════════════════════════
 *  · 提升端口持久化（properties.promoted_widgets_json）
 *  ════════════════════════════════════════════════ */

/** 读取持久化的提升端口映射（按外层端口名索引）。 */
function readPromotedPersist(node) {
    const out = new Map();
    const parseTo = (raw) => {
        if (typeof raw !== "string" || !raw.length) return;
        const arr = safeCall(() => JSON.parse(raw), null, "promoted_widgets_json 解析");
        if (!Array.isArray(arr)) return;
        for (const it of arr) {
            if (!it || it.name == null || it.nodeId == null || it.widgetName == null) continue;
            out.set(String(it.name), { nodeId: it.nodeId, widgetName: String(it.widgetName) });
        }
    };
    parseTo(node.properties?.promoted_widgets_json);
    parseTo(node._a001PromotedJson); // 兼容旧字段
    return out;
}

/** 写入持久化的提升端口映射（对已提升外层端口做 up-sert；无提升端口时清除字段）。
 * ★ 判定「是提升槽」的依据有三，任一命中即记录：
 *   _a001Source            —— 提升实例的源映射（nodeId + widgetName）
 *   _a001OfficialWidgetId  —— 官方 widget 化标记（bindOfficialPromotedWidget 写入）
 *   widgetId               —— 官方 socketless 载体（对齐官方节点行为）
 * 提升槽始终保留在 node.inputs 中（对齐官方：带控件槽不删端口），故此处遍历 inputs 即可。 */
function writePromotedPersist(node) {
    if (!node) return;
    node.properties = node.properties || {};
    const arr = [];
    for (const inp of node.inputs || []) {
        if (!inp) continue;
        const src = inp._a001Source;
        const isPromoted = src?.nodeId != null || inp._a001OfficialWidgetId != null || inp.widgetId != null;
        if (!isPromoted) continue;
        let nodeId = src?.nodeId;
        let widgetName = src?.widgetName;
        // 无源映射时用槽名兜底（widgetId 形如 <graphId>:<nodeId>:<name>）
        if (widgetName == null && inp.widgetId != null) {
            const parts = String(inp.widgetId).split(":");
            if (parts.length >= 3) widgetName = parts[parts.length - 1];
        }
        if (widgetName == null) widgetName = inp.name;
        if (nodeId == null || widgetName == null) continue;
        arr.push({ name: inp.name, nodeId, widgetName: String(widgetName) });
    }
    if (arr.length) node.properties.promoted_widgets_json = JSON.stringify(arr);
    else delete node.properties.promoted_widgets_json;
}

/** 生成不与现有名冲突的唯一名（对齐原生 nextUniqueName：Append_N、Append_1、Append_2…）。 */
function a001UniqueName(base, existingNames) {
    const names = new Set(existingNames);
    if (!names.has(base)) return base;
    let i = 1;
    while (names.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
}

/* ══════════════════════════════════════════════
 *  1 · 子图定义
 *  ══════════════════════════════════════════════ */

/**
 * 构造空子图定义。
 * 字段结构对齐官方 ExportedSubgraph（参见 ComfyUI/blueprints/*.json），
 * 交给官方 LGraph.createSubgraph(def) 解析，不自造结构。
 * 节点自身不预设任何插槽（输入/输出均为空），进入子图后由用户自行添加槽位。
 */
function buildSubgraphData(name) {
    return {
        id: uuidv4(),
        version: 1,
        state: { lastGroupId: 0, lastNodeId: 0, lastLinkId: 0, lastRerouteId: 0 },
        revision: 0,
        config: {},
        name,
        inputNode: { id: SG_INPUT_NODE_ID, bounding: [0, 0, 120, 60] },
        outputNode: { id: SG_OUTPUT_NODE_ID, bounding: [400, 0, 120, 60] },
        inputs: [],
        outputs: [],
        widgets: [],
        nodes: [],
        groups: [],
        links: [],
        extra: { workflowRendererVersion: "LG" },
        description: "容器节点的内部子图空间",
    };
}

/**
 * 读取节点保存的子图数据。
 * 注意：properties.subgraph_data_json 是本项目私有约定，非官方字段
 * （官方子图存于工作流顶层 definitions.subgraphs[]，由节点 type 的 UUID 引用）。
 * 本节点无法改写自身 type，故走 properties 通道；内容仍是官方
 * ExportedSubgraph 结构，由官方 createSubgraph(def) 解析。
 */
function readSavedSubgraphData(node) {
    const rawJson = node.properties?.subgraph_data_json;
    if (typeof rawJson === "string" && rawJson.length > 0) {
        const parsed = safeCall(() => JSON.parse(rawJson), null, "subgraph_data_json 解析");
        if (parsed && parsed.nodes) {
            return { data: parsed, channel: "subgraph_data_json" };
        }
    }
    return null;
}

/* ★★ 插槽同步簇已拆分至 A001_slots.js（本轮拆分，仅搬迁零逻辑改动）。
 *  包含：外层端口 ⇄ 子图槽对齐（同步/查找/链接解析）、子图插槽事件监听装配、
 *  提升控件的即时绑定。此处仅 re-export 对外入口，并注入提升簇回调以避开循环依赖。 */
import {
    initSlotDeps,
    syncSlotsInitial,
    attachSlotSync,
    detachSlotSync,
    /* 槽查找 / 链接解析（原为本文件私有，随簇一并迁出；提升簇仍需调用）。 */
    findOuterSlotBySubgraphSlotId as _findOuterSlotBySubgraphSlotId,
    findSgSlotById as _findSgSlotById,
    markOuterInputAsWidget as _markOuterInputAsWidget,
    resolveSgLink as _resolveSgLink,
    collectSgLinkIds as _collectSgLinkIds,
    sgInputSlotCarriesWidget as _sgInputSlotCarriesWidget,
} from "./A001_slots.js?v=20261007a";

/* re-export：保持对外 API 不变（ensureSubgraph 与提升簇内部仍按原名调用）。 */
export { attachSlotSync, detachSlotSync, syncSlotsInitial };
/* ════════════════════════════════════════════════
 *  2 · 提升控件/端口子系统（widget/端口提升到外层）
 *  设计：A001 子图是「活对象」，内层真实节点 widget 的 .value 就是真值。
 *  提升 = 在外层 input 槽挂一个与内层源 widget 双向绑定的 host widget；
 *  渲染交给 Vue 原生控件网格，官方 widgetValueStore / 投影层负责行存在与实时刷新。
 *  widgetId 格式对齐原生：[graphId]:[nodeId]:[name]（name/nodeId encodeURIComponent）。
 *  ════════════════════════════════════════════════ */

/** 取子图内某节点的输入槽 —— 兼容 node.getSlotFromWidget 或自实现的 findIndex 兜底。 */
function innerSlotForWidget(sourceNode, sourceWidget) {
    if (!sourceNode || !sourceWidget) return undefined;
    const native = sourceNode.getSlotFromWidget?.(sourceWidget);
    if (native) return native;
    const inputs = sourceNode.inputs || [];
    const slot = inputs.find(
        (inp) =>
            inp.name === sourceWidget.name ||
            inp.widget?.name === sourceWidget.name ||
            (inp.widget?.widgetId && sourceWidget.widgetId && inp.widget.widgetId === sourceWidget.widgetId)
    );
    if (!slot) return undefined;
    try {
        const w = slot.widget;
        if (!w || typeof w !== "object") slot.widget = { name: sourceWidget.name };
        else if (w.name == null) w.name = sourceWidget.name;
    } catch (_e) { /* 只读槽位，忽略 */ }
    return slot;
}

/** 读取源 widget 的可选值列表（下拉/COMBO）。 */
function collectA001WidgetChoices(sourceWidget) {
    const opts = sourceWidget?.options || {};
    const vals = opts.values ?? opts.options ?? opts.items;
    if (Array.isArray(vals)) return vals;
    if (typeof opts.values === "function") {
        return safeCall(() => opts.values(sourceWidget), [], "host 取候选值");
    }
    return null;
}

/**
 * 生成一个「投影到外层 input 槽」的 host widget 描述符，与内层源 widget.value 双向绑定。
 * 纯 JS 节点（A001）在 Nodes 2.0 下由 Vue 以 DOM 渲染节点，host widget 只作
 * 「值代理 + widgetId 绑定锚点」，实际 UI 由官方 widget 网格渲染。
 */
function createPromotedHostWidget(sourceWidget, hostNode) {
    if (!sourceWidget) return undefined;
    const host = {};
    const getVal = () => sourceWidget.value;
    const setVal = (v) => {
        if (sourceWidget.value === v) return;
        sourceWidget.value = v;
        safeCall(() => sourceWidget.callback?.(v, hostNode), undefined, "host 源 widget callback");
    };
    Object.defineProperties(host, {
        name: { get: () => sourceWidget.name, set: (v) => { sourceWidget.name = v; }, enumerable: true },
        label: {
            get() { return sourceWidget.label ?? sourceWidget.name; },
            set(v) { sourceWidget.label = v; },
            enumerable: true,
        },
        type: { get: () => sourceWidget.type, enumerable: true },
        y: { get: () => 0, set(_v) { /* DOM 渲染，y 无意义 */ }, enumerable: true },
        value: { get: getVal, set: setVal, enumerable: true },
        options: { get: () => sourceWidget.options, enumerable: true },
    });
    host._a001SourceWidget = sourceWidget;
    host.nodeForCallback = hostNode;
    if (sourceWidget.widgetId) {
        Object.defineProperty(host, "widgetId", {
            value: sourceWidget.widgetId,
            enumerable: false,
            configurable: true,
        });
    }
    host.serializeValue = () => undefined;
    host.serialize = false;
    return host;
}

/**
 * 把源 widget 类型归一化为 ComfyUI 前端控件注册表的规范键。
 * Vue 的 computeProcessedWidgets 以 widget.type 查注册表，命中才会渲染「官方外观」
 * 控件；查不到则回退 WidgetDOM/WidgetLegacy。规范键见 frontend getWidgetTypeRegistry：
 * textarea 组件的 aliases 为 ["TEXTAREA","multiline","customtext"]，即多行文本必须
 * 映射为 "customtext" 才会命中官方 TextareaWidget。
 */
function a001NativeWidgetType(sourceWidget) {
    if (!sourceWidget) return "string";
    const raw = String(sourceWidget.type ?? "").toLowerCase();
    const choices = collectA001WidgetChoices(sourceWidget);
    if (Array.isArray(choices) && choices.length) return "combo";
    if (raw.includes("bool") || raw === "toggle") return "boolean";
    if (isA001MultilineWidget(sourceWidget, raw)) return "customtext";
    if (raw === "int" || raw.includes("int")) return "int";
    if (raw === "float" || raw.includes("float") || raw.includes("number") || raw.includes("slider")) return "float";
    if (raw.includes("textarea") || raw.includes("multiline")) return "customtext";
    if (raw.includes("combo") || raw.includes("select")) return "combo";
    if (raw.includes("color")) return "color";
    if (raw.includes("string") || raw.includes("text")) return "string";
    return "string";
}

/**
 * 判定源 widget 是否为「多行文本」。
 * 优先级：0) 实际渲染元素是 <textarea>（事实依据）；
 * 1) type 含 textarea/multiline/customtext；2) options.multiline 为真值；
 * 3) options.dynamicPrompts 为真值。
 */
function isA001MultilineWidget(sourceWidget, rawLower) {
    if (!sourceWidget) return false;
    const el = sourceWidget.inputEl || sourceWidget.element;
    if (el && String(el.tagName || "").toUpperCase() === "TEXTAREA") return true;
    const raw = rawLower ?? String(sourceWidget?.type ?? "").toLowerCase();
    if (raw.includes("textarea") || raw.includes("multiline") || raw === "customtext") return true;
    const opts = sourceWidget?.options || {};
    const multi = opts.multiline;
    if (multi === true || multi === 1 || multi === "true" || multi === "1") return true;
    if (opts.dynamicPrompts === true) return true;
    return false;
}

/**
 * 提升/反提升控件后重算一次节点尺寸。
 * 一次性（不进周期轮询）：量 DOM 高度再 setSize 在 flex 网格上是闭环自反馈会振荡；
 * 改用官方 computeSize（内容固有高度一侧），延后两帧等 Vue 完成控件登记。
 */
function resizeAfterPromotedChange(node) {
    if (!node || typeof window === "undefined") return;
    const raf = window.requestAnimationFrame;
    if (typeof raf !== "function") return;
    safeCall(() => {
        raf(() => raf(() => {
            if (!isNodeInGraph(node)) return;
            const hasPromoted = (node.inputs || []).some(
                (inp) => inp?._a001OfficialWidgetId
            );
            if (!hasPromoted) return;
            /* ★ 提升/反提升后控件行刚由 Vue 建好，补一次滑条上妆
             *  （数值控件的「轨道/填充/滑块」需要行已存在才能挂上）。 */
            safeCall(() => refreshA001Sliders(node), undefined, "提升后装配滑条");
            const curSize = readA001NodeSize(node);
            const proposed = safeCall(() => node.computeSize?.(curSize[0]), null, "提升后 computeSize");
            if (!proposed || !Array.isArray(proposed) || !Number.isFinite(proposed[1])) return;
            const target = Math.ceil(proposed[1]);
            const cur = curSize[1];
            if (Math.abs(target - cur) <= A001_PROMOTED_SIZE_EPS) return;
            safeCall(() => node.setSize?.([curSize[0], target]), undefined, "提升后尺寸重算");
            /* ★ 高度解耦基线重采样：提升后本函数主动改了节点高度，
             *  预览框期望高度需按新布局重新确立，否则下次网格变化补偿会失准。 */
            safeCall(() => resyncA001SizeLock(node), undefined, "提升后重采样高度解耦基线");
            dirtyCanvas(node);
        }));
    }, undefined, "提升后尺寸重算排程");
}

/**
 * 构建并注入被提升控件（幂等）。
 * 只走官方投影路线：登记 store + 给槽写 widgetId，行的存在性由 node.inputs 投影决定，
 * 内容由 widgetValueStore 按 widgetId 实时查出，登记完即随之渲染。
 */
function mountPromotedWidget(node, outerInput, hostWidget) {
    if (!node || !outerInput || !hostWidget) return;
    const sourceWidget = hostWidget._a001SourceWidget;
    if (outerInput._a001OfficialWidgetId) return;
    const ok = bindOfficialPromotedWidget(node, outerInput, sourceWidget);
    if (ok) {
        outerInput._widget = hostWidget;
        dirtyCanvas(node);
        safeCall(() => node.expandToFitContent?.(), undefined, "官方提升控件撑开尺寸");
    }
}

/** 卸载被提升控件：注销 store 记录并清掉槽上的 widgetId。 */
function unmountPromotedWidget(node, outerInput) {
    if (!node || !outerInput) return;
    unbindOfficialPromotedWidget(node, outerInput);
    outerInput._widget = null;
    dirtyCanvas(node);
}

/* ─────── 投影层（对齐官方 SubgraphNode._projectPromotedWidget） ───────
 * Vue 渲染节点控件的入口是 extractVueNodeData(node) → 它遍历 node.widgets，
 * 对每个 widget 调 node.getSlotFromWidget(widget) 拿回槽；随后
 * resolvePromotedWidgetSource() 要求「槽有 widgetId」才算提升控件。
 * 所以要做两件事：
 *   ① 劫持 widgets getter：把 inputs 里带 widgetId 的槽「投影」成 store-backed
 *      的 widget 描述符，追加到 widget 列表。
 *   ② override getSlotFromWidget：按 widget.widgetId === input.widgetId 反查槽。
 * 不做这步，即使 store 里登记了数据，node.widgets 也没有对应行，Vue 无从渲染。
 * widgets getter 每次读取都重新遍历 inputs 现场投影；store 是 Pinia reactive，
 * 值变化直接驱动 Vue，天然「即时刷新」，无切换工作流才显示的问题。
 * ─────────────────────────────────────────────────────────────────────── */

/** 把一个带 widgetId 的外层槽投影成 store-backed widget 描述符（对齐官方 promotedInputWidget）。 */
function projectA001PromotedWidget(input) {
    if (input?._widget) return input._widget;
    const id = input?.widgetId;
    if (!id) return undefined;
    const store = a001WidgetValueStore();
    /* ★ 兜底补挂回流桥：bindOfficialPromotedWidget 在槽已有 _a001OfficialWidgetId 时
     * 会提前 return（工作流反序列化恢复的槽就属这种情况），监听器便永远挂不上。
     * 投影入口每次读都会被走到，且 bindA001StoreReflow 内部幂等，故在此补一次最稳妥。 */
    if (store) bindA001StoreReflow(store);
    const getState = () => (store ? safeCall(() => store.getWidget(id), null, "投影取 state") : null);
    const widget = {
        get name() { return getState()?.name ?? input.name; },
        get label() { return getState()?.label ?? input.label ?? input.name; },
        set label(next) {
            const s = getState();
            if (s) s.label = next;
        },
        get y() { return getState()?.y ?? 0; },
        set y(next) {
            const s = getState();
            if (s) s.y = next;
        },
        get type() {
            const t = getState()?.type;
            if (t) return t;
            const src = input._a001SourceWidget;
            return src ? a001NativeWidgetType(src) : "text";
        },
        get options() {
            const o = getState()?.options;
            if (o) return o;
            const src = input._a001SourceWidget;
            if (!src) return {};
            const opts = Object.assign({}, src.options || {});
            if (a001NativeWidgetType(src) === "customtext") {
                opts.multiline = true;
                if (opts.dynamicPrompts == null) opts.dynamicPrompts = true;
            }
            return opts;
        },
        get value() { return getState()?.value; },
        set value(next) {
            /* ★ 双通道：store 负责驱动官方 UI，src 负责驱动内层真实节点。
             * 此前 store 存在时直接 return（假设官方会回流），实测证明官方
             * setValue 不会调用 state.callback，导致内层拿不到值 —— 故必须直写 src。 */
            if (store) store.setValue(id, next);
            const src = input._a001SourceWidget;
            if (src && src.value !== next) src.value = next;
        },
        callback(next) {
            if (store) store.setValue(id, next);
            const src = input._a001SourceWidget;
            if (src && src.value !== next) {
                src.value = next;
                safeCall(() => src.callback?.(next, input), undefined, "投影回流源 callback");
            }
        },
    };
    Object.defineProperty(widget, "widgetId", {
        value: id,
        enumerable: false,
        configurable: true,
    });
    widget._a001Projected = true;
    input._widget = widget;
    return widget;
}

/* ★★ 收起状态与尺寸簇已拆分至 A001_hidden.js（本轮拆分，仅搬迁零逻辑改动）。
 *  包含：节点尺寸读写、新建默认宽度落地、收起状态持久化/恢复/DOM 同步。
 *  此处仅 re-export，保持本模块既有调用点与对外 API 不变。
 *  ⚠️ 已用 verify_move.py 逐字符比对确认 9 个函数搬迁前后逻辑完全一致。 */
import {
    initHiddenDeps,
    readA001NodeSize,
    applyA001DefaultSize,
    persistA001HiddenState,
    restoreA001HiddenState,
    scheduleA001HiddenRestore,
    toggleA001WidgetsHidden,
    refreshPortsAfterHiddenToggle,
    isA001WidgetsHidden,
    syncA001HiddenClass,
} from "./A001_hidden.js?v=20261007a";

/* re-export：保持对外 API 不变（A001_Appearance / A001_restore 等按原名引用）。 */
export {
    restoreA001HiddenState,
    toggleA001WidgetsHidden,
    isA001WidgetsHidden,
    syncA001HiddenClass,
};

/**
 * 在 A001 子图节点上安装官方投影层（幂等）：
 *   - 记录原始 widgets 存取器，改为「原始列表 + 投影提升控件」；
 *   - override getSlotFromWidget：先按 widgetId 反查外层槽，未命中交回原生。
 * 必须在节点构造早期调用（onNodeCreated），确保 Vue 首次读取即为最终形态。
 */
function installA001WidgetProjection(node) {
    if (!node || node._a001ProjectionInstalled) return;
    const nodeType = node.constructor;
    if (!nodeType?.prototype) return;
    node._a001ProjectionInstalled = true;
    const self = node;
    try {
        Object.defineProperty(self, "widgets", {
            get() {
                const list = [];
                /* ★★ 收起/展开控件 = 「CSS 隐藏」（一比一照抄 Custom Stage，实测踩坑，勿改回
                 *  早先的「停止投影 = 卸载 DOM」写法）：
                 *    旧写法在收起时直接不产出控件行 → Vue 卸载整批控件 DOM →
                 *    ① textarea 元素被销毁，用户拖过的高度（内联 height）随之丢失，
                 *       展开后只能靠 properties 存档读回，链路一断就「高度还原不了」；
                 *    ② 元素引用换新 → 官方槽位 DOM 重建 → 端口胶囊丢皮、需要多路补偿；
                 *    ③ 网格宿主 [data-widgets-grid-node-id] 有整体消失的风险 → 端口锚点失据。
                 *    Custom Stage 的 bindPanelCollapse 用的是「元素保留 + CSS 隐藏」
                 *    （[data-v2-collapsed] > :not(.v2-collapse){display:none}），
                 *    元素从不销毁 → 内联高度天然存活 → 无需任何持久化、也无重建副作用。
                 *    这里保持投影始终产出全部控件行，改由 CSS 按节点上的隐藏标记整批隐藏
                 *    （样式注入见 A001_textarea_resize.js 的 injectCss），语义等价、副作用归零。 */
                for (const inp of self.inputs || []) {
                    if (!inp || !inp.widgetId) continue;
                    const w = safeCall(() => projectA001PromotedWidget(inp), undefined, "投影提升控件");
                    if (w) list.push(w);
                }
                for (const w of self._a001ExtraWidgets || []) {
                    if (w && !list.includes(w)) list.push(w);
                }
                return list;
            },
            set(v) {
                if (!Array.isArray(v)) return;
                self._a001ExtraWidgets = v.filter((w) => !w?._a001Projected);
            },
            configurable: true,
            enumerable: true,
        });
    } catch (_e) { /* 极端情况下保持原样，不阻断节点创建 */ }
    if (!Array.isArray(self._a001ExtraWidgets)) {
        const existing = safeCall(() => {
            const d = Object.getOwnPropertyDescriptor(self, "widgets");
            if (d && !d.get && Array.isArray(d.value)) return d.value;
            const protoDesc = Object.getOwnPropertyDescriptor(nodeType.prototype, "widgets");
            if (protoDesc?.get) return protoDesc.get.call(self);
            if (d?.get) return d.get.call(self);
            return undefined;
        }, undefined, "抓取原生 widgets") ?? [];
        self._a001ExtraWidgets = (Array.isArray(existing) ? existing : []).filter((w) => !w?._a001Projected);
    }
    const proto = nodeType.prototype;
    if (!proto.__a001SlotFromWidgetPatched) {
        const isA001 = (n) => n?._a001ProjectionInstalled;
        const origGetSlot = proto.getSlotFromWidget;
        proto.getSlotFromWidget = function (widget) {
            if (isA001(this) && widget?.widgetId) {
                const hit = (this.inputs || []).find((inp) => inp.widgetId === widget.widgetId);
                if (hit) return hit;
            }
            return origGetSlot ? origGetSlot.apply(this, arguments) : undefined;
        };
        proto.__a001SlotFromWidgetPatched = true;
    }
}

/** ★ 敲一下 inputs 数组，触发 Vue 侧 shallow 响应式重算。
 * 官方 extractVueNodeData 把 node.inputs 包成 shallowReactive 代理，shallow 只代理
 * 数组长度/索引写入、不代理元素属性写入；而提升控件的关键标记 widgetId 恰写在
 * 「槽元素」属性上（shallow 追踪不到）。修复：写完后原地替换槽引用（同值不同对象），
 * 让索引写入生效，从而触发 widgets getter 重算，即时显示。 */
function touchA001Inputs(node) {
    if (!node || !Array.isArray(node.inputs)) return;
    safeCall(() => {
        const list = node.inputs;
        for (let i = 0; i < list.length; i++) {
            list[i] = Object.assign({}, list[i]);
        }
        /* ★ 替换槽对象后重新登记回流反查（2026-10-05 修复引用分裂）：
         *  A001_REFLOW_INDEX 存的是「槽对象引用」，若仍指向刚被替换掉的旧对象，
         *  store.$onAction 回流就会写到脱离 node.inputs 的孤儿槽上（其 _a001SourceWidget
         *  与投影层再建的 _widget 也随之分裂，读到陈旧值）。这里按新槽上的
         *  _a001OfficialWidgetId 以原 id 重登，保证「反查表持有的 input ===
         *  node.inputs 里的元素」。 */
        if (A001_REFLOW_INDEX.size) {
            for (const inp of list) {
                const wid = inp?._a001OfficialWidgetId;
                if (wid) registerA001ReflowTarget(wid, node, inp);
            }
        }
    }, undefined, "敲 inputs 触发响应式");
}

/**
 * ★ 官方路线：把「内核源 widget」登记为外层宿主槽上的提升控件。
 * 对齐官方 promotionUtils.ts 的 seedNestedPromotedInputState()：
 *   hostInput.widget ??= { name: inputName }
 *   hostInput.widget.name = inputName
 *   hostInput.widgetId   = widgetId(rootGraphId, subgraphNodeId, inputName)
 *   useWidgetValueStore().registerWidget(id, { type, value, options, label, serialize, disabled, isDOMWidget })
 * 槽登记完后，installA001WidgetProjection 的 widgets getter 会把这一行投影出来；
 * 值/类型/选项由 store 实时供给。值回流：给 state 补 callback 桥，外层改值写回内层源 widget。
 */
function bindOfficialPromotedWidget(node, outerInput, sourceWidget) {
    if (!node || !outerInput) return false;
    const graphId = a001HostGraphId(node);
    const name = String(outerInput.name ?? sourceWidget?.name ?? "value");
    const id = a001WidgetId(graphId, node.id, name);
    if (!id) return false;
    /* ★ 让外层槽被官方判定为「由控件承载」(widgeted)，从而隐藏圆点端口。
     * 实证（官方前端产物 settingStore）：
     *   - 渲染列表 inputs = nonWidgetedInputs(nodeData) + linkedWidgetedInputs(nodeData)
     *   - 「是否 widgeted」依据槽上的 input.widget（及其 name），【不是】widgetId
     *   - widgetId 只用于控件值存储与去重（getWidgetIdentity / computeProcessedWidgets）
     * 因此这里必须补写 outerInput.widget，否则槽会被当作普通端口画出圆点。 */
    if (!outerInput.widget) outerInput.widget = { name };
    else if (outerInput.widget.name == null) outerInput.widget.name = name;
    outerInput.widgetId = id;
    outerInput._a001OfficialWidgetId = id;
    outerInput._a001SourceWidget = sourceWidget;
    /* ★ 登记回流反查（性能优化）：$onAction 回调据此 O(1) 定位宿主槽，
     * 取代原先每次 setValue 遍历全图节点×槽的扫描。重复登记同 id 幂等覆盖。 */
    registerA001ReflowTarget(id, node, outerInput);
    touchA001Inputs(node);
    const store = a001WidgetValueStore();
    if (!store) return true;
    /* ★ 挂官方 store → 内层源控件的回流桥（幂等）。用户从官方 UI 输入时只写 store、
     * 不触发投影 setter / state.callback，必须靠 store.$onAction 把值送回内层。 */
    bindA001StoreReflow(store);
    const srcOpts = sourceWidget?.options || {};
    const choices = sourceWidget ? collectA001WidgetChoices(sourceWidget) : null;
    const options = Object.assign({}, srcOpts);
    if (Array.isArray(choices) && choices.length) options.values = choices.slice();
    options.serialize = false;
    const nativeType = sourceWidget ? a001NativeWidgetType(sourceWidget) : "text";
    const isMulti = nativeType === "customtext";
    if (isMulti) {
        options.multiline = true;
        if (options.dynamicPrompts == null) options.dynamicPrompts = true;
    }
    safeCall(() => store.registerWidget(id, {
        name,
        type: nativeType,
        value: sourceWidget?.value,
        options,
        label: outerInput.label ?? sourceWidget?.label ?? name,
        serialize: false,
        disabled: !!srcOpts.disabled,
        isDOMWidget: false,
        y: 0,
    }), undefined, "官方提升控件 registerWidget");
    if (sourceWidget) {
        const state = safeCall(() => store.getWidget(id), null, "官方提升控件取 state");
        if (state) {
            state.callback = (v) => {
                if (sourceWidget.value === v) return;
                sourceWidget.value = v;
                safeCall(() => sourceWidget.callback?.(v, node), undefined, "官方提升控件回流源 callback");
            };
            state.value = sourceWidget.value;
        }
    }
    return true;
}

/** ★ 官方路线：注销宿主槽上的提升控件（反提升时调用）。 */
function unbindOfficialPromotedWidget(node, outerInput) {
    if (!node || !outerInput) return;
    const id = outerInput._a001OfficialWidgetId ?? outerInput.widgetId;
    /* ★ 注销回流反查（必须在清空 _a001OfficialWidgetId 之前取到 id）。 */
    unregisterA001ReflowTarget(id);
    outerInput._a001OfficialWidgetId = null;
    outerInput._a001SourceWidget = null;
    outerInput._widget = undefined;
    if (outerInput.widgetId) delete outerInput.widgetId;
    if (!id) return;
    const store = a001WidgetValueStore();
    if (!store) return;
    safeCall(() => store.deleteWidget(id), undefined, "官方提升控件 deleteWidget");
}

/** ★ 整节点删除时的批量注销：遍历本节点所有外层输入槽，逐个走反提升清理。
 *  背景：unbindOfficialPromotedWidget 原先只在「反提升」交互路径被调用，
 *  节点被整体删除（onRemoved）时不会遍历 inputs，导致 store 条目残留。
 *  本函数只做「补齐调用」，复用既有单槽清理逻辑，不引入新语义。 */
function unbindAllOfficialPromotedWidgets(node) {
    if (!node) return;
    const inputs = node.inputs || [];
    for (const inp of inputs) {
        if (!inp) continue;
        if (!(inp._a001OfficialWidgetId || inp.widgetId)) continue;
        safeCall(() => unbindOfficialPromotedWidget(node, inp), undefined, "节点删除批量注销提升控件");
    }
}

/* ════════════════════════════════════════════════
 *  2.5 · 复制粘贴 ID 重映射
 *
 *  ★ 本节旧实现（冲突检测 + 蛇形取号 + 数据重映射，共 13 个函数与 3 个常量）已整体移除：
 *    它针对 properties 里「已落盘的 JSON 字符串」做重映射，是早期方案的残留，全文件零调用点
 *    （本节函数均未 export；grep 命中的同名函数属 A005/A006 各自的独立实现，与此处无关）。
 *    现役实现见下方 remapA001ClipboardData —— 直接对剪贴板数据（而非 properties 字符串）重映射。
 * ════════════════════════════════════════════════ */
/* ─── 创建/恢复子图 ─── */

/**
 * 为节点创建 / 恢复子图，并挂载到 node.subgraph。
 * 幂等：已存在非空子图时不会重复创建。
 * 全流程复用官方能力：createSubgraph(def) 建 → configure(def) 灌数据。
 *
 * opts.force（复刻 A006_workflow.js applySnapshotToNode 的强制重建语义）：
 *  · false（默认）—— 保持原幂等行为：已有非空子图时仅做插槽同步/提升重建后返回，
 *    不销毁、不重建（工作流切换/反序列化路径依赖此行为）。
 *  · true —— 无条件销毁当前子图并按 properties.subgraph_data_json 重建，
 *    供「还原」把快照数据整体灌回节点使用（旧子图状态须先清干净）。
 * 导出：供 A001_workflow.js「还原」以 opts.force=true 强制重建。
 */
export function ensureSubgraph(node, opts = {}) {
    const force = opts?.force === true;
    const graph = getNodeGraph(node);
    // 官方子图工厂挂在 LGraph 上，能力探测后调用
    if (!graph || typeof graph.createSubgraph !== "function") {
        alog("当前 graph 不支持 createSubgraph");
        return null;
    }
    const saved = readSavedSubgraphData(node);
    const savedNodeCount = saved?.data?.nodes?.length ?? 0;

    if (node.subgraph) {
        const existingNodes = node.subgraph?._nodes || node.subgraph?.nodes || [];
        if (!force && (existingNodes.length > 0 || !saved || savedNodeCount === 0)) {
            /* ★ 关键：子图已存在时【不能直接 return】。
             * 工作流切换/反序列化路径下，configure 钩子调到这里时 node.subgraph
             * 已被官方从 subgraph_data_json 恢复成非空子图（nodes 已有内容），
             * 若此处提前返回，下面的 syncSlotsInitial / attachSlotSync /
             * reconcilePromotedInputs 就全部被跳过 —— 这正是「新建时端口控件都在，
             * 切换工作流后双双消失」的根因：外层 inputs 里的提升槽（widgetId 载体）
             * 与投影控件需要在【每次进入本函数】时重建。
             * 这些调用均幂等（attachSlotSync 比较 _a001SyncedSg；reconcile 内部
             * 按 _a001OfficialWidgetId / occupied 去重），重复执行安全。
             * force=true 时跳过此快速返回，继续走下面的销毁 + 重建流程。 */
            safeCall(() => syncSlotsInitial(node), undefined, "已存子图同步插槽");
            safeCall(() => attachSlotSync(node), undefined, "已存子图挂插槽同步");
            safeCall(() => reconcilePromotedInputs(node), undefined, "已存子图重建提升");
            /* ★★ 节点级状态回灌（修复「A004 视频开关刷新后变开」）：
             *  本分支下官方已用自己的通道预建了 node.subgraph，A001 私有通道
             *  （properties.subgraph_data_json）里的节点级状态【不会】被官方应用 ——
             *  实测：官方预建的内层节点 mode=0（默认），而私有通道 data 里是 mode=4。
             *  后果：A004 所在组本应「已忽略」，加载后却变「未忽略」→ 其 switch 被
             *  联动逻辑写成「开」→ 用户看到「刷新后开关自己变开」。
             *  实际回灌由 attachA001Ports 统一排程（scheduleA001ModesRestore），
             *  覆盖全部装配路径，此处无需再调（避免重复）。 */
            return node.subgraph;
        }
        alog(
            (force ? "强制重建子图 | " : "重建子图 | ") +
            "销毁当前空子图，用保存数据恢复 | nodes:" + savedNodeCount
        );
        // 官方 Subgraph.clear()
        safeCall(() => node.subgraph.clear?.(), undefined, "销毁旧子图");
        node.subgraph = null;
    }

    const data = _prepareSubgraphData(node, saved);

    /* ★ 复制粘贴 ID 冲突检测 → 整体重映射（槽/节点/连线/分组/reroute + 计数器
     *   + 外层端口标记 + 内嵌子图定义）。蓝本：A005_subgraph.js:600-616。
     *  必须在 createSubgraph / configure 之前完成：官方据此建图并解析 node.id，
     *  晚于此则画布标签已按旧 ID 建好，重映射只能改数据、改不动已建实例。 */
    _remapSubgraphOnIdConflict(node, data);

    /* ★ 必须早于 createSubgraph：把本节点子图里内嵌的原生子图定义
     * （ExportedSubgraph 数组）先 leaf-first 注册进 rootGraph，
     * 否则 configure 灌数据时遇到 UUID node type 的内层 SubgraphNode
     * 会因定义未注册而变成未知节点（「节点内部的子图无法识别」根因）。
     * 蓝本：A005_subgraph.js:608-615。 */
    _restoreEmbeddedDefsBeforeCreate(node, graph);

    // 官方 LGraph.createSubgraph(def)
    const sg = safeCall(() => graph.createSubgraph(data), null, "createSubgraph");
    if (!sg) return null;
    node.subgraph = sg;

    // 官方 Subgraph.configure(def)：createSubgraph 只建壳，不灌 nodes/links，
    // 有存量数据时须主动补调一次
    if (data.nodes?.length > 0 && typeof sg.configure === "function") {
        safeCall(() => sg.configure(data), undefined, "sg.configure");
    }

    // 建图/恢复后同步插槽并重建提升绑定（桌面版提升子系统的接线点）。
    // 必须先建立子图，插槽同步与 reconcile 都依赖 node.subgraph。
    _syncSlotsAfterSubgraph(node);

    return sg;
}

/* ─── ensureSubgraph 的分解体（函数级拆分：仅搬代码，零逻辑改动） ─── */

/** ★★ 把私有通道（subgraph_data_json）里的**节点级状态**回灌到已存子图。
 *
 *  为什么需要（浏览器实测根因，勿删）：
 *    加载工作流时，官方会用自己的通道**预建** node.subgraph（非空）。于是
 *    ensureSubgraph 命中「快速返回分支」，不再调 sg.configure(data) —— 私有通道
 *    properties.subgraph_data_json 里的节点级状态（mode 等）**从未被应用**。
 *    实测：官方预建的 A004 内层节点 mode=0（默认），而私有通道 data 里是 mode=4；
 *    结果 A004 所在组本应「已忽略」却变成「未忽略」→ 其 switch 被联动写成「开」。
 *
 *  做法：调用方（scheduleA001ModesRestore）已确保 properties 就绪后传入 data；
 *    按节点 id 精确匹配，只同步 `mode`（缺失/非法则跳过）。
 *    · 只碰 mode 一个字段，绝不重建节点 → 零其它副作用；
 *    · 幂等：重复调用结果一致；
 *    · 找不到对应节点（id 不一致 / 重映射过）→ 静默跳过，不影响其它逻辑。
 *
 *  @param {LGraphNode} node A001 子图节点
 *  @param {object|null} data 私有通道对象（含 nodes[]）
 *  @returns {number} 实际回灌的节点数
 */
function applyA001NodeModesFromSaved(node, data) {
    const sg = node?.subgraph;
    const list = data?.nodes;
    if (!sg || !Array.isArray(list) || !list.length) return 0;
    const live = sg._nodes || sg.nodes || [];
    if (!Array.isArray(live) || !live.length) return 0;
    /* 内存节点按 id 建索引（id 可能是 number 或 string，统一转 string 比对）。 */
    const byId = new Map();
    for (const n of live) {
        if (n && n.id != null) byId.set(String(n.id), n);
    }
    let changed = 0;
    for (const rec of list) {
        if (!rec || rec.id == null) continue;
        if (typeof rec.mode !== "number") continue;
        const target = byId.get(String(rec.id));
        if (!target) continue;
        if (target.mode === rec.mode) continue;
        safeCall(() => { target.mode = rec.mode; }, undefined, "回灌节点 mode");
        changed += 1;
    }
    if (changed > 0) {
        alog("已按存档回灌节点 mode | 修正节点数:", changed, "| 子图节点总数:", live.length);
        /* mode 变化会影响画布渲染（忽略态灰显），标注脏位重绘。 */
        safeCall(() => node.graph?.setDirtyCanvas?.(true, true), undefined, "回灌 mode 后重绘");
        safeCall(() => sg.setDirtyCanvas?.(true, true), undefined, "回灌 mode 后子图重绘");
    }
    return changed;
}

/** 排一次「按存档回灌节点 mode」——必须等 properties 被官方还原 + 子图建立完成。
 *
 *  ★ 时机（实测踩坑，勿改回同步调用）：
 *    官方反序列化顺序为 onNodeCreated → configure，而 node.properties 在 configure
 *    **之后**才被还原。ensureSubgraph 的快速返回分支跑在 configure 内部，此刻同步读
 *    subgraph_data_json 会拿到空值（实测：回灌函数无任何输出）。
 *    故这里复用「双 rAF + setTimeout 兜底」双通道（与隐藏态恢复同款），并在回调里
 *    重新读取最新 properties；只要仍有「未修正的 mode」就重试，最多 8 拍。
 *    幂等 + 自带重试，重复排程无害。 */
function scheduleA001ModesRestore(node) {
    if (!node) return;
    let tries = 0;
    const MAX = 8;
    const run = () => {
        if (!isNodeInGraph(node)) return;
        const saved = safeCall(() => readSavedSubgraphData(node), null, "回灌 mode: 读存档");
        const changed = safeCall(
            () => applyA001NodeModesFromSaved(node, saved?.data || null),
            0,
            "回灌 mode: 应用"
        );
        /* 若这一拍没拿到数据 / 还没修正完，稍后重试（覆盖 properties 晚就绪的窗口）。 */
        if ((!saved || changed === 0) && tries < MAX) {
            tries += 1;
            safeCall(() => setTimeout(run, 80 * tries), undefined, "回灌 mode 重试排程");
        }
    };
    /* 通道一：双 rAF（可见时最贴近「渲染完成后」）。 */
    if (typeof requestAnimationFrame === "function") {
        safeCall(() => requestAnimationFrame(() => requestAnimationFrame(run)),
            undefined, "回灌 mode 排程（rAF）");
    }
    /* 通道二：setTimeout 兜底（不受页面可见性影响，保证一定执行）。 */
    safeCall(() => setTimeout(run, 48), undefined, "回灌 mode 排程（setTimeout 兜底）");
}

/** 取本次建图要用的子图数据：优先深拷贝保存数据，失败/缺失则回退为空子图。
 *  日志文案与分支判据与原 ensureSubgraph 内联段逐字一致。 */
function _prepareSubgraphData(node, saved) {
    let data;
    if (saved) {
        data = safeCall(
            () => JSON.parse(JSON.stringify(saved.data)),
            undefined,
            "子图数据深拷贝"
        );
        if (!data || typeof data !== "object") {
            alog("保存数据不可用（深拷贝失败）→ 回退为空子图");
            data = buildSubgraphData("001_子图节点");
        }
        alog(
            `从保存数据恢复子图 | 通道: ${saved.channel}` +
            ` | nodes: ${data.nodes?.length ?? 0}` +
            ` | links: ${data.links?.length ?? 0}`
        );
    } else {
        data = buildSubgraphData("001_子图节点");
        alog("无保存数据，新建空子图");
    }
    return data;
}

/* ★★ id 重映射簇已拆分至 A001_remap.js（本轮拆分，仅搬迁零逻辑改动）。
 *  包含：remapA001ClipboardData（node/link/reroute/group/subgraph 五类 id 全局唯一
 *  重分配 + 引用同步）与 remapSubgraphOnIdConflict（节点级一次性去重包装）。
 *  此处仅 re-export，保持本模块既有调用点与对外 API 不变。
 *  ⚠️ 该簇是本项目最敏感区域（多轮浏览器实测收敛），已用 verify_move.py
 *     逐字符比对确认搬迁前后逻辑完全一致（remapA001ClipboardData 5372 字符）。 */
import {
    remapA001ClipboardData,
    remapSubgraphOnIdConflict as _remapSubgraphOnIdConflict,
} from "./A001_remap.js?v=20261007a";

/* re-export：外部（A005/A006 同构实现、测试脚本）可能按原名引用。 */
export { remapA001ClipboardData };

/** 建图前把内嵌原生子图定义（ExportedSubgraph 数组）leaf-first 注册进 rootGraph，
 *  否则 configure 灌数据时遇到 UUID node type 的内层 SubgraphNode 会变成未知节点。 */
function _restoreEmbeddedDefsBeforeCreate(node, graph) {
    safeCall(
        () => {
            const raw = node.properties?.embedded_subgraph_defs_json;
            if (!raw) return;
            const embeddedDefs = JSON.parse(raw);
            restoreEmbeddedSubgraphDefs(node, graph, embeddedDefs);
        },
        undefined,
        "恢复内嵌子图定义"
    );
}

/** 建图/恢复后同步插槽并重建提升绑定（与原 ensureSubgraph 尾部三行调用等价，
 *  仅「建图后」路径使用；「已存子图」路径的日志文案不同，故不共用）。 */
function _syncSlotsAfterSubgraph(node) {
    safeCall(() => syncSlotsInitial(node), undefined, "建图后同步插槽");
    safeCall(() => attachSlotSync(node), undefined, "建图后挂插槽同步");
    safeCall(() => reconcilePromotedInputs(node), undefined, "建图后重建提升");
}

/** ★★ 子图身份守护（自愈兜底）：节点持有子图存档、却没有 node.subgraph 时补建。
 *
 *  为什么必须有它（v0.38.2 实测根因）：
 *    官方新版前端把「进入子图」入口做成 Vue NodeFooter 按钮，显示判据是
 *        :is-subgraph="!!lgraphNode?.isSubgraphNode()"
 *    而 A001 的 isSubgraphNode() 只答 `!!this.subgraph`。于是只要 node.subgraph
 *    在反序列化/复制粘贴的时序竞态中没建起来（或 createSubgraph 抛错被吞），
 *    「进入子图」入口、子图面包屑、执行展开会一并静默消失 —— 且不会触发任何
 *    UI 级缺失判据，恢复中枢的既有巡检也发现不了。
 *
 *  判据只认「有存档 + 无实例」：
 *    · 无存档的新节点（子图已在内存里）→ 不处理，避免覆盖内存态；
 *    · 已持有 subgraph（含空子图）→ 立即返回，可被高频巡检安全调用。
 */
function ensureSubgraphIfMissing(node) {
    if (!node || node.subgraph) return;
    const saved = node.properties?.subgraph_data_json;
    if (typeof saved !== "string" || !saved.length) return;
    alog("子图身份守护：node.subgraph 缺失，依据存档补建");
    safeCall(() => ensureSubgraph(node), undefined, "子图身份守护补建");
    safeCall(() => dirtyCanvas(node), undefined, "子图身份守护重绘");
}

/* ════════════════════════════════════════════════
 *  3 · 提升 主入口 / 反提升 / 收集 / 恢复对齐
 *  ════════════════════════════════════════════════ */

/**
 * 把子图内 sourceNode 的 sourceWidget 提升为外层 input 槽（端口）。
 * 复刻原生 promoteValueWidgetViaSubgraphInput 语义，返回 { ok, reason? }。
 */
function promoteWidgetToPort(node, sourceNode, sourceWidget) {
    const sg = node.subgraph;
    if (!sg) return { ok: false, reason: "noSubgraph" };
    const sourceWidgetName = sourceWidget?.name || "value";
    if (!sourceWidget || !sourceNode) return { ok: false, reason: "missingSourceSlot" };
    const sourceSlot = innerSlotForWidget(sourceNode, sourceWidget);
    if (!sourceSlot) {
        alog(`提升失败：找不到内层输入槽 | 节点:${sourceNode.title ?? sourceNode.type}(id=${sourceNode.id}) widget:${sourceWidget.name}`);
        return { ok: false, reason: "missingSourceSlot" };
    }
    const promoted = node.inputs || [];
    for (let i = 0; i < promoted.length; i++) {
        const src = promoted[i]._a001Source;
        if (src && String(src.nodeId) === String(sourceNode.id) && src.widgetName === sourceWidgetName) {
            alog(`已存在提升端口，跳过重复提升 | ${sourceWidgetName}`);
            return { ok: true, inputIndex: i, already: true };
        }
    }
    const existingNames = sg.inputs.map((i) => i.name);
    const inputName = a001UniqueName(sourceWidgetName, existingNames);
    const subgraphInput = sg.addInput(inputName, String(sourceSlot.type ?? sourceWidget.type ?? "*"));
    if (!subgraphInput) return { ok: false, reason: "addInputFailed" };
    subgraphInput.label = sourceSlot.label ?? sourceWidget.label ?? sourceWidgetName;
    const link = subgraphInput.connect(sourceSlot, sourceNode);
    if (!link) {
        safeCall(() => sg.removeInput(subgraphInput), undefined, "promote 回滚 removeInput");
        alog(`提升失败：内层槽连接被拒 | widget:${sourceWidget.name}`);
        return { ok: false, reason: "connectFailed" };
    }
    let outerInput = _findOuterSlotBySubgraphSlotId(node.inputs, subgraphInput.id);
    if (!outerInput) {
        outerInput = safeCall(
            () => node.addInput(inputName, String(sourceSlot.type ?? sourceWidget.type ?? "*"), { _a001SubgraphSlotId: subgraphInput.id }),
            null,
            "promote 兜底 addInput"
        );
    }
    if (!outerInput) {
        safeCall(() => sg.removeInput(subgraphInput), undefined, "promote 无外层槽回滚");
        return { ok: false, reason: "noOuterSlot" };
    }
    outerInput.label = subgraphInput.label ?? inputName;
    const hostWidget = createPromotedHostWidget(sourceWidget, node);
    outerInput._a001Source = buildA001SourceRef(sourceNode.id, sourceWidgetName);
    outerInput._a001SubgraphSlotId = subgraphInput.id;
    if (hostWidget) hostWidget.nodeForCallback = node;
    mountPromotedWidget(node, outerInput, hostWidget);
    touchA001Inputs(node);
    writePromotedPersist(node);
    dirtyCanvas(node);
    resizeAfterPromotedChange(node);
    /* ★ 新提升的槽若承载多行文本，立即换成自研 @编辑器（内层判定由注入的
     *  isMultilineWidget 完成，与官方投影归一化口径一致）。*/
    safeCall(() => refreshA001PromptEditors(node), undefined, "提升后装配编辑器");
    alog(`已提升控件到端口 | ${sourceNode.title ?? sourceNode.type}:${sourceWidgetName} → 外层输入口 ${inputName}`);
    return { ok: true, inputName };
}

/** 收集子图内所有「可提升」的输入 widget：真实节点（非 inputNode/outputNode 虚拟出口）且带同名输入槽。 */
function collectPromotableWidgets(node) {
    const sg = node.subgraph;
    if (!sg) return [];
    const result = [];
    for (const inner of getSgNodes(sg)) {
        if (!inner || isConstId(inner.id)) continue;
        const widgets = inner.widgets || [];
        for (const w of widgets) {
            if (!w || w.name == null) continue;
            const slot = (inner.getSlotFromWidget?.(w)) ||
                (inner.inputs || []).find(
                    (inp) => inp.name === w.name || inp.widget?.name === w.name
                );
            if (slot) result.push({ node: inner, widget: w, slot });
        }
    }
    return result;
}

/** 反提升：删除外层 input 槽对应内层 SubgraphInput（连带源 widget 恢复为普通控件）。 */
function demoteWidgetFromPort(node, inputIndex) {
    const input = node.inputs?.[inputIndex];
    if (!input) return { ok: false, reason: "noInput" };
    const subInputId = input._a001SubgraphSlotId;
    const inputName = input.name;
    const sg = node.subgraph;
    /* ★ @文本编辑器：先摘掉该槽的编辑器与 doc 存档（在本函数清空槽字段之前，
     *  因为卸载需要用到 _a001OfficialWidgetId 与 wrap 的 DOM 归属）。
     *  反提升后该槽不再存在，若保留 doc 会成为永不释放的孤儿存档。 */
    safeCall(() => detachA001PromptEditorSlot(node, inputName), undefined, "反提升卸载编辑器");
    safeCall(() => a001DropPromptRecord(node, inputName), undefined, "反提升清理 doc 存档");
    unmountPromotedWidget(node, input);
    if (sg && subInputId != null) {
        const subgraphInput = _findSgSlotById(sg.inputs, subInputId);
        if (subgraphInput) {
            if (typeof subgraphInput.disconnect === "function") {
                safeCall(() => subgraphInput.disconnect(), undefined, "demote 断开");
            }
            safeCall(() => sg.removeInput(subgraphInput), undefined, "demote removeInput");
        }
    }
    if (subInputId != null) {
        const outerIdx = (node.inputs || []).findIndex(
            (s) => String(s._a001SubgraphSlotId) === String(subInputId)
        );
        if (outerIdx >= 0) safeCall(() => node.removeInput(outerIdx), undefined, "demote 兜底移除外层槽");
    }
    delete input._a001Source;
    delete input.widgetId;
    input.widget = undefined;
    input._widget = undefined;
    writePromotedPersist(node);
    dirtyCanvas(node);
    resizeAfterPromotedChange(node);
    alog("已取消提升控件 | 输入口:", inputName);
    return { ok: true };
}

/** 序遍历子图内所有节点 widget，返回可提升条目列表（供 getExtraMenuOptions 子菜单使用）。 */
function listPromotableWidgets(node) {
    const _isGood = (item) =>
        item.widget && item.slot && item.node && !isConstId(item.node.id);
    return collectPromotableWidgets(node).filter(_isGood);
}

/**
 * 解析内层 SubgraphInput 的提升来源。
 * 子图内部连线方向是 inputNode(-10) → 内层目标节点输入槽，故真实源节点在
 * 链接的 target_id / target_slot 上（origin_id 恒为 -10，不能当源）。
 * 返回 { nodeId, widgetName, sourceNode, sourceWidget } 或 null。
 */
function resolveA001PromotedSource(node, outerInput) {
    const sg = node.subgraph;
    if (!sg || !outerInput) return null;
    const inputName = outerInput.name;
    const inputNode = sg.inputNode;
    if (!inputNode) return null;
    const slotId = outerInput._a001SubgraphSlotId;
    let slot = slotId != null
        ? (sg.inputs || []).find((s) => String(s.id) === String(slotId))
        : undefined;
    if (!slot) slot = (sg.inputs || []).find((s) => s.name === inputName);
    if (!slot) return null;
    const linkIds = _collectSgLinkIds(slot);
    const innerNodes = getSgNodes(sg);
    for (const linkId of linkIds) {
        const sub = _resolveSgLink(sg, linkId, "reconcile");
        if (!sub) continue;
        const official = safeCall(() => sub.resolve?.(sg), null, "reconcile 官方 resolve");
        if (official?.inputNode && official?.input && !isConstId(official.inputNode.id)) {
            const w = safeCall(
                () => official.inputNode.getWidgetFromSlot?.(official.input),
                null,
                "reconcile 取内层 widget"
            );
            if (w) {
                return {
                    nodeId: official.inputNode.id,
                    widgetName: w.name,
                    sourceNode: official.inputNode,
                    sourceWidget: w,
                };
            }
        }
        let targetNode = null;
        let targetSlot = null;
        if (sub.target_id != null && !isConstId(sub.target_id)) {
            targetNode = safeCall(() => node.rootGraph?.getNodeById?.(sub.target_id)
                || innerNodes.find((n) => String(n.id) === String(sub.target_id)), undefined, "reconcile 找源节点");
            if (targetNode && sub.target_slot != null) {
                targetSlot = (targetNode.inputs || [])[sub.target_slot];
            }
        }
        if (!targetNode) {
            const innerInput = (inputNode.inputs || []).find((x) => x.link === linkId);
            if (innerInput?.name != null) {
                targetNode = innerNodes.find((n) =>
                    (n.inputs || []).some((x) => x.name === innerInput.name
                        || x.widget?.name === innerInput.name));
                targetSlot = targetNode?.inputs?.find((x) => x.name === innerInput.name
                    || x.widget?.name === innerInput.name);
            }
        }
        if (!targetNode || isConstId(targetNode.id)) continue;
        const tSlotIdx = sub.target_slot != null ? Number(sub.target_slot) : null;
        if (tSlotIdx != null && Number.isFinite(tSlotIdx)) {
            targetSlot = (targetNode.inputs || [])[tSlotIdx] ?? targetSlot;
        }
        const widgetName = targetSlot?.widget?.name ?? targetSlot?.name ?? null;
        if (widgetName == null) continue;
        const ws = targetNode.widgets || [];
        const sourceWidget = ws.find((w) => w?.name === widgetName) || null;
        if (!sourceWidget) continue;
        return { nodeId: targetNode.id, widgetName, sourceNode: targetNode, sourceWidget };
    }
    return null;
}

/**
 * 刷新/恢复后重建已 promote 的外层 input 槽绑定：
 * 来源仍在 → 保留；丢失 → 由持久化或链接推断恢复。
 * 循环内维护「已被占用的 (内层节点, 控件名)」集合，防止内外层槽数量不一致时重复注册。
 */
function reconcilePromotedInputs(node) {
    const sg = node.subgraph;
    if (!sg) return;
    const persisted = readPromotedPersist(node);
    /* ★ 恢复兜底（拆为 _ensurePromotedOuterSlots）：先把「子图输入槽里带提升控件、
     * 但外层还没有对应槽」的情况补齐，再走下方统一的重建流程。 */
    let dirty = _ensurePromotedOuterSlots(node, sg);
    const occupied = new Set();
    /* ★ 单次 reconcile 内的解析结果缓存（性能优化）：resolveA001PromotedSource
     * 内部要遍历子图槽的 links 并对每条链接做官方 resolve（含 getWidgetFromSlot
     * 等较重的调用）。本循环按外层槽逐个解析，同一 (槽id|槽名) 在一次 reconcile
     * 内只会出现一次，但「槽名相同、slotId 缺失」的退化分支会重复走同一 slot 查询；
     * 且 ensureSubgraph 每次进入都会重跑本函数（切图/反序列化高频）。
     * 这里以「槽名 + _a001SubgraphSlotId」为键 memo，命中即复用，避免重复解析。
     * 缓存在本函数作用域内，函数返回即释放，不影响后续调用的结果新鲜度。 */
    const resolveMemo = new Map();
    /* ★ 循环不变量外提（性能优化 + 降嵌套）：
     * innerNodes 只依赖 sg（本函数内不变）；内层节点查找是纯查询，不依赖循环变量。
     * 原先定义在循环体内，每轮外层槽都重新创建闭包，槽多时（整图反序列化）会产生
     * 大量短命闭包。外提后语义完全等价（查找逻辑移入 _findInnerNodeById，仍复用同一 innerNodes）。 */
    const innerNodes = getSgNodes(sg);
    for (const outer of node.inputs || []) {
        if (outer._a001Source) {
            if (outer._a001OfficialWidgetId) continue;
        }
        const resolved = _resolvePromotedSourceForOuter(node, outer, resolveMemo, persisted, innerNodes);
        if (resolved.changed) dirty = true;
        const { sourceNode, sourceWidget, widgetName } = resolved;
        if (!sourceNode || !sourceWidget || widgetName == null) continue;
        const key = `${sourceNode.id}::${widgetName}`;
        if (occupied.has(key)) {
            _releaseDuplicatePromotedSlot(node, outer);
            continue;
        }
        occupied.add(key);
        const hostWidget = createPromotedHostWidget(sourceWidget, node);
        if (hostWidget) hostWidget.nodeForCallback = node;
        outer._a001Source = buildA001SourceRef(sourceNode.id, widgetName);
        mountPromotedWidget(node, outer, hostWidget);
    }
    if (dirty) writePromotedPersist(node);
}

/* ─── reconcilePromotedInputs 的分解体（函数级拆分：仅搬代码，零逻辑改动） ─── */

/** 恢复兜底：以内层子图槽为准，把「带提升控件、但外层还没有对应槽」的槽补建出来。
 *  返回是否产生需要持久化的改动（原 reconcile 首段内联循环）。 */
function _ensurePromotedOuterSlots(node, sg) {
    let dirty = false;
    /* ★ 序列化/反序列化后，外层 inputs 可能已由 configure 还原（对齐官方会保留槽）；
     * 但也可能因历史版本数据缺失该槽。此时以子图槽为准重建外层槽。*/
    for (const si of sg.inputs || []) {
        if (!_sgInputSlotCarriesWidget(sg, si)) continue;
        let outer = (node.inputs || []).find(
            (s) => s._a001SubgraphSlotId === si.id || s.name === si.name || s.label === si.name
        );
        if (!outer) {
            const added = node.addInput(si.name, si.type, { _a001SubgraphSlotId: si.id });
            outer = added || (node.inputs || [])[node.inputs.length - 1];
            dirty = true;
        }
        if (outer) {
            outer._a001SubgraphSlotId = si.id;
            _markOuterInputAsWidget(outer, si.name);
        }
    }
    return dirty;
}

/** 在子图节点列表内按 id 找节点，找不到再回退 rootGraph 全局查
 *  （原 reconcile 内的 findInnerNode 闭包外提）。 */
function _findInnerNodeById(node, innerNodes, id) {
    const byInner = innerNodes.find((n) => String(n?.id) === String(id));
    if (byInner) return byInner;
    return safeCall(
        () => node.rootGraph?.getNodeById?.(id),
        undefined,
        "reconcile 找源节点"
    );
}

/** 解析单个外层槽的提升来源（链接解析优先 → 持久化兜底），
 *  返回 { sourceNode, sourceWidget, widgetName, changed }；无来源时三项为 null。 */
function _resolvePromotedSourceForOuter(node, outer, memo, persisted, innerNodes) {
    let sourceNode = null;
    let sourceWidget = null;
    let widgetName = null;
    let changed = false;
    const resolved = (() => {
        const memoKey = `${outer._a001SubgraphSlotId ?? ""}::${outer.name ?? ""}`;
        if (memo.has(memoKey)) return memo.get(memoKey);
        const r = resolveA001PromotedSource(node, outer);
        memo.set(memoKey, r);
        return r;
    })();
    if (resolved?.sourceNode && resolved?.sourceWidget && !isConstId(resolved.sourceNode.id)) {
        sourceNode = resolved.sourceNode;
        sourceWidget = resolved.sourceWidget;
        widgetName = resolved.widgetName;
        const src = outer._a001Source;
        if (!src || String(src.nodeId) !== String(sourceNode.id) || src.widgetName !== widgetName) {
            outer._a001Source = buildA001SourceRef(sourceNode.id, widgetName);
            changed = true;
        }
    }
    if (!sourceNode || !sourceWidget) {
        let src = outer._a001Source;
        const p = persisted.get(String(outer.name));
        if (!src && p) {
            src = buildA001SourceRef(p.nodeId, p.widgetName);
            changed = true;
        }
        if (src?.nodeId != null && src.widgetName != null) {
            sourceNode = _findInnerNodeById(node, innerNodes, src.nodeId);
            sourceWidget = (sourceNode?.widgets || []).find((w) => w?.name === src.widgetName);
            widgetName = src.widgetName;
        }
    }
    return { sourceNode, sourceWidget, widgetName, changed };
}

/** 释放「已被占用的 (内层节点, 控件名)」重复提升槽：
 *  只拆官方绑定而不清 _a001Source / _a001SourceWidget 会留下幽灵提升槽——
 *  该槽仍被 promotedInputs 过滤命中，会被误当合法提升口参与右键菜单与持久化。
 *  （原 reconcile 去重分支，与 demote 路径保持一致的完整清理口径。） */
function _releaseDuplicatePromotedSlot(node, outer) {
    safeCall(() => {
        if (outer._a001OfficialWidgetId) {
            unbindOfficialPromotedWidget(node, outer);
            outer._widget = null;
        }
        delete outer._a001Source;
        outer._a001SourceWidget = null;
    }, undefined, "去重重复提升控件");
}

/* ══════════════════════════════════════════════
 *  4 · 节点扩展注册
 *  ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
 *  3.5 · 端口胶囊装配 / 卸载（统一收口，幂等）
 *
 *  装配顺序不可颠倒：先「网格锚点」保住宿主 [data-widgets-grid-node-id]，
 *  再「端口胶囊」换皮上妆。胶囊模块自身会在找不到宿主时静默退出。
 *
 *  为什么要收口成一个函数：装配点有 4 处（nodeCreated / loadedGraphNode /
 *  onNodeCreated / configure），卸载点 1 处（onRemoved），刷新点 1 处（onResize）。
 *  收口后各钩子只写一行，顺序与依赖注入口径永远一致。
 *
 *  依赖注入：把本模块的 alog / safeCall 传进子模块，避免子模块反向 import
 *  造成 ESM 循环依赖的 TDZ 崩溃（与 initAppearanceDeps 同一手法）。
 *  ══════════════════════════════════════════════ */

/** 装配端口（网格锚点 → 端口胶囊），幂等；可在任意时机重复调用。 */
function attachA001Ports(node) {
    safeCall(() => attachA001GridAnchor(node, { alog, safeCall }), undefined, "装配网格锚点");
    safeCall(() => attachA001PortCapsule(node, { alog, safeCall }), undefined, "装配端口胶囊");
    /* ★★ 把「刷新端口胶囊」的出口挂到节点上（每实例一份）。
     *  用途：其他模块（A001_Appearance 的按键回调）在触发会重建节点 DOM 的操作后
     *  主动补一次刷新，而无需反向 import 本模块（避免循环依赖，与
     *  initAppearanceDeps / initRunDeps 同一注入范式）。
     *  典型场景：点击「运行」→ graphToPrompt 遍历展开子图 → 官方切换执行态 class
     *  → Vue 重渲染节点 DOM → 胶囊换皮类名丢失（用户看到「点运行时节点闪一下」）。
     *  刷新逻辑复用 refreshPortsAfterHiddenToggle 的「同帧 + 双 rAF」组合。 */
    node._a001RefreshPorts = () => refreshPortsAfterHiddenToggle(node);
    /* ★ 读回「隐藏控件」的存档状态（双 rAF 后读 —— properties 在 configure 之后才被还原）。
     *  四个装配钩子都会走到这里，故刷新 / 加载 / 新建 / 撤销复用四条路径全覆盖。 */
    scheduleA001HiddenRestore(node);
    /* ★ 按存档回灌内层节点的 mode（修复「A004 视频开关刷新后变开」）。
     *  与上面同一时机（properties 在 configure 之后才还原），四路径全覆盖 ——
     *  不依赖 ensureSubgraph 走哪个分支。 */
    scheduleA001ModesRestore(node);
    /* ★ 读回「加载开关」的存档状态并回填按键图标（同上，properties 在 configure 后还原）。
     *  排程逻辑封装在 A001_disguise.js，移除该功能时一并删除本行即可。 */
    scheduleA001ComfyTVSwitchSync(node);
    /* ★ 尾随重试：胶囊的首轮上妆队列只有 0~900ms（见 TICK_DELAYS），
     *  而工作流加载 / 切换画布 / 搜索结果建节点等路径下，节点 DOM 可能更晚才出现，
     *  那一轮会全部扑空。这里补 4 拍长间隔重试（仅在「已装配但尚未观测到节点根」时），
     *  成本极低（每拍一次 querySelector），保证 DOM 晚到也能上妆。 */
    scheduleA001PortsLateRetry(node);
    /* ★ 提升文本框原生纵向拖拽（照搬 008_ComfyTV Custom Stage）：
     *  给节点内网格里的官方 <textarea> 补 resize:vertical（浏览器原生手柄，仅右下角）；
     *  拖拽改变的高度由 A001_Appearance 的高度归属记账（观察 host/预览框）自动同步节点高，
     *  本模块只额外负责「把高度存进 properties，元素重建时读回」，故无需回调。 */
    safeCall(
        () => attachA001TextareaResize(node),
        undefined,
        "装配文本框原生拖拽",
    );
    /* ★ 提升数值控件 · 滑条：给带 min/max 的 INT/FLOAT 控件上「轨道 + 填充 + 滑块」并绑拖拽。
     *  此刻控件行可能尚未由 Vue 渲染出来（DOM 晚到），故这里只是「尽力一次」；
     *  真正的兜底由统一恢复中枢的巡检负责（判据见 A001_restore._evaluateNode 的第 ⑤ 条）。 */
    safeCall(() => refreshA001Sliders(node), undefined, "装配数值控件滑条");
    /* ★ 滑条的**延迟重试链**（DOM 晚到兜底，实测必需）：
     *  首次调用时官方控件行往往还没由 Vue 渲染出来（实测返回 0，滑条不上妆）。
     *  这里补几拍重试，命中即停；仍不命中则由统一恢复中枢的巡检兜底
     *  （判据见 A001_restore._evaluateNode 的第 ⑤ 条）。 */
    scheduleA001SlidersRetry(node);
    /* ★★ 登记进统一恢复中枢：此后该节点的外观恢复由中枢统一调度，
     *  各模块自己的巡检作为「兜底」保留（中枢失效时仍能自愈）。 */
    safeCall(() => registerA001Node(node), undefined, "登记统一恢复中枢");
}

/** 滑条上妆的尾随重试（DOM 晚到兜底）；幂等，成功即停。 */
function scheduleA001SlidersRetry(node) {
    if (!node || node._a001SliderRetryTimer) return;
    let step = 0;
    /* 退避阶梯：覆盖「Vue 首帧 → 面板/网格挂载 → 控件行渲染」的完整窗口。 */
    const DELAYS = [0, 120, 320, 700, 1200];
    const again = () => {
        node._a001SliderRetryTimer = null;
        if (!isNodeInGraph(node)) return;
        let ok = 0;
        safeCall(() => { ok = refreshA001Sliders(node) || 0; }, undefined, "滑条尾随上妆");
        step += 1;
        /* 已上妆成功（返回 >0）或已达重试上限 → 停止。 */
        if (ok > 0 || step >= DELAYS.length) return;
        node._a001SliderRetryTimer = setTimeout(again, DELAYS[step] || 1000);
    };
    node._a001SliderRetryTimer = setTimeout(again, DELAYS[0]);
}

/** 端口胶囊的尾随补挂（DOM 晚到兜底）；幂等，成功即停。 */
function scheduleA001PortsLateRetry(node) {
    if (!node || node._a001PortsLateTimer) return;
    let step = 0;
    const again = () => {
        node._a001PortsLateTimer = null;
        /* 已卸载（节点删除）或已成功观测到节点根 → 停止补挂 */
        if (!node._a001PortCapsuleOn || node._xzgA001CapObservedRoot) return;
        safeCall(() => attachA001PortCapsule(node, { alog, safeCall }), undefined, "端口胶囊尾随补挂");
        step += 1;
        if (step >= 4) return;
        node._a001PortsLateTimer = setTimeout(again, 1000);
    };
    node._a001PortsLateTimer = setTimeout(again, 1200);
}

/** 卸载端口（端口胶囊 → 网格锚点），幂等；节点删除时调用。 */
function detachA001Ports(node) {
    if (node._a001PortsLateTimer) {
        clearTimeout(node._a001PortsLateTimer);
        node._a001PortsLateTimer = null;
    }
    /* ★ 取消在途的尺寸刷新 rAF：onResize 排下的帧回调若在节点删除之后才执行，
     *   仍会对已移除的节点跑 refreshA001PortCapsule / refreshA001Sliders（无谓 DOM 查询）。 */
    if (node._a001PortRefreshRaf && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(node._a001PortRefreshRaf);
        node._a001PortRefreshRaf = 0;
    }
    /* 滑条尾随重试定时器同样要清（避免节点删除后回调仍跑）。 */
    if (node._a001SliderRetryTimer) {
        clearTimeout(node._a001SliderRetryTimer);
        node._a001SliderRetryTimer = null;
    }
    /* 清掉注入给外观模块的刷新出口（闭包持有 node，节点删除后不应再被调用）。 */
    node._a001RefreshPorts = null;
    safeCall(() => detachA001PortCapsule(node), undefined, "卸载端口胶囊");
    safeCall(() => detachA001GridAnchor(node, { safeCall }), undefined, "摘除网格锚点");
    /* ★ 卸载文本框拖拽手柄：清巡检定时器 + 解绑 textarea 事件监听。 */
    safeCall(() => detachA001TextareaResize(node), undefined, "卸载文本框拖拽手柄");
    /* ★ 卸载数值控件滑条：摘掉自绘元素、拖拽监听与标记（官方 DOM 自动恢复原样）。 */
    safeCall(() => detachA001Sliders(node), undefined, "卸载数值控件滑条");
    /* ★ 从统一恢复中枢注销（节点删除后不应再被调度）。 */
    safeCall(() => unregisterA001Node(node), undefined, "注销统一恢复中枢");
}

/* ⚠️ 以下四处装配必须放进「微任务」，禁止顶层同步调用（血泪教训，勿回退）：
 *
 * ComfyUI 会把 WEB_DIRECTORY（本项目为 js/）下的**每个 .js 都当成扩展入口**加载
 * （实测 /api/extensions 清单里包含 js/A001/ 下的全部文件），
 * 因此 A001_Appearance.js、A001_workflow.js 等也会成为入口，而入口顺序并不固定。
 *
 * 一旦本次求值是由「A001_Appearance.js / A001_workflow.js 先加载」的环形依赖驱动，
 * 本模块的顶层代码就会早于 A001_Appearance.js 的顶层执行；此时它的 `let alog`
 * 仍在 TDZ，调用 initAppearanceDeps 立即抛：
 *     ReferenceError: Cannot access 'alog' before initialization
 * 该异常使整个 A001 模块求值失败 → 下方 app.registerExtension 根本不执行
 * → 扩展列表里没有 "ABC.Node" → 面板 / 端口胶囊 / 运行键全部静默消失（实测复现）。
 *
 * 包进 queueMicrotask 后，等环上各方求值完成再注入，彻底消除该竞态。
 * （下方的 app.registerExtension 保持在顶层：它只登记钩子，不触碰跨模块变量。） */
queueMicrotask(() => {
    /* ★★ 注入统一恢复中枢（A001_restore.js）的恢复任务表。
     *  各模块不再「各自巡检、各自重建」，而是把「怎么恢复」注册到这里，
     *  由中枢统一决定「何时恢复、以什么顺序恢复、是否真的需要恢复」。
     *  详见 A001_restore.js 头注的系统性问题说明。 */
    initA001Restore({
        /* 端口胶囊：补类名 + 重建桶 + 重绑 hover + 重写中心线 + 同步端点。 */
        capsule(node) {
            safeCall(() => refreshA001PortCapsule(node), undefined, "恢复:端口胶囊");
        },
        /* 连接线端点：按 DOM 实测重写 slot.pos 与官方 layoutStore。 */
        slotPos(node) {
            safeCall(() => nudgeA001PortCapsule(node), undefined, "恢复:端口锚点");
        },
        /* 文本框：补作用域/排列类名 + 读回存档高度 + 重挂 RO。 */
        textarea(node) {
            safeCall(() => scanA001Textarea(node), undefined, "恢复:文本框");
        },
        /* 面板：补挂 / 校正位置 / 同步内部两框顺序。 */
        panel(node) {
            safeCall(() => ensureA001Panel(node), undefined, "恢复:面板");
        },
        /* 高度模型：补 data-a001-height 并收敛一次。 */
        height(node) {
            safeCall(() => resyncA001SizeLock(node), undefined, "恢复:高度模型");
        },
        /* 收起标记：补 data-a001-collapsed 与网格 display。 */
        hiddenCls(node) {
            safeCall(() => syncA001HiddenClass(node), undefined, "恢复:收起标记");
        },
        /* 滑条：给提升的 INT/FLOAT 数值控件补外观与拖拽（幂等）。 */
        slider(node) {
            safeCall(() => refreshA001Sliders(node), undefined, "恢复:滑条");
        },
        /* 子图身份：node.subgraph 丢失时依据存档补建。
         * ★ 这是官方「进入子图」入口（Vue NodeFooter 的 isSubgraph 判据）的
         *   唯一依赖来源，复制粘贴/反序列化竞态下必须能自愈，故纳入每拍巡检。 */
        subgraph(node) {
            safeCall(() => ensureSubgraphIfMissing(node), undefined, "恢复:子图身份");
        },
    });

    /* ★★ 把提升控件簇的能力注入插槽同步簇（A001_slots.js）。
     *  必要性：子图槽连接事件（input-connected / input-added）需要在**建投影那一刻**
     *  立即用内层 widget 在外层槽上挂 host widget；而这几个函数属于本文件的提升簇。
     *  若由 A001_slots.js 反向 import 本模块，会形成「入口 ⇄ 插槽簇」循环依赖 ——
     *  与 initAppearanceDeps / initRunDeps / initPromptDeps 同一注入范式。
     *  ⚠️ 必须放在 queueMicrotask 内：ComfyUI 把 js/ 下每个 .js 都当扩展入口加载，
     *     入口顺序不固定；顶层调用会撞上 TDZ（Cannot access before initialization）。 */
    initSlotDeps({
        createPromotedHostWidget,
        mountPromotedWidget,
        writePromotedPersist,
        touchA001Inputs,
    });

    /* ★★ 把外观 / 胶囊 / 滑条 / 编辑器能力注入「收起状态与尺寸」簇（A001_hidden.js）。
     *  必要性：收起/展开控件与默认宽度落地都需要刷新面板位置、胶囊几何、滑条与编辑器；
     *  若由 A001_hidden.js 反向 import 本模块或那些模块，会形成循环依赖 ——
     *  与 initSlotDeps 同一注入范式，注入时机同样必须在 queueMicrotask 内。 */
    initHiddenDeps({
        refreshA001PortCapsule,
        nudgeA001PortCapsule,
        resyncA001SizeLock,
        refreshA001Sliders,
        repositionA001Panel,
        suppressA001CapsuleOpen,
        refreshA001PromptEditors,
        touchA001Inputs,
    });

    /* 把本模块的工具函数注入外观模块（A001_Appearance.js），
     * 使其无需反向 import 本模块，避免循环依赖。 */
    initAppearanceDeps({
        alog,
        safeCall,
        toggleA001WidgetsHidden,
        isA001WidgetsHidden,
        /* ★ 运行按键功能（复刻 008_ComfyTV Custom Stage 运行键）：
         *  仅注入行为，不改外观模块对按键的排布与样式。 */
        runA001Node,
        queryA001RunState,
        /* ★「加载开关」按键：查询/切换「能否被 ComfyTV 识别展开」。
         *  逻辑实现在 A001_disguise.js，此处仅注入行为（外观模块不反向 import）。 */
        isA001ComfyTVEnabled,
        toggleA001ComfyTVEnabled,
    });

    /* 把运行态的刷新出口注入运行模块（A001_run.js），避免其反向 import 本模块。
     * 运行态一变即定向刷新对应节点的运行按键文案/配色。 */
    initRunDeps({
        notifyA001RunState(node) {
            const btn = node?._a001RunBtn;
            if (btn) {
                safeCall(() => refreshA001RunButton(btn, node), undefined, "运行按键状态回填");
            }
        },
        refreshA001RunPreview(node) {
            safeCall(() => refreshA001Preview(node), undefined, "运行结束重绘预览");
        },
    });

    /* ★ 把 @文本编辑器（A001_prompt_editor.js）所需的私有能力注入进去，
     *  避免它反向 import 本模块造成 ESM 循环依赖（与 initAppearanceDeps /
     *  initRunDeps 同一手法）。注入项逐条说明：
     *   · getStore          —— widgetValueStore 探测链（本模块私有，不复制以免漂移）
     *   · refreshPortCapsule—— 编辑器挂载后刷新端口胶囊几何
     *   · dirtyCanvas       —— 同帧去重重绘
     *   · isMultilineWidget —— 复用本节点的「是否多行文本」判定，与投影层归一化口径一致
     *   · isWidgetsHidden   —— 「隐藏控件」态下跳过挂载（doc 保留在 properties）
     *   · syncNodeHeight    —— 编辑器右下角手柄拖高后，把节点总高同步一次
     *     （映射 resyncA001SizeLock：「行 min-height 撑大 → chrome 变大 → 节点加高」，
     *       预览框高度不变，与原生 textarea 拖拽联动同口径）
     *  ★ 刻意不注入 resizeAfterPromotedChange：编辑器高度零干预，
     *    不许由代码触发 node.setSize()（会与用户拉伸打架）。 */
    initPromptDeps({
        getStore: a001WidgetValueStore,
        refreshPortCapsule: refreshA001PortCapsule,
        dirtyCanvas,
        isMultilineWidget: isA001MultilineWidget,
        isWidgetsHidden: isA001WidgetsHidden,
        syncNodeHeight: resyncA001SizeLock,
        /* 画布缩放：编辑器拖拽手柄按它把「屏幕像素位移」换算成「布局像素增量」，
         * 否则缩放后的画布里手柄不跟手（详见 A001_prompt_editor 的 onMove 注释）。 */
        canvasScale: () => Number(app?.canvas?.ds?.scale) || 1,
    });

    /* 控制台诊断入口：inspectA001PromptEditor(app.graph._nodes[0])。
     * 返回网格定位、各槽定位策略、textarea 隐藏态、doc 统计等快照；
     * 其 widgetsHaveOurDom 恒应为 false（为 true 即误走了 addDOMWidget）。 */
    try {
        globalThis.inspectA001PromptEditor = inspectA001PromptEditor;
    } catch (_e) { /* 非浏览器环境忽略 */ }

    /* 模块加载即安装全局执行事件监听（executing / progress / execution_success ...）。
     * 内部自检 window.__a001RunHooked，重复调用无副作用。
     * 复刻 008_ComfyTV executionStore.ts:bindToApi 的事件集合，取与运行按键相关的最小集。 */
    installA001RunHooks();

    /* 模块加载即安装全局预览监听（executed / execution_cached）。
     * 内部自检 window.__a001ExecutedHooked，重复调用无副作用。
     * 参考官方前端事件总线：api.addEventListener 挂在全局 api 事件流上，
     * 与 A005/A006 预览采用同一范式（未逐行引用，原因：压缩产物）。 */
    installA001PreviewRefresh();
});

app.registerExtension({
    name: "ABC.Node",
    /* ★ 连接线中点数字徽标：在画布就绪后挂钩 canvas.drawConnections。
     *  为什么放 setup 而非 nodeCreated：徽标是**画布级**装饰（跨节点、
     *  画在所有连线之上），只需装一次，不该随每个节点重复安装。
     *  setup 时机上 app.canvas 可能尚未就绪 → 带重试兜底（最多 10 次 × 300ms）。 */
    setup() {
        let tries = 0;
        const tryInstall = () => {
            const ok = safeCall(() => installA001LinkBadges(), false, "安装连线徽标");
            if (ok) return;
            tries += 1;
            if (tries < 10) setTimeout(tryInstall, 300);
        };
        tryInstall();

        /* ★ 原生子图伪装（开关版）：安装序列化 patch（装一次即可，幂等）。
         *  保存时把「加载开关」已打开的 A001 序列化成顶层 definitions.subgraphs +
         *  type=UUID，供 Custom Stage 等外部工具识别内层；开关关闭的节点不受影响。
         *  window.LGraph 在 setup 早期可能未就绪 → 模块内部自带重试兜底。 */
        safeCall(() => installA001Disguise(), undefined, "安装原生子图伪装(开关版)");
    },
    /* ★ 原生子图伪装 · 反序列化还原：工作流加载 configure 之前，把 type=UUID 且
     * properties['Node name for S&R']='A001_SubgraphNode' 的节点改回 A001_SubgraphNode，
     * 让 createNode 直接建成 A001 节点（真正换类、恢复全部自定义功能），
     * 并顺手把该节点的「加载开关」标为开（它是伪装形态存盘的）。
     * 该钩子是官方 registerExtension 的标准方法（groupNode 扩展同款用法）。 */
    beforeConfigureGraph(graphData) {
        safeCall(() => onBeforeConfigureGraph(graphData), undefined, "伪装还原(beforeConfigureGraph)");
    },
    // 新建节点：同步建子图（保证原生「进入子图」入口可用）+ 插入底框
    nodeCreated(node) {
        if (node.constructor?.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
            safeCall(() => applyA001DefaultSize(node), undefined, "新建默认宽度");
            try {
                ensureSubgraph(node);
            } catch (e) {
                alog("nodeCreated ensureSubgraph 失败:", e);
            }
            safeCall(() => ensureA001Panel(node), undefined, "节点面板");
            safeCall(() => attachA001Preview(node), undefined, "注册预览");
            /* ★ 执行展开钩子必须装：否则官方 graphToPrompt 探测到
             * isSubgraphNode 为真、却找不到 getInnerNodes → 抛
             * "this.node.getInnerNodes is not a function"，整个 prompt 构建中断。 */
            safeCall(() => attachExecutionHooks(node), undefined, "安装执行展开钩子");
            // 注册进运行系统（运行按键功能复刻自 008_ComfyTV Custom Stage）
            safeCall(() => attachA001Run(node), undefined, "注册运行");
            /* ★ 端口胶囊（复刻 008_ComfyTV 端口外观）：装配点之一。
             *  必须放在 installA001WidgetProjection 之后（网格锚点要塞进它建立的
             *  投影白名单 _a001ExtraWidgets）—— 见下方 onNodeCreated 钩子。 */
            attachA001Ports(node);
            /* ★ @文本编辑器：把提升上来的多行文本控件换成自研富文本编辑器。
             *  必须在投影层装好之后（依赖 widgets 投影做定位兜底），
             *  且自身带重试链（DOM 未就绪时自动补挂）。 */
            safeCall(() => attachA001PromptEditor(node), undefined, "装配 Prompt 编辑器");
        }
    },
    // 工作流加载/反序列化路径可能不触发 nodeCreated，补挂一次（幂等）
    loadedGraphNode(node) {
        if (node.type === NODE_TYPE) {
            try {
                ensureSubgraph(node);
            } catch (e) {
                alog("loadedGraphNode ensureSubgraph 失败:", e);
            }
            safeCall(() => ensureA001Panel(node), undefined, "节点面板");
            safeCall(() => attachA001Preview(node), undefined, "注册预览");
            safeCall(() => attachExecutionHooks(node), undefined, "安装执行展开钩子");
            safeCall(() => attachA001Run(node), undefined, "注册运行");
            /* ★ 端口胶囊装配点之一（工作流加载路径） */
            attachA001Ports(node);
            /* ★ @文本编辑器装配点之一（工作流加载路径） */
            safeCall(() => attachA001PromptEditor(node), undefined, "装配 Prompt 编辑器");
        }
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        /* ★ 媒体源变化监听必须**先于**下面的 A001 类型判断安装：
         *  它要作用于 LoadImage/LoadVideo/LoadAudio 这类**非 A001** 节点类型
         *  （上游素材换图时刷新编辑器 @ 缩略图）。内部按名字筛选，非媒体源直接返回。 */
        safeCall(() => a001InstallMediaSourceWatch(nodeType, nodeData), undefined, "安装媒体源变化监听");
        if (nodeData.name !== NODE_TYPE) return;
        /* 创建钩子：投影层必须最早装（Vue 首次读 node.widgets 即需含提升行），
         * 然后建子图/挂插槽同步/重建提升，最后补挂外观面板。 */
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            safeCall(() => installA001WidgetProjection(this), undefined, "安装提升控件投影");
            if (onNodeCreated) onNodeCreated.apply(this, arguments);
            /* ★ 默认宽度兜底：nodeCreated 钩子在部分路径不触发（如程序化建节点），
             * 这里补一次；函数幂等，且会跳过反序列化出来的节点。 */
            safeCall(() => applyA001DefaultSize(this), undefined, "新建默认宽度");
            try {
                if (!this.subgraph) ensureSubgraph(this);
            } catch (e) {
                alog("onNodeCreated ensureSubgraph 失败:", e);
            }
            safeCall(() => ensureA001Panel(this), undefined, "节点面板");
            safeCall(() => attachA001Preview(this), undefined, "注册预览");
            safeCall(() => attachExecutionHooks(this), undefined, "安装执行展开钩子");
            /* ★ 端口胶囊装配点之一：本钩子第 1 行已装好投影层，
             *  网格锚点依赖该投影白名单，故此处装配时序正确。 */
            attachA001Ports(this);
            /* ★ @文本编辑器装配点之一（程序化建节点路径） */
            safeCall(() => attachA001PromptEditor(this), undefined, "装配 Prompt 编辑器");
        };
        /* 官方子图身份契约 LGraphNode.prototype.isSubgraphNode()：
         * ComfyUI 原生据此渲染「进入子图」入口，并在点击时二次校验。
         * 官方 SubgraphNode 类恒返回 true、LGraphNode 基类恒返回 false；
         * 本节点是普通 LGraphNode，只能按「是否持有子图」作答。 */
        nodeType.prototype.isSubgraphNode = function () {
            return !!this.subgraph;
        };
        /* 配置恢复钩子：工作流反序列化后重建子图，随后交给官方机制接管。 */
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            /* ★ 复位「id 已重映射」标记：本次反序列化将重新执行一次重映射
             *  （节点对象可能被撤销/重做复用，不能让上一轮标记漏过来）。 */
            this.__a001RemapDone = false;
            /* ★★ 复制粘贴/反序列化 id 重映射（重写版，浏览器实测 2026-10-03）：
             *  必须在 onConfigure.apply 之前执行，且数据源取 info.properties
             *  （反序列化时 this.properties 尚未还原，只有 info.properties 有值）。
             *
             *  为什么放在这里而非 ensureSubgraph 内：
             *    configure 钩子里 ensureSubgraph 会因「node.subgraph 已存在」或
             *    「this.properties 未还原→saved 为空」而走快速返回，导致
             *    _remapSubgraphOnIdConflict 被跳过（实测重映射日志 0 行）。
             *    故在此【无条件】对 info.properties.subgraph_data_json 做全局唯一 id
             *    重映射（基于 rootGraph.state），并同步写回 info 与 this，确保后续
             *    官方/自身建图用的都是已重映射的数据。
             *
             *  ★ 为什么需要（v0.38.x 复制粘贴 link 52→14→7→0）：
             *    官方 remapClipboardSubgraphNodeIds 只重映射官方子图 e.subgraphs 的
             *    node.id（patchLinkNodeIds 仅同步 origin/target），完全不碰 link.id /
             *    reroute.id，也不碰 A001 的私有 subgraph_data_json。而 A001 自建子图走
             *    normalizeSubgraphDefinitions 同样只 remint node id → link/reroute id
             *    与 rootGraph 注册表冲突 → replaceLink/registerReroute 拒绝 → link 丢失。 */
            safeCall(() => {
                const props = info && info.properties ? info.properties : null;
                if (!props) return;
                const g = getNodeGraph(this) || app?.rootGraph || app?.graph;
                const root = g?.rootGraph || g;

                /* ── 第一步：重映射内嵌子图定义（embedded_subgraph_defs_json）──
                 *  ★ 关键（浏览器实测 2026-10-03「进入子图无法识别 / 标题栏消失」根因）：
                 *    内嵌子图定义的 id 若与源节点相同，两节点会共享同一份定义，
                 *    rootGraph.subgraphs 里同一 id 只有一份 → 引用冲突/被覆盖 →
                 *    进入子图时无法识别、标题栏与退出按钮丢失。
                 *    故必须为每个 def 换【全新 uuid】，并重映射其内部 id，
                 *    再把 subgraph_data_json 中引用该 def 的节点 type 同步为新 uuid。 */
                let defIdMap = null;
                const rawDefs = props.embedded_subgraph_defs_json;
                if (typeof rawDefs === "string" && rawDefs.length) {
                    defIdMap = new Map();
                    const defs = JSON.parse(rawDefs);
                    if (Array.isArray(defs)) {
                        for (const def of defs) {
                            if (!def) continue;
                            /* ★ 不再手动改 def.id（原实现写 def.id = uuidv4()）：
                             *   那样会与官方 createSubgraph→normalizeSubgraphDefinitions
                             *   的 id 分配重复、互相打架 —— normalize 结束后实际注册的
                             *   subgraph.id 与 subgraph_data_json 里记录的 type 不一致，
                             *   内层 SubgraphNode 变成未知节点、「进入子图」入口消失。
                             *   现统一交给 remapA001ClipboardData：它为 subgraph 自身
                             *   分配全新 uuid（subgraphIdMap 记录映射），并同步内部
                             *   node/link/reroute/group id；调用方再用映射修正 type 引用。 */
                            const r = remapA001ClipboardData(def, root);
                            for (const [oldId, newId] of r.subgraphIdMap) defIdMap.set(oldId, newId);
                        }
                        props.embedded_subgraph_defs_json = JSON.stringify(defs);
                        this.properties = this.properties || {};
                        this.properties.embedded_subgraph_defs_json = props.embedded_subgraph_defs_json;
                    }
                }

                /* ── 第二步：重映射主数据（subgraph_data_json）── */
                const raw = props.subgraph_data_json;
                if (typeof raw === "string" && raw.length) {
                    const data = JSON.parse(raw);
                    if (data && typeof data === "object") {
                        remapA001ClipboardData(data, root);
                        // 同步内嵌子图引用：把节点 type（= 旧 def uuid）替换为新 uuid
                        if (defIdMap && defIdMap.size) {
                            const fixType = (t) => (typeof t === "string" && defIdMap.has(t)) ? defIdMap.get(t) : t;
                            for (const n of data.nodes || []) if (n && n.type) n.type = fixType(n.type);
                            for (const dd of data.definitions?.subgraphs || []) {
                                for (const n of dd?.nodes || []) if (n && n.type) n.type = fixType(n.type);
                            }
                        }
                        const json = JSON.stringify(data);
                        props.subgraph_data_json = json;
                        this.properties = this.properties || {};
                        this.properties.subgraph_data_json = json;
                    }
                }

                /* ── 第三步：清掉官方可能预建的空壳/旧子图，强制 ensureSubgraph 用新数据重建 ── */
                if (this.subgraph) {
                    safeCall(() => this.subgraph.clear?.(), undefined, "清空预建/旧子图");
                    this.subgraph = null;
                }
                /* ★ 置位：本次反序列化的重映射已完成，让 ensureSubgraph 的
                 *   _remapSubgraphOnIdConflict 跳过，避免对同一份数据重复取号。 */
                this.__a001RemapDone = true;
            }, undefined, "configure: 复制粘贴 id 重映射");
            if (onConfigure) onConfigure.apply(this, arguments);
            /* ★★ 置「来自工作流存档」标记 —— 这是唯一可靠的判据。
             * 官方反序列化顺序为 `onNodeCreated` → `configure`：本钩子跑完后
             * `node.properties` / `node.size` 才被还原。applyA001DefaultSize 的
             * 落地闭包（rAF）晚于本钩子，靠此标记跳过，才不会把恢复好的宽度
             * 又覆盖成默认 250。详见同文件 applyA001DefaultSize 注释与
             * docs/子图提升机制调研.md:2117-2144 官方原文摘录。 */
            this._a001Deserialized = true;
            try {
                ensureSubgraph(this);
            } catch (e) {
                alog("configure ensureSubgraph 失败:", e);
            }
            /* ★ 反序列化后预览状态是空的（本次会话尚未执行），此处主动重绘一次：
             *  面板若已挂好，会把「运行后显示结果」占位提示画出来；
             *  若面板还没挂，则由 ensureA001Panel 挂载完成时补画（幂等，无副作用）。 */
            safeCall(() => attachA001Preview(this), undefined, "注册预览");
            safeCall(() => refreshA001Preview(this), undefined, "反序列化后重绘预览");
            // 反序列化路径同样要补装执行展开钩子（幂等）
            safeCall(() => attachExecutionHooks(this), undefined, "安装执行展开钩子");
            safeCall(() => attachA001Run(this), undefined, "注册运行");
            /* ★ 端口胶囊装配点之一（反序列化路径，权威时序点） */
            attachA001Ports(this);
            /* ★ @文本编辑器装配点之一（反序列化路径，权威时序点）。
             *  本行位于 onConfigure.apply 之后 —— properties（含编辑器 doc 存档）
             *  已还原，此刻装配/重试才能读到正确的历史内容；
             *  若 DOM 尚未由 Vue 渲染出来，则走重试链稍后补挂。 */
            safeCall(() => attachA001PromptEditor(this), undefined, "装配 Prompt 编辑器");
        };
        /* 序列化钩子：把子图导出为本节点私有数据。
         * 导出用官方 Subgraph.asSerialisable()，不自造结构；
         * 落盘位置是本项目私有约定（官方是「节点 type 引 UUID + 顶层
         * definitions.subgraphs[]」，本节点无法改 type，故存 properties）。
         *
         * ★★ 新版 ComfyUI 的序列化入口变了（实测踩坑，勿删本条）：
         *   LGraph.serialize() → asSerialisable() → serialiseStoredNodes()
         *                         → node.serializeFromStoreState(storeState)
         *   即**优先**用 store 里的节点状态序列化，**根本不调用 node.serialize()**
         *   （只有「store 与活节点不一致」的兜底分支才会回退到 node.serialize()）。
         *   故必须同时覆盖 serializeFromStoreState，否则：
         *     · 新建 A001 节点 → 往子图加节点 → 数据只活在内存 subgraph 里；
         *     · 切换工作流 → 官方序列化走 serializeFromStoreState → 我们的
         *       subgraph_data_json 不被产出 → 切回来的子图是空的（用户症状）。
         *
         * 【导出函数】两处钩子共用，保证两条序列化路径产出一致。 */
        const exportA001Subgraph = (self) => {
            const exported = safeCall(
                () => self.subgraph?.asSerialisable?.(),
                undefined,
                "serialize: subgraph.asSerialisable"
            );
            if (!exported) return undefined;
            /* ★ 落盘必须包 safeCall：JSON.stringify 遇循环引用/BigInt 会抛错，
             * 异常一旦冒泡出去会中断整张工作流的保存。失败时保留旧值更安全。 */
            return safeCall(
                () => JSON.stringify(exported),
                undefined,
                "serialize: 子图数据序列化"
            );
        };
        /* 把导出结果写进「目标对象」的 properties（目标可能是活节点，也可能是
         * serializeFromStoreState 正在拼装的输出对象）。 */
        const putA001SubgraphJson = (target, json) => {
            if (typeof json !== "string") return;
            safeCall(
                () => {
                    target.properties = target.properties || {};
                    target.properties.subgraph_data_json = json;
                },
                undefined,
                "serialize: 子图数据落盘"
            );
        };
        /* 内嵌原生子图定义收集（两条序列化路径共用）。
         * ★ 本节点子图里若再放了官方 SubgraphNode，其定义不会随 subgraph_data_json
         *   一起走（那是本层子图的导出），必须单独收集为 ExportedSubgraph 数组落盘，
         *   恢复时 leaf-first 注册。蓝本：A005_ImageNode.js:773-787。 */
        const putA001EmbeddedDefs = (self, target) => {
            safeCall(
                () => {
                    const embeddedDefs = collectEmbeddedSubgraphDefs(self.subgraph);
                    target.properties = target.properties || {};
                    if (embeddedDefs.length) {
                        target.properties.embedded_subgraph_defs_json = JSON.stringify(embeddedDefs);
                    } else {
                        delete target.properties.embedded_subgraph_defs_json;
                    }
                },
                undefined,
                "serialize: 内嵌子图定义落盘"
            );
        };
        const onSerialize = nodeType.prototype.serialize;
        nodeType.prototype.serialize = function () {
            /* ★ 落盘前先把编辑器 DOM 状态刷回提升槽值与 properties 存档。
             *  必要性：正在编辑（未 blur）时，最新内容只在 DOM 里，
             *  若此刻保存工作流，widgets_values / 子图导出会拿到旧值。
             *  必须在 subgraph.asSerialisable() 之前执行。 */
            safeCall(() => flushA001PromptEditors(this), undefined, "落盘前刷编辑器值");
            putA001SubgraphJson(this, exportA001Subgraph(this));
            putA001EmbeddedDefs(this, this);
            return onSerialize ? onSerialize.apply(this, arguments) : undefined;
        };
        /* ★★ 新版序列化入口（关键，勿删）：
         *   serialiseStoredNodes 对「store 状态与活节点一致」的节点调用本方法，
         *   并直接采信其返回值作为该节点的序列化结果 —— node.serialize 不会被执行。
         *   故这里在官方返回值上补写我们的私有字段。
         *   ⚠️ 必须在官方实现之后调用（先拿到它按 store 状态拼好的对象），再补字段。 */
        const onSerializeFromStore = nodeType.prototype.serializeFromStoreState;
        if (typeof onSerializeFromStore === "function") {
            nodeType.prototype.serializeFromStoreState = function (storeState) {
                /* ★ 落盘前先把编辑器 DOM 状态刷回提升槽值与 properties 存档
                 *  （与 node.serialize 同一必要性：未 blur 时最新内容只在 DOM）。 */
                safeCall(() => flushA001PromptEditors(this), undefined, "落盘前刷编辑器值(store)");
                const out = onSerializeFromStore.apply(this, arguments) || {};
                putA001SubgraphJson(out, exportA001Subgraph(this));
                putA001EmbeddedDefs(this, out);
                return out;
            };
        }
        /* ══ 节点右键菜单：提升/管理子图内部控件端口 ══ */
        nodeType.prototype.getExtraMenuOptions = function (graphManager, options) {
            const menu = Array.isArray(options) ? options : [];
            try {
                const sg = this.subgraph;
                if (!sg) return menu;
                const node = this;
                const items = listPromotableWidgets(this);
                const promotedInputs = (this.inputs || []).filter((i) => i._a001Source);
                menu.push(null);
                if (!items.length) {
                    menu.push({ content: "提升控件到端口（子图内暂无可提升控件）", disabled: true });
                } else {
                    const byNode = new Map();
                    for (const it of items) {
                        const already = promotedInputs.some(
                            (p) => p._a001Source
                                && String(p._a001Source.nodeId) === String(it.node.id)
                                && p._a001Source.widgetName === it.widget.name
                        );
                        const key = it.node.title || it.node.type || `node ${it.node.id}`;
                        if (!byNode.has(key)) byNode.set(key, []);
                        byNode.get(key).push({ it, already });
                    }
                    const promoteGroup = [];
                    for (const [nodeLabel, list] of byNode) {
                        const sub = [];
                        for (const { it, already } of list) {
                            sub.push({
                                content: already ? `${it.widget.name}（已提升）` : it.widget.name,
                                disabled: already,
                                callback: () => {
                                    if (already) return;
                                    const r = promoteWidgetToPort(node, it.node, it.widget);
                                    if (!r.ok) alog("提升失败:", r.reason);
                                },
                            });
                        }
                        promoteGroup.push({ content: `◆ ${nodeLabel}`, submenu: { title: nodeLabel, options: sub } });
                    }
                    menu.push({
                        content: "提升控件到端口",
                        submenu: { title: "提升控件到端口", options: promoteGroup },
                    });
                }
                if (promotedInputs.length) {
                    const demoteSub = promotedInputs.map((inp) => ({
                        content: inp.name,
                        callback: () => {
                            const i = (node.inputs || []).findIndex((x) => x === inp);
                            if (i >= 0) demoteWidgetFromPort(node, i);
                        },
                    }));
                    menu.push({
                        content: "取消端口提升",
                        submenu: { title: "取消端口提升", options: demoteSub },
                    });
                }
                return menu;
            } catch (e) {
                alog("getExtraMenuOptions 失败:", e);
                return menu;
            }
        };
        /* 拉伸钩子：面板宽度由文档流决定、无尺寸反推，拉伸时仅在塌陷场景重算。
         *
         * ★★ 这里**不再**调用任何高度同步（本轮重构，实测踩坑）：
         *   Custom Stage 完全没有 onResize 钩子 —— 它的「用户拉伸」检测全部由
         *   bindCardHeight 的 ResizeObserver 判据完成：
         *       chromeOf() 没变、但 node.size[1] 变了 → sample()（刷新基线）
         *   若我们在这里再调 apply()，就会与模型自身的判据打架：
         *   用户拉伸的**那一刻** chrome 还没重排完，apply() 会用旧 chrome 反算，
         *   把刚拉出来的尺寸又改回去 —— 正是「拉伸手感不对 / 高度乱跳」的根因之一。
         *   故此处只保留「面板补挂」与「端口胶囊重算」，高度交给模型自己。 */
        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function () {
            if (onResize) onResize.apply(this, arguments);
            try { ensureA001Panel(this); } catch (_e) { /* 面板补挂失败忽略 */ }
            /* ★ @文本编辑器：轻量刷新（不重建 DOM）。
             *  尺寸变化后节点 DOM 可能被 Vue 重建 → 校验归属并重设 textarea 隐藏；
             *  编辑器若已脱离则在内部走重挂。 */
            safeCall(() => refreshA001PromptEditors(this), undefined, "编辑器随尺寸刷新");
            /* ★ 尺寸变了 → 端口桶的垂直中心线必须重算（胶囊垂直居中的基准），
             *  同时补一次上妆（尺寸变化后 Vue 可能重建槽位 DOM）。
             *  ⚠️ 用 rAF 节流（实测踩坑，勿改回同步直调）：
             *    拖拽文本框 / 连续拉伸时节点尺寸**每帧都变**，onResize 会每帧触发；
             *    若每帧同步跑 refreshA001PortCapsule（含 collectClusters 的 DOM 查询
             *    与 syncSlotPosFromDom 的几何计算），拖拽会明显发涩、不如 Custom Stage 丝滑。
             *    节流后每帧最多执行一次，肉眼无差、手感顺滑。 */
            if (typeof requestAnimationFrame === "function") {
                if (!this._a001PortRefreshRaf) {
                    this._a001PortRefreshRaf = requestAnimationFrame(() => {
                        this._a001PortRefreshRaf = 0;
                        safeCall(() => refreshA001PortCapsule(this), undefined, "端口胶囊重算中心线");
                        /* ★ 尺寸变化后控件行可能被 Vue 重建 → 滑条自绘元素丢失，补一次。
                         *  同样放进这条 rAF 节流链（避免拉伸时每帧重复查询 DOM）。 */
                        safeCall(() => refreshA001Sliders(this), undefined, "滑条随尺寸刷新");
                    });
                }
            } else {
                safeCall(() => refreshA001PortCapsule(this), undefined, "端口胶囊重算中心线");
                safeCall(() => refreshA001Sliders(this), undefined, "滑条随尺寸刷新");
            }
        };
        /* 移除钩子：清理面板 DOM、解除插槽同步监听，防节点删除后残留。 */
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            /* ★ 原钩子用 safeCall 包裹：官方 onRemoved 若抛错，下面的自身清理
             *  （释放 store 条目 / DOM / 监听）将全部被跳过 → 残留。降级而非崩溃。 */
            safeCall(() => onRemoved?.apply(this, arguments), undefined, "原 onRemoved 钩子");
            /* ★ 按节点批量清理回流反查（防止 A001_REFLOW_INDEX 随节点增删累积）。
       * 放在最前：后续 dispose/detach 可能提前丢失 inputs 引用。 */
      releaseA001NodeReflow(this);
      /* ★ 按节点批量注销提升控件的官方 store 条目。
       * 必要性：store.deleteWidget(id) 原唯一调用点 unbindOfficialPromotedWidget 只在
       * 「反提升」路径触发；整节点删除时不会走到那里，导致 widgetValueStore 条目与
       * state.callback 闭包（强引用 sourceWidget → 间接引用本节点）永久残留、无法 GC。
       * 位置：必须在 detachSlotSync 之前——它会把 _a001SyncedSg 置 null 并失去 inputs 引用。 */
      unbindAllOfficialPromotedWidgets(this);
      /* ★ 预览资源释放：把 <video>/<audio> 的 src 摘掉并 load()，
       *  否则已脱离文档的元素仍会继续解码、占用内存。必须早于 disposeA001Panel，
       *  因为后者会清掉 _a001PreviewHost 引用，之后就找不到这些元素了。 */
      safeCall(() => disposeA001Preview(this), undefined, "释放预览资源");
      safeCall(() => detachA001Preview(this), undefined, "注销预览");
      /* ★ 注销运行系统：清看门狗定时器并从运行节点集合移除，
       *  否则节点删除后其状态对象仍被集合强引用，无法 GC。 */
      safeCall(() => detachA001Run(this), undefined, "注销运行");
      /* ★ 解绑「记录 / 还原」按键：面板 DOM 即将随 disposeA001Panel 移除，
       *  显式摘掉 click 监听，避免节点对象被复用（撤销恢复）时旧监听残留。 */
      safeCall(() => unbindA001WorkflowButtons(this), undefined, "解绑记录/还原按键");
      /* ★ 卸载 @文本编辑器：在 detachA001Ports / disposeA001Panel **之前**执行 ——
       *  本模块卸载依赖节点 DOM（找 wrap、恢复 textarea 显示、摘行标记），
       *  DOM 被 Vue 回收后就清理不干净了。同时断开 MO 守卫、清重试定时器、
       *  复位复用相关标记（节点对象会被撤销/重做复用）。 */
      safeCall(() => detachA001PromptEditor(this), undefined, "卸载 Prompt 编辑器");
      /* ★ 卸载端口胶囊与网格锚点：必须早于 disposeA001Panel ——
       *  detach 依赖节点 DOM（找桶、摘类名、复位中心线变量），
       *  面板释放后节点 DOM 可能已被 Vue 回收，届时清理不干净。 */
      detachA001Ports(this);
      disposeA001Panel(this);
      detachSlotSync(this);
      /* ★ 清掉 dirtyCanvas 的同帧去重标志，避免节点对象被复用（撤销恢复）后
       * 因残留 pending=true 而永久跳过重绘。 */
      this._a001DirtyPending = false;
      /* ★ 同时取消在途 rAF：节点已删除，回调无需再跑，也不必多持有 node 引用一拍。 */
      if (this._a001DirtyRaf) {
          try { cancelAnimationFrame(this._a001DirtyRaf); } catch (_e) { /* 忽略 */ }
          this._a001DirtyRaf = 0;
      }
      /* ★ 同步复位「隐藏态恢复」排程标志：与上一条同理，双 rAF 未跑完即被删除时
       *  该标志会残留 true，节点对象被复用后 scheduleA001HiddenRestore 直接 return
       *  → 隐藏态恢复被永久跳过。 */
      this._a001HiddenRestoreScheduled = false;
      /* ★ 复位「id 已重映射」标记：节点对象被复用（撤销/重做）后需重新走一次重映射。 */
      this.__a001RemapDone = false;
        };
    },
});
