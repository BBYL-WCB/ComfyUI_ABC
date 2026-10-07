/* =============================================================================
 * A001_prompt_history.js —— A001 @文本编辑器 · 历史与撤销防护
 * -----------------------------------------------------------------------------
 * 一、为什么需要「撤销防护」
 * -----------------------------------------------------------------------------
 * 编辑器是 contenteditable，落在画布节点内部。若不拦截：
 *   · Ctrl+Z 会被 LiteGraph 的 processKey 当成「图撤销」→ 编辑器里的输入无法撤销，
 *     反而把整个节点/连线撤销掉（用户体感：打字后按 Ctrl+Z 节点消失）。
 *   · 浏览器原生 undo 事件（beforeinput historyUndo）也会冒泡到画布。
 * 参考实现的做法（本模块复刻）：自建 doc 级历史栈 + 三层拦截
 *   ① window keydown 捕获（最外层，防止 LiteGraph 先拿到）
 *   ② editor keydown 捕获（编辑器内）
 *   ③ LGraphCanvas.prototype.processKey 改写（画布键盘入口兜底）
 *
 * 二、历史栈
 * -----------------------------------------------------------------------------
 *   rec.history = { undo: [{doc}], redo: [{doc}], lastKey: string, applying: boolean }
 *   入栈用 a001PromptDocKey 去重（同内容不入栈），上限 A001_PROMPT_HISTORY_LIMIT。
 *
 * 三、与上层解耦
 * -----------------------------------------------------------------------------
 * 本模块只操作 rec 契约字段：rec.node / rec.editor / rec.history /
 * rec.applyHistoryEntry(doc)。不 import 编辑器模块。
 * ========================================================================== */

import { safeCall } from "./A001_shared.js?v=20261007a";
import {
    A001_EDITOR_CLASS,
    A001_PROMPT_HISTORY_LIMIT,
    A001_PROMPT_UNDO_VERSION,
    a001ClonePromptDoc,
    a001PromptDocKey,
} from "./A001_prompt_core.js?v=20261007a";

/* 当前获得焦点的编辑器记录（window 级捕获时用来判断「事件属于哪个编辑器」）。 */
let a001ActivePromptRec = null;

export function a001SetActivePromptRec(rec) {
    a001ActivePromptRec = rec || null;
}

/** 若当前活跃记录就是 rec，则清空该引用（编辑器卸载时调用，防 rec 泄漏）。
 *  ★ 必要性：a001ActivePromptRec 是模块级强引用，持有 rec（含已 remove 的 DOM、
 *  历史栈、全量 doc）。卸载后若不清，该 rec 无法 GC，且 recFromEditor 的快速
 *  路径会持续返回这个僵尸 rec。 */
export function a001ClearActivePromptRec(rec) {
    if (rec && a001ActivePromptRec === rec) a001ActivePromptRec = null;
}

/** 从事件目标或当前焦点反查编辑器元素。
 *
 * ★ 刻意**不做**「回退到最近一次活跃编辑器」：window 捕获阶段一旦命中就会
 *   stopImmediatePropagation 吞掉 Ctrl+Z，若此时编辑器其实已失焦（焦点在画布），
 *   画布的撤销会被误吞。只认「事件目标」与「当前焦点」这两个确凿来源。 */
function editorFromEvent(event) {
    const target = event?.target;
    if (target?.closest) {
        const hit = target.closest(`.${A001_EDITOR_CLASS}`);
        if (hit) return hit;
    }
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (active?.closest) {
        const hit = active.closest(`.${A001_EDITOR_CLASS}`);
        if (hit) return hit;
    }
    return null;
}

/** 由编辑器元素反查记录（rec.editor === el）。 */
function recFromEditor(editor) {
    if (!editor) return null;
    if (a001ActivePromptRec?.editor === editor) return a001ActivePromptRec;
    for (const n of a001IterNodes()) {
        for (const rec of n._a001PromptEditors?.values?.() || []) {
            if (rec?.editor === editor) {
                a001ActivePromptRec = rec;
                return rec;
            }
        }
    }
    return null;
}

