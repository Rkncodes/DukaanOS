from typing import Annotated

from fastapi import APIRouter, Depends, Form, UploadFile

from app.core.config import settings
from app.core.db import DbSession
from app.integrations.vision import FrameRecognizer, ProductRecognizer, build_frame_recognizer, build_recognizer
from app.modules.auth.deps import Tenant
from app.modules.vision import service
from app.modules.vision.image import MAX_IMAGE_BYTES, validate_image
from app.modules.vision.schemas import VisionResult

router = APIRouter(prefix="/vision", tags=["vision"])


def get_recognizer() -> ProductRecognizer:
    return build_recognizer(settings.effective_vision_provider)


def get_frame_recognizer() -> FrameRecognizer:
    return build_frame_recognizer(settings.effective_vision_provider)


Recognizer = Annotated[ProductRecognizer, Depends(get_recognizer)]
LiveRecognizer = Annotated[FrameRecognizer, Depends(get_frame_recognizer)]


@router.post("/recognize")
def recognize(image: UploadFile, db: DbSession, ctx: Tenant, recognizer: Recognizer) -> VisionResult:
    """Detect products in a photo and match them to this merchant's catalog.
    Read-only: the image is not stored and nothing is added to a cart."""
    data = image.file.read(MAX_IMAGE_BYTES + 1)
    validate_image(data, image.content_type)
    return service.recognize(db, ctx, recognizer, data)


@router.post("/frames")
def recognize_frame(
    image: UploadFile,
    db: DbSession,
    ctx: Tenant,
    recognizer: LiveRecognizer,
    sequence: Annotated[int, Form(ge=0)] = 0,
) -> VisionResult:
    """One live camera frame -> detections matched to this merchant's catalog.
    Read-only, like /recognize: frames are not stored and no cart is touched."""
    data = image.file.read(MAX_IMAGE_BYTES + 1)
    validate_image(data, image.content_type)
    return service.recognize_frame(db, ctx, recognizer, data, sequence=sequence)
