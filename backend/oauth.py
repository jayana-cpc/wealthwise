import logging
import os
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from typing import Any, Optional, Protocol, cast

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.responses import Response


logger = logging.getLogger("wealthwise.oauth")

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
    raise RuntimeError("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET env var")

class GoogleOAuthClient(Protocol):
    async def authorize_redirect(self, request: Request, redirect_uri: str) -> Response: ...

    async def authorize_access_token(self, request: Request) -> dict: ...

    async def parse_id_token(self, request: Request, token: dict) -> dict: ...


oauth = OAuth()
google = oauth.register(
    name="google",
    client_id=GOOGLE_CLIENT_ID,
    client_secret=GOOGLE_CLIENT_SECRET,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)
if google is None:
    raise RuntimeError("Failed to initialize Google OAuth client")
google_client = cast(GoogleOAuthClient, google)

router = APIRouter()

def with_query_param(url: str, **params: str) -> str:
    """Return URL with the provided query params merged in."""
    parsed = urlparse(url)
    query = dict(parse_qsl(parsed.query))
    query.update({k: v for k, v in params.items() if v is not None})
    return urlunparse(parsed._replace(query=urlencode(query)))


@router.get("/auth/google/start")
async def auth_google_start(request: Request, next: Optional[str] = None):
    """
    Starts Google OAuth. Your Next.js page hits:
      /auth/google/start?next=http://localhost:3000/dashboard
    """
    if not next:
        next = f"{FRONTEND_URL}/dashboard"

    # Store where to redirect after login
    logger.info("OAuth start; next=%s", next)
    request.session["post_auth_redirect"] = next

    # This callback must be registered in Google Console:
    #   http://localhost:8001/auth/google/callback
    redirect_uri = str(request.url_for("auth_google_callback"))
    return await google_client.authorize_redirect(request, redirect_uri)


@router.get("/auth/google/callback", name="auth_google_callback")
async def auth_google_callback(request: Request):
    """
    Handles Google redirect, creates an app session, and redirects back to `next`.
    """
    try:
        logger.info("OAuth callback; query=%s", request.url.query)
        token = await google_client.authorize_access_token(request)
        if not isinstance(token, dict):
            logger.error("OAuth token unexpected type=%s", type(token))
            return RedirectResponse(url=f"{FRONTEND_URL}/?error=oauth_failed")

        logger.info("OAuth token response keys=%s", list(token.keys()))
        if "id_token" in token:
            # parse_id_token signature is (token, nonce)
            user = await google_client.parse_id_token(token, None)
        else:
            logger.warning("OAuth token missing id_token; falling back to userinfo")
            user = await google_client.userinfo(token=token)
            if hasattr(user, "json"):
                user = user.json()

        logger.info("OAuth user; sub=%s email=%s", user.get("sub"), user.get("email"))
        request.session["user"] = {
            "sub": user.get("sub"),
            "email": user.get("email"),
            "name": user.get("name"),
            "picture": user.get("picture"),
        }
    except Exception:
        logger.exception("OAuth callback failed")
        error_url = with_query_param(FRONTEND_URL, login="error", error="oauth_failed")
        return RedirectResponse(url=error_url)

    redirect_to = request.session.get("post_auth_redirect") or f"{FRONTEND_URL}/dashboard"
    redirect_to = with_query_param(redirect_to, login="success")
    return RedirectResponse(url=redirect_to)


@router.post("/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return JSONResponse({"ok": True})


@router.get("/me")
async def me(request: Request):
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user
