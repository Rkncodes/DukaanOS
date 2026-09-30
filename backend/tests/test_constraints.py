"""Database-level constraints: the last line of defence if a service has a bug."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError

from app.modules.billing.models import Cart, CartItem
from app.modules.catalog.models import Product
from app.modules.customers.models import Customer
from app.modules.khata.models import KhataEntry
from app.modules.merchants.models import Merchant, User
from app.modules.orders.models import Order
from app.modules.payments.models import Payment


def _merchant(db, slug: str) -> Merchant:
    m = Merchant(name="Owner", store_name=slug, store_slug=slug)
    db.add(m)
    db.flush()
    return m


def _violates(db, *objs) -> None:
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add_all(objs)
            db.flush()


def test_product_constraints(db):
    m = _merchant(db, "c-1")
    other = _merchant(db, "c-2")
    db.add(Product(merchant_id=m.id, name="Maggi", price=Decimal(14), barcode="111", sku="S1"))
    db.flush()

    _violates(db, Product(merchant_id=m.id, name="Neg", price=Decimal(-1)))
    _violates(db, Product(merchant_id=m.id, name="Neg cost", price=Decimal(1), cost_price=Decimal(-1)))
    _violates(db, Product(merchant_id=m.id, name="Neg stock", price=Decimal(1), stock_quantity=Decimal(-1)))
    _violates(db, Product(merchant_id=m.id, name="Dup barcode", price=Decimal(1), barcode="111"))
    _violates(db, Product(merchant_id=m.id, name="Dup sku", price=Decimal(1), sku="S1"))
    _violates(db, Product(merchant_id=uuid.uuid4(), name="No merchant", price=Decimal(1)))

    # Same barcode for a different merchant, and multiple NULL barcodes, are fine.
    db.add_all(
        [
            Product(merchant_id=other.id, name="Maggi", price=Decimal(14), barcode="111"),
            Product(merchant_id=m.id, name="Loose 1", price=Decimal(1)),
            Product(merchant_id=m.id, name="Loose 2", price=Decimal(1)),
        ]
    )
    db.flush()


def test_merchant_and_user_uniqueness(db):
    m = _merchant(db, "slug-x")
    _violates(db, Merchant(name="O", store_name="Dup", store_slug="slug-x"))
    db.add(User(merchant_id=m.id, name="U", email="u@x.dev", password_hash="h"))
    db.flush()
    _violates(db, User(merchant_id=m.id, name="U2", email="u@x.dev", password_hash="h"))
    _violates(db, User(merchant_id=m.id, name="U3", email="u3@x.dev", password_hash="h", role="superadmin"))


def test_enum_check_constraints(db):
    m = _merchant(db, "c-enum")
    _violates(db, Cart(merchant_id=m.id, status="bogus"))
    _violates(db, Cart(merchant_id=m.id, channel="whatsapp"))
    _violates(db, Payment(merchant_id=m.id, amount=Decimal(1), method="bitcoin", status="succeeded", provider="x"))


def test_cart_item_constraints(db):
    m = _merchant(db, "c-cart")
    product = Product(merchant_id=m.id, name="P", price=Decimal(10))
    cart = Cart(merchant_id=m.id)
    db.add_all([product, cart])
    db.flush()
    _violates(db, CartItem(cart_id=cart.id, product_id=product.id, quantity=Decimal(0), unit_price=Decimal(10)))
    _violates(db, CartItem(cart_id=cart.id, product_id=product.id, quantity=Decimal(1), unit_price=Decimal(10),
                           source="telepathy"))
    db.add(CartItem(cart_id=cart.id, product_id=product.id, quantity=Decimal(1), unit_price=Decimal(10)))
    db.flush()
    _violates(db, CartItem(cart_id=cart.id, product_id=product.id, quantity=Decimal(1), unit_price=Decimal(10)))


def test_order_totals_must_be_consistent(db):
    m = _merchant(db, "c-order")
    base = dict(merchant_id=m.id, channel="counter")
    _violates(db, Order(**base, subtotal=Decimal(100), discount=Decimal(0), total=Decimal(90)))
    _violates(db, Order(**base, subtotal=Decimal(100), discount=Decimal(150), total=Decimal(-50)))
    _violates(db, Order(**base, subtotal=Decimal(100), discount=Decimal(-1), total=Decimal(101)))
    db.add(Order(**base, subtotal=Decimal(100), discount=Decimal(10), total=Decimal(90)))
    db.flush()


def test_khata_constraints(db):
    m = _merchant(db, "c-khata")
    customer = Customer(merchant_id=m.id, name="C")
    db.add(customer)
    db.flush()
    base = dict(merchant_id=m.id, customer_id=customer.id)
    _violates(db, KhataEntry(**base, type="credit", amount=Decimal(0)))
    _violates(db, KhataEntry(**base, type="credit", amount=Decimal(-10)))
    _violates(db, KhataEntry(**base, type="gift", amount=Decimal(10)))
    _violates(db, KhataEntry(**base, type="payment", amount=Decimal(10)))  # payment needs a Payment
    _violates(db, Payment(merchant_id=m.id, amount=Decimal(0), method="cash", status="succeeded", provider="cash"))
