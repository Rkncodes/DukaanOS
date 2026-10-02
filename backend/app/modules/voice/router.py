from fastapi import APIRouter

from app.core.db import DbSession
from app.modules.auth.deps import Tenant
from app.modules.voice import service
from app.modules.voice.schemas import VoiceRequest, VoiceResult

router = APIRouter(prefix="/voice", tags=["voice"])


@router.post("/parse")
def parse_transcript(data: VoiceRequest, db: DbSession, ctx: Tenant) -> VoiceResult:
    """Turn a speech-to-text transcript into items matched to this merchant's catalogue.
    Read-only: nothing is stored and nothing is added to a cart."""
    return service.parse_transcript(db, ctx, data.transcript)
