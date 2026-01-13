from typing import TypedDict

from fastapi import HTTPException, Request


class SessionUser(TypedDict, total=False):
    """Shape of the user object stored in the session."""

    sub: str
    email: str
    name: str
    picture: str


def get_current_user(request: Request) -> SessionUser:
    """
    Return the authenticated user from the session or raise 401.

    This keeps the auth check reusable as a FastAPI dependency.
    """
    user = request.session.get("user")
    if not isinstance(user, dict) or not user.get("sub"):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return SessionUser(
        sub=user.get("sub", ""),
        email=user.get("email", ""),
        name=user.get("name", ""),
        picture=user.get("picture", ""),
    )
