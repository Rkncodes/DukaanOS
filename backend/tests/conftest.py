"""Tests run against a real Postgres database (TEST_DATABASE_URL).

The schema is rebuilt from scratch with Alembic once per session (so every run
verifies migrations on a clean database). Each test runs inside an outer
transaction that is rolled back; app sessions join it via savepoints, so the
routers' db.commit() calls work normally.
"""

from collections.abc import Callable, Iterator

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, text
from sqlalchemy.orm import Session

from app.core.config import BACKEND_DIR, settings
from app.core.db import get_db
from app.main import app

engine = create_engine(settings.test_database_url)


def alembic_config() -> Config:
    cfg = Config(BACKEND_DIR / "alembic.ini")
    cfg.attributes["database_url"] = settings.test_database_url
    cfg.attributes["configure_logger"] = False
    return cfg


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> Iterator[None]:
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    command.upgrade(alembic_config(), "head")
    yield
    engine.dispose()


@pytest.fixture
def connection() -> Iterator[Connection]:
    conn = engine.connect()
    trans = conn.begin()
    yield conn
    trans.rollback()
    conn.close()


def _session(connection: Connection) -> Session:
    return Session(bind=connection, join_transaction_mode="create_savepoint", expire_on_commit=False)


@pytest.fixture
def db(connection: Connection) -> Iterator[Session]:
    session = _session(connection)
    yield session
    session.close()


@pytest.fixture
def make_client(connection: Connection) -> Iterator[Callable[[], TestClient]]:
    """Each client has its own cookie jar, i.e. its own logged-in user."""

    def _get_db() -> Iterator[Session]:
        session = _session(connection)
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_db
    yield lambda: TestClient(app)
    app.dependency_overrides.clear()


def register(client: TestClient, email: str, store_name: str, password: str = "password123") -> dict:
    res = client.post(
        "/api/v1/auth/register",
        json={"name": store_name + " Owner", "email": email, "password": password, "store_name": store_name},
    )
    assert res.status_code == 201, res.text
    return res.json()


@pytest.fixture
def client_a(make_client) -> TestClient:
    client = make_client()
    register(client, "a@dukaanos.dev", "Store A")
    return client


@pytest.fixture
def client_b(make_client) -> TestClient:
    client = make_client()
    register(client, "b@dukaanos.dev", "Store B")
    return client


def create_product(client: TestClient, **overrides) -> dict:
    payload = {"name": "Maggi", "price": "14.00", "stock_quantity": "10", "barcode": None} | overrides
    res = client.post("/api/v1/products", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def create_customer(client: TestClient, **overrides) -> dict:
    res = client.post("/api/v1/customers", json={"name": "Rahul", "phone": "9999900000"} | overrides)
    assert res.status_code == 201, res.text
    return res.json()


def create_cart(client: TestClient, **payload) -> dict:
    res = client.post("/api/v1/carts", json=payload)
    assert res.status_code == 201, res.text
    return res.json()
