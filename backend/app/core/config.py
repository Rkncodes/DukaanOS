from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

if TYPE_CHECKING:
    from app.integrations.groq import GroqConfig
    from app.integrations.paytm import PaytmConfig
    from app.integrations.vision_real import RealVisionConfig
    from app.modules.vision.matching import MatchingConfig

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

    # Which app.integrations.vision provider serves /vision/recognize and /vision/frames.
    # "real" (default) = local computer vision on the uploaded image (needs `uv sync --extra vision`);
    # "none" = vision switched off. There is no mock provider and no fallback: if the real provider
    # cannot run, the API answers 503 with the reason.
    vision_provider: Literal["real", "none"] = "real"
    vision_real_device: Literal["cpu", "cuda"] = "cpu"
    vision_real_locator_model: str = "google/owlvit-base-patch32"
    vision_real_identifier_model: str = "openai/clip-vit-base-patch32"
    vision_real_prompts: Path | None = None  # None -> app/integrations/vision_prompts.json (generic, no products)
    vision_real_min_locate_score: float = 0.15
    vision_real_ocr: bool = True  # read printed text on packs (second source of evidence)
    vision_real_ocr_side: int = 640  # OCR resolution: higher reads smaller text, slower
    # Which app.integrations.ocr reader serves /parchi/read. "ocr" (default) = local OCR on the
    # uploaded photo (needs `uv sync --extra parchi`); "none" = switched off. No mock, no fallback.
    parchi_provider: Literal["ocr", "none"] = "ocr"
    # Diagnosis only: write every pipeline stage of every recognized image to this folder
    # (frame, crops, boxes, trace.json). Unset in normal use: it stores camera images on disk.
    vision_debug_dir: Path | None = None
    # Catalog matching (app.modules.vision.matching). Scores are combined evidence, 0..1.
    vision_match_score: float = Field(default=0.75, gt=0, le=1)  # needed to preselect a product
    vision_min_score: float = Field(default=0.35, ge=0, le=1)  # below this: not in catalog
    vision_match_margin: float = Field(default=0.15, ge=0, le=1)  # lead over the runner-up, else the merchant picks
    vision_reference_floor: float = Field(default=0.65, ge=-1, le=1)  # reference-photo similarity: no support...
    vision_reference_strong: float = Field(default=0.85, ge=-1, le=1)  # ...full support

    # Paytm payment gateway (Counter "Pay with Paytm"). Off by default: the app runs without it.
    # When switched on, PAYTM_MID and PAYTM_MERCHANT_KEY are required (the app refuses to start
    # without them). "sandbox" (default) talks to Paytm's staging host; "production" takes real
    # money and is only accepted together with ENV=prod.
    paytm_enabled: bool = False
    paytm_env: Literal["sandbox", "production"] = "sandbox"
    paytm_mid: str | None = None
    paytm_merchant_key: SecretStr | None = None  # never logged, never sent to the browser
    paytm_website: str | None = None  # None -> WEBSTAGING (sandbox) / DEFAULT (production)
    paytm_callback_url: str | None = None  # optional; otherwise the URL configured for PAYTM_WEBSITE is used
    paytm_timeout_seconds: float = Field(default=15, gt=0, le=60)
    # Check Paytm's checksum on a status response before a payment counts as received.
    paytm_verify_response_signature: bool = True

    # Salaahkaar (the assistant). It answers through Groq's OpenAI-compatible API, and only by
    # calling DukaanOS's own tools (app.modules.assistant.tools). Without GROQ_API_KEY the app
    # runs normally and the assistant reports itself unavailable.
    groq_api_key: SecretStr | None = None  # backend only: never logged, never sent to the browser
    groq_model: str = "openai/gpt-oss-120b"
    groq_timeout_seconds: float = Field(default=30, gt=0, le=120)
    # The store's offset from UTC in minutes, for "today" (default +05:30, India).
    store_utc_offset_minutes: int = Field(default=330, ge=-720, le=840)

    @property
    def groq(self) -> "GroqConfig | None":
        """None when no API key is set: the assistant is then unavailable."""
        from app.integrations.groq import GroqConfig

        key = self.groq_api_key.get_secret_value().strip() if self.groq_api_key else ""
        if not key:
            return None
        return GroqConfig(api_key=key, model=self.groq_model, timeout_seconds=self.groq_timeout_seconds)

    @property
    def effective_cookie_secure(self) -> bool:
        return self.env == "prod" if self.cookie_secure is None else self.cookie_secure

    @property
    def effective_vision_provider(self) -> str:
        return self.vision_provider

    @property
    def real_vision(self) -> "RealVisionConfig":
        from app.integrations.vision_real import DEFAULT_PROMPTS, RealVisionConfig

        return RealVisionConfig(
            locator_model=self.vision_real_locator_model,
            identifier_model=self.vision_real_identifier_model,
            device=self.vision_real_device,
            prompts_path=self.vision_real_prompts or DEFAULT_PROMPTS,
            min_locate_score=self.vision_real_min_locate_score,
            ocr=self.vision_real_ocr,
            ocr_side=self.vision_real_ocr_side,
        )

    @property
    def vision_matching(self) -> "MatchingConfig":
        from app.modules.vision.matching import MatchingConfig

        return MatchingConfig(
            match_score=self.vision_match_score,
            min_score=self.vision_min_score,
            margin=self.vision_match_margin,
            reference_floor=self.vision_reference_floor,
            reference_strong=self.vision_reference_strong,
        )

    @model_validator(mode="after")
    def _matching_thresholds_are_ordered(self) -> "Settings":
        if self.vision_min_score > self.vision_match_score:
            raise ValueError("VISION_MIN_SCORE must not exceed VISION_MATCH_SCORE")
        if self.vision_reference_floor >= self.vision_reference_strong:
            raise ValueError("VISION_REFERENCE_FLOOR must be below VISION_REFERENCE_STRONG")
        return self

    @property
    def paytm(self) -> "PaytmConfig | None":
        """None when Paytm is switched off."""
        from app.integrations.paytm import HOSTS, WEBSITES, PaytmConfig

        if not self.paytm_enabled:
            return None
        assert self.paytm_mid and self.paytm_merchant_key  # guaranteed by _paytm_is_fully_configured
        return PaytmConfig(
            environment=self.paytm_env,
            host=HOSTS[self.paytm_env],
            mid=self.paytm_mid,
            merchant_key=self.paytm_merchant_key.get_secret_value(),
            website=self.paytm_website or WEBSITES[self.paytm_env],
            callback_url=self.paytm_callback_url,
            timeout_seconds=self.paytm_timeout_seconds,
            verify_response_signature=self.paytm_verify_response_signature,
        )

    @model_validator(mode="after")
    def _paytm_is_fully_configured(self) -> "Settings":
        if not self.paytm_enabled:
            return self
        missing = [
            name
            for name, value in (("PAYTM_MID", self.paytm_mid), ("PAYTM_MERCHANT_KEY", self.paytm_merchant_key))
            if value is None or not (value.get_secret_value() if isinstance(value, SecretStr) else value).strip()
        ]
        if missing:
            raise ValueError(
                f"PAYTM_ENABLED=true needs {' and '.join(missing)} (Paytm dashboard > API keys). "
                "Set them in backend/.env, or set PAYTM_ENABLED=false to run without Paytm."
            )
        if self.paytm_env == "production" and self.env != "prod":
            raise ValueError("PAYTM_ENV=production takes real money and is only allowed with ENV=prod. Use PAYTM_ENV=sandbox.")
        return self

    @model_validator(mode="after")
    def _require_real_secret_in_prod(self) -> "Settings":
        if self.env == "prod" and self.jwt_secret == INSECURE_DEV_SECRET:
            raise ValueError("JWT_SECRET must be set in prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
