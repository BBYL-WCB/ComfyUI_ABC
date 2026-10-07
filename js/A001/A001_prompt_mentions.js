/* =============================================================================
 * A001_prompt_mentions.js —— A001 @文本编辑器 · 媒体引用与候选菜单
 * -----------------------------------------------------------------------------
 * 一、职责
 * -----------------------------------------------------------------------------
 * 复刻参考实现的「@媒体引用」子系统：
 *   · 候选收集   a001MentionOptions(node)   —— 改为遍历 A001 一跳上游的媒体节点
 *   · 缩略图     a001MentionPreviewUrl(...) —— 复用 A001_preview.js 的 a001MediaUrl
 *                ★ 仅图片有真实缩略图；视频与音频一律用内联 SVG 图标（用户需求）
 *   · chip       make / update / thumb / 状态（pending / unresolved）
 *   · 下拉菜单   open / render / position / choose / close / 键盘导航
 *   · 光标区间   a001GetMentionRange（units 文本流算法，勿改用 cloneContents）
 *   · 粘贴还原   含 <Picture 1> / @图片1 的文本 → chip
 *   · 预览刷新   上游连接或素材变化时重解 chip 与菜单
 *
 * 二、与上层解耦
 * -----------------------------------------------------------------------------
 * 本模块不 import 编辑器 / 历史模块。编辑器把它自己的能力以「回调」形式挂到
 * 编辑器记录 rec 上（rec.syncFromEditor / rec.pushHistory / rec.renderFromDoc），
 * 本模块只调用回调。rec 的字段契约见 A001_prompt_editor.js 头注。
 *
 * 三、候选来源（用户指定）
 * -----------------------------------------------------------------------------
 * A001 节点一跳上游：遍历 node.inputs → link → 上游节点，
 * 按「输入槽类型」判定媒体种类（IMAGE/MASK→image、VIDEO→video、AUDIO→audio），
 * 与 A001_run.js 的 pickOfficialLoader 口径一致（出处 comfy_api _io.py）。
 * 序号按类型分别计数（与后端 <Picture n>/<Video n>/<Audio n> 语义一致）。
 * ========================================================================== */

import { app } from "../../../scripts/app.js";
import { safeCall, getNodeGraph } from "./A001_shared.js?v=20261007a";
import {
    A001_TEXT,
    A001_CHIP_CLASS,
    A001_CHIP_LABEL_CLASS,
    A001_CHIP_THUMB_CLASS,
    A001_DIALOGUE_CLASS,
    A001_MENU_CLASS,
    A001_CARET_SENTINEL,
    a001PromptMentionTag,
    a001PromptMentionLabel,
} from "./A001_prompt_core.js?v=20261007a";
import { a001MediaUrl } from "./A001_preview.js?v=20261007a";
import { linkById, upstreamSlotOutputFile } from "./A001_run.js?v=20261007a";

/* 槽类型 → 媒体种类（与 A001_run.js pickOfficialLoader 同口径）。 */
const MEDIA_BY_SLOT_TYPE = { IMAGE: "image", MASK: "image", VIDEO: "video", AUDIO: "audio" };
const MEDIA_ORDER = { image: 0, video: 1, audio: 2 };

/* 媒体占位图标（内联 SVG，避免额外资源请求）。
 * 视频与音频**共用同一套波形图标**（用户需求：视频和音频一样，只用内联 SVG 波形图标）：
 *   · 音频：绿色波形（同参考实现）；
 *   · 视频：同一个波形，但填充改为视频类型色（蓝色），由 CSS 的 .is-video 类区分。
 * 两者都不做真实缩略图，因此这里恒无网络请求、恒无 dataURL。 */
const MEDIA_ICON_SVG =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E"
    + "%3Crect x='0.5' y='10' width='3' height='4' rx='1.5' fill='%2300e2bb'/%3E"
    + "%3Crect x='5.5' y='7' width='3' height='10' rx='1.5' fill='%2300e2bb'/%3E"
    + "%3Crect x='10.5' y='4' width='3' height='16' rx='1.5' fill='%2300e2bb'/%3E"
    + "%3Crect x='15.5' y='7' width='3' height='10' rx='1.5' fill='%2300e2bb'/%3E"
    + "%3Crect x='20.5' y='10' width='3' height='4' rx='1.5' fill='%2300e2bb'/%3E%3C/svg%3E";

/* ════════════════════════════════════════════════
 *  1 · 上游媒体候选
 * ════════════════════════════════════════════════ */

/** 按 id 取节点（兼容 getNodeById 缺失）。 */
function getNodeById(graph, id) {
    if (!graph || id == null) return null;
    const viaApi = safeCall(() => graph.getNodeById?.(id), undefined, "取上游节点");
    if (viaApi) return viaApi;
    return (graph._nodes || []).find((n) => String(n?.id) === String(id)) || null;
}

/** 节点显示名（菜单副标题）。 */
function sourceLabel(node) {
    return String(node?.title || node?.comfyClass || node?.type || "Media");
}

/** 上游是否为 A001 子图节点。 */
function isA001SubgraphNode(n) {
    if (!n) return false;
    return safeCall(() => n.isSubgraphNode?.() === true, false, "A001 身份判定")
        || String(n.type || "") === "A001_SubgraphNode";
}

