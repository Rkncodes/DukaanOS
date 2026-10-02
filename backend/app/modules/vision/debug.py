"""Diagnosis dump for the real vision pipeline: every stage's output for one frame.

Off unless VISION_DEBUG_DIR is set (or app.scripts.vision_debug is run on an image file).
Per frame it writes a folder with:

  frame.jpg        the image as received
  boxes.jpg        the frame with the detector's kept boxes (green), the crop actually cut out
                   for each (yellow) and every text line read (blue = assigned to a box, red = not)
  crop_<n>.jpg     exactly the pixels given to the identifier for detection n
  trace.json       numbers for every stage (see `trace`)

It only observes: nothing here changes what is recognized.
"""

import json
import re
from datetime import datetime
from pathlib import Path

from PIL import ImageDraw

from app.integrations.types import BoundingBox, Evidence
from app.integrations.vision_real import Observation, crop, crop_rect, lines_inside
from app.modules.vision import matching
from app.modules.vision.matching import Entry, MatchingConfig

RAW_BOXES = 15  # strongest raw detector boxes listed, kept or not


def _pixels(box: BoundingBox, size: tuple[int, int]) -> dict:
    w, h = size
    return {
        "left": round(box.x * w),
        "top": round(box.y * h),
        "right": round((box.x + box.width) * w),
        "bottom": round((box.y + box.height) * h),
    }


def _box(box: BoundingBox, size: tuple[int, int]) -> dict:
    return {
        "normalized": {"x": round(box.x, 4), "y": round(box.y, 4), "width": round(box.width, 4), "height": round(box.height, 4)},
        "pixels": _pixels(box, size),
        "share_of_frame": round(max(0.0, box.width) * max(0.0, box.height), 3),
    }


def trace(seen: Observation, evidence: list[Evidence], entries: list[Entry], config: MatchingConfig) -> dict:
    """`evidence[n]` is what the provider reported for `seen.regions[n]`."""
    size = seen.frame.size
    names = {e.key: e.name for e in entries}
    weights = dict(zip([e.key for e in entries], matching.token_weights([e.name for e in entries]), strict=True))
    assigned: dict[int, list[int]] = {}  # text line index -> detections it was given to
    detections = []
    for n, (region, found, ev) in enumerate(zip(seen.regions, seen.found, evidence, strict=True)):
        mine = lines_inside(region.box, list(seen.lines))
        for line in mine:
            assigned.setdefault(seen.lines.index(line), []).append(n)
        left, top, right, bottom = crop_rect(size, region.box)
        scored, read = matching.score_entries(ev, entries, config)
        decision = matching.decide(ev, entries, config)
        detections.append(
            {
                "detection": n,
                "locate_score": round(region.score, 4),
                "box": _box(region.box, size),
                "crop": {
                    "file": f"crop_{n}.jpg",
                    "pixels": {"left": left, "top": top, "right": right, "bottom": bottom},
                    "width": right - left,
                    "height": bottom - top,
                    "note": "the box plus a 5% margin; the identifier model resizes this to its own input size",
                },
                "ocr_lines_assigned": [{"text": t.text, "score": round(t.score, 3)} for t in mine],
                "ocr_text_used": ev.text,
                "ocr_words_usable": sorted(read.words),
                "ocr_is_readable": len(read) >= config.min_text_tokens,
                "clip": {
                    "none_of_these_products": round(found.other, 4),
                    "scores": [{"name": label, "score": round(score, 4)} for label, score in found.visual],
                },
                "fusion": [
                    {
                        "name": names[s.key],
                        "score": s.score,
                        "visual": round(s.visual, 4),
                        "text": s.text,
                        "reference": s.reference,
                        "name_words_read": sorted(read.read_words(names[s.key])),
                        "name_words_missing": sorted(set(weights[s.key]) - read.read_words(names[s.key])),
                        "has_reference_photos": bool(next(e for e in entries if e.key == s.key).references),
                    }
                    for s in scored
                ],
                "decision": {
                    "state": decision.state.value,
                    "products": [names[s.key] for s in decision.ranked],
                    "thresholds": {"match_score": config.match_score, "min_score": config.min_score, "margin": config.margin},
                },
            }
        )
    raw = sorted((r for r in seen.raw if r.score == r.score), key=lambda r: -r.score)[:RAW_BOXES]
    kept = {(r.score) for r in seen.regions}
    return {
        "image": {"width": size[0], "height": size[1]},
        "detector": {
            "raw_boxes_total": len(seen.raw),
            "strongest_raw_boxes": [
                {"score": round(r.score, 4), "kept": r.score in kept, **_box(r.box, size)} for r in raw
            ],
            "kept_after_filter_and_nms": len(seen.regions),
        },
        "ocr_full_frame": [
            {
                "text": line.text,
                "score": round(line.score, 3),
                "box": _box(line.box, size),
                "assigned_to_detections": assigned.get(i, []),
            }
            for i, line in enumerate(seen.lines)
        ],
        "detections": detections,
    }


def save(
    out_dir: Path, seen: Observation, evidence: list[Evidence], entries: list[Entry], config: MatchingConfig, *, tag: str = ""
) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
    folder = Path(out_dir) / "-".join(p for p in (stamp, re.sub(r"[^A-Za-z0-9_.-]+", "_", tag)) if p)
    folder.mkdir(parents=True, exist_ok=True)
    data = trace(seen, evidence, entries, config)
    seen.frame.save(folder / "frame.jpg", quality=92)
    for n, region in enumerate(seen.regions):
        crop(seen.frame, region.box).save(folder / f"crop_{n}.jpg", quality=95)

    drawn = seen.frame.copy()
    draw = ImageDraw.Draw(drawn)
    w, h = drawn.size
    for i, line in enumerate(data["ocr_full_frame"]):
        p = line["box"]["pixels"]
        colour = (40, 90, 255) if line["assigned_to_detections"] else (255, 40, 40)
        draw.rectangle((p["left"], p["top"], p["right"], p["bottom"]), outline=colour, width=max(1, w // 480))
    for n, region in enumerate(seen.regions):
        p = _pixels(region.box, (w, h))
        draw.rectangle(crop_rect((w, h), region.box), outline=(255, 220, 0), width=max(1, w // 480))
        draw.rectangle((p["left"], p["top"], p["right"], p["bottom"]), outline=(0, 220, 60), width=max(2, w // 240))
        draw.text((p["left"] + 4, p["top"] + 4), f"{n}: {region.score:.2f}", fill=(0, 220, 60))
    drawn.save(folder / "boxes.jpg", quality=92)

    (folder / "trace.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return folder
