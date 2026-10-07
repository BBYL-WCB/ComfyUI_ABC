/* =============================================================================
 * A001_prompt_editor.js —— A001 @文本编辑器 · 主模块
 * -----------------------------------------------------------------------------
 * 一、这个模块解决什么问题
 * -----------------------------------------------------------------------------
 * A001 把子图内层节点的 widget「提升」到容器外层后，多行文本控件由官方 Vue
 * （Nodes 2.0）渲染成 textarea。本模块把该控件**换成自研富文本编辑器**：
 *   · 结构：contenteditable 编辑器 + mention chip（@图片1）+ 对话块（#）
 *   · 数据：doc{text,parts} 存 node.properties.a001_prompt_docs[槽名]
 *   · 值  ：写回「提升槽」的双通道（内层源 widget + 官方 widgetValueStore）
 *
 * 二、为什么不用 addDOMWidget（本模块的根本约束）
 * -----------------------------------------------------------------------------
 * 参考实现（002_MiniMaxH3_Easy参考/web/minimax_h3_easy_ui.js）用
 * node.addDOMWidget 挂自研编辑器。但 A001 **严禁**该 API —— 实测会触发 Vue
 * 全量重建并直接崩溃（见 A001_grid_anchor.js 头注「绝对不要做的事」）。
 * 故本模块改走 A001 面板已验证的路线：
 *   ① 定位官方控件行 DOM（不猜位置，找不到就重试）
 *   ② 仅把官方 textarea 置为 display:none（不改 widget.type / options / computeSize，
 *      行必须继续存在，否则不该出现在控件网格里 —— 那会破坏组件契约）
 *   ③ 在 textarea 之后手工插入自研 wrap（完全脱离 widget 系统）
 *   ④ 单一重试链 + MutationObserver 守卫，Vue 重建 DOM 后同帧重挂
 *
 * 三、值同步（对齐 bindA001StoreReflow 的实测结论）
 * -----------------------------------------------------------------------------
 *   A001_SubgraphNode.js 注释写明：官方 Vue 控件输入时**只写 store，
 *   从不调用 state.callback**。故唯一出口 writePromotedText 必须三写：
 *     src.value          —— 内层真实节点（执行真值）
 *     store.setValue(id) —— 官方 UI / 其它消费者
 *     input._widget.value—— 投影描述符缓存
 *   并把值相等短路作为防循环的第一道闸。
 *
 * 四、rec 记录契约（mentions / history 模块共用）
 * -----------------------------------------------------------------------------
 *   { node, outerInput, slotName, row, textarea, wrap, editor, tools, viewButton,
 *     menu, history, locateStrategy, disposed,
 *     syncFromEditor(markDirty), serializeNow(), pushHistory(),
 *     renderFromDoc(force), applyHistoryEntry(doc),
 *     closeMentionMenu(), refreshMentionPreviews() }
 *
 * 五、依赖注入
 * -----------------------------------------------------------------------------
 * 本模块需要 A001_SubgraphNode.js 的私有能力（store 探测、尺寸重算、胶囊刷新），
 * 用 initPromptDeps 反向注入（与 initAppearanceDeps / initRunDeps 同范式），
 * 避免 ESM 循环依赖。
 * ========================================================================== */

import { safeCall, getNodeGraph, alog } from "./A001_shared.js?v=20261007a";
import {
    A001_WRAP_CLASS,
    A001_EDITOR_CLASS,
    A001_CHIP_CLASS,
    A001_DIALOGUE_CLASS,
    A001_ROW_CLASS,
    A001_DOM_ATTR,
    A001_SLOT_ATTR,
    A001_CARET_SENTINEL,
    A001_TEXT,
    A001_PROMPT_VIEW_RAW,
    A001_PROMPT_VIEW_STRUCTURED,
    a001ClonePromptDoc,
    a001EmptyPromptDoc,
    a001PromptDocTextFromParts,
    a001PromptPartsFromText,
    a001ReadPromptRecord,
    a001WritePromptRecord,
    injectA001PromptCss,
} from "./A001_prompt_core.js?v=20261007a";
import {
    a001CanUseMediaMentions,
    a001CloseMentionMenu,
    a001HandleMentionMenuKeydown,
    a001InsertTextWithMentionChips,
    a001IsMentionChip,
    a001MakeMentionChip,
    a001MentionOptions,
    a001RefreshMentionPreviews,
    a001RequestMentionRefresh,
    a001ResolveMentionFrom,
    a001SyncMentionMenuToCaret,
} from "./A001_prompt_mentions.js?v=20261007a";
import {
    a001HandlePromptHistoryKeydown,
    a001InstallPromptUndoShield,
    a001IsUndoRedoEvent,
    a001PatchLGraphCanvasProcessKey,
    a001PrepareEditorForUndo,
    a001PushPromptHistory,
    a001ResetPromptHistory,
    a001SetActivePromptRec,
    a001ClearActivePromptRec,
    initPromptHistoryDeps,
} from "./A001_prompt_history.js?v=20261007a";

/* ════════════════════════════════════════════════
 *  0 · 依赖注入
 * ════════════════════════════════════════════════ */

/** 默认的节点根定位（与 A001_Appearance.js findNodeRoot 同款语义与缓存键，
 *  可安全共存：命中即复用 node._a001DomRoot，避免每轮全量 querySelector）。 */
function defaultFindNodeRoot(node) {
    if (typeof document === "undefined" || node?.id == null) return null;
    const cached = node._a001DomRoot;
    if (cached?.isConnected && cached.getAttribute?.("data-node-id") === String(node.id)) {
        return cached;
    }
    const hit = document.querySelector(`[data-node-id="${node.id}"]`);
    if (hit) node._a001DomRoot = hit;
    return hit;
}

let deps = {
    getStore: () => null,
    refreshPortCapsule: () => {},
    dirtyCanvas: () => {},
    isMultilineWidget: () => false,
    findNodeRoot: defaultFindNodeRoot,
    isWidgetsHidden: () => false,
    /* ★ 拖拽手柄改高后，把「节点总高」同步一次（映射 A001_SubgraphNode 的
     *  resyncA001SizeLock）。编辑器只改「承载行的 min-height」，行高被撑大后
     *  chrome 变大，由高度模型 apply() 把节点加高到「新 chrome + wanted」，
     *  预览框高度不变 —— 与原生 textarea 拖拽的联动口径完全一致。 */
    syncNodeHeight: () => {},
    /* ★ 画布缩放（app.canvas.ds.scale）：拖拽手柄把「屏幕像素位移」换算成
     *  「布局像素增量」时必须用它 —— 节点 DOM 被画布 transform:scale 缩放，
     *  不换算就会「不跟手」（详见 bindResizerEvents 的 onMove 注释）。 */
    canvasScale: () => 1,
};

export function initPromptDeps(injected) {
    const next = Object.assign({}, deps);
    for (const key of Object.keys(deps)) {
        if (typeof injected?.[key] === "function") next[key] = injected[key];
    }
    deps = next;
    a001InstallPromptUndoShield();
    a001PatchLGraphCanvasProcessKey();
    injectA001PromptCss();
}

/* ════════════════════════════════════════════════
 *  1 · 小工具
 * ════════════════════════════════════════════════ */

const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

/** 打「自身写入」抑制窗口：编辑器自身改动不该唤醒守卫做重挂判定。
 *  窗口刻意取小（80ms）：宁可多一次幂等空转，也不要长期压住守卫，
 *  否则「装配后 Vue 紧接着重建控件行」会被误静默（另有 onResize 兜底）。 */
function noteSelfWrite(node, ms = 80) {
    if (node) node._a001PromptSelfWriteUntil = nowMs() + ms;
}

function inSelfWrite(node) {
    return nowMs() < (Number(node?._a001PromptSelfWriteUntil) || 0);
}

/** 取提升槽的 widgetId。 */
function slotWidgetId(outerInput) {
    return outerInput?._a001OfficialWidgetId ?? outerInput?.widgetId ?? null;
}

/** 取提升文本控件的当前真值（内层源 widget 优先）。 */
function currentTextOf(node, outerInput) {
    const src = outerInput?._a001SourceWidget;
    if (src && src.value != null) return String(src.value);
    const id = slotWidgetId(outerInput);
    const store = deps.getStore();
    const value = safeCall(() => (store && id ? store.getWidget(id)?.value : null), null, "取提升控件值");
    return value == null ? "" : String(value);
}

/**
 * 唯一值出口：把编辑器文本写回提升槽（三写 + 值相等短路）。
 * @returns {boolean} 是否发生了写入
 */
function writePromotedText(node, outerInput, text) {
    const next = String(text ?? "");
    const src = outerInput?._a001SourceWidget;
    const id = slotWidgetId(outerInput);
    const store = deps.getStore();
    let wrote = false;
    if (src && src.value !== next) {
        src.value = next;
        wrote = true;
        safeCall(() => src.callback?.(next, node), undefined, "提升文本回流源 callback");
    }
    if (store && id && safeCall(() => store.getWidget(id)?.value, null, "取 store 值") !== next) {
        safeCall(() => store.setValue(id, next), undefined, "写官方 widgetValueStore");
        wrote = true;
    }
    const projected = outerInput?._widget;
    if (projected && projected.value !== next) {
        safeCall(() => { projected.value = next; }, undefined, "写投影描述符");
        wrote = true;
    }
    return wrote;
}

/* ── 外部改值 → 回灌编辑器（plan §3.2） ──
 * 场景：工作流加载 / 官方控件被外部程序改写 / 其它节点联动改本槽值。
 * 此时 store 被写入，而编辑器 DOM 仍是旧内容 —— 不处理就会「显示旧文本、
 * 但执行用的是新值」。
 *
 * 实现要点（逐条都是防循环/防打断的关键）：
 *   · 只用 id→rec 反查表，不做全图扫描（setValue 是最高频回调之一）
 *   · 编辑器正在聚焦（用户打字中）→ 一律跳过，绝不打断输入
 *   · rec.doc.text 与目标值相等 → 短路（自己写 store 时也会走到这里）
 *   · rec.syncing 重入锁 → 跳过序列化中的自激
 */
const REC_BY_WIDGET_ID = new Map();
const A001_STORE_HOOKED = new WeakSet();

/** 把 rec 登记进 id 反查表（槽被反提升时须移除，否则 Map 会强引用节点无法 GC）。 */
function registerRecId(rec) {
    const id = slotWidgetId(rec?.outerInput);
    if (id) REC_BY_WIDGET_ID.set(id, rec);
}

function unregisterRecId(rec) {
    const id = slotWidgetId(rec?.outerInput);
    if (id && REC_BY_WIDGET_ID.get(id) === rec) REC_BY_WIDGET_ID.delete(id);
}

function hookStoreExternalSync() {
    const store = deps.getStore();
    if (!store || typeof store.$onAction !== "function") return;
    if (A001_STORE_HOOKED.has(store)) return;
    A001_STORE_HOOKED.add(store);
    safeCall(() => {
        store.$onAction((ctx) => {
            if (ctx?.name !== "setValue") return;
            if (!REC_BY_WIDGET_ID.size) return;
            const [id, value] = ctx.args || [];
            if (typeof id !== "string") return;
            const rec = REC_BY_WIDGET_ID.get(id);
            if (!rec || rec.disposed || rec.syncing) return;
            if (document.activeElement === rec.editor) return;
            const next = String(value ?? "");
            if (String(rec.doc?.text ?? "") === next) return;
            /* 以外部新值为真相重建 parts（旧 chip 尽量解析回来，解析不到则标 unresolved）。 */
            rec.doc = {
                v: 1,
                text: next,
                parts: a001PromptPartsFromText(next, a001ResolveMentionFrom(rec.node)),
                view: rec.doc?.view === A001_PROMPT_VIEW_RAW ? A001_PROMPT_VIEW_RAW : A001_PROMPT_VIEW_STRUCTURED,
            };
            safeCall(() => rec.persistDoc(), undefined, "外部改值后落盘");
            renderEditorFromDoc(rec, true);
            a001ResetPromptHistory(rec);
        });
    }, undefined, "注册 store 外部改值回灌监听");
}

/* ════════════════════════════════════════════════
 *  2 · 行定位（分层回退，找不到就重试；绝不猜位置）
 * ════════════════════════════════════════════════ */

/** 找控件网格宿主。 */
function findWidgetGrid(node) {
    const root = deps.findNodeRoot(node);
    if (!root) return null;
    return root.querySelector(".lg-node-widgets")
        || root.querySelector("[data-widgets-grid-node-id]")
        || null;
}

/** 行的候选名集合（外层槽名 + 内层源控件名 / label）。 */
function rowNameCandidates(outerInput) {
    const names = new Set();
    const push = (v) => { if (v != null && String(v)) names.add(String(v)); };
    push(outerInput?.name);
    push(outerInput?.label);
    push(outerInput?._a001SourceWidget?.name);
    push(outerInput?._a001SourceWidget?.label);
    return names;
}

/** 从行元素（或其祖先）读 data-widget-name。 */
function rowWidgetName(row) {
    if (!row) return "";
    const holder = row.closest?.("[data-widget-name]") || row;
    return String(holder?.getAttribute?.("data-widget-name") || "");
}

/**
 * 定位「本提升槽」对应的控件行与被隐藏的官方 textarea。
 *
 * 策略（命中即停；顺序按「可靠度」排列，越靠前越精确）：
 *   单 textarea → 直接采用
 *   多 textarea → ① 行 data-widget-name 命中槽名/源控件名（最可靠）
 *                 ② 行 data-widget-id 命中 widgetId
 *                 ③ 值匹配（要求唯一命中）
 *                 ④ 投影 widgets 下标兜底（依赖投影顺序 === 网格行顺序）
 * 全部失败则返回 null，交给重试链；**绝不 append 到猜测位置**。
 * @returns {{grid:Element, row:Element, textarea:Element, strategy:string}|null}
 */
function locatePromotedTextRow(node, outerInput) {
    const grid = findWidgetGrid(node);
    if (!grid) return null;

    const all = Array.from(grid.querySelectorAll("textarea")).filter(
        (el) => !el.closest?.(`.${A001_WRAP_CLASS}`)
    );
    if (!all.length) return null;

    /* ★ 单 textarea 只在「本节点只有一个可编辑槽」时才可无条件采用：
     *   若同时有多个多行文本提升槽，早期（其它槽尚未装配）单 textarea 确实成立，
     *   但后到的槽会把这个已装配的 textarea 当成自己的 —— 两个编辑器挂在同一行上。
     *   故多槽节点一律走下面的精确匹配分支。 */
    const multiSlot = (node.inputs || []).filter((inp) => slotEditability(inp) === "yes").length > 1;

    let textarea = null;
    let strategy = "";

    if (all.length === 1 && !multiSlot) {
        textarea = all[0];
        strategy = "single";
    } else {
        const names = rowNameCandidates(outerInput);
        const id = slotWidgetId(outerInput);

        /* ① 行名匹配 */
        for (const el of all) {
            const row = el.closest?.("[data-widget-name]") || el.closest?.(".lg-node-widget") || el.parentElement;
            const name = rowWidgetName(row);
            if (name && names.has(name)) {
                textarea = el;
                strategy = "rowName";
                break;
            }
        }
        /* ② 行 data-widget-id 匹配 */
        if (!textarea && id) {
            for (const el of all) {
                const row = el.closest?.(".lg-node-widget") || el.parentElement;
                const holder = row?.closest?.("[data-widget-id]") || row;
                if (String(holder?.getAttribute?.("data-widget-id") || "") === String(id)) {
                    textarea = el;
                    strategy = "rowWidgetId";
                    break;
                }
            }
        }
        /* ④ 值匹配（唯一命中才认；比下标映射更可靠，故排在它前面） */
        if (!textarea) {
            const want = currentTextOf(node, outerInput);
            const hits = all.filter((el) => String(el.value ?? "") === want);
            if (hits.length === 1) {
                textarea = hits[0];
                strategy = "value";
            }
        }
        /* ⑤ 投影 widgets 下标兜底。
         * ★ 必须基于「网格里的全部行」而不是「只有 textarea 的行」取样：
         *   node.widgets 的下标口径包含非文本框行（如锚点行），
         *   若拿过滤后的 textarea 数组去索引，槽一多就会整体错位。 */
        if (!textarea) {
            const widget = outerInput?._widget;
            const list = node.widgets || [];
            const index = widget ? list.indexOf(widget) : -1;
            if (index >= 0) {
                const rows = Array.from(grid.querySelectorAll(".lg-node-widget"));
                const targetRow = rows[index];
                const ta = targetRow
                    ? Array.from(targetRow.querySelectorAll("textarea"))
                        .find((el) => !el.closest?.(`.${A001_WRAP_CLASS}`))
                    : null;
                if (ta) {
                    textarea = ta;
                    strategy = "widgetIndex";
                }
            }
        }
    }
    if (!textarea) return null;

    const row = textarea.closest?.(".lg-node-widget") || textarea.parentElement;
    if (!row || !grid.contains(row) || !row.contains(textarea)) return null;
    return { grid, row, textarea, strategy };
}

