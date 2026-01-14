import logging
import os
import uuid
from datetime import datetime
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
PORTFOLIO_IMPORT_BATCHES_TABLE = os.getenv(
    "PORTFOLIO_IMPORT_BATCHES_TABLE", "portfolio_import_batches"
)
MARKET_PRICE_BARS_TABLE = os.getenv("MARKET_PRICE_BARS_TABLE", "market_price_bars")
RISK_ANALYSES_TABLE = os.getenv("RISK_ANALYSES_TABLE", "risk_analyses")
RISK_NARRATIVES_TABLE = os.getenv("RISK_NARRATIVES_TABLE", "risk_narratives")
USER_SECRETS_TABLE = os.getenv("USER_SECRETS_TABLE", "user_secrets")


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


class PortfolioImportBatch(BaseModel):
    id: str
    user_sub: str
    user_email: Optional[str] = None
    file_name: Optional[str] = None
    row_count: Optional[int] = None
    payload: PositionsPayload
    raw_csv: Optional[str] = None
    created_at: Optional[str] = None

    class Config:
        extra = "allow"


class MarketPriceBar(BaseModel):
    symbol: str
    timeframe: str
    t: datetime
    o: float
    h: float
    l: float
    c: float
    v: Optional[int] = None
    source: str = "alpaca"

    class Config:
        extra = "allow"


class RiskAnalysisRecord(BaseModel):
    id: str
    user_sub: str
    batch_id: str
    mode: str
    status: str
    packet: Dict[str, Any]
    error: Optional[str] = None
    created_at: Optional[str] = None

    class Config:
        extra = "allow"


class RiskNarrativesRecord(BaseModel):
    id: str
    analysis_id: str
    narratives: List[Dict[str, Any]]
    model: Optional[str] = None
    created_at: Optional[str] = None

    class Config:
        extra = "allow"


class UserSecretRecord(BaseModel):
    user_id: str
    provider: str
    encrypted_value: str
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


def insert_portfolio_import_batch(
    user: SessionUser, payload: PositionsPayload, raw_csv: str, file_name: str
) -> PortfolioImportBatch:
    batch_id = str(uuid.uuid4())
    record = {
        "id": batch_id,
        "user_sub": user["sub"],
        "user_email": user.get("email"),
        "file_name": file_name,
        "row_count": len(payload.rows),
        "payload": jsonable_encoder(payload, exclude_none=True),
        "raw_csv": raw_csv,
    }
    client = get_supabase_client()
    logger.info(
        "Saving import batch to Supabase; batch_id=%s user_sub=%s rows=%s",
        batch_id,
        user.get("sub"),
        len(payload.rows),
    )

    response = client.table(PORTFOLIO_IMPORT_BATCHES_TABLE).insert(record).execute()
    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise RuntimeError(f"Supabase insert failed: {message}")

    data = getattr(response, "data", None)
    if not data:
        raise RuntimeError("Supabase insert returned no data.")

    saved = data[0]
    saved["payload"] = PositionsPayload.parse_obj(saved["payload"])
    return PortfolioImportBatch.parse_obj(saved)