/** 解析控件值里的文件描述：支持对象与 "name.png [input]" / "sub/name.png" 两种形态。 */
function parseFileValue(value) {
    if (value && typeof value === "object") {
        const filename = String(value.filename || value.name || "").trim();
        if (!filename) return null;
        return {
            filename,
            subfolder: String(value.subfolder || ""),
            type: String(value.type || "input"),
        };
    }
    const text = String(value || "").trim();
    if (!text || /^data:|^blob:|^https?:/i.test(text)) return null;
    /* ★ 修正原正则死逻辑：原写法 `/^(.*?)(?:\s*\[(input|output|temp)\])?$/` 中，
     *  惰性组 `(.*?)` 会被回溯扩到整串以满足 `$`，导致 m[1] 恒等于全文、m[2] 恒为
     *  undefined —— 于是 "name.png [output]" 被当成路径 "name.png [output]"，
     *  pop() 后 filename 变成 "[output]"、type 恒为 input（缩略图 404）。
     *  改为：先显式剥离结尾的 [type] 后缀，再取路径。 */
    const suffix = text.match(/^(.*?)\s*\[(input|output|temp)\]\s*$/i);
    const pathText = suffix ? suffix[1] : text;
    const typeTag = suffix ? suffix[2].toLowerCase() : null;
    const path = String(pathText || "").replaceAll("\\", "/").replace(/^\/+/, "");
    const segments = path.split("/");
    const filename = segments.pop() || "";
    if (!filename) return null;
    return {
        filename,
        subfolder: segments.join("/"),
        type: typeTag || "input",
    };
}

/** 从上游节点取媒体文件名（复刻参考实现的 sourceFilename：优先匹配控件名，再按扩展名）。 */
function upstreamFilename(node, mediaType) {
    if (!node) return null;
    const preferred = {
        image: ["image", "filename", "file"],
        video: ["video", "file", "filename", "video_file", "videofile"],
        audio: ["audio", "file", "filename", "audio_file", "audiofile"],
    }[mediaType] || ["file", "filename"];
    const preferredSet = new Set(preferred);
    const widgets = Array.isArray(node.widgets) ? node.widgets : [];
    const ordered = [
        ...widgets.filter((w) => preferredSet.has(String(w?.name || "").toLowerCase())),
        ...widgets,
    ];
    const extPattern = /\.(png|jpe?g|webp|gif|bmp|tif|avif|mp4|webm|mov|mkv|avi|m4v|mp3|wav|flac|ogg|m4a)$/i;
    for (const widget of ordered) {
        const name = String(widget?.name || "").toLowerCase();
        const parsed = parseFileValue(widget?.value);
        if (!parsed) continue;
        if (preferredSet.has(name) || extPattern.test(parsed.filename)) return parsed;
    }
    return parseFileValue(node?.properties?.filename || node?.properties?.file || "");
}

/** 判定 URL 是否指向视频。
 *
 *  ★ 分隔符必须同时接受 `?` `#` `&`（实测坑）：
 *    ComfyUI 的 /view 地址形如
 *      /api/view?type=input&filename=ComfyUI_00001_.mp4&subfolder=&rand=0.91…
 *    扩展名后面直接跟 `&`（不是 `?`/`#`）。只认 `[?#]` 会把这类地址误判为
 *    「不是视频」，于是视频地址被当成图片塞进 <img> → 加载失败。
 *
 *  ★ 用途说明（用户需求，勿扩展回「视频抽帧」）：
 *    本函数只用于**把视频地址从「图片候选」里排除**（img.src 与 imgs[].src 两处）。
 *    A001 已**彻底移除视频首帧抽帧**功能：视频与音频一样，只用内联 SVG 波形图标
 *    作为缩略图，不再生成 dataURL、不再建隐藏 <video>、不再异步刷新 chip。 */