/* ════════════════════════════════════════════════
 *  3 · DOM 装配
 * ════════════════════════════════════════════════ */

/** 取官方控件行内、与本槽 textarea 关联的那个浮动标签（<label for=textarea.id>）。
 *
 *  官方多行文本控件（customtext）会在控件左上角渲染一个 absolute 定位的
 *  `<label>文本</label>`（`top-1.5 left-3`，如 CLIP 文本编码所见）。
 *  我们只把官方 textarea 置为 display:none，该 label 并不属于 textarea 的子树，
 *  因此会残留、悬浮在自研编辑器第一行左上方（用户看到「第一行内置的『文本』二字」）。
 *  故此处按 for→id 精确取回该 label，与 textarea 一同隐藏/恢复。 */
function officialRowLabel(rec) {
    const ta = rec?.textarea;
    const row = rec?.row;
    if (!ta || !row) return null;
    const id = ta.id;
    if (!id) return null;
    /* 限定在本行内查找，避免误伤其它控件行的同名标签。 */
    return row.querySelector(`label[for="${CSS.escape(id)}"]`);
}

/** 隐藏官方 textarea 及其浮动标签（只做元素级隐藏，不动 widget 元数据）。
 *
 *  ★ 补挂第三方提示词小助手(005)期间**必须放行**（否则补挂永远失败）：
 *    005 需要官方 textarea 处于可见态才能通过其可见性校验并完成异步挂载。
 *    而本节点的守卫 MutationObserver 会观察到「textarea 被置可见」这次 style
 *    变化，进而调用装配/刷新 → 走到这里把 textarea 又拍回 display:none，
 *    于是 005 的异步查找始终看到隐藏 textarea → 图标永远挂不上。
 *    （实测现象：手动分步显示 textarea 能挂上，但被守卫拍回后再查即丢失。）
 *    故：只要 _a001PromptPaRewiring 为真（补挂轮询进行中），此处直接跳过隐藏；
 *    补挂结束（成功或超时）后由 rewirePromptAssistantForSlot 的 finish 统一恢复隐藏。 */
function hideOfficialTextarea(rec) {
    const ta = rec?.textarea;
    if (!ta) return;
    if (rec.node?._a001PromptPaRewiring) return;
    /* ★ 热点早退：textarea 与该行浮动标签均已隐藏时直接返回，跳过 querySelector。
     *  本函数在两个高频入口被调用（守卫 MO 回调、onResize→refresh），
     *  健康态下每批/每帧都要跑一次 label[for] 查询，这里把它省掉。
     *  用 rec._a001TaHidden 记账：置 none 后为 true，showOfficialTextarea 会复位。 */
    if (rec._a001TaHidden && ta.style.display === "none") return;
    if (ta.style.display !== "none") ta.style.display = "none";
    /* 标签是 textarea 的兄弟（不在其子树里），必须单独隐藏。 */
    const label = officialRowLabel(rec);
    if (label && label.style.display !== "none") label.style.display = "none";
    rec._a001TaHidden = true;
}

/** 恢复官方 textarea（及其浮动标签）显示（卸载时调用，节点对象可能被撤销复用）。 */
function showOfficialTextarea(rec) {
    const ta = rec?.textarea;
    if (!ta) return;
    if (ta.style.display === "none") ta.style.display = "";
    const label = officialRowLabel(rec);
    if (label && label.style.display === "none") label.style.display = "";
    /* 复位隐藏记账：下次 hideOfficialTextarea 需重新执行一次 querySelector/隐藏。 */
    rec._a001TaHidden = false;
}

/* ── 「不占布局的可见」：方案 A 的核心工具 ─────────────────────────────────
 *
 * ★ 背景（实测根因）
 * -----------------------------------------------------------------------------
 *  005 提示词小助手的补挂流程要求官方 textarea 处于**可见**态（其
 *  UIToolkit.isElementVisible 只判定内联 `style.display !== 'none'` 且
 *  `style.visibility !== 'hidden'`，**不查 offsetHeight / getBoundingClientRect**）。
 *  而官方 textarea 一旦以正常文档流方式显示，控件行就会多占 20px
 *  （= NODE_WIDGET_HEIGHT），补挂结束再隐藏又缩回 —— 于是「点击显示控件」时
 *  出现一次约 150ms 的 +20px 涨落抖动（已在浏览器 A/B 实测确认）。
 *
 * ★ 解法
 * -----------------------------------------------------------------------------
 *  让 textarea「**可见但不参与布局**」：
 *    · 保留 `display` 非 none → 通过 005 的可见性校验；
 *    · 用 `position:absolute` 将其**移出文档流** → 不再撑高控件行；
 *    · `opacity:0 + pointer-events:none + z-index:-1` → 用户完全看不到、碰不到，
 *      且位于自研编辑器之下（编辑器 wrap 是 absolute; inset:0，本就在其上）。
 *  finish() 时恢复被改写的全部内联样式，再设回 display:none。
 *
 *  被改写的样式会在进入前快照保存，退出时精确还原，避免污染其它逻辑。
 */
const PA_OFFSCREEN_STYLES = {
    position: "absolute",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "-1",
    height: "0",
    minHeight: "0",
    maxHeight: "0",
    padding: "0",
    borderWidth: "0",
    margin: "0",
    left: "0",
    top: "0",
    width: "1px",
    minWidth: "0",
};

/** 把官方 textarea 切到「不占布局的可见」态；返回被改写样式的快照（供还原）。 */
function offscreenOfficialTextarea(ta) {
    if (!ta) return null;
    const snapshot = {};
    for (const prop of Object.keys(PA_OFFSCREEN_STYLES)) {
        snapshot[prop] = ta.style[prop];
        ta.style[prop] = PA_OFFSCREEN_STYLES[prop];
    }
    /* display 必须显式清成可见（覆盖此前可能残留的 none）。 */
    snapshot.display = ta.style.display;
    ta.style.display = "";
    /* visibility 也归零，防止此前被设成 hidden 导致 005 判不可见。 */
    snapshot.visibility = ta.style.visibility;
    ta.style.visibility = "";
    return snapshot;
}

/** 还原 offscreenOfficialTextarea 改写过的样式；display 交由调用方决定。 */
function restoreOfficialTextareaLayout(ta, snapshot) {
    if (!ta || !snapshot) return;
    for (const prop of Object.keys(snapshot)) {
        ta.style[prop] = snapshot[prop];
    }
}

/* ★ 编辑器高度**完全由 CSS 决定**，这里没有任何高度测量/写入逻辑（勿再加回）：
 *  .a001-prompt-editor-wrap{height:100%} 撑满 grid 行 → 与原生 textarea 天然等高、
 *  并随节点拉伸自动跟随。原理与出处见 A001_prompt_core.js 的「高度方案」注释，
 *  以及已验证实现备份 ABC备份\20260926_054248_A001编辑器高度覆盖原生控件。
 *  历史上曾用「JS 测量 textarea 高度 → 写 CSS 变量」与「ResizeObserver 跟随行高」
 *  两种方案，前者量到的是被隐藏元素（不可靠），后者会把 grid 行高的变化误当成
 *  控件高度变化（导致编辑器跟着节点一起变高）—— 均已被推翻。 */

/**
 * 标记承载行 + 在 wrap 上记录槽名。
 *
 * ★ 给承载行加类名的目的**只有一个**：让它成为 wrap 的定位上下文
 *   （CSS `.a001-prompt-row { position:relative }`），使 wrap 的
 *   `position:absolute; inset:0` 能贴合该行，从而与官方控件等高。
 * ★ 该类名在 CSS 里**只声明 position**，不写任何尺寸/对齐属性 ——
 *   行的空间必须继续由官方 _arrangeWidgets 弹性分配，插手尺寸会让节点
 *   高度无法自由伸缩（血泪教训，见 A001_prompt_core.js 高度方案注释）。
 */
function markRow(rec) {
    const row = rec?.row;
    if (row && !row.classList.contains(A001_ROW_CLASS)) row.classList.add(A001_ROW_CLASS);
    const wrap = rec?.wrap;
    if (!wrap) return;
    const current = wrap.getAttribute(A001_SLOT_ATTR);
    if (current !== String(rec.slotName)) wrap.setAttribute(A001_SLOT_ATTR, String(rec.slotName));
}

/** 构造 ComfyUI 自带的 PrimeIcons 字体图标元素（<i class="pi pi-xxx">）。 */
function makeToolIcon(iconName) {
    const icon = document.createElement("i");
    icon.className = `pi ${iconName}`;
    icon.setAttribute("aria-hidden", "true");
    return icon;
}

/** 构造 wrap + editor + 工具条。 */
function buildEditorDom(rec) {
    const wrap = document.createElement("div");
    wrap.className = A001_WRAP_CLASS;
    wrap.setAttribute(A001_DOM_ATTR, "1");
    wrap.setAttribute(A001_SLOT_ATTR, String(rec.slotName));

    const editor = document.createElement("div");
    /* ★★ 刻意**不加** `comfy-multiline-input`（血泪教训，勿加回）
     * ----------------------------------------------------------------
     *  该官方类在 ComfyUI 全局样式里带 `overflow: hidden`（因为原生
     *  <textarea> 自己就能滚动，外层不需要滚动容器）。我们的编辑器是
     *  contenteditable 的 <div>，滚动必须由它自己承担；
     *  带上这个类会导致：
     *    · 常驻竖向滑条完全不出现（父级 overflow:hidden 把滚动能力掐掉）；
     *    · 内容超出后被直接裁掉，看不到也滚不到；
     *    · 早前「第 2 行才开始输入文本」的怪异表现也与它有关。
     *  外观（底色/边框/圆角/字体）全部由 .a001-prompt-editor 自行声明，
     *  不需要借用官方的文本域样式。 */
    editor.className = A001_EDITOR_CLASS;
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    editor.spellcheck = false;
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", `prompt ${rec.slotName}`);
    editor.dataset.placeholder = A001_TEXT.placeholder;
    a001PrepareEditorForUndo(editor);

    const tools = document.createElement("div");
    tools.className = "a001-prompt-editor-tools";
    /* 三个工具按钮统一用 ComfyUI 自带的 PrimeIcons 字体图标（pi pi-*）：
     *  · 字体随 ComfyUI 预加载，不依赖运行时按需生成（比 UnoCSS 的
     *    icon-[lucide--*] 更稳）；
     *  · 单色字形，跟随按钮的 color / opacity（emoji 做不到）；
     *  · 同一字体内尺寸一致，天然对齐，无需逐个微调字号。 */
    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.className = "a001-prompt-editor-tool a001-prompt-editor-view-toggle";
    viewButton.append(makeToolIcon("pi-objects-column"));
    viewButton.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    viewButton.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePromptView(rec);
    });
    tools.append(viewButton);
    /* ★ 文本清理按钮：放在「笔」右侧，一键清空当前文本框内容。 */
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "a001-prompt-editor-tool a001-prompt-editor-clear";
    clearButton.append(makeToolIcon("pi-trash"));
    clearButton.title = A001_TEXT.clearText;
    clearButton.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    clearButton.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearPromptText(rec);
    });
    tools.append(clearButton);
    /* ★ 复制按钮：放在清理按钮右侧，把文本框内文字全部复制到剪贴板。 */
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "a001-prompt-editor-tool a001-prompt-editor-copy";
    copyButton.append(makeToolIcon("pi-copy"));
    copyButton.title = A001_TEXT.copyText;
    copyButton.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    copyButton.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyPromptText(rec);
    });
    tools.append(copyButton);

    wrap.append(editor, tools);
    /* ★ 右下角纵向拖拽手柄：编辑器是 contenteditable <div>，浏览器原生 resize
     *  对其无效，故自绘一个手柄并挂 JS 拖拽（逻辑见 bindResizerEvents）。
     *  外观与 A001_textarea_resize.js 的 textarea::-webkit-resizer 完全一致。 */
    const resizer = document.createElement("div");
    resizer.className = "a001-prompt-resizer";
    resizer.setAttribute("aria-hidden", "true");
    wrap.append(resizer);
    return { wrap, editor, tools, viewButton, clearButton, copyButton, resizer };
}

/* ── 为第三方「提示词小助手」(005) 补挂图标 ──
 *
 * ★★ 为什么需要这段（实测根因，勿删）
 * -----------------------------------------------------------------------------
 *  第三方插件 005_comfyui_prompt_assistant 会把它的图标 append 到
 *  **官方 textarea 的父容器**（.p-floatlabel / textarea.parentElement）。
 *  而本编辑器为了保证「官方控件让位」，把官方 textarea 置为 display:none。
 *  005 的 UIToolkit.isValidInput 里有一条「可见性补救」：控件元素若
 *  display:none 即判为**无效控件** → 于是它不会给本节点挂图标。
 *
 *  更糟的是 005 没有监听 DOM 重建：其挂载时机只有「节点首次被选中」与
 *  「启用时全图扫描」，且处理后会把 node._promptAssistantInitialized 置 true。
 *  因此一旦发生下列任一 DOM 重建，图标被 Vue 随行回收后就**永不回来**：
 *    · 隐藏控件（整行控件被回收）
 *    · 退出/进入子图（内部 DOM 卸载重建）
 *    · 切换工作流（整图 DOM 重建）
 *
 *  实测解法（浏览器已验证）：
 *    ① 临时把官方 textarea 恢复可见（让 005 的可见性校验通过）；
 *    ② 复位 node._promptAssistantInitialized，调 005 的 checkAndSetupNode(node)
 *       —— 它内部自带「UI 丢失则 cleanup 重建」逻辑，是幂等入口；
 *    ③ 待 005 图标真正挂好后，再恢复 textarea 隐藏。
 *
 *  ★★ 第③步为什么必须「等」而不能「立即」做（二次踩坑，勿改回同步）
 *  -----------------------------------------------------------------------------
 *  005 的容器查找是**异步 Promise**：checkAndSetupNode → setupNodeAssistant
 *  → createAssistantUI → _setupUIPosition → nodeMountService
 *      .findMountContainerWithRetry(...).then(...)
 *  Vue 模式下该查找带重试（maxRetries:5 / retryInterval:800ms），且每次查找
 *  都会经 UIToolkit.isValidInput 的「可见性补救」校验 textarea 是否可见。
 *  因此若在第②步之后**同步**把 textarea 设回 display:none，005 的异步查找
 *  在其后执行时看到的仍是隐藏 textarea → 判定无效 → 图标永远挂不上
 *  （实测现象：手动分步调用能成功、合并到同一次同步调用就失败）。
 *  故这里改为**轮询等待图标出现**再恢复隐藏，并留兜底超时。
 *
 *  因为 005 的图标挂在 textarea 的**父容器**上、不挂在 textarea 自身，
 *  所以等它挂好后再隐藏 textarea 不会影响已挂好的图标。
 *
 *  ⚠️ 全程容错：005 未安装 / API 变更 / 已挂过图标，都必须静默跳过，
 *     绝不影响本编辑器自身的装配流程。
 */

/** 005 图标容器类名（来自其 AssistantContainer.js）。 */
const PA_ICON_SELECTOR = ".assistant-container-common";

/** 补挂单轮内等待 005 异步挂载的时间窗。
 *  ★ 必须 ≥ 005 的完整重试周期：其 Vue 模式查找为 maxRetries:5 × retryInterval:800ms
 *  ≈ 4s（实测保持可见 5s 内必挂上、1.6s 窗口则失败）。
 *  这段可见窗口对用户无影响：官方 textarea 被本编辑器 wrap（absolute; inset:0）完全覆盖。 */
const PA_REWIRE_WAIT_MS = 5000;
/** 轮询间隔。 */
const PA_REWIRE_POLL_MS = 150;
/** 补挂最大轮次（应对 005 异步查找的时序竞争）。 */
const PA_REWIRE_ROUNDS = 2;
/** 轮次之间的间隔。
 *  ★ 不宜为 0：005 内部有 _isMounting 竞争保护，过密的重复调用会被它跳过。 */
const PA_REWIRE_ROUND_GAP_MS = 300;

/** 查询 005 的实例管理器（未安装则返回 null）。 */
function promptAssistantApi() {
    return safeCall(() => globalThis.app?.promptAssistant ?? null, null, "取提示词小助手实例");
}

/* ── 全局兜底：hook 005 的 checkAndSetupNode，在其建立实例后修正 Note 误判 ──
 *
 * ★ 为什么还要这一个全局 hook（只靠编辑器装配路径不够）
 * -----------------------------------------------------------------------------
 *  A001 节点**未必有提升文本控件**（例如某些工作流里的 A001 只有普通控件），
 *  这种节点上编辑器装配路径不会触发 → 只挂编辑器收口的修正就永远轮不到它。
 *  而 005 在自己的「节点选中 / 全图扫描」路径里仍会给它建实例（同样带 Note 误判）。
 *  故这里再包一层 005 的入口：无论它从哪条路径建实例，建完我们都跟进修正。
 *  该 hook 全局只装一次（window 标记去重），成本极低（仅在一次 setup 后遍历实例表）。
 */
