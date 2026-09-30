from fastapi import APIRouter, Response, status

from app.core.config import settings
from app.core.db import DbSession
from app.core.security import create_access_token
from app.modules.auth import service
from app.modules.auth.deps import CurrentUser
from app.modules.auth.schemas import LoginRequest, MerchantRead, RegisterRequest, SessionRead, UserRead
from app.modules.merchants.models import User

router = APIRouter(prefix="/auth", tags=["auth"])


def _set_session_cookie(response: Response, user: User) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=create_access_token(user.id),
        max_age=settings.jwt_expire_minutes * 60,
        httponly=True,
        secure=settings.effective_cookie_secure,
        samesite="lax",
        path="/",
    )


def _session(user: User) -> SessionRead:
    return SessionRead(user=UserRead.model_validate(user), merchant=MerchantRead.model_validate(user.merchant))


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(data: RegisterRequest, response: Response, db: DbSession) -> SessionRead:
    user = service.register(db, data)
    db.commit()
    _set_session_cookie(response, user)
    return _session(user)


@router.post("/login")
def login(data: LoginRequest, response: Response, db: DbSession) -> SessionRead:
    user = service.authenticate(db, data.email, data.password)
    _set_session_cookie(response, user)
    return _session(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response) -> None:
    response.delete_cookie(
        settings.session_cookie_name,
        path="/",
        httponly=True,
        secure=settings.effective_cookie_secure,
        samesite="lax",
    )


@router.get("/me")
def me(user: CurrentUser) -> SessionRead:
    return _session(user)