function isLikelyVideoUrl(url) {
    return /\.(mp4|webm|mov|mkv|avi|m4v)(?:[?#&].*)?$/i.test(String(url || ""));
}

/**
 * 取候选缩略图 URL。
 * 优先级：上游画布预览图 → 上游控件内的 img → 上游是 A001 时的输出产物
 *        → 上游文件类控件的值；统一经 a001MediaUrl 构造 /view 地址。
 *
 * ★ 视频与音频恒返回 ""（用户需求）：
 *   两者都不做缩略图，改由**内联 SVG 图标**呈现（见 a001MakeMentionThumb）。
 *   A001 不抽视频首帧、不读 <video>.poster —— 视频地址若塞进 <img> 只会加载失败，
 *   故这里直接把 video / audio 归为「无缩略图」。
 *
 * 历史上曾有「视频抽帧」分支（隐藏 <video> + canvas 采样 + dataURL 缓存 + 异步刷新），
 * 已按用户要求**整段删除**，勿再恢复。
 */
function mentionPreviewUrl(srcNode, type, sourceSlot) {
    if (!srcNode || type === "audio" || type === "video") return "";

    if (type === "image") {
        const img = (srcNode.imgs || []).find((it) => it?.src && !isLikelyVideoUrl(it.src));
        if (img?.src) return img.src;
    }
    for (const widget of srcNode.widgets || []) {
        const el = widget?.element;
        const img = el?.matches?.("img") ? el : el?.querySelector?.("img");
        if (img?.src && !isLikelyVideoUrl(img.src)) return img.src;
    }

    if (isA001SubgraphNode(srcNode)) {
        const file = safeCall(
            () => upstreamSlotOutputFile(srcNode, sourceSlot),
            null,
            "取上游 A001 输出产物"
        );
        if (file?.filename) {
            return a001MediaUrl({
                filename: file.filename,
                subfolder: file.subfolder || "",
                type: file.type || "output",
            }) || "";
        }
    }

    const parsed = upstreamFilename(srcNode, type);
    if (parsed) {
        return a001MediaUrl({
            filename: parsed.filename,
            subfolder: parsed.subfolder,
            type: parsed.type || "input",
        }) || "";
    }
    return "";
}

/**
 * 收集本节点可引用的媒体候选（一跳上游）。
 * 顺序：image → video → audio；同类型按输入槽顺序，序号按类型分别计数。
 * @returns {Array<object>}
 */
export function a001MentionOptions(node) {
    const graph = getNodeGraph(node);
    if (!graph) return [];
    const raw = [];
    let index = 0;
    for (const inp of node?.inputs || []) {
        const seq = index++;
        if (inp?.link == null) continue;
        const type = MEDIA_BY_SLOT_TYPE[String(inp.type || "").toUpperCase()];
        if (!type) continue;
        const lk = linkById(graph, inp.link);
        if (!lk || lk.origin_id == null) continue;
        const src = getNodeById(graph, lk.origin_id);
        if (!src) continue;
        raw.push({ type, src, sourceSlot: Number(lk.origin_slot) || 0, seq });
    }
    raw.sort((a, b) => (MEDIA_ORDER[a.type] ?? 9) - (MEDIA_ORDER[b.type] ?? 9) || a.seq - b.seq);

    const counts = { image: 0, video: 0, audio: 0 };
    const list = [];
    for (const item of raw) {
        counts[item.type] += 1;
        const ordinal = counts[item.type];
        const label = a001PromptMentionLabel(item.type, ordinal);
        list.push({
            type: item.type,
            tag: a001PromptMentionTag(item.type, ordinal),
            token: `@${label}`,
            label,
            fullLabel: sourceLabel(item.src),
            ordinal,
            mediaIndex: list.length + 1,
            referenceMode: "index",
            source: sourceLabel(item.src),
            sourceId: Number(item.src.id),
            sourceSlot: item.sourceSlot,
            previewUrl: mentionPreviewUrl(item.src, item.type, item.sourceSlot),
        });
    }
    return list;
}

/**
 * 是否存在可用候选（决定 @ 菜单与占位提示是否启用）。
 *
 * ★ 刻意做成「低成本探测」而非 a001MentionOptions().length > 0：
 *   本函数在每次按键（input / keyup / beforeinput）都会被调用，
 *   若在此构造完整候选（含缩略图 URL、上游反查）会成为输入路径上的热点。
 *   这里只做「有没有连入媒体槽」的判定 —— 足够决定要不要弹菜单。
 */
export function a001CanUseMediaMentions(node) {
    for (const inp of node?.inputs || []) {
        if (inp?.link == null) continue;
        if (MEDIA_BY_SLOT_TYPE[String(inp.type || "").toUpperCase()]) return true;
    }
    return false;
}

/** 候选数组 ↔ 函数适配（供 core 的 partsFromText 使用）。 */
export function a001ResolveMentionFrom(node) {
    return (type, ordinal) => a001MentionOptions(node).find(
        (opt) => opt.type === type && Number(opt.ordinal) === Number(ordinal)
    ) || null;
}

/**
 * 在候选中定位某引用（序号模式：按类型 + 序号）。
 * @returns {object|null}
 */
export function a001FindMentionOption(options, reference) {
    const type = String(reference?.mediaType || reference?.type || "image").toLowerCase();
    const ordinal = Number(reference?.ordinal);
    if (!Number.isFinite(ordinal) || ordinal <= 0) return null;
    return (options || []).find((item) => item.type === type && Number(item.ordinal) === ordinal) || null;
}

/* ════════════════════════════════════════════════
 *  2 · chip DOM
 * ════════════════════════════════════════════════ */

/**
 * 构造缩略图元素。
 *
 * ★ 视频与音频一律用**内联 SVG 图标**（用户需求）：
 *   两者都没有真正的画面缩略图。音频沿用波形图标；视频复用同一个波形图标但打
 *   is-video 类（由 CSS 用类型色区分），保证「没有视频抽帧、也没有 <img> 网络请求」。
 *   图片仍走 previewUrl → <img>，加载失败回退为类型图标。
 */
export function a001MakeMentionThumb(option, menu = false) {
    const className = menu ? "a001-mention-menu-thumb" : A001_CHIP_THUMB_CLASS;
    const type = String(option?.type || "image").toLowerCase();
    /* ★ 视频 / 音频：内联 SVG，恒不发起任何媒体请求、恒无 dataURL。
     *  （历史：视频曾用隐藏 <video> + canvas 抽帧生成 dataURL，已整段删除。） */
    if (type === "audio" || type === "video") {
        const icon = document.createElement("img");
        icon.className = `${className} is-${type}`;
        icon.alt = "";
        icon.draggable = false;
        icon.setAttribute("aria-hidden", "true");
        icon.src = MEDIA_ICON_SVG;
        icon.dataset.a001PreviewUrl = "";
        icon.dataset.a001MediaType = type;
        return icon;
    }
    if (option?.previewUrl) {
        const image = document.createElement("img");
        image.className = className;
        image.alt = "";
        image.draggable = false;
        image.src = option.previewUrl;
        image.dataset.a001PreviewUrl = option.previewUrl;
        image.dataset.a001MediaType = type;
        image.addEventListener("error", () => {
            image.replaceWith(a001MakeMentionThumb({ ...option, previewUrl: "" }, menu));
        }, { once: true });
        return image;
    }
    const icon = document.createElement("span");
    icon.className = `${className} is-${type}`;
    icon.setAttribute("aria-hidden", "true");
    icon.dataset.a001PreviewUrl = "";
    icon.dataset.a001MediaType = type;
    return icon;
}

/** chip 的 title（三态提示文案）。 */
function chipTitle(option) {
    if (option?.pending) return A001_TEXT.pendingTitle;
    if (option?.unresolved) return A001_TEXT.unresolvedTitle;
    return String(option?.fullLabel || option?.label || "");
}

/**
 * 构造 mention chip。
 * contentEditable=false：浏览器不会把插入符落进 chip 内部；
 * pointerdown 上按「点击左右半区」把光标定位到 chip 前/后（与参考实现一致）。
 */
export function a001MakeMentionChip(option) {
    const chip = document.createElement("span");
    chip.className = `${A001_CHIP_CLASS}${option?.pending ? " is-pending" : option?.unresolved ? " is-unresolved" : ""}`;
    chip.contentEditable = "false";
    chip.dataset.token = option?.token || option?.tag || "";
    chip.dataset.tag = option?.tag || option?.token || "";
    chip.dataset.label = option?.label || "";
    chip.dataset.fullLabel = option?.fullLabel || option?.label || "";
    chip.dataset.mediaType = option?.type || "image";
    chip.dataset.referenceMode = "index";
    chip.dataset.ordinal = Number(option?.ordinal) || "";
    chip.dataset.mediaIndex = Number(option?.mediaIndex) || "";
    chip.dataset.sourceId = option?.sourceId != null ? String(option.sourceId) : "";
    chip.dataset.sourceSlot = String(Number(option?.sourceSlot) || 0);
    chip.dataset.previewUrl = option?.previewUrl || "";
    chip.dataset.pendingReference = option?.pending ? "true" : "";
    chip.title = chipTitle(option);

    const label = document.createElement("span");
    label.className = A001_CHIP_LABEL_CLASS;
    label.textContent = `@${option?.label || ""}`;
    chip.append(a001MakeMentionThumb(option), label);

    chip.addEventListener("pointerdown", (event) => {
        if (event.target?.closest?.(`.${A001_CHIP_LABEL_CLASS}`)) return;
        event.preventDefault();
        event.stopPropagation();
        const selection = window.getSelection?.();
        if (!selection) return;
        const rect = chip.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        const range = document.createRange();
        if (before) range.setStartBefore(chip);
        else range.setStartAfter(chip);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    });
    return chip;
}

/** 判定是否为 mention chip 元素。 */
export function a001IsMentionChip(node) {
    return node?.nodeType === Node.ELEMENT_NODE && node.classList?.contains(A001_CHIP_CLASS);
}

/** 用最新候选刷新 chip（断线 → is-unresolved；素材更新 → 缩略图更新）。 */
export function a001UpdateMentionChip(chip, option) {
    if (!chip || !option) return;
    const nextToken = option.token || option.tag || chip.dataset.token || "";
    const nextTag = option.tag || chip.dataset.tag || nextToken;
    const nextLabel = option.label || chip.dataset.label || nextToken;
    const nextFullLabel = option.fullLabel || nextLabel;
    const nextPreviewUrl = option.previewUrl || "";
    chip.classList.toggle("is-pending", Boolean(option.pending));
    chip.classList.toggle("is-unresolved", Boolean(option.unresolved) && !option.pending);
    chip.dataset.token = nextToken;
    chip.dataset.tag = nextTag;
    chip.dataset.label = nextLabel;
    chip.dataset.fullLabel = nextFullLabel;
    chip.dataset.mediaType = option.type || chip.dataset.mediaType || "image";
    chip.dataset.ordinal = Number(option.ordinal) || chip.dataset.ordinal || "";
    chip.dataset.mediaIndex = Number(option.mediaIndex) || chip.dataset.mediaIndex || "";
    chip.dataset.pendingReference = option.pending ? "true" : "";
    if (option.sourceId != null) chip.dataset.sourceId = String(option.sourceId);
    if (option.sourceSlot != null) chip.dataset.sourceSlot = String(Number(option.sourceSlot) || 0);
    chip.dataset.previewUrl = nextPreviewUrl;
    chip.title = chipTitle(option);

    const label = chip.querySelector?.(`.${A001_CHIP_LABEL_CLASS}`);
    if (label) label.textContent = `@${nextLabel}`;
    const thumb = chip.querySelector?.(`.${A001_CHIP_THUMB_CLASS}`);
    const wantType = option.type || "image";
    if (thumb && (thumb.dataset?.a001PreviewUrl !== nextPreviewUrl || thumb.dataset?.a001MediaType !== wantType)) {
        const replacement = a001MakeMentionThumb(option);
        thumb.replaceWith(replacement);
    } else if (!thumb) {
        chip.prepend(a001MakeMentionThumb(option));
    }
}

/* ════════════════════════════════════════════════
 *  3 · @ 查询区间（units 文本流算法）
 * ════════════════════════════════════════════════ */

/**
 * 计算光标处的 @ 查询区间。
 *
 * ★ 必须用「可编辑文本流」算法，**不能**用 cloneContents().textContent：
 *   chip 是 contentEditable=false 元素，其可见文本也含 "@"，用后者会让
 *   「在已有 chip 之后输入普通字符」被误判成正在输入 @ 查询。
 *   故把 chip / 对话块 / <br> 一律视作硬边界，只扫描纯文本节点。
 *
 * @returns {{range: Range, query: string}|null}
 */
export function a001GetMentionRange(editor) {
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;
    const caret = selection.getRangeAt(0);
    if (!editor.contains(caret.startContainer)) return null;
    if (caret.startContainer.parentElement?.closest?.(`.${A001_DIALOGUE_CLASS}`)) return null;

    const units = [];
    const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.parentElement?.closest?.(`.${A001_CHIP_CLASS}`)) units.push({ kind: "text", node });
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.classList?.contains(A001_DIALOGUE_CLASS)) {
            units.push({ kind: "dialogue", node });
            return;
        }
        if (node.classList?.contains(A001_CHIP_CLASS)) {
            units.push({ kind: "chip", node });
            return;
        }
        if (node.tagName === "BR") {
            units.push({ kind: "break", node });
            return;
        }
        for (const child of node.childNodes || []) visit(child);
    };
    visit(editor);

    if (caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const currentIndex = units.findIndex((u) => u.kind === "text" && u.node === caret.startContainer);
    if (currentIndex < 0) return null;

    const selected = [];
    for (let i = currentIndex; i >= 0; i -= 1) {
        const unit = units[i];
        if (unit.kind !== "text") break;
        const end = i === currentIndex ? caret.startOffset : (unit.node.textContent || "").length;
        selected.unshift({ unit, text: (unit.node.textContent || "").slice(0, end) });
    }
    const before = selected.map((e) => e.text).join("");
    const match = before.match(/@[^@\n]*$/);
    if (!match) return null;

    const targetStart = before.length - match[0].length;
    let offset = 0;
    const range = document.createRange();
    for (const entry of selected) {
        const next = offset + entry.text.length;
        if (targetStart <= next) {
            range.setStart(entry.unit.node, Math.max(0, targetStart - offset));
            break;
        }
        offset = next;
    }
    range.setEnd(caret.startContainer, caret.startOffset);
    return { range, query: match[0].slice(1) };
}

