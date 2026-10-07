"""000_ComfyUI_ABC · A000 设置数据文件存储

提供设置页（js/A000/A000_SettingsPage.js）读写持久化配置文件的 HTTP 路由。
数据只存一个文件 js/A000/A000-ABCsettings.json，内容是"被隐藏的按键 + 折叠偏好"。

路由：
  GET  /a000/settings  -> 有文件返回 { exists:true, data }; 无文件返回 { exists:false }
  POST /a000/settings  -> 以 data 整体覆盖写入唯一配置文件

健壮性（避免单配置文件损坏）：
  · 写入采用「临时文件 + 原子替换(os.replace)」：中途崩溃不会留下半写/截断的
    A000-ABCsettings.json；读取侧对坏文件同样容错返回 exists:false，由前端按无文件处理。
"""

import asyncio
import json
import os
from aiohttp import web
from server import PromptServer

# 配置目录：本插件 js/A000（A000 前端文件 A000_SettingsPage.js 与数据文件同在此目录）
A000_DIR = os.path.join(os.path.dirname(__file__), "js", "A000")
SETTINGS_FILE = os.path.join(A000_DIR, "A000-ABCsettings.json")
# 唯一配置文件的原子写临时名（同目录，写毕 os.replace 覆盖为 A000-ABCsettings.json）
_SETTINGS_TMP = SETTINGS_FILE + ".tmp"


def _ensure_dir() -> None:
    os.makedirs(A000_DIR, exist_ok=True)


def _load_settings():
    """读取配置文件；文件缺失或内容损坏均返回 None（由前端按无文件/默认处理）。

    返回 dict 仅在文件完整且可解析时给出，绝不抛出导致 500。
    """
    if not os.path.isfile(SETTINGS_FILE):
        return None
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        # 损坏/半写/编码异常：不把坏内容当配置，交给前端走默认(全显示)
        return None
    return data if isinstance(data, dict) else None


def _write_settings(data: dict) -> None:
    """同步落盘：临时文件写入 + 原子替换。

    抽为独立同步函数，便于由路由经 asyncio.to_thread 丢到线程池执行，
    避免磁盘 IO 阻塞事件循环（启动与导入优化 · 第六节「不阻塞事件循环」）。
    失败时清理残留临时文件后原样抛出，由调用方转为 500。
    """
    try:
        _ensure_dir()
        with open(_SETTINGS_TMP, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(_SETTINGS_TMP, SETTINGS_FILE)
    except Exception:
        # 清理可能残留的临时文件，避免下次读到陈旧数据
        try:
            if os.path.isfile(_SETTINGS_TMP):
                os.remove(_SETTINGS_TMP)
        except OSError:
            pass
        raise


@PromptServer.instance.routes.get("/a000/settings")
async def get_settings(_request):
    """读取配置：无文件/损坏时返回 { exists:false }，由前端决定"恢复默认(全显示)"。

    磁盘读经 to_thread 移出事件循环：配置文件虽小，但读盘期间不应阻塞
    其它节点的 HTTP 请求（规范第六节）。
    """
    data = await asyncio.to_thread(_load_settings)
    if data is None:
        return web.json_response({"exists": False})
    return web.json_response({"exists": True, "data": data})


@PromptServer.instance.routes.post("/a000/settings")
async def post_settings(request):
    """整体覆盖写入唯一配置文件（保存不要多就一个）。

    原子写：先写 A000-ABCsettings.json.tmp，成功后再 os.replace 覆盖，避免中断半写。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    data = body.get("data")
    if not isinstance(data, dict):
        return web.json_response({"error": "missing data"}, status=400)
    try:
        # 写盘 + os.replace 全在线程池执行：事件循环在此期间可继续处理其它请求。
        await asyncio.to_thread(_write_settings, data)
    except Exception as e:
        return web.json_response({"error": f"write failed: {e}"}, status=500)
    return web.json_response({"ok": True})


__all__ = ["SETTINGS_FILE"]
