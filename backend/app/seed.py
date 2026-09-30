"""Development seed: one demo merchant, built through the real services.

    uv run python -m app.seed          # create if missing
    uv run python -m app.seed --reset  # delete and recreate the demo merchant

Login: ramesh@dukaanos.dev / demo1234
Barcodes are demo EAN-13 values (valid check digit), not real product barcodes.
"""

import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.db import SessionLocal
from app.core.enums import Channel, CheckoutMethod, InputSource, PaymentMethod
from app.core.tenancy import TenantContext
from app.modules.auth import service as auth
from app.modules.auth.schemas import RegisterRequest
from app.modules.billing import service as billing
from app.modules.billing.models import Cart
from app.modules.billing.schemas import CartCreate, CheckoutRequest
from app.modules.catalog import service as catalog
from app.modules.catalog.models import Category, Product
from app.modules.catalog.schemas import CategoryCreate, ProductCreate
from app.modules.customers import service as customers
from app.modules.customers.models import Customer
from app.modules.customers.schemas import CustomerCreate
from app.modules.khata import service as khata
from app.modules.khata.models import KhataEntry
from app.modules.merchants.models import Merchant
from app.modules.orders import service as orders
from app.modules.orders.models import Order
from app.modules.payments.models import Payment

DEMO_EMAIL = "ramesh@dukaanos.dev"
DEMO_PASSWORD = "demo1234"
DEMO_SLUG = "ramesh-general-store"

# name, category, price, cost_price, stock, unit
PRODUCTS = [
    ("Kurkure Masala Munch 90g", "Snacks", "20", "16.50", 48, "pcs"),
    ("Lays Classic Salted 52g", "Snacks", "20", "16.50", 60, "pcs"),
    ("Maggi 2-Minute Noodles 70g", "Instant Food", "14", "12.00", 120, "pcs"),
    ("Coke 750ml", "Beverages", "40", "33.00", 36, "pcs"),
    ("Pepsi 750ml", "Beverages", "40", "33.00", 30, "pcs"),
    ("Thums Up 750ml", "Beverages", "40", "33.00", 30, "pcs"),
    ("Amul Taaza Milk 500ml", "Dairy", "28", "26.00", 40, "pcs"),
    ("Parle-G Biscuits 250g", "Biscuits & Chocolates", "25", "21.00", 80, "pcs"),
    ("Britannia Good Day 100g", "Biscuits & Chocolates", "30", "25.00", 40, "pcs"),
    ("Dairy Milk Chocolate 50g", "Biscuits & Chocolates", "50", "42.00", 45, "pcs"),
    ("Aashirvaad Atta 5kg", "Staples", "295", "270.00", 20, "pcs"),
    ("Tata Salt 1kg", "Staples", "28", "24.00", 50, "pcs"),
    ("Surf Excel Easy Wash 1kg", "Household", "140", "122.00", 18, "pcs"),
    ("Dettol Antiseptic Liquid 125ml", "Personal Care", "75", "64.00", 15, "pcs"),
    ("Colgate Strong Teeth 200g", "Personal Care", "110", "94.00", 25, "pcs"),
]

CUSTOMERS = [
    ("Rahul Sharma", "9810010001"),
    ("Aman Verma", "9810010002"),
    ("Priya Singh", "9810010003"),
    ("Rohit Gupta", "9810010004"),
    ("Neha Kapoor", "9810010005"),
    ("Vikram Yadav", "9810010006"),
]


def _ean13(n: int) -> str:
    body = f"890{n:09d}"
    total = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(body))
    return body + str((10 - total % 10) % 10)


def _sku(name: str) -> str:
    return "RGS-" + "".join(w[0] for w in name.upper().split() if w[0].isalnum())[:6]


class _Clock:
    """Backdates seeded records so the demo has a two-week history."""

    def __init__(self) -> None:
        self.now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)

    def at(self, days_ago: int, hour: int) -> datetime:
        return (self.now - timedelta(days=days_ago)).replace(hour=hour)


