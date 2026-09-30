from tests.conftest import create_product


def test_product_crud(client_a):
    category = client_a.post("/api/v1/categories", json={"name": "Snacks"}).json()
    product = create_product(
        client_a, name="Kurkure", price="20.00", cost_price="16.50", barcode="8900000000011", category_id=category["id"]
    )
    assert product["price"] == "20.00"
    assert product["stock_quantity"] == "10.000"
    assert product["is_active"] is True

    pid = product["id"]
    assert client_a.get(f"/api/v1/products/{pid}").json()["name"] == "Kurkure"

    updated = client_a.patch(f"/api/v1/products/{pid}", json={"price": "22.00"}).json()
    assert updated["price"] == "22.00"
    assert updated["name"] == "Kurkure"

    assert [p["id"] for p in client_a.get("/api/v1/products", params={"q": "kurk"}).json()] == [pid]
    assert [p["id"] for p in client_a.get("/api/v1/products", params={"barcode": "8900000000011"}).json()] == [pid]
    assert [p["id"] for p in client_a.get("/api/v1/products", params={"category_id": category["id"]}).json()] == [pid]

    assert client_a.delete(f"/api/v1/products/{pid}").status_code == 204
    assert client_a.get("/api/v1/products").json() == []
    inactive = client_a.get("/api/v1/products", params={"include_inactive": True}).json()
    assert inactive[0]["is_active"] is False


def test_stock_cannot_be_patched_directly(client_a):
    product = create_product(client_a)
    res = client_a.patch(f"/api/v1/products/{product['id']}", json={"stock_quantity": "999"})
    assert res.status_code == 422


def test_inventory_adjustments(client_a):
    product = create_product(client_a, stock_quantity="5")
    res = client_a.post("/api/v1/inventory/adjustments", json={"product_id": product["id"], "delta": "7"})
    assert res.json()["stock_quantity"] == "12.000"
    res = client_a.post("/api/v1/inventory/adjustments", json={"product_id": product["id"], "delta": "-20"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "insufficient_stock"


def test_duplicate_barcode_and_sku_conflict(client_a):
    create_product(client_a, barcode="123", sku="SKU1")
    res = client_a.post("/api/v1/products", json={"name": "Other", "price": "1", "barcode": "123"})
    assert res.status_code == 409
    res = client_a.post("/api/v1/products", json={"name": "Other", "price": "1", "sku": "SKU1"})
    assert res.status_code == 409


def test_negative_price_rejected(client_a):
    res = client_a.post("/api/v1/products", json={"name": "Bad", "price": "-1"})
    assert res.status_code == 422


def test_category_crud(client_a):
    cat = client_a.post("/api/v1/categories", json={"name": "Dairy"}).json()
    assert client_a.patch(f"/api/v1/categories/{cat['id']}", json={"name": "Milk"}).json()["name"] == "Milk"
    assert client_a.post("/api/v1/categories", json={"name": "Milk"}).status_code == 409
    product = create_product(client_a, category_id=cat["id"])
    assert client_a.delete(f"/api/v1/categories/{cat['id']}").status_code == 204
    assert client_a.get(f"/api/v1/products/{product['id']}").json()["category_id"] is None