function hookPromptAssistantSetup() {
    const api = promptAssistantApi();
    if (!api || typeof api.checkAndSetupNode !== "function") return;
    if (api.__a001CheckHooked) return;
    api.__a001CheckHooked = true;
    const prev = api.checkAndSetupNode;
    api.checkAndSetupNode = function () {
        const out = prev.apply(this, arguments);
        /* 005 建实例是异步的，稍后再修正（用节点级调度，天然幂等）。 */
        safeCall(() => {
            const g = globalThis.app?.graph;
            for (const n of (g?._nodes || [])) {
                if (n?.type === "A001_SubgraphNode") schedulePromptAssistantNoteFix(n);
            }
        }, undefined, "005 setup 后修正 Note 误判");
        return out;
    };
    alog("已安装 005 checkAndSetupNode 兜底 hook");
}

/* ── 修正 005 对 A001 节点的「Note 节点」误判 ──
 *
 * ★★ 为什么需要（实测根因，勿删）
 * -----------------------------------------------------------------------------
 *  005 的 PromptAssistant._isMarkdownNode(node) 末尾有一行兜底判定：
 *      typeLower.includes('subgraph')
 *  而本节点的 type 恰为 "A001_SubgraphNode"，小写后含 "subgraph"
 *  → 被 005 判为「子图/Note 类节点」→ isNoteNode = true。
 *
 *  005 在 addFunctionButtons 里对多数功能按钮的可见性写成：
 *      visible: !isNoteNode && FEATURES.history / tag / expand
 *  只有「翻译」按钮是 visible: FEATURES.translate（注释：Note 节点只显示此按钮）。
 *  于是本节点上的助手只创建了 1 个「翻译」按钮，历史/撤销/重做/标签/优化
 *  全被隐藏 —— 表现就是「鼠标悬浮展开后什么都没有」，而普通节点（如 CLIP
 *  文本编码）能正常展开出完整工具条。
 *
 *  修法（A001 侧，不改第三方插件）：
 *    找到 005 为本节点建立的那个实例 → 把 nodeInfo.isNoteNode 改回 false
 *    → 清空其已生成的按钮 → 重调其 addFunctionButtons 生成完整按钮集。
 *    （instance 与按钮字典均可经 app.promptAssistant.constructor.instances 访问。）
 *
 *  ⚠️ 全程容错：005 未安装 / 结构变更 / 已修正过，都必须静默跳过。
 */

/** 判断某 005 实例是否属于本节点。 */
function isInstanceOfNode(inst, node) {
    return !!inst && String(inst.nodeId) === String(node?.id);
}

/**
 * 修正 005 对某节点的 Note 误判（幂等；已修正则跳过）。
 *
 * ★ 为什么要「一次立即 + 若干次延迟重试」
 * -----------------------------------------------------------------------------
 *  实测：同一画布上两个结构完全相同的 A001 节点，只有先处理的那个能修正成功，
 *  后处理的那个此时 005 尚未把实例建好（实例/容器是异步 createAssistantUI 建
 *  的，晚于图标出现），导致 getInstance 找不到而静默跳过。
 *  故这里挂一个短延迟重试链，直到实例出现并被修正；修好即停。
 * @returns {boolean} 是否执行了修正
 */
function fixPromptAssistantNoteMisjudge(node) {
    const api = promptAssistantApi();
    const Instances = safeCall(() => api?.constructor?.instances, null, "取 005 实例表");
    if (!Instances || typeof Instances.forEach !== "function") return false;

    let fixed = false;
    safeCall(() => {
        Instances.forEach((inst) => {
            if (!isInstanceOfNode(inst, node)) return;
            const info = inst.nodeInfo;
            /* 只处理被误判为 Note 的实例。 */
            if (!info || info.isNoteNode !== true) return;

            info.isNoteNode = false;
            /* 清掉「只显示翻译」的那套按钮，重建为完整按钮集。
             * 必须同时清 DOM 与按钮字典，否则 addFunctionButtons 会与旧按钮叠加。 */
            if (inst.buttons) inst.buttons = {};
            const content = inst.container?.content;
            if (content) content.innerHTML = "";
            /* 重调 005 的按钮装配（其内部按新的 isNoteNode=false 生成全部按钮）。 */
            if (typeof api.addFunctionButtons === "function") api.addFunctionButtons(inst);
            fixed = true;
        });
    }, undefined, "修正提示词小助手 Note 误判");
    if (fixed) alog(`已修正第三方提示词小助手对 A001 的 Note 误判 | 节点:${node?.id}`);
    return fixed;
}

/** Note 误判修正的延迟重试间隔（覆盖 005 异步建实例的滞后）。 */
const PA_NOTE_FIX_RETRY_MS = 400;
/** Note 误判修正的最大重试次数。 */
const PA_NOTE_FIX_RETRIES = 6;

/**
 * 调度 Note 误判修正：立即试一次，未成功则短延迟重试若干次。
 * 用节点级标记防并发重入（多次装配/刷新不应叠加多条重试链）。
 */
function schedulePromptAssistantNoteFix(node) {
    if (!node || node._a001PromptPaNoteFixScheduled) return;
    if (safeCall(() => fixPromptAssistantNoteMisjudge(node), false, "修正提示词小助手 Note 误判")) return;
    node._a001PromptPaNoteFixScheduled = true;
    let tries = 0;
    const tick = () => {
        if (tries >= PA_NOTE_FIX_RETRIES) {
            node._a001PromptPaNoteFixScheduled = false;
            return;
        }
        tries += 1;
        if (safeCall(() => fixPromptAssistantNoteMisjudge(node), false, "延迟修正提示词小助手 Note 误判")) {
            node._a001PromptPaNoteFixScheduled = false;
            return;
        }
        setTimeout(tick, PA_NOTE_FIX_RETRY_MS);
    };
    setTimeout(tick, PA_NOTE_FIX_RETRY_MS);
}

/**
 * 为某槽补挂 005 图标（幂等；已挂则跳过）。
 *
 * ★ 为什么要「多轮」补挂（实测，勿简化成单轮）
 * -----------------------------------------------------------------------------
 *  005 的容器查找是异步的，且其内部一轮查找失败后**只销毁 container、不会自愈**。
 *  而 005 自身的重试（Vue 模式 5×800ms）与我们的调用时机可能错位；实测出现
 *  「同一时刻只补挂一个节点成功、另一个失败」的时序竞争（两个结构完全相同的
 *  A001 节点，一个挂上一个没挂）。因此这里做成**多轮**：每轮都把 textarea
 *  置可见 + 复位 init + 调 checkAndSetupNode，轮间等待一个短窗口；任一
 *  轮见到图标即收工，全部失败才放弃。
 *
 * ★ 恢复 textarea 隐藏是**异步**的（等 005 图标挂好或全部轮次超时），因此本
 *   函数会在节点上记一个哨兵（_a001PromptPaRewiring），避免并发重入。
 * @returns {boolean} 是否发起了补挂
 */
function rewirePromptAssistantForSlot(rec) {
    const node = rec?.node;
    const ta = rec?.textarea;
    if (!node || !ta || !ta.isConnected) return false;

    /* 未安装 005 / 总开关关闭 → 直接跳过。 */
    const api = promptAssistantApi();
    if (!api || typeof api.checkAndSetupNode !== "function") return false;
    if (!safeCall(() => globalThis.FEATURES?.enabled, false, "查询小助手总开关")) return false;

    const root = deps.findNodeRoot(node);
    if (!root) return false;

    /* 已存在图标 → 无需补挂（避免每次装配都触发 005 的清理重建）。
     * ★ 但仍要顺手做一次「Note 误判」修正：图标可能是在本逻辑之前（如 005
     *   自身的选中/全图扫描路径）挂上的，此时按钮很可能仍只有「翻译」。
     *   该修正函数幂等（已修正则 isNoteNode!==true 直接跳过），无副作用。 */
    if (root.querySelector(PA_ICON_SELECTOR)) {
        safeCall(() => schedulePromptAssistantNoteFix(node), undefined, "修正提示词小助手 Note 误判（图标已存在）");
        return false;
    }
    /* 已有一轮补挂/等待在途 → 不重复发起。 */
    if (node._a001PromptPaRewiring) return false;

    node._a001PromptPaRewiring = true;
    const prevDisplay = ta.style.display;
    /* 方案 A：本轮补挂期间，textarea 用「不占布局的可见」态（见 offscreenOfficialTextarea）。
     * 记录改写的样式快照，finish 时精确还原，避免污染其它逻辑。 */
    let layoutSnapshot = null;
    let round = 0;

    /** 结束：还原布局 + 恢复隐藏 + 释放哨兵。 */
    const finish = (found) => {
        node._a001PromptPaRewiring = false;
        /* ① 先还原补挂期间改写的布局样式（position/opacity/height 等）。 */
        safeCall(() => { restoreOfficialTextareaLayout(ta, layoutSnapshot); }, undefined, "还原官方 textarea 布局样式");
        layoutSnapshot = null;
        /* ② 无论成败都恢复隐藏态：我们的编辑器必须覆盖官方控件。
         * 用 prevDisplay 兜底，避免把「本来就没隐藏」的槽位误设成 none。
         * ★ 隐藏官方 textarea 时会顺带补上 offscreen 改写的样式归零，故这里先还原再置 none。 */
        safeCall(() => { ta.style.display = prevDisplay || "none"; }, undefined, "恢复官方 textarea 隐藏");
        if (found) {
            /* ★ 图标挂好后，修正 005 对 A001 的 Note 误判（否则只显示「翻译」按钮）。
             *  用调度版（含延迟重试）：005 的实例异步建好，可能晚于图标出现。 */
            safeCall(() => schedulePromptAssistantNoteFix(node), undefined, "修正提示词小助手 Note 误判");
            /* 补挂过程改变了 DOM，打一次自身写入抑制窗口避免守卫误判。 */
            noteSelfWrite(node);
            alog(`已为第三方提示词小助手补挂图标 | 槽:${rec.slotName} | 轮次:${round}`);
        } else {
            alog(`第三方提示词小助手图标补挂失败（已用尽轮次）| 槽:${rec.slotName}`);
        }
    };

    /** 单轮：置「不占布局的可见」+ 复位 init + check，等窗口后再判定。 */
    const runRound = () => {
        if (rec.disposed || !ta.isConnected || !deps.findNodeRoot(node)) return finish(false);
        round += 1;
        safeCall(() => {
            /* ① 切到「不占布局的可见」：display 非 none → 通过 005 可见性校验；
             *    position:absolute + 零高度 → 不撑高控件行，杜绝 +20px 抖动。 */
            layoutSnapshot = offscreenOfficialTextarea(ta);
            /* ② 复位「已处理」标记并调用其幂等入口（其内部异步查找容器）。 */
            node._promptAssistantInitialized = false;
            api.checkAndSetupNode(node);
        }, undefined, "为提示词小助手补挂图标");

        const startedAt = nowMs();
        const poll = () => {
            if (rec.disposed || !ta.isConnected) return finish(false);
            if (deps.findNodeRoot(node)?.querySelector(PA_ICON_SELECTOR)) return finish(true);
            if (nowMs() - startedAt < PA_REWIRE_WAIT_MS) return setTimeout(poll, PA_REWIRE_POLL_MS);
            /* 本轮超时：还有轮次则再来一轮，否则放弃。 */
            if (round < PA_REWIRE_ROUNDS) return setTimeout(runRound, PA_REWIRE_ROUND_GAP_MS);
            return finish(false);
        };
        setTimeout(poll, PA_REWIRE_POLL_MS);
    };

    setTimeout(runRound, 0);
    return true;
}

/* ════════════════════════════════════════════════
 *  4 · DOM → doc（序列化）
 * ════════════════════════════════════════════════ */

/**
 * 序列化编辑器 DOM 为 doc。
 *
 * 规则（与参考实现逐条对齐）：
 *   text 节点  → text part（剔除光标哨兵）
 *   对话块     → dialogue part
 *   mention chip → mention part（读 dataset 全字段）
 *   <br>       → 换行
 *   DIV/P 块级 → 前置换行（避免相邻块粘连）
 */
function serializeEditor(rec) {
    const editor = rec?.editor;
    const raw = rec?.doc?.view === A001_PROMPT_VIEW_RAW;
    if (!editor) return a001EmptyPromptDoc();

    const parts = [];
    const pushText = (text) => {
        const value = String(text || "").replaceAll(A001_CARET_SENTINEL, "");
        if (!value) return;
        if (parts.at(-1)?.type === "text") parts[parts.length - 1].text += value;
        else parts.push({ type: "text", text: value });
    };
    const visit = (item) => {
        if (item.nodeType === Node.TEXT_NODE) {
            pushText(item.textContent);
            return;
        }
        if (item.nodeType !== Node.ELEMENT_NODE) return;
        if (item.classList?.contains(A001_DIALOGUE_CLASS)) {
            parts.push({ type: "dialogue", text: dialogueBlockText(item) });
            return;
        }
        if (a001IsMentionChip(item)) {
            parts.push({
                type: "mention",
                token: item.dataset.token || "",
                tag: item.dataset.tag || item.dataset.token || "",
                label: item.dataset.label || "",
                fullLabel: item.dataset.fullLabel || item.dataset.label || "",
                mediaType: item.dataset.mediaType || "image",
                referenceMode: "index",
                ordinal: Number(item.dataset.ordinal) || null,
                mediaIndex: Number(item.dataset.mediaIndex) || null,
                sourceId: item.dataset.sourceId ? Number(item.dataset.sourceId) : null,
                sourceSlot: Number(item.dataset.sourceSlot) || 0,
                previewUrl: item.dataset.previewUrl || "",
            });
            return;
        }
        if (item.tagName === "BR") {
            pushText("\n");
            return;
        }
        const block = item.tagName === "DIV" || item.tagName === "P";
        if (block && parts.length
            && !(parts.at(-1)?.type === "text" && parts.at(-1).text.endsWith("\n"))) {
            pushText("\n");
        }
        for (const child of item.childNodes || []) visit(child);
    };
    for (const child of editor.childNodes || []) visit(child);

    const text = raw
        ? parts.map((p) => (p.type === "mention" ? String(p.tag || p.token || "") : p.type === "dialogue" ? `<d>${p.text}</d>` : p.text)).join("")
        : a001PromptDocTextFromParts(parts);
    return {
        v: 1,
        text,
        parts,
        view: rec?.doc?.view === A001_PROMPT_VIEW_RAW ? A001_PROMPT_VIEW_RAW : A001_PROMPT_VIEW_STRUCTURED,
    };
}

/** 编辑器纯文本（含 chip 的 token、对话块内文），用于对话块内容与校验。 */
function editorText(container) {
    let result = "";
    const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            result += String(node.textContent || "").replaceAll(A001_CARET_SENTINEL, "");
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (a001IsMentionChip(node)) {
            result += node.dataset.token || "";
            return;
        }
        if (node.tagName === "BR") {
            result += "\n";
            return;
        }
        const block = node.tagName === "DIV" || node.tagName === "P";
        if (block && result && !result.endsWith("\n")) result += "\n";
        for (const child of node.childNodes || []) visit(child);
    };
    for (const child of container?.childNodes || []) visit(child);
    return result;
}

const dialogueBlockText = (block) => editorText(block);

/* ════════════════════════════════════════════════
 *  5 · doc → DOM（渲染）
 * ════════════════════════════════════════════════ */

/** 追加带换行的纯文本。 */
function appendTextWithBreaks(container, value) {
    String(value || "").split("\n").forEach((part, index) => {
        if (index) container.append(document.createElement("br"));
        if (part) container.append(document.createTextNode(part));
    });
}

/** 构造对话块。 */
function makeDialogueBlock(value = "") {
    const block = document.createElement("span");
    block.className = A001_DIALOGUE_CLASS;
    block.spellcheck = false;
    block.dataset.a001Dialogue = "true";
    appendTextWithBreaks(block, value);
    if (!String(value || "")) block.append(document.createTextNode(A001_CARET_SENTINEL));
    return block;
}

/** 保证空对话块内部始终含一个光标哨兵。
 *
 *  ★ 为什么要（复刻参考实现 ensureDialogueInnerCaret）：
 *    对话块被删空后若**没有任何子节点**（或只剩 <br>），浏览器在该块内
 *    没有可落点，`setCaretAtEndOfNode(block)` 只能退化成 setStart(node,0)，
 *    表现为「空块里打不了字 / 光标跑了」，故每次删空后补回哨兵。 */
