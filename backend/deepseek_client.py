import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx


class DeepSeekError(Exception):
    """Raised when DeepSeek call fails or returns unusable output."""


def _build_messages(risk_packet: Dict[str, Any]) -> List[Dict[str, str]]:
    system = (
        "You are a risk explainer for personal portfolios. "
        "Only explain the provided metrics. Do not invent numbers or give investment advice. "
        "Respond with strict JSON: {\"narratives\": [{\"id\": \"...\", \"severity\": \"low|medium|high\", "
        "\"headline\": \"\", \"summary\": \"\", \"why_it_matters\": \"\", \"watch_thresholds\": [\"...\"]}]}"
    )
    user = (
        "Produce 3-5 concise narratives based on this risk packet. "
        "If any market-data fields are missing, acknowledge that they are unavailable. "
        f"RiskPacket: {json.dumps(risk_packet, ensure_ascii=True)}"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

logger = logging.getLogger("wealthwise.deepseek")


def _clean_content(raw: str) -> str:
    """
    Remove Markdown fences like ```json ... ``` and trim whitespace.
    Also attempts to extract the largest JSON object if fences remain.
    """
    text = raw.strip()
    if text.startswith("```"):
        # drop first line fence
        parts = text.splitlines()
        # remove first fence line
        parts = parts[1:] if parts else []
        # remove trailing fence if present
        if parts and parts[-1].strip().startswith("```"):
            parts = parts[:-1]
        text = "\n".join(parts).strip()
    # Fallback: extract JSON object boundaries
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


async def generate_narratives(
    risk_packet: Dict[str, Any],
    api_key: str,
    model: Optional[str] = None,
    base_url_env: str = "DEEPSEEK_BASE_URL",
    model_env: str = "DEEPSEEK_MODEL",
    temperature: float = 0.3,
    max_tokens: int = 800,
) -> List[Dict[str, Any]]:
    if not api_key:
        raise DeepSeekError("Missing DeepSeek API key.")

    base_url = os.getenv(base_url_env, "https://api.deepseek.com").rstrip("/")
    model_name = model or os.getenv(model_env, "deepseek-chat")
    url = f"{base_url}/chat/completions"

    payload = {
        "model": model_name,
        "messages": _build_messages(risk_packet),
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        logger.warning("DeepSeek request timed out: url=%s payload_keys=%s", url, list(payload.keys()))
        raise DeepSeekError("DeepSeek request timed out.") from exc
    if resp.status_code == 401:
        logger.warning("DeepSeek auth failed: status=401 url=%s body=%s", url, resp.text[:500])
        raise DeepSeekError("DeepSeek authentication failed (401).")
    if resp.status_code == 429:
        logger.warning("DeepSeek rate limit: status=429 url=%s body=%s", url, resp.text[:500])
        raise DeepSeekError("DeepSeek rate limit hit (429).")
    if resp.status_code >= 500:
        logger.warning("DeepSeek service error: status=%s url=%s body=%s", resp.status_code, url, resp.text[:500])
        raise DeepSeekError("DeepSeek service error.")
    if resp.status_code >= 400:
        logger.warning("DeepSeek request failed: status=%s url=%s body=%s", resp.status_code, url, resp.text[:500])
        raise DeepSeekError(f"DeepSeek request failed: {resp.text}")

    data = resp.json()
    choices = data.get("choices")
    if not choices:
        logger.warning("DeepSeek returned no choices; raw=%s", resp.text[:500])
        raise DeepSeekError("DeepSeek returned no choices.")

    content = choices[0].get("message", {}).get("content")
    if not content:
        logger.warning("DeepSeek returned empty content; raw=%s", resp.text[:500])
        raise DeepSeekError("DeepSeek returned empty content.")

    cleaned = _clean_content(content)

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        logger.warning("DeepSeek JSON parse failed; content=%s", content[:500])
        raise DeepSeekError("Failed to parse DeepSeek JSON response.") from exc

    narratives = parsed.get("narratives")
    if not isinstance(narratives, list):
        logger.warning("DeepSeek response missing narratives; parsed=%s", parsed)
        raise DeepSeekError("DeepSeek response missing narratives list.")

    return narratives
