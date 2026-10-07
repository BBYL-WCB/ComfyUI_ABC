// ═══════════════════════════════════════════════════════════════
//  A001 子图节点 · 运行按键（局部执行 / 取消 / 状态回灌）
//
//  本模块只承担「运行按键点下去之后发生什么」，不负责外观。
//  由 A001_SubgraphNode.js 装配并调用：
//    · attachA001Run(node)   —— 注册节点进入运行系统（幂等）
//    · detachA001Run(node)   —— 注销节点（onRemoved 时释放监听与状态）
//    · runA001Node(node)     —— 点击运行键入口（运行中则转为取消）
//    · queryA001RunState(node) —— 供外观模块回填按键忙碌态
//
//  功能复刻来源：008_ComfyTV 的 Custom Stage 运行按键
//  对应源码（仅复刻功能，外观不复刻）：
//    · src/composables/stages/stageRun.ts
//        createStageRun().onRunRequest / onCancelRequest / 看门狗 / 事件回调
//    · src/composables/stages/queueControl.ts
//        promptInQueue() / cancelPrompt()（/queue 与 /interrupt 的取舍）
//    · src/stores/executionStore.ts
//        bindToApi() 的全局事件订阅与按节点分发（executing / progress / success ...）
//
//  官方能力引用（不重造，能引用即引用）：
//  · app.graphToPrompt()        —— 官方图转 prompt（含子图展开，本节点已装执行展开钩子）
//  · POST /prompt               —— 官方入队 HTTP 接口（ComfyUI 自带运行按键的底层通道）。
//    Body：{ prompt, client_id, partial_execution_targets }。
//    · partial_execution_targets：官方「局部执行」字段，语义为「只执行到这些目标节点
//      （含其上游依赖），下游节点不参与」。目标必须是「有输出的节点」，指向容器节点会
//      被后端以 400 prompt_no_outputs 拒绝。
//    · 响应：{ prompt_id, number, node_errors }。与 ComfyUI 自带运行按键完全一致。
//    出处：ComfyUI 后端 openapi.yaml（/prompt → partial_execution_targets：
//    "List of node names to execute"）与 tests/execution/test_execution.py
//    的 queue_prompt() 实证。
//  · api.addEventListener / api.fetchApi —— 官方事件总线与 HTTP 入口。
//
//  ★ 为什么直接走 /prompt 而不走 app.queuePrompt()：
//    008_ComfyTV 对 api.queuePrompt 打了 monkey-patch（见其源码
//    __comfytvOwnRun / rewriteGlobalRunOutput），劫持了 JS 层入队链路。
//    经 A001 实测：调用 app.queuePrompt() 会返回 true（假成功），但既不发 /prompt
//    请求、也不产生任何执行事件、队列始终为空 —— 表现为「点击运行后没反应」。
//    而 ComfyUI 自带运行按键走底层 HTTP /prompt，不受任何 JS wrapper 影响。
//    故本模块直接 POST /prompt，与自带运行按键同源同效。
//
//  ★ 局部执行的两层保证（与 ComfyTV 同构）：
//    1) prompt 只收「本节点及其上游可达节点」的输出条目（裁剪输出体积）；
//    2) 用官方 partial_execution_targets 指定执行终点，下游节点不参与。
//  ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { alog, safeCall, isNodeInGraph, showA001Toast } from "./A001_shared.js?v=20261007a";

/* ─── 官方 LiteGraph 模式常量（不重造） ─── */
/** LiteGraph.NEVER：静音节点，不参与执行。 */
const LG_MODE_NEVER = 2;
/** LiteGraph.BYPASS：旁路节点（透传）。 */
const LG_MODE_BYPASS = 4;

/** 看门狗延时（ms）：队列已空却迟迟没有 execution_success/error 时兜底复位。
 *  取值与 ComfyTV stageRun.ts 的 setTimeout(..., 3000) 一致。 */
const WATCHDOG_MS = 3000;

/** 已注册进入运行系统的 A001 子图节点（供事件回灌过滤，避免遍历全图）。 */
const A001_RUN_NODES = new Set();

/* ══════════════════════════════════════════════
 *  轻量提示条（供「上游无产物」等中止场景反馈）
 *  ★ 实现已提取到 A001_shared.js 的 showA001Toast：本模块与
 *    A001_workflow.js:showToastA001 原先各有一份完全同构的实现（jscpd 91 tokens 克隆簇）。
 *    本模块的差异在此包装中保留：safeCall 兜底 + "运行提示条" 日志标签。
 *  ══════════════════════════════════════════════ */
function notifyA001Toast(text) {
    safeCall(() => showA001Toast(text), undefined, "运行提示条");
}

/* ══════════════════════════════════════════════
 *  运行态（存在节点上，面板被 Vue 重建后可无损回填）
 *  ══════════════════════════════════════════════ */

/** 取（或初始化）节点的运行态容器。 */
function stateOf(node) {
    if (!node) return null;
    if (!node._a001RunState) {
        node._a001RunState = {
            running: false,     // 是否已入队并等待结果
            promptId: null,     // 本次执行的 prompt_id（用于事件比对）
            progress: null,     // { value, max } 进度
            error: null,        // 上次失败信息（供按键提示）
        };
    }
    return node._a001RunState;
}

/** 复位运行态（不触碰 error，错误信息留给人看）。 */
function resetRunState(node) {
    const st = stateOf(node);
    if (!st) return;
    st.running = false;
    st.promptId = null;
    st.progress = null;
    st._wdTried = null;   // 复位看门狗「已确认」记录，下一次运行才可再确认
    clearWatchdog(node);
    notifyRunState(node);
}

/** 通知外观模块刷新按键（由 A001_SubgraphNode.js 注入，避免反向 import）。 */
let notifyRunState = () => {};
/** 运行结束后触发一次预览重绘（由 A001_SubgraphNode.js 注入）。 */
let refreshPreview = () => {};

/**
 * 注入宿主提供的工具函数（打破循环依赖）。
 * @param {{notifyA001RunState?: Function, refreshA001RunPreview?: Function}} deps
 */
