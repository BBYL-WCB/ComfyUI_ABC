import { app } from "../../../scripts/app.js";
import { setTitleBadgeEnabled, getTitleBadgeEnabled, scanAll } from "./A000_TagMove.js";
import { injectStyleOnce } from "./A000_DomStyle.js";

// ═══════════════════════════════════════════════════════════════
//  A000 · 000_ABC 前端公共池
//
//  本文件由两段相互独立的功能组成（各自独立注册扩展、互不依赖）：
//    · A000-1 设置页   —— 可勾选清单，隐藏主界面工具栏按键
//    · A000-2 标题徽章 —— 把节点徽章栏搬进标题栏右侧
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  A000-1  设置页
//   · 本页功能：可勾选清单，隐藏主界面两类工具栏的对应按键：
//       ① 操作栏（顶栏）     —— .actionbar-container 内的按键 / 开关 / 组
//       ② 左侧导航侧栏      —— nav[data-testid="side-toolbar"] 内的按键
//   · 前端设置系统为静态注册、无自定义控件类型，故采用「DOM 注入」，
//     每个按键一个勾选，勾选即隐藏对应按钮。
//   · ComfyUI 机制：分类需至少 1 个“原生设置项”左侧菜单才会出现该分类，
//     故保留 1 个说明性占位项撑起 ABC设置 分类入口，三个清单都挂其下。
//
//  持久化：
//   · 设置统一保存到一个数据文件 js/A000/A000-ABCsettings.json（经后端 /a000/settings 读写），
//     每次页面加载自动加载，勾选/折叠后自动保存（去抖），文件只有这一个。
//   · 文件内容 = { hidden:{ab:[key],sb:[label],sg:[label]}, fold:{UI,AB,SB,SG} }：
//        hidden 只记录“被隐藏的按键”（默认全显示，无文件即什么都不隐藏）；
//          tp = 模板页面（侧栏“模板”对话框左侧分类页）；
//        fold 记录各清单是否折叠（纯 UI 偏好，一并入文件）。
//   · 无数据文件时恢复默认：所有 UI 全部显示（hidden 为空）。
//   · 首次升级：若历史 localStorage(000_ABC.*) 有旧隐藏配置，自动迁移进文件并清除。
// ═══════════════════════════════════════════════════════════════

const CATEGORY = "ABC设置";
const GROUP_MAIN = "ABC设置";
const ENTRY_LABEL = "（说明）勾选下方对应项，可隐藏/恢复主界面操作栏（顶栏）与左侧导航侧栏上的按键。";

const SIDE_SEL = 'nav[data-testid="side-toolbar"] ';    // 左侧导航侧栏容器
const ACT_SEL  = '.actionbar-container';                // 操作栏（顶栏）容器

// ── 分类入口占位（ComfyUI 需 ≥1 原生项，分类左侧菜单才会出现）──
app.registerExtension({
  name: "000_ABC.SettingsPage",
  settings: [
    {
      id: `${CATEGORY}.entry`,
      name: ENTRY_LABEL,
      type: "boolean",
      defaultValue: false,
      category: [CATEGORY, GROUP_MAIN, ENTRY_LABEL],
    },
  ],
});

// ═══════════ 持久化（单文件 js/A000/A000-ABCsettings.json） ═══════════
// 仅作旧数据迁移时读取 localStorage；运行时一切以内存态 + 文件为准
const SB_KEY = "000_ABC.sb_entries";
const AB_KEY = "000_ABC.ab_entries";
const SG_KEY = "000_ABC.sg_entries";
const SB_FOLD_KEY = "000_ABC.sb_fold";
const AB_FOLD_KEY = "000_ABC.ab_fold";
const SG_FOLD_KEY = "000_ABC.sg_fold";
const UI_FOLD_KEY = "000_ABC.ui_fold";
const TP_KEY = "000_ABC.tp_entries";
const TP_FOLD_KEY = "000_ABC.tp_fold";

// 内存态：hiddenMap = { ab:{key:true}, sb:{label:true}, sg:{label:true}, tp:{label:true} }
//          foldState  = { UI:'0'|'1'|null, AB:…, SB:…, SG:…, TP:… }  (null=无记录，默认折叠)
const hiddenMap = { ab: {}, sb: {}, sg: {}, tp: {} };
const foldState = { UI: null, AB: null, SB: null, SG: null, TP: null };
// 节点库“来源”视图总开关（true=在节点库“全部节点”后注入“来源”标签，分插件罗列 custom_nodes 节点）
// 模板页面分类缓存：模板对话框与设置对话框互斥，缓存使清单在设置页始终可见
let tpCache = [];
let sourceEnabled = false;
let srcActive = false;       // 当前是否正显示“来源”视图
let srcTabEl = null;         // 注入的“来源”标签按钮
let srcPanelEl = null;       // 注入的来源分组面板容器
let srcDrawn = false;        // 面板内容是否已渲染过一次

let srcTrNodes = null;       // 002 汉化包节点 title 表缓存：type -> {title,...}
let srcData = null;          // /object_info 分组缓存
let srcDataBusy = false;     // 防止重复拉取
let storeReady = false;      // 文件数据加载/迁移完成；之前禁止写盘（避免空状态覆盖真实设置）
let saveTimer = null;

function foldId(title) {
  if (title.indexOf("画布") === 0) return "UI";            // 画布UI按键清单（外层）
  if (title.indexOf("操作栏") === 0) return "AB";
  if (title.indexOf("应用程序设置") === 0) return "SG";
  if (title.indexOf("设置页面") === 0) return "SG";       // 新：全部设置页面清单
  if (title.indexOf("模板页面") === 0) return "TP";       // 新：模板页面清单
  return "SB";
}

function collectHidden(group) { return Object.keys(hiddenMap[group] || {}); }

function serializeState() {
  return {
    hidden: { ab: collectHidden("ab"), sb: collectHidden("sb"), sg: collectHidden("sg"), tp: collectHidden("tp") },
    fold: { UI: foldState.UI, AB: foldState.AB, SB: foldState.SB, SG: foldState.SG, TP: foldState.TP },
    tpl: tpCache.slice(),
    source: { enabled: !!sourceEnabled },
    titleBadge: { enabled: getTitleBadgeEnabled() },
  };
}

// 去抖保存：只在 storeReady 后才允许写盘（统一一个文件）
function scheduleSave() {
  if (!storeReady) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 400);
}

async function persistNow() {
  try {
    const resp = await fetch("/a000/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: serializeState() }),
    });
    if (!resp.ok) console.warn("[ABC] 设置保存失败：HTTP " + resp.status);
  } catch (e) { console.warn("[ABC] 设置保存失败：网络错误", e); }
}

// 把已建好的折叠块按 foldState 应用到 DOM
const foldItems = { UI: null, AB: null, SB: null, SG: null, TP: null }; // 各块 .abc-sb-items
function setFoldDom(fid, folded) {
  const items = foldItems[fid];
  if (!items) return;
  items.style.display = folded ? "none" : "";
  const head = items.parentElement && items.parentElement.firstElementChild;
  const mark = head && head.querySelector("span");
  if (mark) mark.textContent = folded ? "▸" : "▾";
}
function applyFoldAll() {
  ["UI", "AB", "SB", "SG", "TP"].forEach((f) => {
    const v = foldState[f];
    let folded = true; // 无记录默认折叠
    if (v === "0") folded = false;
    else if (v === "1") folded = true;
    setFoldDom(f, folded);
  });
}

