"""FastAPI entry point: health, case API for the web app, and live catalog lookups."""
import json
import os
import random
import time
import uuid
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

APP_VERSION = "0.2.0"
MAX_UPLOAD = 12 * 1024 * 1024

@asynccontextmanager
async def _lifespan(_app):
    """Load the registry, search index and decision model before the first visitor, not during it."""
    engine()
    _registry_stats()
    yield


app = FastAPI(title="Ek Oshudh, Dui Naam API", version=APP_VERSION, lifespan=_lifespan)

# The app is served by this same server (same origin). CORS only matters for the Vite dev server on another port
# and for a phone on the same Wi-Fi or the optional tunnel.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https://.*\.trycloudflare\.com|http://localhost:\d+|http://127\.0\.0\.1:\d+|http://192\.168\.\d+\.\d+:\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)




@lru_cache(maxsize=1)
def engine():
    from app.conversation import Engine
    return Engine()


def live(payload: dict, t0: float) -> dict:
    """Every response carries a fresh request id, server time and latency: proof that nothing is cached."""
    return {**payload, "request_id": uuid.uuid4().hex[:12], "server_time": time.time(), "latency_ms": round((time.time() - t0) * 1000, 1)}


@app.get("/api/health")
def api_health():
    """What the app can do right now: the local registry always; reading photos and voice only with the AI."""
    from app.ai.gemini import STATUS
    e = engine()
    return {"registry": {"products": _registry_stats()["products"], "ready": True},
            "ai": {"key_present": bool(os.environ.get("GEMINI_API_KEY")), **STATUS},
            "aliases_skipped": e.index.alias_errors, "request_id": uuid.uuid4().hex[:12], "server_time": time.time()}


@app.get("/api/network")
def network(request: Request):
    """The laptop's address on the local network, so the QR code opens the app on a phone on the same Wi-Fi."""
    import socket
    port = request.url.port or 8000
    urls = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))          # no packet is sent; this only picks the outgoing interface
        ip = s.getsockname()[0]
        s.close()
        if not ip.startswith("127."):
            urls.append(f"http://{ip}:{port}")
    except OSError:
        pass
    return {"urls": urls}


@app.get("/api/copy")
def copy_text():
    """The app's wording (config/copy_bn.json): the same file the rules use."""
    from app.core.explain_bn import load_copy
    return {"ui": load_copy().get("ui", {}), "titles": load_copy()["titles"]}


@app.post("/api/cases/sample")
def sample_case():
    t0 = time.time()
    return live(engine().sample_case(), t0)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": APP_VERSION, "request_id": uuid.uuid4().hex[:12], "server_time": time.time()}


@app.post("/api/cases")
def new_case():
    t0 = time.time()
    return live({"case_id": engine().new_case().case_id}, t0)


def _case(case_id: str):
    try:
        return engine().get(case_id)
    except KeyError:
        raise HTTPException(404, "case not found or expired")


def _is_image(data: bytes) -> bool:
    import io

    from PIL import Image, UnidentifiedImageError
    try:
        Image.open(io.BytesIO(data)).verify()
        return True
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        return False


# Plain (non-async) routes: FastAPI runs them in a worker thread, so a slow AI call never blocks other visitors.
@app.post("/api/cases/{case_id}/images")
def add_image(case_id: str, file: UploadFile = File(...), allow_repeat: bool = False, upload_id: str | None = Form(None)):
    t0 = time.time()
    case = _case(case_id)
    data = file.file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "image too large (max 12 MB)")
    if not _is_image(data):
        raise HTTPException(415, "this file is not a photo")
    from app.ai.gemini import GeminiError
    try:
        return live(engine().add_image(case, data, allow_repeat=allow_repeat, upload_id=upload_id), t0)
    except GeminiError as e:
        raise HTTPException(502, f"reading failed: {e}")


class TextIn(BaseModel):
    text: str


MAX_TEXT_CHARS, MAX_TEXT_LINES = 2000, 30


MAX_AUDIO = 5 * 1024 * 1024


@app.post("/api/cases/{case_id}/voice")
def add_voice(case_id: str, file: UploadFile = File(...)):
    t0 = time.time()
    case = _case(case_id)
    data = file.file.read(MAX_AUDIO + 1)
    if not data or len(data) > MAX_AUDIO:
        raise HTTPException(413, "voice note must be under 5 MB")
    from app.ai.gemini import GeminiError
    try:
        out = engine().add_voice(case, data, file.content_type or "audio/webm")
    except ValueError as e:
        raise HTTPException(415, str(e))
    except GeminiError as e:
        raise HTTPException(502, f"could not transcribe: {e}")
    return live(out, t0)


@app.get("/api/cases/{case_id}/speech")
def case_speech(case_id: str):
    """Bangla voice reply for this case's findings (template text only)."""
    case = _case(case_id)
    from app.ai.gemini import GeminiError
    try:
        audio, mime, text = engine().speech(case)
    except GeminiError as e:
        raise HTTPException(502, f"could not create speech: {e}")
    return Response(audio, media_type=mime, headers={"Cache-Control": "no-store", "X-Request-Id": uuid.uuid4().hex[:12]})