export function initRunDeps(deps) {
    if (typeof deps?.notifyA001RunState === "function") notifyRunState = deps.notifyA001RunState;
    if (typeof deps?.refreshA001RunPreview === "function") refreshPreview = deps.refreshA001RunPreview;
}

/* ══════════════════════════════════════════════
 *  官方能力封装：prompt 裁剪 / 入队 / 队列查询 / 取消
 *  ══════════════════════════════════════════════ */

/** 取节点所属图（与自定义节点图兼容）。 */
function graphOf(node) {
    return node?.graph || safeCall(() => app?.graph, undefined, "取图") || null;
}

/* ══════════════════════════════════════════════
 *  链式连接：上游 A001 节点识别与产物注入
 *
 *  ★ 需求（用户指定）：画布上两个 A001 节点相连时，点击运行下游 A001
 *    不得执行上游 A001，只从端口取上游已产出的数据。
 *
 *  ★ 为什么必须做（实测结论）：
 *    下游 A001 的输入端口连着上游 A001 的输出端口时，官方 graphToPrompt
 *    会把「上游 A001 容器 + 其展开的内层节点」一并写进 prompt，且下游条目
 *    对外层的引用精确指向「上游展开出的内层 feed 节点」——
 *    实测：下游容器 4964714 的 inputs.image = ["1:4964711", 0]，
 *    下游内层 4964714:5791135 的 inputs.image 同样是 ["1:4964711", 0]
 *    （其中 "1:4964711" = 上游容器 id 1 的子图内 SaveImage 节点）。
 *    而后端执行到上游 A001 容器时，其 execute() 是空壳（返回空 NodeOutput），
 *    上游子图内层节点也会被真正执行一遍 —— 既浪费算力，又不符合「只取数据」。
 *
 *  ★ 解法（官方能力优先，零拷贝）：
 *    1) 识别「直接相连」的上游 A001 节点（只看本节点 inputs 的连线来源）；
 *    2) 从上游取出其输出插槽对应的产物文件（{filename, subfolder, type}）；
 *    3) 在 prompt 里为每个这样的连接插入一个官方加载节点
 *       （LoadImage / LoadVideo / LoadAudio），widget 值写成官方
 *       「文件名 + [目录]」注解形式（如 "a.png [output]"）——官方加载节点的
 *       execute() 走 folder_paths.get_annotated_filepath()，可零拷贝直读
 *       output/temp 目录产物（出处：nodes.py LoadImage.load_image、
 *       nodes_video.py LoadVideo.execute 第 364 行）；
 *    4) 把下游对该上游的引用改写为指向新建的加载节点；
 *    5) 把上游 A001 的条目（容器 "1" 与 "1:*"）从 prompt 中整体剔除。
 *    上游从未运行、无产物文件时：提示并中止本次运行（用户指定口径）。
 * ══════════════════════════════════════════════ */

/** 由插槽类型挑选官方加载节点 class_type 与其「文件 widget 名」。
 *  出处（官方节点定义）：
 *   · LoadImage  —— nodes.py:1738，widget 名 "image"，读 input/output/temp
 *   · LoadVideo  —— comfy_extras/nodes_video.py:341，widget 名 "file"（注意不是 video）
 *   · LoadAudio  —— comfy_extras/nodes_audio.py:359，widget 名 "audio"
 *  类型串出处：comfy_api/latest/_io.py（IMAGE / VIDEO / AUDIO）。 */
function pickOfficialLoader(slotType) {
    const t = String(slotType || "").toUpperCase();
    if (t === "IMAGE" || t === "MASK") return { classType: "LoadImage", widgetName: "image", kind: "image" };
    if (t === "VIDEO") return { classType: "LoadVideo", widgetName: "file", kind: "video" };
    if (t === "AUDIO") return { classType: "LoadAudio", widgetName: "audio", kind: "audio" };
    return null;
}

/** 取链路：（与 collectReachableIds 内同款，兼容 links Map / 数组 / getLink 三形态）。
 *  ★ export 供 A001_prompt_mentions.js 复用（@引用候选需沿输入槽的 link 反查上游）。 */
export function linkById(graph, id) {
    const links = graph?.links;
    if (links && typeof links.get === "function") return links.get(id);
    return links?.[id] ?? safeCall(() => graph?.getLink?.(id), undefined, "取链路");
}

/** 判定节点是否为 A001 子图节点（运行系统的身份判据，与 A001_exec.js 契约一致）。 */
function isA001SubgraphNode(n) {
    if (!n) return false;
    return safeCall(() => !!n.isSubgraphNode?.(), false, "A001 身份判定") === true
        || String(n.type || "") === "A001_SubgraphNode";
}

/**
 * 识别「直接相连」的上游 A001 节点。
 * 只沿本节点 inputs 的连线看一层（用户指定：只处理直接相连的上游）。
 * @returns {Array<{outerInput:object, linkId:any, upstream:object}>}
 */
function identifyUpstreamA001(node) {
    const graph = graphOf(node);
    const out = [];
    if (!graph) return out;
    for (const inp of node?.inputs || []) {
        if (inp?.link == null) continue;
        const lk = linkById(graph, inp.link);
        const srcId = lk?.origin_id;
        if (srcId == null) continue;
        const hasGetById = typeof graph.getNodeById === "function";
        const src = safeCall(() => (hasGetById ? graph.getNodeById(srcId) : undefined), undefined, "取上游节点")
            || (graph._nodes || []).find((n) => String(n?.id) === String(srcId))
            || null;
        if (!isA001SubgraphNode(src)) continue;
        out.push({ outerInput: inp, linkId: inp.link, originSlot: lk?.origin_slot, upstream: src });
    }
    return out;
}

/**
 * 取上游 A001 某个输出插槽对应的产物文件描述对象 {filename, subfolder, type}。
 * 取数优先级（稳健性递增回退）：
 *   ① 运行态累积表 _a001PreviewAssets[feedId].data（本次会话执行过 → 最准）
 *   ② 持久化 properties._a001_preview.data / .cmp.data（刷新/重载后仍可用）
 * 槽 → 内层 feed 节点 id 的解析走官方 resolveSubgraphOutputLink（A001_exec.js 已装）。
 * @returns {object|null} 形如 {filename, subfolder, type}；取不到返回 null。
 * ★ export 供 A001_prompt_mentions.js 复用：@引用候选在「上游是 A001 节点」时
 *   需按输出槽取产物文件描述，与预览模块同源口径。
 */
