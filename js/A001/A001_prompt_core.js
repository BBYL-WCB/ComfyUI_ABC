/* =============================================================================
 * A001_prompt_core.js —— A001 @文本编辑器 · 常量与纯数据层
 * -----------------------------------------------------------------------------
 * 一、本文件解决什么
 * -----------------------------------------------------------------------------
 * 复刻参考插件（002_MiniMaxH3_Easy参考/web/minimax_h3_easy_ui.js）的 prompt 富
 * 文本编辑器的「与 UI 无关」部分：doc 数据模型、mention 标签规则、DOM 序列化的
 * 纯函数、properties 读写、CSS 注入。上层 A001_prompt_mentions.js /
 * A001_prompt_editor.js 只做 DOM 与交互。
 *
 * 二、数据模型（与参考实现逐字段对齐）
 * -----------------------------------------------------------------------------
 *   doc = {
 *     v: 1,
 *     text: "…最终写回文本控件的字符串（mention 已替换为 <Picture 1> 等）…",
 *     parts: [
 *       { type: "text",    text },
 *       { type: "dialogue", text },
 *       { type: "mention", token, tag, label, fullLabel, mediaType,
 *         referenceMode, ordinal, mediaIndex, sourceId, sourceSlot, previewUrl,
 *         unresolved, pending },
 *     ],
 *     view: "structured" | "raw",
 *   }
 *
 * 三、存储
 * -----------------------------------------------------------------------------
 *   node.properties.a001_prompt_docs = { "<槽名>": doc }
 *   键用「外层提升槽名」而非 widgetId —— widgetId 含 graphId
 *   （[graphId]:[nodeId]:[name]），会话/工作流重载后不保证稳定，落盘必失配。
 *
 * 四、依赖
 * -----------------------------------------------------------------------------
 * 只 import A001_shared.js（依赖图最底层），不 import 任何 A001 私有模块。
 * ========================================================================== */

import { safeCall } from "./A001_shared.js?v=20261007a";
import { injectStyleOnce } from "../A000/A000_DomStyle.js";

/* ── properties 键与视图模式 ── */
export const A001_PROMPT_DOCS_PROP = "a001_prompt_docs";
export const A001_PROMPT_VIEW_STRUCTURED = "structured";
export const A001_PROMPT_VIEW_RAW = "raw";

/* ── DOM 类名 / 标记属性 ── */
export const A001_WRAP_CLASS = "a001-prompt-editor-wrap";
export const A001_EDITOR_CLASS = "a001-prompt-editor";
export const A001_CHIP_CLASS = "a001-mention-chip";
export const A001_CHIP_LABEL_CLASS = "a001-mention-chip-label";
export const A001_CHIP_THUMB_CLASS = "a001-mention-chip-thumb";
export const A001_DIALOGUE_CLASS = "a001-dialogue-block";
export const A001_MENU_CLASS = "a001-mention-menu";
/** 承载行类名：仅用于给它加 position:relative 作为 wrap 的定位上下文。
 *  ★ 该类在 CSS 里**只声明 position**，不得写尺寸/对齐（见高度方案注释）。 */
export const A001_ROW_CLASS = "a001-prompt-row";
/** wrap 上的标记属性：供端口胶囊 MO 识别「编辑器子树」并忽略其变更。 */
export const A001_DOM_ATTR = "data-a001-prompt-editor";
/** wrap 上的槽名标记（多控件并存时用于定位与自检）。
 *  ★ 记在 wrap 上而非承载行上：承载行不能被我们改（见下方隐藏方案注释）。 */
export const A001_SLOT_ATTR = "data-a001-prompt-slot";

/* ── 行为参数 ── */
export const A001_CARET_SENTINEL = "\u200B";
export const A001_PROMPT_HISTORY_LIMIT = 120;
export const A001_PROMPT_UNDO_VERSION = "2026-09-26-a001-prompt-undo-v1";

/* ── 文案（跟随浏览器语言，与参考实现同款策略） ── */
const A001_ZH = (() => {
    const lang = String(
        globalThis.navigator?.language
        || globalThis.navigator?.languages?.[0]
        || ""
    );
    return /^zh(?:[-_]|$)/i.test(lang);
})();

export const A001_LABELS = { image: "图片", video: "视频", audio: "音频" };