// 旧数据一次性迁移：把历史 localStorage 的隐藏项/折叠搬入内存，随后清除这些键
function migrateLegacy() {
  const moved = { hidden: 0, fold: 0 };
  try {
    const abAll = JSON.parse(localStorage.getItem(AB_KEY) || "[]");
    abAll.forEach((e) => { if (e && e.hidden) { hiddenMap.ab[e.text] = true; moved.hidden++; } });
    const sbAll = JSON.parse(localStorage.getItem(SB_KEY) || "[]");
    sbAll.forEach((e) => { if (e && e.hidden) { hiddenMap.sb[e.text] = true; moved.hidden++; } });
    const sgAll = JSON.parse(localStorage.getItem(SG_KEY) || "[]");
    sgAll.forEach((e) => { if (e && e.hidden) { hiddenMap.sg[e.text] = true; moved.hidden++; } });
    foldState.UI = localStorage.getItem(UI_FOLD_KEY);
    foldState.AB = localStorage.getItem(AB_FOLD_KEY);
    foldState.SB = localStorage.getItem(SB_FOLD_KEY);
    foldState.SG = localStorage.getItem(SG_FOLD_KEY);
    foldState.TP = localStorage.getItem(TP_FOLD_KEY);
    if (foldState.UI || foldState.AB || foldState.SB || foldState.SG || foldState.TP) moved.fold = 1;
    Object.keys(localStorage).forEach((k) => { if (k.indexOf("000_ABC.") === 0) localStorage.removeItem(k); });
  } catch (e) { /* 忽略格式异常 */ }
  return moved;
}

function applyData(d) {
  if (!d || typeof d !== "object") return;
  const h = d.hidden || {};
  (h.ab || []).forEach((k) => { hiddenMap.ab[k] = true; });
  (h.sb || []).forEach((k) => { hiddenMap.sb[k] = true; });
  (h.sg || []).forEach((k) => { hiddenMap.sg[k] = true; });
  (h.tp || []).forEach((k) => { hiddenMap.tp[k] = true; });
  const f = d.fold || {};
  if (f.UI !== undefined) foldState.UI = String(f.UI);
  if (f.AB !== undefined) foldState.AB = String(f.AB);
  if (f.SB !== undefined) foldState.SB = String(f.SB);
  if (f.SG !== undefined) foldState.SG = String(f.SG);
  if (f.TP !== undefined) foldState.TP = String(f.TP);
  if (Array.isArray(d.tpl)) {
    d.tpl.forEach((t) => { if (typeof t === "string" && t && tpCache.indexOf(t) === -1) tpCache.push(t); });
  }
  const s = d.source || {};
  if (typeof s.enabled === "boolean") sourceEnabled = s.enabled;
  const tb = d.titleBadge || {};
  if (typeof tb.enabled === "boolean") setTitleBadgeEnabled(tb.enabled);
}

// 启动：加载文件；无文件则尝试迁移旧数据；随后标记就绪并首轮重建/应用
async function initStore() {
  let existed = false;
  let readFailed = false;
  try {
    const r = await fetch("/a000/settings");
    /* ★ 必须判 HTTP 状态（2026-10-06 数据安全）：原实现只 await r.json()，
     *  未看 r.ok。后端返回 5xx/4xx（或反代返回 HTML）时会走 catch / 解析失败 →
     *  被当成「无文件」，紧接着 storeReady = true，任何 scheduleSave 都会把内存里的
     *  **默认空状态** POST 覆盖掉用户的真实配置 → 静默数据丢失。 */
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j && j.exists) { existed = true; applyData(j.data); }
  } catch (e) {
    readFailed = true;
    console.warn("[ABC] 设置读取失败，本次会话不写盘以免覆盖已有配置：", e);
  }
  /* 仅在「确认无文件」时才迁移旧 localStorage；读失败不迁移，避免以空态覆盖。 */
  if (!existed && !readFailed) migrateLegacy();
  /* ★ 读失败时**不置 storeReady**：scheduleSave / persistNow 的写盘闸门保持关闭，
   *  用户既有配置不会被空默认态覆盖；刷新页面会重新尝试读取。 */
  if (!readFailed) storeReady = true;
  sbRebuild(); abRebuild(); sgRebuild(); tpRebuild(); applyAll();
  applyFoldAll();
}

