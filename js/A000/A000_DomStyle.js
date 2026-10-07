// ═══════════════════════════════════════════════════════════════
//  A000 · 公共 DOM 工具：一次性样式注入
//
//  背景：原先 A000_Port / A000_TagMove / A001_slider / A001_textarea_resize /
//  A001_workflow / A002_ImageCrop / A003_UniversalSlider / A004_IgnoreGroup
//  各自维护一份同构样板（模块级布尔标志 + createElement("style") + appendChild），
//  且健壮性不一：只认标志的实现，在 <style> 被界面框架清掉后会永久丢失样式。
//
//  现统一下沉到本模块，以「目标 <style> 是否仍在 DOM 中」作为唯一幂等判据：
//  · 正常路径行为不变（同一 styleId 仍只注入一次）
//  · 元素被清掉后会自动补注入（原「只认标志」的实现做不到）
//
//  本模块只依赖 document，处于依赖图最底层，不 import 任何其他模块。
// ═══════════════════════════════════════════════════════════════

/**
 * 按 styleId 幂等地向 <head> 注入一段样式。
 *
 * @param {string} styleId <style> 元素的 id，同时作为幂等键（各模块需保证唯一）。
 * @param {string} cssText 样式文本。
 * @returns {boolean} 本次是否真的创建并插入了 <style>（幂等命中返回 false）。
 */
export function injectStyleOnce(styleId, cssText) {
    if (typeof document === "undefined") return false;
    if (document.getElementById(styleId)) return false;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = cssText;
    document.head.appendChild(style);
    return true;
}
