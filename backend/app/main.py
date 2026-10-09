from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import API_PREFIX, api_router
from app.core.config import settings
from app.core.errors import register_error_handlers
from app.core.process import run_at_full_speed

run_at_full_speed()  # before any model work: see app.core.process


def create_app() -> FastAPI:
    app = FastAPI(
        title="DukaanOS API",
        version="0.1.0",
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,  # session cookie
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    app.include_router(api_router)
    return app


app = create_app()
