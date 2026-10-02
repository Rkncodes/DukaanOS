"""Real, local computer-vision provider (no cloud, no product list of its own).

For each camera frame it *observes*; it never decides which product something is:

  1. ProductLocator:  frame -> candidate product boxes            (OWL-ViT, generic prompts)
  2. TextReader:      frame -> printed text lines with positions  (RapidOCR), run in parallel
  3. ProductIdentifier, per box crop:
       - visual scores against the merchant's catalog names      (CLIP, "a photo of {name}"
         + generic "something else" prompts; relative, not a calibrated probability)
       - an appearance embedding of the crop                     (CLIP image features, compared
         with the merchant's reference images in app.modules.vision)
  4. Each box's OCR text = the text lines whose centre lies inside it.

The result is one RecognizedItem per physical object with `evidence` attached. The vision
service fuses that evidence with the authenticated merchant's catalog and decides
matched / ambiguous / unsure / unknown. torch, transformers and rapidocr are an optional
extra (`uv sync --extra vision`), imported on first use.
"""

import json
import math
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from decimal import Decimal
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any, Protocol

from PIL import Image

from app.core.enums import InputSource
from app.integrations.types import BoundingBox, Evidence, IntegrationNotConfigured, RecognizedItem, overlap

DEFAULT_PROMPTS = Path(__file__).with_name("vision_prompts.json")
INSTALL_HINT = "Real vision needs the optional dependencies: cd backend && uv sync --extra vision"
UNKNOWN = "Unknown product"


# ---- configuration ----


@dataclass(frozen=True)
class Prompts:
    """Generic prompts only; the classes come from the merchant's catalog at request time."""

    locate: tuple[str, ...]  # stage 1: "a product is here"
    templates: tuple[str, ...]  # per catalog name, e.g. "a photo of {name}"
    other: tuple[str, ...]  # competitors: "not one of this merchant's products"

    def for_label(self, label: str) -> list[str]:
        return [t.format(name=label) for t in self.templates]


def load_prompts(path: Path = DEFAULT_PROMPTS) -> Prompts:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        prompts = Prompts(tuple(raw["locate_prompts"]), tuple(raw["class_templates"]), tuple(raw["other_prompts"]))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise IntegrationNotConfigured(f"Invalid vision prompts file {path}: {exc}") from exc
    if not prompts.locate or not prompts.templates or not prompts.other:
        raise IntegrationNotConfigured(f"{path} needs locate_prompts, class_templates and other_prompts")
    if any("{name}" not in t for t in prompts.templates):
        raise IntegrationNotConfigured(f"Every class template in {path} must contain {{name}}")
    return prompts


@dataclass(frozen=True)
class RealVisionConfig:
    locator_model: str = "google/owlvit-base-patch32"
    identifier_model: str = "openai/clip-vit-base-patch32"
    device: str = "cpu"
    prompts_path: Path = DEFAULT_PROMPTS
    ocr: bool = True  # read printed text on packets (strong SKU evidence)
    ocr_side: int = 640  # OCR text-detection resolution: lower is faster, higher reads smaller text
    min_locate_score: float = 0.15  # stage-1 score below which a box is not a product
    max_items: int = 8
    overlap_iou: float = 0.3  # boxes overlapping more than this are one product
    contained: float = 0.8  # a box this much inside a stronger box is part of the same packet


# ---- stage protocols ----


@dataclass(frozen=True)
class Region:
    box: BoundingBox  # normalized, top-left origin (the DukaanOS/overlay format)
    score: float  # stage-1 "this is a product" score


@dataclass(frozen=True)
class TextLine:
    text: str
    box: BoundingBox  # normalized to the frame
    score: float


@dataclass(frozen=True)
class Identification:
    """Visual observations for one crop (no decision)."""

    visual: tuple[tuple[str, float], ...]  # (label, relative score), best first
    other: float  # relative score of "none of the given labels"
    embedding: tuple[float, ...] = ()


class ProductLocator(Protocol):
    def locate(self, image: Image.Image) -> list[Region]: ...


class TextReader(Protocol):
    def read(self, image: Image.Image) -> list[TextLine]: ...


