from sqlalchemy import select

from app.core.config import settings
from app.modules.merchants.models import User
from tests.conftest import register


def test_health(make_client):
    res = make_client().get("/api/v1/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "database": "ok"}


def test_register_creates_merchant_owner_and_httponly_session_cookie(make_client, db):
    client = make_client()
    res = client.post(
        "/api/v1/auth/register",
        json={"name": "Ramesh", "email": "Ramesh@Example.com", "password": "password123", "store_name": "Ramesh Store"},
    )
    assert res.status_code == 201
    body = res.json()
    assert body["user"]["email"] == "ramesh@example.com"
    assert body["user"]["role"] == "owner"
    assert body["merchant"]["store_slug"] == "ramesh-store"

    set_cookie = res.headers["set-cookie"]
    assert settings.session_cookie_name in set_cookie
    assert "HttpOnly" in set_cookie
    assert "samesite=lax" in set_cookie.lower()

    user = db.scalar(select(User).where(User.email == "ramesh@example.com"))
    assert user.password_hash != "password123"
    assert user.password_hash.startswith("$argon2")


def test_me_requires_authentication(make_client):
    res = make_client().get("/api/v1/auth/me")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "unauthorized"


def test_login_me_logout(make_client):
    register(make_client(), "owner@dukaanos.dev", "My Store")
    client = make_client()

    bad = client.post("/api/v1/auth/login", json={"email": "owner@dukaanos.dev", "password": "wrong-password"})
    assert bad.status_code == 401
    unknown = client.post("/api/v1/auth/login", json={"email": "nobody@dukaanos.dev", "password": "password123"})
    assert unknown.status_code == 401
    assert bad.json()["error"]["message"] == unknown.json()["error"]["message"]

    ok = client.post("/api/v1/auth/login", json={"email": "OWNER@dukaanos.dev", "password": "password123"})
    assert ok.status_code == 200
    assert client.get("/api/v1/auth/me").json()["merchant"]["store_name"] == "My Store"

    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401


def test_logout_expires_the_session_cookie_and_closes_every_merchant_route(make_client):
    client = make_client()
    slug = register(client, "owner@dukaanos.dev", "My Store")["merchant"]["store_slug"]
    merchant_routes = ["/api/v1/auth/me", "/api/v1/products", "/api/v1/customers", "/api/v1/khata/balances", "/api/v1/orders"]
    for url in merchant_routes:
        assert client.get(url).status_code == 200

    res = client.post("/api/v1/auth/logout")
    assert res.status_code == 204
    # The browser is told to drop the cookie: same name, path and flags as it was set with, already expired.
    set_cookie = res.headers["set-cookie"]
    assert set_cookie.startswith(f'{settings.session_cookie_name}="";') or set_cookie.startswith(f"{settings.session_cookie_name}=;")
    assert "Max-Age=0" in set_cookie and "Path=/" in set_cookie and "HttpOnly" in set_cookie
    assert settings.session_cookie_name not in client.cookies

    for url in merchant_routes:
        assert client.get(url).status_code == 401, url
    # Logging out twice is harmless, and the public storefront never needed the session.
    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get(f"/api/v1/public/stores/{slug}").status_code == 200


def test_duplicate_email_rejected(make_client):
    register(make_client(), "dup@dukaanos.dev", "Store One")
    res = make_client().post(
        "/api/v1/auth/register",
        json={"name": "X", "email": "dup@dukaanos.dev", "password": "password123", "store_name": "Store Two"},
    )
    assert res.status_code == 409


def test_store_slugs_are_unique(make_client):
    a = register(make_client(), "one@dukaanos.dev", "Sharma Kirana")
    b = register(make_client(), "two@dukaanos.dev", "Sharma Kirana")
    assert a["merchant"]["store_slug"] == "sharma-kirana"
    assert b["merchant"]["store_slug"] == "sharma-kirana-2"


def test_tampered_token_rejected(make_client):
    client = make_client()
    client.cookies.set(settings.session_cookie_name, "not-a-jwt")
    assert client.get("/api/v1/products").status_code == 401


def test_short_password_rejected(make_client):
    res = make_client().post(
        "/api/v1/auth/register",
        json={"name": "X", "email": "short@dukaanos.dev", "password": "123", "store_name": "S"},
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "validation_error"