export function upstreamSlotOutputFile(upstream, originSlot) {
    const outputs = upstream?.outputs || [];
    const outer = originSlot != null ? outputs[originSlot] : null;
    const slotId = outer?._a001SubgraphSlotId;
    /* 用官方输出槽解析拿内层 feed 节点 id（与预览模块同源）。 */
    let feedId = null;
    if (slotId != null) {
        const res = safeCall(() => upstream.resolveSubgraphOutputLink?.(slotId), null, "上游输出槽解析");
        feedId = res?.link?.origin_id;
    }
    /* ① 运行态累积表。 */
    const assets = upstream?._a001PreviewAssets || {};
    if (feedId != null && assets[String(feedId)]?.data) {
        const d = assets[String(feedId)].data;
        if (d?.filename) return { filename: d.filename, subfolder: d.subfolder || "", type: d.type || "output" };
    }
    /* ② 持久化记录（主内容 / 对比内容）。 */
    const rec = upstream?.properties?._a001_preview;
    if (rec?.data?.filename) {
        return { filename: rec.data.filename, subfolder: rec.data.subfolder || "", type: rec.data.type || "output" };
    }
    if (rec?.cmp?.data?.filename) {
        return { filename: rec.cmp.data.filename, subfolder: rec.cmp.data.subfolder || "", type: rec.cmp.data.type || "output" };
    }
    return null;
}

/**
 * 为「上游 A001 → 本节点某输入槽」这条连接，构造一个官方加载节点条目，
 * 并把 prompt 中对该上游的全部引用改写为指向它；同时登记上游条目以便剔除。
 *
 * 引用改写的实测依据：下游条目里对上游的引用形如 ["1:4964711", 0]，
 * 即「上游容器 id:上游内层 feed 节点 id」。故按前缀 "1:" 匹配即可整体命中
 * （顶层容器 "1" 的引用同样可能在下游容器条目上出现，一并改写）。
 *
 * @param {object} built 已裁剪的 { output }
 * @param {object} up    识别结果 { outerInput, linkId, originSlot, upstream }
 * @param {Set<string>} upstreamTopIds 需要从 prompt 剔除的上游顶层 id 集合
 * @param {number} seq   序号（用于生成稳定的临时节点 id）
 * @returns {object|null} { ok:true } 或 { ok:false, reason:string }
 */
function injectUpstreamFileNode(built, up, upstreamTopIds, seq) {
    const output = built.output;
    const upId = String(up.upstream.id);
    const slotType = up.outerInput?.type;
    const loader = pickOfficialLoader(slotType);
    if (!loader) {
        return { ok: false, reason: `端口「${up.outerInput?.name ?? "?"}」类型 ${slotType ?? "?"} 暂不支持自动取数` };
    }
    const file = upstreamSlotOutputFile(up.upstream, up.originSlot);
    if (!file) {
        return { ok: false, reason: `上游节点「${up.upstream.title || upId}」尚无产物，请先运行上游` };
    }
    /* 官方注解文件名：无注解时 get_annotated_filepath 会回退到 input 目录，
     * 故必须带 [output] / [temp] / [input] 后缀（folder_paths.annotated_filepath）。
     * subfolder 用正斜杠拼接（官方内部按 os.path.normpath 处理）。 */
    const dirTag = file.type || "output";
    const rel = file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename;
    const annotated = `${rel} [${dirTag}]`;

    /* 临时节点 id：与官方数字 id 体系不冲突（负数且避开 -10/-20 锚点）。 */
    const newNodeId = String(-1000 - seq);
    output[newNodeId] = {
        inputs: { [loader.widgetName]: annotated },
        class_type: loader.classType,
        _meta: { title: `上游取数·${loader.kind}` },
    };

    /* 改写 prompt 中对该上游的所有引用 → 指向新加载节点（第 0 号输出）。 */
    let rewrites = 0;
    const referencesUpstream = (ref) =>
        typeof ref === "string" && (ref === upId || ref.startsWith(upId + ":"));
    for (const entry of Object.values(output)) {
        const inputs = entry?.inputs;
        if (!inputs) continue;
        for (const [k, v] of Object.entries(inputs)) {
            if (Array.isArray(v) && referencesUpstream(v[0])) {
                inputs[k] = [newNodeId, 0];
                rewrites++;
            }
        }
    }
    /* 登记上游顶层 id（含其展开内层条目），供调用方整体剔除。 */
    upstreamTopIds.add(upId);
    alog(`链式取数 | 上游 ${upId} 槽「${up.outerInput?.name}」(${slotType})` +
        ` → ${loader.classType}「${annotated}」| 改写引用 ${rewrites} 处`);
    if (!rewrites) {
        return { ok: false, reason: `未能定位下游对上游节点「${up.upstream.title || upId}」的引用` };
    }
    return { ok: true };
}

/**
 * 收集「本节点及其上游可达节点」的 id 集合。
 * 复刻 ComfyTV graphSerialize.ts:collectReachableNodeIds —— 沿输入链路回溯，
 * 只保留链路可达且非 NEVER/BYPASS/虚拟 的节点。
 * ★ 链式场景：遇到上游 A001 子图节点时【停止回溯】——用户要求不执行上游，
 *   其数据由 injectUpstreamFileNode 以官方加载节点替代。
 */