/** 遍历画布上所有节点（安全）。 */
function a001IterNodes() {
    const graph = safeCall(() => a001GraphRef(), null, "取当前图");
    return graph?._nodes || [];
}

/* 图引用由编辑器模块注入（避免本模块 import app 造成多重来源）。 */
let a001GraphRef = () => null;
export function initPromptHistoryDeps(deps) {
    if (typeof deps?.getGraph === "function") a001GraphRef = deps.getGraph;
}

/** 判定是否为「撤销/重做」组合键。 */
export function a001IsUndoRedoEvent(event) {
    if (!(event?.ctrlKey || event?.metaKey)) return false;
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "");
    return key === "z" || key === "y" || code === "KeyZ" || code === "KeyY";
}

/** 取（或初始化）记录的历史栈。 */
function ensureHistory(rec) {
    if (!rec?.editor) return null;
    if (rec.history) return rec.history;
    const doc = a001ClonePromptDoc(safeCall(() => rec.serializeNow?.(), null, "历史初始化序列化"));
    rec.history = {
        undo: [{ doc }],
        redo: [],
        lastKey: a001PromptDocKey(doc),
        applying: false,
    };
    return rec.history;
}

/** 重置历史栈（挂载 / 内容被外部整体替换后调用）。 */
export function a001ResetPromptHistory(rec) {
    if (!rec) return;
    rec.history = null;
    ensureHistory(rec);
}