export const A001_TEXT = {
    placeholder: A001_ZH ? "输入提示词…（@ 引用素材，# 对话块）" : "Prompt… (@ reference, # dialogue)",
    mentionTitle: A001_ZH ? "引用素材" : "Reference media",
    mentionEmpty: A001_ZH ? "请先把媒体连到本节点的输入口" : "Connect media to this node first",
    pendingTitle: A001_ZH ? "等待连接对应序号的媒体素材" : "Waiting for media with the matching index",
    unresolvedTitle: A001_ZH ? "已断开：请重新连接或删除该引用" : "Disconnected: reconnect or remove this reference",
    viewStructured: A001_ZH ? "结构化视图" : "Structured view",
    viewRaw: A001_ZH ? "原始文本视图" : "Raw text view",
    clearText: A001_ZH ? "清空当前文本框" : "Clear this text box",
    /* ★ 复制按钮的四条反馈文案（编辑器 copyPromptText 引用）。
     *  原缺失：A001_prompt_editor.js L592/1838/1841/1856 引用了 copyText/copyEmpty/copyDone/copyFail，
     *  但本表未定义 → button.title 被写成字符串 "undefined"（必现缺陷）。 */
    copyText: A001_ZH ? "复制提示词" : "Copy prompt",
    copyEmpty: A001_ZH ? "没有可复制的内容" : "Nothing to copy",
    copyDone: A001_ZH ? "已复制" : "Copied",
    copyFail: A001_ZH ? "复制失败" : "Copy failed",
};

/* ════════════════════════════════════════════════
 *  1 · mention 标签规则（序号模式）
 * ════════════════════════════════════════════════ */

/** 由类型 + 序号生成官方媒体标签：<Picture n> / <Video n> / <Audio n>。 */
export function a001PromptMentionTag(type, ordinal) {
    const mediaType = String(type || "image").toLowerCase();
    const index = Number(ordinal);
    if (!Number.isFinite(index) || index <= 0) return "";
    if (mediaType === "image") return `<Picture ${index}>`;
    if (mediaType === "video") return `<Video ${index}>`;
    if (mediaType === "audio") return `<Audio ${index}>`;
    return "";
}

/** 序号模式下 chip 的显示标签：图片1 / 视频2 / 音频1。 */
export function a001PromptMentionLabel(type, ordinal) {
    const index = Number(ordinal);
    if (!Number.isFinite(index) || index <= 0) return "";
    return `${A001_LABELS[type] || type}${index}`;
}

/** 单个 part → 最终 prompt 文本片段。 */
export function a001PromptTextFromPart(part) {
    if (part?.type === "dialogue") return `<d>${String(part.text || "")}</d>`;
    if (part?.type !== "mention") return String(part?.text || "");
    return String(part.tag || part.token || a001PromptMentionTag(part.mediaType, part.ordinal) || "");
}

/** parts → 最终 prompt 文本。 */
export function a001PromptDocTextFromParts(parts) {
    return (Array.isArray(parts) ? parts : []).map((p) => a001PromptTextFromPart(p)).join("");
}

/* ════════════════════════════════════════════════
 *  2 · 文本 → parts（反序列化）
 * ════════════════════════════════════════════════ */

/** @别名前缀（中英并存，与参考实现的 pastedMentionCandidates 别名表同源）。 */
const MENTION_ALIASES = {
    image: ["图片", "Image", "image", "Picture", "picture"],
    video: ["视频", "Video", "video"],
    audio: ["音频", "Audio", "audio"],
};

/** 由别名前缀反查媒体类型；未命中返回 null。 */
function aliasToType(prefix) {
    for (const type of Object.keys(MENTION_ALIASES)) {
        if (MENTION_ALIASES[type].includes(prefix)) return type;
    }
    return null;
}

/**
 * 在 text 的 cursor 处尝试匹配一个「官方媒体标签」。
 * @returns {{raw:string, type:string, ordinal:number}|null}
 */
function matchOfficialTagAt(text, cursor) {
    const rest = String(text || "").slice(cursor);
    const m = rest.match(/^<\s*(picture|video|audio)\s*(\d+)\s*>/i);
    if (!m) return null;
    const type = m[1].toLowerCase() === "picture" ? "image" : m[1].toLowerCase();
    const ordinal = Number(m[2]);
    if (!Number.isFinite(ordinal) || ordinal <= 0) return null;
    return { raw: m[0], type, ordinal };
}

/**
 * 在 text 的 cursor 处尝试匹配一个「@别名」引用（如 @图片1 / @图片 1）。
 * @returns {{raw:string, type:string, ordinal:number}|null}
 */