function collectReachableIds(node) {
    const graph = graphOf(node);
    const reachable = new Set();
    if (!graph || node?.id == null) return reachable;
    /* ★ 统一用「字符串 id」入集：ComfyUI 前端节点 id 为字符串（如 "127"），
     *  而 graphToPrompt() 输出的 key 也是字符串。若混用 Number 会全部失配。 */
    reachable.add(String(node.id));

    const getLink = (id) => {
        const links = graph.links;
        if (links && typeof links.get === "function") return links.get(id);
        return links?.[id] ?? safeCall(() => graph.getLink?.(id), undefined, "取链路");
    };
    /* ★ 预建 id→节点索引：原实现每个上游节点都走 graph.getNodeById 或
     *  `_nodes.find(...)`（O(n) 线性扫描），大图回溯退化为 O(n²)。
     *  这里一次性建 Map（O(n)），后续 O(1)。 */
    const hasGetById = typeof graph.getNodeById === "function";
    const nodeIndex = new Map();
    for (const n of graph._nodes || []) {
        if (n?.id != null) nodeIndex.set(String(n.id), n);
    }
    const getNodeById = (id) =>
        safeCall(() => (hasGetById ? graph.getNodeById(id) : undefined), undefined, "按 id 取节点")
        || nodeIndex.get(String(id))
        || null;

    /* ★ 用索引游标替代 Array.shift()：shift 为 O(n)，整体退化为 O(n²)。 */
    const queue = [node];
    const seenNodes = new Set([node]);
    for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        for (const inp of cur?.inputs || []) {
            if (inp?.link == null) continue;
            const link = getLink(inp.link);
            const srcId = link?.origin_id;
            if (srcId == null) continue;
            const srcNode = getNodeById(srcId);
            if (!srcNode || seenNodes.has(srcNode)) continue;
            /* ★ 链式场景：上游是 A001 子图节点 → 不纳入可达集、不继续回溯。
             *  其数据改由 injectUpstreamFileNode 注入的官方加载节点提供，
             *  从而「只取端口数据、不执行上游」。 */
            if (isA001SubgraphNode(srcNode)) {
                alog("链式取数：跳过上游 A001 节点", String(srcId), "（不执行上游）");
                continue;
            }
            seenNodes.add(srcNode);
            reachable.add(String(srcNode.id));
            queue.push(srcNode);
        }
    }
    return reachable;
}

/**
 * ★★★ 运行前按「控制后生成」模式更新【子图内部】节点的随机种子（实测缺失，补齐）。
 *
 * 【作用对象】种子在 A001 里**通常不是提升控件**，而是子图内部节点自己的控件
 *   （如 KSampler 的 seed）。它随子图数据存在 `subgraph._nodes` 里，
 *   用户是在「进入子图」后于内层节点上设置种子的。
 *   ❌ 不要只遍历外层 `node.widgets`：那里面只有提升投影控件，碰不到内层种子
 *      （前一版就是因此「没有效果」）。
 *
 * 【为什么需要手写】官方生成前的种子处理，依赖 KSampler 这类节点上由
 *   `addValueControlWidgets` 生成的**兄弟控件** `control_after_generate`
 *   （一个 combo 控件，值为 fixed/increment/decrement/randomize）。
 *   A001 运行时不走官方的「整图生成前处理」链路（改为直发 /prompt 以做局部执行），
 *   内层节点也不在顶层图中，故那套处理不会作用到子图内部 → 种子不更新。
 *
 * 【实现口径】遍历子图内全部节点（含嵌套子图，递归）：
 *   · 找「模式控件」：name === "control_after_generate" 的 combo，取其 value 作模式；
 *     它通常紧跟在种子控件之后（官方就是相邻插入的）。
 *   · 找「种子控件」：name 匹配 seed / 随机种 / noise_seed 等，且值为数值。
 *   · 按模式改写种子 value：randomize=随机、increment=+1、decrement=-1（按 min/max 回绕）、
 *     fixed=不动。与官方语义一致。
 *   · 同时写 `widget.value` 与 `node.widgets_values` 的同名项（部分节点的值是存在
 *     widgets_values 数组里的），确保 graphToPrompt 取到新值。
 *
 * 【时机】必须在 `buildScopedPrompt`（内部调 graphToPrompt 序列化）之前调用。
 *
 * @returns {number} 实际被更新的种子控件个数（供日志）
 */
