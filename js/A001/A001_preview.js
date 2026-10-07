// ═══════════════════════════════════════════════════════════════
//  A001_子图节点 · 预览框（子图执行结果 → 多类型渲染）
//
//  职责：把「本节点子图内部节点」的执行产物，渲染到 A001 面板上方的预览框
//  （.xzg-a001-preview）里。支持 图片 / 视频 / 音频 / 文本 四种类型。
//
//  ── 数据来源（不改后端）────────────────────────────────────────
//  ComfyUI 执行引擎把子图展开后，内层节点的执行结果照常通过 executed 事件
//  广播，其 detail.node 形如 "外层节点id:内层节点id"。
//  判定口径与 A005 / A006 完全一致（实测结论，见 js/A005/A005_exec.js 与
//  js/A006/A006_exec.js 的 installPreviewRefresh：先按 ":" 切出外层 id 前缀
//  快速过滤，避免每次事件都遍历全部节点做重解析）。
//
//  ── 类型判定 ──────────────────────────────────────────────────
//  按产物【字段名】判定而非节点类型（同一节点可能多产物，字段判据更稳）：
//    images → image ；gifs/videos → video ；audio → audio ；text → text
//  对应 ComfyTV 的 previewKindOf()（把 images / image 合并为 image）语义。
//
//  ── 取址 ──────────────────────────────────────────────────────
//  走官方 /view 路由（api.apiURL），与 A005_shared.imageDataToUrl /
//  A006_shared.videoDataToUrl 同款参数，不自造后端代理。
//
//  ── 渲染 ──────────────────────────────────────────────────────
//  纯原生 DOM（A001 无 Vue 运行时），逐类型对应 ComfyTV MediaPreviewV2.vue 的
//  kind 分支语义。宿主元素由 A001_Appearance.js 负责创建与嵌进预览框，
//  本模块只做内容填充与释放，不参与面板挂载/重挂（那部分归 Appearance）。
// ═══════════════════════════════════════════════════════════════

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { alog, safeCall, isNodeInGraph, getSgNodes } from "./A001_shared.js?v=20261007a";
/* 对比层（图像 / 视频双源滑块对比）：独立模块，单向依赖 A001_shared，
 * 不反向 import 本模块（对比所需 URL 由本模块在数据层算好后传入，杜绝循环依赖）。 */
import {
    buildA001CompareLayer,
    disposeA001Compare,
} from "./A001_compare.js?v=20261007a";

/** 预览内容的配色（对齐 ComfyTV 的 .v2-mp__hint 观感）。 */
export const A001_PREVIEW = {
    HINT_FG: "#666666",
    HINT_FONT_SIZE: 12,
    TEXT_FG: "#dddddd",
    TEXT_FONT_SIZE: 12,
    TEXT_BG: "#111111",
    /** 视频预览的默认音量（0-1）：仅在首次创建视频元素时应用；
     *  用户调节后记入 node._a001Volume，重建时沿用记忆值，不再回到此默认。 */
    DEFAULT_VOLUME: 0.3,
};

/** 每种类型对应的预览元素 data-kind（供 CSS / 调试识别）。
 *  图片 / 视频 / 音频统一底色 #171717，与节点面板观感一致。 */
const KIND_HOST_STYLE = {
    image: { background: "#171717" },
    video: { background: "#171717" },
    audio: { background: "#171717" },
    text: { background: A001_PREVIEW.TEXT_BG },
};

/* ─── 官方 LiteGraph 节点模式常量（与 A001_run.js 同款定义，不重造） ─── */
/** LiteGraph.NEVER(2)：静音/忽略节点，不参与执行。 */
const LG_MODE_NEVER = 2;
/** LiteGraph.BYPASS(4)：旁路节点（透传）。 */
const LG_MODE_BYPASS = 4;

/**
 * 判定某内层节点当前是否处于「被忽略 / 旁路」状态。
 *
 * ★ 为什么预览必须关心这个（用户实测回归）：
 *   用户在子图里把「图片工作流」整体设为忽略（mode=NEVER），再在其输出插槽下方
 *   新增一个视频输出插槽接入视频节点。图片节点并未被删除，仍留在子图里，
 *   故 pruneA001Assets（按「节点是否还在子图」清理）不会清掉它的旧产物；
 *   而 resolveA001SlotOutputs 原本只看累积表里有没有这项，不看源节点还能不能跑，
 *   于是「第 1 个槽（图片）优先」的规则让旧图片永远压住下面的视频 —— 视频/音频
 *   切不上去。修复口径（用户指定）：源节点被忽略则该槽跳过，且不展示其旧产物。
 */
function isInnerNodeIgnored(sg, feedId) {
    const list = getSgNodes(sg);
    const n = list.find((x) => String(x?.id) === String(feedId));
    if (!n) return false;   // 找不到节点（如容器自身广播）→ 不当作忽略
    const mode = Number(n.mode);
    return mode === LG_MODE_NEVER || mode === LG_MODE_BYPASS;
}

/* ══════════════════════════════════════════════
 *  类型判定 / 取址
 * ══════════════════════════════════════════════ */

/** 由文件名后缀判定媒体类型；无法识别返回 null。
 *  ★ 为什么必须靠后缀：官方 SaveImage 保存视频/GIF 时，
 *    产物依旧塞在 ui["images"] 里，只额外加 `ui["animated"] = (True,)` 标记，
 *    根本不存在 ui.videos / ui.gifs 字段。
 *    出处：comfy_extras/nodes_images.py 第 1859-1862 行
 *        ui = {"images": results}
 *        if animated and len(images) > 1:
 *            ui["animated"] = (True,)
 *    若只看字段名，mp4 会被 images 抢先判成 image → 丢进 <img> → 浏览器无法渲染 → 空白。 */