function ensureDialogueInnerCaret(block) {
    if (!block || dialogueBlockText(block)) return;
    const hasSentinel = [...(block.childNodes || [])].some((node) => isSentinelText(node));
    if (!hasSentinel) block.append(document.createTextNode(A001_CARET_SENTINEL));
}

/** 追加 [哨兵, 对话块, 哨兵]。 */
function appendDialogueBlock(container, value = "") {
    container.append(
        document.createTextNode(A001_CARET_SENTINEL),
        makeDialogueBlock(value),
        document.createTextNode(A001_CARET_SENTINEL)
    );
}

/** 按 <d>…</d> 切分文本并插入对话块（纯文本来源的兜底渲染）。 */
function appendPromptTextWithDialogueBlocks(container, value) {
    const source = String(value || "");
    const pattern = /<d>([\s\S]*?)<\/d>/gi;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source))) {
        appendTextWithBreaks(container, source.slice(cursor, match.index));
        appendDialogueBlock(container, match[1]);
        cursor = match.index + match[0].length;
    }
    appendTextWithBreaks(container, source.slice(cursor));
}

/**
 * 从 doc 渲染编辑器内容。
 * @param {boolean} force 为 false 且编辑器正在聚焦时跳过（不打断用户输入）
 */
function renderEditorFromDoc(rec, force = false) {
    const editor = rec?.editor;
    if (!editor) return;
    if (document.activeElement === editor && !force) return;

    const doc = rec.doc || a001EmptyPromptDoc();
    const raw = doc.view === A001_PROMPT_VIEW_RAW;
    editor.textContent = "";
    editor.classList.toggle("is-raw", raw);
    if (raw) {
        a001CloseMentionMenu(rec);
        const text = Array.isArray(doc.parts) && doc.parts.length
            ? a001PromptDocTextFromParts(doc.parts)
            : String(doc.text || "");
        appendTextWithBreaks(editor, text);
    } else if (!Array.isArray(doc.parts) || !doc.parts.length) {
        appendPromptTextWithDialogueBlocks(editor, String(doc.text || ""));
    } else {
        const live = a001MentionOptions(rec.node);
        for (const part of doc.parts) {
            if (part?.type === "dialogue") {
                appendDialogueBlock(editor, String(part.text || ""));
                continue;
            }
            if (part?.type !== "mention") {
                appendTextWithBreaks(editor, part?.text || "");
                continue;
            }
            editor.append(makeMentionChipFromPart(part, live));
        }
    }
    syncViewButton(rec);
}

/** 回填视图切换按钮的图标与提示。
 *  ★ 图标语义（用 ComfyUI 自带 PrimeIcons）：
 *    结构化视图 → pi-objects-column（内容以「块」的形式排布：chip 带缩略图、
 *                 对话块有独立底色 —— 直观体现「结构化组织」）；
 *    原始文本视图 → pi-code（纯文本 / 源码形态，与「结构化」形成明确对比）。
 *  直接改内部 <i> 的类名，不重建元素。 */
function syncViewButton(rec) {
    const btn = rec?.viewButton;
    if (!btn) return;
    const raw = rec.doc?.view === A001_PROMPT_VIEW_RAW;
    const icon = btn.querySelector("i");
    if (icon) icon.className = `pi ${raw ? "pi-code" : "pi-objects-column"}`;
    btn.title = raw ? A001_TEXT.viewStructured : A001_TEXT.viewRaw;
    btn.classList.toggle("is-active", raw);
}

/* ════════════════════════════════════════════════
 *  6 · 同步（DOM → 值 + 存档）
 * ════════════════════════════════════════════════ */

/* ★ 输入去抖（2026-10-05）：input 事件逐键触发 syncFromEditor（全量序列化编辑器 DOM +
 *   写提升槽值 + 落盘 properties）。超长提示词下每键 O(内容) 的 DOM 遍历是主要卡顿来源。
 *   这里**只对 input 路径**去抖（其余 20+ 个调用点——插入 mention / 对话块 / 撤销重做 /
 *   粘贴 / 删除等离散操作——保持同步即时生效），并在四个出口强制立即落盘，
 *   确保不丢最后一次输入：
 *     ① 编辑器失焦（含去点画布「运行」按钮）；② 输入法 compositionend（本就同步）；
 *     ③ Ctrl/Cmd+Enter（运行）与 Ctrl/Cmd+S（保存）；④ 编辑器卸载。
 *   注：input 回调下游只读 rec.doc.view（视图模式，不随输入变化），去抖不影响其判断。 */
const A001_PROMPT_SYNC_DEBOUNCE_MS = 120;

/** 取消已排程的去抖落盘。 */
function cancelScheduledSync(rec) {
    if (rec?._promptSyncTimer) {
        clearTimeout(rec._promptSyncTimer);
        rec._promptSyncTimer = 0;
    }
}

/** 去抖排程：窗口内的多次输入只落盘一次。 */
function scheduleSyncFromEditor(rec) {
    if (!rec) return;
    cancelScheduledSync(rec);
    rec._promptSyncTimer = setTimeout(() => {
        rec._promptSyncTimer = 0;
        if (rec.disposed) return;
        syncFromEditor(rec);
    }, A001_PROMPT_SYNC_DEBOUNCE_MS);
}

/** 立即落盘（取消防抖）。 */
function flushSyncFromEditor(rec) {
    if (!rec?._promptSyncTimer) return;
    cancelScheduledSync(rec);
    if (rec.disposed) return;
    syncFromEditor(rec);
}

/**
 * 序列化编辑器并写回：提升槽值 + properties 存档。
 * 全程用 node._a001PromptSyncing 重入锁保护（回流监听可能再次触发渲染）。
 */
function syncFromEditor(rec, markDirty = true) {
    const node = rec?.node;
    /* ★ 任何同步调用都视为「已落盘」→ 取消在途的去抖任务，避免随后重复执行一次。 */
    cancelScheduledSync(rec);
    if (!node || rec.syncing) return;
    rec.syncing = true;
    try {
        const doc = serializeEditor(rec);
        rec.doc = doc;
        writePromotedText(node, rec.outerInput, doc.text);
        rec.persistDoc();
        if (markDirty) {
            deps.dirtyCanvas(node);
            safeCall(() => node.graph?.setDirtyCanvas?.(true, true), undefined, "同步后图重绘");
        }
    } finally {
        rec.syncing = false;
    }
}

/**
 * 装配后的落地收尾：只刷新端口胶囊，**不做任何节点尺寸计算**。
 *
 * ★★ 为什么删掉了尺寸校准（用户明确要求「去除编辑器高度所有代码限制」）
 * -----------------------------------------------------------------------------
 *  原先这里会调 resizeAfterPromotedChange → node.setSize()，即由代码决定节点高度。
 *  那会与用户手动拉伸互相打架（刚拉完又被算回去），也是「节点高度无法随意变化」
 *  的成因之一。现在编辑器不声明高度、也不触发尺寸重算：
 *  高度完全交回官方 grid 与用户操作。
 *  只剩刷新端口胶囊——那是连线几何，与高度无关，必须保留。
 */
function afterContentChange(rec) {
    const node = rec?.node;
    if (!node) return;
    noteSelfWrite(node);
    deps.refreshPortCapsule(node);
}

/* ════════════════════════════════════════════════
 *  6.5 · 右下角纵向拖拽手柄（编辑器改高）
 * ════════════════════════════════════════════════
 *
 * ★★ 为什么是「改承载行 min-height」而不是「改编辑器自身高度」
 * -----------------------------------------------------------------------------
 *  编辑器 wrap 是 `position:absolute; inset:0` 贴合官方控件行（.a001-prompt-row），
 *  editor 又是 `height:100%` 撑满 wrap —— 即编辑器高度是**行的布局结果**，
 *  直接给编辑器写 height 会被行的实际高度覆盖（血泪教训：见 A001_prompt_core.js
 *  的「高度方案」注释，历史上 JS 写高度的方案均被推翻）。
 *  正解：给**行**设内联 min-height，行被撑高 → wrap/editor 随之变高 →
 *  chrome 变大 → 高度模型的 apply() 自动把节点加高到「新 chrome + wanted」，
 *  预览框高度保持不变。这与原生 textarea 拖拽（size 变大 → 行 stretch 撑高）口径一致。
 *
 * ★ 与 A001_textarea_resize.js 的分工
 * -----------------------------------------------------------------------------
 *  textarea_resize 负责「未被提升为编辑器的普通多行文本框」的原生拖拽；
 *  本段负责「已换成自绘编辑器的提升槽」。二者互斥（同一行要么是原生 textarea、
 *  要么是编辑器），不会同时生效。
 * ------------------------------------------------------------------------- */

/** 行高存档键（写在 node.properties，随工作流序列化）。 */
const PROMPT_HEIGHTS_PROP = "a001_prompt_editor_heights";
/** 可拖拽的高度下限（布局像素），与 A001_textarea_resize 的 MIN_H 同口径（用户指定 80）。 */
const RESIZE_MIN_H = 80;

/** 读该槽已存档的编辑器高度（缺省 0）。 */
function readResizeHeight(node, slotName) {
    return safeCall(() => {
        const v = node?.properties?.[PROMPT_HEIGHTS_PROP]?.[String(slotName)];
        return Number.isFinite(v) ? v : 0;
    }, 0, "读编辑器高度存档");
}

/** 写该槽的编辑器高度到 properties（0/无效时清理该条目）。 */
function writeResizeHeight(node, slotName, h) {
    return safeCall(() => {
        if (!node || slotName == null) return false;
        if (!node.properties || typeof node.properties !== "object") node.properties = {};
        const table = (node.properties[PROMPT_HEIGHTS_PROP] && typeof node.properties[PROMPT_HEIGHTS_PROP] === "object")
            ? node.properties[PROMPT_HEIGHTS_PROP] : {};
        const rounded = Math.round(h);
        if (rounded > 0) table[String(slotName)] = rounded;
        else delete table[String(slotName)];
        node.properties[PROMPT_HEIGHTS_PROP] = table;
        return true;
    }, false, "写编辑器高度存档");
}

/**
 * 把「存档高度」应用到承载行（幂等）。
 * ★ 仅在「行尚无内联 min-height」时写回 —— 内联值可能是用户刚拖出来的，
 *   存档只在元素重建后（切工作流 / Vue 重渲染）兜底。
 */
function applyResizeHeight(rec) {
    const row = rec?.row;
    if (!row) return;
    if (row.style.minHeight) return;
    const h = readResizeHeight(rec.node, rec.slotName);
    /* 读回时同样钳到下限：旧存档可能低于 RESIZE_MIN_H（如早先 24 / 50），
     * 不钳制会让「最低 80」在重建后失效。 */
    if (h > 0) {
        safeCall(() => { row.style.minHeight = `${Math.max(RESIZE_MIN_H, h)}px`; },
            undefined, "读回编辑器高度存档");
    }
}

/** 拖拽手柄：按下 → 记录起点 → 移动改行 min-height → 松开落盘 + 同步节点高。 */
function bindResizerEvents(rec) {
    const resizer = rec?.resizer;
    if (!resizer || resizer._a001Bound) return;
    resizer._a001Bound = true;

    const onPointerDown = (e) => {
        /* 只响应主键（鼠标左键 / 触摸/笔）。 */
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const row = rec.row;
        if (!row) return;
        const startY = e.clientY;
        const startH = row.offsetHeight || RESIZE_MIN_H;
        rec._a001Resizing = true;
        safeCall(() => resizer.classList.add("is-dragging"), undefined, "标记手柄拖拽态");
        /* 拖拽期间抑制守卫重挂（DOM 变化由我们自己引起）。 */
        noteSelfWrite(rec.node, 100000);

        const onMove = (ev) => {
            if (!rec._a001Resizing) return;
            /* ★★ 位移必须换算成「布局像素」（关键修复，勿改回直接相加）：
             *   节点 DOM 被画布 transform:scale(ds.scale) 整体缩放，鼠标位移是
             *   **屏幕像素**，而 row.style.minHeight 是**布局像素**。若直接相加，
             *   画布缩放 50% 时手柄只走一半位移（实测鼠标 +40px → 手柄仅 +20px），
             *   即用户反馈的「不跟手」。除以 scale 后手柄中心与鼠标严格同步，
             *   手感与原生的 textarea resize 手柄一致。
             *   scale 取不到 / 非法值时退化为 1（不缩放），绝不写出 NaN 高度。 */
            const rawScale = Number(safeCall(() => deps.canvasScale(), 1, "取画布缩放"));
            const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
            /* 向下拖 = 增大高度（与原生 resize 手柄同向）。 */
            const next = Math.max(RESIZE_MIN_H, Math.round(startH + (ev.clientY - startY) / scale));
            rec._a001DragH = next;
            safeCall(() => { row.style.minHeight = `${next}px`; }, undefined, "拖拽写行最小高度");
            /* 让高度模型感知 chrome 变化 → 节点高随之调整（预览框保持不变）。 */
            safeCall(() => deps.syncNodeHeight(rec.node), undefined, "拖拽中同步节点高度");
            ev.preventDefault();
        };

        const onUp = () => {
            if (!rec._a001Resizing) return;
            rec._a001Resizing = false;
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onUp, true);
            safeCall(() => resizer.classList.remove("is-dragging"), undefined, "取消手柄拖拽态");
            /* 落盘：把最终高度写进 properties（切工作流/刷新后按原高度恢复）。 */
            const finalH = rec._a001DragH || rec.row?.offsetHeight || 0;
            if (finalH > 0) safeCall(() => writeResizeHeight(rec.node, rec.slotName, finalH), undefined, "落盘编辑器高度");
            rec._a001DragH = 0;
            /* 收尾再同步一次（补齐拖拽过程中的最后一次显式同步）。 */
            safeCall(() => deps.syncNodeHeight(rec.node), undefined, "拖拽结束同步节点高度");
            safeCall(() => deps.dirtyCanvas(rec.node), undefined, "拖拽结束重绘");
        };

        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onUp, true);
        /* ★ 保存 window 级 handler：拖拽中途若节点被卸载（pointerup / pointercancel
         *   永远不到达），这两个监听会常驻并强引用 rec → node。 */
        rec._a001ResizeMove = onMove;
        rec._a001ResizeUp = onUp;
    };

    resizer.addEventListener("pointerdown", onPointerDown);
    rec._a001ResizerDown = onPointerDown;
}

/** 卸载手柄监听（DOM 销毁前调用，幂等）。 */
function unbindResizerEvents(rec) {
    if (!rec) return;
    if (rec.resizer && rec._a001ResizerDown) {
        safeCall(() => rec.resizer.removeEventListener("pointerdown", rec._a001ResizerDown), undefined, "解绑手柄 pointerdown");
    }
    /* ★ 拖拽进行中被卸载：window 上的移动 / 抬起监听仍在（指针抬起或取消事件
     *   可能永远不来），它们强引用 rec → node，必须显式摘掉。 */
    if (rec._a001ResizeMove) {
        safeCall(() => window.removeEventListener("pointermove", rec._a001ResizeMove, true), undefined, "解绑手柄拖拽移动");
    }
    if (rec._a001ResizeUp) {
        safeCall(() => window.removeEventListener("pointerup", rec._a001ResizeUp, true), undefined, "解绑手柄拖拽抬起");
        safeCall(() => window.removeEventListener("pointercancel", rec._a001ResizeUp, true), undefined, "解绑手柄拖拽取消");
    }
    rec._a001ResizeMove = null;
    rec._a001ResizeUp = null;
    rec._a001ResizerDown = null;
    rec._a001Resizing = false;
}

/* ════════════════════════════════════════════════
 *  7 · 光标哨兵与删除边界（复刻参考实现 L5775-6126）
 * ════════════════════════════════════════════════ */

const stripSentinels = (v) => String(v ?? "").replaceAll(A001_CARET_SENTINEL, "");
const makeSentinel = () => document.createTextNode(A001_CARET_SENTINEL);
const isSentinelText = (n) => n?.nodeType === Node.TEXT_NODE && String(n.textContent || "").includes(A001_CARET_SENTINEL);
const isOnlySentinelText = (n) => n?.nodeType === Node.TEXT_NODE && stripSentinels(n.textContent) === "";
const isIgnorableText = (n) => n?.nodeType === Node.TEXT_NODE && stripSentinels(n.textContent).trim() === "";
const isDialogueBlock = (n) => n?.nodeType === Node.ELEMENT_NODE && n.classList?.contains(A001_DIALOGUE_CLASS);

function deepestLeaf(node, direction) {
    let current = node;
    if (a001IsMentionChip(current) || isDialogueBlock(current)) return current;
    while (current?.childNodes?.length) {
        if (a001IsMentionChip(current) || isDialogueBlock(current) || current.contentEditable === "false") return current;
        current = direction === "backward"
            ? current.childNodes[current.childNodes.length - 1]
            : current.childNodes[0];
    }
    return current;
}