/* ════════════════════════════════════════════════
 *  4 · 下拉菜单
 * ════════════════════════════════════════════════ */

/** 关闭并销毁菜单（rec 级）。 */
export function a001CloseMentionMenu(rec) {
    rec?.menu?.element?.remove?.();
    if (rec) rec.menu = null;
}

/** 按光标位置摆放菜单（fixed 定位；越界自动翻转 / 收边）。 */
function positionMentionMenu(element, editor) {
    const selection = window.getSelection?.();
    const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    const editorRect = editor.getBoundingClientRect();
    const rect = caret && (caret.width || caret.height) ? caret : editorRect;
    const width = Math.min(280, Math.max(198, element.offsetWidth || 198));
    const height = Math.min(360, element.offsetHeight || 120);
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    element.style.left = `${Math.max(8, Math.round(left))}px`;
    element.style.top = `${Math.max(8, Math.round(top))}px`;
}

/** 渲染菜单内容（标题 / 空态 / 候选项）。 */
export function a001RenderMentionMenu(rec) {
    const state = rec?.menu;
    if (!state) return;
    const { element, options, activeIndex } = state;
    element.textContent = "";

    const title = document.createElement("div");
    title.className = "a001-mention-menu-title";
    title.textContent = A001_TEXT.mentionTitle;
    element.append(title);

    if (!options.length) {
        const empty = document.createElement("div");
        empty.className = "a001-mention-menu-empty";
        empty.textContent = A001_TEXT.mentionEmpty;
        element.append(empty);
        return;
    }
    options.forEach((option, index) => {
        const item = document.createElement("div");
        item.className = `a001-mention-menu-item${index === activeIndex ? " is-active" : ""}`;
        const main = document.createElement("div");
        main.className = "a001-mention-menu-main";
        main.textContent = option.label;
        main.title = option.fullLabel || option.label || "";
        const detail = document.createElement("div");
        detail.className = "a001-mention-menu-detail";
        detail.textContent = option.source;
        const text = document.createElement("div");
        text.append(main, detail);
        item.append(a001MakeMentionThumb(option, true), text);
        item.addEventListener("pointermove", () => {
            if (!rec.menu || rec.menu.activeIndex === index) return;
            rec.menu.activeIndex = index;
            /* ★ 只切换 .is-active 类，**不重建整份列表**：
             *   原实现调用 a001RenderMentionMenu，而该函数会 textContent="" 清空、
             *   逐项重建 DOM 并重新绑定每项的 pointermove/pointerdown 监听 ——
             *   鼠标划过候选项即反复全量重建，是下拉菜单卡顿的主因。
             *   重建后的可见结果就是「仅 activeIndex 项带 is-active」，故切类等价。
             *   结构：element.children[0] 是标题，其后依次是各候选项。 */
            const children = element.children;
            for (let i = 0; i < options.length; i++) {
                const el = children[i + 1];
                if (el?.classList) el.classList.toggle("is-active", i === index);
            }
        });
        item.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            a001ChooseMention(rec, option);
        });
        element.append(item);
    });
}

