from pydantic import BaseModel, Field
from decimal import Decimal, InvalidOperation
import csv
import io
import re
from typing import List, Optional

EXPECTED_HEADER = [
    "Symbol",
    "Description",
    "Qty (Quantity)",
    "Price",
    "Price Chng $ (Price Change $)",
    "Price Chng % (Price Change %)",
    "Mkt Val (Market Value)",
    "Day Chng $ (Day Change $)",
    "Day Chng % (Day Change %)",
    "Cost Basis",
    "Gain $ (Gain/Loss $)",
    "Gain % (Gain/Loss %)",
    "Reinvest?",
    "Reinvest Capital Gains?",
    "Security Type",
]


def _strip_bom(value: str) -> str:
    return value.lstrip("\ufeff")


class AccountMetadata(BaseModel):
    header_line: str
    account_name: Optional[str] = None
    as_of: Optional[str] = None

    class Config:
        extra = "forbid"


class PositionRow(BaseModel):
    symbol: str
    description: str
    quantity: Optional[Decimal] = None
    price: Optional[Decimal] = None
    price_change: Optional[Decimal] = None
    price_change_pct: Optional[Decimal] = None
    market_value: Optional[Decimal] = None
    day_change: Optional[Decimal] = None
    day_change_pct: Optional[Decimal] = None
    cost_basis: Optional[Decimal] = None
    gain: Optional[Decimal] = None
    gain_pct: Optional[Decimal] = None
    reinvest: Optional[str] = None
    reinvest_capital_gains: Optional[str] = None
    security_type: Optional[str] = None
    row_type: str = Field(
        default="position",
        description="position|cash|summary to help classify totals vs positions",
    )

    class Config:
        extra = "forbid"


class PositionsPayload(BaseModel):
    metadata: AccountMetadata
    rows: List[PositionRow]

    class Config:
        extra = "forbid"




def _clean_value(raw: str) -> str:
    """Strip common quoting patterns like =\"$1.23\"."""
    value = _strip_bom(raw).strip()
    if value.startswith('="'):
        value = value[2:]
    if value.endswith('"'):
        value = value[:-1]
    if value.startswith('"') and value.endswith('"') and len(value) >= 2:
        value = value[1:-1]
    return value.strip()


def _normalize_numeric_token(value: str) -> str:
    value = value.replace("$", "").replace(",", "").strip()
    if value.startswith("(") and value.endswith(")"):
        value = f"-{value[1:-1]}"
    return value


def _parse_decimal(raw: str) -> Optional[Decimal]:
    value = _clean_value(raw)
    if value in ("", "--", "N/A"):
        return None
    value = _normalize_numeric_token(value)
    try:
        return Decimal(value)
    except InvalidOperation:
        raise ValueError(f"Could not parse decimal from value '{raw}'")


def _parse_percent(raw: str) -> Optional[Decimal]:
    value = _clean_value(raw)
    if value in ("", "--", "N/A"):
        return None
    value = _normalize_numeric_token(value.replace("%", ""))
    try:
        return Decimal(value)
    except InvalidOperation:
        raise ValueError(f"Could not parse percent from value '{raw}'")


def _parse_quantity(raw: str) -> Optional[Decimal]:
    value = _clean_value(raw)
    if value in ("", "--"):
        return None
    try:
        return Decimal(value)
    except InvalidOperation:
        raise ValueError(f"Could not parse quantity from value '{raw}'")


def _parse_account_metadata(line: Optional[str]) -> AccountMetadata:
    if not line:
        return AccountMetadata(header_line="Unknown")
    account_name = None
    as_of = None
    match = re.match(r"Positions for account (?P<account>.+?) as of (?P<as_of>.+)", line)
    if match:
        account_name = match.group("account").strip()
        as_of = match.group("as_of").strip()
    return AccountMetadata(header_line=line.strip(), account_name=account_name, as_of=as_of)


def _row_type(symbol: str) -> str:
    lower_symbol = symbol.lower()
    if "account total" in lower_symbol:
        return "summary"
    if "cash" in lower_symbol:
        return "cash"
    return "position"


def parse_positions_csv(text: str) -> PositionsPayload:
    metadata_line = None
    header = None
    rows: List[PositionRow] = []
    reader = csv.reader(io.StringIO(text))

    for raw_row in reader:
        if not raw_row or all(not cell.strip() for cell in raw_row):
            continue

        # Capture the metadata header line before the actual CSV header.
        if header is None and raw_row[0].startswith("Positions for account"):
            metadata_line = raw_row[0]
            continue

        if header is None and _strip_bom(raw_row[0]).strip() == "Symbol":
            header = [_strip_bom(cell) for cell in raw_row]
            # Drop trailing empty columns that come from trailing commas.
            while header and not header[-1].strip():
                header.pop()
            if header != EXPECTED_HEADER:
                raise ValueError("CSV header does not match expected positions format.")
            continue

        if header is None:
            continue  # Skip any unexpected preamble rows

        normalized_row = list(raw_row)
        if len(normalized_row) < len(EXPECTED_HEADER):
            normalized_row.extend([""] * (len(EXPECTED_HEADER) - len(normalized_row)))
        if len(normalized_row) > len(EXPECTED_HEADER):
            normalized_row = normalized_row[: len(EXPECTED_HEADER)]

        rows.append(
            PositionRow(
                symbol=_clean_value(normalized_row[0]),
                description=_clean_value(normalized_row[1]),
                quantity=_parse_quantity(normalized_row[2]),
                price=_parse_decimal(normalized_row[3]),
                price_change=_parse_decimal(normalized_row[4]),
                price_change_pct=_parse_percent(normalized_row[5]),
                market_value=_parse_decimal(normalized_row[6]),
                day_change=_parse_decimal(normalized_row[7]),
                day_change_pct=_parse_percent(normalized_row[8]),
                cost_basis=_parse_decimal(normalized_row[9]),
                gain=_parse_decimal(normalized_row[10]),
                gain_pct=_parse_percent(normalized_row[11]),
                reinvest=_clean_value(normalized_row[12]) or None,
                reinvest_capital_gains=_clean_value(normalized_row[13]) or None,
                security_type=_clean_value(normalized_row[14]) or None,
                row_type=_row_type(_clean_value(normalized_row[0])),
            )
        )

    if header is None:
        raise ValueError("Could not find CSV header row.")

    metadata = _parse_account_metadata(metadata_line)
    return PositionsPayload(metadata=metadata, rows=rows)
