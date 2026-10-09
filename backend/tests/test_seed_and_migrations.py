from decimal import Decimal

from alembic import command
from sqlalchemy import func, select

from app import seed
from app.core.tenancy import TenantContext
from app.modules.catalog import service as catalog
from app.modules.catalog.models import Product
from app.modules.inventory import service as inventory
from app.modules.khata import service as khata
from app.modules.khata.models import KhataEntry
from app.modules.orders.models import Order
from app.modules.payments.models import Payment
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
    assert db.scalar(select(func.count()).select_from(Order).where(Order.merchant_id == merchant.id)) == 13

    client = make_client()
    res = client.post("/api/v1/auth/login", json={"email": seed.DEMO_EMAIL, "password": seed.DEMO_PASSWORD})
    assert res.status_code == 200
    products = client.get("/api/v1/products").json()
    assert len(products) == 24
    assert all(len(p["barcode"]) == 13 for p in products)


def test_seeded_shelves_hold_the_fixed_demo_stock_levels(db):
    merchant = seed.seed(db)
    ctx = TenantContext(merchant_id=merchant.id)
    stock = {p.name: p.stock_quantity for p in catalog.list_products(db, ctx)}

    assert stock == {name: Decimal(level) for name, _c, _p, _cost, level, _u in seed.PRODUCTS}  # fixed, not random
    assert set(stock.values()) == {Decimal(8), Decimal(60), Decimal(65), Decimal(70)}
    # The demo history sold from these products, and the shelves were then filled back up.
    assert stock["Maggi 2-Minute Noodles 70g"] == 70 and stock["Aashirvaad Atta 5kg"] == 60


def test_restock_only_changes_demo_stock_and_destroys_nothing(db):
    merchant = seed.seed(db)
    ctx = TenantContext(merchant_id=merchant.id)
    products = {p.name: p for p in catalog.list_products(db, ctx)}
    count = lambda model: db.scalar(select(func.count()).select_from(model).where(model.merchant_id == merchant.id))  # noqa: E731
    before = {model: count(model) for model in (Order, Payment, KhataEntry, Product)}

    assert seed.restock(db, ctx) == []  # already at the demo level: nothing to do

    # The store traded since: some sold down, one overstocked, and the merchant added a product of their own.
    inventory.adjust_stock(db, ctx, products["Aashirvaad Atta 5kg"].id, Decimal(-52))
    inventory.adjust_stock(db, ctx, products["Maggi 2-Minute Noodles 70g"].id, Decimal(30))
    own = Product(merchant_id=merchant.id, name="Homemade Pickle 500g", price=Decimal(120), stock_quantity=Decimal(4))
    db.add(own)
    db.flush()

    assert seed.restock(db, ctx) == [
        ("Aashirvaad Atta 5kg", Decimal(8), Decimal(60)),
        ("Maggi 2-Minute Noodles 70g", Decimal(100), Decimal(70)),
    ]
    assert products["Aashirvaad Atta 5kg"].stock_quantity == 60 and products["Maggi 2-Minute Noodles 70g"].stock_quantity == 70
    assert own.stock_quantity == 4  # not a demo product: left alone
    assert {model: count(model) for model in before} == before | {Product: before[Product] + 1}
    assert seed.restock(db, ctx) == []


def test_seed_reset_purges_and_recreates(db):
    first = seed.seed(db)
    seed._purge_merchant(db, first.id)
    db.flush()
    second = seed.seed(db)
    assert second.id != first.id and second.store_slug == seed.DEMO_SLUG