class ProductIdentifier(Protocol):
    embedding_model: str | None

    def identify(self, image: Image.Image, regions: list[Region], labels: tuple[str, ...]) -> list[Identification]: ...

    def embed(self, image: Image.Image) -> tuple[float, ...]: ...


# ---- geometry ----


def clip_box(box: BoundingBox) -> BoundingBox | None:
    if not all(math.isfinite(v) for v in (box.x, box.y, box.width, box.height)):
        return None
    x0, y0 = max(0.0, box.x), max(0.0, box.y)
    x1, y1 = min(1.0, box.x + box.width), min(1.0, box.y + box.height)
    if x1 - x0 <= 0.01 or y1 - y0 <= 0.01:
        return None
    return BoundingBox(round(x0, 4), round(y0, 4), round(x1 - x0, 4), round(y1 - y0, 4))


def lines_inside(box: BoundingBox, lines: list[TextLine], *, min_score: float = 0.5) -> list[TextLine]:
    """Text lines whose centre lies inside the box (slightly padded), top to bottom."""
    pad_x, pad_y = box.width * 0.05, box.height * 0.05
    inside = []
    for line in lines:
        cx, cy = line.box.x + line.box.width / 2, line.box.y + line.box.height / 2
        if (
            line.score >= min_score
            and box.x - pad_x <= cx <= box.x + box.width + pad_x
            and box.y - pad_y <= cy <= box.y + box.height + pad_y
        ):
            inside.append(line)
    inside.sort(key=lambda t: (round(t.box.y, 2), t.box.x))
    return [t for t in inside if t.text.strip()]


def text_inside(box: BoundingBox, lines: list[TextLine], *, min_score: float = 0.5) -> str:
    return " ".join(t.text.strip() for t in lines_inside(box, lines, min_score=min_score))


def crop_rect(size: tuple[int, int], box: BoundingBox, pad: float = 0.05) -> tuple[int, int, int, int]:
    """Pixel rectangle (left, top, right, bottom) cut out for a box: the box plus a small margin."""
    w, h = size
    px, py = box.width * pad, box.height * pad
    left, top = max(0.0, box.x - px) * w, max(0.0, box.y - py) * h
    right, bottom = min(1.0, box.x + box.width + px) * w, min(1.0, box.y + box.height + py) * h
    return int(left), int(top), max(int(left) + 1, int(right)), max(int(top) + 1, int(bottom))


def crop(image: Image.Image, box: BoundingBox, pad: float = 0.05) -> Image.Image:
    return image.crop(crop_rect(image.size, box, pad))


@dataclass(frozen=True)
class Observation:
    """Everything the pipeline saw in one frame, stage by stage (kept for diagnosis)."""

    frame: Image.Image
    raw: tuple[Region, ...]  # the detector's output before filtering and NMS
    regions: tuple[Region, ...]  # one per physical object
    lines: tuple[TextLine, ...]  # all text read in the frame
    found: tuple[Identification, ...]  # per region


# ---- the provider ----


