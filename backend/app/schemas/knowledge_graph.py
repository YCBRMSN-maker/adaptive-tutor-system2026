from pydantic import BaseModel, Field, validator
from typing import List, Dict, Any, Optional
from app.schemas.response import StandardResponse
import re

class KnowledgeGraphNodeData(BaseModel):
    """章节路径图节点数据模型
    
    定义章节路径图中单个节点的数据内容，采用Cypher.js兼容格式。
    
    Attributes:
        id: 节点唯一标识符
        label: 节点显示标签
        type: 节点类型（可选）
        description: 节点描述（可选）
        difficulty: 难度等级（可选）
    """
    id: str = Field(..., description="节点唯一标识符")
    label: str = Field(..., min_length=1, max_length=100, description="节点显示标签")
    type: Optional[str] = Field(None, description="节点类型")
    description: Optional[str] = Field(None, max_length=500, description="节点描述")
    difficulty: Optional[int] = Field(None, ge=1, le=5, description="难度等级(1-5)")
    
    @validator('id')
    def validate_id(cls, v):
        """验证ID格式"""
        if not re.match(r'^[a-zA-Z0-9_-]+$', v):
            raise ValueError('ID只能包含字母、数字、下划线和连字符')
        return v
    
    @validator('label')
    def validate_label(cls, v):
        """验证标签内容"""
        if not v.strip():
            raise ValueError('标签不能为空')
        return v.strip()

class KnowledgeGraphNode(BaseModel):
    """章节路径图节点模型
    
    章节路径图中的节点结构，包含节点数据对象。
    这种结构是为了与Cypher.js等图形库兼容。
    
    Attributes:
        data: 节点数据对象，包含id和label信息
    """
    data: KnowledgeGraphNodeData

class KnowledgeGraphEdgeData(BaseModel):
    """章节路径图边数据模型
    
    定义章节路径图中边的连接关系，采用Cypher.js兼容格式。
    
    Attributes:
        source: 源节点ID
        target: 目标节点ID
        edge_type: 边类型（可选）
        weight: 边权重（可选）
        label: 边标签（可选）
    """
    source: str = Field(..., description="源节点ID")
    target: str = Field(..., description="目标节点ID")
    edge_type: Optional[str] = Field(None, description="边类型")
    weight: Optional[float] = Field(None, ge=0.0, le=1.0, description="边权重(0-1)")
    label: Optional[str] = Field(None, max_length=50, description="边标签")
    
    @validator('source', 'target')
    def validate_node_ids(cls, v):
        """验证节点ID格式"""
        if not re.match(r'^[a-zA-Z0-9_-]+$', v):
            raise ValueError('节点ID只能包含字母、数字、下划线和连字符')
        return v
    
    @validator('source')
    def validate_source_not_target(cls, v, values):
        """验证源节点和目标节点不能相同"""
        if 'target' in values and v == values['target']:
            raise ValueError('源节点和目标节点不能相同')
        return v

class KnowledgeGraphEdge(BaseModel):
    """章节路径图边模型
    
    章节路径图中的边结构，表示节点间的连接关系。
    这种结构是为了与Cypher.js等图形库兼容。
    
    Attributes:
        data: 边数据对象，包含源节点和目标节点信息
    """
    data: KnowledgeGraphEdgeData

class KnowledgeGraph(BaseModel):
    """章节路径图模型
    
    完整的章节路径图结构，包含所有节点和边。
    
    Attributes:
        nodes: 节点列表，包含所有章节节点
        edges: 边列表，包含所有节点间的连接关系
        dependent_edges: 依赖边列表，包含章节间的依赖关系
        metadata: 图谱元数据（可选）
    """
    nodes: List[KnowledgeGraphNode] = Field(..., description="节点列表")
    edges: List[KnowledgeGraphEdge] = Field(..., description="边列表")
    dependent_edges: List[KnowledgeGraphEdge] = Field(..., description="依赖边列表")
    metadata: Optional[Dict[str, Any]] = Field(None, description="图谱元数据")
    
    @validator('nodes')
    def validate_unique_node_ids(cls, v):
        """验证节点ID唯一性"""
        node_ids = [node.data.id for node in v]
        if len(node_ids) != len(set(node_ids)):
            raise ValueError('节点ID必须唯一')
        return v
    
    @validator('edges')
    def validate_edge_nodes_exist(cls, v, values):
        """验证边连接的节点存在"""
        if 'nodes' in values:
            node_ids = {node.data.id for node in values['nodes']}
            for edge in v:
                if edge.data.source not in node_ids:
                    raise ValueError(f'源节点 {edge.data.source} 不存在')
                if edge.data.target not in node_ids:
                    raise ValueError(f'目标节点 {edge.data.target} 不存在')
        return v
    
    @validator('dependent_edges')
    def validate_dependent_edge_nodes_exist(cls, v, values):
        """验证依赖边连接的节点存在"""
        if 'nodes' in values:
            node_ids = {node.data.id for node in values['nodes']}
            for edge in v:
                if edge.data.source not in node_ids:
                    raise ValueError(f'依赖源节点 {edge.data.source} 不存在')
                if edge.data.target not in node_ids:
                    raise ValueError(f'依赖目标节点 {edge.data.target} 不存在')
        return v
