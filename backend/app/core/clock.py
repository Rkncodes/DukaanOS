"""The store's own day.

Timestamps are stored in UTC, but "today's sales" means the merchant's today. The store's
offset from UTC is a setting (default +05:30, India, which has no daylight saving).
"""

from datetime import datetime, timedelta, timezone

from app.core.config import settings
from app.core.db import utcnow


def store_timezone() -> timezone:
    return timezone(timedelta(minutes=settings.store_utc_offset_minutes))


def store_now() -> datetime:
    return utcnow().astimezone(store_timezone())


def store_day_start(now: datetime | None = None) -> datetime:
    """Midnight at the start of the store's current day (timezone-aware)."""
    local = (now or utcnow()).astimezone(store_timezone())
    return local.replace(hour=0, minute=0, second=0, microsecond=0)
