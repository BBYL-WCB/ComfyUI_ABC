// ═══════════════════════════════════════════════════════════════
//  A001 子图节点 · 原生子图伪装（disguise）· 开关版
//
//  ★★ 本文件是「ComfyTV 识别展开」功能的**独立实现**，从备份
//     （20261002_233309_完成阶段目标4.2修复子图持久化）的 A001_disguise.js 复刻而来。
//     想要移除该功能时：删除本文件，并清掉 A001_SubgraphNode.js 里的
//     import / installA001Disguise / beforeConfigureGraph / initAppearanceDeps 注入，
//     以及 A001_Appearance.js 里「加载开关」按键那一段即可。
//
//  ● 与原版的关键差异（本轮需求）：**做成开关型**。
//      · 每个 A001 节点带一个开关状态（properties._a001ComfyTVEnabled，随工作流持久化）；
//      · 只有开关**打开**的节点，保存时才会被伪装成「ComfyUI 原生子图」形态；
//      · 开关关闭（默认）→ 保存为普通 A001 形态，外部工具（ComfyTV / Custom Stage）不识别。
//      · 开关由节点面板上的「加载开关」按键控制（逻辑出口见下方 toggleA001ComfyTVEnabled）。
//
//  ● 原版机制说明（保存伪装 / 加载还原）：
//    · 保存时：把 A001 序列化成「ComfyUI 原生子图」形态（顶层 definitions.subgraphs
//      + 节点 type=子图 UUID），使 Custom Stage 等外部工具能像识别自带子图一样
//      「完全展开 A001、识别内部所有节点」。
//    · 加载时：把伪装过的节点（type=UUID 且 properties['Node name for S&R']=
//      'A001_SubgraphNode'）还原回 A001_SubgraphNode，恢复 A001 全部自定义功能。
//
//  设计原则（零侵入、复用原生机制）：
//  · 只在「序列化产物（内存对象）」上改写 type/definitions，**不改动活节点**，
//    因此 A001 在画布上全程是 A001，自定义功能零损失。
//  · 不改 ComfyTV、不改 ComfyUI 源码；伪装只发生在「保存到磁盘」那一刻。
//
//  关键技术事实（调研已证）：
//  · 顶层 definitions.subgraphs 由 LGraph.asSerialisable() 依据
//    rootGraph._subgraphs（isSubgraphNode + type 判据）生成。A001 的 type 不是
//    UUID，原生不会收集它 → 需在本模块的 asSerialisable 后处理里手动注入。
//  · 反序列化只按 node.type 查找节点类；properties['Node name for S&R']
//    不参与识别（它是写入端）。还原必须在 beforeConfigureGraph 改 type 换类。
//  · A001 的 subgraph_data_json 本身就是标准 ExportedSubgraph 格式（含合法 UUID）。
// ═══════════════════════════════════════════════════════════════

import { alog, safeCall } from "./A001_shared.js?v=20261007a";

/** A001 节点真实类型（序列化时被替换为子图 UUID，反序列化时据 S&R 标记还原）。 */
const A001_NODE_TYPE = "A001_SubgraphNode";
/** 官方写入端字段：节点注册时的 type（每个节点 onNodeCreated 自动写入）。 */
const SR_PROP = "Node name for S&R";
/** 伪装标记：还原时据此确认「这是 A001 伪装成 UUID 的节点」。 */
const A001_ORIGINAL_UUID = "_a001OriginalUuid";

/* ────────────────────────────────
 *  开关状态（每节点）
 *  · 存在 node.properties 里 → 随工作流序列化持久化；
 *    serialize() 会把 properties 一并写出，故保存伪装时可直接读序列化产物里的该字段。
 * ──────────────────────────────── */

/** 开关属性名：true = 允许被 ComfyTV 等外部工具识别展开；缺省 / false = 不允许。 */
const COMFYTV_PROP = "_a001ComfyTVEnabled";

/** 查询该节点是否开启了「ComfyTV 识别」开关。 */
export function isA001ComfyTVEnabled(node) {
    return node?.properties?.[COMFYTV_PROP] === true;
}

