from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]

INSECURE_DEV_SECRET = "dev-insecure-secret-change-me-before-deploying"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"

    database_url: str = "postgresql+psycopg://dukaanos:dukaanos@localhost:5432/dukaanos"
    test_database_url: str = "postgresql+psycopg://dukaanos:dukaanos@localhost:5432/dukaanos_test"

    jwt_secret: str = INSECURE_DEV_SECRET
    jwt_expire_minutes: int = 60 * 24 * 7
    session_cookie_name: str = "dukaanos_session"
    # None -> secure cookies only in prod (browsers allow Secure on http://localhost,
    # but the test client does not).
    cookie_secure: bool | None = None

    cors_origins: list[str] = ["http://localhost:5173"]

    @property
    def effective_cookie_secure(self) -> bool:
        return self.env == "prod" if self.cookie_secure is None else self.cookie_secure

    @model_validator(mode="after")
    def _require_real_secret_in_prod(self) -> "Settings":
        if self.env == "prod" and self.jwt_secret == INSECURE_DEV_SECRET:
            raise ValueError("JWT_SECRET must be set in prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
