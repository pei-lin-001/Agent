import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from mem0 import Memory


ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("MEM0_DATA_DIR", ROOT / ".pi" / "memory" / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

ADMIN_API_KEY = os.environ.get("MEM0_ADMIN_API_KEY")
LLM_API_KEY = os.environ.get("MEM0_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY")
EMBEDDER_API_KEY = os.environ.get("MEM0_EMBEDDER_API_KEY") or os.environ.get("OPENAI_API_KEY")

if not LLM_API_KEY:
    raise RuntimeError("MEM0_LLM_API_KEY is required")
if not EMBEDDER_API_KEY:
    raise RuntimeError("MEM0_EMBEDDER_API_KEY is required")


memory = Memory.from_config(
    {
        "llm": {
            "provider": "openai",
            "config": {
                "api_key": LLM_API_KEY,
                "openai_base_url": os.environ.get("MEM0_LLM_BASE_URL", "https://ollama.com/v1"),
                "model": os.environ.get("MEM0_LLM_MODEL", "qwen3-coder-next"),
                "temperature": float(os.environ.get("MEM0_LLM_TEMPERATURE", "0.1")),
                "max_tokens": int(os.environ.get("MEM0_LLM_MAX_TOKENS", "2000")),
                "store": False,
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "api_key": EMBEDDER_API_KEY,
                "openai_base_url": os.environ.get("MEM0_EMBEDDER_BASE_URL", "https://api.siliconflow.cn/v1"),
                "model": os.environ.get("MEM0_EMBEDDER_MODEL", "BAAI/bge-m3"),
                "embedding_dims": int(os.environ.get("MEM0_EMBEDDER_DIMS", "1024")),
            },
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": os.environ.get("MEM0_COLLECTION", "pi_memories"),
                "path": str(DATA_DIR / "qdrant"),
                "embedding_model_dims": int(os.environ.get("MEM0_EMBEDDER_DIMS", "1024")),
                "on_disk": True,
            },
        },
        "history_db_path": str(DATA_DIR / "history.db"),
        "version": "v1.1",
    }
)

def close_memory_resources() -> None:
    memory.close()
    vector_client = getattr(getattr(memory, "vector_store", None), "client", None)
    if vector_client and hasattr(vector_client, "close"):
        vector_client.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        yield
    finally:
        close_memory_resources()


app = FastAPI(title="pi mem0-compatible memory service", lifespan=lifespan)


class MemoryMessage(BaseModel):
    role: str
    content: str


class AddMemoryRequest(BaseModel):
    user_id: str
    agent_id: str | None = None
    messages: list[MemoryMessage]
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchMemoryRequest(BaseModel):
    user_id: str
    agent_id: str | None = None
    query: str
    limit: int | None = None
    top_k: int | None = None


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if ADMIN_API_KEY and x_api_key != ADMIN_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid memory API key")


def normalize_result(result: Any) -> Any:
    if isinstance(result, dict):
        return result
    if isinstance(result, list):
        return result
    return {"result": result}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/memories")
def add_memory(request: AddMemoryRequest, x_api_key: str | None = Header(default=None, alias="x-api-key")) -> Any:
    require_api_key(x_api_key)
    result = memory.add(
        [message.model_dump() for message in request.messages],
        user_id=request.user_id,
        agent_id=request.agent_id,
        metadata=request.metadata,
    )
    return normalize_result(result)


@app.post("/search")
def search_memory(
    request: SearchMemoryRequest,
    x_api_key: str | None = Header(default=None, alias="x-api-key"),
) -> dict[str, Any]:
    require_api_key(x_api_key)
    limit = request.top_k or request.limit or 5
    filters: dict[str, str] = {"user_id": request.user_id}
    if request.agent_id:
        filters["agent_id"] = request.agent_id
    result = memory.search(
        request.query,
        filters=filters,
        top_k=limit,
    )
    if isinstance(result, dict):
        return result
    return {"results": result}