function applyA001SeedControl(node) {
    let changed = 0;
    /* 种子/模式控件的名称判据（中英文都覆盖）。 */
    const SEED_RE = /seed|随机种|种子|noise_seed/i;
    const MODE_NAME = "control_after_generate";

    const visitGraph = (g) => {
        const list = g?._nodes || g?.nodes || [];
        for (const n of list) {
            if (!n) continue;
            /* 嵌套子图：递归进去（种子可能藏在更深一层）。 */
            if (n.subgraph) visitGraph(n.subgraph);
            const ws = Array.isArray(n.widgets) ? n.widgets : [];
            if (!ws.length) continue;
            /* ① 先取本节点的模式：找名为 control_after_generate 的组合控件。
             *   值可能是英文（官方）或中文（本地化显示值），统一归一到英文语义。 */
            const modeW = ws.find((w) => String(w?.name || "") === MODE_NAME);
            let mode = String(modeW?.value ?? "fixed").trim().toLowerCase();
            /* 归一化：中文/别名 → 官方英文模式名。 */
            if (/^随机|random/.test(mode)) mode = "randomize";
            else if (/^递增.*回绕|increment.?wrap/.test(mode)) mode = "increment-wrap";
            else if (/^递减.*回绕|decrement.?wrap/.test(mode)) mode = "decrement-wrap";
            else if (/^递增|increment/.test(mode)) mode = "increment";
            else if (/^递减|decrement/.test(mode)) mode = "decrement";
            else if (/^固定|fixed/.test(mode)) mode = "fixed";
            /* 诊断：没找到模式控件时打印该节点的控件名，便于定位「选项没生效」。
             * 仅在确实存在种子控件时才打，避免刷屏。 */
            if (!modeW) {
                const hasSeed = ws.some((w) => SEED_RE.test(String(w?.name || "")));
                if (hasSeed) {
                    alog("种子诊断 | 节点", String(n.type ?? n.id),
                        "未找到 control_after_generate，实际控件名:",
                        ws.map((w) => String(w?.name || "?")).join(", "));
                }
            }
            if (!mode || mode === "fixed") continue;
            /* ② 再处理本节点的种子控件（可能有多个，如 noise_seed）。
             *   名称判据同时看 name 与 label：面板上显示的是本地化 label
             *   （如「随机种」「种子」），而 name 可能是 seed / noise_seed。
             *   排除 control_after_generate 自身（名字里也含 seed 语义的干扰项不在此列，
             *   但 combo 的名字是固定的 control_after_generate，额外防一手）。 */
            for (const w of ws) {
                const nm = String(w?.name || "");
                const lb = String(w?.label || "");
                if (nm === MODE_NAME) continue;
                if (!(SEED_RE.test(nm) || SEED_RE.test(lb))) continue;
                const cur = Number(w.value);
                if (!Number.isFinite(cur)) continue;      // 非数值（如字符串种子）不处理
                const minN = Number(w.options?.min);
                const maxN = Number(w.options?.max);
                const min = Number.isFinite(minN) ? minN : 0;
                const max = Number.isFinite(maxN) ? maxN : 0xfffffffffffff; // 官方 MAX_SEED
                let next = cur;
                /* ★ 模式名以官方 addValueControlWidgets 的选项为准（实测踩坑）：
                 *   values = ['fixed','increment','decrement','randomize']，
                 *   且 combo 控件存在时官方还会**动态追加** 'increment-wrap'
                 *   （见前端产物 settingStore-*.js: `o.options.values.push('increment-wrap')`）。
                 *   用户在下拉里选到的很可能是「increment-wrap / increment(回绕)」，
                 *   只判断 'increment' 会漏掉它 → 表现为「递增值和递减值选项没有变化」。
                 *   故四种递增/递减写法全部覆盖，并兼容 decrement-wrap。 */
                if (mode === "randomize") {
                    next = Math.floor(Math.random() * (max - min + 1)) + min;
                } else if (mode === "increment") {
                    /* 递增（不回绕）：到顶就停在 max。 */
                    next = Math.min(cur + 1, max);
                } else if (mode === "increment-wrap") {
                    /* 递增（回绕）：超过 max 回到 min。 */
                    next = cur + 1 > max ? min : cur + 1;
                } else if (mode === "decrement") {
                    next = Math.max(cur - 1, min);
                } else if (mode === "decrement-wrap") {
                    next = cur - 1 < min ? max : cur - 1;
                } else {
                    continue;                            // 未知模式不动
                }
                w.value = next;
                /* ③ 三处同步写入（实测踩坑，勿只写 widget.value）：
                 *   官方反序列化路径是 `e.value = t[e.name]`（t = widgets_values_named），
                 *   说明控件值还有第二个家：widgets_values_named 对象；
                 *   另有部分节点用 widgets_values 数组。graphToPrompt 取值时
                 *   可能命中其中任一处，只写 widget.value 会出现「改了但序列化仍取旧值」。
                 *   故三处一并写，确保 graphToPrompt 一定拿到新种子。 */
                const idx = ws.indexOf(w);
                safeCall(() => {
                    const vals = n.widgets_values;
                    if (Array.isArray(vals) && idx >= 0 && idx < vals.length) vals[idx] = next;
                }, undefined, "同步种子到 widgets_values");
                safeCall(() => {
                    const named = n.widgets_values_named;
                    if (named && typeof named === "object" && w.name in named) named[w.name] = next;
                }, undefined, "同步种子到 widgets_values_named");
                /* 诊断：打印改前/改后与三处落点，便于确认取值来源确实被覆盖。 */
                alog(`种子更新 | 节点 ${String(n.type ?? n.id)} | ${nm} | ${mode}` +
                    ` | ${cur} → ${next}`);
                changed++;
            }
        }
    };

    safeCall(() => visitGraph(node?.subgraph), undefined, "运行前更新种子");
    if (changed) alog("运行前已按模式更新子图内种子:", changed, "个");
    return changed;
}

/**
 * 用官方 graphToPrompt 构建 prompt，再按「可达集」裁剪输出条目。
 * 复刻 ComfyTV graphSerialize.ts:buildScopedPrompt。
 * 官方 graphToPrompt 内部会展开本节点的子图（本节点已装执行展开钩子），
 * 故展开后的内层节点 id 也在可达集里，必须一并保留。
 *
 * ★ 链式连接处理（用户指定：连接的上游 A001 不执行，只取端口数据）：
 *   裁剪后，对每个「直接相连的上游 A001」注入官方加载节点并改写引用，
 *   再把上游 A001 的条目（容器 "1" 与 "1:*"）整体剔除。
 *
 * @returns {{output:object, nodeId:string}|{error:string}|null}
 *   正常返回 { output, nodeId }；上游无产物等需中止的情况返回 { error }；无内容返回 null。
 */
async function buildScopedPrompt(node) {
    const a = app;
    const pm = await a.graphToPrompt();
    if (!pm?.output) return null;

    const reachable = collectReachableIds(node);
    const sgId = String(node?.id ?? "");
    /* ★ keep 判定：graphToPrompt() 的 output key 有两种形态——
     *   · 顶层节点：普通 id，如 "127"；
     *   · 子图展开后的内层节点：形如 "127:131"（父id:子id），见实测输出
     *     ["127","127:131","127:132","127:133"]。
     *  因此：顶层 id 直接与可达集比对；带冒号的内层 id 取其「父 id」比对。
     *  所有比对一律走字符串，避免 Number/String 失配。 */
    const keep = (id) => {
        const key = String(id);
        if (reachable.has(key)) return true;
        const colon = key.indexOf(":");
        if (colon > 0) return reachable.has(key.slice(0, colon));
        return false;
    };

    const output = {};
    for (const [id, entry] of Object.entries(pm.output)) {
        if (keep(id)) output[id] = entry;
    }
    if (!Object.keys(output).length) return null;

    /* ★ 链式连接：上游 A001 不执行，改注入官方加载节点取端口数据。 */
    const ups = identifyUpstreamA001(node);
    if (ups.length) {
        const built = { output };
        const upstreamTopIds = new Set();
        for (const [i, up] of ups.entries()) {
            const r = injectUpstreamFileNode(built, up, upstreamTopIds, i);
            if (!r?.ok) {
                /* 用户指定口径：上游无产物 → 提示并中止本次运行。 */
                return { error: r?.reason || "上游取数失败" };
            }
        }
        /* 剔除上游 A001 的全部条目：容器顶层 id 及其展开的内层条目（"1:*"）。 */
        for (const key of Object.keys(output)) {
            if (upstreamTopIds.has(key)) { delete output[key]; continue; }
            const colon = key.indexOf(":");
            if (colon > 0 && upstreamTopIds.has(key.slice(0, colon))) delete output[key];
        }
        alog("链式取数完成 | 剩余条目", Object.keys(output).length,
            "| 已剔除上游", [...upstreamTopIds].join(","));
    }

    /* ★ 附带 pm.workflow（整份工作流存档 JSON）：
     *  它是 ComfyUI 官方「把工作流写进产物」的唯一数据来源 —— 官方队列按键在
     *  api.queuePrompt() 里组装 extra_data.extra_pnginfo.workflow = graphToPrompt().workflow
     *  （出处：前端产物 api-DclbNWWy.js 的 queuePrompt，`extra_pnginfo:{workflow:i}`；
     *   后端消费见 nodes.py SaveImage.save_images 把 extra_pnginfo 各键逐条写进 PNG tEXt）。
     *  A001 运行键直发 /prompt，若不带上它，产物里就只有执行用的 prompt、没有 workflow
     *  → 从产物还原时 A001 节点内部子图结构全部丢失（实测产物 tEXt 仅含 "prompt"）。
     *  workflow.nodes 里每个 A001 节点都带有 subgraph_data_json（由本节点 serialize 钩子落盘），
     *  故带上它即可实现「产物 → 一比一还原 A001 节点内外全部数据」。 */
    return { output, nodeId: sgId, workflow: pm.workflow };
}