// ── 通用工具 ───────────────────────────────────────────────────
function normWs(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function isInDialog(el) {
  return !!el.closest('[role="dialog"],[aria-modal="true"]');
}

// ═══════════ ① 左侧导航侧栏清单 ═══════════
// 标签归一：截掉“——”副标题与尾随“(快捷键)”括注，统一为“主标题”
function sbLabel(el) {
  let t = normWs(el.textContent);
  if (t) {
    const i = t.indexOf("——");
    if (i !== -1) t = t.slice(0, i).trim();
    t = t.replace(/[（(][^（()）]*[)）]\s*$/, "").trim();
    if (t) return t;
  }
  let a = normWs(el.getAttribute("aria-label"));
  if (a) {
    const j = a.indexOf("——");
    if (j !== -1) a = a.slice(0, j).trim();
    a = a.replace(/[（(][^（()）]*[)）]\s*$/, "").trim();
  }
  return a;
}

function sbScanEls() {
  const els = [];
  document.querySelectorAll(SIDE_SEL + "button").forEach((el) => {
    if (!isInDialog(el)) els.push(el);
  });
  return els;
}
function sbFindEls(text) {
  return sbScanEls().filter((b) => sbLabel(b) === text);
}

let sbEntries = [];
let sbEl = null;

function sbApply() {
  /* ★ 单次扫描 + 建映射（2026-10-06 性能）：原实现遍历 entries 时逐条调 sbFindEls，
   *  而它内部每次都做一次全文 querySelectorAll（ab 组还含排序/Set 去重）
   *  → O(条目数) 次全文扫描，整体 O(N²)。改为先扫一次、按 key 建映射，
   *  再按 entries 分发：降为 O(1) 次扫描。
   *  行为等价性：sbFindEls 的语义正是「扫描结果里匹配 key 的全部元素」，映射只是把
   *  「每条筛一遍」改成「一次分组」，结果集合完全一致；且**不跨 Apply 复用**
   *  （各 Apply 仍各自扫描），不受阶段间 DOM 变化影响。
   *  另：isInDialog 只看 closest('[role="dialog"]')、不看可见性，故本函数
   *  自己设的 display:none 不会改变扫描结果。 */
  const byText = new Map();
  for (const b of sbScanEls()) {
    const t = sbLabel(b);
    let arr = byText.get(t);
    if (!arr) { arr = []; byText.set(t, arr); }
    arr.push(b);
  }
  for (const e of sbEntries) {
    for (const el of (byText.get(e.text) || [])) {
        el.classList.toggle("abc-hide-btn", !!e.hidden);
        if (e.hidden) el.style.setProperty("display", "none", "important");
        else el.style.removeProperty("display");
    }
  }
}

/** 通用复选清单渲染：侧栏/顶栏/设置组/模板页四个分组的清单结构完全同构
 *  （jscpd 实测为 A000 内部最大克隆簇）。差异按「参数化保留、禁止顺手统一」原则注入：
 *  容器元素、hiddenMap 分组桶、Apply 回调。标签取 label || text —— sb/sg/tp 的条目只有
 *  text、ab 的条目带 label，二者等价且与各自原实现逐字一致。 */
function renderCheckList(container, entries, hiddenBucket, applyFn) {
  if (!container) return;
  container.innerHTML = "";
  entries.forEach((e) => {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;user-select:none;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "abc-sw";
    cb.checked = !!e.hidden;
    cb.addEventListener("change", () => {
      e.hidden = cb.checked;
      if (cb.checked) hiddenBucket[e.text] = true; else delete hiddenBucket[e.text];
      scheduleSave();
      applyFn();
    });
    const sp = document.createElement("span");
    sp.textContent = e.label || e.text;
    row.appendChild(cb);
    row.appendChild(sp);
    container.appendChild(row);
  });
}

function sbRender() {
  renderCheckList(sbEl, sbEntries, hiddenMap.sb, sbApply);
}

function sbRebuild() {
  const texts = sbScanEls().map(sbLabel).filter((t) => t && t !== "设置");
  const uniq = [];
  texts.forEach((t) => { if (uniq.indexOf(t) === -1) uniq.push(t); });
  if (!uniq.length) { sbApply(); return; }
  sbEntries = uniq.map((t) => ({ text: t, hidden: !!hiddenMap.sb[t] }));
  sbRender();
  sbApply();
}

function sbSync() {
  const texts = sbScanEls().map(sbLabel).filter((t) => t && t !== "设置");
  const uniq = [];
  texts.forEach((t) => { if (uniq.indexOf(t) === -1) uniq.push(t); });
  if (!uniq.length) { sbApply(); return; }
  if (uniq.length !== sbEntries.length || uniq.some((t, i) => !sbEntries[i] || sbEntries[i].text !== t)) {
    sbRebuild();
  } else {
    sbApply();
  }
}

// ═══════════ ② 操作栏（顶栏）清单 ═══════════
// 控件既含 <button>，也含「翻译开启/关闭」(.tl-toggle-pill) 开关、「批次数量」(.batch-count) 整组。
// 稳定键取“首个非空识别属性”，顺序 text > title > aria > data-testid；
// 显示名优先取更贴近图标按钮语义的中文 title/aria（title 多为中文、aria 多为英文）。
const SRC_WORD = { text: "文本", title: "提示", aria: "图标", testid: "键", pill: "开关", batch: "批次" };

function abIdentify(el) {
  if (el.classList && el.classList.contains("batch-count")) {
    return { key: "bc:batch", label: "批次数量", src: "batch" };
  }
  if (el.classList && el.classList.contains("tl-toggle-pill")) {
    let p = normWs(el.textContent)
      .split("开启").join(" ")
      .split("关闭").join(" ")
      .split("启用").join(" ")
      .split("禁用").join(" ")
      .split("开").join(" ")
      .split("关").join(" ")
      .replace(/\s+/g, " ").trim();
    if (!p) p = normWs(el.textContent);
    return { key: "p:" + p, label: p, src: "pill" };
  }
  const t = normWs(el.textContent);
  const ti = normWs(el.getAttribute("title"));
  const a = normWs(el.getAttribute("aria-label"));
  const td = normWs(el.getAttribute("data-testid"));
  if (t) return { key: "t:" + t, label: t, src: "text" };
  if (ti) return { key: "y:" + ti, label: ti, src: "title" };
  if (a) return { key: "a:" + a, label: a, src: "aria" };
  if (td) return { key: "d:" + td, label: td, src: "testid" };
  return null;
}

// 收集“独立可隐藏单元”：先入大单元（pill / batch-count）并标记其全部子树，
// 再扫顶层 <button> 时跳过已被覆盖的；最终按 DOM 顺序返回。
function abScanEls() {
  const used = new Set();
  const units = [];

  const take = (el) => {
    if (isInDialog(el)) return;
    units.push(el);
    el.querySelectorAll("*").forEach((n) => used.add(n));
    used.add(el);
  };

  document.querySelectorAll(ACT_SEL + " .batch-count," + ACT_SEL + " .tl-toggle-pill").forEach(take);
  document.querySelectorAll(ACT_SEL + " button").forEach((el) => {
    if (isInDialog(el) || used.has(el)) return;
    take(el);
  });

  return units.slice().sort((a, b) => {
    const r = a.compareDocumentPosition(b);
    if (r & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (r & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

function abFindEls(key) {
  return abScanEls().filter((b) => { const id = abIdentify(b); return id && id.key === key; });
}

// 依 DOM 顺序抓取候选（按键去重），带 key/label/src
function abCandidates() {
  const seen = {};
  const res = [];
  abScanEls().forEach((el) => {
    const id = abIdentify(el);
    if (!id || seen[id.key]) return;
    seen[id.key] = 1;
    res.push(id);
  });
  return res;
}

// 显示名消歧：同名（如两个“运行”）时，从第 2 个起加来源后缀以区分
function abDisambiguate(list) {
  const cnt = {};
  list.forEach((c) => { cnt[c.label] = (cnt[c.label] || 0) + 1; });
  const used = {};
  return list.map((c) => {
    if (cnt[c.label] <= 1) return c;
    used[c.label] = (used[c.label] || 0) + 1;
    const dup = used[c.label];
    const sfx = SRC_WORD[c.src] || c.src;
    return { key: c.key, label: dup === 1 ? c.label : c.label + "（" + sfx + "）", src: c.src };
  });
}

let abEntries = [];
let abEl = null;

function abApply() {
  /* ★ 单次扫描 + 建映射（2026-10-06 性能）：原实现遍历 entries 时逐条调 abFindEls（abIdentify 对每个候选做一次解析），
   *  而它内部每次都做一次全文 querySelectorAll（ab 组还含排序/Set 去重）
   *  → O(条目数) 次全文扫描，整体 O(N²)。改为先扫一次、按 key 建映射，
   *  再按 entries 分发：降为 O(1) 次扫描。
   *  行为等价性：abFindEls 的语义正是「扫描结果里匹配 key 的全部元素」，映射只是把
   *  「每条筛一遍」改成「一次分组」，结果集合完全一致；且**不跨 Apply 复用**
   *  （各 Apply 仍各自扫描），不受阶段间 DOM 变化影响。
   *  另：isInDialog 只看 closest('[role="dialog"]')、不看可见性，故本函数
   *  自己设的 display:none 不会改变扫描结果。 */
  const byKey = new Map();
  for (const b of abScanEls()) {
    const id = abIdentify(b);
    if (!id || !id.key) continue;
    let arr = byKey.get(id.key);
    if (!arr) { arr = []; byKey.set(id.key, arr); }
    arr.push(b);
  }
  for (const e of abEntries) {
    for (const el of (byKey.get(e.text) || [])) {
        el.classList.toggle("abc-hide-btn", !!e.hidden);
        if (e.hidden) el.style.setProperty("display", "none", "important");
        else el.style.removeProperty("display");
    }
  }
}

function abRender() {
  renderCheckList(abEl, abEntries, hiddenMap.ab, abApply);
}

function abRebuild() {
  const cands = abDisambiguate(abCandidates());
  if (!cands.length) { abApply(); return; }
  abEntries = cands.map((c) => ({ text: c.key, label: c.label, hidden: !!hiddenMap.ab[c.key] }));
  abRender();
  abApply();
}

function abSync() {
  const keys = abCandidates().map((c) => c.key);
  if (!keys.length) { abApply(); return; }
  if (keys.length !== abEntries.length || keys.some((k, i) => !abEntries[i] || abEntries[i].text !== k)) {
    abRebuild();
  } else {
    abApply();
  }
}


// ═══════════ ③ 设置页面清单 ═══════════
// 目标：设置对话框左侧导航里的“全部设置页面”（分类项按钮）。
// 常规分组：用户、Comfy、画面、外观、3D、遮罩编辑器、快捷键、扩展、关于；
//  其他分组：对齐布局、🌐Language翻译语言、🪛Crystools工具组、HotReload、✨提示词小助手。
// 新旧兼容：遍历所有分组头(h3)所在导航容器，抓取其全部 button 即全部设置页面。
// 排除自身入口 ABC设置（避免把“设置”入口也隐藏掉导致无法再进入）。
function sgScanEls() {
  const out = [];
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return out;
  // 新版结构：dialog > nav(外层) > nav(分类导航) 内含多组：h3(分组标题) + button(分类页按钮)。
  // 旧版按固定名 h3“应用程序设置”分组匹配；版本更新后该分组头消失导致失效，
  // 现改为遍历所有分组头(h3)所在导航容器，抓取其中全部 button 即“全部设置页面”。
  const seen = new Set();
  const heads = dlg.querySelectorAll('h3');
  for (const h of heads) {
    const nav = h.closest('nav');
    if (!nav) continue;
    nav.querySelectorAll('[role="button"]').forEach((b) => {
      if (seen.has(b)) return;
      seen.add(b);
      const text = normWs(b.textContent);
      if (!text) return;
      if (text === CATEGORY) return;               // 排除自身“ABC设置”入口（forEach 回调只能用 return）
      out.push({ el: b, text });
    });
  }
  return out;
}

function sgFindEls(text) {
  return sgScanEls().filter((o) => o.text === text).map((o) => o.el);
}

let sgEntries = [];
let sgEl = null;

function sgApply() {
  /* ★ 单次扫描 + 建映射（2026-10-06 性能）：原实现遍历 entries 时逐条调 sgFindEls（sgScanEls 每次遍历全部 nav/h3），
   *  而它内部每次都做一次全文 querySelectorAll（ab 组还含排序/Set 去重）
   *  → O(条目数) 次全文扫描，整体 O(N²)。改为先扫一次、按 key 建映射，
   *  再按 entries 分发：降为 O(1) 次扫描。
   *  行为等价性：sgFindEls 的语义正是「扫描结果里匹配 key 的全部元素」，映射只是把
   *  「每条筛一遍」改成「一次分组」，结果集合完全一致；且**不跨 Apply 复用**
   *  （各 Apply 仍各自扫描），不受阶段间 DOM 变化影响。
   *  另：isInDialog 只看 closest('[role="dialog"]')、不看可见性，故本函数
   *  自己设的 display:none 不会改变扫描结果。 */
  const byText = new Map();
  for (const o of sgScanEls()) {
    let arr = byText.get(o.text);
    if (!arr) { arr = []; byText.set(o.text, arr); }
    arr.push(o.el);
  }
  for (const e of sgEntries) {
    for (const el of (byText.get(e.text) || [])) {
        el.classList.toggle("abc-hide-btn", !!e.hidden);
        if (e.hidden) el.style.setProperty("display", "none", "important");
        else el.style.removeProperty("display");
    }
  }
}

function sgRender() {
  renderCheckList(sgEl, sgEntries, hiddenMap.sg, sgApply);
}

function sgRebuild() {
  const items = sgScanEls();
  const texts = items.map((o) => o.text);
  const uniq = [];
  texts.forEach((t) => { if (uniq.indexOf(t) === -1) uniq.push(t); });
  if (!uniq.length) { sgApply(); return; }
  sgEntries = uniq.map((t) => ({ text: t, hidden: !!hiddenMap.sg[t] }));
  sgRender();
  sgApply();
}

function sgSync() {
  const items = sgScanEls();
  const texts = items.map((o) => o.text);
  const uniq = [];
  texts.forEach((t) => { if (uniq.indexOf(t) === -1) uniq.push(t); });
  if (!uniq.length) { sgApply(); return; }
  if (uniq.length !== sgEntries.length || uniq.some((t, i) => !sgEntries[i] || sgEntries[i].text !== t)) {
    sgRebuild();
  } else {
    sgApply();
  }
}

// ═══════════ ④ 模板页面清单 ═══════════
// 目标：ComfyUI 侧栏“模板”按钮打开的模板浏览对话框（左侧导航里的分类页按钮）。
// 与设置对话框同为 [role="dialog"] + nav + h3(分组头) + [role="button"](分类项)，
// 靠 nav 内 h2 文本为“模板”来区分模板对话框与其他对话框。
// 分组：所有模板/Popular/产品与广告/角色与时尚/品牌与设计（无分组头）
//       + 基础：图像/图像工具/视频/视频工具/音频/3D模型/☁️API…/节点基础/合作伙伴节点
//       + 扩展：各插件模板分组。
//
// 关键：模板对话框与设置对话框是两个互斥的模态框，无法同时打开。
// 因此不能像 sb/sg 那样只在对话框打开时才列出条目——否则清单永远是空的。
// 方案：把“模板对话框内发现过的分类项”缓存进 tpCache，并随设置文件一起持久化；
//   打开模板对话框时实时更新缓存；设置页始终用缓存渲染清单，
//   勾选后既写隐藏配置，也在模板对话框打开时实时生效。
function tpDialog() {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const d of dialogs) {
    const h2 = d.querySelector('nav h2');
    if (h2 && normWs(h2.textContent) === "模板") return d;
  }
  return null;
}

// 只扫当前模板对话框内实际存在的分类按钮（对话框未打开时返回空数组）
// 过滤：纯符号（如 "..."）、空文本、不可见（加载骨架/隐藏项）
function tpScanLive() {
  const out = [];
  const dlg = tpDialog();
  if (!dlg) return out;
  const seen = new Set();
  const push = (b) => {
    if (seen.has(b)) return;
    seen.add(b);
    const text = normWs(b.textContent);
    if (!text) return;
    if (!/[\p{L}\p{N}]/u.test(text)) return;     // 纯符号/省略号，跳过
    if (b.offsetParent === null) return;          // 不可见（骨架/隐藏），跳过
    out.push({ el: b, text });
  };
  dlg.querySelectorAll('nav [role="button"]').forEach(push);
  return out;
}

// 用一次完整实时列表“钉住”缓存（对话框已渲染完成时调用）：
// 直接以该列表为权威顺序，剔除历史脏项；缓存里已有的额外项保留在末尾。
function tpCachePin(labels) {
  const next = labels.slice();
  let changed = next.length !== tpCache.length;
  if (!changed) {
    for (let i = 0; i < next.length; i++) { if (next[i] !== tpCache[i]) { changed = true; break; } }
  }
  if (changed) tpCache = next;
  return changed;
}

// 清单数据源：优先实时（对话框开着），否则用缓存
function tpScanEls() {
  const live = tpScanLive();
  if (live.length >= 5) {
    // 列表已完整渲染：以实时结果为准重建缓存（顺带剔除 "..."/未翻译等历史脏项）
    if (tpCachePin(live.map((o) => o.text))) scheduleSave();
    return live;
  }
  if (live.length) return live;
  return tpCache.map((t) => ({ el: null, text: t }));
}

function tpFindEls(text) {
  return tpScanLive().filter((o) => o.text === text).map((o) => o.el);
}

let tpEntries = [];
let tpEl = null;

function tpApply() {
  /* ★ 单次扫描 + 建映射（2026-10-06 性能）：原实现遍历 entries 时逐条调 tpFindEls（内部走 tpScanLive 全文扫描），
   *  而它内部每次都做一次全文 querySelectorAll（ab 组还含排序/Set 去重）
   *  → O(条目数) 次全文扫描，整体 O(N²)。改为先扫一次、按 key 建映射，
   *  再按 entries 分发：降为 O(1) 次扫描。
   *  行为等价性：tpFindEls 的语义正是「扫描结果里匹配 key 的全部元素」，映射只是把
   *  「每条筛一遍」改成「一次分组」，结果集合完全一致；且**不跨 Apply 复用**
   *  （各 Apply 仍各自扫描），不受阶段间 DOM 变化影响。
   *  另：isInDialog 只看 closest('[role="dialog"]')、不看可见性，故本函数
   *  自己设的 display:none 不会改变扫描结果。 */
  const byText = new Map();
  for (const o of tpScanLive()) {
    let arr = byText.get(o.text);
    if (!arr) { arr = []; byText.set(o.text, arr); }
    arr.push(o.el);
  }
  for (const e of tpEntries) {
    for (const el of (byText.get(e.text) || [])) {
        el.classList.toggle("abc-hide-btn", !!e.hidden);
        if (e.hidden) el.style.setProperty("display", "none", "important");
        else el.style.removeProperty("display");
    }
  }
}

function tpRender() {
  renderCheckList(tpEl, tpEntries, hiddenMap.tp, tpApply);
}

function tpRebuild() {
  const items = tpScanEls();
  const texts = items.map((o) => o.text);
  const uniq = [];
  texts.forEach((t) => { if (uniq.indexOf(t) === -1) uniq.push(t); });
  if (!uniq.length) { tpApply(); return; }
  tpEntries = uniq.map((t) => ({ text: t, hidden: !!hiddenMap.tp[t] }));
  tpRender();
  tpApply();
}

function tpSync() {
  const items = tpScanEls();
  const texts = items.map((o) => o.text);
  const uniq = [];
  texts.forEach((t) => { if (uniq.indexOf(t) === -1) uniq.push(t); });
  if (!uniq.length) { tpApply(); return; }
  if (uniq.length !== tpEntries.length || uniq.some((t, i) => !tpEntries[i] || tpEntries[i].text !== t)) {
    tpRebuild();
  } else {
    tpApply();
  }
}
// ═══════════ 注入块构建（通用） ═══════════
function makeBlock(title, noRefresh) {
  const wrap = document.createElement("div");
  wrap.dataset.abcBlock = "1";
  wrap.className = "abc-sidebar-block";
  if (noRefresh) wrap.classList.add("abc-outer"); // 外层大清单容器标识

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;padding:8px 0;user-select:none;";
  const mark = document.createElement("span");
  mark.style.cssText = "display:inline-block;width:24px;color:#9ab;font-size:22px;line-height:1;text-align:center;";
  const h = document.createElement("h3");
  h.className = "text-base m-0";
  h.textContent = title;
  if (noRefresh) h.style.cssText = "font-size:22px;font-weight:700;";
  head.appendChild(mark);
  head.appendChild(h);
  if (!noRefresh) {
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "刷新";
    refresh.style.cssText = "margin-left:auto;padding:2px 10px;border:1px solid #888;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:12px;";
    refresh.addEventListener("click", (e) => { e.stopPropagation(); onRefresh(title); });
    head.appendChild(refresh);
  }
  wrap.appendChild(head);

  const items = document.createElement("div");
  items.className = "abc-sb-items";
  wrap.appendChild(items);

  // 折叠：写入内存 foldState 并统一去抖保存；初始状态读 foldState（无记录默认折叠）
  const fid = foldId(title);
  foldItems[fid] = items;
  head.addEventListener("click", () => {
    const folded = items.style.display === "none";
    setFoldDom(fid, !folded);
    foldState[fid] = folded ? "0" : "1"; // 现展开→折叠存"1"；现折叠→展开存"0"
    scheduleSave();
  });
  applyFoldAll();

  return { wrap, items };
}
function onRefresh(title) {
  if (title.indexOf("操作栏") === 0) abRebuild();
  else if (title.indexOf("应用程序设置") === 0) sgRebuild();
  else if (title.indexOf("设置页面") === 0) sgRebuild();   // 新：全部设置页面清单
  else if (title.indexOf("模板页面") === 0) tpRebuild();   // 新：模板页面清单
  else sbRebuild();
}

let abBlockEl = null;
let sbBlockEl = null;
let sgBlockEl = null;
let tpBlockEl = null;

// 隐藏 ABC设置 顶部的说明性占位项：仅为让 "ABC设置" 分类出现在左侧菜单而注册了一个原生 boolean 占位；该项无意义，注入完成后立即从 UI 中隐藏（不影响分类入口）。
function hideEntryPlaceholder() {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return;
  dlg.querySelectorAll(".setting-item").forEach((it) => {
    if (it.dataset && it.dataset.abcEntryHidden === "1") return;
    if ((it.textContent || "").indexOf(ENTRY_LABEL) !== -1) {
      it.style.display = "none";
      it.dataset.abcEntryHidden = "1";
    }
  });
}

// 在 ABC设置 分类内容容器内注入三个清单块（仅一次），并首次抓取
function ensureInjected() {
  let anchor = null;
  document.querySelectorAll(".setting-group").forEach((g) => {
    if (anchor) return;
    const kids = Array.from(g.children);
    const hasGrp = kids.some((el) => normWs(el.textContent) === GROUP_MAIN);
    const hasEntry = kids.some((el) => (el.textContent || "").indexOf(CATEGORY) !== -1);
    if (hasGrp || hasEntry) anchor = g;
  });
  if (!anchor) return;
  anchor.setAttribute("data-abc-group", "1"); // 标记 ABC设置 分组，原生标题据此加粗加大
  // 注入到 ABC设置 分类的 group 内部（而非其父容器），
  // 确保切换分类时 group 被隐藏，本页注入块也一并隐藏，不会残留在其他设置页下方。
  const holder = anchor;
  if (!holder || holder.querySelector("[data-abc-block]")) return;

  // 外层大清单容器：套住三个子清单
  const outer = makeBlock("画布UI按键清单", true);
  holder.appendChild(outer.wrap);

  const ab = makeBlock("操作栏（顶栏）");
  outer.items.appendChild(ab.wrap);
  abEl = ab.items;
  abBlockEl = ab.wrap;
  abRebuild();

  const sb = makeBlock("左侧导航侧栏");
  outer.items.appendChild(sb.wrap);
  sbEl = sb.items;
  sbBlockEl = sb.wrap;
  sbRebuild();

  const sg = makeBlock("设置页面");
  outer.items.appendChild(sg.wrap);
  sgEl = sg.items;
  sgBlockEl = sg.wrap;
  sgRebuild();

  const tp = makeBlock("模板页面");
  outer.items.appendChild(tp.wrap);
  tpEl = tp.items;
  tpBlockEl = tp.wrap;
  tpRebuild();

  // “使用来源”总开关：控制是否在画布节点库“全部节点”后注入“来源”视图（分插件罗列）
  const srcBox = document.createElement("div");
  srcBox.dataset.abcBlock = "1";
  srcBox.className = "abc-sidebar-block";
  const srcRow = document.createElement("div");
  srcRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 0;user-select:none;";
  const srcLab = document.createElement("h3");
  srcLab.className = "text-base m-0";
  srcLab.style.cssText = "font-size:22px;font-weight:700;";
  srcLab.textContent = "使用_插件节点来源";
  srcRow.appendChild(srcLab);
  srcBox.appendChild(srcRow);
  const srcBody = document.createElement("label");
  srcBody.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;";
  const srcCb = document.createElement("input");
  srcCb.type = "checkbox";
  srcCb.className = "abc-sw";
  srcCb.checked = !!sourceEnabled;
  const srcTxt = document.createElement("span");
  srcTxt.textContent = '在节点库"全部节点"前增加"插件节点"，展示自定义插件的节点';
  srcTxt.style.cssText = "font-size:12px;opacity:.9;line-height:1.4;";
  srcCb.addEventListener("change", () => {
    sourceEnabled = srcCb.checked;
    scheduleSave();
    srcSync();
  });
  srcBody.appendChild(srcCb);
  srcBody.appendChild(srcTxt);
  srcBox.appendChild(srcBody);
  holder.appendChild(srcBox);   // 与“画布UI按键清单”并列（同一层级），不受其折叠影响

  // “移动 节点ID标签/节点源标签”总开关：样式与“使用_插件节点来源”一致，控制 A000-2 是否把徽章搬进标题栏
  const tbBox = document.createElement("div");
  tbBox.dataset.abcBlock = "1";
  tbBox.className = "abc-sidebar-block";
  const tbRow = document.createElement("div");
  tbRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 0;user-select:none;";
  const tbLab = document.createElement("h3");
  tbLab.className = "text-base m-0";
  tbLab.style.cssText = "font-size:22px;font-weight:700;";
  tbLab.textContent = "移动 节点ID标签/节点源标签";
  tbRow.appendChild(tbLab);
  tbBox.appendChild(tbRow);
  const tbBody = document.createElement("label");
  tbBody.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;";
  const tbCb = document.createElement("input");
  tbCb.type = "checkbox";
  tbCb.className = "abc-sw";
  tbCb.checked = getTitleBadgeEnabled();
  const tbTxt = document.createElement("span");
  tbTxt.textContent = "把节点的“#ID / 节点来源”徽章从底部搬进标题栏，与标题同行显示";
  tbTxt.style.cssText = "font-size:12px;opacity:.9;line-height:1.4;";
  tbCb.addEventListener("change", () => {
    setTitleBadgeEnabled(tbCb.checked);
    scheduleSave();
    scanAll();
  });
  tbBody.appendChild(tbCb);
  tbBody.appendChild(tbTxt);
  tbBox.appendChild(tbBody);
  holder.appendChild(tbBox);   // 紧跟在“使用_插件节点来源”下方
}

// ═══════════ ④ 节点库“来源”视图 ═══════════
// 需求：在画布左侧“节点库”面板里“全部节点”标签后追加一个“来源”标签；点击后在面板内
// 按 custom_nodes 插件目录把各插件提供的节点分插件罗列出来。
// 来源判定：/object_info 里每个节点的 python_module 以 "custom_nodes." 开头即自定义插件节点，
//           其第 2 段即插件目录名（如 custom_nodes.000_ComfyUI_ABC -> 000_ComfyUI_ABC）。
// 总开关“使用来源”为 false 时移除注入；Vue 重渲染丢失节点时由心跳 srcSync() 自愈重注入。
const SRC_TAB_ID = "abc-src-tab";

function srcLocate() {
  const tab = document.getElementById("tab-all");
  if (!tab) return null;
  let layout = null;
  let cur = tab;
  while (cur && cur !== document.body) {
    const cn = " " + ((cur.className || "").toString()) + " ";
    if (cn.indexOf("flex-col") !== -1 && cur.children.length >= 2) { layout = cur; break; }
    cur = cur.parentElement;
  }
  if (!layout) return null;
  const nativeContent = layout.children[1];
  if (!nativeContent || nativeContent === tab) return null;
  return { tab, tabStrip: tab.parentElement, layout, nativeContent };
}

function srcLoadData() {
  if (srcData) return Promise.resolve(srcData);
  if (srcDataBusy) return srcDataBusy;
  srcDataBusy = (async () => {
    let groups = [];
    try {
      if (srcTrNodes === null) {
        try {
          const r = await fetch("/translation_node/get_translation", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "locale=zh-CN"
          });
          const j = await r.json();
          srcTrNodes = (j && j.Nodes) || {};
        } catch (e) { /* ★ 失败保持 null 以便下次重试（原实现固化 {} → 汉化标题永久缺失） */ }
      }
      const resp = await fetch("/object_info");
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const info = await resp.json();
      const map = {};
      for (const type in info) {
        const e = info[type];
        const pm = e && e.python_module;
        if (!pm || pm.indexOf("custom_nodes.") !== 0) continue;
        const segs = pm.split(".");
        const folder = segs.length >= 2 ? segs[1] : (pm || type);
        const cat = ((e && e.category) || "").trim();
        const zh2 = (srcTrNodes && srcTrNodes[type] && srcTrNodes[type].title) || "";
        const label = String(zh2).trim() || (e && e.display_name) || type;
        (map[folder] = map[folder] || []).push({ type: type, label: label, category: cat });
      }
      groups = Object.keys(map).filter(function (k) { return k !== ""; }).sort(function (a, b) {
        const x = a.toLowerCase(), y = b.toLowerCase();
        return x < y ? -1 : (x > y ? 1 : 0);
      }).map((folder) => {
        const list = map[folder].slice().sort(function (a, b) {
          const x = (a.category || "").toLowerCase(), y = (b.category || "").toLowerCase();
          if (x !== y) return x < y ? -1 : 1;
          const al = (a.label || "").toLowerCase(), bl = (b.label || "").toLowerCase();
          return al < bl ? -1 : (al > bl ? 1 : 0);
        });
        return { folder: folder, count: list.length, list: list };
      });
    } catch (err) {
      console.warn("[ABC] 获取节点来源失败", err);
      /* ★ 失败**不写入缓存**（2026-10-06）：原实现无条件 srcData = groups
       *  （失败时是空数组），而空数组为真值 → 下次 srcLoadData 首行的
       *  `if (srcData) return ...` 直接命中，「插件节点」面板永久空白，
       *  除非刷新整页。改为失败时保持 srcData = null，允许下次重试。 */
      srcDataBusy = false;
      return [];
    }
    srcData = groups;
    srcDataBusy = false;
    return groups;
  })();
  return srcDataBusy;
}

function srcRenderList() {
  if (!srcPanelEl) return;
  srcPanelEl.innerHTML = "";
  srcPanelEl.textContent = "加载中…";
  srcLoadData().then((groups) => {
    if (!srcPanelEl) return;
    srcPanelEl.innerHTML = "";
    if (!groups.length) { srcPanelEl.textContent = "未发现 custom_nodes 下的自定义插件节点。"; return; }

    function makeIcon(cls) {
      const i = document.createElement("i");
      i.className = cls;
      return i;
    }

    function addNode(nodeType, gx, gy) {
      try {
        if (!nodeType) return false;
        const appObj = app;
        const LG = window.LiteGraph;
        if (!LG || typeof LG.createNode !== "function") return false;
        const node = LG.createNode(nodeType);
        if (!node) {
          console.warn("[ABC] 未注册的节点类型: " + nodeType);
          return false;
        }
        const graph = (appObj && appObj.canvas && appObj.canvas.graph) || (appObj && appObj.graph) || null;
        if (!graph || !Array.isArray(graph.nodes)) {
          console.warn("[ABC] 无法取得活动画布图");
          return false;
        }
        let cx = 0, cy = 0, placed = false;
        try {
          const gcanvas = appObj && appObj.canvas;
          const ds = gcanvas && gcanvas.ds;
          if (ds && typeof ds.scale === "number" && Array.isArray(ds.offset)) {
            let w = 800, h = 600;
            const cvs = gcanvas.canvas;
            if (cvs && typeof cvs.getBoundingClientRect === "function") {
              const r = cvs.getBoundingClientRect();
              if (r && r.width) { w = r.width; h = r.height; }
            }
            const inv = 1 / (ds.scale || 1);
            cx = (w / 2 - (ds.offset[0] || 0)) * inv;
            cy = (h / 2 - (ds.offset[1] || 0)) * inv;
            placed = true;
          }
        } catch (e) {}
        if (!placed) {
          cx = 50 + (graph.nodes.length % 6) * 24;
          cy = 50 + (graph.nodes.length % 6) * 24;
        }
        let nw = 120, nh = 30;
        try { if (typeof node.computeSize === "function") { const s = node.computeSize(); if (s) { if (s[0]) nw = s[0]; if (s[1]) nh = s[1]; } } } catch (e) {}
        let px = cx, py = cy;
        if (typeof gx === "number" && typeof gy === "number" && isFinite(gx) && isFinite(gy)) { px = gx; py = gy; }
        node.pos = [Math.round(px - nw / 2), Math.round(py - 20)];
        graph.add(node);
        try { if (typeof node.onAdded === "function") node.onAdded(); } catch (e) {}
        try {
          const gcanvas = appObj && appObj.canvas;
          if (gcanvas && typeof gcanvas.setDirty === "function") gcanvas.setDirty(true, true);
          else if (typeof graph.setDirtyCanvas === "function") graph.setDirtyCanvas(true, true);
        } catch (e) {}
        return true;
      } catch (err) {
        console.warn("[ABC] 添加节点失败", err);
        return false;
      }
    }

    // 每条节点挂在 category 路径上。若无 category，则直接挂在该插件根下作为叶子。
    function folderNode() { return { name: "", children: {}, leaves: [] }; }
    function ensurePath(root, parts) {
      let cur = root;
      for (let a = 0; a < parts.length; a++) {
        const s = (parts[a] || "").trim();
        if (!s) continue;
        if (!cur.children[s]) cur.children[s] = folderNode();
        cur = cur.children[s];
        cur.name = s;
      }
      return cur;
    }
    const pluginMap = {};
    let total = 0;
    groups.forEach((g) => {
      total += g.count;
      const root = (pluginMap[g.folder] = pluginMap[g.folder] || folderNode());
      root.name = g.folder;
      g.list.forEach((n) => {
        const cat = (n.category || "").trim();
        if (cat) {
          const parts = cat.split("/");
          ensurePath(root, parts).leaves.push({ type: n.type, label: n.label });
        } else {
          root.leaves.push({ type: n.type, label: n.label });
        }
      });
    });

    function cmpLower(a, b) {
      const x = a.toLowerCase(), y = b.toLowerCase();
      return x < y ? -1 : (x > y ? 1 : 0);
    }
    function folderCount(n) {
      let c = n.leaves.length;
      for (const k in n.children) c += folderCount(n.children[k]);
      return c;
    }

    const pluginNames = Object.keys(pluginMap).sort(cmpLower);
    const head = document.createElement("div");
    head.style.cssText = "padding:10px 12px 6px;font-weight:700;border-bottom:1px solid rgba(128,128,128,.25);";
    head.textContent = "按插件名罗列 · " + pluginNames.length + " 个插件 · " + total + " 个节点";
    srcPanelEl.appendChild(head);

    const tree = document.createElement("div");
    tree.setAttribute("role", "tree");
    tree.className = "abc-src-tree";
    srcPanelEl.appendChild(tree);

    function appendLeaf(box, leaf, depth) {
      const it = document.createElement("div");
      it.className = "group/tree-node flex w-full min-w-0 cursor-pointer select-none items-center gap-3 overflow-hidden py-2 outline-none hover:bg-comfy-input rounded";
      it.style.cssText = "padding-left:" + (8 + (depth + 1) * 24) + "px;";
      it.style.cursor = "grab";
      it.setAttribute("role", "treeitem");
      it.setAttribute("aria-level", String(depth + 2));
      it.setAttribute("aria-selected", "false");
      it.dataset.nodeType = leaf.type;
      const nico = makeIcon("icon-[comfy--node] size-4 shrink-0 text-muted-foreground");
      const lb = document.createElement("span");
      lb.className = "text-foreground min-w-0 flex-1 truncate text-sm";
      lb.textContent = leaf.label;
      lb.title = leaf.label + "  (" + leaf.type + ")";
      it.appendChild(nico); it.appendChild(lb);

      // 供拖拽判定的闭包状态
      const st = { sx: 0, sy: 0, dragging: false, ghost: null };

      function screenToGraph(clientX, clientY) {
        try {
          const appObj = app;
          const gcanvas = appObj && appObj.canvas;
          const ds = gcanvas && gcanvas.ds;
          if (!ds || typeof ds.scale !== "number" || !Array.isArray(ds.offset)) return null;
          const cvs = gcanvas.canvas;
          if (!cvs || typeof cvs.getBoundingClientRect !== "function") return null;
          const r = cvs.getBoundingClientRect();
          if (!r) return null;
          const inv = 1 / (ds.scale || 1);
          return [
            (clientX - r.left - (ds.offset[0] || 0)) * inv,
            (clientY - r.top - (ds.offset[1] || 0)) * inv
          ];
        } catch (err) { return null; }
      }

      function isOverCanvas(clientX, clientY) {
        try {
          const appObj = app;
          const cvs = appObj && appObj.canvas && appObj.canvas.canvas;
          if (!cvs) return false;
          const r = cvs.getBoundingClientRect();
          if (!r) return false;
          return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
        } catch (err) { return false; }
      }

      function makeGhost(label) {
        const g = document.createElement("div");
        g.textContent = label;
        g.style.cssText = "position:fixed;z-index:2147483000;pointer-events:none;padding:5px 10px;" +
          "border:1px solid rgba(160,180,220,.7);border-radius:6px;background:rgba(24,26,30,.92);" +
          "color:#e8e8e8;font-size:12px;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.45);" +
          "left:-1000px;top:-1000px;";
        document.body.appendChild(g);
        return g;
      }
      function moveGhost(ev) {
        if (st.ghost) {
          st.ghost.style.left = (ev.clientX + 12) + "px";
          st.ghost.style.top = (ev.clientY + 12) + "px";
        }
      }
      function endDrag(ev, didDrag) {
        if (st.dragging) {
          st.dragging = false;
          if (didDrag && isOverCanvas(ev.clientX, ev.clientY)) {
            const gp = screenToGraph(ev.clientX, ev.clientY);
            if (gp) addNode(leaf.type, gp[0], gp[1]);
          }
        }
        if (st.ghost) { st.ghost.remove(); st.ghost = null; }
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
      }
      function onMove(ev) {
        if (!st.dragging) {
          if (Math.abs(ev.clientX - st.sx) > 5 || Math.abs(ev.clientY - st.sy) > 5) {
            st.dragging = true;
            it.style.cursor = "grabbing";
            st.ghost = makeGhost(leaf.label);
          }
        }
        if (st.dragging) moveGhost(ev);
      }
      function onUp(ev) {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        const wasDrag = st.dragging;
        endDrag(ev, wasDrag);
        if (wasDrag) { it.style.cursor = "grab"; }
      }

      it.addEventListener("mousedown", function (ev) {
        if (ev.button !== 0) return;
        st.sx = ev.clientX; st.sy = ev.clientY; st.dragging = false;
        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("mouseup", onUp, true);
      });

      it.addEventListener("click", function (ev) {
        // 仅普通单击（未发生拖拽位移）才放置到画布中心，避免与拖拽落点重复
        if (st.dragging) return;
        ev.preventDefault();
        addNode(leaf.type);
      });

      box.appendChild(it);
    }

    // 折叠状态：初始全部折叠
    function buildNode(box, node, depth, defaultExpanded) {
      const row = document.createElement("div");
      row.className = "group/tree-node flex w-full min-w-0 cursor-pointer select-none items-center gap-3 overflow-hidden py-2 outline-none hover:bg-comfy-input rounded";
      row.style.cssText = "padding-left:" + (8 + depth * 24) + "px;";
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      const initialExpanded = !!defaultExpanded;
      row.setAttribute("aria-expanded", initialExpanded ? "true" : "false");
      const chev = makeIcon("icon-[lucide--chevron-down] size-4 shrink-0 text-muted-foreground transition-transform");
      if (!initialExpanded) chev.style.transform = "rotate(-90deg)";
      const fico = makeIcon("icon-[lucide--folder] size-4 shrink-0 text-muted-foreground");
      const nm = document.createElement("span");
      nm.className = "text-foreground min-w-0 flex-1 truncate text-sm";
      nm.textContent = node.name;
      nm.title = node.name;
      const ct = document.createElement("span");
      ct.className = "text-muted-foreground text-xs";
      ct.textContent = "(" + folderCount(node) + ")";
      row.appendChild(chev); row.appendChild(fico); row.appendChild(nm); row.appendChild(ct);
      box.appendChild(row);

      const childBox = document.createElement("div");
      childBox.style.cssText = "display:flex;flex-direction:column;";
      if (!initialExpanded) childBox.style.display = "none";
      box.appendChild(childBox);

      const childNames = Object.keys(node.children).sort(cmpLower);
      // 子文件夹/叶子默认是否展开：按 defaultExpanded 传递
      const subDefault = !!defaultExpanded;
      childNames.forEach((cn) => buildNode(childBox, node.children[cn], depth + 1, subDefault));
      node.leaves.slice().sort(function (a, b) { return cmpLower(a.label, b.label); }).forEach((leaf) => {
        appendLeaf(childBox, leaf, depth);
      });

      row.addEventListener("click", function () {
        const exp = row.getAttribute("aria-expanded") === "true";
        const nx = !exp;
        row.setAttribute("aria-expanded", nx ? "true" : "false");
        childBox.style.display = nx ? "" : "none";
        chev.style.transform = nx ? "" : "rotate(-90deg)";
      });
    }

    function buildPlugin(box, pluginName, node) {
      // 顶层插件行也按目录节点同样渲染（深度=0）
      buildNode(box, node, 0, false);
    }

    function render() {
      tree.innerHTML = "";
      pluginNames.forEach((p) => {
        buildPlugin(tree, p, pluginMap[p]);
      });
    }

    render();
  });
}

// 保证“来源”标签 + 返回监听 + 分组面板存在（幂等，心跳可反复调用）
function srcEnsureDom(loc) {
  const nativeTab = loc.tab;
  if (!srcTabEl || !srcTabEl.isConnected) {
    srcActive = false;   // 旧标签已脱离 DOM，复位选中态，等待心跳重新判定
    srcTabEl = document.createElement("button");
    srcTabEl.type = "button";
    srcTabEl.id = SRC_TAB_ID;
    srcTabEl.textContent = "插件节点";
    srcTabEl.setAttribute("role", "tab");
    if (nativeTab && nativeTab.className) srcTabEl.className = nativeTab.className.toString();
    srcTabEl.style.marginLeft = "2px";
    srcTabEl.addEventListener("click", () => { srcActive = true; srcRefreshView(); });
    // 把“来源”放在“全部节点”前面：打开节点库时默认打开的即是“来源”
    if (nativeTab && nativeTab.parentNode) {
      nativeTab.parentNode.insertBefore(srcTabEl, nativeTab);
    } else {
      loc.tabStrip.appendChild(srcTabEl);
    }
  }
  if (nativeTab && !nativeTab.__abcSrcBound) {
    nativeTab.__abcSrcBound = true;
    nativeTab.addEventListener("click", () => { if (srcActive) { srcActive = false; srcRefreshView(); } });
  }
  if (!srcPanelEl || !srcPanelEl.isConnected) {
    srcDrawn = false;    // 面板被重建，内容需重新渲染（否则关闭重开后来源列表空白）
    srcPanelEl = document.createElement("div");
    srcPanelEl.style.cssText = "display:none;min-height:0;flex:1 1 0%;overflow-y:auto;overscroll-behavior:none;";
    loc.layout.appendChild(srcPanelEl);
  }
}

function srcRefreshView() {
  const loc = srcLocate();
  if (!loc) return;
  if (srcTabEl && srcTabEl.isConnected) {
    srcTabEl.setAttribute("aria-selected", srcActive ? "true" : "false");
    srcTabEl.style.backgroundColor = srcActive ? "rgb(49,50,53)" : "transparent";
  }
  const nativeTab = document.getElementById("tab-all");
  if (nativeTab) nativeTab.style.backgroundColor = srcActive ? "transparent" : "";
  if (srcActive) {
    loc.nativeContent.style.display = "none";
    if (srcPanelEl && srcPanelEl.isConnected) {
      srcPanelEl.style.display = "";
      if (!srcDrawn) { srcDrawn = true; srcRenderList(); }
    }
  } else {
    loc.nativeContent.style.display = "";
    if (srcPanelEl && srcPanelEl.isConnected) srcPanelEl.style.display = "none";
  }
}

function srcRemoveDom() {
  if (srcTabEl && srcTabEl.isConnected) srcTabEl.remove();
  if (srcPanelEl && srcPanelEl.isConnected) srcPanelEl.remove();
  const loc = srcLocate();
  if (loc) loc.nativeContent.style.display = "";
  const nativeTab = document.getElementById("tab-all");
  if (nativeTab) nativeTab.style.backgroundColor = "";
  srcTabEl = null;
  srcPanelEl = null;
  srcDrawn = false;
}

// 心跳入口：依据总开关决定 注入/维持 或 清理
function srcSync() {
  if (!sourceEnabled) {
    if (srcTabEl || srcPanelEl) { srcActive = false; srcRemoveDom(); }
    return;
  }
  const loc = srcLocate();
  if (!loc) {
    return;
  }
  srcEnsureDom(loc);
  srcRefreshView();
}

// ── 主循环 ─────────────────────────────────────────────────────
const applyAll = () => {
  sbSync();
  abSync();
  sgSync();
  tpSync();
  ensureInjected();
  hideEntryPlaceholder();
  srcSync();
};
// 高频 DOM 扫描最小间隔节流：吸收 ComfyUI 高频子元素增删的连发，
// 保证任意两次全量扫描间隔 ≥ SCAN_MIN_MS；trailing 兜底确保最后一次变更也被处理。
const SCAN_MIN_MS = 300;
let lastScanTs = 0;
let scanTimer = null;
function consumeApplyAll() {
  domDirty = false;                 // 变更已消费，复位门控标记
  applyAll();
}
function scheduleScan() {
  const now = Date.now();
  const wait = SCAN_MIN_MS - (now - lastScanTs);
  if (wait <= 0) { lastScanTs = now; consumeApplyAll(); return; }
  if (scanTimer) return;
  scanTimer = setTimeout(() => { scanTimer = null; lastScanTs = Date.now(); consumeApplyAll(); }, wait);
}
// MutationObserver 为主事件驱动：任何 DOM 变更置位 dirty 并触发（节流后）全量扫描
let domDirty = true;
new MutationObserver(() => { domDirty = true; scheduleScan(); })
  .observe(document.documentElement, { childList: true, subtree: true });

// 启动兜底：load(300ms) 与延时(1000ms) 两触发点竞速，仅首次真正执行一次完整重建+全量扫描
let booted = false;
function bootScan() {
  if (booted) return;
  booted = true;
  sbRebuild(); abRebuild(); sgRebuild(); tpRebuild(); applyAll();
}
window.addEventListener("load", () => setTimeout(bootScan, 300));
setTimeout(bootScan, 1000);
// 兜底心跳：仅当存在未消费的 DOM 变更才真正全量扫描；ComfyUI 空闲（无 DOM 变化）时每跳只读一个布尔，几乎零 CPU
setInterval(() => { if (domDirty && !document.hidden) scheduleScan(); }, 600);

// 启动：异步加载/迁移单文件配置，完成后首轮重建以应用隐藏
initStore();

injectStyleOnce("abc-settings-style",
  ".abc-sidebar-block{ padding:6px 0; border-top:1px solid rgba(128,128,128,.25); margin-top:8px; } .abc-sidebar-block h3{ font-size:16px; font-weight:700; } .setting-group[data-abc-group] > h3{ font-size:30px; font-weight:700; } .abc-hide-btn{ display:none !important; }"
  + ".abc-outer > .abc-sb-items > .abc-sidebar-block{ padding-left:16px; }"
  + ".abc-outer > .abc-sb-items > .abc-sidebar-block > .abc-sb-items{ padding-left:32px; }"
  + "input.abc-sw{ -webkit-appearance:none; appearance:none; width:34px; height:18px; flex:0 0 34px; margin:0; padding:0; border:1px solid rgba(128,128,128,.55); border-radius:9px; background:#3a3a3a; position:relative; cursor:pointer; transition:background .15s,border-color .15s; vertical-align:middle; }"
  + "input.abc-sw::after{ content:\"\"; position:absolute; top:1px; left:1px; width:14px; height:14px; border-radius:50%; background:#fff; transition:transform .15s; }"
  + "input.abc-sw:checked{ background:#1e90ff; border-color:#1e90ff; }"
  + "input.abc-sw:checked::after{ transform:translateX(16px); }"
  + "input.abc-sw:focus-visible{ outline:2px solid #1e90ff; outline-offset:2px; }");