function matchAliasTokenAt(text, cursor) {
    const rest = String(text || "").slice(cursor);
    const m = rest.match(/^@([A-Za-z\u4e00-\u9fa5]+)\s?(\d+)/);
    if (!m) return null;
    const type = aliasToType(m[1]);
    if (!type) return null;
    const ordinal = Number(m[2]);
    if (!Number.isFinite(ordinal) || ordinal <= 0) return null;
    return { raw: m[0], type, ordinal };
}

/**
 * 文本 → parts。
 *
 * @param {string} value 控件的文本值
 * @param {(type:string, ordinal:number)=>object|null} [resolveMention]
 *        由上层（mentions 模块）提供的「实时候选解析器」。命中则 chip 有缩略图与
 *        sourceId；未命中则标 unresolved/pending（红波浪），与参考实现同语义。
 * @returns {Array<object>} parts
 */
export function a001PromptPartsFromText(value, resolveMention) {
    const text = String(value || "");
    const parts = [];
    const pushText = (chunk) => {
        const next = String(chunk || "");
        if (!next) return;
        if (parts.at(-1)?.type === "text") parts[parts.length - 1].text += next;
        else parts.push({ type: "text", text: next });
    };
    const pushMention = (type, ordinal, raw) => {
        const resolved = safeCall(() => resolveMention?.(type, ordinal) || null, null, "解析素材候选");
        const label = a001PromptMentionLabel(type, ordinal);
        const tag = a001PromptMentionTag(type, ordinal);
        parts.push({
            type: "mention",
            token: resolved?.token || `@${label}`,
            tag: resolved?.tag || tag,
            label: resolved?.label || label,
            fullLabel: resolved?.fullLabel || resolved?.label || label,
            mediaType: type,
            referenceMode: "index",
            ordinal,
            mediaIndex: resolved?.mediaIndex ?? null,
            sourceId: resolved?.sourceId ?? null,
            sourceSlot: resolved?.sourceSlot ?? 0,
            previewUrl: resolved?.previewUrl || "",
            unresolved: !resolved,
            pending: !resolved,
            /* raw 只在粘贴/解析时用于对齐，不落盘（sanitize 会剔除）。 */
            _raw: raw || "",
        });
    };

    let plainStart = 0;
    let cursor = 0;
    while (cursor < text.length) {
        const dialogue = text.slice(cursor).match(/^<d>([\s\S]*?)<\/d>/i);
        if (dialogue) {
            if (plainStart < cursor) pushText(text.slice(plainStart, cursor));
            parts.push({ type: "dialogue", text: dialogue[1] || "" });
            cursor += dialogue[0].length;
            plainStart = cursor;
            continue;
        }
        const hit = matchOfficialTagAt(text, cursor) || matchAliasTokenAt(text, cursor);
        if (hit) {
            if (plainStart < cursor) pushText(text.slice(plainStart, cursor));
            pushMention(hit.type, hit.ordinal, hit.raw);
            cursor += hit.raw.length;
            plainStart = cursor;
            continue;
        }
        cursor += 1;
    }
    if (plainStart < text.length) pushText(text.slice(plainStart));
    return parts;
}

/* ════════════════════════════════════════════════
 *  3 · doc 基础操作
 * ════════════════════════════════════════════════ */

/** 深拷贝一份 doc（去 Vue Proxy / 共享引用）。 */
export function a001ClonePromptDoc(doc) {
    const source = doc && typeof doc === "object" ? doc : {};
    /* ★ parts 拷贝时剔除 `_raw`（解析期临时字段）：它不参与语义内容，
     *  若混入后续 a001PromptDocKey 的 JSON，会让「同一内容」因解析细节差异
     *  被判为「不同」，污染历史去重与变更比对。 */
    const parts = Array.isArray(source.parts)
        ? source.parts.map((p) => {
            if (!p || typeof p !== "object") return p;
            const copy = { ...p };
            delete copy._raw;
            return copy;
        })
        : [];
    return {
        v: 1,
        text: String(source.text || ""),
        parts,
        view: source.view === A001_PROMPT_VIEW_RAW ? A001_PROMPT_VIEW_RAW : A001_PROMPT_VIEW_STRUCTURED,
    };
}

/** doc 的唯一键（历史去重 / 变更比对）。 */
export function a001PromptDocKey(doc) {
    const c = a001ClonePromptDoc(doc);
    /* view 不参与内容比对：切视图不应被当成一次「内容变更」。 */
    return JSON.stringify({ v: c.v, text: c.text, parts: c.parts });
}

/** 构造一个空 doc。 */
export function a001EmptyPromptDoc(view = A001_PROMPT_VIEW_STRUCTURED) {
    return { v: 1, text: "", parts: [], view };
}