const EXT_IMAGE = new Set(["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "avif"]);
const EXT_VIDEO = new Set(["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv", "gif", "apng"]);
const EXT_AUDIO = new Set(["flac", "mp3", "wav", "ogg", "m4a", "opus", "aac"]);

/** 文本预览落盘的最大字符数（防工作流文件被运行产物撑大）。 */
const A001_PREVIEW_TEXT_LIMIT = 8192;

function a001KindByFilename(data) {
    const name = data?.filename;
    if (typeof name !== "string" || !name) return null;
    const dot = name.lastIndexOf(".");
    if (dot < 0) return null;
    const ext = name.slice(dot + 1).toLowerCase();
    if (EXT_VIDEO.has(ext)) return "video";
    if (EXT_AUDIO.has(ext)) return "audio";
    if (EXT_IMAGE.has(ext)) return "image";
    return null;
}

/** 由执行产物字段判定预览类型；无法识别返回 null。
 *  判定顺序：① 扩展名消歧（最可靠）→ ② 字段名。
 *  扩展名优先的原因见 a001KindByFilename 注释。 */
export function a001KindOfOutput(output) {
    if (!output || typeof output !== "object") return null;
    /* ① 扩展名优先：逐类取首个元素的文件名后缀判定，可正确识别
     *    「视频藏在 images 字段里」这一官方行为。
     * ② 音频单独提前判定：audio 字段与 images 不冲突，若与 images 同时存在，
     *    原实现「先到先得」会让音频被 images 抢先而静默丢失。 */
    const audioByExt = Array.isArray(output.audio) && output.audio.length
        ? a001KindByFilename(output.audio[0])
        : null;
    if (audioByExt) return audioByExt;
    const candidates = [
        [output.images, "image"],
        [output.gifs, "video"],
        [output.videos, "video"],
        [output.audio, "audio"],
    ];
    for (const [arr, fallbackKind] of candidates) {
        if (!Array.isArray(arr) || !arr.length) continue;
        const byExt = a001KindByFilename(arr[0]);
        if (byExt) return byExt;
        return fallbackKind;
    }
    if (Array.isArray(output.text) && output.text.length) return "text";
    return null;
}

/** 取该类型对应的首个产物数据对象。
 *  ★ 视频要额外查 images 字段：官方把 mp4/webm/gif 也塞在 ui["images"] 里，
 *    故 video 类型的数据源是 gifs || videos || images（与 A006_exec.js
 *    的 _extractOutputVideos 兜底顺序一致）。 */
function a001FirstItemOf(output, kind) {
    const pick = (v) => (Array.isArray(v) && v.length ? v[0] : null);
    switch (kind) {
        case "image": return pick(output.images);
        case "video": return pick(output.gifs) || pick(output.videos) || pick(output.images);
        case "audio": return pick(output.audio);
        case "text": return pick(output.text);
        default: return null;
    }
}

/**
 * 由后端产物数据构造 /view URL（官方路由，图片/视频/音频统一可访问）。
 * 与 A005_shared.imageDataToUrl / A006_shared.videoDataToUrl 同款参数形态。
 */
export function a001MediaUrl(data) {
    if (!data) return null;
    return safeCall(
        () => api.apiURL(
            `/view?filename=${encodeURIComponent(data.filename)}` +
            `&type=${encodeURIComponent(data.type || "output")}` +
            `&subfolder=${encodeURIComponent(data.subfolder || "")}` +
            `${app.getPreviewFormatParam?.() ?? ""}${app.getRandParam?.() ?? ""}`
        ),
        null,
        "构造 /view 地址"
    );
}

/* ══════════════════════════════════════════════
 *  渲染层（纯 DOM）
 * ══════════════════════════════════════════════ */

/** 取本节点的预览宿主元素（由 A001_Appearance.js 创建并内嵌在 .xzg-a001-preview 里）。 */
function previewHost(node) {
    const host = node?._a001PreviewHost;
    return host?.isConnected ? host : null;
}

/** 清空宿主内容并返回它；同时复位占位提示的显隐。 */
function clearPreviewHost(host) {
    while (host.firstChild) host.removeChild(host.firstChild);
    host.dataset.kind = "";
    host.style.background = "";
    /* ★ 复位指针态：对比层在「有对比」时会把宿主设为 pointer-events:auto /
     *  cursor:crosshair，从「有对比」变为「无内容」时若不复位，宿主仍会吞掉
     *  指针事件（阻碍节点拖拽起始）。 */
    host.style.pointerEvents = "";
    host.style.cursor = "";
    host._a001CmpSig = undefined;
}

/** 渲染占位提示（无内容时）。 */
function renderHint(host, node) {
    const hint = node._a001PreviewHint;
    if (hint?.isConnected && hint.parentElement === host) return;
    const el = document.createElement("div");
    el.className = "xzg-a001-mp-hint";
    el.textContent = "运行后显示结果";
    el.style.cssText = [
        "position:absolute",
        "left:0",
        "right:0",
        "top:50%",
        "transform:translateY(-50%)",
        "text-align:center",
        `color:${A001_PREVIEW.HINT_FG}`,
        `font-size:${A001_PREVIEW.HINT_FONT_SIZE}px`,
        "line-height:1.4",
        "user-select:none",
        "pointer-events:none",
    ].join(";");
    node._a001PreviewHint = el;
    host.appendChild(el);
}

/** 图片分支：居中 contain，棋盘格衬底。 */
function buildImage(url) {
    const img = document.createElement("img");
    img.className = "xzg-a001-mp-img";
    img.src = url;
    img.alt = "";
    img.style.cssText = [
        "width:100%",
        "height:100%",
        "object-fit:contain",
        "display:block",
        // 图片不参与交互：保持面板整体可穿透，避免挡住节点拖拽
        "pointer-events:none",
    ].join(";");
    return img;
}

/** 视频分支：可播放/暂停，故需恢复指针事件。
 *
 * ★ 默认不播放（停在首帧）：
 *   `autoplay = false` 是根本 —— 否则挂载即自动开播。仅设 autoplay 仍不够稳：
 *   部分浏览器会在元数据/首帧缓冲完成后把播放头前移，故再于 `loadedmetadata`
 *   时把 `currentTime` 钉回 0，并在 `play` 事件之外不做任何主动 `play()` 调用，
 *   确保预览始终停在首帧，需用户手动点击控件才播。
 *   （与 A006_VideoNode.js 的 vidMain/vidCmp 同为「autoplay=false」范式。）
 *
 * ★ 声音：默认有声、音量 30%，且**只在第一次（首次创建该元素）时**应用 ——
 *   之后用户用控件调过的音量记在 node._a001Volume 上，重建元素时按记忆值恢复，
 *   绝不在每次播放/重绘时把音量重置回 30%。
 *   （对比视频仍恒静音：声音永远来自主视频，见 A001_compare.js buildCompareMedia。） */
function buildVideo(url, node) {
    const v = document.createElement("video");
    v.className = "xzg-a001-mp-video";
    v.src = url;
    v.controls = true;
    v.loop = true;
    v.muted = false;                 // 默认播放声音（不再是静音预览）
    v.autoplay = false;              // 但仍不自动播放：需用户点击才播（见上）
    v.playsInline = true;
    v.preload = "metadata";
    /* 首次创建 → 用默认 30%；已被用户调节过 → 沿用记忆值（「只在第一次」的落点）。 */
    const remembered = node?._a001Volume;
    v.volume = typeof remembered === "number" ? remembered : A001_PREVIEW.DEFAULT_VOLUME;
    /* 反向记忆：用户拖音量条/静音后写回节点，供后续重建恢复。 */
    v.addEventListener("volumechange", () => {
        safeCall(() => { if (node) node._a001Volume = v.volume; }, undefined, "记忆视频音量");
    });
    /* 元数据就绪后把播放头钉在 0，保证画面是首帧而非某个缓冲到的中间帧。 */
    v.addEventListener("loadedmetadata", () => {
        try { v.currentTime = 0; } catch (_e) { /* 某些格式尚不可 seek，忽略即可 */ }
    }, { once: true });
    v.style.cssText = [
        "width:100%",
        "height:100%",
        "object-fit:contain",
        "display:block",
        "background:transparent",
        "pointer-events:auto",
    ].join(";");
    return v;
}

/** 音频分支：上下左右居中一条播放器。
 *  宿主为 flex 居中容器，故这里只需给定宽度上限，
 *  不能再用 width:90%（flex 下百分比宽度会与主轴居中互相拉扯）。 */
function buildAudio(url) {
    const a = document.createElement("audio");
    a.className = "xzg-a001-mp-audio";
    a.src = url;
    a.controls = true;
    /* ★ 默认不播放（与视频同口径）：不做任何 play() 调用，也不设 autoplay，
     *  停在 0 秒由用户手动点播放。preload="metadata" 只取时长等信息、不预载音频体。 */
    a.autoplay = false;
    a.preload = "metadata";
    a.style.cssText = [
        "width:90%",
        "max-width:100%",
        "display:block",
        "pointer-events:auto",
    ].join(";");
    return a;
}

/**
 * 音频列表分支：每个音频一条播放器，纵向排列，顺序 = 内部输出插槽顺序。
 *
 * 【为什么要列表】A001 是通用子图容器，可能同时接多个音频输出（如多轨对照）。
 * 单条播放器只能显示一个，故这里按插槽顺序全部列出。
 * 【默认都不播放】逐条 autoplay=false，不做任何 play() 调用 —— 用户手动点才播，
 * 避免多个音频同时自动播放造成混音（也规避浏览器对非用户手势自动播放的拦截）。
 * 【互斥播放】同一时刻只允许一个在播：任一条开始播放即暂停其余所有（见下方委托）。
 * 【可滚动】容器 flex:1 + overflow-y:auto：音频多时可在框内滚动，不撑破预览框。
 */
function buildAudioList(items) {
    const wrap = document.createElement("div");
    wrap.className = "xzg-a001-mp-audios";
    wrap.style.cssText = [
        "position:absolute",
        "inset:0",
        "box-sizing:border-box",
        "padding:8px",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "gap:8px",
        "overflow-y:auto",
        "pointer-events:auto",
    ].join(";");
    for (const it of items) {
        const a = buildAudio(it.url);
        /* 列表里由容器统一控制宽度，单条不再取 90%（避免叠加滚动条宽度）。 */
        a.style.width = "100%";
        /* ★ 互斥播放（只播当前点击的那条）：
         *  用「捕获阶段」监听 play —— 它先于冒泡到达容器，可在音频刚进入播放态时
         *  立刻暂停其余条，避免出现几十毫秒的双轨重叠。
         *  委托到容器而非逐条绑定：重建列表时旧监听随 DOM 一并释放，无需手工解绑。 */
        a.addEventListener("play", () => {
            safeCall(() => {
                for (const other of wrap.querySelectorAll("audio")) {
                    if (other !== a && !other.paused) other.pause();
                }
            }, undefined, "音频互斥播放");
        }, true);
        wrap.appendChild(a);
    }
    return wrap;
}

/** 文本分支：可滚动，故需恢复指针事件。 */
function buildText(value) {
    const pre = document.createElement("pre");
    pre.className = "xzg-a001-mp-text";
    pre.textContent = typeof value === "string" ? value : String(value ?? "");
    pre.style.cssText = [
        "position:absolute",
        "inset:0",
        "margin:0",
        "padding:8px",
        "box-sizing:border-box",
        "overflow:auto",
        "white-space:pre-wrap",
        "word-break:break-word",
        `color:${A001_PREVIEW.TEXT_FG}`,
        `font-size:${A001_PREVIEW.TEXT_FONT_SIZE}px`,
        "line-height:1.5",
        "pointer-events:auto",
    ].join(";");
    return pre;
}

/** 释放已挂的多媒体元素（清 src 并 load，避免 detached 元素继续解码解码占用内存）。 */
function releaseMedia(el) {
    if (!el) return;
    if (el.tagName === "VIDEO" || el.tagName === "AUDIO") {
        safeCall(() => {
            el.pause?.();
            el.removeAttribute("src");
            el.load?.();
        }, undefined, "释放媒体元素");
    } else if (el.tagName === "IMG") {
        safeCall(() => { el.removeAttribute("src"); }, undefined, "释放图片元素");
    }
}

/**
 * 若宿主内已有与目标状态同源的预览元素，则原样沿用（不重建 DOM），返回 true。
 *
 * 【存在意义】renderA001Preview 原为「每次全量重建」，而拉伸节点（onResize →
 * ensureA001Panel）会反复触发重绘；媒体元素一被重建就会重新 load：
 * 视频黑闪一帧、音频进度归零 —— 即「拉伸时框内闪烁」。
 * 只要 kind 与 url / 文本一致，就没有任何理由重建它。
 */
function reuseExistingPreview(host, kind, state) {
    if (host.dataset.kind !== kind) return false;
    /* ★ 音频列表：逐条比对 src 序列（顺序也参与判定 —— 插槽顺序变了要重建）。
     *  命中复用可避免「拉伸/重绘时音频重新加载、进度归零」。 */
    if (kind === "audio" && Array.isArray(state?.audios)) {
        const wrap = host.firstElementChild;
        if (!wrap || wrap.className !== "xzg-a001-mp-audios") return false;
        const els = Array.from(wrap.querySelectorAll("audio"));
        if (els.length !== state.audios.length) return false;
        return els.every((el, i) =>
            (el.getAttribute("src") || "") === (state.audios[i].url || ""));
    }
    const el = host.firstElementChild;
    if (!el) return false;
    if (kind === "text") {
        const want = typeof state.text === "string" ? state.text : String(state.text ?? "");
        return el.tagName === "PRE" && el.textContent === want;
    }
    const want = state.url || "";
    if (!want) return false;
    /* 用 getAttribute 而非 el.src：后者是解析后的绝对 URL，与状态里的原串不可比。 */
    if ((el.getAttribute("src") || "") !== want) return false;
    return (kind === "image" && el.tagName === "IMG")
        || (kind === "video" && el.tagName === "VIDEO")
        || (kind === "audio" && el.tagName === "AUDIO");
}

/**
 * 按状态渲染预览内容（幂等：同源内容原地复用，变化时才全量重建）。
 * @param {object} node A001 子图节点
 * @param {{kind:string,url?:string,text?:string}|null} state 预览状态；null = 无内容
 */
export function renderA001Preview(node, state) {
    const host = previewHost(node);
    if (!host) return;
    /* ★★ 同源复用（消除拉伸 / 面板重挂引起的媒体闪烁）：
     *  拉伸节点会反复走到这里，若每次都重建，<video>/<audio> 必然重新加载。
     *  命中复用时只确保占位提示已移除，不做任何 DOM 重建。 */
    const kindNow = state?.kind;
    if (kindNow && reuseExistingPreview(host, kindNow, state)) {
        const hint = node._a001PreviewHint;
        if (hint?.isConnected) {
            safeCall(() => hint.remove(), undefined, "移除预览占位提示");
        }
        /* ★ 对比层：源可能刚变化（第二个内层节点执行完）或首次出现。
         *  build 内部按 src 判定，未变则只更新裁剪位置与显隐，不重建媒体。 */
        if (kindNow === "image" || kindNow === "video") {
            safeCall(
                () => buildA001CompareLayer(node, host, state.cmp ?? null),
                undefined,
                "更新对比层"
            );
        }
        return;
    }
    // 先释放旧多媒体元素（在清空之前，否则拿不到引用）
    for (const child of Array.from(host.children)) {
        if (child !== node._a001PreviewHint) releaseMedia(child);
    }
    /* ★ 清空宿主会连同对比层 DOM（cmp / cut / handle）一起移除，
     *  先把引用摘干净，避免留下悬空引用。 */
    if (host._a001Parts) {
        host._a001Parts = { main: null, cmp: null, cut: null, handle: null };
    }
    clearPreviewHost(host);

    const kind = state?.kind;
    if (!kind) {
        renderHint(host, node);
        return;
    }
    // 有内容时提示元素移出（保留引用，供后续复用）
    if (node._a001PreviewHint) {
        safeCall(() => node._a001PreviewHint.remove(), undefined, "移除预览占位提示");
    }

    let el = null;
    if (kind === "text") {
        el = buildText(state.text);
    } else if (kind === "audio" && Array.isArray(state.audios) && state.audios.length) {
        /* ★ 音频：按插槽顺序列出全部播放器（默认都不播放，见 buildAudio）。 */
        el = buildAudioList(state.audios);
    } else if (state.url) {
        el = kind === "image" ? buildImage(state.url)
            : kind === "video" ? buildVideo(state.url, node)
                : kind === "audio" ? buildAudio(state.url) : null;
    }
    if (!el) {
        renderHint(host, node);
        return;
    }
    host.dataset.kind = kind;
    host.style.background = KIND_HOST_STYLE[kind]?.background ?? "";
    host.appendChild(el);
    /* ★ 记主元素引用（对比层靠它反算内容矩形做 clamp），再按需建对比层。 */
    host._a001Parts = { main: el, cmp: null, cut: null, handle: null };
    if (kind === "image" || kind === "video") {
        safeCall(
            () => buildA001CompareLayer(node, host, state.cmp ?? null),
            undefined,
            "构建对比层"
        );
    }
}

/** 节点删除时的预览资源释放。 */
export function disposeA001Preview(node) {
    if (!node) return;
    /* ★ 对比层先释放（清事件标志、暂停并卸载对比媒体）：
     *  随后下面的遍历会释放宿主内全部媒体资源，本调用负责本模块的状态复位。 */
    safeCall(() => disposeA001Compare(node), undefined, "释放对比层");
    const host = node?._a001PreviewHost;
    if (host) {
        for (const child of Array.from(host.children)) releaseMedia(child);
        safeCall(() => { while (host.firstChild) host.removeChild(host.firstChild); }, undefined, "清空预览宿主");
    }
    node._a001PreviewHint = null;
    node._a001PreviewState = null;
    /* ★ 内层产物累积表一并清空：节点被删除后没有复活语义（复用时会按新子图重建表）。 */
    node._a001PreviewAssets = null;
    node._a001AssetsSgId = null;
}

/* ══════════════════════════════════════════════
 *  预览持久化（随工作流保存 / 刷新后恢复）
 * ══════════════════════════════════════════════ */

/** 把当前预览状态落盘到 node.properties._a001_preview（随工作流保存）。
 *  与 A005_subgraph.js:642-647 / A006_subgraph.js:642-647 同款约定，
 *  差别在于 A001 支持四类型，故除媒体对象外还要记 kind 与 text。
 *  只存最小信息（kind + 媒体描述对象 / 文本），不存 DOM、不存已构造的 URL ——
 *  URL 里带 rand 参数与预览格式参数，重启后必须重算，否则指向失效缓存。 */
export function saveA001Preview(node, state) {
    if (!node || !state?.kind) return;
    safeCall(
        () => {
            node.properties = node.properties || {};
            const rec = { kind: state.kind };
            /* ★ 音频多轨：逐条落盘（顺序 = 插槽顺序），只存最小描述对象。 */
            if (state.kind === "audio" && Array.isArray(state.audios) && state.audios.length) {
                const list = state.audios
                    .filter((a) => a?.data?.filename)
                    .map((a) => ({
                        filename: a.data.filename,
                        subfolder: a.data.subfolder || "",
                        type: a.data.type || "output",
                    }));
                if (!list.length) return;
                rec.audios = list;
                return void (node.properties._a001_preview = rec);
            }
            if (state.kind === "text") {
                /* ★ 文本产物长度上限：properties 会随工作流落盘，文本类产物
                 *  （LLM 输出 / JSON / 大段 prompt）可达 MB 级，会显著撑大工作流文件。
                 *  超过上限时截断并标注（仅影响持久化回填，实时渲染仍用内存态全文）。 */
                const raw = String(state.text ?? "");
                rec.text = raw.length > A001_PREVIEW_TEXT_LIMIT
                    ? raw.slice(0, A001_PREVIEW_TEXT_LIMIT) + "\n…（已截断，仅持久化保存前 " + A001_PREVIEW_TEXT_LIMIT + " 字符）"
                    : raw;
            } else if (state.data && state.data.filename) {
                rec.data = {
                    filename: state.data.filename,
                    subfolder: state.data.subfolder || "",
                    type: state.data.type || "output",
                };
            } else {
                return;
            }
            /* ★ 对比内容一并落盘（A001 比 A005/A006 更彻底：那两者只在执行后
             *  同批加载对比源，刷新即失去对比；这里随预览一起持久化，重载工作流
             *  后对比仍在）。只存最小描述对象，URL 一律重算（见本函数头注）。 */
            if (state.cmp?.data?.filename) {
                rec.cmp = {
                    kind: state.cmp.kind,
                    data: {
                        filename: state.cmp.data.filename,
                        subfolder: state.cmp.data.subfolder || "",
                        type: state.cmp.data.type || "output",
                    },
                };
            }
            node.properties._a001_preview = rec;
        },
        undefined,
        "预览状态落盘"
    );
}

/** 从 properties._a001_preview 读取上次保存的预览记录；无有效记录返回 null。 */
export function getSavedA001Preview(node) {
    const rec = node?.properties?._a001_preview;
    if (!rec || typeof rec !== "object" || !rec.kind) return null;
    if (rec.kind === "text") return rec;
    /* ★ 音频多轨：以 audios 数组为有效判据（不再要求 rec.data）。 */
    if (rec.kind === "audio" && Array.isArray(rec.audios) && rec.audios.length) return rec;
    return rec.data?.filename ? rec : null;
}

/** 从持久化记录还原预览状态（刷新/加载工作流后调用）。
 *  媒体类型重算 URL（不能复用旧 URL，见 saveA001Preview 注释）。 */
export function restoreA001Preview(node) {
    if (!node || node._a001PreviewState) return;
    const rec = getSavedA001Preview(node);
    if (!rec) return;
    /* ★ 音频多轨：逐条重算 URL 并按原顺序还原成列表。 */
    if (rec.kind === "audio" && Array.isArray(rec.audios) && rec.audios.length) {
        const audios = [];
        for (const d of rec.audios) {
            const u = a001MediaUrl(d);
            if (u) audios.push({ url: u, data: d });
        }
        if (!audios.length) return;
        node._a001PreviewState = {
            kind: "audio",
            audios,
            url: audios[0].url,       // 兼容单音频消费者的旧字段
            data: audios[0].data,
        };
        alog("已恢复上次预览 | audio ×", audios.length);
        return;
    }
    if (rec.kind === "text") {
        node._a001PreviewState = { kind: "text", text: rec.text ?? "" };
    } else {
        const url = a001MediaUrl(rec.data);
        if (!url) return;
        node._a001PreviewState = { kind: rec.kind, url, data: rec.data };
        /* ★ 对比内容恢复（与 saveA001Preview 的 cmp 对应）：
         *  同样重算 URL，仅在类型合法（image/video）且地址可用时挂上。 */
        const cmpUrl = rec.cmp?.data ? a001MediaUrl(rec.cmp.data) : null;
        if (cmpUrl && (rec.cmp.kind === "image" || rec.cmp.kind === "video")) {
            node._a001PreviewState.cmp = {
                kind: rec.cmp.kind,
                url: cmpUrl,
                data: rec.cmp.data,
            };
        }
    }
    alog("已恢复上次预览 |", rec.kind, rec.data?.filename ?? "",
        rec.cmp ? "| 含对比" : "");
}

/* ══════════════════════════════════════════════
 *  内层产物累积 / 主对比选取（数据层）
 *
 *  ★ 为什么要累积而不是「后到覆盖」：对比功能需要同一轮执行里
 *    「多个内层节点」的产物（主内容 + 对比内容），单个状态位装不下。
 *  约定口径（用户指定）：按【内层节点 id】区分 —— id 最小者为「主内容」，
 *  其后第一个同类型者为「对比内容」；同类只有一份则不对比。
 * ══════════════════════════════════════════════ */

/**
 * 取（并按需初始化）本节点的内层产物累积表。
 * key = 内层节点 id（容器自身广播用 "self"）；
 * 值 = { kind, url, data, text, innerId } —— 同一节点重复广播直接覆盖，不累积成对比。
 *
 * 子图被重建（id 变化）时整表清空：旧产物属于旧子图，留着会串味。
 */
function a001PreviewAssets(node) {
    const sgId = node?.subgraph ? String(node.subgraph.id ?? "") : "";
    if (node._a001AssetsSgId !== sgId) {
        node._a001PreviewAssets = {};
        node._a001AssetsSgId = sgId;
    }
    if (!node._a001PreviewAssets) node._a001PreviewAssets = {};
    return node._a001PreviewAssets;
}

/**
 * 清理已不存在于子图的内层节点产物（内层节点被删除后不留幽灵对比）。
 * ★ 内层节点列表为空时【短路不清理】：执行前/子图刚建时列表可能尚未展开，
 *   此时按空集合清理会误删刚广播进来的产物。
 */
function pruneA001Assets(node) {
    const assets = node?._a001PreviewAssets;
    if (!assets || !node.subgraph) return;
    const ids = getSgNodes(node.subgraph)
        .map((n) => (n?.id == null ? "" : String(n.id)))
        .filter((v) => v);
    if (!ids.length) return;
    const alive = new Set(ids);
    for (const key of Object.keys(assets)) {
        if (!alive.has(String(key))) delete assets[key];
    }
}

/** 内层节点 id 排序：数值升序优先，非数字 id 回退字符串比较。 */
function compareA001InnerId(a, b) {
    const na = Number(a?.innerId);
    const nb = Number(b?.innerId);
    const fa = Number.isFinite(na);
    const fb = Number.isFinite(nb);
    if (fa && fb) return na - nb;
    return String(a?.innerId ?? "").localeCompare(String(b?.innerId ?? ""));
}

/**
 * 按【子图输出插槽由上到下】的顺序解析出内层产物（最多取前两个）。
 *
 * 口径（用户指定）：
 *   · 第 1 个槽（最上面）→ 主内容；第 2 个槽 → 对比内容；第 3 个及以后一律忽略
 *   · 同时有图与视频时，**以最上面那个槽的类型为准**：第 2 个槽产物类型与之不符则不对比
 *   · 未连线的槽跳过（不占位）——某槽的源未执行时不至于让整个预览变空
 *
 * 取数路径：槽 id → 官方 resolveSubgraphOutputLink（A001_exec.js 已装）→ 内层 feed 节点 id
 *          → 从内层产物累积表按键取出该节点的产物（与 A006 getInnerUiVideos 同构）。
 */
function resolveA001SlotOutputs(node, maxCount) {
    const sg = node?.subgraph;
    const slots = Array.isArray(sg?.outputs) ? sg.outputs : [];
    const assets = node?._a001PreviewAssets || {};
    /* maxCount 省略/非正数 = 不限数量（音频要收全部槽，见 resolveA001PreviewState）。 */
    const limit = Number.isFinite(maxCount) && maxCount > 0 ? maxCount : Infinity;
    const out = [];
    for (const slot of slots) {
        if (out.length >= limit) break;
        if (slot?.id == null) continue;
        const res = safeCall(
            () => node.resolveSubgraphOutputLink?.(slot.id),
            null,
            "对比/主内容输出槽解析"
        );
        const feedId = res?.link?.origin_id;
        if (feedId == null) {
            alog(`输出槽「${slot.name ?? "?"}」未连线 → 跳过`);
            continue;
        }
        /* ★ 源节点已被忽略 / 旁路 → 该槽跳过（用户实测回归，详见 isInnerNodeIgnored 注释）：
         *  图片节点仅被「忽略」而非删除时，其旧产物仍在累积表里；若不跳过，
         *  「第 1 槽优先」的规则会让旧图片永远压住下方新接入的视频 / 音频槽。 */
        if (isInnerNodeIgnored(sg, feedId)) {
            alog(`输出槽「${slot.name ?? "?"}」源节点 ${feedId} 已被忽略 → 跳过`);
            continue;
        }
        const entry = assets[String(feedId)];
        if (!entry?.url) {
            /* 诊断用：连了线但取不到产物（源节点本次未产出媒体，或开关未执行）。
             * 这类日志量极小（每次执行每槽一条），却能直接定位「为什么没对比」。 */
            alog(`输出槽「${slot.name ?? "?"}」源节点 ${feedId} 暂无媒体产物 → 跳过`);
            continue;
        }
        alog(`输出槽「${slot.name ?? "?"}」→ 内层节点 ${feedId} | ${entry.kind} | 第 ${out.length + 1} 项`);
        out.push(entry);
    }
    return out;
}

/**
 * 由累积表 + 子图输出槽选出最终预览状态。
 *
 * ① 优先按输出槽顺序（用户连线显式指定）：上=主、下=对比；
 * ② 无任何输出槽连线时回退到「内层产物 id 最小者」为主（保持既有自动预览行为，
 *    否则老工作流（未连输出槽）会一执行就看不到任何预览）；
 * ③ 对比仅在同类型（image / video）且非同一来源时启用 —— 音频 / 文本不对比；
 * ④ ★ 音频特例：**收集全部输出槽的音频并按槽顺序排列**（audios 数组），
 *    不再受「只用前两个槽」的限制，也不参与对比 —— 多个音频是并列播放器列表。
 *
 * @returns {{kind:string,url?:string,data?:object,text?:string,innerId:string,
 *            audios?:Array<{url:string,data:object,innerId:string}>,
 *            cmp?:{kind:string,url:string,data:object,innerId:string}}|null}
 */
function resolveA001PreviewState(node) {
    pruneA001Assets(node);
    const sg = node?.subgraph;
    const assets = node?._a001PreviewAssets;
    /* ★ 回退集：仅保留「源节点未被忽略」的产物。
     *  被忽略节点的旧产物不得参与预览（用户指定口径），否则「图片被设为忽略 →
     *  换视频」时旧图片会一直压住新视频。键为容器自身广播的 "self" 时无对应内层节点，
     *  isInnerNodeIgnored 返回 false，正常保留。 */
    const entries = assets
        ? Object.entries(assets)
            .filter(([k]) => !isInnerNodeIgnored(sg, k))
            .map(([, v]) => v)
        : [];
    if (!entries.length) return null;

    /* ★ 音频特例：收集【全部】输出槽里的音频（不限两个），顺序 = 插槽顺序。
     *  这样「内部输出插槽连接多个音频」时会全部列出，且顺序与插槽一致。 */
    const allOut = resolveA001SlotOutputs(node);
    const audios = allOut.filter((e) => e.kind === "audio");
    if (audios.length) {
        return {
            kind: "audio",
            audios: audios.map((e) => ({ url: e.url, data: e.data, innerId: e.innerId })),
            url: audios[0].url,          // 兼容单音频消费者的旧字段
            data: audios[0].data,
            innerId: audios[0].innerId,
        };
    }

    const slotOut = allOut.slice(0, 2);
    let main = slotOut[0] || null;
    let cmp = null;
    if (main) {
        const second = slotOut[1];
        /* 类型以最上面那个槽为准：第 2 个槽产物类型不符 → 不对比（只显示主内容）。 */
        if (second && second.kind === main.kind
            && String(second.innerId) !== String(main.innerId)) {
            cmp = {
                kind: second.kind,
                url: second.url,
                data: second.data,
                innerId: second.innerId,
            };
        }
    } else {
        main = entries.slice().sort(compareA001InnerId)[0];
    }
    if (!main) return null;

    const state = { kind: main.kind, innerId: main.innerId };
    if (main.kind === "text") {
        state.text = main.text ?? "";
    } else {
        state.url = main.url;
        state.data = main.data;
    }
    if (cmp) state.cmp = cmp;
    return state;
}

/* ══════════════════════════════════════════════
 *  归属判定 / 状态更新
 * ══════════════════════════════════════════════ */

/**
 * 把一条 executed 广播应用到可能归属它的 A001 子图节点上。
 *
 * detail.node 形态（与 A005/A006 实测一致）：
 *   · "外层id:内层id"  子图内部节点广播 → 按外层 id 前缀匹配本节点
 *   · "外层id"          容器自身广播
 * 仅当外层 id 命中本节点时才写入，避免误抓其他节点的产物。
 */
export function applyA001Executed(detail) {
    if (!detail) return;
    const execId = String(detail.node ?? "");
    if (!execId) return;
    const colonIdx = execId.indexOf(":");
    const outerId = colonIdx > 0 ? execId.slice(0, colonIdx) : execId;
    const innerId = colonIdx > 0 ? execId.slice(colonIdx + 1) : "";

    /* ★ 先按 O(1) 索引查节点；索引未命中时回退遍历注册表兜底
     *  （覆盖「attach 时 id 尚未定型 → 索引漏登记」的边界，保证不漏回灌）。 */
    let node = A001_PREVIEW_INDEX.get(outerId) || null;
    if (!node) {
        for (const n of A001_PREVIEW_NODES) {
            if (n && n.id != null && String(n.id) === outerId) { node = n; break; }
        }
    }
    if (!node || node.id == null) return;
    /* ★ 不在图中时只跳过本轮，**不得注销注册**：
     *  执行瞬间（子图展开/切图）isNodeInGraph 可能短暂为 false，
     *  原实现用 continue 仅跳过本轮、下轮即自愈；
     *  若在此 detach，会把节点永久移出注册表 → 后续 executed 全部查不到
     *  → 预览框空白（实测回归）。 */
    if (!isNodeInGraph(node)) return;

    const kind = a001KindOfOutput(detail.output);
    if (!kind) return;
    const item = a001FirstItemOf(detail.output, kind);
    if (!item) return;

    /* 写入累积表（同一内层节点重复广播 → 覆盖该项，不会多出一份对比）。 */
    const assets = a001PreviewAssets(node);
    const key = innerId || "self";
    if (kind === "text") {
        assets[key] = { kind, text: String(item), innerId };
    } else {
        const url = a001MediaUrl(item);
        if (!url) return;
        // ★ 同时保留原始产物对象（data）：持久化时需要它，URL 不可复用
        assets[key] = { kind, url, data: item, innerId };
    }

    const state = resolveA001PreviewState(node);
    if (!state) return;
    node._a001PreviewState = state;
    // ★ 落盘：刷新网页后从 properties 恢复，否则结果只活在内存里
    safeCall(() => saveA001Preview(node, state), undefined, "预览状态落盘");
    // 转发给 Appearance 侧刷新（宿主元素存在与否由渲染层自行判定）
    safeCall(() => refreshA001Preview(node), undefined, "预览内容刷新");
}

/* ══════════════════════════════════════════════
 *  节点注册表 / 刷新入口
 * ══════════════════════════════════════════════ */

/** 已初始化的 A001 子图节点（供事件回灌过滤，避免遍历全图）。 */
const A001_PREVIEW_NODES = new Set();
/** 外层节点 id → node 的索引：executed 广播高频（每个内层节点一次），
 *  原实现线性遍历 A001_PREVIEW_NODES 比对 id（O(N)），改用 Map 后 O(1)。 */
const A001_PREVIEW_INDEX = new Map();

/** 注册节点进入预览系统（幂等）。
 *  ★ 索引补写：attach 可能在 node.id 尚未定型时被调用（onNodeCreated 早于入图），
 *    故每次调用都尝试按当前 id 刷新索引，避免「id 后定型但索引漏登记」。 */
export function attachA001Preview(node) {
    if (!node) return;
    if (node.id != null) A001_PREVIEW_INDEX.set(String(node.id), node);
    if (node._a001PreviewAttached) return;
    node._a001PreviewAttached = true;
    A001_PREVIEW_NODES.add(node);
}

/** 注销节点（onRemoved 时调用）。 */
export function detachA001Preview(node) {
    if (!node) return;
    A001_PREVIEW_NODES.delete(node);
    if (node.id != null) A001_PREVIEW_INDEX.delete(String(node.id));
    node._a001PreviewAttached = false;
}

/**
 * 把当前状态重新绘制到宿主上。
 * 面板被 Vue 整棵重建后，宿主元素会换新，本函数负责把内容画回来
 * （状态存 node._a001PreviewState，不存 DOM，故可无损重绘）。
 */
export function refreshA001Preview(node) {
    if (!node) return;
    // 宿主尚未就绪（面板还没挂）→ 等 Appearance 挂好后自行调用本函数
    if (!node._a001PreviewHost) return;
    /* ★ 内存态为空时兜底从 properties 恢复：
     *  刷新网页 / 加载工作流后本次会话尚未执行，_a001PreviewState 是空的，
     *  但 properties._a001_preview 里有上次运行结果，此处补一次还原。 */
    if (!node._a001PreviewState) {
        safeCall(() => restoreA001Preview(node), undefined, "兜底恢复预览");
    }
    renderA001Preview(node, node._a001PreviewState ?? null);
}

/** 安装全局 executed / execution_cached 监听（幂等）。 */
export function installA001PreviewRefresh() {
    if (window.__a001ExecutedHooked) return;
    window.__a001ExecutedHooked = true;

    api.addEventListener("executed", ({ detail }) => safeCall(
        () => applyA001Executed(detail),
        undefined,
        "executed 预览回灌"
    ));

    // 服务端缓存命中：结果来自缓存，不会重发 executed，需借 execution_cached 补齐
    api.addEventListener("execution_cached", ({ detail }) => safeCall(
        () => {
            const ids = Array.isArray(detail?.nodes) ? detail.nodes.map(String) : [];
            if (!ids.length) return;
            /* ★ 用 Set 替代 ids.includes()：原实现是「Set 遍历 × 数组线性查找」
             *  （O(N×M)），改为 Map 索引直查 + 集合判定后为 O(M)。 */
            const idSet = new Set(ids);
            for (const id of idSet) {
                const node = A001_PREVIEW_INDEX.get(id);
                if (!node) continue;
                safeCall(() => refreshA001Preview(node), undefined, "缓存命中预览回灌");
            }
        },
        undefined,
        "execution_cached 预览回灌"
    ));

    alog("预览监听已安装（executed / execution_cached）");
}
