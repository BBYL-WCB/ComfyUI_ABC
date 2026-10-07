"""A001 子图节点（V3 API + Nodes 2.0 前端）。

一个空壳子图容器：节点自身承载一个内部子图，通过原生入口进入后自行搭建工作流。

- SubgraphNode：容器节点（node_id="A001_SubgraphNode"）。节点自身不预设任何输入/输出插槽。

本文件只定义节点类与双轨注册映射；注册聚合（comfy_entrypoint / ABCExtension）
统一在包 __init__.py。记录/还原 API 路由定义在本文件末尾（相机快照模式，
带 /a001 前缀与独立存储目录）。
"""

from __future__ import annotations

import asyncio
import ctypes
import json
import os
import re

from aiohttp import web

from comfy_api.latest import io
from server import PromptServer


# ---------------------------------------------------------------------------
# 节点类
# ---------------------------------------------------------------------------

class SubgraphNode(io.ComfyNode):
    """001_子图节点：空壳子图容器。

    node_id 采用名字 "A001_SubgraphNode"。
    节点自身不预设插槽，内部子图内容由用户自行搭建。
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="A001_SubgraphNode",
            display_name="001_子图节点",
            category="ABC",
            inputs=[],
            outputs=[],
        )

    @classmethod
    def execute(cls):
        """容器节点：无固定输入输出，执行结果为空。"""
        return io.NodeOutput()


# ---------------------------------------------------------------------------
# 注册（V3 双轨）
# ---------------------------------------------------------------------------

# 适配 000_ComfyUI_ABC 插件：NODE_CLASS_MAPPINGS 注册节点类，NODE_DISPLAY_NAME_MAPPINGS 设置显示名。
# 类本身已是 V3（io.ComfyNode）。ComfyUI 加载器（nodes.py）在同一模块内优先读取
# NODE_CLASS_MAPPINGS，server.node_info() 会通过 issubclass 检测到 V3 类并走 Schema
# （GET_NODE_INFO_V1）生成节点定义，execution.py 同样按 V3 路径执行。
# 注册聚合（comfy_entrypoint / ABCExtension）统一在包 __init__.py，本文件只定义节点类与双轨映射。
NODE_CLASS_MAPPINGS = {
    "A001_SubgraphNode": SubgraphNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "A001_SubgraphNode": "001_子图节点",
}


# ---------------------------------------------------------------------------
# 记录/还原 API：读写 js/A001/A001_Workflow 下的快照 JSON 文件
# 相机快照模式，带专属路由前缀与存储目录：
#   POST /a001/workflow/save   { title, data } → 写文件，同名自动加数字后缀
#   GET  /a001/workflow/list                 → 返回 { workflows: [{name,title,mtime}] }
#   POST /a001/workflow/load   { name }      → 返回文件 JSON 内容
#   POST /a001/workflow/delete { name }      → 删除记录文件
# ---------------------------------------------------------------------------

# 保存目录：本插件 js/A001/A001_Workflow（前端可经 /extensions 访问，方便人工核对）
# ★ 用 realpath 归一：插件目录经符号链接部署时，若 WF_DIR 不 realpath，
#   下方 realpath 前缀校验的基准与实际 join 基准会不同源 → 全部读写被误判非法。
WF_DIR = os.path.realpath(
    os.path.join(os.path.dirname(os.path.realpath(__file__)), "js", "A001", "A001_Workflow")
)

# Windows 保留设备名：以这些名字写文件会「返回成功但不落盘」，导致前端误以为已保存。
_WIN_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def _ensure_dir():
    os.makedirs(WF_DIR, exist_ok=True)


def _resolve_wf_path(name):
    """把请求传入的 name 解析为 WF_DIR 下的真实文件路径。

    先在 basename 层挡掉路径穿越，再用 realpath 前缀校验兜底，
    防止符号链接等场景绕过 basename。非法返回 None。
    """
    if not isinstance(name, str):
        return None
    # 过滤控制字符（含 NUL）：NUL 会截断后续 create_unicode_buffer / 路径拼接。
    safe = re.sub(r"[\x00-\x1f]", "", os.path.basename(name)).strip()
    if not safe:
        return None
    real_dir = os.path.realpath(WF_DIR)
    real_path = os.path.realpath(os.path.join(WF_DIR, safe))
    if real_path != real_dir and not real_path.startswith(real_dir + os.sep):
        return None
    # ★ 返回已校验的 real_path（而非重新拼接路径），消除「校验值与使用值不一致」的 TOCTOU。
    return real_path


def _safe_name(title):
    """去掉路径/非法字符，空或命中 Windows 保留名则用默认名，并限制长度。"""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(title)).strip()
    # Windows 不允许文件名以点/空格结尾；超长（>255 字节）会 OSError。
    name = name.rstrip(" .")
    if name.upper() in _WIN_RESERVED:
        name = "_" + name
    name = name[:120].rstrip(" .")
    return name or "未命名"


def _unique_path(title):
    """同名文件存在时加数字后缀（title.json → title_2.json → …）。"""
    _ensure_dir()
    base = _safe_name(title)
    path = os.path.join(WF_DIR, base + ".json")
    if not os.path.exists(path):
        return path, base
    i = 2
    while os.path.exists(os.path.join(WF_DIR, f"{base}_{i}.json")):
        i += 1
    return os.path.join(WF_DIR, f"{base}_{i}.json"), f"{base}_{i}"


def _write_workflow(title, data):
    """同步写文件（供 asyncio.to_thread 调用，避免阻塞事件循环）。

    返回 (name, title)；写失败抛异常，由调用方转 500。
    """
    path, base = _unique_path(title)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return base + ".json", base


def _read_workflow(path):
    """同步读文件（供 asyncio.to_thread 调用）。"""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


@PromptServer.instance.routes.post("/a001/workflow/save")
async def save_workflow(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    data = body.get("data")
    if data is None:
        return web.json_response({"error": "missing data"}, status=400)
    try:
        # 磁盘写入丢进线程，避免阻塞 aiohttp 事件循环（见《启动与导入优化》第六章）
        name, base = await asyncio.to_thread(_write_workflow, body.get("title") or "未命名", data)
    except Exception as e:  # noqa: BLE001
        return web.json_response({"error": f"write failed: {e}"}, status=500)
    return web.json_response({"name": name, "title": base})


def _list_workflows():
    """同步枚举快照目录（供 asyncio.to_thread 调用）。

    目录被外部删除 / 权限变更时返回 None（调用方转空列表），不抛 500。
    """
    _ensure_dir()
    try:
        entries = os.listdir(WF_DIR)
    except OSError:
        return None
    items = []
    for fn in entries:
        if not fn.lower().endswith(".json"):
            continue
        p = os.path.join(WF_DIR, fn)
        try:
            mtime = os.path.getmtime(p)
        except OSError:
            continue
        items.append({"name": fn, "title": fn[:-5], "mtime": mtime})
    items.sort(key=lambda x: -x["mtime"])
    return items


@PromptServer.instance.routes.get("/a001/workflow/list")
async def list_workflows(_request):
    # 目录扫描 + stat 丢线程，避免阻塞事件循环
    items = await asyncio.to_thread(_list_workflows)
    return web.json_response({"workflows": items or []})


async def _read_name_request(request):
    """解析 { name } 请求体并校验目标文件存在，返回 (path, None) 或 (None, 错误响应)。

    load / delete 两个接口共享同一段「JSON 解析 → 取 name → 路径校验 → 存在性校验」
    前置流程，错误响应结构与状态码逐字一致（invalid json 400 / missing name 400 /
    not found 404）。差异（读写动作与错误文案）留在各自接口内，不在此统一。
    """
    try:
        body = await request.json()
    except Exception:
        return None, web.json_response({"error": "invalid json"}, status=400)
    name = body.get("name")
    if not name:
        return None, web.json_response({"error": "missing name"}, status=400)
    path = _resolve_wf_path(name)  # 防路径穿越（basename + realpath 双重校验）
    if not path or not os.path.isfile(path):
        return None, web.json_response({"error": "not found"}, status=404)
    return path, None


@PromptServer.instance.routes.post("/a001/workflow/load")
async def load_workflow(request):
    path, err = await _read_name_request(request)
    if err is not None:
        return err
    try:
        # 读文件同样丢线程：大快照 JSON 的解析可能耗时，不能卡住事件循环
        data = await asyncio.to_thread(_read_workflow, path)
    except Exception as e:  # noqa: BLE001
        return web.json_response({"error": f"read failed: {e}"}, status=500)
    return web.json_response(data)


# ---------------------------------------------------------------------------
# 删除记录：移到回收站（Windows SHFileOperation API，无需额外依赖）
# ---------------------------------------------------------------------------

class _SHFILEOPSTRUCTW(ctypes.Structure):
    """Windows SHFILEOPSTRUCT（W 版），用于把文件移到回收站。"""

    _fields_ = [
        ("hwnd", ctypes.c_void_p),
        ("wFunc", ctypes.c_uint),
        ("pFrom", ctypes.c_wchar_p),
        ("pTo", ctypes.c_wchar_p),
        ("fFlags", ctypes.c_ushort),
        ("fAnyOperationsAborted", ctypes.c_int),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", ctypes.c_wchar_p),
    ]


def _send_to_recycle_bin(path: str) -> bool:
    """把文件移动到回收站。

    返回 True 表示已进回收站、可恢复；返回 False 表示回收站不可用，
    已回退为永久删除（不可恢复）。
    """
    if os.name != "nt":
        try:
            os.remove(path)
        except FileNotFoundError:
            pass  # 目标已不存在：视为删除成功，不误报 500
        return False
    p_from = ctypes.create_unicode_buffer(path + "\0")  # 双 null 结尾（SHFileOperation 要求）
    op = _SHFILEOPSTRUCTW()
    op.wFunc = 3  # FO_DELETE
    op.pFrom = ctypes.cast(p_from, ctypes.c_wchar_p)
    # FOF_ALLOWUNDO(0x40)|FOF_NOCONFIRMATION(0x10)|FOF_SILENT(0x04)|FOF_NOERRORUI(0x400)
    op.fFlags = 0x40 | 0x10 | 0x04 | 0x0400
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if result == 0 and not op.fAnyOperationsAborted:
        return True
    # 回收站不可用（如网络盘/已禁用回收站）→ 回退永久删除（不可恢复）
    try:
        os.remove(path)
    except FileNotFoundError:
        pass  # 目标已不存在：视为删除成功，不误报 500
    return False


@PromptServer.instance.routes.post("/a001/workflow/delete")
async def delete_workflow(request):
    path, err = await _read_name_request(request)
    if err is not None:
        return err
    try:
        # Shell 回收站调用是同步阻塞的，丢线程避免卡住事件循环
        recycled = await asyncio.to_thread(_send_to_recycle_bin, path)
    except Exception as e:  # noqa: BLE001
        return web.json_response({"error": f"delete failed: {e}"}, status=500)
    return web.json_response({"ok": True, "name": os.path.basename(path), "recycled": recycled})


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]