/** 打开（或就地刷新）菜单。 */
export function a001OpenMentionMenu(rec) {
    const editor = rec?.editor;
    if (!editor || !a001CanUseMediaMentions(rec.node)) {
        a001CloseMentionMenu(rec);
        return false;
    }
    const mention = a001GetMentionRange(editor);
    if (!mention) {
        a001CloseMentionMenu(rec);
        return false;
    }
    const query = mention.query.toLowerCase();
    const options = a001MentionOptions(rec.node).filter(
        (option) => !query
            || `${option.label} ${option.fullLabel || ""} ${option.source}`.toLowerCase().includes(query)
    );
    const existing = rec.menu;
    if (existing) {
        existing.mention = mention;
        existing.options = options;
        existing.activeIndex = Math.min(existing.activeIndex, Math.max(0, options.length - 1));
        a001RenderMentionMenu(rec);
        positionMentionMenu(existing.element, editor);
        return true;
    }
    const element = document.createElement("div");
    element.className = A001_MENU_CLASS;
    document.body.append(element);
    rec.menu = { element, mention, options, activeIndex: 0 };
    a001RenderMentionMenu(rec);
    positionMentionMenu(element, editor);
    return true;
}

/** 光标移动后同步菜单（无 @ 区间则关闭）。 */
export function a001SyncMentionMenuToCaret(rec) {
    const editor = rec?.editor;
    if (!editor || !a001CanUseMediaMentions(rec.node) || !a001GetMentionRange(editor)) {
        a001CloseMentionMenu(rec);
        return false;
    }
    return a001OpenMentionMenu(rec);
}

