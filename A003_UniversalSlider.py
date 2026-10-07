"""A003 万能滑条节点：支持浮点/整数双模式切换，超宽范围原生滑条。"""

from comfy_api.latest import io


class UniversalSlider(io.ComfyNode):
    """万能滑条节点：支持浮点/整数双模式切换，超宽范围原生滑条。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="UniversalSlider",
            display_name="003_万能滑条",
            category="ABC",
            description="万能滑条节点：支持浮点/整数双模式切换，超宽范围原生滑条。",
            inputs=[
                io.Float.Input(
                    "数值",
                    default=5.0,
                    min=-999999,
                    max=999999,
                    step=0.01,
                    display_mode=io.NumberDisplay.slider,
                ),
                io.Combo.Input(
                    "输出类型",
                    options=["float", "int"],
                    default="float",
                ),
            ],
            outputs=[
                io.AnyType.Output("输出"),
            ],
        )

    @classmethod
    def execute(cls, 数值, 输出类型="float"):
        processed_value = round(float(数值), 10)
        if 输出类型 == "int":
            return io.NodeOutput(int(round(processed_value)))
        return io.NodeOutput(processed_value)

    @classmethod
    def fingerprint_inputs(cls, 数值, 输出类型="float"):
        processed_value = round(float(数值), 10)
        if 输出类型 == "int":
            return int(round(processed_value))
        return processed_value


# 适配 000_ComfyUI_ABC 插件：NODE_CLASS_MAPPINGS 注册节点类，NODE_DISPLAY_NAME_MAPPINGS 设置显示名。
# 类本身已是 V3（io.ComfyNode）。ComfyUI 加载器（nodes.py）在同一模块内优先读取
# NODE_CLASS_MAPPINGS，server.node_info() 会通过 issubclass 检测到 V3 类并走 Schema
# （GET_NODE_INFO_V1）生成节点定义，execution.py 同样按 V3 路径执行。
# 注册聚合（comfy_entrypoint / ABCExtension）统一在包 __init__.py，本文件只定义节点类与双轨映射。
NODE_CLASS_MAPPINGS = {
    "UniversalSlider": UniversalSlider,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "UniversalSlider": "003_万能滑条",
}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