def seed(db: Session) -> Merchant:
    user = auth.register(
        db,
        RegisterRequest(
            name="Ramesh Kumar",
            email=DEMO_EMAIL,
            password=DEMO_PASSWORD,
            store_name="Ramesh General Store",
            phone="9810000000",
        ),
    )
    ctx = TenantContext(merchant_id=user.merchant_id, user_id=user.id, role=user.role)
    clock = _Clock()

    categories = {
        name: catalog.create_category(db, ctx, CategoryCreate(name=name)).id
        for name in dict.fromkeys(p[1] for p in PRODUCTS)
    }
    products = {}
    for i, (name, category, price, cost, stock, unit) in enumerate(PRODUCTS, start=1):
        products[name] = catalog.create_product(
            db,
            ctx,
            ProductCreate(
                name=name,
                category_id=categories[category],
                sku=_sku(name),
                barcode=_ean13(i),
                price=Decimal(price),
                cost_price=Decimal(cost),
                stock_quantity=Decimal(stock),
                unit=unit,
            ),
        ).id
    cust = {
        name.split()[0]: customers.create_customer(db, ctx, CustomerCreate(name=name, phone=phone)).id
        for name, phone in CUSTOMERS
    }

    def backdate(when: datetime, *objs) -> None:
        for obj in objs:
            obj.created_at = when
            if hasattr(obj, "updated_at"):
                obj.updated_at = when

    def sale(days_ago, hour, items, method, customer=None, source=InputSource.MANUAL):
        cart = billing.create_cart(
            db, ctx, CartCreate(channel=Channel.COUNTER, customer_id=cust[customer] if customer else None)
        )
        for product, qty in items:
            billing.add_item(db, ctx, cart.id, products[product], Decimal(qty), source)
        order = orders.checkout(db, ctx, cart.id, CheckoutRequest(method=method))
        when = clock.at(days_ago, hour)
        related = [
            *db.scalars(select(KhataEntry).where(KhataEntry.order_id == order.id)),
            *db.scalars(select(Payment).where(Payment.order_id == order.id)),
        ]
        backdate(when, cart, order, *order.items, *cart.items, *related)

    def credit(days_ago, hour, customer, amount, description):
        entry = khata.add_credit(db, ctx, cust[customer], Decimal(amount), description=description)
        backdate(clock.at(days_ago, hour), entry)

    def repay(days_ago, hour, customer, amount, method, description=None):
        entry = khata.record_payment(db, ctx, cust[customer], Decimal(amount), method=method, description=description)
        backdate(clock.at(days_ago, hour), entry, db.get(Payment, entry.payment_id))

    # Opening balances carried over from the paper khata
    credit(14, 10, "Rahul", "450", "Purana hisaab")
    credit(14, 10, "Priya", "1200", "August ka saman")
    credit(14, 11, "Rohit", "300", "Purana hisaab")
    credit(13, 18, "Aman", "150", "Doodh aur bread")

    # Counter sales (cash / UPI / khata)
    sale(12, 9, [("Maggi 2-Minute Noodles 70g", 4), ("Amul Taaza Milk 500ml", 2)], CheckoutMethod.KHATA, "Rahul")
    sale(11, 19, [("Coke 750ml", 2), ("Lays Classic Salted 52g", 3)], CheckoutMethod.CASH)
    sale(10, 12, [("Aashirvaad Atta 5kg", 1), ("Tata Salt 1kg", 1), ("Surf Excel Easy Wash 1kg", 1)],
         CheckoutMethod.KHATA, "Priya")
    sale(9, 17, [("Parle-G Biscuits 250g", 2), ("Dairy Milk Chocolate 50g", 1)], CheckoutMethod.UPI, "Neha",
         InputSource.BARCODE)
    repay(8, 20, "Aman", "150", PaymentMethod.CASH, "Hisaab clear")
    sale(7, 18, [("Thums Up 750ml", 2), ("Kurkure Masala Munch 90g", 3)], CheckoutMethod.KHATA, "Vikram")
    repay(6, 11, "Priya", "1000", PaymentMethod.UPI)
    sale(5, 8, [("Amul Taaza Milk 500ml", 4), ("Britannia Good Day 100g", 2)], CheckoutMethod.CASH)
    repay(4, 19, "Rahul", "200", PaymentMethod.CASH)
    sale(3, 13, [("Colgate Strong Teeth 200g", 1), ("Dettol Antiseptic Liquid 125ml", 1)], CheckoutMethod.KHATA,
         "Rohit")
    sale(2, 18, [("Pepsi 750ml", 3), ("Kurkure Masala Munch 90g", 2)], CheckoutMethod.UPI)
    repay(1, 20, "Vikram", "140", PaymentMethod.CASH, "Poora hisaab")
    sale(0, 9, [("Maggi 2-Minute Noodles 70g", 6), ("Amul Taaza Milk 500ml", 2)], CheckoutMethod.KHATA, "Rahul",
         InputSource.VOICE)

    db.flush()
    return user.merchant


def _purge_merchant(db: Session, merchant_id) -> None:
    """Dev-only. Children first: history tables deliberately don't cascade from products."""
    for model in (KhataEntry, Payment, Order, Cart, Product, Category, Customer):
        db.execute(delete(model).where(model.merchant_id == merchant_id))
    db.execute(delete(Merchant).where(Merchant.id == merchant_id))  # cascades users


def main() -> None:
    reset = "--reset" in sys.argv
    with SessionLocal() as db:
        existing = db.scalar(select(Merchant).where(Merchant.store_slug == DEMO_SLUG))
        if existing is not None:
            if not reset:
                print(f"Demo merchant already exists ({DEMO_EMAIL}). Use --reset to recreate.")
                return
            _purge_merchant(db, existing.id)
        merchant = seed(db)
        db.commit()
        print(f"Seeded {merchant.store_name} ({merchant.store_slug}). Login: {DEMO_EMAIL} / {DEMO_PASSWORD}")


if __name__ == "__main__":
    main()