function adjacentLeaf(node, root, direction) {
    if (!node || node === root) return null;
    let current = node;
    while (current && current !== root) {
        const sibling = direction === "backward" ? current.previousSibling : current.nextSibling;
        if (sibling) return deepestLeaf(sibling, direction);
        current = current.parentNode;
    }
    return null;
}

function getAdjacentLeafFromCaret(range, root, direction) {
    const container = range.startContainer;
    const offset = range.startOffset;
    if (container.nodeType === Node.TEXT_NODE) {
        if (direction === "backward" && offset > 0) return null;
        if (direction === "forward" && offset < container.textContent.length) return null;
        return adjacentLeaf(container, root, direction);
    }
    if (container.nodeType === Node.ELEMENT_NODE) {
        if (direction === "backward") {
            if (offset > 0) return deepestLeaf(container.childNodes[offset - 1], "backward");
            return adjacentLeaf(container, root, "backward");
        }
        if (offset < container.childNodes.length) return deepestLeaf(container.childNodes[offset], "forward");
        return adjacentLeaf(container, root, "forward");
    }
    return null;
}

function findChipAcrossWhitespace(start, root, direction) {
    let current = start;
    const skipped = [];
    while (current) {
        if (a001IsMentionChip(current)) return { chip: current, skipped };
        if (isIgnorableText(current)) {
            skipped.push(current);
            current = adjacentLeaf(current, root, direction);
            continue;
        }
        return null;
    }
    return null;
}

function findLineBreakAcrossWhitespace(start, root, direction) {
    let current = start;
    const skipped = [];
    while (current) {
        if (current.nodeType === Node.ELEMENT_NODE && current.tagName === "BR") {
            return { breakNode: current, skipped };
        }
        if (isIgnorableText(current)) {
            skipped.push(current);
            current = adjacentLeaf(current, root, direction);
            continue;
        }
        return null;
    }
    return null;
}

function findDialogueAcrossWhitespace(start, root, direction) {
    let current = start;
    const skipped = [];
    while (current) {
        if (isDialogueBlock(current)) return { block: current, skipped };
        if (isIgnorableText(current)) {
            skipped.push(current);
            current = adjacentLeaf(current, root, direction);
            continue;
        }
        return null;
    }
    return null;
}

function setCaretAtNode(node, offset = 0) {
    const selection = window.getSelection?.();
    if (!selection || !node) return;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function setCaretAtEndOfNode(node) {
    if (!node) return;
    const selection = window.getSelection?.();
    if (!selection) return;
    const range = document.createRange();
    let target = node;
    while (target?.lastChild) target = target.lastChild;
    if (target?.nodeType === Node.TEXT_NODE) range.setStart(target, target.textContent.length);
    else if (target?.parentNode && target !== node) range.setStartAfter(target);
    else range.setStart(node, node.childNodes.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function getDeletionScanStart(range, editor, direction) {
    let spacer = null;
    let start = null;
    const container = range.startContainer;
    const offset = range.startOffset;
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if (direction === "backward") {
            const before = text.slice(0, offset);
            if (before && stripSentinels(before).trim() !== "") return null;
            spacer = before ? container : null;
            start = before ? adjacentLeaf(container, editor, "backward") : getAdjacentLeafFromCaret(range, editor, "backward");
        } else {
            const after = text.slice(offset);
            if (after && stripSentinels(after).trim() !== "") return null;
            spacer = after ? container : null;
            start = after ? adjacentLeaf(container, editor, "forward") : getAdjacentLeafFromCaret(range, editor, "forward");
        }
    } else {
        start = getAdjacentLeafFromCaret(range, editor, direction);
    }
    return { start, spacer, container, offset };
}

function removeSpacerText(spacer, offset, direction) {
    if (spacer?.nodeType !== Node.TEXT_NODE) return;
    if (direction === "backward") spacer.deleteData(0, offset);
    else spacer.deleteData(offset, spacer.textContent.length - offset);
    if (!spacer.textContent) spacer.remove();
}

function deleteLastVisibleChar(textNode) {
    const text = String(textNode?.textContent || "");
    let cursor = 0;
    let last = null;
    for (const char of Array.from(text)) {
        if (char !== A001_CARET_SENTINEL) last = { index: cursor, length: char.length };
        cursor += char.length;
    }
    if (!last) return false;
    textNode.deleteData(last.index, last.length);
    if (!textNode.textContent) textNode.remove();
    return true;
}

function deletePreviousVisibleCharBeforeOffset(textNode, offset) {
    if (textNode?.nodeType !== Node.TEXT_NODE) return false;
    const text = String(textNode.textContent || "");
    const limit = Math.max(0, Math.min(Number(offset) || 0, text.length));
    let cursor = 0;
    let target = null;
    for (const char of Array.from(text)) {
        const next = cursor + char.length;
        if (next > limit) break;
        if (char !== A001_CARET_SENTINEL) target = { index: cursor, length: char.length };
        cursor = next;
    }
    if (!target) return false;
    textNode.deleteData(target.index, target.length);
    setCaretAtNode(textNode, target.index);
    return true;
}

function findPreviousContentFromSentinel(marker, editor) {
    let current = adjacentLeaf(marker, editor, "backward");
    const skipped = [];
    while (current) {
        if (isOnlySentinelText(current)) {
            skipped.push(current);
            current = adjacentLeaf(current, editor, "backward");
            continue;
        }
        return { node: current, skipped };
    }
    return { node: null, skipped };
}

const removeEmptyMarker = (marker) => { if (isOnlySentinelText(marker)) marker.remove?.(); };

function placeCaretAfterPreviousContent(marker, editor) {
    const previous = findPreviousContentFromSentinel(marker, editor);
    if (previous.node?.nodeType === Node.TEXT_NODE) {
        setCaretAtNode(previous.node, previous.node.textContent.length);
        removeEmptyMarker(marker);
        return true;
    }
    if (a001IsMentionChip(previous.node)) {
        const after = getOrInsertSentinel(previous.node, "after");
        setCaretAtNode(after, after.textContent.length);
        if (after !== marker) removeEmptyMarker(marker);
        return true;
    }
    setCaretAtNode(marker, marker.textContent.length);
    return false;
}

function getOrInsertSentinel(chip, side) {
    if (!chip?.parentNode) return null;
    const sibling = side === "before" ? chip.previousSibling : chip.nextSibling;
    if (isSentinelText(sibling)) return sibling;
    const marker = makeSentinel();
    chip.parentNode.insertBefore(marker, side === "before" ? chip : chip.nextSibling);
    return marker;
}

function removeMentionChipNode(chip, direction = "backward") {
    if (!chip?.parentNode) return null;
    const marker = makeSentinel();
    chip.parentNode.insertBefore(marker, direction === "backward" ? chip : chip.nextSibling);
    chip.remove();
    return marker;
}

function isSentinelBeforeChip(marker, editor) {
    const next = adjacentLeaf(marker, editor, "forward");
    return Boolean(findChipAcrossWhitespace(next, editor, "forward")?.chip);
}

function backspaceBeforeChip(rec) {
    const editor = rec.editor;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const marker = range.startContainer;
    if (!editor.contains(marker) || !isSentinelText(marker) || !isSentinelBeforeChip(marker, editor)) return false;
    if (deletePreviousVisibleCharBeforeOffset(marker, range.startOffset)) return true;
    const previous = findPreviousContentFromSentinel(marker, editor);
    if (!previous.node) {
        if (isSentinelBeforeChip(marker, editor)) setCaretAtNode(marker, marker.textContent.length);
        else if (marker.textContent === A001_CARET_SENTINEL) marker.remove();
        a001CloseMentionMenu(rec);
        return true;
    }
    if (previous.node.nodeType === Node.TEXT_NODE) deleteLastVisibleChar(previous.node);
    else if (a001IsMentionChip(previous.node)) previous.node.remove();
    else if (previous.node.nodeType === Node.ELEMENT_NODE && previous.node.tagName === "BR") previous.node.remove();
    else return false;
    for (const item of previous.skipped) item.remove?.();
    setCaretAtNode(marker, marker.textContent.length);
    a001CloseMentionMenu(rec);
    return true;
}

function backspaceAtLooseSentinel(rec) {
    const editor = rec.editor;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const marker = range.startContainer;
    if (!editor.contains(marker) || !isSentinelText(marker) || isSentinelBeforeChip(marker, editor)) return false;
    if (deletePreviousVisibleCharBeforeOffset(marker, range.startOffset)) return true;
    const previous = findPreviousContentFromSentinel(marker, editor);
    if (!previous.node || (previous.node.nodeType === Node.ELEMENT_NODE && previous.node.tagName === "BR")) return false;
    if (previous.node.nodeType === Node.TEXT_NODE) deleteLastVisibleChar(previous.node);
    else if (a001IsMentionChip(previous.node)) previous.node.remove();
    else return false;
    for (const item of previous.skipped) item.remove?.();
    setCaretAtNode(marker, marker.textContent.length);
    a001CloseMentionMenu(rec);
    return true;
}

function deleteLineBreakNearCaret(rec, direction) {
    const editor = rec.editor;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return false;
    const scan = getDeletionScanStart(range, editor, direction);
    if (!scan) return false;
    const found = findLineBreakAcrossWhitespace(scan.start, editor, direction);
    if (!found?.breakNode) return false;
    const marker = makeSentinel();
    found.breakNode.parentNode?.insertBefore(marker, found.breakNode);
    found.breakNode.remove();
    for (const item of found.skipped) item.remove?.();
    removeSpacerText(scan.spacer, scan.offset, direction);
    placeCaretAfterPreviousContent(marker, editor);
    a001CloseMentionMenu(rec);
    return true;
}

function blockNativeSentinelDeletion(editor) {
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const marker = range.startContainer;
    if (!editor.contains(marker) || !isSentinelText(marker)) return false;
    if (stripSentinels(marker.textContent || "") !== "") return false;
    const previous = adjacentLeaf(marker, editor, "backward");
    const next = adjacentLeaf(marker, editor, "forward");
    return Boolean(
        findChipAcrossWhitespace(previous, editor, "backward")?.chip
        || findChipAcrossWhitespace(next, editor, "forward")?.chip
    );
}

function deleteChipNearCaret(rec, direction) {
    const editor = rec.editor;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    if (!editor.contains(startNode)) return false;
    if (startNode.nodeType === Node.TEXT_NODE
        && !isSentinelText(startNode)
        && stripSentinels(startNode.textContent || "") !== ""
        && ((direction === "backward" && range.startOffset > 0)
            || (direction === "forward" && range.startOffset < startNode.textContent.length))) {
        return false;
    }
    const scan = getDeletionScanStart(range, editor, direction);
    if (!scan) return false;
    const found = findChipAcrossWhitespace(scan.start, editor, direction);
    if (!found?.chip) return false;
    const marker = removeMentionChipNode(found.chip, direction);
    for (const item of found.skipped) item.remove?.();
    removeSpacerText(scan.spacer, scan.offset, direction);
    if (marker) setCaretAtNode(marker, marker.textContent.length);
    a001CloseMentionMenu(rec);
    return true;
}

function insertEditorLineBreak(editor) {
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    range.deleteContents();
    const br = document.createElement("br");
    const marker = document.createTextNode(A001_CARET_SENTINEL);
    const fragment = document.createDocumentFragment();
    fragment.append(br, marker);
    range.insertNode(fragment);
    const caret = document.createRange();
    caret.setStart(marker, marker.textContent.length);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    return true;
}

function insertPlainText(editor, text) {
    if (document.execCommand?.("insertText", false, text)) return;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

/**
 * 由 part 构造 mention chip（与 renderEditorFromDoc 同口径）。
 *
 * ★ 抽出来的原因：renderEditorFromDoc 与「粘贴结构化文本」两处都要把
 *   part 变成 chip，且必须**用当下的实时候选（live options）覆盖 part 里的
 *   存档值**，否则粘贴进来的引用会显示旧缩略图 / 断线状态。
 */
function makeMentionChipFromPart(part, liveOptions) {
    const ordinal = Number(part?.ordinal) || null;
    const option = (liveOptions || []).find(
        (opt) => opt.type === (part?.mediaType || "image") && Number(opt.ordinal) === ordinal
    );
    return a001MakeMentionChip({
        type: part?.mediaType || option?.type || "image",
        token: option?.token || part?.token || "",
        tag: option?.tag || part?.tag || part?.token || "",
        label: option?.label || part?.label || part?.token || "",
        fullLabel: option?.fullLabel || part?.fullLabel || part?.label || "",
        ordinal: option?.ordinal ?? part?.ordinal,
        sourceId: option?.sourceId ?? part?.sourceId,
        sourceSlot: option?.sourceSlot ?? part?.sourceSlot ?? 0,
        mediaIndex: option?.mediaIndex ?? part?.mediaIndex,
        previewUrl: option?.previewUrl || "",
        unresolved: !option,
        pending: !option && ordinal != null,
    });
}

/**
 * 按「原始文本」的完整语法（@ 媒体标签 + <d> 对话块）在光标处插入结构化 DOM。
 *
 * ★ 为什么单独做（症状根因）：
 *   编辑器里「复制」出来的是 doc.text 原始串，其中对话块形如 `<d>台词</d>`。
 *   旧粘贴路径 a001InsertTextWithMentionChips 只扫描媒体标签，`<d>…</d>`
 *   会被当普通文字插入 → **台词块不识别**。
 *   本函数改用与「视图切换 / 加载存档」同一个解析器 a001PromptPartsFromText，
 *   保证粘贴还原出的结构与其它入口完全一致。
 *
 * @returns {boolean} 是否已接管本次插入（false 表示调用方应走兜底路径）
 */
function insertPromptTextWithStructure(rec, text) {
    const editor = rec?.editor;
    const value = String(text || "");
    if (!editor || !value) return false;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return false;

    const parts = safeCall(
        () => a001PromptPartsFromText(value, a001ResolveMentionFrom(rec.node)),
        null,
        "解析粘贴文本"
    );
    if (!Array.isArray(parts) || !parts.length) return false;
    /* 不含任何结构化语法时交回旧路径（纯文本插入的行为更原生）。 */
    if (!parts.some((part) => part?.type === "dialogue" || part?.type === "mention")) return false;

    const live = a001MentionOptions(rec.node);
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
        if (part?.type === "dialogue") {
            fragment.append(
                document.createTextNode(A001_CARET_SENTINEL),
                makeDialogueBlock(String(part.text || "")),
                document.createTextNode(A001_CARET_SENTINEL)
            );
            continue;
        }
        if (part?.type === "mention") {
            fragment.append(
                document.createTextNode(A001_CARET_SENTINEL),
                makeMentionChipFromPart(part, live),
                document.createTextNode(A001_CARET_SENTINEL)
            );
            continue;
        }
        appendTextWithBreaks(fragment, part?.text || "");
    }
    /* 末尾光标落点：用哨兵标记，插入后把光标定到哨兵之后。 */
    const caretMarker = document.createTextNode(A001_CARET_SENTINEL);
    fragment.append(caretMarker);

    range.deleteContents();
    range.insertNode(fragment);
    const caret = document.createRange();
    caret.setStart(caretMarker, caretMarker.textContent.length);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    return true;
}

/* ── 对话块操作 ── */

function dialogueBlockAtSelection(editor) {
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount) return null;
    const container = selection.getRangeAt(0).startContainer;
    const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const block = element?.closest?.(`.${A001_DIALOGUE_CLASS}`);
    return block && editor.contains(block) ? block : null;
}

/** 当前选区是否落在给定对话块内部。
 *  用于「按 # 后确认光标确实进了新块」的兜底判断。 */
function caretInsideBlock(block) {
    if (!block) return false;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount) return false;
    const container = selection.getRangeAt(0).startContainer;
    const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    return !!element && (element === block || block.contains(element));
}

function dialogueBoundary(block, side) {
    if (!block?.parentNode) return null;
    const sibling = side === "before" ? block.previousSibling : block.nextSibling;
    if (isSentinelText(sibling)) return sibling;
    const marker = makeSentinel();
    block.parentNode.insertBefore(marker, side === "before" ? block : block.nextSibling);
    return marker;
}

function exitDialogueBlock(rec, block) {
    const marker = dialogueBoundary(block, "after");
    if (!marker) return false;
    const text = String(marker.textContent || "");
    const index = text.indexOf(A001_CARET_SENTINEL);
    rec.editor.focus({ preventScroll: true });
    setCaretAtNode(marker, index >= 0 ? index + A001_CARET_SENTINEL.length : text.length);
    a001CloseMentionMenu(rec);
    return true;
}