/** mention part 落盘白名单（剔除 previewUrl 等易失字段）。 */
function sanitizePart(part) {
    if (part?.type === "dialogue") return { type: "dialogue", text: String(part.text || "") };
    if (part?.type !== "mention") return { type: "text", text: String(part?.text || "") };
    return {
        type: "mention",
        token: String(part.token || ""),
        tag: String(part.tag || ""),
        label: String(part.label || ""),
        fullLabel: String(part.fullLabel || ""),
        mediaType: String(part.mediaType || "image"),
        referenceMode: "index",
        ordinal: Number(part.ordinal) || null,
        sourceId: part.sourceId != null ? Number(part.sourceId) : null,
        sourceSlot: Number(part.sourceSlot) || 0,
    };
}

/**
 * 落盘前的 doc 瘦身。
 *
 * ★ 必须剔除 previewUrl：它是 /view?...&rand=… 形式的一次性地址
 *   （A001_preview.js 注释明确「URL 一律重算，绝不落盘」），落盘既无意义
 *   又会让工作流文件膨胀；恢复时由候选人重新解析。
 */
export function a001SanitizeDocForSave(doc) {
    /* 直接读原 doc 字段 + parts 走白名单：原实现先 a001ClonePromptDoc 再 map(sanitizePart)，
     * parts 被遍历/重建两次（clone 那趟纯属冗余）。 */
    const source = doc && typeof doc === "object" ? doc : {};
    return {
        v: 1,
        text: String(source.text || ""),
        parts: (Array.isArray(source.parts) ? source.parts : []).map(sanitizePart),
        view: source.view === A001_PROMPT_VIEW_RAW ? A001_PROMPT_VIEW_RAW : A001_PROMPT_VIEW_STRUCTURED,
    };
}

/* ════════════════════════════════════════════════
 *  4 · properties 读写（按槽名分桶）
 * ════════════════════════════════════════════════ */

