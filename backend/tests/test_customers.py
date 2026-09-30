from tests.conftest import create_customer


def test_customer_crud(client_a):
    customer = create_customer(client_a, name="Priya", phone="9810010003")
    cid = customer["id"]
    assert client_a.get(f"/api/v1/customers/{cid}").json()["name"] == "Priya"

    updated = client_a.patch(f"/api/v1/customers/{cid}", json={"name": "Priya Singh"}).json()
    assert updated["name"] == "Priya Singh"
    assert updated["phone"] == "9810010003"

    assert [c["id"] for c in client_a.get("/api/v1/customers", params={"q": "singh"}).json()] == [cid]
    assert [c["id"] for c in client_a.get("/api/v1/customers", params={"q": "0003"}).json()] == [cid]

    assert client_a.delete(f"/api/v1/customers/{cid}").status_code == 204
    assert client_a.get(f"/api/v1/customers/{cid}").status_code == 404


def test_duplicate_phone_within_merchant_conflicts(client_a, client_b):
    create_customer(client_a, phone="9000000001")
    assert client_a.post("/api/v1/customers", json={"name": "X", "phone": "9000000001"}).status_code == 409
    # Same phone at a different merchant is fine.
    create_customer(client_b, phone="9000000001")


def test_customer_with_khata_history_cannot_be_deleted(client_a):
    customer = create_customer(client_a)
    client_a.post(f"/api/v1/customers/{customer['id']}/khata/credits", json={"amount": "50"})
    res = client_a.delete(f"/api/v1/customers/{customer['id']}")
    assert res.status_code == 409
    assert client_a.get(f"/api/v1/customers/{customer['id']}").status_code == 200
