# DukaanOS

One operating system for small local merchants. Four modules, **one shared set of merchant data**:

| Module | What it does | Status |
|---|---|---|
| **Counter** | Billing: manual, barcode, vision, voice, handwritten parchi | Foundation (cart/checkout API) |
| **Shop** | QR storefront, online orders | Placeholder |
| **Khata** | Customer udhaar ledger | Foundation (ledger API) |
| **Salaahkaar** | AI assistant over real shop data | Tool-registry interface only |

## Stack

- **Backend**: FastAPI · SQLAlchemy 2 (sync) · Alembic · Pydantic v2 · PostgreSQL · `uv`
- **Frontend**: React 19 · Vite · TypeScript · Tailwind v4 · React Router · TanStack Query · `openapi-fetch`
- **Auth**: HTTP-only session cookie holding a signed JWT; passwords hashed with Argon2

## Getting started

Prerequisites: Python 3.12+, [uv](https://docs.astral.sh/uv/), Node 22+, PostgreSQL running locally.

```bash
# 1. One-time: create the app role + dev/test databases (as a Postgres superuser)
psql -U postgres -h localhost -f backend/scripts/setup_local_db.sql

# 2. Backend  →  http://localhost:8000/api/v1/docs
cd backend
cp .env.example .env
uv sync
uv run alembic upgrade head
uv run python -m app.seed            # demo store; add --reset to recreate
uv run fastapi dev app/main.py       # or: uv run uvicorn app.main:app --reload

# 3. Frontend  →  http://localhost:5173
cd frontend
npm install
npm run dev
```

Demo login: **ramesh@dukaanos.dev / demo1234** (Ramesh General Store: 15 products, 6 customers, 2 weeks of bills and khata).

In development, Vite proxies `/api` to `localhost:8000`, so the session cookie is same-origin and CORS never comes up.

## Common tasks

| Task | Command |
|---|---|
| Backend tests (real Postgres, `dukaanos_test`) | `cd backend && uv run pytest` |
| Frontend typecheck / tests / build | `cd frontend && npm run typecheck && npm test && npm run build` |
| New migration after changing models | `cd backend && uv run alembic revision --autogenerate -m "..."` |
| Regenerate frontend API types after changing schemas | `cd frontend && npm run gen:api` |

`npm run gen:api` exports FastAPI's OpenAPI schema (no running server needed) to `frontend/openapi.json` and generates `frontend/src/lib/api/schema.d.ts`. Pydantic schemas are the single source of truth for domain types.

## Architecture

```
backend/app/
  core/           config, db (Base, mixins, session), tenancy, errors, security, enums, types
  modules/<name>/ models.py · schemas.py · service.py · router.py
     auth  merchants  catalog  inventory  customers  billing  orders  payments  khata  assistant
  integrations/   interfaces only: vision, ocr, speech (STT/TTS), llm
  seed.py         demo data, built through the real services
frontend/src/
  app/            router, providers, AppShell (sidebar + top bar), shared UI
  features/       auth, dashboard, counter, shop, khata, salaahkaar
  lib/api/        typed client, generated schema, shared query hooks
```

**Rules that keep it one product:**

1. **Layers.** Routers are thin: they parse the request, call a service, then `db.commit()`. Services contain the business logic and only `flush()`, so they compose (checkout → inventory + payments + khata) inside one transaction. Nothing writes to another module's tables except through that module's service.
2. **Merchant isolation.** Every merchant-owned table has `merchant_id`. Every service takes a `TenantContext`, built from the logged-in user and never from client input. Queries go through `tenancy.scoped()` / `get_owned()`. Records that belong to another merchant return **404**, and cross-references (product→category, cart→customer, cart item→product) are checked the same way. See `tests/test_isolation.py`.
3. **Billing convergence.** Every input produces the same thing:
   `Manual / Barcode / Vision / Voice / Parchi / Assistant → RecognizedItem → billing.resolve_item → billing.add_item → Cart → orders.checkout → inventory + payments | khata`.
   `CartItem`, `OrderItem` and `KhataEntry` record the `source` of each line.
4. **LLM boundary.** An `LLMProvider` only *proposes* tool calls. `assistant.tools.execute_tool` validates them with Pydantic and calls the existing services under the merchant's `TenantContext`. The LLM never touches the database.
5. **Replaceable integrations.** Payment gateways implement `payments.providers.PaymentProvider`. Vision, OCR, speech and LLM providers implement the protocols in `app/integrations/`. Core logic never imports a vendor SDK.

**Data model.** The tables are merchants, users, categories, products, customers, carts, cart_items, orders, order_items, payments and khata_entries.
- Primary keys are UUIDs.
- Money is `NUMERIC(12,2)` and quantities are `NUMERIC(12,3)`; the API serializes both as strings.
- A khata balance is always computed (credits − payments), never stored.
- A khata/udhaar sale creates a khata credit and **no** payment row. `payments` only records money actually received.
- Stock changes only through `inventory.service`.
- CHECK, UNIQUE and FK constraints in Postgres back up the service-level rules.

**Errors.** Every error returns `{"error": {"code", "message", "details"}}`. On the frontend, the client throws a typed `ApiError`.

## Configuration

`backend/.env` (see `.env.example`):
- `DATABASE_URL`, `TEST_DATABASE_URL`
- `JWT_SECRET` (required when `ENV=prod`), `JWT_EXPIRE_MINUTES`
- `COOKIE_SECURE` (defaults to on when `ENV=prod`)
- `CORS_ORIGINS`

`frontend/.env`:
- `VITE_API_BASE_URL`: leave empty in dev.