function insertDialogueBlockAtSelection(rec) {
    const editor = rec.editor;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !editor) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    if (dialogueBlockAtSelection(editor)) return false;
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    /* ★ 直接持有刚建的 block 引用，**不要**用选区反查（血泪教训，勿改回）：
     *  插入 fragment 之后，选区仍停留在插入前的旧位置（我们并未更新它），
     *  于是 dialogueBlockAtSelection() 取到的 startContainer 落在对话块之外，
     *  closest(对话块) 命中不到 → block 为 null → 光标压根没被设置，
     *  表现就是「按 # 生成对话块后，光标停在块外」。 */
    const block = makeDialogueBlock("");
    fragment.append(makeSentinel(), block, makeSentinel());
    range.insertNode(fragment);
    editor.focus({ preventScroll: true });
    /* 光标落在对话块内部末尾（空块里是哨兵之后）。 */
    setCaretAtEndOfNode(block);
    /* ★ 再补一次「下一帧确认」：部分浏览器会在本次输入事件收尾时把选区
     *  重置回插入点之前/之后，导致刚设好的块内光标被顶出块外。若下一帧
     *  发现光标不在本块内，就再设一次（幂等，仅在确实跑偏时才动作）。 */
    const raf = typeof globalThis.requestAnimationFrame === "function" ? globalThis.requestAnimationFrame : null;
    if (raf) {
        raf(() => {
            if (rec.disposed || !block.isConnected || document.activeElement !== editor) return;
            if (caretInsideBlock(block)) return;
            setCaretAtEndOfNode(block);
        });
    }
    a001CloseMentionMenu(rec);
    return true;
}

function deleteLastDialogueContent(block) {
    const leaves = [];
    const visit = (n) => {
        if (n.nodeType === Node.TEXT_NODE) { leaves.push(n); return; }
        if (n.nodeType === Node.ELEMENT_NODE && n.tagName === "BR") { leaves.push(n); return; }
        for (const child of n.childNodes || []) visit(child);
    };
    for (const child of block.childNodes || []) visit(child);
    for (let i = leaves.length - 1; i >= 0; i -= 1) {
        const leaf = leaves[i];
        if (leaf.nodeType === Node.TEXT_NODE) {
            if (deleteLastVisibleChar(leaf)) {
                ensureDialogueInnerCaret(block);
                setCaretAtEndOfNode(block);
                return true;
            }
            if (!leaf.textContent) leaf.remove();
            continue;
        }
        const next = leaf.nextSibling;
        leaf.remove();
        if (isOnlySentinelText(next)) next.remove();
        ensureDialogueInnerCaret(block);
        setCaretAtEndOfNode(block);
        return true;
    }
    ensureDialogueInnerCaret(block);
    setCaretAtEndOfNode(block);
    return false;
}

function removeDialogueBlock(block) {
    if (!block?.parentNode) return false;
    const parent = block.parentNode;
    const before = block.previousSibling;
    const after = block.nextSibling;
    let marker = isSentinelText(before) ? before : null;
    if (!marker) {
        marker = makeSentinel();
        parent.insertBefore(marker, block);
    }
    block.remove();
    if (after !== marker && isOnlySentinelText(after)) after.remove();
    setCaretAtNode(marker, marker.textContent.length);
    return true;
}

function backspaceDialogueBoundary(rec) {
    const editor = rec.editor;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
    const activeBlock = dialogueBlockAtSelection(editor);
    if (activeBlock) {
        if (!dialogueBlockText(activeBlock)) {
            const removed = removeDialogueBlock(activeBlock);
            if (removed) a001CloseMentionMenu(rec);
            return removed;
        }
        return false;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return false;
    const scan = getDeletionScanStart(range, editor, "backward");
    if (!scan) return false;
    const found = findDialogueAcrossWhitespace(scan.start, editor, "backward");
    if (!found?.block) return false;
    for (const skipped of found.skipped) skipped.remove?.();
    const block = found.block;
    if (dialogueBlockText(block)) {
        if (!deleteLastDialogueContent(block)) return false;
        a001CloseMentionMenu(rec);
        return true;
    }
    const removed = removeDialogueBlock(block);
    if (removed) a001CloseMentionMenu(rec);
    return removed;
}

/* ════════════════════════════════════════════════
 *  8 · 工具条动作（视图切换 / 文本清理）
 * ════════════════════════════════════════════════ */

/**
 * 清空当前文本框内的全部内容。
 *
 * 做法与视图切换同源：改写 doc → 渲染 → 写回提升槽值 → 存档，
 * 保证「编辑器 DOM / 槽值 / properties 存档」三者一致。
 * ★ 保留撤销能力：清空前把当前内容压入历史（Ctrl+Z 可恢复），
 *   故**不**调用 a001ResetPromptHistory（那会清空整个历史栈）。
 */
function clearPromptText(rec) {
    if (!rec) return;
    const editor = rec.editor;
    /* 已经是空的不重复操作（避免无意义的历史栈与重绘）。 */
    const hasContent = (rec.doc?.parts?.length > 0)
        || String(rec.doc?.text || "").length > 0
        || String(editor?.textContent || "").length > 0;
    if (!hasContent) return;
    /* ① 先把当前 DOM 落成 doc，② 再把「清空前的内容」压入历史作为撤销点。 */
    syncFromEditor(rec, false);
    a001PushPromptHistory(rec);
    /* ③ 置空 doc（保留当前视图模式，避免清空时顺带切视图）。 */
    const doc = a001EmptyPromptDoc();
    doc.view = rec.doc?.view === A001_PROMPT_VIEW_RAW ? A001_PROMPT_VIEW_RAW : A001_PROMPT_VIEW_STRUCTURED;
    rec.doc = doc;
    rec.persistDoc();
    renderEditorFromDoc(rec, true);
    writePromotedText(rec.node, rec.outerInput, doc.text);
    noteSelfWrite(rec.node);
    deps.dirtyCanvas(rec.node);
    alog("编辑器文本已清空", `槽:${rec.slotName}`);
}

/**
 * 复制当前文本框内的**原始文本**到剪贴板。
 *
 * ★ 取 doc.text（原始串）而非 editor.innerText（可见文本）：
 *  结构化视图里 chip 显示为「@图片1」、对话块是独立 DOM，
 *  innerText 拿到的是这些**显示态**文字；而 doc.text 存的是会写回槽值、
 *  参与后续处理的**原始文本**（如 <Picture 1> 这类标签形态）。
 *  用户要复制的正是这份原始文本。
 * ★ 先 serializeNow() 落定当前 DOM：编辑器里的输入是懒同步的，
 *  不先序列化会复制到「上一次同步时的旧文本」。
 * ★ 复制失败兜底：navigator.clipboard 在非安全上下文/无权限时会 reject，
 *  回退到临时 textarea + execCommand("copy")（老浏览器的通用做法）。
 */
function copyPromptText(rec) {
    if (!rec) return;
    const doc = safeCall(() => rec.serializeNow?.(), null, "复制前序列化编辑器");
    const text = String(doc?.text ?? rec.doc?.text ?? "");
    if (!text.trim()) {
        flashToolTitle(rec.copyButton, A001_TEXT.copyEmpty);
        return;
    }
    const done = () => flashToolTitle(rec.copyButton, A001_TEXT.copyDone);
    const fallback = () => {
        const ok = safeCall(() => {
            const area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.left = "-9999px";
            document.body.append(area);
            area.select();
            const result = document.execCommand?.("copy");
            area.remove();
            return result;
        }, false, "回退复制");
        if (ok) done();
        else flashToolTitle(rec.copyButton, A001_TEXT.copyFail);
    };
    if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
    } else {
        fallback();
    }
}

/** 临时把按钮提示改为反馈文案，1.1s 后还原（用于复制/清空的结果反馈）。 */
function flashToolTitle(button, message) {
    if (!button) return;
    if (!button._a001TitleOriginal) button._a001TitleOriginal = button.title;
    button.title = message;
    clearTimeout(button._a001TitleTimer);
    button._a001TitleTimer = setTimeout(() => {
        button.title = button._a001TitleOriginal || button.title;
    }, 1100);
}

function togglePromptView(rec) {
    if (!rec) return;
    const raw = rec.doc?.view === A001_PROMPT_VIEW_RAW;
    /* 切到 raw 前先把当前 DOM 落成 doc，避免丢失未同步内容。 */
    if (!raw) syncFromEditor(rec, false);
    const nextView = raw ? A001_PROMPT_VIEW_STRUCTURED : A001_PROMPT_VIEW_RAW;
    const doc = a001ClonePromptDoc(rec.doc || a001EmptyPromptDoc());
    doc.view = nextView;
    if (nextView === A001_PROMPT_VIEW_STRUCTURED) {
        /* raw → structured：按当下的文本重新解析 parts（解析不出的标 unresolved）。 */
        doc.parts = a001PromptPartsFromText(doc.text, a001ResolveMentionFrom(rec.node));
    }
    rec.doc = doc;
    rec.persistDoc();
    renderEditorFromDoc(rec, true);
    writePromotedText(rec.node, rec.outerInput, doc.text);
    a001ResetPromptHistory(rec);
    noteSelfWrite(rec.node);
    deps.dirtyCanvas(rec.node);
    alog("编辑器视图切换 →", nextView, `槽:${rec.slotName}`);
}

/* ════════════════════════════════════════════════
 *  9 · 事件装配
 * ════════════════════════════════════════════════ */

function bindEditorEvents(rec) {
    const { editor, wrap, node } = rec;

    /* ── beforeinput：@ / # 的结构化插入 ── */
    editor.addEventListener("beforeinput", (event) => {
        if (event.isComposing) return;
        const raw = rec.doc?.view === A001_PROMPT_VIEW_RAW;
        if (raw) {
            node._a001DialogueHashHandled = false;
            return;
        }
        if (node._a001DialogueHashHandled) {
            node._a001DialogueHashHandled = false;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
        }
        if (event.inputType === "insertText" && event.data === "#" && insertDialogueBlockAtSelection(rec)) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            syncFromEditor(rec);
            a001PushPromptHistory(rec);
            return;
        }
        if (event.data === "@" && a001CanUseMediaMentions(node)) {
            setTimeout(() => a001SyncMentionMenuToCaret(rec), 0);
        }
    });

    /* ── input：去抖落盘 + 驱动菜单（IME 期间只同步） ── */
    editor.addEventListener("input", (event) => {
        scheduleSyncFromEditor(rec);
        if (event?.isComposing || event?.inputType === "insertCompositionText" || node._a001PromptComposing) {
            if (rec.doc?.view !== A001_PROMPT_VIEW_RAW) a001SyncMentionMenuToCaret(rec);
            return;
        }
        a001PushPromptHistory(rec);
        if (rec.doc?.view === A001_PROMPT_VIEW_RAW) a001CloseMentionMenu(rec);
        else a001SyncMentionMenuToCaret(rec);
    });

    /* ★ 失焦即落盘：去抖窗口内移出编辑器时，最后一次输入不能丢。 */
    editor.addEventListener("blur", () => { flushSyncFromEditor(rec); });

    editor.addEventListener("compositionstart", () => { node._a001PromptComposing = true; });
    editor.addEventListener("compositionend", () => {
        node._a001PromptComposing = false;
        syncFromEditor(rec);
        a001PushPromptHistory(rec);
        if (rec.doc?.view !== A001_PROMPT_VIEW_RAW) a001SyncMentionMenuToCaret(rec);
    });

    /* ── keyup：方向键移动光标后同步菜单 ── */
    editor.addEventListener("keyup", (event) => {
        if (rec.doc?.view === A001_PROMPT_VIEW_RAW || !a001CanUseMediaMentions(node)) return;
        if (["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"].includes(event.key)) return;
        a001SyncMentionMenuToCaret(rec);
        event.stopPropagation();
    });

    /* ── keydown（capture）：撤销/重做优先 ── */
    editor.addEventListener("keydown", (event) => {
        /* ★ 运行（Ctrl/Cmd+Enter）前先立即落盘，避免「输入完立刻运行」读到去抖前的旧值。 */
        if ((event.ctrlKey || event.metaKey) && String(event.key || "").toLowerCase() === "enter") {
            flushSyncFromEditor(rec);
        }
        if (a001IsUndoRedoEvent(event)) a001HandlePromptHistoryKeydown(rec, event);
    }, true);

    /* ── keydown（bubble）：业务按键，顺序即优先级（勿改） ── */
    editor.addEventListener("keydown", (event) => {
        const key = String(event.key || "").toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === "s") {
            syncFromEditor(rec);
            event.preventDefault();
            return;
        }
        const raw = rec.doc?.view === A001_PROMPT_VIEW_RAW;
        if (raw) a001CloseMentionMenu(rec);
        if (!raw && a001HandleMentionMenuKeydown(rec, event)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (!raw && event.key === "#" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing
            && insertDialogueBlockAtSelection(rec)) {
            event.preventDefault();
            event.stopPropagation();
            node._a001DialogueHashHandled = true;
            setTimeout(() => { node._a001DialogueHashHandled = false; }, 0);
            syncFromEditor(rec);
            a001PushPromptHistory(rec);
            return;
        }
        const dialogue = dialogueBlockAtSelection(editor);
        if (event.key === "Enter" && dialogue && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            exitDialogueBlock(rec, dialogue);
            syncFromEditor(rec);
            a001PushPromptHistory(rec);
            return;
        }
        if (event.key === "Enter" && dialogue && event.shiftKey && insertEditorLineBreak(editor)) {
            event.preventDefault();
            event.stopPropagation();
            syncFromEditor(rec);
            a001PushPromptHistory(rec);
            return;
        }
        if (event.key === "Backspace" && (
            backspaceDialogueBoundary(rec)
            || deleteLineBreakNearCaret(rec, "backward")
            || deleteChipNearCaret(rec, "backward")
            || backspaceBeforeChip(rec)
            || backspaceAtLooseSentinel(rec)
            || blockNativeSentinelDeletion(editor)
        )) {
            event.preventDefault();
            syncFromEditor(rec);
            a001PushPromptHistory(rec);
        } else if (event.key === "Delete" && deleteChipNearCaret(rec, "forward")) {
            event.preventDefault();
            syncFromEditor(rec);
            a001PushPromptHistory(rec);
        } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && insertEditorLineBreak(editor)) {
            event.preventDefault();
            a001CloseMentionMenu(rec);
            syncFromEditor(rec);
            a001PushPromptHistory(rec);
        } else if (event.key === "Escape") {
            a001CloseMentionMenu(rec);
        }
        event.stopPropagation();
    });

    /* ── paste：文本里的引用标记 / 对话块标记转结构化 DOM ── */
    editor.addEventListener("paste", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const text = event.clipboardData?.getData("text/plain") || "";
        if (rec.doc?.view === A001_PROMPT_VIEW_RAW) {
            insertPlainText(editor, text);
            syncFromEditor(rec);
            a001PushPromptHistory(rec);
            return;
        }
        /* ★ 优先走「完整 doc 语法解析」：
         *  原始文本里既有 @ 媒体标签（<Picture 1>），也有对话块标签（<d>…</d>）。
         *  旧的 a001InsertTextWithMentionChips 只认媒体标签，会把 <d>…</d>
         *  当普通文字插进去（症状：粘贴原始文本后对话块不识别）。
         *  这里用与「视图切换 / 加载存档」同一个解析器 a001PromptPartsFromText，
         *  两类语法一并还原，语义完全一致。 */
        if (insertPromptTextWithStructure(rec, text)) {
            syncFromEditor(rec);
            a001PushPromptHistory(rec);
            a001SyncMentionMenuToCaret(rec);
            noteSelfWrite(node);
            return;
        }
        /* 兜底：解析器未接管（无光标 / 空文本）时退回旧路径。 */
        a001InsertTextWithMentionChips(rec, text);
        syncFromEditor(rec);
        a001PushPromptHistory(rec);
        a001SyncMentionMenuToCaret(rec);
        noteSelfWrite(node);
    });

    editor.addEventListener("blur", () => {
        syncFromEditor(rec);
        setTimeout(() => {
            if (!rec.menu?.element?.matches?.(":hover")) a001CloseMentionMenu(rec);
        }, 160);
    });

    /* ── wrap 级：阻断事件冒泡到画布（避免拖节点 / 画布快捷键误触发） ── */
    wrap.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        a001SetActivePromptRec(rec);
        if (!event.target?.closest?.(`.${A001_CHIP_CLASS}`)) a001CloseMentionMenu(rec);
    });
    for (const type of ["pointerup", "click", "dblclick", "contextmenu"]) {
        wrap.addEventListener(type, (event) => event.stopPropagation());
    }

    /* ── 滚轮：编辑器内滚动不缩放画布；未聚焦时交还画布 ── */
    const wheelHandler = (event) => {
        const focused = document.activeElement === editor;
        const horizontal = Math.abs(event.deltaX || 0) > Math.abs(event.deltaY || 0);
        const maxScrollTop = Math.max(0, editor.scrollHeight - editor.clientHeight);
        /* ★ lineHeight 缓存：getComputedStyle 每次调用都会强制一次样式重算，
         *   而滚轮事件在连续滚动时每秒可达数十次。按编辑器元素缓存；
         *   元素被重建（字号/外观变化通常伴随重建）时缓存自动失效并重取。 */
        if (rec._a001LineHeightEl !== editor) {
            rec._a001LineHeightEl = editor;
            rec._a001LineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 16;
        }
        const lineHeight = rec._a001LineHeight || 16;
        const deltaY = event.deltaMode === 1
            ? event.deltaY * lineHeight
            : event.deltaMode === 2
                ? event.deltaY * editor.clientHeight
                : event.deltaY;
        if (!focused) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            globalThis.app?.canvas?.processMouseWheel?.(event);
            return;
        }
        if (!event.ctrlKey && !horizontal && maxScrollTop > 0 && deltaY) {
            const next = Math.max(0, Math.min(maxScrollTop, editor.scrollTop + deltaY));
            if (next !== editor.scrollTop) {
                editor.scrollTop = next;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                return;
            }
        }
        if (!event.ctrlKey && !horizontal && maxScrollTop > 0) {
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        globalThis.app?.canvas?.processMouseWheel?.(event);
    };
    editor.addEventListener("wheel", wheelHandler, { passive: false, capture: true });
    wrap.addEventListener("wheel", wheelHandler, { passive: false });
}

