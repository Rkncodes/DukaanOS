import uuid

from sqlalchemy import JSON, ForeignKey, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, CreatedAt, MerchantScoped, UUIDPk


class ProductReferenceImage(UUIDPk, MerchantScoped, CreatedAt, Base):
    """A photo of a catalog product's real packaging, used as visual evidence by Vision.

    Stores the appearance embedding (computed once, by the provider model named in `model`)
    and a small thumbnail for review; the original upload is not kept.
    """

    __tablename__ = "product_reference_images"

    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    model: Mapped[str] = mapped_column(String(160))  # embeddings from other models are not comparable
    embedding: Mapped[list[float]] = mapped_column(JSON)
    thumbnail: Mapped[bytes] = mapped_column(LargeBinary)  # JPEG, longest side <= 256 px