/** 写入开关状态（true=开 / false=关），返回写入后的值。 */
export function setA001ComfyTVEnabled(node, on) {
    if (!node) return false;
    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    node.properties[COMFYTV_PROP] = !!on;
    return !!on;
}

/** 翻转开关状态，返回翻转后的值。「加载开关」按键点击时调用。 */
export function toggleA001ComfyTVEnabled(node) {
    return setA001ComfyTVEnabled(node, !isA001ComfyTVEnabled(node));
}

/** 让「加载开关」按键按节点当前状态回填图标/tooltip。
 *  按键自身的刷新出口由 A001_Appearance.js 在建按键时挂到 node._a001SyncLoadBtn 上
 *  （与收起按键的 _a001SyncHideBtn 同款），此处只负责调用，避免反向依赖外观模块。 */
export function refreshA001ComfyTVSwitch(node) {
    safeCall(() => node?._a001SyncLoadBtn?.(), undefined, "刷新加载开关按键状态");
}

/** 排一次「加载开关」按钮状态回填（幂等，重复调用无害）。
 *
 * ★ 为什么要排程：官方反序列化顺序是 onNodeCreated → configure，而 `node.properties`
 *   在 configure **之后**才被还原；面板按键此时可能已按「默认关」画好，需等属性到位后
 *   再回填。用「双 rAF + setTimeout 兜底」双通道（与收起状态的恢复排程同款）——
 *   浏览器在标签页不可见时会暂停 rAF，故必须有 setTimeout 兜底通道。 */
export function scheduleA001ComfyTVSwitchSync(node) {
    if (!node || node._a001ComfyTvSyncScheduled) return;
    node._a001ComfyTvSyncScheduled = true;
    const run = () => {
        node._a001ComfyTvSyncScheduled = false;
        refreshA001ComfyTVSwitch(node);
    };
    if (typeof requestAnimationFrame === "function") {
        safeCall(() => requestAnimationFrame(() => requestAnimationFrame(() => {
            if (node._a001ComfyTvSyncScheduled) run();
        })), undefined, "加载开关回填排程（rAF）");
    }
    safeCall(() => setTimeout(() => {
        if (node._a001ComfyTvSyncScheduled) run();
    }, 48), undefined, "加载开关回填排程（setTimeout 兜底）");
}

/** 轻量子图定义 schema 校验（自包含，不依赖 shared，便于本文件整体移除）：
 *  subgraph_data_json / embedded_subgraph_defs_json 反序列化入口统一走这里，
 *  防止畸形 JSON（手工编辑/损坏的工作流）被采信后下游抛难追踪的错。 */
function isValidSubgraphDef(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (typeof obj.id !== "string" || !obj.id) return false;
    if (!Array.isArray(obj.nodes)) return false;
    if (obj.links != null && !Array.isArray(obj.links)) return false;
    if (obj.inputs != null && !Array.isArray(obj.inputs)) return false;
    if (obj.outputs != null && !Array.isArray(obj.outputs)) return false;
    return true;
}

/** 判定字符串是否为 UUID（36 位、8-4-4-4-12 段式）。与 vendored is_subgraph_uuid 一致。 */
function isUuid(s) {
    if (typeof s !== "string" || s.length !== 36) return false;
    const parts = s.split("-");
    if (parts.length !== 5) return false;
    const lens = parts.map((p) => p.length);
    return lens[0] === 8 && lens[1] === 4 && lens[2] === 4 && lens[3] === 4 && lens[4] === 12;
}

/** 从节点 properties 读出 A001 的子图定义对象（JSON 字符串 → 对象）。 */
function readA001SubgraphDef(props) {
    const raw = props?.subgraph_data_json;
    if (typeof raw !== "string" || !raw) return null;
    const obj = safeCall(() => JSON.parse(raw), null, "disguise 解析 subgraph_data_json");
    /* 统一走 schema 校验（id 为 string + nodes 为数组等），防止畸形 JSON 被采信
     * （血泪教训：手工编辑的工作流可注入 {nodes:"abc"}）。 */
    if (!isValidSubgraphDef(obj)) return null;
    return obj;
}

/* ────────────────────────────────
 *  序列化伪装：保存工作流时把 A001 变成原生子图形态
 * ──────────────────────────────── */