/** 选中候选项：替换 @ 查询区间为 chip（前后各补一个光标哨兵）。 */
export function a001ChooseMention(rec, option) {
    const state = rec?.menu;
    const range = state?.mention?.range;
    const editor = rec?.editor;
    if (!range || !editor) return;
    range.deleteContents();
    const before = document.createTextNode(A001_CARET_SENTINEL);
    const chip = a001MakeMentionChip(option);
    const after = document.createTextNode(A001_CARET_SENTINEL);
    const fragment = document.createDocumentFragment();
    fragment.append(before, chip, after);
    range.insertNode(fragment);

    const selection = window.getSelection?.();
    if (selection) {
        const caret = document.createRange();
        caret.setStart(after, after.textContent.length);
        caret.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caret);
    }
    a001CloseMentionMenu(rec);
    safeCall(() => rec.syncFromEditor?.(), undefined, "菜单选后同步");
    safeCall(() => rec.pushHistory?.(), undefined, "菜单选后历史");
    editor.focus();
}

/** 菜单键盘导航：Esc / ↑↓ / Enter / Tab。返回是否已消费事件。 */
export function a001HandleMentionMenuKeydown(rec, event) {
    const state = rec?.menu;
    if (!state) return false;
    if (event.key === "Escape") {
        a001CloseMentionMenu(rec);
        return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (state.options.length) {
            const delta = event.key === "ArrowDown" ? 1 : -1;
            state.activeIndex = (state.activeIndex + delta + state.options.length) % state.options.length;
            a001RenderMentionMenu(rec);
            state.element.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest" });
        }
        return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
        const option = state.options[state.activeIndex];
        if (option) a001ChooseMention(rec, option);
        return Boolean(option);
    }
    return false;
}

/* ════════════════════════════════════════════════
 *  5 · 粘贴还原（文本里的 <Picture 1> / @图片1 → chip）
 * ════════════════════════════════════════════════ */

/** 候选的文本别名表（供粘贴时识别）。 */
export function a001PastedMentionCandidates(node) {
    if (!a001CanUseMediaMentions(node)) return [];
    const aliases = {
        image: ["图片", "Image", "image", "Picture", "picture"],
        video: ["视频", "Video", "video"],
        audio: ["音频", "Audio", "audio"],
    };
    const candidates = [];
    const seen = new Set();
    for (const option of a001MentionOptions(node)) {
        const set = new Set();
        if (option.fullLabel) set.add(`@${option.fullLabel}`);
        if (option.token) set.add(option.token);
        for (const prefix of aliases[option.type] || []) {
            set.add(`@${prefix}${option.ordinal}`);
            set.add(`@${prefix} ${option.ordinal}`);
        }
        for (const raw of set) {
            const value = String(raw || "");
            const key = value.toLocaleLowerCase();
            if (!value || seen.has(key)) continue;
            seen.add(key);
            candidates.push({ raw: value, option });
        }
    }
    return candidates.sort((a, b) => b.raw.length - a.raw.length);
}