@app.post("/api/cases/{case_id}/text")
def add_text(case_id: str, body: TextIn):
    t0 = time.time()
    if len(body.text) > MAX_TEXT_CHARS or body.text.count("\n") >= MAX_TEXT_LINES:
        raise HTTPException(413, f"too long: at most {MAX_TEXT_LINES} lines")
    return live(engine().add_text(_case(case_id), body.text), t0)


class ConfirmIn(BaseModel):
    product_id: int | None = None
    per_day: float | None = Field(default=None, gt=0, le=24)   # doses per day: a real schedule, not a typo


@app.post("/api/cases/{case_id}/items/{item_id}/confirm")
def confirm(case_id: str, item_id: str, body: ConfirmIn):
    t0 = time.time()
    case = _case(case_id)
    if body.product_id is not None and not engine().graph.has_product(body.product_id):
        raise HTTPException(422, "no such product in the registry")
    try:
        return live(engine().confirm(case, item_id, body.product_id, body.per_day), t0)
    except StopIteration:
        raise HTTPException(404, "item not found")


@app.get("/api/brands/web")
def brand_web(q: str):
    """Not in our registry: look the name up on MedEx (MedEx search, then DuckDuckGo). Only the name is sent."""
    t0 = time.time()
    q = q.strip()
    if not 2 <= len(q) <= 60:
        raise HTTPException(400, "name length")
    from app.core.web_lookup import lookup
    return live({"query": q, **lookup(q)}, t0)


class WebIn(BaseModel):
    url: str = Field(max_length=200)


@app.post("/api/cases/{case_id}/items/{item_id}/web")
def choose_web(case_id: str, item_id: str, body: WebIn):
    """The family tapped a MedEx result: the server fetches that page itself, adds the brand with its ingredients
    (source = the page) and confirms the line. Only medex.com.bd brand pages are accepted."""
    t0 = time.time()
    from app.core.web_lookup import BRAND_URL, fetch_brand
    if not BRAND_URL.fullmatch(body.url):
        raise HTTPException(400, "only medex.com.bd brand pages")
    case = _case(case_id)
    try:
        b = fetch_brand(body.url)
    except Exception:
        b = None
    if not b:
        raise HTTPException(502, "could not read that page")
    pid = engine().graph.add_product(b["brand"], b["generic"], b["strength"], b["form"], b["maker"], body.url)
    try:
        return live(engine().confirm(case, item_id, pid), t0)
    except StopIteration:
        raise HTTPException(404, "item not found")


class StatusIn(BaseModel):
    taking: Literal["current", "stopped", "unsure"]


@app.post("/api/cases/{case_id}/items/{item_id}/status")
def item_status(case_id: str, item_id: str, body: StatusIn):
    """Taken now / stopped / not sure: a duplicate turns red only when every medicine involved is taken now."""
    case = _case(case_id)
    if not any(i.item_id == item_id for i in case.items):
        raise HTTPException(404, "item not found")
    return engine().set_status(case, item_id, body.taking)


@app.delete("/api/cases/{case_id}/items/{item_id}")
def remove_item(case_id: str, item_id: str):
    case = _case(case_id)
    if not any(i.item_id == item_id for i in case.items):
        raise HTTPException(404, "item not found")
    engine().remove(case, item_id)
    return {"removed": item_id}


@app.post("/api/cases/{case_id}/items/{item_id}/resolve")
def resolve_item(case_id: str, item_id: str):
    """Agent looks for evidence (other medicines in the case, registry lookups) for one unclear item."""
    t0 = time.time()
    case = _case(case_id)
    if not any(i.item_id == item_id for i in case.items):
        raise HTTPException(404, "item not found")
    return live(engine().resolve(case, item_id), t0)


@app.get("/api/cases/{case_id}/check")
def check(case_id: str):
    t0 = time.time()
    case = _case(case_id)
    out = live(engine().check(case), t0)
    if os.environ.get("EK_PREFETCH_SPEECH"):   # live servers: start the voice reply now, while the result is read
        engine().prefetch_speech(case)
    return out


