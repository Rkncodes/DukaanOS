import uuid

import pytest
from pydantic import ValidationError

from app.core.errors import NotFound
from app.core.tenancy import TenantContext
from app.modules.assistant.tools import TOOLS, execute_tool, tool_specs
from tests.conftest import create_cart, create_customer, create_product


def _ctx(client) -> TenantContext:
    me = client.get("/api/v1/auth/me").json()
    return TenantContext(merchant_id=uuid.UUID(me["merchant"]["id"]), user_id=uuid.UUID(me["user"]["id"]))


def test_tool_specs_expose_json_schemas():
    specs = {s.name: s for s in tool_specs()}
    assert set(specs) == set(TOOLS)
    assert "customer_id" in specs["record_khata_payment"].input_schema["properties"]
    assert TOOLS["add_to_cart"].mutates and not TOOLS["search_products"].mutates


def test_tools_call_the_same_services(client_a, db):
    ctx = _ctx(client_a)
    product = create_product(client_a, name="Maggi", price="14.00")
    customer = create_customer(client_a)
    cart = create_cart(client_a)

    result = execute_tool(db, ctx, "add_to_cart", {"cart_id": cart["id"], "product_id": product["id"], "quantity": "2"})
    assert result["items"][0]["source"] == "assistant"
    assert result["subtotal"] == "28.00"

    entry = execute_tool(db, ctx, "record_khata_payment", {"customer_id": customer["id"], "amount": "50"})
    assert entry["type"] == "payment" and entry["source"] == "assistant"
    assert execute_tool(db, ctx, "get_customer_balance", {"customer_id": customer["id"]})["balance"] == "-50.00"


def test_invalid_tool_calls_are_rejected(client_a, db):
    ctx = _ctx(client_a)
    with pytest.raises(NotFound):
        execute_tool(db, ctx, "drop_database", {})
    with pytest.raises(ValidationError):
        execute_tool(db, ctx, "record_khata_payment", {"customer_id": str(uuid.uuid4()), "amount": "-5"})