def fetch_import_batch(user: SessionUser, batch_id: str) -> Optional[PortfolioImportBatch]:
    client = get_supabase_client()
    response = (
        client.table(PORTFOLIO_IMPORT_BATCHES_TABLE)
        .select("*")
        .eq("id", batch_id)
        .eq("user_sub", user["sub"])
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
    return PortfolioImportBatch.parse_obj(record)


def load_cached_market_price_bars(
    symbols: List[str], start: datetime, end: datetime, timeframe: str = "1Day"
) -> Dict[str, List[MarketPriceBar]]:
    if not symbols:
        return {}
    client = get_supabase_client()
    response = (
        client.table(MARKET_PRICE_BARS_TABLE)
        .select("*")
        .in_("symbol", symbols)
        .eq("timeframe", timeframe)
        .gte("t", start.isoformat())
        .lte("t", end.isoformat())
        .order("t", desc=False)
        .execute()
    )
    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise RuntimeError(f"Supabase fetch failed: {message}")

    data = getattr(response, "data", None) or []
    out: Dict[str, List[MarketPriceBar]] = {}
    for item in data:
        try:
            bar = MarketPriceBar.parse_obj(item)
        except Exception:
            continue
        out.setdefault(bar.symbol, []).append(bar)
    return out


def upsert_market_price_bars(bars: List[MarketPriceBar]) -> None:
    if not bars:
        return
    client = get_supabase_client()
    payload = [jsonable_encoder(bar, exclude_none=True) for bar in bars]
    response = (
        client.table(MARKET_PRICE_BARS_TABLE)
        .upsert(payload, on_conflict="symbol,timeframe,t")
        .execute()
    )
    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise RuntimeError(f"Supabase upsert failed: {message}")


def insert_risk_analysis(record: RiskAnalysisRecord) -> RiskAnalysisRecord:
    client = get_supabase_client()
    response = (
        client.table(RISK_ANALYSES_TABLE)
        .insert(jsonable_encoder(record, exclude_none=True))
        .execute()
    )
    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise RuntimeError(f"Supabase insert failed: {message}")

    data = getattr(response, "data", None)
    if not data:
        raise RuntimeError("Supabase insert returned no data.")
    return RiskAnalysisRecord.parse_obj(data[0])


def insert_risk_narratives(record: RiskNarrativesRecord) -> RiskNarrativesRecord:
    client = get_supabase_client()
    response = (
        client.table(RISK_NARRATIVES_TABLE)
        .insert(jsonable_encoder(record, exclude_none=True))
        .execute()
    )
    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise RuntimeError(f"Supabase insert failed: {message}")

    data = getattr(response, "data", None)
    if not data:
        raise RuntimeError("Supabase insert returned no data.")
    return RiskNarrativesRecord.parse_obj(data[0])


def fetch_latest_risk_analysis(
    user: SessionUser, batch_id: Optional[str] = None
) -> Optional[RiskAnalysisRecord]:
    client = get_supabase_client()
    query = (
        client.table(RISK_ANALYSES_TABLE)
        .select("*")
        .eq("user_sub", user["sub"])
        .order("created_at", desc=True)
        .limit(1)
    )
    if batch_id:
        query = query.eq("batch_id", batch_id)
    response = query.execute()
    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise RuntimeError(f"Supabase fetch failed: {message}")

    data = getattr(response, "data", None)
    if not data:
        return None
    return RiskAnalysisRecord.parse_obj(data[0])


def fetch_risk_narratives(analysis_id: str) -> Optional[RiskNarrativesRecord]:
    client = get_supabase_client()
    response = (
        client.table(RISK_NARRATIVES_TABLE)
        .select("*")
        .eq("analysis_id", analysis_id)
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
    return RiskNarrativesRecord.parse_obj(data[0])


def upsert_user_secret(user_id: str, provider: str, encrypted_value: str) -> UserSecretRecord:
    client = get_supabase_client()
    record = {"user_id": user_id, "provider": provider, "encrypted_value": encrypted_value}
    response = (
        client.table(USER_SECRETS_TABLE)
        .upsert(record, on_conflict="user_id")
        .execute()
    )
    error = getattr(response, "error", None)
    if error:
        message = getattr(error, "message", None) or str(error)
        raise RuntimeError(f"Supabase upsert failed: {message}")

    data = getattr(response, "data", None)
    if not data:
        raise RuntimeError("Supabase upsert returned no data.")
    return UserSecretRecord.parse_obj(data[0])


def fetch_user_secret(user_id: str, provider: str) -> Optional[UserSecretRecord]:
    client = get_supabase_client()
    response = (
        client.table(USER_SECRETS_TABLE)
        .select("*")
        .eq("user_id", user_id)
        .eq("provider", provider)
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
    return UserSecretRecord.parse_obj(data[0])
