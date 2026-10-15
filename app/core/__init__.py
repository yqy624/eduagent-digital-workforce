"""平台内核：与业务无关的可复用能力。

依赖方向：app.core 不得 import app.routers / app.services，
只能被上层依赖。
"""