/** 在 value 的 cursor 处匹配官方媒体标签，返回可插入的候选（未连素材则标 pending）。 */
export function a001OfficialMediaTagMatchAt(node, value, cursor) {
    if (!a001CanUseMediaMentions(node)) return null;
    const match = String(value || "").slice(cursor).match(/^<\s*(picture|video|audio)\s*(\d+)\s*>/i);
    if (!match) return null;
    const type = match[1].toLowerCase() === "picture" ? "image" : match[1].toLowerCase();
    const ordinal = Number(match[2]);
    if (!Number.isFinite(ordinal) || ordinal <= 0) return null;
    const resolved = a001MentionOptions(node).find(
        (option) => option.type === type && Number(option.ordinal) === ordinal
    );
    const label = a001PromptMentionLabel(type, ordinal);
    return {
        raw: match[0],
        option: resolved || {
            type,
            tag: a001PromptMentionTag(type, ordinal),
            token: `@${label}`,
            label,
            fullLabel: label,
            ordinal,
            referenceMode: "index",
            sourceId: null,
            sourceSlot: 0,
            previewUrl: "",
            unresolved: true,
            pending: true,
        },
    };
}

/** 往 fragment 追加带换行的纯文本，返回最后一个追加的节点。 */
function appendPastedText(fragment, text) {
    let last = null;
    String(text || "").split("\n").forEach((part, index) => {
        if (index) {
            last = document.createElement("br");
            fragment.append(last);
        }
        if (part) {
            last = document.createTextNode(part);
            fragment.append(last);
        }
    });
    return last;
}

/**
 * 把含引用标记的粘贴文本插入编辑器：命中候选/官方标签的片段转成 chip。
 * @returns {boolean} 是否插入
 */
export function a001InsertTextWithMentionChips(rec, text) {
    const editor = rec?.editor;
    const node = rec?.node;
    const selection = window.getSelection?.();
    if (!editor || !selection || !selection.rangeCount || !editor.contains(selection.anchorNode)) return false;
    const value = String(text || "");
    if (!value) return false;
    const range = selection.getRangeAt(0);
    const candidates = a001PastedMentionCandidates(node);
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    let plainStart = 0;
    let cursor = 0;
    while (cursor < value.length) {
        const match = a001OfficialMediaTagMatchAt(node, value, cursor)
            || candidates.find(
                (c) => value.slice(cursor, cursor + c.raw.length).toLocaleLowerCase() === c.raw.toLocaleLowerCase()
            );
        if (!match) {
            cursor += 1;
            continue;
        }
        if (plainStart < cursor) appendPastedText(fragment, value.slice(plainStart, cursor));
        fragment.append(document.createTextNode(A001_CARET_SENTINEL));
        fragment.append(a001MakeMentionChip(match.option));
        fragment.append(document.createTextNode(A001_CARET_SENTINEL));
        cursor += match.raw.length;
        plainStart = cursor;
    }
    if (plainStart < value.length) appendPastedText(fragment, value.slice(plainStart));
    const caretMarker = document.createTextNode(A001_CARET_SENTINEL);
    fragment.append(caretMarker);
    range.insertNode(fragment);

    const caret = document.createRange();
    caret.setStart(caretMarker, caretMarker.textContent.length);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    return true;
}

/* ════════════════════════════════════════════════
 *  6 · 预览刷新（上游连接 / 素材变化）
 * ════════════════════════════════════════════════ */

/** 遍历某节点全部编辑器记录，重解 chip 与菜单。 */
export function a001RefreshMentionPreviews(node) {
    const recs = node?._a001PromptEditors;
    if (!recs?.size) return false;
    const options = a001MentionOptions(node);
    for (const rec of recs.values()) {
        const editor = rec?.editor;
        if (!editor) continue;
        for (const chip of editor.querySelectorAll?.(`.${A001_CHIP_CLASS}`) || []) {
            const ordinal = Number(chip.dataset.ordinal) || null;
            const option = a001FindMentionOption(options, {
                mediaType: chip.dataset.mediaType || "image",
                ordinal,
            });
            a001UpdateMentionChip(chip, option || {
                type: chip.dataset.mediaType || "image",
                token: chip.dataset.token || "",
                label: chip.dataset.label || chip.dataset.fullLabel || "",
                fullLabel: chip.dataset.fullLabel || chip.dataset.label || "",
                referenceMode: "index",
                ordinal,
                sourceId: null,
                sourceSlot: 0,
                previewUrl: "",
                unresolved: true,
                pending: ordinal != null,
            });
        }
        safeCall(() => rec.syncFromEditor?.(false), undefined, "刷新后同步编辑器");
        const menu = rec.menu;
        if (menu) {
            const query = String(menu.mention?.query || "").toLowerCase();
            menu.options = options.filter(
                (option) => !query
                    || `${option.label} ${option.fullLabel || ""} ${option.source}`.toLowerCase().includes(query)
            );
            menu.activeIndex = Math.min(menu.activeIndex, Math.max(0, menu.options.length - 1));
            a001RenderMentionMenu(rec);
        }
    }
    return true;
}

