import logging
import time
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Form, Response, UploadFile, status

from app.core.config import settings
from app.core.db import DbSession
from app.integrations.vision import FrameRecognizer, ProductRecognizer, build_frame_recognizer, build_recognizer
from app.modules.auth.deps import Tenant
from app.modules.vision import service
from app.modules.vision.image import MAX_IMAGE_BYTES, validate_image
from app.modules.vision.schemas import ReferenceImageRead, VisionResult

router = APIRouter(prefix="/vision", tags=["vision"])
log = logging.getLogger("uvicorn.error")  # the server's own console logger: shown without extra logging setup


def get_recognizer() -> ProductRecognizer:
    return build_recognizer(settings.effective_vision_provider, settings.real_vision)


def get_frame_recognizer() -> FrameRecognizer:
    return build_frame_recognizer(settings.effective_vision_provider, settings.real_vision)


Recognizer = Annotated[ProductRecognizer, Depends(get_recognizer)]
LiveRecognizer = Annotated[FrameRecognizer, Depends(get_frame_recognizer)]


def _timed(response: Response, started: float, what: str, result: VisionResult) -> VisionResult:
    """How long the server spent on this image: in the console, and as a Server-Timing header the
    browser shows next to the request (Network > Timing), to tell server time from everything else."""
    took = (time.perf_counter() - started) * 1000
    response.headers["Server-Timing"] = f"vision;dur={took:.0f}"
    log.info("vision %s: %.0f ms on the server, %d detections", what, took, len(result.detections))
    return result


@router.post("/recognize")
def recognize(image: UploadFile, db: DbSession, ctx: Tenant, recognizer: Recognizer, response: Response) -> VisionResult:
    """Detect products in a photo and match them to this merchant's catalog.
    Read-only: the image is not stored and nothing is added to a cart."""
    started = time.perf_counter()
    data = image.file.read(MAX_IMAGE_BYTES + 1)
    validate_image(data, image.content_type)
    return _timed(response, started, "photo", service.recognize(db, ctx, recognizer, data))


@router.post("/frames")
def recognize_frame(
    image: UploadFile,
    db: DbSession,
    ctx: Tenant,
    recognizer: LiveRecognizer,
    response: Response,
    sequence: Annotated[int, Form(ge=0)] = 0,
) -> VisionResult:
    """One live camera frame -> detections matched to this merchant's catalog.
    Read-only, like /recognize: frames are not stored and no cart is touched."""
    started = time.perf_counter()
    data = image.file.read(MAX_IMAGE_BYTES + 1)
    validate_image(data, image.content_type)
    result = service.recognize_frame(db, ctx, recognizer, data, sequence=sequence)
    return _timed(response, started, f"frame {sequence}", result)


# ---- reference photos: the merchant's own pictures of a product's packaging ----

REFERENCES = "/products/{product_id}/reference-images"


@router.get(REFERENCES)
def list_reference_images(product_id: uuid.UUID, db: DbSession, ctx: Tenant) -> list[ReferenceImageRead]:
    return service.list_reference_images(db, ctx, product_id)


@router.post(REFERENCES, status_code=status.HTTP_201_CREATED)
def add_reference_image(
    product_id: uuid.UUID, image: UploadFile, db: DbSession, ctx: Tenant, recognizer: Recognizer
) -> ReferenceImageRead:
    """Teach Vision what this product's packaging looks like. The photo itself is not kept:
    only its appearance embedding and a small thumbnail."""
    data = image.file.read(MAX_IMAGE_BYTES + 1)
    validate_image(data, image.content_type)
    reference = service.add_reference_image(db, ctx, recognizer, product_id, data)
    db.commit()
    return reference


@router.get(
    REFERENCES + "/{reference_id}/thumbnail",
    response_class=Response,
    responses={200: {"content": {"image/jpeg": {}}}},
)
def reference_image_thumbnail(product_id: uuid.UUID, reference_id: uuid.UUID, db: DbSession, ctx: Tenant) -> Response:
    reference = service.get_reference_image(db, ctx, product_id, reference_id)
    return Response(reference.thumbnail, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.delete(REFERENCES + "/{reference_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_reference_image(product_id: uuid.UUID, reference_id: uuid.UUID, db: DbSession, ctx: Tenant) -> None:
    service.delete_reference_image(db, ctx, product_id, reference_id)
    db.commit()
