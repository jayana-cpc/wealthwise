import logging
import os
import json
import time
from typing import Any, Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.cors import CORSMiddleware

# Load .env early so OAuth env vars are available at import time.
try:  # pragma: no cover - defensive import
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    pass

from backend.auth import SessionUser, get_current_user
from backend.csv_parsing import PositionsPayload, parse_positions_csv
from backend.crypto_utils import decrypt_secret, encrypt_secret
from backend.oauth import router as oauth_router
from backend.risk_service import analyze_batch, import_holdings, latest_analysis
from backend.performance_service import PerformanceResponse, build_performance_payload
from backend.optimization_service import (
    OptimizationRequest,
    OptimizationResponse,
    list_methods as list_opt_methods,
    run_optimization,
)
from backend.supabase_client import (
    PortfolioUpload,
    fetch_latest_portfolio_upload,
    fetch_user_secret,
    insert_portfolio_upload,
    insert_portfolio_transactions_upload,
    upsert_user_secret,
)
from backend.deepseek_client import DeepSeekError, run_chat_completion
# backend/main.py (top)
from dotenv import load_dotenv
load_dotenv()


# Run from repo root: uvicorn backend.main:app --reload --port 8001
app = FastAPI(title="WealthWise API", version="0.2.0")

# CORS (so your Next.js frontend on :3000 can call your API)
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session middleware (stores OAuth state + your user session)
SESSION_SECRET = os.getenv("SESSION_SECRET")
if not SESSION_SECRET:
    raise RuntimeError("Missing SESSION_SECRET env var")

app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    same_site="lax",
    https_only=False,  # set True in production with HTTPS
)

app.include_router(oauth_router)

logger = logging.getLogger("wealthwise.api")


class AssistantChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AssistantChatRequest(BaseModel):
    messages: List[AssistantChatMessage]
    selection: Optional[Dict[str, Any]] = None
    user_context: Optional[Dict[str, Any]] = Field(None, alias="userContext")
    model: Optional[str] = None

    class Config:
        allow_population_by_field_name = True

ASSISTANT_SYSTEM_PROMPT = """
You are the in-app WealthWise assistant. Users click a UI element, and you receive a UI_SELECTION_JSON that describes what they referenced (labels, semantic fields, ww-id, role, bounding box). Use it to:
- Identify what the element is.
- Explain how to read or interpret it in plain language.
- Mention inputs or filters (date range, benchmarks) when present.
- Call out if required data is missing or ambiguous.
Rules:
- Do not invent numbers that are not present in the selection or provided context.
- Prefer concise explanations anchored to the selection payload.
- If no selection is provided, give a brief, general answer and ask for a selection for deeper guidance.
""".strip()

MAX_ASSISTANT_SELECTION_BYTES = 20_000
MAX_ASSISTANT_MESSAGES = 24


def _trim_selection(selection: Dict[str, Any]) -> Dict[str, Any]:
    trimmed = dict(selection)
    try:
        encoded_len = len(json.dumps(trimmed, ensure_ascii=True).encode("utf-8"))
    except Exception:
        return {}

    if encoded_len > MAX_ASSISTANT_SELECTION_BYTES:
        trimmed.pop("outerHTMLSnippet", None)
        visible = trimmed.get("visibleText")
        if isinstance(visible, str):
            trimmed["visibleText"] = visible[:400]
    return trimmed


def _build_assistant_messages(body: AssistantChatRequest) -> List[Dict[str, str]]:
    messages: List[Dict[str, str]] = [{"role": "system", "content": ASSISTANT_SYSTEM_PROMPT}]

    if body.selection:
        trimmed = _trim_selection(body.selection)
        messages.append({"role": "system", "content": f"UI_SELECTION_JSON: {json.dumps(trimmed, ensure_ascii=True)}"})

    if body.user_context:
        messages.append(
            {
                "role": "system",
                "content": f"PAGE_STATE_JSON: {json.dumps(body.user_context, ensure_ascii=True)}",
            }
        )

    for msg in body.messages[-MAX_ASSISTANT_MESSAGES :]:
        content = (msg.content or "").strip()
        if not content:
            continue
        if msg.role not in ("user", "assistant"):
            continue
        messages.append({"role": msg.role, "content": content})

    return messages

