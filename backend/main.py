import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.cors import CORSMiddleware

from backend.csv_parsing import PositionsPayload, parse_positions_csv
from backend.oauth import router as oauth_router


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


@app.post("/upload-csv", response_model=PositionsPayload)
async def upload_csv(file: UploadFile = File(...)) -> PositionsPayload:
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="File not uploaded.")
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Uploaded file must be a CSV.")

    try:
        raw_bytes = await file.read()
        text = raw_bytes.decode("utf-8-sig")
        return parse_positions_csv(text)
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Unable to decode file as UTF-8.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
