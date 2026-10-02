"""Run one image through the real vision pipeline and dump every stage (diagnosis only).

    uv run --extra vision python -m app.scripts.vision_debug photo.jpg [more.jpg ...]
        [--email ramesh@dukaanos.dev] [--out vision-debug]

Uses that merchant's active catalog and reference photos from the configured database, the
configured models and thresholds - the same code path as POST /vision/frames. Writes one folder
per image (see app.modules.vision.debug) and prints a summary. Nothing is added to any cart.
"""

import argparse
from pathlib import Path

from sqlalchemy import select

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.tenancy import TenantContext
from app.integrations.vision import build_recognizer
from app.modules.catalog import service as catalog
from app.modules.merchants.models import User
from app.modules.vision import debug, service
from app.seed import DEMO_EMAIL


def summarize(data: dict) -> str:
    image = data["image"]
    out = [f"image {image['width']}x{image['height']}, {data['detector']['kept_after_filter_and_nms']} detection(s)"]
    out.append("full-frame OCR: " + (" | ".join(f"{t['text']} ({t['score']})" for t in data["ocr_full_frame"]) or "(nothing read)"))
    for d in data["detections"]:
        px, crop = d["box"]["pixels"], d["crop"]
        out.append(
            f"detection {d['detection']}: locate {d['locate_score']}, box x {px['left']}-{px['right']} y {px['top']}-{px['bottom']} "
            f"({d['box']['share_of_frame']:.0%} of frame), crop {crop['width']}x{crop['height']} -> {crop['file']}"
        )
        out.append(f"  text used: {d['ocr_text_used']!r}  readable={d['ocr_is_readable']}")
        out.append(f"  CLIP 'none of these' = {d['clip']['none_of_these_products']}")
        for f in d["fusion"][:6]:
            out.append(
                f"  {f['name'][:34]:34} fused {f['score']:.3f}  look {f['visual']:.3f}  text {f['text']:.3f} "
                f"{f['name_words_read']}  reference {f['reference']:.3f}"
            )
        out.append(f"  decision: {d['decision']['state']} {d['decision']['products']}")
    return "\n".join(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--email", default=DEMO_EMAIL, help="a user of the merchant whose catalog to match against")
    parser.add_argument("--out", type=Path, default=Path("vision-debug"))
    args = parser.parse_args()

    with SessionLocal() as db:
        user = db.scalars(select(User).where(User.email == args.email.lower())).one_or_none()
        if user is None:
            raise SystemExit(f"No user {args.email}; run `uv run python -m app.seed` or pass --email")
        ctx = TenantContext(merchant_id=user.merchant_id, user_id=user.id, role=user.role)
        products = catalog.list_products(db, ctx)
        provider = build_recognizer("real", settings.real_vision).for_catalog(tuple(p.name for p in products))
        config = settings.vision_matching
        print(f"catalog: {len(products)} active products of {args.email}; provider {provider.name}")
        for path in args.images:
            seen = provider.observe(path.read_bytes())
            items = provider.items(seen)
            entries = service._entries(db, ctx, items, products)
            folder = debug.save(args.out, seen, [i.evidence for i in items], entries, config, tag=path.stem)
            print(f"\n== {path.name} -> {folder}")
            print(summarize(debug.trace(seen, [i.evidence for i in items], entries, config)))


if __name__ == "__main__":
    main()