class AnalyzeRequest(BaseModel):
    batch_id: str
    mode: Literal["csv_only", "enriched"]


class AnalyzeResponse(BaseModel):
    analysis_id: str
    status: str
    packet: Dict[str, Any]
    narratives: List[Dict[str, Any]]
    model: Optional[str] = None


class ImportResponse(BaseModel):
    batch_id: str
    row_count: Optional[int] = None


class TransactionImportResponse(BaseModel):
    id: int
    file_name: Optional[str] = None


class DeepSeekKeyRequest(BaseModel):
    api_key: str


@app.post("/upload-csv", response_model=PositionsPayload)
async def upload_csv(
    file: UploadFile = File(...), user: SessionUser = Depends(get_current_user)
) -> PositionsPayload:
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="File not uploaded.")
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Uploaded file must be a CSV.")

    try:
        raw_bytes = await file.read()
        text = raw_bytes.decode("utf-8-sig")
        payload = parse_positions_csv(text)
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Unable to decode file as UTF-8.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        await run_in_threadpool(
            insert_portfolio_upload,
            user=user,
            payload=payload,
            raw_csv=text,
            file_name=file.filename,
        )
    except Exception as exc:
        logger.exception("Failed to persist CSV upload to Supabase")
        raise HTTPException(status_code=502, detail="Failed to store CSV upload.") from exc

    return payload


@app.get("/portfolio-uploads/latest", response_model=Optional[PortfolioUpload])
async def latest_portfolio_upload(
    user: SessionUser = Depends(get_current_user),
) -> Optional[PortfolioUpload]:
    try:
        return await run_in_threadpool(fetch_latest_portfolio_upload, user)
    except Exception as exc:
        logger.exception("Failed to fetch latest CSV upload from Supabase")
        raise HTTPException(status_code=502, detail="Failed to load latest upload.") from exc


@app.post("/api/portfolio/import/holdings", response_model=ImportResponse)
async def import_portfolio_holdings(
    file: UploadFile = File(...), user: SessionUser = Depends(get_current_user)
) -> ImportResponse:
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="File not uploaded.")
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Uploaded file must be a CSV.")

    try:
        raw_bytes = await file.read()
        text = raw_bytes.decode("utf-8-sig")
        payload = parse_positions_csv(text)
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Unable to decode file as UTF-8.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        batch = await run_in_threadpool(
            import_holdings, user=user, payload=payload, raw_csv=text, file_name=file.filename
        )
    except Exception as exc:
        logger.exception("Failed to persist holdings import to Supabase")
        raise HTTPException(status_code=502, detail="Failed to store holdings import.") from exc

    return ImportResponse(batch_id=batch.id, row_count=batch.row_count)


@app.post("/api/portfolio/import/transactions", response_model=TransactionImportResponse)
async def import_portfolio_transactions(
    file: UploadFile = File(...), user: SessionUser = Depends(get_current_user)
) -> TransactionImportResponse:
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="File not uploaded.")
    if not file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Uploaded file must be a JSON file.")

    try:
        raw_bytes = await file.read()
        text = raw_bytes.decode("utf-8-sig")
        payload = json.loads(text)
        if not isinstance(payload, dict):
            raise ValueError("JSON root must be an object.")
        if not payload.get("BrokerageTransactions"):
            raise ValueError("JSON missing BrokerageTransactions array.")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Unable to decode file as UTF-8.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        saved = await run_in_threadpool(
          insert_portfolio_transactions_upload,
          user=user,
          payload=payload,
          raw_json=text,
          file_name=file.filename,
        )
    except Exception as exc:
        logger.exception("Failed to persist transactions upload to Supabase")
        raise HTTPException(status_code=502, detail="Failed to store transactions upload.") from exc

    return TransactionImportResponse(id=saved.id or 0, file_name=saved.file_name)