/* ════════════════════════════════════════════════
 *  10 · 挂载 / 重挂 / 卸载
 * ════════════════════════════════════════════════ */

/** 取（或建）某槽的编辑器记录。 */
function ensureRec(node, outerInput) {
    if (!node._a001PromptEditors) node._a001PromptEditors = new Map();
    const slotName = String(outerInput?.name ?? "");
    let rec = node._a001PromptEditors.get(slotName);
    if (rec) return rec;
    rec = { node, outerInput, slotName, disposed: false };
    /* ★ doc 与 properties 的读写锚在本槽：多提升文本控件并存时各存各的。
     *  不能把读写放在模块顶层，否则多槽会互相覆盖。 */
    rec.readDoc = () => a001ReadPromptRecord(node, slotName);
    rec.writeDoc = (doc) => a001WritePromptRecord(node, slotName, doc);
    rec.persistDoc = () => safeCall(() => rec.writeDoc(rec.doc), undefined, "落盘 prompt doc");
    rec.serializeNow = () => serializeEditor(rec);
    rec.syncFromEditor = (markDirty = true) => syncFromEditor(rec, markDirty);
    rec.pushHistory = () => a001PushPromptHistory(rec);
    rec.renderFromDoc = (force = false) => renderEditorFromDoc(rec, force);
    rec.applyHistoryEntry = (doc) => {
        rec.doc = a001ClonePromptDoc(doc);
        rec.persistDoc();
        writePromotedText(rec.node, rec.outerInput, rec.doc.text);
        renderEditorFromDoc(rec, true);
        afterContentChange(rec);
    };
    rec.closeMentionMenu = () => a001CloseMentionMenu(rec);
    rec.refreshMentionPreviews = () => a001RefreshMentionPreviews(rec.node);
    node._a001PromptEditors.set(slotName, rec);
    /* 登记进 id 反查表：store.setValue 是高频回调，必须 O(1) 定位到 rec。 */
    registerRecId(rec);
    return rec;
}

/**
 * 判定某外层槽是否「可换自研编辑器」。
 *
 * ★ 为什么不能只看 _a001SourceWidget：
 *   工作流反序列化恢复的槽会直接带上 _a001OfficialWidgetId，
 *   此时 mountPromotedWidget 会提前 return（外层槽已有官方 widgetId），
 *   于是 _a001SourceWidget 可能压根没被重建 —— 只看它就判定为「不可编辑」，
 *   表现为「刷新/重开工作流后编辑器消失且不再回来」。
 *   故此时退化为读官方 store 里登记的 state.type（与投影层同源）。
 *
 * @returns {"yes"|"no"|"unknown"} unknown 表示「store 尚未就绪，暂无法判定」，
 *          调用方必须据此进入重试，而不是当成 no 永久放弃。
 */
function slotEditability(outerInput) {
    if (!outerInput || !slotWidgetId(outerInput)) return "no";
    const src = outerInput._a001SourceWidget;
    if (src) {
        return safeCall(() => deps.isMultilineWidget(src), false, "判定多行文本控件") ? "yes" : "no";
    }
    const store = deps.getStore();
    const state = store ? safeCall(() => store.getWidget(slotWidgetId(outerInput)), null, "取提升控件 state") : null;
    if (!state) return "unknown";
    return String(state.type || "") === "customtext" ? "yes" : "no";
}

/**
 * 清理「同一槽」的重复 wrap，只保留 keep 那一个。
 *
 * ★★ 为什么必须做（实测血泪，勿删）
 * -----------------------------------------------------------------------------
 *  症状：A001 的文本编辑器「有时候没被加载」——实为编辑器被创建了**多份**、
 *  以 position:absolute; inset:0 完全重叠在同一行上，互相遮挡。
 *  浏览器实测证据（同一节点同一槽）：
 *    · document.querySelectorAll('.a001-prompt-editor-wrap').length === 2
 *    · 两个 wrap 的 data-a001-prompt-slot 都是 "prompt"、都 isConnected
 *    · 而 node._a001PromptEditors 里只有 1 条记录（DOM 与记录数不匹配）
 *
 *  成因：rec.wrap 只记录**最后一套**。当某次流程新建了第二套 wrap 时，
 *  旧的那套就失去引用、变成「孤儿 DOM」：
 *    · 后续判定用 rec.wrap（新的、健康的）→ 认为无需重建，不再自愈；
 *    · 孤儿 wrap 永远留在行内，越积越多（Vue 每次重建都可能再加一套）。
 *
 *  故每次挂载/刷新都以「槽」为粒度去重：行内凡属于本槽、但不是 keep 的 wrap
 *  一律移除，从源头保证「一个槽只有一套 DOM」。
 *
 * @param {Element} row      承载行
 * @param {string}  slotName 槽名
 * @param {Element} keep     要保留的 wrap（可为 null，表示全部清理）
 * @returns {number} 被清理掉的数量
 */
function dedupeSlotWraps(row, slotName, keep) {
    if (!row) return 0;
    let removed = 0;
    for (const el of Array.from(row.querySelectorAll(`.${A001_WRAP_CLASS}`))) {
        if (el === keep) continue;
        /* 只清理「属于本槽」的 wrap：同名槽才是重复；不同槽的 wrap 要留着。 */
        if (String(el.getAttribute(A001_SLOT_ATTR) ?? "") !== String(slotName)) continue;
        safeCall(() => el.remove(), undefined, "清理重复编辑器 DOM");
        removed += 1;
    }
    return removed;
}

/** 为单个提升槽装配编辑器（幂等）。 */
function ensureSlotEditor(node, outerInput) {
    const located = locatePromotedTextRow(node, outerInput);
    if (!located) return false;
    const rec = ensureRec(node, outerInput);

    /* 行被 Vue 重建 → 旧 DOM 失联，重建编辑器 DOM。 */
    const stillValid = rec.wrap?.isConnected && located.row.contains(rec.wrap);
    if (!stillValid) {
        /* 行被 Vue 重建 → 旧菜单（挂在 body 上）会残留，先清掉。 */
        a001CloseMentionMenu(rec);
        rec.row = located.row;
        rec.textarea = located.textarea;
        rec.locateStrategy = located.strategy;
        /* ★ 建新之前先清掉本槽遗留的旧 wrap（含失去引用的孤儿 DOM）。
         *  必须早于 after(wrap)：否则新旧两套会同时存在于行内并重叠。 */
        const cleaned = dedupeSlotWraps(rec.row, rec.slotName, null);
        if (cleaned) alog(`清理重复编辑器 DOM | 槽:${rec.slotName} | 数量:${cleaned}`);
        const { wrap, editor, tools, viewButton, clearButton, copyButton, resizer } = buildEditorDom(rec);
        rec.wrap = wrap;
        rec.editor = editor;
        rec.tools = tools;
        rec.viewButton = viewButton;
        rec.clearButton = clearButton;
        rec.copyButton = copyButton;
        rec.resizer = resizer;
        markRow(rec);
        hideOfficialTextarea(rec);
        /* ★ 先把存档高度写回「行」（早于挂 wrap）——缩小「行被 Vue 重建 → 高度丢失
         *   → 稍后才补回」之间的塌陷窗口，避免编辑器高度「闪一下」。
         *  applyResizeHeight 幂等且受 row.style.minHeight 保护，安全。 */
        applyResizeHeight(rec);
        located.textarea.after(wrap);
        /* 高度交由 CSS：wrap 用 absolute+inset:0 贴合本行（行已是定位上下文），
         * editor height:100% 撑满 wrap —— 与官方控件天然等高且随节点伸缩。 */
        bindEditorEvents(rec);
        /* ★ 挂右下角拖拽手柄 + 读回存档高度（行被 Vue 重建后原内联 min-height 丢失）。 */
        bindResizerEvents(rec);
        restoreDocForSlot(rec);
        renderEditorFromDoc(rec, true);
        /* ★ 历史栈必须在**渲染完成后**重置，否则栈底会是「渲染前的空 doc」，
         *  用户首次 Ctrl+Z 会莫名其妙地清空编辑器（而不是回到加载时的内容）。 */
        a001ResetPromptHistory(rec);
        a001SetActivePromptRec(rec);
        /* 编辑器插入改变了行高 → 通知胶囊与节点尺寸（一次性，不进轮询）。 */
        afterContentChange(rec);
        alog(`编辑器已装配 | 槽:${rec.slotName} | 定位:${located.strategy}`);
    } else {
        rec.row = located.row;
        rec.textarea = located.textarea;
        /* ★ 健康分支也要去重：孤儿 wrap 可能是在「本套之后」被别的流程加进来的，
         *  此时 stillValid 为真、走不到重建分支，若不去重就永远不会自愈。 */
        const cleaned = dedupeSlotWraps(rec.row, rec.slotName, rec.wrap);
        if (cleaned) alog(`清理重复编辑器 DOM（自愈）| 槽:${rec.slotName} | 数量:${cleaned}`);
        markRow(rec);
        hideOfficialTextarea(rec);
        /* 幂等校正：确保 wrap 紧跟官方 textarea（Vue 可能把 wrap 挪位）。 */
        if (rec.wrap.previousElementSibling !== located.textarea) located.textarea.after(rec.wrap);
        /* ★ 健康分支兜底：手柄若缺失（旧版本已装配的 DOM）则补挂；
         *  行若被 Vue 重建导致内联 min-height 丢失，则从存档读回。 */
        if (rec.wrap && !rec.wrap.querySelector?.(".a001-prompt-resizer")) {
            const resizer = document.createElement("div");
            resizer.className = "a001-prompt-resizer";
            resizer.setAttribute("aria-hidden", "true");
            rec.wrap.append(resizer);
            rec.resizer = resizer;
        }
        if (!rec._a001ResizerDown) bindResizerEvents(rec);
        applyResizeHeight(rec);
    }
    syncViewButton(rec);
    /* ★ 先打自身写入抑制窗口，再为第三方提示词小助手(005)补挂图标。
     *  必要性：补挂过程中会把官方 textarea 临时切到可见（style 变化）并复位
     *  _promptAssistantInitialized，这些 DOM 改动会被本节点的 MutationObserver
     *  守卫观察到；若不在抑制窗口内，会被误判为「外部重建」而触发一次多余重挂。 */
    noteSelfWrite(node);
    /* ★ 顺带为第三方提示词小助手(005)补挂图标：其图标挂在官方 textarea 的父容器上，
     *  而我们把 textarea 隐藏了，导致其可见性校验失败、DOM 重建后不再自愈。
     *  此处是「装配/重挂」的唯一收口，每次都尝试一次补挂（幂等，已挂则跳过）。 */
    safeCall(() => rewirePromptAssistantForSlot(rec), undefined, "补挂第三方提示词小助手图标");
    return true;
}

/**
 * 恢复某槽的 doc 并渲染。
 *
 * 真相优先级（★ 关键）：
 *   1) doc.text === 控件真值 → 用存档 parts 渲染（保留 chip 结构）
 *   2) 控件真值为空而存档非空 → 补写控件值（首次升级路径）
 *   3) 不一致 → 以**控件真值**为真相重建 parts（执行口径优先），
 *      旧 chip 经解析器尽量还原，解析不到的显示 unresolved/pending。
 */
function restoreDocForSlot(rec) {
    const node = rec.node;
    const value = currentTextOf(node, rec.outerInput);
    const stored = safeCall(() => rec.readDoc?.(), null, "读 prompt doc");
    if (stored && stored.text === value) {
        rec.doc = stored;
    } else if (!value && stored?.text) {
        rec.doc = stored;
        writePromotedText(node, rec.outerInput, stored.text);
    } else {
        const view = stored?.view === A001_PROMPT_VIEW_RAW ? A001_PROMPT_VIEW_RAW : A001_PROMPT_VIEW_STRUCTURED;
        rec.doc = {
            v: 1,
            text: value,
            parts: a001PromptPartsFromText(value, a001ResolveMentionFrom(node)),
            view,
        };
    }
}

/**
 * 挂载该节点全部可编辑的提升槽。
 *
 * 返回语义（决定是否进重试链）：
 *   true  —— 「处理完毕」：或已全部装配，或本节点根本没有可编辑槽
 *            （★ 后者必须视为完毕，否则没有文本提升控件的 A001 节点会
 *             被无限重试，每 500ms 空跑一次）
 *   false —— 「DOM 未就绪」：有可编辑槽但定位不到行，需要重试
 */
export function ensureA001PromptEditor(node) {
    if (typeof document === "undefined" || node?.id == null) return true;
    /* ★ 复位终端标记：节点对象会被复用（撤销/重做/切图），onRemoved 会置 true，
     *  但复用后若不在这里清回 false，「重试链」与「守卫同帧重挂」都会被挡死，
     *  表现为 UI 时有时无且永不恢复。本函数是唯一(重)挂载入口，故在此复位。 */
    node._a001PromptDisposed = false;

    /* 逐个槽判定「可编辑性」；unknown（store 未就绪）必须进重试，
     * 不能与 no 混同 —— 否则刷新后 store 稍晚就绪的节点会永久不装配编辑器。 */
    const slots = [];
    let unknown = false;
    for (const outerInput of node.inputs || []) {
        const state = slotEditability(outerInput);
        if (state === "unknown") unknown = true;
        else if (state === "yes") slots.push(outerInput);
    }
    if (!slots.length) return !unknown;

    /* ★ 守卫常驻：只要该节点存在「可编辑槽」，无论此刻是否处于隐藏态都把
     *  MutationObserver 挂上。原因：隐藏态下本函数会提前返回（不挂编辑器），
     *  而「显示控件」时控件行会被 Vue 重建 —— 若没有守卫感知这次 DOM 变化，
     *  就再无人能把编辑器挂回来（表现为显示控件后编辑器永久消失）。 */
    startPromptGuard(node);

    /* 控件整体隐藏时不挂载（doc 保留在 properties，恢复显示后自动回来）。 */
    if (safeCall(() => deps.isWidgetsHidden(node), false, "查询控件隐藏态")) return true;

    let allOk = true;
    for (const outerInput of slots) {
        const ok = safeCall(() => ensureSlotEditor(node, outerInput), false, "装配编辑器");
        if (!ok) allOk = false;
    }
    return allOk && !unknown;
}

/* ── 重试链（单一链 + 退避 + 图存活宽限） ── */

const RETRY_DELAYS = [100, 100, 200, 200, 500];
const GRAPH_GRACE_MS = 5000;

function schedulePromptRetry(node) {
    if (node._a001PromptDisposed) return;
    if (node._a001PromptRetryTimer) return;
    const now = Date.now();
    if (!node._a001PromptFirstTryAt) node._a001PromptFirstTryAt = now;
    const inGraph = safeCall(() => {
        const g = getNodeGraph(node);
        return !!g && (g._nodes || []).includes(node);
    }, true, "编辑器重试存活判据");
    if (!inGraph && now - node._a001PromptFirstTryAt > GRAPH_GRACE_MS) return;
    const step = node._a001PromptRetryCount || 0;
    node._a001PromptRetryCount = step + 1;
    const delay = RETRY_DELAYS[Math.min(step, RETRY_DELAYS.length - 1)];
    node._a001PromptRetryTimer = setTimeout(() => {
        node._a001PromptRetryTimer = null;
        if (node._a001PromptDisposed) return;
        safeCall(() => ensureA001PromptEditor(node), undefined, "编辑器重试挂载");
    }, delay);
}

/* ── MutationObserver 守卫（Vue 重建 DOM 后同帧重挂） ── */

