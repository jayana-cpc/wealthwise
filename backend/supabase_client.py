import logging
import os
from functools import lru_cache
from typing import Any, Dict, List, Optional

from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel

from backend.auth import SessionUser
from backend.csv_parsing import PositionsPayload

try:
    from supabase import Client, create_client
except ImportError as exc:  # pragma: no cover - surfaces missing dependency clearly
    raise RuntimeError(
        "Missing dependency 'supabase'. Install with `pip install supabase`."
    ) from exc

logger = logging.getLogger("wealthwise.supabase")

# Table name is configurable to make local and deployed environments easy to line up.
PORTFOLIO_UPLOADS_TABLE = os.getenv("SUPABASE_PORTFOLIO_UPLOADS_TABLE", "portfolio_uploads")


class PortfolioUpload(BaseModel):
    id: Optional[int] = None
    user_sub: str
    user_email: Optional[str] = None
    file_name: Optional[str] = None
    row_count: Optional[int] = None
    payload: PositionsPayload
    raw_csv: Optional[str] = None
    created_at: Optional[str] = None

    class Config:
        extra = "allow"


@lru_cache(maxsize=1)
def get_supabase_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var")

    return create_client(url, key)


def _build_upload_record(
    user: SessionUser, payload: PositionsPayload, raw_csv: str, file_name: str
) -> Dict[str, Any]:
    encoded_payload = jsonable_encoder(payload, exclude_none=True)
    return {
        "user_sub": user["sub"],
        "user_email": user.get("email"),
        "file_name": file_name,
        "row_count": len(payload.rows),
        "payload": encoded_payload,
        "raw_csv": raw_csv,
    }


def insert_portfolio_upload(
    user: SessionUser, payload: PositionsPayload, raw_csv: str, file_name: str
) -> List[Dict[str, Any]]:
    """
    Persist the parsed CSV to Supabase.

    Returns Supabase response data for observability; callers can ignore it.
    """
    record = _build_upload_record(user, payload, raw_csv, file_name)
    client = get_supabase_client()
    logger.info(
        "Saving CSV upload to Supabase; user_sub=%s rows=%s",
        user.get("sub"),
        len(payload.rows),
    )

    response = client.table(PORTFOLIO_UPLOADS_TABLE).insert(record).execute()
    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise RuntimeError(f"Supabase insert failed: {message}")

    data = getattr(response, "data", None)
    if data is None:
        raise RuntimeError("Supabase insert returned no data.")

    return data


def fetch_latest_portfolio_upload(user: SessionUser) -> Optional[PortfolioUpload]:
    """
    Fetch the most recent upload for the current user from Supabase.

    Returns None if no uploads exist yet.
    """
    client = get_supabase_client()
    response = (
        client.table(PORTFOLIO_UPLOADS_TABLE)
        .select("*")
        .eq("user_sub", user["sub"])
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise RuntimeError(f"Supabase fetch failed: {message}")

    data = getattr(response, "data", None)
    if not data:
        return None

    record = data[0]
    payload_data = record.get("payload")
    if not payload_data:
        raise RuntimeError("Supabase record missing payload data.")

    record["payload"] = PositionsPayload.parse_obj(payload_data)
    return PortfolioUpload.parse_obj(record)