@app.post("/api/risk/analyze", response_model=AnalyzeResponse)
async def risk_analyze(
    body: AnalyzeRequest, user: SessionUser = Depends(get_current_user)
) -> AnalyzeResponse:
    if body.mode not in ("csv_only", "enriched"):
        raise HTTPException(status_code=400, detail="Invalid mode.")

    try:
        analysis, narratives, model = await analyze_batch(user, body.batch_id, body.mode)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Risk analysis failed")
        raise HTTPException(status_code=502, detail="Risk analysis failed.") from exc

    return AnalyzeResponse(
        analysis_id=analysis.id,
        status=analysis.status,
        packet=analysis.packet,
        narratives=narratives,
        model=model,
    )


@app.get("/api/risk/latest")
async def risk_latest(
    batch_id: Optional[str] = None, user: SessionUser = Depends(get_current_user)
) -> Dict[str, Any]:
    try:
        result = await run_in_threadpool(latest_analysis, user, batch_id)
    except Exception as exc:
        logger.exception("Failed to load latest risk analysis")
        raise HTTPException(status_code=502, detail="Failed to load latest risk analysis.") from exc
    if not result:
        raise HTTPException(status_code=404, detail="No risk analysis found.")
    return result


@app.get("/api/performance/portfolio", response_model=PerformanceResponse)
async def portfolio_performance(
    user: SessionUser = Depends(get_current_user),
) -> PerformanceResponse:
    try:
        return await build_performance_payload(user)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to build performance dashboard payload")
        raise HTTPException(
            status_code=502, detail="Failed to build portfolio performance payload."
        ) from exc


@app.post("/api/ai/chat")
async def assistant_chat(
    body: AssistantChatRequest, user: SessionUser = Depends(get_current_user)
) -> Dict[str, str]:
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages are required.")

    secret_record = fetch_user_secret(user["sub"], "deepseek")
    api_key = decrypt_secret(secret_record.encrypted_value) if secret_record else None
    if not api_key:
        api_key = os.getenv("DEEPSEEK_API_KEY") or None
    if not api_key:
        raise HTTPException(status_code=400, detail="DeepSeek API key not configured.")

    chat_messages = _build_assistant_messages(body)
    started_at = time.monotonic()
    try:
        reply = await run_chat_completion(chat_messages, api_key=api_key, model=body.model)
    except DeepSeekError as exc:
        logger.warning("DeepSeek chat failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Assistant chat crashed")
        raise HTTPException(status_code=502, detail="Assistant request failed.") from exc

    selection_dict = body.selection if isinstance(body.selection, dict) else {}
    logger.info(
        "assistant.chat",
        extra={
            "ww_id": selection_dict.get("wwId"),
            "strategy": selection_dict.get("selectorStrategy"),
            "model": body.model or os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
            "elapsed_sec": time.monotonic() - started_at,
        },
    )

    return {"reply": reply}


@app.post("/api/settings/deepseek-key")
async def set_deepseek_key(
    body: DeepSeekKeyRequest, user: SessionUser = Depends(get_current_user)
) -> Dict[str, str]:
    if not body.api_key.strip():
        raise HTTPException(status_code=400, detail="API key is required.")

    try:
        encrypted = encrypt_secret(body.api_key)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        await run_in_threadpool(upsert_user_secret, user["sub"], "deepseek", encrypted)
    except Exception as exc:
        logger.exception("Failed to persist DeepSeek key")
        raise HTTPException(status_code=502, detail="Failed to store DeepSeek key.") from exc

    return {"status": "stored"}


@app.get("/api/optimize/methods")
async def optimize_methods() -> Dict[str, Any]:
    return list_opt_methods()


@app.post("/api/optimize/run", response_model=OptimizationResponse)
async def optimize_run(
    body: OptimizationRequest, user: SessionUser = Depends(get_current_user)
) -> OptimizationResponse:
    try:
        return await run_optimization(user, body)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Allocation optimization failed")
        raise HTTPException(status_code=502, detail="Optimization failed.") from exc
