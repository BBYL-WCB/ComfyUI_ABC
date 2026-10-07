"""A002 图片裁剪节点（V3 API + Nodes 2.0 前端）。

用法与 legacy 版完全一致：接收 base64 图片与裁剪参数，输出图像/遮罩/宽度/高度。
"""

import base64
import hashlib
import io as _io
import json
import logging
import os
import threading
from collections import OrderedDict

import torch
import numpy as np
from PIL import Image

import folder_paths
from comfy_api.latest import io

logger = logging.getLogger(__name__)

# ---- base64 解码 LRU 缓存 ----
# 同一张图片在调整裁剪参数（拖拽、改尺寸等）时会反复触发节点执行，
# 每次都会重新解码 base64（2048x2048 图片实测约 93ms）。
# 按 base64 内容 hash 缓存解码结果，命中时仅需 ~0.02ms 查 key。
# 限制条目上限：每张 2048x2048 float32 图约 50MB，防止缓存导致内存膨胀。
_DECODE_CACHE_MAX = 4
_decode_cache = OrderedDict()
# ComfyUI 执行队列可能并发调用节点，用锁保护缓存读写（解码在锁外执行，锁粒度极小）
_decode_lock = threading.Lock()
# md5 短路缓存：同一张图在反复调整裁剪参数（拖拽、改尺寸）时，base64 字符串内容完全一致。
# 此时直接复用上一次的 md5 摘要，避免对 ~11MB 字符串做全量 hash 扫描
# （实测 md5 约 24.5ms vs 字符串比较约 4.7ms，命中路径总耗时下降约 80%）。
_last_base64 = None
_last_key = None


def _resolve_ref_path(ref) -> str:
    """把 ``ref:{filename, subfolder, type}`` 解析为允许目录内的真实文件路径；非法返回 None。

    ★ 不依赖宿主 ``get_annotated_filepath`` 的 ``[type]`` 后缀解析：实测当前宿主
    ``annotated_filepath`` 对三种后缀均多截 1 个字符（``[input]`` 走 ``name[:-8]``），
    会把 ``a.png[input]`` 解析成 ``a.pn``，使引用图必然加载失败并静默回落黑图。
    此处显式按 type 选目录再拼接，并做「真实路径必须仍在基目录内」的归属校验
    （防 ``subfolder`` 中塞 ``..`` 造成目录穿越，与 A001 快照路由 ``_resolve_wf_path`` 同策略）。
    """
    if not isinstance(ref, dict):
        return None
    filename = ref.get("filename", "")
    subfolder = ref.get("subfolder", "") or ""
    ftype = ref.get("type", "input") or "input"
    if not isinstance(filename, str) or not filename:
        return None
    if not isinstance(subfolder, str):
        subfolder = ""
    if ftype == "output":
        base_dir = folder_paths.get_output_directory()
    elif ftype == "temp":
        base_dir = folder_paths.get_temp_directory()
    else:
        base_dir = folder_paths.get_input_directory()
    real_dir = os.path.realpath(base_dir)
    real_path = os.path.realpath(os.path.join(real_dir, subfolder, filename))
    within = getattr(folder_paths, "is_within_directory", None)
    if callable(within):
        try:
            if not within(real_dir, real_path):
                return None
        except Exception:
            return None
    elif real_path != real_dir and not real_path.startswith(real_dir + os.sep):
        return None
    if not os.path.isfile(real_path):
        return None
    return real_path