@app.get("/api/cases/{case_id}/items/{item_id}/crop.jpg")
def item_crop(case_id: str, item_id: str):
    it = next((i for i in _case(case_id).items if i.item_id == item_id), None)
    if not it or not it.crop:
        raise HTTPException(404, "no crop")
    return Response(it.crop, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/api/brands/search")
def brand_search(q: str):
    """'Try any brand': live lookup in the catalog, with the knowledge-graph path for the top match."""
    t0 = time.time()
    e = engine()
    cands = e.index.search(q, 20)
    opts = e._options(cands, 5)
    return live({"query": q, "options": opts, "path": e.graph.path(opts[0]["product_id"]) if opts else None}, t0)


@lru_cache(maxsize=1)
def _registry_stats() -> dict:
    """Computed once from the registry: sizes, and the medicines sold under the most brand names (single-ingredient
    products only, salts folded: 'Cefixime Trihydrate' -> Cefixime). Used by the welcome screen: nothing typed by hand."""
    from app.core.rules import base_ingredient
    g = engine().graph
    q = g._q
    reg = "WHERE source = 'registry'"   # the registry's own rows; brands added locally are not counted as registry
    counts = {"products": q(f"SELECT COUNT(*) FROM product {reg}")[0][0],
              "brand_names": q(f"SELECT COUNT(DISTINCT brand) FROM product {reg}")[0][0],
              "generics": q(f"SELECT COUNT(DISTINCT generic) FROM product {reg}")[0][0]}
    rows = q("""SELECT i.name, p.brand, COUNT(*) FROM product p
                JOIN product_ingredient pi ON pi.product_id = p.id JOIN ingredient i ON i.id = pi.ingredient_id
                WHERE p.id IN (SELECT product_id FROM product_ingredient GROUP BY product_id HAVING COUNT(*) = 1)
                GROUP BY i.name, p.brand""")
    by: dict[str, dict[str, int]] = {}
    for name, brand, n in rows:
        d = by.setdefault(base_ingredient(name).title(), {})
        d[brand] = d.get(brand, 0) + n
    featured = featured_examples(engine().settings.get("welcome_pairs") or [], by)
    shown = {e["ingredient"] for e in featured}
    top = [kv for kv in sorted(by.items(), key=lambda kv: -len(kv[1])) if kv[0] not in shown][:8]
    examples = featured + [{"ingredient": ing, "brand_count": len(brands), "brands": _by_count(brands)[:8]}
                           for ing, brands in top]
    return {**counts, "examples": examples}


def _by_count(brands: dict[str, int]) -> list[str]:
    return [b for b, _ in sorted(brands.items(), key=lambda kv: (-kv[1], kv[0]))]


def featured_examples(pairs: list, by: dict[str, dict[str, int]]) -> list[dict]:
    """The welcome pairs from settings (the brands in the story), each checked in the registry: both brands must be
    single-ingredient products with the same ingredient. The ingredient and the brand count are looked up, never typed;
    a pair that does not share an ingredient is left out."""
    out = []
    for pair in pairs:
        if len(pair) != 2:
            continue
        for ing, brands in by.items():
            names = {b.lower(): b for b in brands}
            a, b = (names.get(str(x).lower()) for x in pair)
            if a and b and a != b and ing not in {e["ingredient"] for e in out}:
                out.append({"ingredient": ing, "brand_count": len(brands),
                            "brands": [a, b] + [x for x in _by_count(brands) if x not in (a, b)][:6]})
                break
    return out


@app.get("/api/stats")
def stats():
    t0 = time.time()
    pol = engine().policy
    ev = None
    if pol.get("test"):
        ev = {"n_test": pol.get("n_test"), "reader": pol.get("reader"), "method": pol.get("method"),
              "top1": (pol.get("top1_test") or {}).get("R2"),                       # raw labels: the number we lead with
              "top1_audited": (pol.get("top1_test_audited") or {}).get("R2"),
              "auto_accept": pol["test"].get("auto_accept_coverage"),
              "auto_error_audited": (pol.get("test_audited") or {}).get("auto_accept_error")}
    return live({**_registry_stats(), "eval": ev}, t0)


@app.get("/api/brands/random")
def brand_random():
    t0 = time.time()
    e = engine()
    brand = random.choice(e.index.brands)
    p = e.graph.products_by_brand(brand)[0]
    return live({"brand": brand, "path": e.graph.path(p.id)}, t0)



@app.get("/api/cases/{case_id}")
def get_case(case_id: str):
    """Reopen a case by link (?case=...): its items, so the web app can show confirm or results."""
    t0 = time.time()
    case = _case(case_id)
    uploads = engine().uploads_view(case)   # first: an upload seen as done always has its items in the list below
    return live({"case_id": case.case_id, "items": [engine().item_view(i) for i in case.items], "uploads": uploads}, t0)


# The same server also serves the built web app (web/dist): one command runs the whole product locally.
_DIST = os.path.join(os.path.dirname(__file__), "..", "..", "web", "dist")
if os.path.isdir(_DIST):
    from fastapi.staticfiles import StaticFiles

    class _WebApp(StaticFiles):
        """The page itself is always re-checked (a phone that opened the link before kept the old app after an update);
        the bundled files have content hashes in their names, so those may be cached."""
        async def get_response(self, path, scope):
            resp = await super().get_response(path, scope)
            if path in ("", ".", "/", "index.html") or path.endswith(".html"):
                resp.headers["Cache-Control"] = "no-cache"
            return resp
    app.mount("/", _WebApp(directory=_DIST, html=True), name="web")