/** 全局去抖刷新（多处可并发触发，合并成一次）。 */
let a001MentionRefreshTimer = null;
export function a001RequestMentionRefresh(node) {
    if (a001MentionRefreshTimer) return;
    a001MentionRefreshTimer = setTimeout(() => {
        a001MentionRefreshTimer = null;
        safeCall(() => {
            if (node && node._a001PromptEditors?.size) {
                a001RefreshMentionPreviews(node);
                return;
            }
            /* 未指定节点（上游素材变化）→ 刷新画布上所有挂有编辑器的节点。 */
            for (const n of app?.graph?._nodes || []) {
                if (n?._a001PromptEditors?.size) a001RefreshMentionPreviews(n);
            }
        }, undefined, "刷新媒体引用预览");
    }, 0);
}

/* ── 监听「媒体源节点」的素材变化（复刻参考实现 watchMediaSourceNode） ──
 *
 * ★★ 为什么必须单独装（实测根因，勿删）
 * -----------------------------------------------------------------------------
 *  症状：在上游（如 LoadImage）换了图片后，编辑器里 @ 引用的**缩略图不更新**。
 *  根因：本模块原先的刷新只有两个触发点 ——
 *    ① onConnectionsChange（**连线**变化）
 *    ② 运行结束的预览刷新
 *  而「换个图片」既不改连线、也未运行 → 两个触发点都不命中 → 永不刷新。
 *
 *  修法：给媒体源节点（LoadImage / LoadVideo / LoadAudio 等）装上值变化监听：
 *    · 包装其每个 widget 的 callback（画布侧选文件走这条）
 *    · 监听其控件元素（inputEl / element）的 change / input 事件（DOM 侧走这条）
 *  任一变化 → a001RequestMentionRefresh()（不传节点 = 刷新全图所有编辑器）。
 */

/** 媒体源节点名筛选（与参考实现同口径：按节点名小写包含关系）。 */
function isA001MediaSourceName(name) {
    const n = String(name || "").toLowerCase();
    return n.includes("loadimage") || n.includes("loadvideo") || n.includes("loadaudio");
}

/** 为单个媒体源节点装上素材变化监听（幂等）。 */
export function a001WatchMediaSourceNode(node) {
    if (!node) return;
    /* ★ 双触发（实测需要）：
     *  ① 立即触发一次 —— 覆盖「控件值已先行更新」的常规路径；
     *  ② 60ms 后再触发一次 —— 给 ComfyUI 内部（预览重建 / 值回写）留同步窗口，
     *     避免刷新时读到尚未更新的中间态。
     *  两次都走 a001RequestMentionRefresh，其自身有去抖，不会重复计算。 */
    const trigger = () => {
        a001RequestMentionRefresh();
        setTimeout(() => a001RequestMentionRefresh(), 60);
    };
    for (const widget of node.widgets || []) {
        if (!widget || widget._a001MediaSourceWatched) continue;
        widget._a001MediaSourceWatched = true;
        /* ① 画布侧选文件：包装 widget.callback（保留原回调，链式调用）。 */
        const original = widget.callback;
        widget.callback = function a001MediaSourceWidgetChange() {
            const result = safeCall(() => original?.apply(this, arguments), undefined, "媒体源原回调");
            trigger();
            return result;
        };
        /* ② DOM 侧改值：监听控件元素的 change / input（捕获阶段，避免被上游拦截）。 */
        const element = widget.inputEl || widget.element;
        if (element?.addEventListener) {
            element.addEventListener("change", trigger, true);
            element.addEventListener("input", trigger, true);
        }
    }
}

/**
 * 对每个注册的节点类型安装媒体源监听（内部按名字筛选，非媒体源直接返回）。
 * 需在 beforeRegisterNodeDef 里对**所有**节点类型调用（与参考实现一致）。
 */
export function a001InstallMediaSourceWatch(nodeType, nodeData) {
    if (!nodeType || !isA001MediaSourceName(nodeData?.name)) return;
    if (nodeType.prototype._a001MediaSourceInstalled) return;
    nodeType.prototype._a001MediaSourceInstalled = true;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function a001MediaSourceOnCreated() {
        const result = originalCreated?.apply(this, arguments);
        safeCall(() => a001WatchMediaSourceNode(this), undefined, "媒体源节点建立监听");
        return result;
    };
    /* 反序列化（打开工作流）后也要装：此刻控件与初始值才就位。 */
    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function a001MediaSourceOnConfigure(info) {
        const result = originalConfigure?.apply(this, arguments);
        safeCall(() => a001WatchMediaSourceNode(this), undefined, "媒体源节点建立监听(configure)");
        /* 载入即刷新一次：保证 @ chip 首次渲染就带上正确缩略图。 */
        a001RequestMentionRefresh();
        return result;
    };
}

/* 注：原 export default { ... } 已删除——全仓无任何 default 导入方
 * （消费方 A001_prompt_editor.js / A001_link_badge.js 均用具名导入），属死导出面。 */
