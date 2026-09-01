#章节路径图
from fastapi import APIRouter, HTTPException
import json
import os
from app.schemas.knowledge_graph import KnowledgeGraph
from app.core.config import settings
from app.schemas.response import StandardResponse

router = APIRouter()

# 使用配置中的DATA_DIR确保路径正确
GRAPH_FILE_PATH = os.path.join(settings.DATA_DIR, "knowledge_graph.json")

_knowledge_graph_cache = None # 全局缓存
_last_loaded_path = None   # 最后一次加载的缓存路径

@router.get("", response_model=StandardResponse[KnowledgeGraph])  # 空路径，因为路由前缀会在api.py中定义
def get_knowledge_graph():
    global _knowledge_graph_cache, _last_loaded_path

    # 如果缓存存在并且路径没变，直接用缓存
    if _knowledge_graph_cache is not None and _last_loaded_path == GRAPH_FILE_PATH:
        print(f"_knowledge_graph_cache: {_knowledge_graph_cache} ")
        print(f"_last_loaded_path: {_last_loaded_path} ")
        return StandardResponse(data=_knowledge_graph_cache)
        
    try:
        print(f"_knowledge_graph_cache={_knowledge_graph_cache} ")
        print(f"_last_loaded_path={_last_loaded_path} ")
        # 文件不存在情况
        if not os.path.exists(GRAPH_FILE_PATH):
            print(f"warning: 文件 {GRAPH_FILE_PATH} 不存在，返回空数据")
            _knowledge_graph_cache = KnowledgeGraph(nodes=[], edges=[], dependent_edges=[], metadata=None)
            _last_loaded_path = GRAPH_FILE_PATH
            return StandardResponse(data=_knowledge_graph_cache)  # 返回空数据
            
        # 读取并解析文件
        with open(GRAPH_FILE_PATH, encoding='utf-8-sig') as f:  # 使用 utf-8-sig 自动处理 BOM 编码
            try:
                print(f"读取文件 {GRAPH_FILE_PATH}成功，正在解析...")
                raw_content = f.read()  # 先读取原始内容
                print(f"文件内容前100字符: {raw_content[:100]}")  # 检查内容是否被正确读取
                data = json.loads(raw_content)   # 尝试解析JSON
                validated_data = KnowledgeGraph(**data)
                _knowledge_graph_cache = validated_data
                _last_loaded_path = GRAPH_FILE_PATH
                return StandardResponse(data=validated_data)
            except json.JSONDecodeError:
                print(f"error: 文件 {GRAPH_FILE_PATH} 内容不是有效的 JSON 格式，返回默认节点")
                # JSON 无效时返回 default_node
                _knowledge_graph_cache = KnowledgeGraph(
                    nodes=[{"data": {
                        "id": "default_node",
                        "label": "默认节点",
                        "type": None,
                        "description": None,
                        "difficulty": None
                    }}],
                    edges=[],
                    dependent_edges=[],
                    metadata=None
                )
                _last_loaded_path = GRAPH_FILE_PATH
                return StandardResponse(data=_knowledge_graph_cache)
    except Exception as e:
        # 其他异常
        print(f"error: 文件 {GRAPH_FILE_PATH} 读取失败: {str(e)}")
        _knowledge_graph_cache = KnowledgeGraph(nodes=[], edges=[], dependent_edges=[], metadata=None)
        _last_loaded_path = GRAPH_FILE_PATH
        return StandardResponse(data=_knowledge_graph_cache)  # 返回空数据
