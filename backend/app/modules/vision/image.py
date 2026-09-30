"""Upload validation. Images are checked in memory and never stored."""

import warnings
from io import BytesIO

from PIL import Image, UnidentifiedImageError

from app.core.errors import DomainError

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
_ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}


class InvalidImage(DomainError):
    status_code = 422
    code = "invalid_image"


class ImageTooLarge(DomainError):
    status_code = 413
    code = "image_too_large"


def validate_image(data: bytes, content_type: str | None) -> None:
    """Raise unless `data` is a complete, decodable JPEG/PNG/WebP within the limits.
    The declared content type is checked, but the decoded bytes are what we trust."""
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageTooLarge(f"Image is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
    if not data:
        raise InvalidImage("The uploaded file is empty")
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise InvalidImage("Upload a JPEG, PNG or WebP image", details={"content_type": content_type})
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as img:
                if img.format not in _ALLOWED_FORMATS:
                    raise InvalidImage("Upload a JPEG, PNG or WebP image", details={"format": img.format})
                width, height = img.size
                if width * height > MAX_IMAGE_PIXELS:
                    raise InvalidImage("Image dimensions are too large")
                img.load()  # decode pixels: catches truncated files whose header parses fine
    except InvalidImage:
        raise
    except (
        UnidentifiedImageError,
        OSError,
        SyntaxError,
        ValueError,
        Image.DecompressionBombWarning,
        Image.DecompressionBombError,
    ) as exc:
        raise InvalidImage("The file is not a readable image") from exc
