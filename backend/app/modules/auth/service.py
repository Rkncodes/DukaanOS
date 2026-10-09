import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import UserRole
from app.core.errors import Conflict, Unauthorized
from app.core.security import hash_password, verify_password
from app.modules.auth.schemas import MerchantUpdate, RegisterRequest
from app.modules.merchants.models import Merchant, User

# Verified against when the email is unknown, so response time doesn't reveal which emails exist.
_DUMMY_HASH = hash_password("dummy-password-for-timing")


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:70] or "store"


def _unique_slug(db: Session, store_name: str) -> str:
    base = _slugify(store_name)
    slug, n = base, 1
    while db.scalar(select(Merchant.id).where(Merchant.store_slug == slug)) is not None:
        n += 1
        slug = f"{base}-{n}"
    return slug


def register(db: Session, data: RegisterRequest) -> User:
    """Creates a merchant (store) and its owner user."""
    email = data.email.lower()
    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise Conflict("An account with this email already exists")

    merchant = Merchant(
        name=data.name,
        email=email,
        phone=data.phone,
        store_name=data.store_name,
        store_slug=_unique_slug(db, data.store_name),
    )
    user = User(
        merchant=merchant,
        name=data.name,
        email=email,
        password_hash=hash_password(data.password),
        role=UserRole.OWNER,
    )
    db.add_all([merchant, user])
    db.flush()
    return user


def update_merchant(db: Session, user: User, data: MerchantUpdate) -> Merchant:
    merchant = user.merchant
    merchant.gstin = data.gstin
    db.flush()
    return merchant


def authenticate(db: Session, email: str, password: str) -> User:
    user = db.scalar(select(User).where(User.email == email.lower()))
    if user is None:
        verify_password(password, _DUMMY_HASH)
        raise Unauthorized("Invalid email or password")
    if not verify_password(password, user.password_hash):
        raise Unauthorized("Invalid email or password")
    return user
