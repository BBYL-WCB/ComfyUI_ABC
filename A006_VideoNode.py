"""A006 视频节点（V3 API + Nodes 2.0 前端）。

一个可定制界面的容器节点：双击节点即可进入内部子图编辑空间。

- VideoNode：容器节点（node_id="A006_VideoNode"）。外部「视频01」输出槽透传
  子图内部产出的视频；本版本用 io.Video.Input / io.Video.Output 表示 VIDEO 数据，
  前端预览由 executed / execution_cached 事件回灌机制（js/A006/A006_exec.js）负责。
- FeedVideo：内部供视频节点（is_dev_only，不显示在节点菜单），供「运行」按钮
  局部执行时读取视频文件。

本文件只定义节点类与双轨注册映射；注册聚合（comfy_entrypoint / ABCExtension）
统一在包 __init__.py。
"""

from __future__ import annotations

import ctypes
import json
import os
import re

import folder_paths
from aiohttp import web

from comfy_api.latest import InputImpl, io
from server import PromptServer


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def _resolve_path(base_dir: str, subfolder: str, filename: str) -> str:
    """组合基础目录、子文件夹、文件名得到完整路径。"""
    if subfolder:
        return os.path.join(base_dir, subfolder, filename)
    return os.path.join(base_dir, filename)


# ---------------------------------------------------------------------------
# 节点类
# ---------------------------------------------------------------------------

class VideoNode(io.ComfyNode):
    """006 视频节点：双击进入内部子图。

    node_id 采用名字 "A006_VideoNode"。
    外部预留的输入/输出插槽与子图内部 inputNode/outputNode 的插槽一一对应；
    「视频01」输出仅用于把子图内部产出视频回灌为预览。
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="A006_VideoNode",
            display_name="006_视频节点",
            category="ABC",
            description="视频节点：双击进入内部子图，子图产出视频经「视频01」输出。",
            inputs=[
                io.String.Input("文本", default="", multiline=True),
                io.Video.Input("videos", optional=True),
            ],
            outputs=[
                io.Video.Output("视频01"),
            ],
        )

    @classmethod
    def execute(cls, 文本: str = "", videos=None):
        """透传子图内部产出视频到输出槽（io.Video.Output），前端预览由 executed 事件回灌。

        未连接视频（videos 为 None）时透传 None，不产出预览，与旧版行为一致。
        """
        return io.NodeOutput(videos)


class FeedVideo(io.ComfyNode):
    """读取一个已生成的视频文件并作为 VIDEO 数据输出。

    供 A006「运行」按钮局部执行使用：链路 A→B 中点 B 运行时，前端临时创建
    本节点读取 A 上次保存的预览视频传输给 B，A 及其上游不再重新执行。
    is_dev_only=True：不显示在节点菜单（前端核心按 object_info.dev_only 加入 skip_list），
    但保持注册与可执行（前端 createNode 仍可创建）。
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="A006_FeedVideo",
            display_name="006_供视频(内部)",
            category="ABC/_internal",
            description="读取视频文件作为 VIDEO 输出（内部供视频用）。",
            is_dev_only=True,
            inputs=[
                io.String.Input("filename", default=""),
                io.String.Input("subfolder", default=""),
                io.Combo.Input("path_type", options=["temp", "output", "input"], default="temp"),
            ],
            outputs=[
                io.Video.Output("视频"),
            ],
        )

    @classmethod
    def execute(cls, filename: str, subfolder: str = "", path_type: str = "temp"):
        """按 folder_paths 规则定位文件并作为 VIDEO 数据返回。"""
        base_dir = folder_paths.get_directory_by_type(path_type)
        if not base_dir:
            raise ValueError(f"未知的路径类型: {path_type}")

        full_path = _resolve_path(base_dir, subfolder, filename)
        # 防路径穿越：subfolder / filename 为用户可控，解析后的真实路径必须仍在 base_dir 内
        real_base = os.path.realpath(base_dir)
        real_full = os.path.realpath(full_path)
        if real_full != real_base and not real_full.startswith(real_base + os.sep):
            raise ValueError("非法路径: 超出允许目录")
        if not os.path.isfile(full_path):
            raise FileNotFoundError(f"视频不存在: {full_path}")

        video = InputImpl.VideoFromFile(str(full_path))
        return io.NodeOutput(video)


# ---------------------------------------------------------------------------
# 注册（V3 双轨）
# ---------------------------------------------------------------------------