/** 取整个 docs 桶（不存在时返回空对象，不写入）。 */
export function a001PromptDocsBucket(node) {
    const raw = node?.properties?.[A001_PROMPT_DOCS_PROP];
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/** 读某槽的 doc；无存档返回 null。 */
export function a001ReadPromptRecord(node, slotName) {
    const rec = a001PromptDocsBucket(node)[String(slotName)];
    if (!rec || typeof rec !== "object") return null;
    if (!Array.isArray(rec.parts)) return null;
    return a001ClonePromptDoc(rec);
}

/** 写某槽的 doc（自动瘦身）。 */
export function a001WritePromptRecord(node, slotName, doc) {
    if (!node || slotName == null) return false;
    return !!safeCall(() => {
        node.properties = node.properties || {};
        const bucket = Object.assign({}, a001PromptDocsBucket(node));
        bucket[String(slotName)] = a001SanitizeDocForSave(doc);
        node.properties[A001_PROMPT_DOCS_PROP] = bucket;
        return true;
    }, false, "写 prompt doc");
}

/** 删某槽的 doc（反提升 / 节点删除时调用）；桶空则整体清除字段。 */
export function a001DropPromptRecord(node, slotName) {
    if (!node || slotName == null) return false;
    return !!safeCall(() => {
        const props = node.properties;
        if (!props) return false;
        const bucket = Object.assign({}, a001PromptDocsBucket(node));
        if (!(String(slotName) in bucket)) return false;
        delete bucket[String(slotName)];
        if (Object.keys(bucket).length) props[A001_PROMPT_DOCS_PROP] = bucket;
        else delete props[A001_PROMPT_DOCS_PROP];
        return true;
    }, false, "删 prompt doc");
}

/* ════════════════════════════════════════════════
 *  5 · 样式注入
 * -----------------------------------------------------------------------------
 *  类名统一 a001- 前缀；配色全部走 ComfyUI 主题变量 + 兜底，
 *  不硬编码参考插件的 h3 配色变量，避免与本项目其它节点冲突。
 * ════════════════════════════════════════════════ */

const A001_PROMPT_STYLE_ID = "xzg-a001-prompt-editor-style";

export function injectA001PromptCss() {
    injectStyleOnce(A001_PROMPT_STYLE_ID, `
/* ── 外层 wrap：填满所在控件行，自带主题变量 ── */
.${A001_WRAP_CLASS} {
  position: relative;
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  --a001-prompt-bg: var(--component-node-widget-background, var(--comfy-input-bg, #222));
  --a001-prompt-text: var(--component-node-foreground, var(--input-text, #ddd));
  --a001-prompt-muted: var(--component-node-foreground-secondary, var(--muted-foreground, rgba(255,255,255,.42)));
  --a001-prompt-outline: var(--component-node-widget-background-highlighted, var(--border-default, rgba(255,255,255,.16)));
  --a001-prompt-accent: rgba(0, 226, 187, .98);
  --a001-prompt-accent-soft: rgba(0, 226, 187, .14);
  --a001-prompt-size: var(--text-xs, var(--comfy-textarea-font-size, 12px));
  --a001-prompt-radius: var(--radius-lg, 6px);
}

/* ── 官方 textarea：由 JS 逐个 display:none 隐藏（与 054248 已验证版一致） ──
 * ★★ 刻意**不**用行级 CSS 兜底（勿再加回）
 * -----------------------------------------------------------------------------
 *  曾经写过的两条兜底规则都在不同层面帮了倒忙：
 *    · «.lg-node-widget.a001-prompt-row textarea { display:none }»
 *      —— 给承载行打标记后，行本身成了「被我们改过的元素」；
 *    · «.lg-node-widget:has(> .a001-prompt-editor-wrap) textarea»
 *      —— :has() 让浏览器把整行纳入「含 wrap 的行」这条规则的匹配集合，
 *         行的布局计算被卷进编辑器的尺寸依赖里。
 *  两者都会让承载行的高度不再由官方 grid 独立决定，结果就是
 *  **节点高度无法自由伸缩**，或编辑器高度不跟控件。
 *  正解：只对 textarea 元素本身置 display:none（JS 做，见 hideOfficialTextarea），
 *  官方行/grid 完全不受我们的样式影响。 */

/* ── 编辑器外壳（wrap）：靠「贴合官方控件行」实现高度跟随 ──
 * ★★ 高度方案（依据 002 技能《节点富UI前端开发》·「multiline 吃掉剩余高度」铁律）
 * -----------------------------------------------------------------------------
 *  技能原文结论：新版前端（comfyui-frontend-package 1.41+）的 _arrangeWidgets
 *  布局引擎会把**节点体的剩余高度分配给 multiline 文本框**，该控件被拉伸到节点
 *  底部 —— 即「被提升的多行文本控件」的高度是**布局引擎弹出来的**，
 *  既不是固定值，也不是我们能在 JS 里算准的。
 *
 *  故不做测量、不做跟随，而是让编辑器与该控件**共用同一个空间**：
 *    wrap 用 position:absolute; inset:0 贴合「官方控件所在的那条行」，
 *    行高由布局引擎分配 → wrap 随之伸缩 → editor height:100% 撑满 wrap。
 *
 *  ★ 为什么用 absolute + inset:0 而不是 height:100%：
 *    height:100% 需要父级有**确定的**高度值，而承载行的高度由 grid 轨道弹性
 *    分配、未必是可继承的确定值，取不到参照就会退化成内容高度（这正是之前
 *    「编辑器高度不跟控件一致」的成因）。absolute+inset:0 直接以行的 padding
 *    box 为基准四边贴合，**不依赖父级高度是否为确定值**，任何情况下都贴合。
 *    基于同一坐标系的百分比定位也是本项目对比层已验证的做法。
 *
 *  ★ 关键：wrap 绝不写 min-height / max-height。
 *    任何一个值都会给弹性空间设下限，节点被压矮时行压不下去，
 *    表现为「节点高度不能随意变化」。
 *
 *  历史上试过并已推翻的方案（勿再重蹈）：
 *    · JS 测量 textarea 高度 → 写 CSS 变量 （量的是已隐藏元素，不可靠）
 *    · ResizeObserver 观察承载行               （行的变化是布局结果，跟它无意义）
 *    · 给承载行加类名或 :has() 行级 CSS        （行被卷入我们的样式，破坏弹性分配）
 *    · overflow-y:scroll + 自定义滚动条        （整组自定义规则失效，连原生条都没了） */

/* 承载行：**只加定位上下文，不碰任何尺寸**（给 wrap 的 absolute 提供参照）。
 * ★ 切勿在此写 height/min-height/max-height/align-items/display：
 *   行的空间由官方 _arrangeWidgets 弹性分配，插手尺寸就会破坏节点自由伸缩。
 *   position:relative 不影响布局流，只建立包含块，是这里唯一安全的声明。 */
.a001-prompt-row {
  position: relative;
}

.${A001_WRAP_CLASS} {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  /* 光标：文本编辑形状（详见编辑器本体的 cursor 注释）。
   * wrap 覆盖整行，若不声明，行内空白处可能沿用官方行/画布的手形光标。 */
  cursor: text;
}

/* ── 编辑器本体：撑满 wrap，滚动由自身承担 ──
 *  height:100% 承接 wrap 的高度（= 官方控件行高）；
 *  overflow-y:auto 内容超出时由浏览器**原生滚动条**接管（勿加定制，见下）。 */
.${A001_EDITOR_CLASS} {
  display: block;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  /* 底部留 14px：给「编辑器底部横向拖拽条」让位，避免压住最后一行文字。 */
  padding: 6px 8px 14px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  border: 1px solid var(--a001-prompt-outline);
  border-radius: var(--a001-prompt-radius);
  outline: none;
  resize: none;
  /* ★ 光标用「文本编辑」形状（竖线 I-beam），不用手形。
   *  必要性：这是 contenteditable 文本域，手形（pointer / grab）会让人误以为
   *  它是可点击的按钮或可拖拽区域；而 ComfyUI 全局样式 / 画布拖拽逻辑可能给
   *  节点内元素（或其父级行/面板）声明了 pointer / grab，会被继承下来。
   *  故在此显式声明 cursor:text 覆盖继承值（元素自身声明优先级高于继承）。 */
  cursor: text;
  background-color: var(--a001-prompt-bg);
  color: var(--a001-prompt-text);
  caret-color: var(--a001-prompt-text);
  font-family: Consolas, "Courier New", monospace;
  font-size: var(--a001-prompt-size);
  font-weight: 400;
  line-height: 1.4;
  letter-spacing: 0;
}
.${A001_EDITOR_CLASS}:focus { border-color: var(--a001-prompt-outline); box-shadow: 0 0 0 1px var(--a001-prompt-outline); }

/* ── 竖向滚动条：自定义外观（用户选定，勿删） ──
 * 需求：滚动条的轨道背景只在右侧一条，并与编辑器的圆角对齐、不外露方正直角。
 * 做法要点：
 *   · scrollbar 宽度取 10px，滑块用 border:3px transparent + background-clip
 *     content-box 内缩，视觉上滑块纤细、两侧留白，不贴边。
 *   · 轨道自身给 border-radius，并让编辑器 overflow 圆角裁剪（见下 overflow 一行）。
 *   · 关键：给编辑器保留 border-radius 的同时，滚动条会被圆角裁掉直角 ——
 *     这天然实现「贴合编辑器圆角」，无需给轨道单独算半径。
 *
 * ★★ 关于「两套互斥渲染路径」（必读，避免日后误判）
 * -----------------------------------------------------------------------------
 *  浏览器对滚动条有两条互斥的渲染路径，**一旦声明任意 ::-webkit-scrollbar 规则
 *  就切到自定义路径**，系统/主题样式全部失效、外观完全由下面这套接管。
 *  这与「原生滚动条」是二选一，不是叠加 —— 所以本块存在时就是自定义滚动条。
 *  实测证据（浏览器读取运行中的编辑器）：offsetWidth - clientWidth = 12px，
 *  而系统默认约 15-17px，确认处于自定义路径。
 *
 *  ★ 生态权衡（用户已明确选择自定义）：
 *    自定义的代价是外观与 ComfyUI 主题不再统一，换来的是完全可控的宽度/配色/圆角。
 *    收益是「圆角贴合编辑器」由我们显式控制，不依赖浏览器对 border-radius 的裁剪行为。
 *
 *  ★ 只做外观（::-webkit-scrollbar-*），**不改 overflow 行为**：
 *    overflow-y:auto 保持不变 —— 曾把 overflow 改成 scroll + scrollbar-gutter 那次
 *    才是「滚动条彻底消失」的真凶，与自定义滚动条本身无关。 */
.${A001_EDITOR_CLASS}::-webkit-scrollbar {
  width: 10px;
  height: 0;
}
.${A001_EDITOR_CLASS}::-webkit-scrollbar-track {
  /* 轨道背景：右对齐的一条，染得极淡，不抢视觉 */
  background: transparent;
  border-radius: var(--a001-prompt-radius);
  margin: 4px 0;
}
.${A001_EDITOR_CLASS}::-webkit-scrollbar-thumb {
  /* 滑块：3px 透明边框 + content-box 裁切 → 实际可见宽 4px，两侧留白 */
  background: rgba(255, 255, 255, .26);
  background-clip: content-box;
  border: 3px solid transparent;
  border-radius: 999px;
  min-height: 28px;
}
.${A001_EDITOR_CLASS}::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, .42);
  background-clip: content-box;
}
.${A001_EDITOR_CLASS}::-webkit-scrollbar-corner {
  background: transparent;
}

.${A001_EDITOR_CLASS}:empty::before {
  content: attr(data-placeholder);
  color: var(--a001-prompt-muted);
  pointer-events: none;
}
.${A001_EDITOR_CLASS}.is-raw { white-space: pre-wrap; }

/* 滚动补充说明（勿加定制）：只写 overflow-y:auto，交给浏览器**原生滚动条**。
 * 曾改成 overflow-y:scroll + scrollbar-gutter + ::-webkit-scrollbar 自定义轨道/滑块：
 * 一旦给元素加自定义滚动条规则，浏览器即切到「自定义渲染路径」，
 * 此时任一条子规则被全局样式干扰 → 整组规则连同原生滚动条一起失效。 */

/* ── mention chip ── */
.${A001_CHIP_CLASS} {
  display: inline;
  max-width: 150px;
  margin: 0 1px;
  padding: 0;
  vertical-align: baseline;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--a001-prompt-accent);
  font-family: inherit;
  font-size: var(--a001-prompt-size);
  font-weight: 400;
  line-height: inherit;
  user-select: text;
  cursor: text;
}
.${A001_CHIP_CLASS}.is-unresolved {
  color: #ff9b9b;
  text-decoration: underline wavy rgba(255,110,110,.86);
  text-decoration-thickness: 1px;
}
.${A001_CHIP_CLASS}.is-pending { color: var(--a001-prompt-muted); }
.${A001_CHIP_LABEL_CLASS} {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: baseline;
}
.${A001_CHIP_THUMB_CLASS} {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 2px;
  object-fit: cover;
  border-radius: 3px;
  vertical-align: -2px;
  background: rgba(255,255,255,.12);
  user-select: none;
}
.${A001_CHIP_THUMB_CLASS}.is-image { background: #5aa9f0; }
.${A001_CHIP_THUMB_CLASS}.is-video { background: rgba(73,182,255,.55); }
.${A001_CHIP_THUMB_CLASS}.is-audio { background: rgba(0,226,187,.55); }

/* ── 对话块 ── */
.${A001_DIALOGUE_CLASS} {
  display: inline;
  margin: 0 1px;
  padding: 2px 4px;
  vertical-align: 1px;
  border: 0;
  border-radius: 4px;
  background: var(--a001-prompt-accent-soft);
  color: rgba(190,255,244,.98);
  font-family: Consolas, "Courier New", monospace;
  font-size: var(--a001-prompt-size);
  box-shadow: inset 0 0 0 1px rgba(0,226,187,.16);
  line-height: calc(1em + 6px);
  white-space: pre-wrap;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  user-select: text;
  cursor: text;
  outline: none;
}
.${A001_DIALOGUE_CLASS}:focus {
  background: rgba(0,226,187,.19);
  box-shadow: inset 0 0 0 1px rgba(0,226,187,.26);
}

/* ── 工具条（左下角：视图切换） ── */
.${A001_WRAP_CLASS} .a001-prompt-editor-tools {
  position: absolute;
  left: 5px;
  bottom: 5px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 3px;
  pointer-events: auto;
}
.${A001_WRAP_CLASS} .a001-prompt-editor-tool {
  appearance: none;
  display: flex;
  align-items: center;
  justify-content: center;
  /* ★ 图标居中三件套（缺一不可）：
   *  ① flex + center：图标元素水平垂直都落在按钮中心；
   *  ② padding:0 + 固定 18×18：排除内边距导致的整体偏移；
   *  ③ 字体图标用 ::before 渲染字形，其 font-size 决定视觉大小，
   *     不再依赖按钮自身的 font 简写。 */
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid transparent;
  /* 正方形 + 50% 圆角 = 圆形底框（悬浮/激活时呈现）。 */
  border-radius: 50%;
  outline: none;
  background: transparent;
  color: var(--a001-prompt-text);
  opacity: .34;
  cursor: pointer;
  user-select: none;
  transition: opacity .12s ease, background-color .12s ease, border-color .12s ease;
}
/* 图标本体：用 ComfyUI 自带的 PrimeIcons 字体图标（pi pi-*）。
 *  字形由 .pi 的 ::before + primeicons 字体渲染，这里只需定字号与行高，
 *  三个图标同字体同字号 → 天然一致，无需逐个微调。 */
.${A001_WRAP_CLASS} .a001-prompt-editor-tool .pi {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
}
.${A001_WRAP_CLASS} .a001-prompt-editor-tool:hover,
.${A001_WRAP_CLASS} .a001-prompt-editor-tool:focus-visible {
  opacity: .62;
  background: rgba(255,255,255,.045);
  border-color: var(--a001-prompt-outline);
}
.${A001_WRAP_CLASS} .a001-prompt-editor-tool.is-active {
  opacity: .5;
  color: rgba(190,255,244,.88);
  background: rgba(0,226,187,.04);
  border-color: rgba(0,226,187,.12);
}

/* ── 编辑器底部横向拖拽条（替代原右下角手柄） ──
 * ★ 为什么需要自绘：编辑器本体是 contenteditable <div>，浏览器原生 resize
 *   只对 <textarea> 等可替换元素生效，div 上 resize:vertical 无效；
 *   而官方 textarea 已被本编辑器隐藏。故在 wrap 底部放一条横条，
 *   由 JS 承担「拖拽改高」逻辑（见 A001_prompt_editor.js 的 resizer 段）。
 * ★ 用户需求：由「右下角 16×16 手柄」改为「编辑器下方横条」。
 *   横条水平居中、贴编辑器底边；拖拽仍然只改高度（纵向），光标保持 ns-resize。 */
.${A001_WRAP_CLASS} .a001-prompt-resizer {
  position: absolute;
  left: 50%;
  bottom: 3px;
  transform: translateX(-50%);
  z-index: 4;
  /* 宽度取编辑器宽度的 60%（居中 → 左右各留 20% 空隙，随节点宽度自适应）。 */
  width: 60%;
  height: 3px;
  box-sizing: border-box;
  border-radius: 2px;
  background: rgba(255,255,255,.28);
  /* 纵向拖拽光标。 */
  cursor: ns-resize;
  touch-action: none;
  user-select: none;
}
/* 亮色主题：横条用深色，保证可见。 */
html:not(.dark-theme) .${A001_WRAP_CLASS} .a001-prompt-resizer {
  background: rgba(0,0,0,.28);
}
/* 悬停 / 拖拽中：横条提亮，给出操作反馈。 */
.${A001_WRAP_CLASS} .a001-prompt-resizer:hover,
.${A001_WRAP_CLASS} .a001-prompt-resizer.is-dragging {
  background: rgba(0,226,187,.75);
}

/* ── @ 候选菜单（fixed，挂 body，不受节点裁剪） ── */
.${A001_MENU_CLASS} {
  position: fixed;
  z-index: 10080;
  width: 198px;
  min-width: 198px;
  max-width: 198px;
  max-height: 360px;
  overflow: auto;
  padding: 5px;
  border: 1px solid var(--a001-prompt-outline, rgba(255,255,255,.16));
  border-radius: 8px;
  background: var(--component-node-widget-background, var(--comfy-menu-bg, rgba(28,28,28,.98)));
  box-shadow: 0 16px 38px rgba(0,0,0,.42);
  color: var(--component-node-foreground, rgba(255,255,255,.94));
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.${A001_MENU_CLASS} .a001-mention-menu-title {
  padding: 6px 8px 7px;
  color: var(--component-node-foreground-secondary, rgba(255,255,255,.62));
  font-size: 12px;
}
.${A001_MENU_CLASS} .a001-mention-menu-empty {
  padding: 9px 10px;
  color: var(--component-node-foreground-secondary, rgba(255,255,255,.62));
  font-size: 12px;
}
.${A001_MENU_CLASS} .a001-mention-menu-item {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-height: 42px;
  padding: 4px 7px;
  border-radius: 6px;
  cursor: pointer;
}
.${A001_MENU_CLASS} .a001-mention-menu-item.is-active,
.${A001_MENU_CLASS} .a001-mention-menu-item:hover { background: rgba(160,255,178,.15); }
.${A001_MENU_CLASS} .a001-mention-menu-thumb {
  display: block;
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 5px;
  background: rgba(255,255,255,.1);
}
.${A001_MENU_CLASS} .a001-mention-menu-thumb.is-video { background: rgba(73,182,255,.55); }
.${A001_MENU_CLASS} .a001-mention-menu-thumb.is-image { background: #5aa9f0; }
.${A001_MENU_CLASS} .a001-mention-menu-thumb.is-audio { background: rgba(0,226,187,.55); }
.${A001_MENU_CLASS} .a001-mention-menu-main {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
}
.${A001_MENU_CLASS} .a001-mention-menu-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
  color: var(--component-node-foreground-secondary, rgba(255,255,255,.55));
  font-size: 11px;
}
`);
}