class RealLiveRecognizer:
    """Real recognition from the camera image; serves live frames and single photos.

    A bare instance compares against no catalog names; the vision service calls
    `for_catalog(names)` per request to get a view over one merchant's catalog.
    """

    is_mock = False

    def __init__(
        self,
        locator: ProductLocator,
        identifier: ProductIdentifier,
        reader: TextReader | None = None,
        *,
        name: str = "local-cv",
        labels: tuple[str, ...] = (),
        min_locate_score: float = 0.15,
        max_items: int = 8,
        overlap_iou: float = 0.3,
        contained: float = 0.8,
    ):
        self.name = name
        self.locator = locator
        self.identifier = identifier
        self.reader = reader
        self.labels = labels
        self.min_locate_score = min_locate_score
        self.max_items = max_items
        self.overlap_iou = overlap_iou
        self.contained = contained

    @property
    def embedding_model(self) -> str | None:
        return self.identifier.embedding_model

    def for_catalog(self, labels: tuple[str, ...]) -> "RealLiveRecognizer":
        """Same models, visual classes = these labels (one merchant's active product names)."""
        return RealLiveRecognizer(
            self.locator,
            self.identifier,
            self.reader,
            name=self.name,
            labels=tuple(dict.fromkeys(label.strip() for label in labels if label.strip())),
            min_locate_score=self.min_locate_score,
            max_items=self.max_items,
            overlap_iou=self.overlap_iou,
            contained=self.contained,
        )

    def _duplicate(self, box: BoundingBox, kept: list[Region]) -> bool:
        for k in kept:
            iou, inside = overlap(box, k.box)
            if iou > self.overlap_iou or inside > self.contained:
                return True
        return False

    def _regions(self, raw: list[Region]) -> list[Region]:
        """Class-agnostic NMS: one region per physical object, strongest first."""
        kept: list[Region] = []
        likely = [r for r in raw if math.isfinite(r.score) and r.score >= self.min_locate_score]
        for region in sorted(likely, key=lambda r: -r.score):
            if len(kept) >= self.max_items:
                break
            box = clip_box(region.box)
            if box is None or self._duplicate(box, kept):
                continue
            kept.append(Region(box, region.score))
        return kept

    def _locate_and_read(self, frame: Image.Image) -> tuple[list[Region], list[TextLine]]:
        """Locate products and read text concurrently (both release the GIL during inference)."""
        if self.reader is None:
            return self.locator.locate(frame), []
        with ThreadPoolExecutor(max_workers=2) as pool:
            located = pool.submit(self.locator.locate, frame)
            read = pool.submit(self.reader.read, frame)
            return located.result(), read.result()

    def observe(self, image: bytes) -> Observation:
        with Image.open(BytesIO(image)) as img:
            frame = img.convert("RGB")
        raw, lines = self._locate_and_read(frame)
        regions = self._regions(raw)
        found = self.identifier.identify(frame, regions, self.labels) if regions else []
        if len(found) != len(regions):
            raise ValueError("identifier returned a different number of results than regions")
        return Observation(frame, tuple(raw), tuple(regions), tuple(lines), tuple(found))

    def recognize_frame(self, image: bytes, *, sequence: int) -> list[RecognizedItem]:
        return self.recognize(image)

    def recognize(self, image: bytes) -> list[RecognizedItem]:
        return self.items(self.observe(image))

    def items(self, seen_in_frame: Observation) -> list[RecognizedItem]:
        lines = list(seen_in_frame.lines)
        items = []
        for region, seen in zip(seen_in_frame.regions, seen_in_frame.found, strict=True):
            visual = tuple((label, float(p)) for label, p in seen.visual if label in self.labels and math.isfinite(p))
            items.append(
                RecognizedItem(
                    source=InputSource.VISION,
                    quantity=Decimal(1),  # one box = one physical packet
                    label=UNKNOWN,  # the vision service names it after catalog matching
                    bbox=region.box,
                    evidence=Evidence(
                        visual=visual,
                        visual_other=float(seen.other) if math.isfinite(seen.other) else 1.0,
                        text=text_inside(region.box, lines),
                        embedding=seen.embedding,
                        embedding_model=self.identifier.embedding_model,
                        locate_score=region.score,
                    ),
                )
            )
        return items

    def embed_reference(self, image: bytes) -> tuple[str, tuple[float, ...]]:
        """Appearance embedding of the main product in a reference photo (for catalog references)."""
        with Image.open(BytesIO(image)) as img:
            photo = img.convert("RGB")
        regions = self._regions(self.locator.locate(photo))
        subject = crop(photo, regions[0].box) if regions else photo
        if self.identifier.embedding_model is None:
            raise IntegrationNotConfigured("This vision provider cannot compare reference images")
        return self.identifier.embedding_model, self.identifier.embed(subject)


# ---- default models (loaded lazily) ----


