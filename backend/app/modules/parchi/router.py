from typing import Annotated

from fastapi import APIRouter, Depends, UploadFile

from app.core.config import settings
from app.core.db import DbSession
from app.integrations.ocr import ParchiReader, build_parchi_reader
from app.modules.auth.deps import Tenant
from app.modules.parchi import service
from app.modules.parchi.schemas import ParchiResult
from app.modules.vision.image import MAX_IMAGE_BYTES, validate_image  # shared upload validation

router = APIRouter(prefix="/parchi", tags=["parchi"])


def get_parchi_reader() -> ParchiReader:
    return build_parchi_reader(settings.parchi_provider)


Reader = Annotated[ParchiReader, Depends(get_parchi_reader)]


@router.post("/read")
def read_parchi(image: UploadFile, db: DbSession, ctx: Tenant, reader: Reader) -> ParchiResult:
    """Read a photo of a parchi and match each line to this merchant's catalogue.
    Read-only: the image is not stored and nothing is added to a cart."""
    data = image.file.read(MAX_IMAGE_BYTES + 1)
    validate_image(data, image.content_type)
    return service.read_parchi(db, ctx, reader, data)