/**
 * 收集「局部执行目标」id 列表。
 * 官方 partial_execution_targets 语义：只执行到这些目标节点（含其上游依赖），
 * 且目标必须是「输出节点」（后端 execution.py 判定 class_.OUTPUT_NODE is True），
 * 否则后端以 400 prompt_no_outputs 拒绝。
 *
 * 本节点是子图容器，容器本身不是输出节点，故目标取本节点子图内的「输出节点」。
 * 前端判定输出节点沿用官方字段：nodeData.output_node（与后端 OUTPUT_NODE 对应）。
 * 子图展开后这些内层节点在 prompt 里的 key 形如 "127:133"（父id:子id），
 * 与后端执行器使用的节点名一致，故直接以此形态作为 target。
 *
 * @returns {string[]} 形如 ["127:133"] 的目标 id 列表（可能为空）。
 */
function collectPartialTargets(node) {
    const sgId = String(node?.id ?? "");
    const sg = node?.subgraph;
    const inner = sg?._nodes || sg?.nodes || [];
    const targets = [];
    for (const n of inner) {
        /* LiteGraph 节点模式：NEVER(静音)/BYPASS(旁路) 不参与执行 */
        const mode = Number(n?.mode);
        if (mode === LG_MODE_NEVER || mode === LG_MODE_BYPASS) continue;
        /* 仅输出节点可作局部执行目标：官方 nodeData.output_node === 后端 OUTPUT_NODE */
        if (!n?.constructor?.nodeData?.output_node) continue;
        /* 子图展开后的内层节点 key：父id:子id（与 graphToPrompt 输出、后端节点名一致） */
        targets.push(sgId ? `${sgId}:${String(n.id)}` : String(n.id));
    }
    return targets;
}

/** 判定官方 /queue 返回的某条队列里是否仍持有指定 prompt_id。
 *  提取为文件级公共函数，消除 promptInQueue / cancelPrompt 两处逐字重复。 */
function queueHolds(list, promptId) {
    return Array.isArray(list)
        && list.some((e) => Array.isArray(e) && String(e[1]) === String(promptId));
}

/** 判定某 prompt 是否仍在队列（待执行或运行中）。
 *  复刻 ComfyTV queueControl.ts:promptInQueue —— 官方 /queue 只读接口。 */
async function promptInQueue(promptId) {
    try {
        const r = await api.fetchApi("/queue");
        const q = await r.json();
        return queueHolds(q?.queue_pending, promptId) || queueHolds(q?.queue_running, promptId);
    } catch (e) {
        alog("查询队列失败:", e);
        return null;
    }
}

/**
 * 取消某个 prompt。
 * 复刻 ComfyTV queueControl.ts:cancelPrompt —— 待执行走 /queue 删除，
 * 运行中走 /interrupt 中断。
 */
async function cancelPrompt(promptId) {
    /* 无 prompt_id（理论上不会出现：/prompt 成功即回传 prompt_id）时的兜底降级：
     * 走官方 api.interrupt() 语义 —— POST /interrupt 不带 body，中断当前执行。 */
    if (promptId == null) {
        await api.fetchApi("/interrupt", { method: "POST" });
        return "interrupted";
    }
    let q = null;
    try {
        const r = await api.fetchApi("/queue");
        q = await r.json();
    } catch (e) {
        alog("取消前读队列失败，直接中断:", e);
    }
    if (q && queueHolds(q.queue_pending, promptId)) {
        await api.fetchApi("/queue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delete: [promptId] }),
        });
        return "deleted";
    }
    await api.fetchApi("/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: promptId }),
    });
    return queueHolds(q?.queue_running, promptId) ? "interrupted" : "unknown";
}

/* ══════════════════════════════════════════════
 *  看门狗
 *  ══════════════════════════════════════════════ */

function clearWatchdog(node) {
    const st = stateOf(node);
    if (st?._watchdog) {
        clearTimeout(st._watchdog);
        st._watchdog = null;
    }
}

/**
 * 看门狗：队列已空却迟迟没有 execution_success/error 时复位，防止按键永久卡在忙碌态。
 * 复刻 ComfyTV stageRun.ts:onStatus 中的 watchdogTimer 分支。
 */
