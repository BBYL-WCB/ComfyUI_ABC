"""000_ComfyUI_ABC 插件初始化（V3 注册）。

启动与导入优化：严格遵循「路径 → 导出 → 基础设施 → 业务模块」四层顺序。
  1) 路径层：WEB_DIRECTORY（字面量，永不可能失败）
  2) 导出层：NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS（**前置声明**，
     值为纯字符串 key 或占位 None，不引用任何尚未导入的类）
  3) 基础设施层：comfy_api / typing_extensions（各自 try 兜底）
  4) 业务层：A000-A004 各模块（各自独立 try，单个模块出错不影响其余节点注册）

设计要点（对应规范「导出优先声明」+「两段式 try」）：
  · 旧实现把两个 MAPPINGS 写在业务 import 之后，任一模块导入失败 → 整包抛异常 →
    全部节点消失；且 WEB_DIRECTORY 之后才失败会导致前端目录也读不到。
  · 现在业务层 import 之间互相隔离：任一模块崩了，其余照常注册；
    get_node_list() 按映射表过滤 None，只返回真正导入成功的类。
"""

# ── 第 1 层：路径（纯字面量，最先赋值，保证前端 js 目录一定能被宿主读到）────────
WEB_DIRECTORY = "./js"

# ── 第 2 层：导出（纯字面量声明，必须早于任何可能失败的 import）────────────────
# 值先占位为 None，随后由业务层「导入成功即写入」的方式填充实际类对象。
# 这样即便业务层全部失败，宿主仍能拿到一个（空）映射表而不是 ImportError。
NODE_CLASS_MAPPINGS = {
    "A002_ImageCrop": None,
    "UniversalSlider": None,
    "IgnoreGroup": None,
    "A001_SubgraphNode": None,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "A002_ImageCrop": "002_图片裁剪",
    "UniversalSlider": "003_万能滑条",
    "IgnoreGroup": "004_忽略组",
    "A001_SubgraphNode": "001_子图节点",
}

# ── 第 3 层：基础设施（各自 try，缺失时降级而非中断）──────────────────────────
# ComfyUI 加载器（nodes.py）优先读取 NODE_CLASS_MAPPINGS；comfy_entrypoint() 为
# V3 规范入口，二者为「双轨兼容」，任一不可用都不应影响另一条路径。
try:
    from comfy_api.latest import ComfyExtension
except Exception:  # pragma: no cover - 宿主环境异常时的降级路径
    ComfyExtension = None

try:
    from typing_extensions import override
except Exception:  # pragma: no cover

    def override(fn):
        """typing_extensions 缺失时的降级实现：原样返回被装饰函数。"""
        return fn


# ── 第 4 层：业务模块（逐模块 try，互不牵连）──────────────────────────────────
# 每个 import 独立失败域：任一节点模块导入报错，只跳过它自己的节点注册，
# 其余节点、WEB_DIRECTORY、两个 MAPPINGS 均已在前三层就位，不受影响。
#
# 失败必须留痕：原先各 except 静默吞异常，节点在菜单里消失时控制台没有任何线索，
# 排查只能靠逐个注释 import 二分。这里统一补一条 WARNING（模块名 + 异常摘要），
# 不改变任何注册结果。
import logging as _logging

_import_logger = _logging.getLogger("000_ComfyUI_ABC")


def _warn_import_failure(module: str, exc: BaseException) -> None:
    """记录业务模块导入失败：只补可诊断线索，不改变注册结果。"""
    _import_logger.warning(
        "模块 %s 导入失败，其节点不会注册：%s: %s", module, type(exc).__name__, exc
    )


try:
    from .A002_ImageCrop import ImageCrop

    NODE_CLASS_MAPPINGS["A002_ImageCrop"] = ImageCrop
except Exception as _e:  # noqa: BLE001
    ImageCrop = None
    _warn_import_failure("A002_ImageCrop", _e)

try:
    from .A003_UniversalSlider import UniversalSlider

    NODE_CLASS_MAPPINGS["UniversalSlider"] = UniversalSlider
except Exception as _e:  # noqa: BLE001
    UniversalSlider = None
    _warn_import_failure("A003_UniversalSlider", _e)

try:
    from .A004_IgnoreGroup import IgnoreGroup

    NODE_CLASS_MAPPINGS["IgnoreGroup"] = IgnoreGroup
except Exception as _e:  # noqa: BLE001
    IgnoreGroup = None
    _warn_import_failure("A004_IgnoreGroup", _e)

try:
    # 纯子图容器节点
    from .A001_SubgraphNode import SubgraphNode as A001SubgraphNode

    NODE_CLASS_MAPPINGS["A001_SubgraphNode"] = A001SubgraphNode
except Exception as _e:  # noqa: BLE001
    A001SubgraphNode = None
    _warn_import_failure("A001_SubgraphNode", _e)

# import 即触发模块级 @PromptServer 路由注册（A000 设置文件读写）。
# 失败仅意味着设置页读写不可用，不影响任何节点注册。
try:
    from . import A000_SettingsStore  # noqa: F401
except Exception as _e:  # noqa: BLE001
    A000_SettingsStore = None
    _warn_import_failure("A000_SettingsStore", _e)


# 清掉占位 None：宿主拿到的映射表只含真正可用的节点类。
NODE_CLASS_MAPPINGS = {k: v for k, v in NODE_CLASS_MAPPINGS.items() if v is not None}


class ABCExtension(ComfyExtension if ComfyExtension is not None else object):
    """聚合 A000-A004 全部 V3 节点的扩展入口。

    comfy_api 不可用（ComfyExtension 为 None）时退化为普通类，
    仍可由 NODE_CLASS_MAPPINGS 这条轨道完成注册。
    """

    if ComfyExtension is not None:

        @override
        async def get_node_list(self) -> list[type]:
            # 只返回导入成功的节点类，避免把 None 交给宿主。
            return list(NODE_CLASS_MAPPINGS.values())


async def comfy_entrypoint() -> ABCExtension:
    return ABCExtension()


__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "comfy_entrypoint",
    "ABCExtension",
]
