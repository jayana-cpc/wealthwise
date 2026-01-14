import base64
import os
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _load_key_from_env(env_key: str) -> bytes:
    raw = os.getenv(env_key)
    if not raw:
        raise RuntimeError(f"Missing {env_key} env var for encryption key.")
    try:
        key = base64.b64decode(raw)
    except Exception as exc:
        raise RuntimeError(f"Failed to base64-decode {env_key}.") from exc
    if len(key) != 32:
        raise RuntimeError(f"{env_key} must decode to 32 bytes for AES-256-GCM.")
    return key


def encrypt_secret(value: str, env_key: str = "DEEPSEEK_KEY_ENC_KEY") -> str:
    """
    Encrypt a short secret using AES-256-GCM and return a base64 payload.

    Output layout: base64(nonce + ciphertext). AAD is unused by design.
    """
    key = _load_key_from_env(env_key)
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ciphertext = aesgcm.encrypt(nonce, value.encode("utf-8"), None)
    return base64.b64encode(nonce + ciphertext).decode("ascii")


def decrypt_secret(encoded: str, env_key: str = "DEEPSEEK_KEY_ENC_KEY") -> Optional[str]:
    key = _load_key_from_env(env_key)
    try:
        payload = base64.b64decode(encoded)
    except Exception:
        return None
    if len(payload) < 13:
        return None
    nonce, ciphertext = payload[:12], payload[12:]
    aesgcm = AESGCM(key)
    try:
        plaintext = aesgcm.decrypt(nonce, ciphertext, None)
        return plaintext.decode("utf-8")
    except Exception:
        return None