function armWatchdog(node) {
    const st = stateOf(node);
    if (!st || st._watchdog) return;
    const pid = st.promptId;
    /* ★ 同一 promptId 只做一次 /queue 确认：status 事件在队列变动时高频广播，
     *  归零会反复 arm；原实现每次触发后 _watchdog 置 null 又可再 arm →
     *  可能形成「status → watchdog → /queue → status → …」的轮询放大。
     *  用 _wdTried 记录已确认过的 pid，避免对同一执行重复发起 HTTP 往返。 */
    if (st._wdTried === pid) return;
    st._watchdog = setTimeout(async () => {
        st._watchdog = null;
        if (!st.running || st.promptId !== pid) return;
        st._wdTried = pid;
        const queued = await promptInQueue(pid);
        if (queued === false) {
            alog("看门狗：prompt", pid, "已离队且无成功/失败事件，复位运行态");
            resetRunState(node);
        }
    }, WATCHDOG_MS);
}

/* ══════════════════════════════════════════════
 *  运行 / 取消
 *  ══════════════════════════════════════════════ */

/**
 * 点击运行键入口：未运行 → 入队执行；运行中 → 取消。
 * 复刻 ComfyTV stageRun.ts:onRunRequest / onCancelRequest 的对外语义。
 */
export async function runA001Node(node) {
    const st = stateOf(node);
    if (!st) return;
    if (st.running) {
        await cancelA001Run(node);
        return;
    }

    st.running = true;
    st.error = null;
    st.progress = { value: 0, max: 1 };
    notifyRunState(node);

    try {
        /* ★ 先按「控制后生成」模式更新种子，再序列化 —— 顺序不能反：
         *  buildScopedPrompt 内部调 graphToPrompt 会取走控件当前值。 */
        applyA001SeedControl(node);
        const built = await buildScopedPrompt(node);
        if (!built) {
            st.error = "无可执行内容";
            alog("运行：prompt 构建为空，未入队");
            resetRunState(node);
            return;
        }
        /* ★ 链式取数失败（如上游 A001 尚无产物）：提示并中止本次运行（用户指定口径）。
         *  buildScopedPrompt 以 { error } 形态回报需中止的原因。 */
        if (built.error) {
            st.error = String(built.error);
            alog("运行：已中止 —", built.error);
            notifyA001Toast(String(built.error));
            resetRunState(node);
            return;
        }
        /* 局部执行目标：本节点子图内「有输出」的可执行节点（形如 "127:133"）。
         * 容器节点本身无输出，不能作为 target，否则后端 400 prompt_no_outputs。 */
        const targets = collectPartialTargets(node);
        alog("运行：入队，节点", String(node.id), "条目数", Object.keys(built.output).length,
            "目标", JSON.stringify(targets));

        /* ★ 直接 POST 官方 /prompt（ComfyUI 自带运行按键的底层通道）。
         *   不走 app.queuePrompt()：该入口被 008_ComfyTV 的 monkey-patch 劫持，
         *   调用后会假成功返回 true 却不发请求（见文件头「为什么直接走 /prompt」）。
         *   body 字段与后端 openapi.yaml / tests/execution/test_execution.py 一致。 */
        const body = {
            prompt: built.output,
            client_id: String(safeCall(() => api?.clientId, undefined, "取 clientId") || ""),
        };
        if (targets.length) body.partial_execution_targets = targets;
        /* ★ 把整份工作流存档塞进 extra_data.extra_pnginfo.workflow —— 与官方队列按键同源。
         *  后端保存产物（SaveImage/PreviewImage/SaveAudio/SaveVideo 等）时，
         *  会把 extra_pnginfo 的每个键逐条写进产物容器（PNG tEXt / MP4 metadata / 音频 metadata），
         *  产物因此自带「当时的工作流」，可据此一比一还原 A001 节点内外全部数据。
         *  出处：
         *   · 前端官方队列按键：api-DclbNWWy.js 的 queuePrompt —— `extra_data:{...,
         *     extra_pnginfo:{workflow:i}}`（i = graphToPrompt().workflow）。
         *   · 后端消费：nodes.py SaveImage.save_images（L1700-1711）——
         *     `for x in extra_pnginfo: metadata.add_text(x, json.dumps(extra_pnginfo[x]))`。
         *  缺此字段时产物仅含 "prompt"（执行图），无 "workflow"（存档图）→ 无法还原子图结构。 */
        if (built.workflow) {
            body.extra_data = { extra_pnginfo: { workflow: built.workflow } };
        }

        const resp = await api.fetchApi("/prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!resp || !resp.ok) {
            let detail = "";
            try {
                const err = await resp.json();
                detail = err?.error?.message || err?.error?.type || "";
            } catch (e) { /* 忽略非 JSON 响应 */ }
            st.error = detail ? `入队被拒：${detail}` : `入队被拒（HTTP ${resp?.status ?? "?"}）`;
            alog("运行：/prompt 返回非 2xx", resp?.status, detail);
            resetRunState(node);
            return;
        }

        /* 官方 /prompt 响应：{ prompt_id, number, node_errors } —— 直接拿到 prompt_id，
         * 无需依赖事件回填，事件仅用于进度与复位。 */
        const data = await resp.json();
        const pid = data?.prompt_id ? String(data.prompt_id) : null;
        if (!pid) {
            st.error = "入队未返回 prompt_id";
            alog("运行：响应缺少 prompt_id", data);
            resetRunState(node);
            return;
        }
        st.promptId = pid;
        alog("运行：已入队，prompt_id =", pid);
        notifyRunState(node);
        armWatchdog(node);
    } catch (e) {
        st.error = e?.message ? String(e.message) : "入队失败";
        alog("/prompt 入队失败:", e);
        resetRunState(node);
    }
}

/** 取消当前节点的执行。 */
export async function cancelA001Run(node) {
    const st = stateOf(node);
    if (!st?.running) return;
    const pid = st.promptId;
    try {
        /* pid 理论上必有（/prompt 成功即回传）；为 null 时 cancelPrompt 兜底降级为
         * 无 body 的 /interrupt，同样能中断本次执行。 */
        await cancelPrompt(pid ?? null);
    } catch (e) {
        alog("取消失败:", e);
    } finally {
        resetRunState(node);
    }
}

/* ══════════════════════════════════════════════
 *  供外观模块回填按键状态
 *  ══════════════════════════════════════════════ */

/**
 * 查询节点当前的按键展示态。
 * @returns {{running:boolean, text:string, title:string, error:string|null, progress:number}}
 */
