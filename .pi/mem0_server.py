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


class UpdateMemoryRequest(BaseModel):
    memory: str


class DedupCandidate(BaseModel):
    id: str
    text: str
    score: float = 0.0


class DedupRequest(BaseModel):
    user_id: str
    new_memory: str
    candidates: list[DedupCandidate]


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


@app.delete("/memories/{memory_id}")
def delete_memory(memory_id: str, x_api_key: str | None = Header(default=None, alias="x-api-key")) -> dict[str, str]:
    require_api_key(x_api_key)
    try:
        memory.delete(memory_id)
    except ValueError:
        # Old memories may only exist in the vector store, not in the history DB.
        # Try direct vector store deletion as fallback.
        try:
            vs = getattr(memory, "vector_store", None)
            if vs and hasattr(vs, "delete"):
                vs.delete(memory_id)
        except Exception:
            pass
    return {"status": "deleted", "memory_id": memory_id}


@app.put("/memories/{memory_id}")
def update_memory(memory_id: str, request: UpdateMemoryRequest, x_api_key: str | None = Header(default=None, alias="x-api-key")) -> Any:
    require_api_key(x_api_key)
    result = memory.update(memory_id, data=request.memory)
    return normalize_result(result)


def _call_llm(prompt: str) -> str:
    """Call the Ollama Cloud LLM directly via OpenAI-compatible API."""
    import json
    import urllib.request

    llm_base_url = os.environ.get("MEM0_LLM_BASE_URL", "https://ollama.com/v1")
    llm_model = os.environ.get("DEDUP_LLM_MODEL", os.environ.get("MEM0_LLM_MODEL", "ministral-3:8b"))
    url = f"{llm_base_url.rstrip('/')}/chat/completions"

    payload = json.dumps({
        "model": llm_model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": 256,
    }).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    api_key = LLM_API_KEY
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    req.add_header("Content-Type", "application/json")

    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        return result.get("choices", [{}])[0].get("message", {}).get("content", "")


@app.post("/dedup")
def dedup_memories(request: DedupRequest, x_api_key: str | None = Header(default=None, alias="x-api-key")) -> dict[str, Any]:
    """Use LLM to identify which candidate memories are superseded by or contradict the new memory."""
    require_api_key(x_api_key)

    if not request.candidates:
        return {"delete_ids": []}

    # Build the prompt for LLM analysis
    candidates_text = "\n".join(
        f"  [{i+1}] id={c.id}: {c.text}"
        for i, c in enumerate(request.candidates)
    )

    prompt = (
        "You are a memory deduplication assistant. Given a NEW fact and a list of EXISTING memories, "
        "identify which existing memories are SUPERSEDED BY or CONTRADICT the new fact.\n\n"
        "A memory is superseded if the new fact provides a more recent, more accurate, or more complete "
        "update on the same specific topic (e.g. a task status change, an updated project goal).\n"
        "A memory is contradicted if the new fact directly states the opposite.\n\n"
        "Memories that are COMPLEMENTARY (different aspects, related but not conflicting) should NOT be flagged.\n"
        "Memories that are about a different topic entirely should NOT be flagged.\n\n"
        f"NEW fact: {request.new_memory}\n\n"
        f"EXISTING memories:\n{candidates_text}\n\n"
        "Respond with ONLY a JSON array of IDs that should be deleted. If none, respond with [].\n"
        "Example: [\"abc123\", \"def456\"]"
    )

    # Call the LLM directly via Ollama Cloud API
    import json as _json
    import re as _re
    try:
        response = _call_llm(prompt)
        # Parse JSON array from response
        json_match = _re.search(r'\[.*?\]', response, _re.DOTALL)
        if json_match:
            try:
                delete_ids = _json.loads(json_match.group(0))
                if isinstance(delete_ids, list):
                    # Validate IDs and only return ones that were in the original candidates
                    candidate_ids = {c.id for c in request.candidates}
                    delete_ids = [str(id) for id in delete_ids if str(id) in candidate_ids]
                    return {"delete_ids": delete_ids}
            except (_json.JSONDecodeError, ValueError):
                pass
        # If parsing fails, return empty list
        return {"delete_ids": []}
    except Exception as e:
        # LLM call failed, return empty (fall back to score-based)
        return {"delete_ids": [], "error": str(e)}


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