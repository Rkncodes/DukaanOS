import uuid
from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.config import settings
from app.core.db import DbSession
from app.integrations.paytm import HttpPaytmClient
from app.modules.auth.deps import Tenant
from app.modules.billing import service as billing
from app.modules.payments import paytm
from app.modules.payments.schemas import (
    PaytmCheckout,
    PaytmConfigRead,
    PaytmPaymentRead,
    PaytmStart,
    PaytmStartRead,
)

router = APIRouter(prefix="/payments/paytm", tags=["payments"])


def get_paytm() -> paytm.Paytm:
    config = settings.paytm
    if config is None:
        raise paytm.PaytmUnavailable("Paytm payments are not set up for this store (PAYTM_ENABLED=false)")
    return paytm.Paytm(config, HttpPaytmClient(config))


Gateway = Annotated[paytm.Paytm, Depends(get_paytm)]


@router.get("/config")
def get_config(ctx: Tenant) -> PaytmConfigRead:
    config = settings.paytm
    return PaytmConfigRead(enabled=config is not None, environment=config.environment if config else None)


@router.get("/current")
def get_current(cart_id: uuid.UUID, db: DbSession, ctx: Tenant) -> PaytmPaymentRead | None:
    """The Paytm payment in progress (or waiting for the merchant) for this bill, if any."""
    billing.get_cart(db, ctx, cart_id)
    return paytm.current_for_cart(db, ctx, cart_id)


@router.post("")
def start(data: PaytmStart, db: DbSession, ctx: Tenant, gateway: Gateway) -> PaytmStartRead:
    """Start (or continue) paying an open bill through Paytm. The amount is the bill's total,
    computed by the backend. The bill is not paid until /verify says so."""
    payment, token = paytm.start(db, ctx, gateway, data.cart_id, data.discount)
    db.commit()
    return PaytmStartRead(
        payment=PaytmPaymentRead.model_validate(payment),
        checkout=PaytmCheckout(
            host=gateway.config.host,
            mid=gateway.config.mid,
            order_id=payment.paytm_order_id,
            txn_token=token,
            amount=payment.amount,
        ),
    )


@router.post("/{payment_id}/verify")
def verify(payment_id: uuid.UUID, db: DbSession, ctx: Tenant, gateway: Gateway) -> PaytmPaymentRead:
    """Ask Paytm what happened and act on its answer. Takes no status from the caller.
    Safe to repeat: a paid bill is completed once."""
    payment = paytm.verify(db, ctx, gateway, payment_id)
    db.commit()
    return payment


@router.post("/{payment_id}/cancel")
def cancel(payment_id: uuid.UUID, db: DbSession, ctx: Tenant, gateway: Gateway) -> PaytmPaymentRead:
    """Give up a payment that Paytm has not received. If Paytm did receive it, the bill is completed instead."""
    payment = paytm.cancel(db, ctx, gateway, payment_id)
    db.commit()
    return payment
