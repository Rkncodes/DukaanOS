from decimal import Decimal

from app.core.tax import summarize
from tests.conftest import create_cart, create_product


def test_summarize_extracts_tax_from_a_tax_inclusive_total():
    # 118.00 at 18% GST is exactly 100.00 taxable + 18.00 tax (9.00 CGST + 9.00 SGST).
    summary = summarize([(Decimal("118.00"), Decimal("18"))])
    assert (summary.taxable_value, summary.cgst, summary.sgst, summary.total_tax) == (
        Decimal("100.00"), Decimal("9.00"), Decimal("9.00"), Decimal("18.00"),
    )  # fmt: skip


def test_summarize_rounds_to_the_cent_and_splits_the_odd_paisa_consistently():
    # 14.00 at 18%: 14 / 1.18 = 11.8644... -> 11.86 taxable, 2.14 tax, odd paisa goes to CGST.
    summary = summarize([(Decimal("14.00"), Decimal("18"))])
    assert (summary.taxable_value, summary.total_tax) == (Decimal("11.86"), Decimal("2.14"))
    assert (summary.cgst, summary.sgst) == (Decimal("1.07"), Decimal("1.07"))  # 2.14 / 2 is exact here


def test_summarize_treats_a_zero_rate_as_fully_taxable_with_no_tax():
    summary = summarize([(Decimal("50.00"), Decimal("0"))])
    assert (summary.taxable_value, summary.total_tax) == (Decimal("50.00"), Decimal("0.00"))


def test_summarize_sums_multiple_lines_at_different_rates():
    summary = summarize([(Decimal("118.00"), Decimal("18")), (Decimal("105.00"), Decimal("5"))])
    # Line 2: 105 / 1.05 = 100.00 taxable, 5.00 tax.
    assert summary.taxable_value == Decimal("200.00")
    assert summary.total_tax == Decimal("23.00")


def test_cart_and_order_report_the_same_tax_breakup(client_a):
    product = create_product(client_a, price="118.00", stock_quantity="10", tax_rate="18")
    cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"], "quantity": "1"})

    cart_tax = client_a.get(f"/api/v1/carts/{cart['id']}").json()["tax_summary"]
    assert (cart_tax["taxable_value"], cart_tax["total_tax"]) == ("100.00", "18.00")

    order = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).json()
    assert order["tax_summary"] == cart_tax
    assert order["items"][0]["tax_rate"] == "18.00"


def test_order_keeps_the_tax_rate_at_time_of_sale_even_if_the_product_changes_later(client_a):
    product = create_product(client_a, price="118.00", stock_quantity="10", tax_rate="18")
    cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"], "quantity": "1"})
    order = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).json()

    client_a.patch(f"/api/v1/products/{product['id']}", json={"tax_rate": "28"})
    assert client_a.get(f"/api/v1/orders/{order['id']}").json()["items"][0]["tax_rate"] == "18.00"


def test_product_tax_rate_defaults_to_zero_and_is_validated(client_a):
    product = create_product(client_a)
    assert product["tax_rate"] == "0.00"
    bad = client_a.post("/api/v1/products", json={"name": "X", "price": "10.00", "tax_rate": "101"})
    assert bad.status_code == 422


def test_merchant_gstin_can_be_set_validated_and_cleared(client_a):
    assert client_a.get("/api/v1/auth/me").json()["merchant"]["gstin"] is None

    bad = client_a.patch("/api/v1/auth/merchant", json={"gstin": "not-a-gstin"})
    assert bad.status_code == 422

    ok = client_a.patch("/api/v1/auth/merchant", json={"gstin": "07abcde1234f1z5"})
    assert ok.status_code == 200 and ok.json()["gstin"] == "07ABCDE1234F1Z5"  # normalized to uppercase
    assert client_a.get("/api/v1/auth/me").json()["merchant"]["gstin"] == "07ABCDE1234F1Z5"

    cleared = client_a.patch("/api/v1/auth/merchant", json={"gstin": None})
    assert cleared.status_code == 200 and cleared.json()["gstin"] is None
