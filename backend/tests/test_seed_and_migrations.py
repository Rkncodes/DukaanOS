from decimal import Decimal

from alembic import command
from sqlalchemy import func, select

from app import seed
from app.core.tenancy import TenantContext
from app.modules.khata import service as khata
from app.modules.orders.models import Order
from tests.conftest import alembic_config


def test_models_match_migrations():
    """Fails if a model changed without a new Alembic revision."""
    command.check(alembic_config())


def test_migrations_downgrade_and_upgrade():
    cfg = alembic_config()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")


def test_seed_builds_demo_merchant_via_services(db, make_client):
    merchant = seed.seed(db)
    ctx = TenantContext(merchant_id=merchant.id)

    balances = {b.customer_name.split()[0]: b.balance for b in khata.list_balances(db, ctx)}
    assert balances == {
        "Priya": Decimal("663.00"),
        "Rahul": Decimal("502.00"),
        "Rohit": Decimal("485.00"),
        "Aman": Decimal("0.00"),
        "Neha": Decimal("0.00"),
        "Vikram": Decimal("0.00"),
    }
    assert db.scalar(select(func.count()).select_from(Order).where(Order.merchant_id == merchant.id)) == 9

    client = make_client()
    res = client.post("/api/v1/auth/login", json={"email": seed.DEMO_EMAIL, "password": seed.DEMO_PASSWORD})
    assert res.status_code == 200
    products = client.get("/api/v1/products").json()
    assert len(products) == 15
    assert all(len(p["barcode"]) == 13 for p in products)


def test_seed_reset_purges_and_recreates(db):
    first = seed.seed(db)
    seed._purge_merchant(db, first.id)
    db.flush()
    second = seed.seed(db)
    assert second.id != first.id and second.store_slug == seed.DEMO_SLUG