/* ── 编辑器守卫：模块级单例观察器（2026-10-05 收敛）──
 * 改造前：每个节点各 new 一个 MutationObserver 观察同一个「画布稳定层」子树，
 *   N 个节点 = N 个观察器同时盯同一批 DOM 变更，回调数 O(N×M)。
 * 现改为「模块级唯一观察器 + 节点注册表」：一次回调内只遍历已注册的节点，
 *   各节点原有判定逻辑逐字保留；「观察目标失效自愈」上提为模块级（单例重绑）。 */
let _promptGuardMO = null;
let _promptGuardTarget = null;
let _promptGuardRebinding = false;
const _promptGuardNodes = new Set();

/** 取画布稳定层（原各节点 stableTarget 的同一口径）。 */
function _promptGuardStableTarget() {
    try {
        const c = globalThis.app?.canvas?.canvas?.parentElement;
        if (c) return c;
    } catch (_e) { /* 画布未就绪，退回 body */ }
    return document.body;
}

/** 起 / 重绑单例观察器（幂等；目标失效时自动重绑）。 */
function ensurePromptGuardMO() {
    if (_promptGuardRebinding) return;
    const t = _promptGuardStableTarget();
    if (!t) return;
    if (_promptGuardMO && _promptGuardTarget === t && _promptGuardTarget.isConnected) return;
    _promptGuardRebinding = true;
    try {
        if (_promptGuardMO) safeCall(() => _promptGuardMO.disconnect(), undefined, "重绑编辑器守卫");
        _promptGuardMO = new MutationObserver((mutations) => {
            for (const node of Array.from(_promptGuardNodes)) {
                const fn = node._a001PromptGuardOnMutations;
                if (typeof fn !== "function") continue;
                safeCall(() => fn(mutations), undefined, "编辑器守卫回调");
            }
        });
        _promptGuardTarget = t;
        _promptGuardMO.observe(t, {
            childList: true,
            subtree: true,
            /* ★ 监听行 style/class：Vue 重建或重置承载行会清掉内联 min-height，
             *   属于纯属性变更（无 childList），不监听就永远补不回高度。
             *   用 attributeFilter 把范围钉死在 class/style，降低触发量；
             *   回调内还有「只看 .a001-prompt-row」的廉价前置过滤兜底。 */
            attributes: true,
            attributeFilter: ["class", "style"],
        });
    } catch (_e) { /* 重绑失败忽略，不影响已挂编辑器 */ } finally {
        _promptGuardRebinding = false;
    }
}

function startPromptGuard(node) {
    if (!node || node._a001PromptGuardMO) return;
    /* ★ 哨兵沿用 _a001PromptGuardMO（值改为 true），避免改动外部既有判据；
     *   真实观察器已上提为模块级单例 _promptGuardMO。 */
    node._a001PromptGuardMO = true;
    node._a001PromptGuardOnMutations = (mutations) => {
        if (node._a001PromptDisposed) return;
        /* 自身写入抑制窗口：编辑器自身改动不该触发重挂判定。 */
        if (inSelfWrite(node)) return;
        /* ★ 超轻量前置过滤（attributes 监听会高频触发，必须先廉价筛掉）：
         *   只看「承载行（.a001-prompt-row）的 style/class 变化」——Vue 重建或重置承载行时会
         *   清掉内联 min-height，必须在此补回高度存档，否则「重载后编辑器高度偶发丢失」。
         *   其它元素的属性抖动（拖拽、缩放在改 transform）一律立即跳过。 */
        /* 编辑器子树内的变更一律忽略（输入 / 滚动 / 改 style 都会回调）。
         * ★ 必须放在补回逻辑之前：否则用户在编辑器内打字时也会跑一遍补回，白白开销。 */
        if (mutations?.length && mutations.every((m) => {
            const el = m.target?.closest ? m.target : m.target?.parentElement;
            return !!el?.closest?.(`[${A001_DOM_ATTR}]`);
        })) return;
        const rowStyleTouched = mutations?.length && mutations.some((m) => {
            if (m.type !== "attributes") return false;
            const t = m.target;
            return !!(t?.classList?.contains?.("a001-prompt-row"));
        });
        if (rowStyleTouched) {
            const rs = [...(node._a001PromptEditors?.values?.() || [])];
            for (const r of rs) safeCall(() => applyResizeHeight(r), undefined, "行 style 变化补回编辑器高度");
            /* 继续走下面流程（可能同时伴随结构变化）。 */
        }
        /* ★ 无条件补回（覆盖 childList 整树重建场景）：
         *   Vue 用「新建行元素替换旧行」时只产生 childList 变更（无 attributes），
         *   上面的 rowStyleTouched 不命中；若不在此补回，行会一直塌到
         *   ensureA001PromptEditor 重挂时才恢复 → 表现为「编辑器高度闪一下」。
         *   仅当变更落在本节点 DOM 子树内才执行，且 applyResizeHeight 幂等廉价。 */
        if (mutations?.length && [...(node._a001PromptEditors?.values?.() || [])].length) {
            const rootNode = node._a001DomRoot?.isConnected
                ? node._a001DomRoot
                : (node.id != null ? document.querySelector(`[data-node-id="${node.id}"]`) : null);
            const touchedSelf = !rootNode || mutations.some((m) => {
                const t = m.target;
                return !!(t && rootNode === t) || !!(t?.closest?.(`[data-node-id="${node.id}"]`));
            });
            if (touchedSelf) {
                const rs = [...(node._a001PromptEditors?.values?.() || [])];
                for (const r of rs) safeCall(() => applyResizeHeight(r), undefined, "结构变化补回编辑器高度");
            }
        }
        if (!_promptGuardTarget?.isConnected) {
            safeCall(() => ensurePromptGuardMO(), undefined, "编辑器观察目标自愈重绑");
        } else if (_promptGuardTarget === document.body) {
            const c = safeCall(() => globalThis.app?.canvas?.canvas?.parentElement, null, "取画布容器");
            if (c && c !== _promptGuardTarget) {
                safeCall(() => ensurePromptGuardMO(), undefined, "编辑器观察目标升级重绑");
            }
        }
        /* 廉价早退：所有编辑器 wrap 都还连着 → 只做轻量修正。
         * ★ 但**必须连带去重**：早退只看 rec.wrap（最后一套），
         *   若行内另有同槽孤儿 wrap，这里直接 return 就永远不会被发现。
         * ★★ 还必须补 applyResizeHeight（血泪教训，用户反馈「重载后编辑器高度偶尔丢失」）：
         *   Vue 重建「承载行」时会清掉行的内联 min-height，但只要 wrap 仍连着（多数情况），
         *   就会走进本早退分支 —— 原先这里只去重 / 隐藏 textarea，从不读回高度存档，
         *   于是「行还在、高度没了」。applyResizeHeight 幂等，且有 row.style.minHeight 保护，
         *   不会覆盖用户正在拖的内联值，可安全重放。 */
        const recs = [...(node._a001PromptEditors?.values?.() || [])];
        if (recs.length && recs.every((r) => r.wrap?.isConnected && r.row?.contains(r.wrap))) {
            for (const r of recs) {
                safeCall(() => dedupeSlotWraps(r.row, r.slotName, r.wrap), undefined, "守卫去重编辑器 DOM");
                hideOfficialTextarea(r);
                safeCall(() => applyResizeHeight(r), undefined, "守卫补回编辑器高度存档");
            }
            return;
        }
        safeCall(() => ensureA001PromptEditor(node), undefined, "编辑器同帧重挂");
    };
    _promptGuardNodes.add(node);
    ensurePromptGuardMO();
}

/** 上游连接变化 → 刷新候选（一次性包装 onConnectionsChange）。 */
function hookConnections(node) {
    if (node._a001PromptConnHooked) return;
    node._a001PromptConnHooked = true;
    const prev = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        const out = prev?.apply(this, arguments);
        safeCall(() => a001RequestMentionRefresh(this), undefined, "连接变化刷新引用");
        return out;
    };
}

/* ── 对外入口 ── */

/** 装配（幂等；失败自动重试）。四个注册钩子与 promote 后都会调用。 */
export function attachA001PromptEditor(node) {
    if (!node || node.id == null) return false;
    if (typeof document === "undefined") return false;
    injectA001PromptCss();
    a001InstallPromptUndoShield();
    a001PatchLGraphCanvasProcessKey();
    /* store 的外部改值回灌监听（WeakSet 去重，store 未就绪时静默跳过）。 */
    hookStoreExternalSync();
    hookConnections(node);
    /* 005 入口兜底 hook（全局一次）：修正其对 A001 的 Note 误判。 */
    hookPromptAssistantSetup();
    const ok = safeCall(() => ensureA001PromptEditor(node), false, "装配 Prompt 编辑器");
    if (ok) {
        node._a001PromptRetryCount = 0;
        node._a001PromptFirstTryAt = 0;
        if (node._a001PromptRetryTimer) {
            clearTimeout(node._a001PromptRetryTimer);
            node._a001PromptRetryTimer = null;
        }
    } else {
        schedulePromptRetry(node);
    }
    return ok;
}

/** 轻量刷新（resize / promote / 控件显隐后调用）。
 *  健康时零查询直接返回（避免拖拽 resize 期间每帧 querySelectorAll）；
 *  确有编辑器脱离 DOM 才走重挂。 */
export function refreshA001PromptEditors(node) {
    if (!node?._a001PromptEditors?.size) {
        return safeCall(() => attachA001PromptEditor(node), false, "编辑器补挂");
    }
    let needRepair = false;
    for (const rec of node._a001PromptEditors.values()) {
        if (rec.wrap?.isConnected && rec.row?.contains(rec.wrap)) {
            /* ★ 顺手清理本槽的重复/孤儿 wrap：刷新是高频入口，
             *  在此去重可让「重复挂载」在下一轮刷新时自动收敛，无需等重建。 */
            safeCall(() => dedupeSlotWraps(rec.row, rec.slotName, rec.wrap), undefined, "刷新时去重编辑器 DOM");
            hideOfficialTextarea(rec);
        } else {
            needRepair = true;
        }
    }
    if (!needRepair) return true;
    return safeCall(() => ensureA001PromptEditor(node), false, "编辑器刷新重挂");
}

/** 落盘前刷值（serialize 钩子调用，确保 widgets_values / 子图导出拿到新值）。 */
export function flushA001PromptEditors(node) {
    for (const rec of node?._a001PromptEditors?.values?.() || []) {
        safeCall(() => syncFromEditor(rec, false), undefined, "落盘前刷编辑器值");
    }
}

/** 卸载单个槽的编辑器（反提升时调用）。 */
export function detachA001PromptEditorSlot(node, slotName) {
    const rec = node?._a001PromptEditors?.get(String(slotName));
    if (!rec) return false;
    cancelScheduledSync(rec);
    rec.disposed = true;
    /* 若被卸载的正是当前活跃记录，清掉模块级强引用（防 rec 泄漏 / 僵尸回灌）。 */
    safeCall(() => a001ClearActivePromptRec(rec), undefined, "清理活跃编辑器引用");
    unregisterRecId(rec);
    a001CloseMentionMenu(rec);
    /* ★ 先摘手柄监听再移除 DOM（避免拖拽中途卸载留下 window 级监听）。 */
    unbindResizerEvents(rec);
    safeCall(() => rec.wrap?.remove?.(), undefined, "移除编辑器 DOM");
    showOfficialTextarea(rec);
    node._a001PromptEditors.delete(String(slotName));
    if (!node._a001PromptEditors.size) {
        node._a001PromptEditors = null;
    }
    noteSelfWrite(node);
    return true;
}

/** 整体卸载（节点删除 / 反提升全部时调用）。 */
export function detachA001PromptEditor(node) {
    if (!node) return false;
    node._a001PromptDisposed = true;
    if (node._a001PromptRetryTimer) {
        clearTimeout(node._a001PromptRetryTimer);
        node._a001PromptRetryTimer = null;
    }
    /* 已无尺寸重算定时器（高度零干预后不再需要），此处不再清理。 */
    /* ★ 单例观察器：只从注册表摘除本节点；注册表空了再断掉共享实例。 */
    _promptGuardNodes.delete(node);
    node._a001PromptGuardOnMutations = null;
    node._a001PromptGuardMO = null;
    node._a001PromptGuardTarget = null;
    node._a001PromptGuardRebind = null;
    if (!_promptGuardNodes.size && _promptGuardMO) {
        safeCall(() => _promptGuardMO.disconnect(), undefined, "断开空置的编辑器守卫");
        _promptGuardMO = null;
        _promptGuardTarget = null;
    }
    for (const rec of node._a001PromptEditors?.values?.() || []) {
        cancelScheduledSync(rec);
        rec.disposed = true;
        /* 清掉模块级活跃记录引用（若命中），防 rec 泄漏。 */
        safeCall(() => a001ClearActivePromptRec(rec), undefined, "清理活跃编辑器引用");
        unregisterRecId(rec);
        a001CloseMentionMenu(rec);
        /* ★ 先摘手柄监听再移除 DOM（避免拖拽中途卸载留下 window 级监听）。 */
        unbindResizerEvents(rec);
        safeCall(() => rec.wrap?.remove?.(), undefined, "移除编辑器 DOM");
        /* ★ 连同本槽的**孤儿 wrap** 一起清掉：rec.wrap 只指向最后一套，
         *  若行内还残留其它同槽 wrap（重复挂载产物），这里不清就会永久遗留。 */
        safeCall(() => dedupeSlotWraps(rec.row, rec.slotName, null), undefined, "清理遗留编辑器 DOM");
        showOfficialTextarea(rec);
        rec.wrap = null;
        rec.editor = null;
        rec.history = null;
    }
    node._a001PromptEditors = null;
    /* ★ 复位复用相关标记：节点对象被撤销恢复后需能重新装配。 */
    node._a001PromptRetryCount = 0;
    node._a001PromptFirstTryAt = 0;
    node._a001PromptSelfWriteUntil = 0;
    node._a001PromptComposing = false;
    node._a001DialogueHashHandled = false;
    node._a001PromptPaRewiring = false;
    node._a001PromptPaNoteFixScheduled = false;
    return true;
}

/** 供外部（预览刷新 / 运行结束）触发的引用预览刷新。 */
export function notifyA001PromptEditorsFromPreview(node) {
    safeCall(() => a001RequestMentionRefresh(node), undefined, "预览刷新通知引用");
}

/* ════════════════════════════════════════════════
 *  11 · 诊断
 * ════════════════════════════════════════════════ */

/**
 * 自检快照（控制台调用：inspectA001PromptEditor(app.graph._nodes[0])）。
 * widgetsHaveOurDom 必须恒为 false —— 它为 true 说明误走了 addDOMWidget。
 */
export function inspectA001PromptEditor(node) {
    const out = {
        nodeId: node?.id ?? null,
        gridFound: false,
        retryPending: !!node?._a001PromptRetryTimer,
        guardOn: !!node?._a001PromptGuardMO,
        disposedFlag: !!node?._a001PromptDisposed,
        widgetsHidden: safeCall(() => deps.isWidgetsHidden(node), false, "查询隐藏态"),
        widgetsHaveOurDom: false,
        editors: [],
    };
    if (!node) return out;
    out.widgetsHaveOurDom = (node.widgets || []).some(
        (w) => w?.element?.classList?.contains?.(A001_WRAP_CLASS)
    );
    out.gridFound = !!findWidgetGrid(node);
    for (const rec of node._a001PromptEditors?.values?.() || []) {
        const counts = { text: 0, mention: 0, dialogue: 0 };
        for (const part of rec.doc?.parts || []) {
            if (counts[part?.type] != null) counts[part.type] += 1;
        }
        out.editors.push({
            slot: rec.slotName,
            locateStrategy: rec.locateStrategy || "",
            rowFound: !!rec.row?.isConnected,
            taHidden: rec.textarea?.style?.display === "none",
            wrapConnected: !!rec.wrap?.isConnected,
            /* 编辑器高度由 CSS(height:100%) 决定，这里回读实际像素值便于核对。 */
            editorHeight: safeCall(
                () => Math.round(Number(rec.editor?.getBoundingClientRect?.().height) || 0),
                0,
                "读编辑器实际高度"
            ),
            docTextLen: String(rec.doc?.text || "").length,
            partCounts: counts,
            viewMode: rec.doc?.view || A001_PROMPT_VIEW_STRUCTURED,
            historyLen: rec.history?.undo?.length ?? 0,
        });
    }
    return out;
}

/* 历史模块需要「当前图」引用；在此注入，避免它 import app 造成来源分裂。 */
initPromptHistoryDeps({
    getGraph: () => safeCall(() => getNodeGraph(null), null, "取当前图"),
});

export default {
    initPromptDeps,
    attachA001PromptEditor,
    refreshA001PromptEditors,
    flushA001PromptEditors,
    detachA001PromptEditor,
    detachA001PromptEditorSlot,
    notifyA001PromptEditorsFromPreview,
    inspectA001PromptEditor,
};