class _Models:
    """Loads torch models once, on first use, and serializes their inference."""

    def __init__(self, config: RealVisionConfig):
        self.config = config
        self._lock = threading.Lock()
        self._loaded: dict[str, Any] | None = None

    def get(self) -> dict[str, Any]:
        with self._lock:
            if self._loaded is None:
                self._loaded = self._load()
            return self._loaded

    def _load(self) -> dict[str, Any]:
        try:
            import torch
            from transformers import CLIPModel, CLIPProcessor, OwlViTForObjectDetection, OwlViTProcessor
        except ImportError as exc:
            raise IntegrationNotConfigured(INSTALL_HINT) from exc
        device = self.config.device
        if device == "cuda" and not torch.cuda.is_available():
            raise IntegrationNotConfigured("VISION_REAL_DEVICE=cuda but no CUDA device/torch build is available")
        try:
            return {
                "torch": torch,
                "owl_processor": OwlViTProcessor.from_pretrained(self.config.locator_model),
                "owl": OwlViTForObjectDetection.from_pretrained(self.config.locator_model).to(device).eval(),
                "clip_processor": CLIPProcessor.from_pretrained(self.config.identifier_model),
                "clip": CLIPModel.from_pretrained(self.config.identifier_model).to(device).eval(),
            }
        except OSError as exc:  # missing weights / no network on first download
            raise IntegrationNotConfigured(f"Could not load vision models: {exc}") from exc

    def run(self, fn):
        models = self.get()
        with self._lock, models["torch"].inference_mode():
            return fn(models)


class OwlVitLocator:
    def __init__(self, models: _Models, prompts: tuple[str, ...]):
        self.models = models
        self.prompts = list(prompts)

    def locate(self, image: Image.Image) -> list[Region]:
        def infer(m):
            inputs = m["owl_processor"](text=[self.prompts], images=image, return_tensors="pt")
            out = m["owl"](**{k: v.to(self.models.config.device) for k, v in inputs.items()})
            scores = out.logits[0].sigmoid().max(-1).values.cpu().tolist()
            boxes = out.pred_boxes[0].cpu().tolist()
            return scores, boxes

        return regions_from_centre_boxes(*self.models.run(infer))


def regions_from_centre_boxes(scores: list[float], boxes: list[list[float]]) -> list[Region]:
    """OWL-ViT boxes are (centre x, centre y, width, height) as fractions of the model input.
    Its processor resizes the whole frame to that input (stretching it, no padding), so the
    fractions are already fractions of the original frame, whatever its aspect ratio."""
    return [
        Region(BoundingBox(cx - bw / 2, cy - bh / 2, bw, bh), float(score))
        for score, (cx, cy, bw, bh) in zip(scores, boxes, strict=True)
    ]


class RapidOcrReader:
    """Printed-text reader (RapidOCR: PaddleOCR models on ONNX Runtime, CPU)."""

    def __init__(self, side: int = 640):
        self.side = side
        self._lock = threading.Lock()
        self._engine: Any = None

    def _get(self):
        if self._engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR
            except ImportError as exc:
                raise IntegrationNotConfigured(INSTALL_HINT) from exc
            self._engine = RapidOCR(det_limit_side_len=self.side)
        return self._engine

    def read(self, image: Image.Image) -> list[TextLine]:
        import numpy as np

        with self._lock:
            engine = self._get()
            result, _ = engine(np.asarray(image)[:, :, ::-1], use_cls=False)  # BGR, packets are upright
        return parse_rapidocr(result, image.size)


def parse_rapidocr(result: Any, size: tuple[int, int]) -> list[TextLine]:
    """RapidOCR returns [[4 corner points], text, score] per line (or None). Malformed entries are skipped."""
    w, h = size
    lines = []
    for entry in result or []:
        try:
            points, text, score = entry
            xs = [float(p[0]) for p in points]
            ys = [float(p[1]) for p in points]
            score = float(score)
        except (TypeError, ValueError, IndexError):
            continue
        if not isinstance(text, str) or not text.strip() or not math.isfinite(score) or w <= 0 or h <= 0:
            continue
        box = clip_box(BoundingBox(min(xs) / w, min(ys) / h, (max(xs) - min(xs)) / w, (max(ys) - min(ys)) / h))
        if box is not None:
            lines.append(TextLine(text=text, box=box, score=score))
    return lines


def _embedding(output: Any) -> Any:
    """CLIP features as a tensor: transformers <5 returns one; 5.x returns an output whose
    pooler_output is the projected embedding."""
    return output if hasattr(output, "norm") else output.pooler_output