/** djb2 字符串哈希（确定性），用于从种子串派生稳定数字。 */
function _hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h >>> 0;
}

/** 从种子串派生**确定性 UUID**（同名种子 → 同名 UUID，每次保存一致）。
 *  格式仍是合法 UUID（8-4-4-4-12，version/variant 位固定），保证 ComfyUI/ComfyTV
 *  的 is_subgraph_uuid 判定通过。 */
function stableUuidFromSeed(seed) {
    const h1 = _hashStr(String(seed)).toString(16).padStart(8, "0").slice(0, 8);
    const h2 = _hashStr(String(seed) + "#1").toString(16).padStart(8, "0");
    const h3 = _hashStr(String(seed) + "#2").toString(16).padStart(8, "0");
    const h4 = _hashStr(String(seed) + "#3").toString(16).padStart(8, "0");
    const seg2 = h2.slice(0, 4);
    const seg3 = "4" + h2.slice(5, 8);            // version 4
    const seg4 = ((parseInt(h3.slice(0, 2), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + h3.slice(2, 4); // variant
    const seg5 = h3.slice(4, 8) + h4;
    return `${h1}-${seg2}-${seg3}-${seg4}-${seg5}`;
}

/** 数字 id 重映射用的命名空间基数：伪装内层 id 映射为**负数**（-(_BASE + 原值)）。
 *  ★ 为什么用负数（修复 "Node ID space exhausted"）：
 *    原方案把内层 id 平移到 +5×10⁹ 的正数命名空间，伪装子图被 loadSubgraphs 实例化后，
 *    会把 rootGraph.lastNodeId 推高到 ~5.9×10⁹，污染全局 id 计数器；当 A001 恢复复杂
 *    子图（内嵌子图、内层节点多）时 createSubgraph 分配节点 id 撞上这个被抬高的计数器，
 *    报 "Node ID space exhausted"。
 *    改用**负数**：负数 id 不参与 ComfyUI 的正数 id 计数（子图 input/output 锚点就是
 *    -10/-20 的先例），既不污染 lastNodeId，又与 A001 恢复用的正数原始 id 完全隔离。
 *  确定性（同一原始 id → 同一伪装负数 id，跨保存稳定），使 Custom Stage 的绑定键有效。 */
const _DISGUISE_ID_OFFSET = 1_000_000_000;

/** 子图槽位/常量 id：子图 input/output 锚点（-10/-20），重映射时保留不动。 */
const _CONST_IDS = new Set([-10, -20]);

/** 把子图定义的「内层 id 命名空间」整体重映射为**确定性负数 id**（就地修改 data）。
 *  数字 id 用「-(_DISGUISE_ID_OFFSET + 原值)」（稳定、负数命名空间、不污染 lastNodeId）；
 *  UUID id 用 stableUuidFromSeed（稳定）。每次保存产出的伪装子图定义 id 完全一致，
 *  使 Custom Stage 的绑定键（disguiseId:innerId）能跨保存保持有效。
 *  自包含实现（不依赖 A001_SubgraphNode.js 的私有 remap 函数）。 */
function remapDisguisedSubgraphIds(data) {
    const mapIdNum = (v) => {
        if (typeof v === "number") return -(_DISGUISE_ID_OFFSET + v);
        return stableUuidFromSeed(String(v));
    };
    const remapId = (v) => (v == null || (typeof v === "number" && _CONST_IDS.has(v))) ? v : mapIdNum(v);

    /* 子图定义级端口 inputs/outputs：id 与 linkIds 都要重映射。
     *  ★ linkIds 引用 links[].id（跨边界链接的解析依据）。漏改会让端口 linkIds
     *    指向已不存在的旧 link id → ComfyTV/前端展开子图时 input_targets/
     *    output_sources 解析失败 → 跨边界断连（如 SaveImage.images 丢失报缺参）、
     *    端口错乱（把内层 widget 误识别为子图端口）。此处与 links[].id 同步 remap。 */
    for (const s of [...(data.inputs || []), ...(data.outputs || [])]) {
        if (s?.id != null && !_CONST_IDS.has(s.id)) s.id = mapIdNum(s.id);
        if (Array.isArray(s?.linkIds)) s.linkIds = s.linkIds.map(remapId);
        /* 单链接槽位兼容字段（部分导出形态用 link / links 而非 linkIds）。 */
        if (s?.link != null) s.link = remapId(s.link);
        if (Array.isArray(s?.links)) s.links = s.links.map(remapId);
    }
    for (const n of data.nodes || []) {
        if (n?.id != null && !_CONST_IDS.has(n.id)) n.id = mapIdNum(n.id);
        for (const inp of n?.inputs || []) {
            if (inp?.link != null) inp.link = remapId(inp.link);
        }
        for (const out of n?.outputs || []) {
            if (Array.isArray(out?.links)) out.links = out.links.map(remapId);
        }
    }
    for (const l of data.links || []) {
        if (l?.id != null) l.id = mapIdNum(l.id);
        if (l?.origin_id != null) l.origin_id = remapId(l.origin_id);
        if (l?.target_id != null) l.target_id = remapId(l.target_id);
        if (l?.parentId != null) l.parentId = remapId(l.parentId);
    }
    /* floatingLinks 与 links 同构（未连满的悬空链接），同样引用节点/链接 id，一并 remap。 */
    for (const l of data.floatingLinks || []) {
        if (l?.id != null) l.id = mapIdNum(l.id);
        if (l?.origin_id != null) l.origin_id = remapId(l.origin_id);
        if (l?.target_id != null) l.target_id = remapId(l.target_id);
        if (l?.parentId != null) l.parentId = remapId(l.parentId);
    }
    for (const g of data.groups || []) if (g?.id != null) g.id = mapIdNum(g.id);
    for (const r of data.reroutes || []) {
        if (r?.id != null) r.id = mapIdNum(r.id);
        if (r?.parentId != null) r.parentId = remapId(r.parentId);
        if (Array.isArray(r?.linkIds)) r.linkIds = r.linkIds.map(remapId);
    }
    /* 子图内部 id 计数器（lastNodeId 等）：内层 id 已换为负数命名空间（不参与正数
     *  计数），故**保留原 state 值即可**，不重算。伪装子图定义仅供外部识别、不参与
     *  真实执行，计数器沿用原始值既不冲突也不影响 ComfyUI/ComfyTV 的解析。 */
    data.state = data.state || {};
}

/** 把 A001 的**内嵌子图定义**注入顶层 definitions.subgraphs（就地修改 top）。
 *
 *  ★ 为什么必须注入（执行报错根因）：
 *    A001 内层可能引用「内嵌子图」——即主定义里某个内层节点的 `type` 是另一个子图的
 *    UUID（形如内嵌「启用4步 LoRA」）。这些内嵌子图的定义只存在于 A001 私有属性
 *    `properties.embedded_subgraph_defs_json`，ComfyUI 原生不会把它们放进顶层
 *    definitions.subgraphs。若不注入，ComfyTV 展开 A001 主定义后会遇到一个 type 为
 *    未知 UUID 的内层节点：既不是已知节点类型、又不在 subgraph_defs 里可展开 →
 *    转换器无法处理，直接把该 UUID 当作错误抛出（前端就弹出裸 UUID 报错）。
 *    原生嵌套子图正是「主定义的节点 type 引用另一条 subgraph def id」，ComfyTV 的
 *    `_expand_subgraphs` 会迭代递归展开它——故只要把内嵌定义注入 definitions.subgraphs，
 *    即可像原生嵌套子图一样被识别与展开。
 *
 *  ★ id 处理：内嵌子图定义的 **id 必须保持不变**（主定义内层节点 type 就是引用它，
 *    改了会断链）；只对**其内部节点/链接的 id** 做重映射（负数命名空间，防与主定义
 *    及其他内嵌子图冲突）。内嵌子图内部若还引用更深层内嵌子图，其 type 已是 UUID，
 *    同样保持原样，只要更深层定义也被一并注入即可（本函数一次性处理全部）。
 *
 *  @param {object} top 顶层序列化产物
 *  @param {object} props 该 A001 节点的 properties */
function injectEmbeddedSubgraphDefs(top, props) {
    const raw = props?.embedded_subgraph_defs_json;
    if (typeof raw !== "string" || !raw) return;
    const list = safeCall(() => JSON.parse(raw), null, "disguise 解析 embedded_subgraph_defs_json");
    if (!Array.isArray(list) || !list.length) return;

    top.definitions = top.definitions || {};
    top.definitions.subgraphs = top.definitions.subgraphs || [];

    for (const emb of list) {
        /* 统一走 schema 校验（与 readA001SubgraphDef 同口径） */
        if (!isValidSubgraphDef(emb)) continue;
        /* 已注入过（按原 id 去重） */
        if (top.definitions.subgraphs.some((s) => s && s.id === emb.id)) continue;
        const copyDef = safeCall(
            () => JSON.parse(JSON.stringify(emb)),
            null,
            "disguise 深拷贝内嵌子图定义"
        );
        if (!copyDef) continue;
        /* 内层 id 重映射（负数命名空间），但保留该定义自身 id */
        safeCall(() => remapDisguisedSubgraphIds(copyDef), undefined, "disguise 重映射内嵌子图内层 id");
        top.definitions.subgraphs.push(copyDef);
    }
}

/** 把 A001 内层的**保存类节点**镜像到顶层，使 ComfyTV 的 Expose I/O 能把它们列入输出候选。
 *
 *  ★ 为什么需要（根因）：
 *    ComfyTV 的输出候选来自 `gui_nodes`，而 `_extract_gui_view` **只遍历顶层 doc.nodes、
 *    不展开子图**。A001 的保存节点（SaveImage/SaveVideo/SaveAudio/PreviewImage…）都在
 *    definitions.subgraphs[].nodes 里 → gui_nodes 看不到 → Expose I/O 里无法把它们暴露。
 *  解法：伪装时在顶层为每个内层保存节点镜像一个同类型节点，id 采用与 ComfyTV 执行图
 *    一致的**复合 id `outerId:innerId`**（_expand_subgraphs 产出的 key 正是此格式，
 *    如 `1:-1006052804`），这样 ComfyTV 暴露后按该 node_id 能在 api_json 里精确命中。
 *  · mode=4（bypass）：镜像节点仅作“输出候选标识”，不参与真实执行，避免顶层重复保存。
 *  · inputs/outputs 留空：不连线，不影响图结构。
 *  · 这些镜像节点在反序列化还原时会按 `_a001MirrorOf` 标记被移除，画布不留幽灵节点。
 *
 *  @param {object} top 顶层序列化产物
 *  @param {object} disguiseNode 已改 type 的顶层 A001 节点
 *  @param {object} disguisedSg 伪装子图定义（内层 id 已重映射）
 *  @param {string} outerId 顶层 A001 节点 id（数字或字符串）
 *  @returns {number} 新增镜像节点数 */
const _SAVE_LIKE_TYPES = new Set([
    "SaveImage", "PreviewImage", "SaveAnimatedWEBP", "SaveAnimatedPNG",
    "SaveVideo", "SaveWEBM", "VHS_VideoCombine",
    "SaveAudio", "SaveAudioMP3", "SaveAudioOpus", "SaveAudioAdvanced",
    "SaveGLB", "PreviewAny", "ShowText", "SaveText", "DisplayAny",
]);
/** 镜像节点标记属性名：还原时据此删除。 */
const A001_MIRROR_OF = "_a001MirrorOf";

function mirrorInnerSaveNodes(top, disguiseNode, disguisedSg, outerId) {
    const innerNodes = disguisedSg?.nodes;
    if (!Array.isArray(innerNodes) || !innerNodes.length) return 0;
    let added = 0;
    const basePos = Array.isArray(disguiseNode?.pos) ? disguiseNode.pos : [0, 0];
    let offset = 0;
    for (const inner of innerNodes) {
        if (!inner || typeof inner !== "object") continue;
        if (!_SAVE_LIKE_TYPES.has(inner.type)) continue;
        const composite = `${outerId}:${inner.id}`;
        /* 去重：同 id 已存在则跳过 */
        if (top.nodes.some((x) => x && String(x.id) === composite)) continue;
        const mirror = {
            id: composite,
            type: inner.type,
            pos: [basePos[0] + 420, basePos[1] + offset * 120],
            size: [210, 60],
            flags: {},
            order: (top.nodes.length || 0) + offset,
            mode: 4,
            inputs: [],
            outputs: [],
            properties: { [A001_MIRROR_OF]: String(outerId ?? ""), "Node name for S&R": inner.type },
            widgets_values: [],
        };
        top.nodes.push(mirror);
        offset += 1;
        added += 1;
    }
    return added;
}

/** 对已序列化的顶层 JSON 做后处理：注入 definitions.subgraphs + 改 A001 节点 type 为 UUID。
 *  只改产物对象，不触碰活节点。返回是否产生改动（便于日志）。
 *
 *  ★★ 开关门控（本轮需求）：
 *    仅当该节点开启了「加载开关」（properties._a001ComfyTVEnabled === true）时，
 *    才对其做伪装。开关关闭 / 缺省 → 原样保存为普通 A001 形态，外部工具不识别。
 *    ★ 判据来源优先取**活节点**：新版 ComfyUI 走
 *      LGraph.serialize() → asSerialisable() → serialiseStoredNodes()
 *      → node.serializeFromStoreState()，产物里是否带上自定义 properties 取决于
 *      store 实现；故这里按 id 回查活节点 node.properties 最稳（见下方 liveById），
 *      活节点取不到时再退回序列化产物自身的 properties（隐藏态等自定义字段同样经此
 *      通道持久化，可作兜底）。
 *
 *  ★ 关键防冲突：给顶层 definitions 里的子图定义**换一个全新 UUID**（disguiseId），
 *    而非沿用子图原始 id。原因：伪装时顶层 definitions 会被 ComfyUI 的 loadSubgraphs
 *    注册进 rootGraph._subgraphs；若用原始 id，A001 反序列化还原后 ensureSubgraph 再用
 *    同一原始 id createSubgraph 会撞 ID（报 "Node ID space exhausted"）。
 *    而 A001 的 properties.subgraph_data_json 保留原始 id 供自身恢复 → 两者不冲突。
 *    disguiseId 存进 properties._a001DisguiseId，节点 type 用它，供还原与外部识别。 */
function disguiseA001InSerialised(top, graph) {
    if (!top || !Array.isArray(top.nodes)) return false;
    /* ★ 活节点按 id 建索引（一次性），供开关门控回查真相。 */
    const liveById = new Map();
    for (const ln of (graph?._nodes || [])) {
        if (ln && ln.id != null) liveById.set(String(ln.id), ln);
    }
    let changed = false;
    for (const n of top.nodes) {
        if (!n || typeof n !== "object") continue;
        const props = n.properties;
        /* 只处理 A001 节点：原生 type=A001_SubgraphNode（保存前尚未伪装） */
        if (n.type !== A001_NODE_TYPE && props?.[SR_PROP] !== A001_NODE_TYPE) continue;
        /* ★ 开关门控：未打开「ComfyTV 识别」开关 → 不伪装，原样保存。
         *   优先读活节点；活节点缺失时退回序列化产物的 properties。 */
        const live = liveById.get(String(n.id));
        const enabled = live ? isA001ComfyTVEnabled(live) : (props?.[COMFYTV_PROP] === true);
        if (!enabled) continue;
        const sg = readA001SubgraphDef(props);
        if (!sg) continue;

        /* 伪装 id：从子图原始 id 确定性派生（同一子图 → 同一伪装 id，跨保存稳定，
         *  使 Custom Stage 对该 A001 的绑定不因重新保存而失效）；且 ≠ 原始 id。 */
        const disguiseId = stableUuidFromSeed("a001-disguise:" + sg.id);
        /* ★ 深拷贝子图定义后整体重映射内层 id：避免顶层 definitions 被 loadSubgraphs
         * 实例化时占用 A001 恢复所需的原始内层 id（"Node ID space exhausted" 根因）。
         * 内层 id 换到独立大数命名空间，子图自身 id 用 disguiseId（节点 type 用它）。 */
        const disguisedSg = safeCall(
            () => JSON.parse(JSON.stringify(sg)),
            null,
            "disguise 深拷贝子图定义"
        );
        if (!disguisedSg) continue;
        safeCall(() => remapDisguisedSubgraphIds(disguisedSg), undefined, "disguise 重映射子图内层 id");
        disguisedSg.id = disguiseId;

        /* ★ 不剔除任何端口 / 输入槽，伪装产物与原生子图保持同构。
         *   实测（018 vs 019、021）：A001 子图定义 inputs 与顶层节点 inputs 里的
         *   resize_type.multiplier / text / prompt 等条目**都是真实的子图输入端口**
         *   （原生 subgraph_data_json.inputs 里本就存在，顶层节点上也带真实 link 连线）。
         *   曾按 promoted_widgets_json 名单剔除，结果切断内层节点输入链 → 执行时报缺参
         *   （ImageScaleToMaxDimension missing 1 required argument）、或参数丢失导致
         *   结果不对（SeedVR2 只缩放不放大、输出尺寸对但细节不增）。故一律保留。 */

        /* 1) 顶层 definitions.subgraphs 追加该子图定义（按 id 去重） */
        top.definitions = top.definitions || {};
        top.definitions.subgraphs = top.definitions.subgraphs || [];
        if (!top.definitions.subgraphs.some((s) => s && s.id === disguiseId)) {
            top.definitions.subgraphs.push(disguisedSg);
        }

        /* ★ 注入内嵌子图定义：A001 内层若引用内嵌子图（node.type 是另一个 UUID），
         *   必须把其定义一并放进 definitions.subgraphs，否则 ComfyTV 展开到该节点时
         *   无从识别，直接抛出裸 UUID 报错。 */
        safeCall(
            () => injectEmbeddedSubgraphDefs(top, props),
            undefined,
            "disguise 注入内嵌子图定义"
        );

        /* 2) 节点 type 改为伪装 UUID；真实类型留 S&R（还原时据以换类）；
         *    伪装 id 存 _a001DisguiseId 供排查。 */
        props[SR_PROP] = A001_NODE_TYPE;
        props._a001DisguiseId = disguiseId;
        n.type = disguiseId;

        /* ★ 镜像内层保存节点到顶层：让 ComfyTV 的 Expose I/O 能列出它们作为输出候选。
         *   镜像 id 用复合 `outerId:innerId`，与执行图 api_json 的 key 对齐；
         *   mode=4 不参与真实执行；还原时按 _a001MirrorOf 标记移除。 */
        safeCall(
            () => mirrorInnerSaveNodes(top, n, disguisedSg, n.id),
            undefined,
            "disguise 镜像内层保存节点到顶层"
        );

        changed = true;
    }
    return changed;
}

/** patch 版本指纹：每当 disguise 的内层 id 映射逻辑（remapDisguisedSubgraphIds 等）
 *  发生影响产物的改动时递增。用途：页面热更新/部分缓存命中时，旧模块注入的
 *  asSerialisable patch 闭包可能仍存活（其内部引用旧的 disguiseA001InSerialised）。
 *  仅靠「是否已 patch」的布尔标记会让旧闭包永久占位（幂等误判），导致新逻辑不生效。
 *  因此用版本指纹替代布尔：版本不一致即强制重打，替换掉旧闭包。 */
const _DISGUISE_PATCH_VERSION = 1;

/** patch LGraph.prototype.asSerialisable（图级），在原生产物后追加伪装。
 *  幂等且可自愈（跨模块版本）：见 _DISGUISE_PATCH_VERSION 注释。
 *  取 LGraph 类的两条路径（任一可用即可）：
 *   ① window.LGraph —— litegraph 命名空间挂到 window 的全局类；
 *   ② app.graph?.constructor —— 当前图实例的类（同一类，图已建时最稳）。 */
function installDisguiseSerializer() {
    const app = typeof window !== "undefined" ? (window.app ?? window.comfyAPI?.api?.app) : null;
    const LGraph = (typeof window !== "undefined" && window.LGraph)
        || (app?.graph?.constructor)
        || null;
    if (!LGraph || !LGraph.prototype) return false;
    const proto = LGraph.prototype;
    /* 已是当前版本 → 无需重打（真正的幂等短路）。 */
    if (proto.__a001DisguisePatchVersion === _DISGUISE_PATCH_VERSION) return true;
    /* 取「真正的原始实现」：首次 patch 时存留到 __a001DisguiseOrig；此后无论被包裹
     * 多少层，重打都基于这份最干净的原始实现，避免闭包无限链式叠加。 */
    const orig = proto.__a001DisguiseOrig || proto.asSerialisable;
    if (typeof orig !== "function") return false;
    if (!proto.__a001DisguiseOrig) proto.__a001DisguiseOrig = orig;
    proto.__a001DisguisePatchVersion = _DISGUISE_PATCH_VERSION;
    proto.__a001DisguisePatched = true;
    proto.asSerialisable = function (...args) {
        const out = orig.apply(this, args);
        /* 只处理根图序列化产物（含 nodes 数组）。子图自身的 asSerialisable 不含顶层 nodes，
         * 其结构是子图定义（有 inputNode/outputNode），不会误伤。 */
        if (out && this.isRootGraph && Array.isArray(out.nodes)) {
            safeCall(() => disguiseA001InSerialised(out, this), undefined, "disguise 伪装序列化产物");
        }
        return out;
    };
    return true;
}

/* ────────────────────────────────
 *  反序列化还原：加载工作流时把伪装的 UUID 节点还原回 A001
 * ──────────────────────────────── */

/** beforeConfigureGraph 钩子：把 type=UUID 且 S&R=A001 的节点改回 A001_SubgraphNode。
 *  这样 createNode("A001_SubgraphNode") 直接建成 A001 节点（自带全部钩子），真正换类。
 *  子图数据仍在 properties.subgraph_data_json（A001 的 ensureSubgraph 会读它）。 */
function restoreA001FromDisguise(graphData) {
    const nodes = graphData?.nodes;
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
        if (!n || typeof n !== "object") continue;
        const props = n.properties;
        if (props?.[SR_PROP] !== A001_NODE_TYPE) continue;
        if (n.type === A001_NODE_TYPE) continue;     // 已是 A001（未伪装或已还原）
        if (!isUuid(n.type)) continue;               // 只认 UUID 形态（伪装产物）
        /* ★ 还原时把开关标为「开」：该节点是以伪装形态存盘的，说明当初开关是打开的。
         *   这样「进入子图 → 保存 → 重开」后开关保持开启、按钮显示为「开」，行为连续。 */
        props[COMFYTV_PROP] = true;
        /* 还原：留底 UUID（万一子图数据在顶层 definitions 需定位），换 type 回 A001 */
        n[A001_ORIGINAL_UUID] = n.type;
        n.type = A001_NODE_TYPE;
    }
    /* ★ 移除伪装时镜像到顶层的保存节点（带 _a001MirrorOf 标记的幽灵节点），
     *   避免它们出现在还原后的画布上。就地从 graphData.nodes 剔除。 */
    for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n && typeof n === "object" && n.properties && n.properties[A001_MIRROR_OF] != null) {
            nodes.splice(i, 1);
        }
    }
}

/* ────────────────────────────────
 *  对外安装入口
 * ──────────────────────────────── */

/** 安装伪装体系：序列化 patch + 反序列化还原钩子。
 *  由 A001_SubgraphNode.js 在 app.registerExtension 的 setup 里调用。
 *  window.LGraph 在 setup 早期可能未就绪 → 带重试兜底（最多 10 次 × 300ms，
 *  与连线徽标同款策略）。 */
export function installA001Disguise() {
    let tries = 0;
    const tryInstall = () => {
        const ok = safeCall(() => installDisguiseSerializer(), false, "安装伪装序列化 patch");
        if (ok) {
            alog("原生子图伪装（开关版）：已安装序列化 patch");
            return;
        }
        tries += 1;
        if (tries < 10) setTimeout(tryInstall, 300);
        else alog("原生子图伪装（开关版）：序列化 patch 安装失败（LGraph 持续不可用）");
    };
    tryInstall();
    return true;
}

/** registerExtension 的 beforeConfigureGraph 钩子实现（还原入口）。 */
export function onBeforeConfigureGraph(graphData) {
    safeCall(() => restoreA001FromDisguise(graphData), undefined, "disguise 反序列化还原");
}
