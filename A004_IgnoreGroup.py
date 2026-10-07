"""A004 忽略组节点：纯前端控制节点，后端无实际处理逻辑。"""

from comfy_api.latest import io


class IgnoreGroup(io.ComfyNode):
    """忽略组控制节点：前端绘制智能按钮，点击切换组的忽略状态。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="IgnoreGroup",
            display_name="004_忽略组",
            category="ABC",
            description="前端按钮切换组的忽略状态（本组恢复 / 忽略其他组 / 忽略所有组）",
            inputs=[
                # switch 布尔输入端口（开关）：
                #   开(true) = 蓝 = 不忽略 / 恢复本组；
                #   关(false) = 紫 = 忽略本组。
                # 用标准布尔输入（socket + 官方布尔 widget 同时存在）：
                #   · socket：可被 ComfyUI 自动识别/连线；
                #   · widget：官方布尔控件（开关），与节点上的大按钮双向联动。
                io.Boolean.Input("switch", default=False),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, switch=False):
        # 纯前端控制节点，后端无实际处理逻辑、无输出；
        # switch 仅作为「可连线/可提升的布尔控件」存在，忽略逻辑全部在前端完成。
        return io.NodeOutput()


# 适配 000_ComfyUI_ABC 插件：NODE_CLASS_MAPPINGS 注册节点类，NODE_DISPLAY_NAME_MAPPINGS 设置显示名。
# 类本身已是 V3（io.ComfyNode）。ComfyUI 加载器（nodes.py）在同一模块内优先读取
# NODE_CLASS_MAPPINGS，server.node_info() 会通过 issubclass 检测到 V3 类并走 Schema
# （GET_NODE_INFO_V1）生成节点定义，execution.py 同样按 V3 路径执行。
# 注册聚合（comfy_entrypoint / ABCExtension）统一在包 __init__.py，本文件只定义节点类与双轨映射。
NODE_CLASS_MAPPINGS = {
    "IgnoreGroup": IgnoreGroup,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "IgnoreGroup": "004_忽略组",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]