export function queryA001RunState(node) {
    const st = stateOf(node);
    if (!st) return { running: false, text: "运行", title: "运行", error: null, progress: 0 };
    if (st.running) {
        const p = st.progress;
        const pct = p && p.max > 0 ? Math.floor((p.value / p.max) * 100) : 0;
        /* ★ 进度为 0 时只显示「取消」（用户要求）：刚入队还没收到 progress 事件时
         *   pct 恒为 0，硬拼成「取消 0%」显得像卡住。有实际进度才附百分比。 */
        return {
            running: true,
            text: pct > 0 ? `取消 ${pct}%` : "取消",
            title: "点击取消当前执行",
            error: null,
            progress: pct,
        };
    }
    return {
        running: false,
        text: "运行",
        title: st.error ? `运行（上次失败：${st.error}）` : "运行",
        error: st.error,
        progress: 0,
    };
}

/* ══════════════════════════════════════════════
 *  全局事件订阅（模块加载即安装，幂等）
 *  ══════════════════════════════════════════════ */

/** 判断事件里的节点 id 是否属于本次「本节点发起」的执行。
 *  ★ 未拿到自己的 promptId 前（入队 → 回传 prompt_id 的窗口期）一律不接受归属：
 *    原实现 `!st.promptId → true` 会让窗口期内**任意其它 prompt** 的成功事件
 *    误判为本节点成功 → 提前复位（按钮从「取消 xx%」跳回「运行」）。 */
function isOwnPrompt(st, pid) {
    if (!st) return false;
    if (!st.promptId) return false;
    if (!pid) return true;
    return String(pid) === String(st.promptId);
}

/**
 * 遍历「仍在图中」的运行节点，顺带剔除已死节点（防止 A001_RUN_NODES 单调增长）。
 * 直接遍历 A001_RUN_NODES 的路径改为走本函数，避免对已删除节点做事件回灌。
 */
function forEachLiveRunNode(fn) {
    for (const node of A001_RUN_NODES) {
        if (!node || !isNodeInGraph(node)) {
            A001_RUN_NODES.delete(node);
            continue;
        }
        fn(node);
    }
}

/**
 * 安装全局执行事件监听。
 * 复刻 ComfyTV executionStore.ts:bindToApi 的事件集合，
 * 只保留与运行按键状态相关的最小集：
 *   executing / progress / execution_success / execution_error / execution_interrupted / status
 */
export function installA001RunHooks() {
    if (window.__a001RunHooked) return;
    window.__a001RunHooked = true;

    // 进度：按上游节点 id 归属，更新发起节点的进度（子图内层节点的事件要回灌到容器）
    api.addEventListener("progress", ({ detail }) => safeCall(() => {
        if (!detail) return;
        const evId = detail.node;
        forEachLiveRunNode((node) => {
            /* ★ 只读访问运行态：不要用 stateOf() —— 它对已死节点会「读取即重建」
             *  状态对象，等于给已删除节点续命并阻碍 GC。 */
            const st = node._a001RunState;
            if (!st?.running) return;
            if (!ownsExecId(node, evId)) return;
            st.progress = { value: Number(detail.value) || 0, max: Math.max(1, Number(detail.max) || 1) };
            notifyRunState(node);
        });
    }, undefined, "progress 回灌"));

    // 执行成功：复位发起节点
    api.addEventListener("execution_success", ({ detail }) => safeCall(() => {
        const pid = detail?.prompt_id;
        forEachLiveRunNode((node) => {
            const st = node._a001RunState;
            if (!st?.running || !isOwnPrompt(st, pid)) return;
            resetRunState(node);
            refreshPreview(node);
        });
    }, undefined, "execution_success 回灌"));

    // 执行出错：记录错误并复位
    api.addEventListener("execution_error", ({ detail }) => safeCall(() => {
        const pid = detail?.prompt_id;
        forEachLiveRunNode((node) => {
            const st = node._a001RunState;
            if (!st?.running || !isOwnPrompt(st, pid)) return;
            st.error = String(detail?.exception_message || detail?.message || "执行失败");
            resetRunState(node);
        });
    }, undefined, "execution_error 回灌"));

    // 执行中断（用户取消）：复位
    api.addEventListener("execution_interrupted", ({ detail }) => safeCall(() => {
        const pid = detail?.prompt_id;
        forEachLiveRunNode((node) => {
            const st = node._a001RunState;
            if (!st?.running || !isOwnPrompt(st, pid)) return;
            resetRunState(node);
        });
    }, undefined, "execution_interrupted 回灌"));

    // 队列变化：队列已空而仍标记运行中 → 交看门狗判定
    api.addEventListener("status", ({ detail }) => safeCall(() => {
        const info = detail?.status?.exec_info ?? detail?.exec_info;
        const remaining = Number(info?.queue_remaining);
        if (!Number.isFinite(remaining) || remaining !== 0) return;
        forEachLiveRunNode((node) => {
            if (node._a001RunState?.running) armWatchdog(node);
        });
    }, undefined, "status 回灌"));
}

/**
 * 判断某执行 id 是否归属该 A001 子图节点。
 * 直接相等 → 归属；否则看它是否位于本节点的子图内（子图展开后内层节点独立上报）。
 */
function ownsExecId(node, execId) {
    if (execId == null || node?.id == null) return false;
    if (String(execId) === String(node.id)) return true;
    const sg = node.subgraph;
    const inner = sg?._nodes || sg?.nodes || [];
    return inner.some((n) => String(n?.id) === String(execId));
}

/* ══════════════════════════════════════════════
 *  注册 / 注销
 *  ══════════════════════════════════════════════ */

/** 注册节点进入运行系统（幂等）。 */
export function attachA001Run(node) {
    if (!node || node._a001RunAttached) return;
    node._a001RunAttached = true;
    stateOf(node);
    A001_RUN_NODES.add(node);
}

/** 注销节点并清理定时器（onRemoved 时调用）。 */
export function detachA001Run(node) {
    if (!node) return;
    clearWatchdog(node);
    A001_RUN_NODES.delete(node);
    node._a001RunAttached = false;
}