# 适配 000_ComfyUI_ABC 插件：NODE_CLASS_MAPPINGS 注册节点类，NODE_DISPLAY_NAME_MAPPINGS 设置显示名。
# 类本身已是 V3（io.ComfyNode）。ComfyUI 加载器（nodes.py）在同一模块内优先读取
# NODE_CLASS_MAPPINGS，server.node_info() 会通过 issubclass 检测到 V3 类并走 Schema
# （GET_NODE_INFO_V1）生成节点定义，execution.py 同样按 V3 路径执行。
# 注册聚合（comfy_entrypoint / ABCExtension）统一在包 __init__.py，本文件只定义节点类与双轨映射。
NODE_CLASS_MAPPINGS = {
    "A006_VideoNode": VideoNode,
    "A006_FeedVideo": FeedVideo,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "A006_VideoNode": "006_视频节点",
    "A006_FeedVideo": "006_供视频(内部)",
}


# ---------------------------------------------------------------------------
# 记录/还原 API：读写 js/A006/A006_VideoWorkflow 下的工作流 JSON 文件
# 路由：
#   POST /a006/workflow/save   { title, data } → 写文件，同名自动加数字后缀
#   GET  /a006/workflow/list                 → 返回 { workflows: [{name,title,mtime}] }
#   POST /a006/workflow/load   { name }      → 返回文件 JSON 内容
#   POST /a006/workflow/delete { name }      → 删除记录文件
# ---------------------------------------------------------------------------

# 保存目录：本插件 js/A006/A006_VideoWorkflow（前端可经 /extensions 访问，方便人工核对）
WF_DIR = os.path.join(os.path.dirname(__file__), "js", "A006", "A006_VideoWorkflow")


def _ensure_dir():
    os.makedirs(WF_DIR, exist_ok=True)


def _resolve_wf_path(name):
    """把请求传入的 name 解析为 WF_DIR 下的真实文件路径。

    先在 basename 层挡掉路径穿越，再用 realpath 前缀校验兜底（与 FeedVideo.execute 同策略），
    防止符号链接等场景绕过 basename。非法返回 None。
    """
    safe = os.path.basename(str(name)).strip()
    if not safe:
        return None
    path = os.path.join(WF_DIR, safe)
    real_dir = os.path.realpath(WF_DIR)
    real_path = os.path.realpath(path)
    if real_path != real_dir and not real_path.startswith(real_dir + os.sep):
        return None
    return os.path.join(WF_DIR, safe)


def _safe_name(title):
    """去掉路径/非法字符，空则用默认名。"""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(title)).strip()
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


@PromptServer.instance.routes.post("/a006/workflow/save")
async def save_workflow(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    data = body.get("data")
    if data is None:
        return web.json_response({"error": "missing data"}, status=400)
    try:
        path, base = _unique_path(body.get("title") or "未命名")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:  # noqa: BLE001
        return web.json_response({"error": f"write failed: {e}"}, status=500)
    return web.json_response({"name": base + ".json", "title": base})


@PromptServer.instance.routes.get("/a006/workflow/list")
async def list_workflows(_request):
    _ensure_dir()
    items = []
    try:
        entries = os.listdir(WF_DIR)
    except OSError:
        # 目录被外部删除 / 权限变更时不抛 500，返回空列表
        return web.json_response({"workflows": []})
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
    return web.json_response({"workflows": items})


@PromptServer.instance.routes.post("/a006/workflow/load")
async def load_workflow(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    name = body.get("name")
    if not name:
        return web.json_response({"error": "missing name"}, status=400)
    path = _resolve_wf_path(name)  # 防路径穿越（basename + realpath 双重校验）
    if not path or not os.path.isfile(path):
        return web.json_response({"error": "not found"}, status=404)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
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
        os.remove(path)
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
    os.remove(path)
    return False


@PromptServer.instance.routes.post("/a006/workflow/delete")
async def delete_workflow(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    name = body.get("name")
    if not name:
        return web.json_response({"error": "missing name"}, status=400)
    path = _resolve_wf_path(name)  # 防路径穿越（basename + realpath 双重校验）
    if not path or not os.path.isfile(path):
        return web.json_response({"error": "not found"}, status=404)
    try:
        recycled = _send_to_recycle_bin(path)
    except Exception as e:  # noqa: BLE001
        return web.json_response({"error": f"delete failed: {e}"}, status=500)
    return web.json_response({"ok": True, "name": os.path.basename(path), "recycled": recycled})


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]