class ImageCrop(io.ComfyNode):
    """图片裁剪节点：根据指定参数裁剪图片。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="A002_ImageCrop",
            display_name="002_图片裁剪",
            category="ABC",
            description="图片裁剪节点：根据指定参数裁剪图片",
            inputs=[
                io.String.Input("image_base64", default="", multiline=True),
                io.Int.Input("crop_x", default=0, min=-4096, max=4096, step=1),
                io.Int.Input("crop_y", default=0, min=-4096, max=4096, step=1),
                io.Int.Input("crop_width", default=1024, min=1, max=8192, step=1),
                io.Int.Input("crop_height", default=1024, min=1, max=8192, step=1),
                io.String.Input("aspect_ratio", default="free"),
                io.String.Input("fill_color", default="#000000"),
            ],
            outputs=[
                io.Image.Output("图像"),
                io.Mask.Output("遮罩"),
                io.Int.Output("宽度"),
                io.Int.Output("高度"),
            ],
        )

    @staticmethod
    def load_image_from_base64(image_base64):
        """从 base64 字符串或文件引用加载图片（带 LRU 缓存，避免同一图片重复解码）。

        支持两种输入：
          1. base64 / data URL —— 直接解码
          2. ``ref:`` 前缀 + JSON —— 按 {filename, subfolder, type} 从 input 目录加载
             （对齐官方 LoadImage：工作流只存引用，后端按引用读文件，避免内嵌 base64 膨胀）
        """
        if not image_base64 or not image_base64.strip():
            return None, 2048, 2048

        value = image_base64.strip()

        # ── 引用模式：从 input 目录按文件名加载 ──
        if value.startswith("ref:"):
            try:
                ref = json.loads(value[4:])
                # ★ 按 type 显式解析目录并做归属校验（不再走宿主有截断缺陷的 [type] 解析）
                image_path = _resolve_ref_path(ref)
                if not image_path:
                    logger.error(f"Ref image rejected (missing or out of allowed dirs): {value[:120]}")
                    return None, 2048, 2048
                img_pil = Image.open(image_path)
                if img_pil.mode != "RGB":
                    img_pil = img_pil.convert("RGB")
                source_width = img_pil.size[0]
                source_height = img_pil.size[1]
                img_np = np.asarray(img_pil, dtype=np.float32)
                img_np *= (1.0 / 255.0)
                source_img_tensor = torch.from_numpy(img_np)
                return source_img_tensor, source_width, source_height
            except Exception as e:
                logger.error(f"Error loading image from ref: {e}")
                return None, 2048, 2048

        # ── base64 模式：直接解码 ──
        # 以 md5 摘要作为缓存键：避免超长 base64 字符串直接作为 key 的内存开销
        # 同一张图反复执行时 base64 内容不变，先复用上一次的摘要，命中则跳过全量 md5 扫描
        global _last_base64, _last_key
        cache_key = None
        if _last_base64 is not None and image_base64 == _last_base64:
            cache_key = _last_key

        if cache_key is None:
            try:
                cache_key = hashlib.md5(image_base64.encode("utf-8")).hexdigest()
            except Exception:
                cache_key = None
            if cache_key is not None:
                # 更新短路缓存（与解码缓存共用锁；竞态仅导致多算一次 md5，无正确性影响）
                with _decode_lock:
                    _last_base64 = image_base64
                    _last_key = cache_key

        if cache_key is not None:
            with _decode_lock:
                cached = _decode_cache.get(cache_key)
                if cached is not None:
                    # LRU：命中条目移到末尾，便于淘汰最久未使用
                    _decode_cache.move_to_end(cache_key)
                    return cached

        try:
            # 处理可能的 data URL 格式
            base64_data = image_base64.strip()
            if "," in base64_data:
                base64_data = base64_data.split(",")[-1]

            # 解码 base64
            img_bytes = base64.b64decode(base64_data)
            img_pil = Image.open(_io.BytesIO(img_bytes))

            # 转换为 RGB
            if img_pil.mode != "RGB":
                img_pil = img_pil.convert("RGB")

            source_width = img_pil.size[0]
            source_height = img_pil.size[1]

            # 转换为 numpy 数组并归一化到 0-1
            img_np = np.asarray(img_pil, dtype=np.float32)
            img_np *= (1.0 / 255.0)
            source_img_tensor = torch.from_numpy(img_np)

            result = (source_img_tensor, source_width, source_height)

            # 写入缓存，超出上限时淘汰最久未使用的条目
            if cache_key is not None:
                with _decode_lock:
                    _decode_cache[cache_key] = result
                    if len(_decode_cache) > _DECODE_CACHE_MAX:
                        evicted_key, _ = _decode_cache.popitem(last=False)
                        # 被淘汰的恰是短路缓存引用的图片：一并释放其 MB 级 base64 字符串
                        if evicted_key == _last_key:
                            _last_base64 = None
                            _last_key = None

            return result
        except Exception as e:
            logger.error(f"Error loading image from base64: {e}")
            return None, 1024, 1024

    @staticmethod
    def parse_fill_color(fill_color):
        """解析填充颜色（支持十六进制和 RGB 格式）。"""
        try:
            fill_color = fill_color.strip()
            if fill_color.startswith("#"):
                # 十六进制格式：#RRGGBB 或 #RGB
                hex_color = fill_color.lstrip("#")
                if len(hex_color) == 3:
                    # 短格式 #RGB -> #RRGGBB
                    hex_color = "".join(c * 2 for c in hex_color)
                if len(hex_color) == 6:
                    fill_rgb = [int(hex_color[i:i + 2], 16) for i in (0, 2, 4)]
                else:
                    fill_rgb = [0, 0, 0]
            else:
                # RGB 格式：r,g,b
                fill_rgb = [int(c.strip()) for c in fill_color.split(",")]
                if len(fill_rgb) != 3:
                    fill_rgb = [0, 0, 0]
            fill_rgb = [max(0, min(255, c)) for c in fill_rgb]
            return fill_rgb
        except Exception as e:
            logger.error(f"Error parsing fill color: {e}")
            return [0, 0, 0]

    @classmethod
    def execute(cls, image_base64, crop_x, crop_y, crop_width, crop_height, aspect_ratio, fill_color):
        """裁剪图片并返回结果。"""
        try:
            # 推理模式下执行张量运算：避免梯度记录开销，降低显存占用
            with torch.inference_mode():
                # 从 base64 字符串加载图片
                source_img_tensor, source_width, source_height = cls.load_image_from_base64(image_base64)

                # 如果没有图片，创建默认空白图片
                if source_img_tensor is None:
                    source_img_tensor = torch.zeros((2048, 2048, 3), dtype=torch.float32)
                    source_width = 2048
                    source_height = 2048

                # 解析填充颜色
                fill_rgb = cls.parse_fill_color(fill_color)

                # 创建目标画布（乘法归一化 + repeat 一次分配并填充，替代 empty+广播写入两步）
                fill_value = torch.tensor(fill_rgb, dtype=torch.float32) * (1.0 / 255.0)
                result_img = fill_value.repeat(crop_height, crop_width, 1)

                # 创建遮罩：默认全白（1.0 表示扩展区域）
                mask = torch.ones((crop_height, crop_width), dtype=torch.float32)

                # 计算源图片和裁切框的交集区域
                src_x1 = max(0, crop_x)
                src_y1 = max(0, crop_y)
                src_x2 = min(source_width, crop_x + crop_width)
                src_y2 = min(source_height, crop_y + crop_height)

                # 计算交集区域在目标图片中的坐标
                dst_x1 = max(0, -crop_x)
                dst_y1 = max(0, -crop_y)
                dst_x2 = dst_x1 + (src_x2 - src_x1)
                dst_y2 = dst_y1 + (src_y2 - src_y1)

                # 如果有交集，复制像素并设置遮罩为黑色（0 表示原图区域）
                if src_x2 > src_x1 and src_y2 > src_y1:
                    result_img[dst_y1:dst_y2, dst_x1:dst_x2, :] = source_img_tensor[src_y1:src_y2, src_x1:src_x2, :]
                    mask[dst_y1:dst_y2, dst_x1:dst_x2] = 0.0

                # 添加 batch 维度
                result_img = result_img.unsqueeze(0)
                mask = mask.unsqueeze(0)

            return io.NodeOutput(result_img, mask, crop_width, crop_height)
        except Exception as e:
            logger.error(f"Error in image crop: {e}")
            # 返回默认值
            result_img = torch.zeros((1, crop_height, crop_width, 3), dtype=torch.float32)
            mask = torch.ones((1, crop_height, crop_width), dtype=torch.float32)
            return io.NodeOutput(result_img, mask, crop_width, crop_height)


# 适配 000_ComfyUI_ABC 插件：NODE_CLASS_MAPPINGS 注册节点类，NODE_DISPLAY_NAME_MAPPINGS 设置显示名。
# 类本身已是 V3（io.ComfyNode）。ComfyUI 加载器（nodes.py）在同一模块内优先读取
# NODE_CLASS_MAPPINGS，server.node_info() 会通过 issubclass 检测到 V3 类并走 Schema
# （GET_NODE_INFO_V1）生成节点定义，execution.py 同样按 V3 路径执行。
# 注册聚合（comfy_entrypoint / ABCExtension）统一在包 __init__.py，本文件只定义节点类与双轨映射。
NODE_CLASS_MAPPINGS = {
    "A002_ImageCrop": ImageCrop,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "A002_ImageCrop": "002_图片裁剪",
}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
