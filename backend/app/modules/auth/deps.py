from typing import Annotated

from fastapi import Depends, Request

from app.core.config import settings
from app.core.db import DbSession
from app.core.errors import Unauthorized
from app.core.security import decode_access_token
from app.core.tenancy import TenantContext
from app.modules.merchants.models import User


def get_current_user(request: Request, db: DbSession) -> User:
    token = request.cookies.get(settings.session_cookie_name)
    user_id = decode_access_token(token) if token else None
    user = db.get(User, user_id) if user_id else None
    if user is None:
        raise Unauthorized("Not authenticated")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_tenant(user: CurrentUser) -> TenantContext:
    return TenantContext(merchant_id=user.merchant_id, user_id=user.id, role=user.role)


Tenant = Annotated[TenantContext, Depends(get_tenant)]