def text_classes(prompts: Prompts, labels: tuple[str, ...]) -> tuple[list[str], list[str | None]]:
    """The visual prompt list and, per prompt, which label owns it (None = 'something else')."""
    texts: list[str] = []
    owners: list[str | None] = []
    for label in labels:
        for text in prompts.for_label(label):
            texts.append(text)
            owners.append(label)
    for text in prompts.other:
        texts.append(text)
        owners.append(None)
    return texts, owners


def relative_scores(owners: list[str | None], logits: list[float]) -> dict[str | None, float]:
    """Best prompt per owner, then a softmax across owners: how clearly each beats the others."""
    best: dict[str | None, float] = {}
    for owner, logit in zip(owners, logits, strict=True):
        best[owner] = max(best.get(owner, float("-inf")), logit)
    top = max(best.values())
    exp = {o: math.exp(v - top) for o, v in best.items()}
    total = sum(exp.values())
    return {o: v / total for o, v in exp.items()}


class ClipIdentifier:
    CACHE_SIZE = 16  # text embeddings for the most recent catalogs (one per merchant, roughly)

    def __init__(self, models: _Models, prompts: Prompts):
        self.models = models
        self.prompts = prompts
        self.embedding_model = f"clip:{models.config.identifier_model}"
        self._text_cache: OrderedDict[tuple[str, ...], tuple[Any, list[str | None]]] = OrderedDict()

    def _text(self, m, labels: tuple[str, ...]):
        cached = self._text_cache.get(labels)
        if cached is not None:
            self._text_cache.move_to_end(labels)
            return cached
        texts, owners = text_classes(self.prompts, labels)
        t = m["clip_processor"](text=texts, return_tensors="pt", padding=True)
        emb = _embedding(m["clip"].get_text_features(**{k: v.to(self.models.config.device) for k, v in t.items()}))
        entry = (emb / emb.norm(dim=-1, keepdim=True), owners)
        self._text_cache[labels] = entry
        if len(self._text_cache) > self.CACHE_SIZE:
            self._text_cache.popitem(last=False)
        return entry

    def _image_features(self, m, crops: list[Image.Image]):
        px = m["clip_processor"](images=crops, return_tensors="pt")["pixel_values"].to(self.models.config.device)
        img = _embedding(m["clip"].get_image_features(pixel_values=px))
        return img / img.norm(dim=-1, keepdim=True)

    def identify(self, image: Image.Image, regions: list[Region], labels: tuple[str, ...]) -> list[Identification]:
        crops = [crop(image, r.box) for r in regions]

        def infer(m):
            text, owners = self._text(m, labels)
            img = self._image_features(m, crops)
            logits = (m["clip"].logit_scale.exp() * img @ text.T).cpu().tolist()
            return logits, owners, img.cpu().tolist()

        rows, owners, embeddings = self.models.run(infer)
        results = []
        for row, emb in zip(rows, embeddings, strict=True):
            probs = relative_scores(owners, row)
            visual = tuple(sorted(((o, p) for o, p in probs.items() if o is not None), key=lambda op: -op[1]))
            results.append(Identification(visual=visual, other=probs.get(None, 0.0), embedding=tuple(emb)))
        return results

    def embed(self, image: Image.Image) -> tuple[float, ...]:
        return tuple(self.models.run(lambda m: self._image_features(m, [image]))[0].cpu().tolist())


@lru_cache
def real_recognizer(config: RealVisionConfig) -> RealLiveRecognizer:
    """One shared instance per configuration (models load lazily on the first frame)."""
    prompts = load_prompts(config.prompts_path)
    models = _Models(config)
    return RealLiveRecognizer(
        OwlVitLocator(models, prompts.locate),
        ClipIdentifier(models, prompts),
        RapidOcrReader(config.ocr_side) if config.ocr else None,
        name="local-cv (owl-vit + clip + ocr)" if config.ocr else "local-cv (owl-vit + clip)",
        min_locate_score=config.min_locate_score,
        max_items=config.max_items,
        overlap_iou=config.overlap_iou,
        contained=config.contained,
    )
