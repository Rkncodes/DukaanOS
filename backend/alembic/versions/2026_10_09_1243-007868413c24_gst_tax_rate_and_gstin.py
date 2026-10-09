"""gst tax rate and gstin

Revision ID: 007868413c24
Revises: 4762f2a3cc0a
Create Date: 2026-10-09 12:43:14.525368

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '007868413c24'
down_revision: Union[str, Sequence[str], None] = '4762f2a3cc0a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('merchants', sa.Column('gstin', sa.String(length=15), nullable=True))
    # server_default so existing rows backfill to 0 (not taxed) instead of failing the NOT NULL.
    op.add_column('order_items', sa.Column('tax_rate', sa.Numeric(precision=12, scale=2), nullable=False, server_default='0'))
    op.add_column('products', sa.Column('tax_rate', sa.Numeric(precision=12, scale=2), nullable=False, server_default='0'))
    op.create_check_constraint('ck_products_tax_rate_valid', 'products', 'tax_rate >= 0 AND tax_rate <= 100')


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('ck_products_tax_rate_valid', 'products', type_='check')
    op.drop_column('products', 'tax_rate')
    op.drop_column('order_items', 'tax_rate')
    op.drop_column('merchants', 'gstin')