/** 把当前编辑器内容压入历史（同内容自动去重）。 */
export function a001PushPromptHistory(rec) {
    const history = ensureHistory(rec);
    if (!history || !rec?.editor || history.applying) return;
    const doc = a001ClonePromptDoc(safeCall(() => rec.serializeNow?.(), null, "历史入栈序列化"));
    const key = a001PromptDocKey(doc);
    if (key === history.lastKey) return;
    history.undo.push({ doc });
    if (history.undo.length > A001_PROMPT_HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
    history.lastKey = key;
}

/** 应用一条历史（写 doc → 重渲染 → 光标置尾）。 */
function applyHistoryEntry(rec, entry) {
    const history = rec?.history;
    if (!history || !entry?.doc || !rec?.editor) return false;
    history.applying = true;
    try {
        const doc = a001ClonePromptDoc(entry.doc);
        safeCall(() => rec.applyHistoryEntry?.(doc), undefined, "应用历史条目");
        history.lastKey = a001PromptDocKey(doc);
    } finally {
        history.applying = false;
    }
    safeCall(() => rec.closeMentionMenu?.(), undefined, "历史应用后关菜单");
    rec.editor.focus();
    setCaretAtEnd(rec.editor);
    return true;
}

/** 光标移到编辑器末尾。 */
function setCaretAtEnd(editor) {
    if (!editor) return;
    const selection = window.getSelection?.();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
}

/** 处理撤销/重做按键（消费事件）。 */
export function a001HandlePromptHistoryKeydown(rec, event) {
    if (!a001IsUndoRedoEvent(event)) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    const history = ensureHistory(rec);
    if (!history) return true;
    const key = String(event.key || "").toLowerCase();
    const isRedo = key === "y"
        || String(event.code || "") === "KeyY"
        || (key === "z" && event.shiftKey);
    if (isRedo) {
        const entry = history.redo.pop();
        if (!entry) return true;
        history.undo.push(entry);
        applyHistoryEntry(rec, entry);
        return true;
    }
    if (history.undo.length <= 1) return true;
    const current = history.undo.pop();
    if (current) history.redo.push(current);
    applyHistoryEntry(rec, history.undo[history.undo.length - 1]);
    return true;
}

/* ════════════════════════════════════════════════
 *  全局防护安装（幂等，全局只装一次）
 * ════════════════════════════════════════════════ */

let a001ShieldInstalled = false;

export function a001InstallPromptUndoShield() {
    if (a001ShieldInstalled || typeof window === "undefined") return;
    a001ShieldInstalled = true;

    /* ① window keydown 捕获：早于 LiteGraph 的画布监听拿到事件。 */
    window.addEventListener("keydown", (event) => {
        if (!a001IsUndoRedoEvent(event)) return;
        const rec = recFromEditor(editorFromEvent(event));
        if (!rec) return;
        a001PushPromptHistory(rec);
        a001HandlePromptHistoryKeydown(rec, event);
    }, true);

    /* ② pointerdown / focusin：记录当前活跃编辑器（供无 target 的事件反查）。 */
    window.addEventListener("pointerdown", (event) => {
        const editor = event?.target?.closest?.(`.${A001_EDITOR_CLASS}`);
        if (editor) a001ActivePromptRec = recFromEditor(editor);
    }, true);
    document.addEventListener("focusin", (event) => {
        const editor = event?.target?.closest?.(`.${A001_EDITOR_CLASS}`);
        if (editor) a001ActivePromptRec = recFromEditor(editor);
    }, true);

    /* ③ beforeinput 的 historyUndo / historyRedo（浏览器原生撤销入口）。 */
    document.addEventListener("beforeinput", (event) => {
        if (event?.inputType !== "historyUndo" && event?.inputType !== "historyRedo") return;
        const rec = recFromEditor(editorFromEvent(event));
        if (!rec) return;
        const isRedo = event.inputType === "historyRedo";
        a001PushPromptHistory(rec);
        a001HandlePromptHistoryKeydown(rec, {
            ctrlKey: true,
            metaKey: false,
            shiftKey: isRedo,
            key: isRedo ? "y" : "z",
            code: isRedo ? "KeyY" : "KeyZ",
            preventDefault: () => event.preventDefault?.(),
            stopPropagation: () => event.stopPropagation?.(),
            stopImmediatePropagation: () => event.stopImmediatePropagation?.(),
        });
    }, true);
}

/**
 * 改写 LGraphCanvas.prototype.processKey。
 *
 * 必要性：LiteGraph 在画布层处理 Ctrl+Z（图撤销）与 Delete（删节点）。
 * 若编辑器已聚焦，这些键必须只作用于编辑器 —— 否则「选中节点后在编辑器里
 * 按 Delete / Ctrl+Z」会误删节点或撤销整张图。
 */
let a001ProcessKeyPatched = false;

export function a001PatchLGraphCanvasProcessKey() {
    if (a001ProcessKeyPatched) return;
    const proto = globalThis.LGraphCanvas?.prototype;
    if (!proto || typeof proto.processKey !== "function") return;
    a001ProcessKeyPatched = true;
    const original = proto.processKey;
    proto.processKey = function a001ProcessKeyShield(event) {
        const editor = safeCall(() => editorFromEvent(event), null, "processKey 反查编辑器");
        const rec = editor ? safeCall(() => recFromEditor(editor), null, "processKey 反查记录") : null;
        if (rec) {
            if (a001IsUndoRedoEvent(event)) {
                a001PushPromptHistory(rec);
                a001HandlePromptHistoryKeydown(rec, event);
                return;
            }
            /* Delete / Backspace 在编辑器内是删字符，绝不能落成「删节点」。 */
            const key = String(event?.key || "");
            if (key === "Delete" || key === "Backspace") return;
        }
        return original.apply(this, arguments);
    };
}

/**
 * 给 contenteditable 强行声明 type="textarea"。
 *
 * 目的：让浏览器把该元素识别为「文本域」，从而在 Ctrl+Z 时派发
 * beforeinput 的 historyUndo 事件（contenteditable 的 div 默认不派发），
 * 使我们的历史栈能接管；同时统一各浏览器的撤销事件行为。
 */
export function a001PrepareEditorForUndo(editor) {
    if (!editor) return;
    if (editor.dataset?.a001UndoVersion === A001_PROMPT_UNDO_VERSION) return;
    editor.setAttribute("data-a001-undo-version", A001_PROMPT_UNDO_VERSION);
    try {
        Object.defineProperty(editor, "type", {
            value: "textarea",
            configurable: true,
        });
    } catch (_e) {
        /* 极端情况下保持原样，不影响其它能力 */
    }
}
