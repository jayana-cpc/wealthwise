import logging
import os
from typing import Optional

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
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
from backend.oauth import router as oauth_router
from backend.supabase_client import (
    PortfolioUpload,
    fetch_latest_portfolio_upload,
    insert_portfolio_upload,
)
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
