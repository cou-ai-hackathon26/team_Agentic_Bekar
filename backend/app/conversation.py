"""One patient's case: everything the web app, the agent and the MCP server share.

photo/text -> perceive -> candidates -> matching policy -> items to confirm -> rules -> Bangla findings.
Cases live in memory only (images are never written to disk) and expire after two hours.
Every step is timed into a trace that the Proof screen shows.
"""
from __future__ import annotations

import json
import os
import threading
import re
from concurrent.futures import Future, ThreadPoolExecutor
import time
import uuid
from dataclasses import dataclass, field

from app.core import explain_bn
from app.core.candidates import Candidate, CandidateIndex, parse_hints
from app.core.decide import Decider, products_per_brand
from app.core.graph import ROOT, Graph, brand_key
from app.core.rerank import distinct_brands, r1, r3
from app.core.rules import Item, Rules, base_ingredient, site_of
from app.core.schedule import parse as parse_schedule
from app.core.settings import DEFAULTS as SETTINGS_DEFAULTS, _merge, load_settings

POLICY_PATH = os.path.join(ROOT, "models", "policy.json")
_MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}


def _parse_date(text: str) -> tuple | None:
    """'Jun 10, 2025', '10/06/2025', '18 SEP 2026', '১০.০৮.২০২৬' -> (day, month, year % 100); None if unreadable.
    Bangladeshi prescriptions write numeric dates day first."""
    t = text.translate(str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")).lower()
    month = next((n for m, n in _MONTHS.items() if m in t), None)
    nums = [int(x) for x in re.findall(r"\d+", t)]
    year = next((n for n in nums if n >= 1000), None)
    rest = [n for n in nums if n != year]
    if year is None and len(rest) == 3:
        year = rest.pop()
    if year is None or not rest:
        return None
    if month is None:
        if len(rest) < 2:
            return None
        day, month = rest[0], rest[1]
    else:
        day = rest[0]
    return (day, month, year % 100) if 1 <= day <= 31 and 1 <= month <= 12 else None


EXACT_AGREE = 0.9   # both photo readers wrote (nearly) the same brand text

# A diagnosis line is not a medicine (24 Nov: 'T. corporis' on a dermatologist's prescription was read as a tablet).
# The reader is told so; this catches the plain cases it still lists. 'T.' before a Latin skin-disease name is Tinea.
_DIAGNOSIS = re.compile(
    r"^\s*(t\.?\s*|tinea\s+)(corporis|cruris|capitis|pedis|versicolou?r|faciei|manuum|unguium|incognito|barbae)\b"
    r"|^\s*(scabies|acne(\s+vulgaris)?|eczema|psoriasis|urticaria|dermatitis|pityriasis|melasma|vitiligo|impetigo"
    r"|hypertension|htn|diabetes|gerd|urti|c/o|dx|d/d|o/e)\b", re.I)

# Voiced and voiceless partners that speech recognition swaps at the start of a word (টেস heard for ডেস).
_SOUND_PAIRS = {"t": "d", "d": "t", "k": "g", "g": "k", "p": "b", "b": "p", "c": "j", "j": "c"}
VOICE_VARIANT_WEIGHT = 0.9  # a sound-alike must be clearly better than what was heard to come first


def sound_alikes(name: str) -> list[str]:
    """The same spoken name with its first letter swapped for its voiced/voiceless partner: 'tes' -> ['des']."""
    n = (name or "").strip().lower()
    return [_SOUND_PAIRS[n[0]] + n[1:]] if n and n[0] in _SOUND_PAIRS else []

DEFAULT_POLICY = {"method": "R1+R3", "r1_accept": 0.85, "r1_margin": 0.10, "r2_accept": 0.98, "agree_min": None,
                  "note": "default until E1/R2 sets thresholds"}
TTL_SECONDS = 2 * 3600


def load_policy() -> dict:
    if os.path.exists(POLICY_PATH):
        return {**DEFAULT_POLICY, **json.load(open(POLICY_PATH, encoding="utf-8"))}
    return dict(DEFAULT_POLICY)


@dataclass
class CaseItem:
    item_id: str
    doc_id: str
    source: str                   # rx | strip | text
    reading: str
    alternatives: list[str]
    strength_text: str
    schedule_text: str
    handwritten: bool
    agree: float | None
    options: list[dict]           # top-3 catalog products for the confirm screen
    product_id: int | None
    confidence: float
    method: str
    needs_confirm: bool
    per_day: float | None
    schedule: dict
    doctor: str | None
    crop: bytes | None = None
    agent: dict | None = None     # the resolver's suggestion for an unclear item (still needs the user's tap)
    taking: str = "unsure"        # current | stopped | unsure, set by the family; red duplicates need 'current'


@dataclass
class Case:
    case_id: str
    created: float = field(default_factory=time.time)
    items: list[CaseItem] = field(default_factory=list)
    docs: list[dict] = field(default_factory=list)
    trace: list[dict] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    sample: bool = False
    uploads: dict = field(default_factory=dict)   # upload id from the phone -> what that photo gave (or its duplicate)
    _next_item: int = 1
    _next_doc: int = 1

    def __getstate__(self):          # saved to disk without its lock (cases survive a server restart)
        state = dict(self.__dict__)
        state.pop("lock", None)
        return state

    def __setstate__(self, state):
        self.__dict__.update(state)
        self.__dict__.setdefault("uploads", {})
        self.lock = threading.Lock()

    def new_ids(self, n_items: int, new_doc: bool = False) -> tuple[list[str], str | None]:
        """Reserve item ids (and a document id) under the case lock: parallel uploads never share an id."""
        with self.lock:
            ids = [f"I{self._next_item + k}" for k in range(n_items)]
            self._next_item += n_items
            doc = None
            if new_doc:
                doc, self._next_doc = f"D{self._next_doc}", self._next_doc + 1
            return ids, doc

    def step(self, name: str, t0: float, **info) -> None:
        self.trace.append({"step": name, "ms": round((time.time() - t0) * 1000, 1), **info})


class Engine:
    def __init__(self, settings: dict | None = None):
        self.settings = load_settings() if settings is None else _merge(SETTINGS_DEFAULTS, settings)
        self.graph = Graph()
        self.index = CandidateIndex(self.graph)
        self.rules = Rules(self.graph, self.settings["rules"])
        self.policy = load_policy()
        if self.settings["matching"]["auto_accept_threshold"] is not None:
            self.policy["r2_accept"] = float(self.settings["matching"]["auto_accept_threshold"])
        self.decider = None
        if self.policy.get("method", "").startswith("R2") and Decider.available():
            self.decider = Decider()
            self.ppb = products_per_brand(self.graph)
        self.cases: dict[str, Case] = {}
        self._speech_cache: dict[str, tuple[bytes, str]] = {}   # reply text -> audio
        self._speech_running: dict = {}
        self._speech_lock = threading.Lock()
        self._speech_pool = ThreadPoolExecutor(4)
        self._load_cases()
        if os.environ.get("EK_CASES_FILE"):
            threading.Thread(target=self._save_cases_forever, daemon=True).start()
        self.lock = threading.Lock()

    # ---------- case store ----------
    def new_case(self) -> Case:
        with self.lock:
            now = time.time()
            for cid in [c for c, v in self.cases.items() if now - v.created > TTL_SECONDS]:
                del self.cases[cid]
            case = Case(uuid.uuid4().hex[:10])
            self.cases[case.case_id] = case
            return case

    def get(self, case_id: str) -> Case:
        case = self.cases.get(case_id)
        if case and time.time() - case.created > TTL_SECONDS:   # expired: forget it now, not only on the next new case
            with self.lock:
                self.cases.pop(case_id, None)
            case = None
        if not case:
            raise KeyError(case_id)
        return case

    # ---------- matching ----------
    def _options(self, cands: list[Candidate], k: int = 3) -> list[dict]:
        return [{"product_id": c.product_id, "brand": c.brand, "strength": c.strength, "form": c.form,
                 "maker": c.manufacturer, "generic": c.generic, "score": round(c.name_score, 3)}
                for c in distinct_brands(cands, k)]

    def match(self, reading: str, alternatives: list[str], crop_parts: list | None, handwritten: bool,
              agree: float | None = None) -> tuple:
        """-> (chosen product or None, confidence, method, needs_confirm, candidates in display order).
        With settings matching.always_confirm every reading waits for the family's tap.
        An exact registry name skips the threshold only when typed, or when read from a photo and BOTH readers wrote
        the same name (agree): the reader's own 'printed' flag alone is not trusted, as a model can tidy a messy
        handwritten word into a real brand name."""
        exact_ok = not handwritten and (crop_parts is None or (agree or 0) >= EXACT_AGREE)
        chosen, conf, method, confirm, cands = self._match(reading, alternatives, crop_parts, handwritten, exact_ok)
        return chosen, conf, method, confirm or bool(self.settings["matching"]["always_confirm"]), cands

    def match_voice(self, said: str, latin: str, strength: str = "") -> tuple:
        """A spoken name -> (chosen, confidence, method, True, candidates in display order). Each spelling is searched
        on its own and the results are merged by the decision model's probability: the English letters the model wrote,
        our own transliteration of the Bangla as said (so a brand the model swapped in cannot hide what was said), and
        the first-letter sound-alikes (টেস -> Des). A spoken item always waits for the family's tap."""
        strength = (strength or "").strip()
        names, keys = [], []
        for n in (latin, said):
            k = parse_hints(n or "")[0]
            if k and k not in keys:
                names.append(n.strip())
                keys.append(k)
        if not names:
            return None, 0.0, "none", True, []
        readings = [(f"{n} {strength}".strip(), 1.0) for n in names]
        readings += [(f"{s} {strength}".strip(), VOICE_VARIANT_WEIGHT) for k in keys for s in sound_alikes(k) if s not in keys]
        if self.decider is None:
            chosen, conf, method, _, cands = self.match(readings[0][0], [r for r, _ in readings[1:]], None, False)
            return chosen, conf, method, True, cands
        best: dict[str, tuple[Candidate, float]] = {}
        others: list[Candidate] = []
        for reading, weight in readings:
            cands, ranked = self.decider.rank_reading(self.index, reading, [], self.ppb)
            for c, p in ranked:
                if c.brand not in best or p * weight > best[c.brand][1]:
                    best[c.brand] = (c, p * weight)
            others += cands
        order = [c for c, _ in sorted(best.values(), key=lambda cp: -cp[1])]
        shown = {c.brand for c in order}
        for c in others:
            if c.brand not in shown:
                order.append(c)
                shown.add(c.brand)
        if not order:
            return None, 0.0, "none", True, []
        return order[0], round(best.get(order[0].brand, (None, 0.0))[1], 3), f"voice: {len(readings)} spellings", True, order

    def _match(self, reading: str, alternatives: list[str], crop_parts: list | None, handwritten: bool,
               exact_ok: bool = False) -> tuple:
        if self.decider is not None:
            return self._match_r2(reading, alternatives, crop_parts, exact_ok=exact_ok)
        cands = self.index.search(reading, 20)
        seen = {c.product_id for c in cands}
        for alt in alternatives[:3]:
            for c in self.index.search(alt, 20):
                if c.product_id not in seen:
                    cands.append(c)
                    seen.add(c.product_id)
        if not cands:
            return None, 0.0, "none", True, []
        first = r1(cands)
        sure = first.confidence >= self.policy["r1_accept"] and first.detail.get("margin", 0) >= self.policy["r1_margin"]
        if sure and not handwritten:
            return first.candidate, first.confidence, "R1", False, cands
        third = self._safe_r3(crop_parts, cands) if crop_parts else None
        if third is not None:
            if third.candidate and third.candidate.brand == first.candidate.brand and sure:
                return third.candidate, max(first.confidence, third.confidence), "R1+R3 agree", False, cands
            if third.candidate:
                return third.candidate, third.confidence, "R3", True, cands
        return first.candidate, first.confidence, "R1", True, cands

    @staticmethod
    def _safe_r3(crop_parts: list, cands: list):
        """The constrained AI choice is a second opinion: if it fails (network, quota), the family is asked instead."""
        from app.ai.gemini import GeminiError
        try:
            return r3(crop_parts, cands, k=5)
        except GeminiError:
            return None

    def _match_r2(self, reading: str, alternatives: list[str], crop_parts: list | None, exact_ok: bool = False) -> tuple:
        """Shipped policy from E1 (models/policy.json): accept when the decision model is sure; otherwise ask the
        constrained AI to pick from the model's top-5 and accept only if it independently agrees; else ask the user.
        exact_ok (typed names, printed strips/boxes): the threshold was calibrated on handwriting, so for these an
        exact registry brand name is accepted as written; anything fuzzier still follows the policy."""
        cands, ranked = self.decider.rank_reading(self.index, reading, alternatives, self.ppb)
        if not ranked:
            return None, 0.0, "none", True, []
        order = [c for c, _ in ranked] + [c for c in cands if c.brand not in {x.brand for x, _ in ranked}]
        top, p = ranked[0]
        if p >= self.policy["r2_accept"]:
            return top, round(p, 3), "R2", False, order
        if exact_ok and brand_key(parse_hints(self.index.apply_alias(reading))[0]) == brand_key(top.brand):
            return top, round(p, 3), "exact name", False, order
        third = self._safe_r3(crop_parts, [c for c, _ in ranked[:5]]) if crop_parts else None
        if third is not None:
            agree_min = self.policy.get("agree_min")
            if third.candidate and third.candidate.brand == top.brand and agree_min is not None and p >= agree_min:
                return top, round(p, 3), "R2+R3 agree", False, order
            if third.candidate and third.candidate.brand == top.brand:  # agree, but the policy still wants a tap
                return top, round(p, 3), "R2+R3 agree, confirm", True, order
            if third.candidate:  # disagreement: show the AI's pick first, but the user decides
                order = [third.candidate] + [c for c in order if c.brand != third.candidate.brand]
                return third.candidate, round(p, 3), "R2/R3 disagree", True, order
        return top, round(p, 3), "R2 unsure", True, order

    # ---------- inputs ----------
    @staticmethod
    def _doc_signature(read: dict) -> dict:
        """What identifies a prescription photo: the doctor, the date and the medicine names as read."""
        return {"doctor": " ".join((read.get("doctor_text") or "").lower().replace(".", " ").split()),
                "date": _parse_date(read.get("date_text") or ""),
                "names": [n for n in (parse_hints(i.get("brand_text", ""))[0] for i in read["items"]) if n]}

    @staticmethod
    def _same_prescription(a: dict, b: dict) -> bool:
        """The same prescription photographed again? Two readings of one photo are never identical (a letter is read
        differently, the doctor is written in English once and in Bangla the next), so compare loosely. A different month means a new visit, even with the same medicines. Saying "same prescription again?"
        by mistake costs the family one tap; missing it would show every line as a duplicate."""
        from rapidfuzz import fuzz
        # Only the month decides: day and year digits on stamps are misread (13 AUG 2026 read as 18 AUG 2020), the
        # month rarely is, and a real follow-up visit is almost always in another month.
        if a["date"] and b["date"] and a["date"][1] != b["date"][1]:
            return False
        if not a["names"] or not b["names"]:
            return False
        alike = sum(1 for x in a["names"] if max(fuzz.ratio(x, y) for y in b["names"]) >= 80)
        overlap = alike / max(len(a["names"]), len(b["names"]))
        same_doctor = bool(a["doctor"] and b["doctor"]) and fuzz.token_set_ratio(a["doctor"], b["doctor"]) >= 80
        return overlap >= 0.75 or (overlap >= 0.5 and same_doctor)

    def add_image(self, case: Case, data: bytes, allow_repeat: bool = False, upload_id: str | None = None) -> dict:
        """The case records each upload from the moment it arrives (reading -> done | failed): the phone can lose this
        answer (Android drops the connection when the camera opens, or reloads the page) and asks the case instead."""
        uid = upload_id[:64] if upload_id else None
        if uid:
            with case.lock:
                case.uploads[uid] = {"state": "reading", "started": time.time(), "doc_id": None, "duplicate_of": None, "items": []}
        try:
            out = self._add_image(case, data, allow_repeat)
        except Exception:
            if uid:
                with case.lock:
                    case.uploads[uid]["state"] = "failed"
            raise
        if uid:
            with case.lock:
                case.uploads[uid].update(state="done", doc_id=out["doc_id"], duplicate_of=out["duplicate_of"],
                                         items=[i["item_id"] for i in out["items"]])
        return out

    UPLOAD_STUCK_SECONDS = 180

    def uploads_view(self, case: Case) -> dict:
        """An upload still 'reading' long after it started was cut off (a server restart): report it as failed."""
        now = time.time()
        with case.lock:
            return {k: ({**u, "state": "failed"} if u.get("state") == "reading" and now - u.get("started", now) > self.UPLOAD_STUCK_SECONDS
                        else u) for k, u in case.uploads.items()}

    def _add_image(self, case: Case, data: bytes, allow_repeat: bool = False) -> dict:
        from app.ai.gemini import image_part
        from app.ai.perceive import crop, read_image
        t0 = time.time()
        read = read_image(data)
        read["items"] = [it for it in read.get("items", []) if not _DIAGNOSIS.search(it.get("brand_text", "") or "")]
        sig = self._doc_signature(read)
        if read["kind"] == "prescription" and not allow_repeat:
            seen = next((d for d in case.docs if d.get("sig") and self._same_prescription(sig, d["sig"])), None)
            if seen:   # counted once: otherwise one prescription would look like two doctors prescribing the same thing
                case.step("perceive", t0, kind=read["kind"], duplicate_of=seen["doc_id"])
                return {"doc_id": None, "duplicate_of": seen["doc_id"], "kind": read["kind"], "items": []}
        ids, doc_id = case.new_ids(len(read["items"]), new_doc=True)
        source = "rx" if read["kind"] == "prescription" else "strip"
        steps = [("perceive", t0, dict(doc=doc_id, kind=read["kind"], lines=len(read["items"]), model=read["meta"].get("model")))]
        def one(item_id, it):
            t1 = time.time()
            c = crop(read["image"], it.get("box"))
            parts = [image_part(c, "image/jpeg")] if c else None
            text = " ".join(x for x in (it.get("brand_text", ""), it.get("strength_text", ""), it.get("form_text", "")) if x)
            chosen, conf, method, confirm, cands = self.match(text, it.get("alternatives", []), parts, bool(it.get("handwritten")),
                                                              it.get("agree"))
            sched = parse_schedule(" ".join(x for x in (it.get("schedule_text", ""), it.get("meal_text", ""), it.get("duration_text", "")) if x))
            ci = CaseItem(item_id, doc_id, source, it.get("brand_text", ""), it.get("alternatives", []),
                          it.get("strength_text", ""), it.get("schedule_text", ""), bool(it.get("handwritten")), it.get("agree"),
                          self._options(cands), chosen.product_id if chosen else None, round(conf, 3), method, confirm,
                          sched.per_day, sched.to_dict(), read.get("doctor_text") or doc_id, c)
            return ci, ("match", t1, dict(item=ci.item_id, reading=ci.reading, method=method, confidence=ci.confidence,
                                          chosen=self.options_brand(ci)))
        # The lines are matched together (an unsure line waits for the AI's second look; one after another, a photo of
        # eight strips once took 122 s). map keeps the photo's order.
        pairs = list(zip(ids, read["items"]))
        with ThreadPoolExecutor(max(1, min(8, len(pairs)))) as pool:
            done = list(pool.map(lambda p: one(*p), pairs))
        new = [ci for ci, _ in done]
        steps += [s for _, s in done]
        if source == "strip":
            new = self._drop_ingredient_lines(self._one_per_product(new))
        # only now, when every line was read and matched, does the photo become part of the case (all or nothing)
        # checked again while saving: two photos of one prescription read at the same time both passed the check above
        same = None if allow_repeat else (lambda d: bool(sig and d.get("sig") and self._same_prescription(sig, d["sig"])))
        seen = self._commit(case, new, steps, doc={"doc_id": doc_id, "kind": read["kind"], "doctor": read.get("doctor_text") or doc_id,
                                                   "date": read.get("date_text") or "", "sig": sig}, same=same)
        if seen:
            return {"doc_id": None, "duplicate_of": seen["doc_id"], "kind": read["kind"], "items": []}
        return {"doc_id": doc_id, "duplicate_of": None, "kind": read["kind"], "items": [self.item_view(i) for i in new]}

    @staticmethod
    def _one_per_product(items: list) -> list:
        """One strip photo shows one product printed many times (English, Bangla, again on every blister): list each
        product once, keeping the reading the matcher was surest of. Different products in one photo stay apart."""
        best: dict = {}
        for ci in items:
            key = ci.product_id if ci.product_id is not None else ("unmatched", ci.reading.lower())
            if key not in best or (best[key].needs_confirm and not ci.needs_confirm):
                best[key] = ci
        kept = {id(ci) for ci in best.values()}
        return [ci for ci in items if id(ci) in kept]

    _PHARMACOPEIA = re.compile(r"\b(usp|bp|ip|inn|ph\.?\s*eur\.?)\b|[0-9.,]+\s*(mg|mcg|g|ml|iu|%)?", re.I)

    def _drop_ingredient_lines(self, items: list) -> list:
        """A strip also prints its ingredient ('Esomeprazole USP' under Sergel MUPS). A reader sometimes lists that as a
        second medicine and the matcher offers another brand of the same ingredient: one strip would become a duplicate
        (24 Nov, real photo: Sergel MUPS + 'Esomeprazole USP' -> Esoral MUPS). A line whose name is the ingredient of
        another product in the same photo is that strip's ingredient text, so it is not a medicine of its own."""
        from rapidfuzz import fuzz
        ings = {id(ci): {base_ingredient(n) for n, _, _ in self.graph.ingredients(ci.product_id)}
                for ci in items if ci.product_id is not None}

        def ingredient_line(ci) -> bool:
            if ci.product_id is not None and brand_key(self.graph.product(ci.product_id).brand) == brand_key(
                    parse_hints(ci.reading)[0]):
                return False                       # an exact registered brand name ('Calamine' lotion) is a medicine
            name = base_ingredient(self._PHARMACOPEIA.sub(" ", ci.reading.lower()))
            return bool(name) and any(fuzz.ratio(name, ing) >= 90 for other, names in ings.items() if other != id(ci)
                                      for ing in names)
        return [ci for ci in items if not ingredient_line(ci)]

    @staticmethod
    def _commit(case: Case, new: list, steps: list, doc: dict | None = None, same=None) -> dict | None:
        """Save under the case lock. With `same`, a document already saved that matches it wins: nothing is saved and
        that document is returned."""
        with case.lock:
            if doc and same:
                seen = next((d for d in case.docs if same(d)), None)
                if seen:
                    return seen
            if doc:
                case.docs.append(doc)
            case.items.extend(new)
            for name, t0, info in steps:
                case.step(name, t0, **info)
        return None

    def add_text(self, case: Case, text: str) -> dict:
        """Typed or spoken lines, e.g. 'Napa 500 1+0+1'. Works offline: no model call at all."""
        lines = [l.strip() for l in text.replace("،", "\n").split("\n") if l.strip()]
        ids, _ = case.new_ids(len(lines))
        new, steps = [], []
        for item_id, line in zip(ids, lines):
            t0 = time.time()
            sched = parse_schedule(line)
            chosen, conf, method, confirm, cands = self.match(line, [], None, False)
            ci = CaseItem(item_id, "typed", "text", line, [], "", line, False, None, self._options(cands),
                          chosen.product_id if chosen else None, round(conf, 3), method, confirm, sched.per_day,
                          sched.to_dict(), None)
            new.append(ci)
            steps.append(("match", t0, dict(item=ci.item_id, reading=line, method=method, confidence=ci.confidence,
                                            chosen=self.options_brand(ci))))
        self._commit(case, new, steps)
        return {"items": [self.item_view(i) for i in new]}

    def add_voice(self, case: Case, data: bytes, mime: str) -> dict:
        """Voice note -> transcript (shown verbatim) -> medicine mentions -> catalog matcher. Spoken brand names are
        short and easy to mishear (e.g. 'Ace'), so every spoken item waits for the user's one-tap confirmation."""
        from app.ai import speech
        t0 = time.time()
        transcript, found, meta = speech.hear(data, mime)
        case.step("hear", t0, model=meta.get("model"), chars=len(transcript), mentions=len(found),
                  fallback=meta.get("fallback"))
        ids, _ = case.new_ids(len(found))
        new, steps = [], []
        for item_id, m in zip(ids, found):
            t2 = time.time()
            said, latin = (m.get("name_as_said") or "").strip(), (m.get("name_english_letters") or "").strip()
            reading = " ".join(x for x in (latin or said, m.get("strength_text", "")) if x)
            alts = [a for a in (said, latin) if a and a != (latin or said)]
            sched_text = m.get("schedule_text", "") or ""
            sched = parse_schedule(sched_text)
            chosen, conf, method, _, cands = self.match_voice(said, latin, m.get("strength_text", "") or "")
            ci = CaseItem(item_id, "voice", "voice", said or latin, alts, m.get("strength_text", ""),
                          sched_text, False, None, self._options(cands), chosen.product_id if chosen else None,
                          round(conf, 3), method, True, sched.per_day, sched.to_dict(), None)
            new.append(ci)
            steps.append(("match", t2, dict(item=ci.item_id, reading=reading, method=method, confidence=ci.confidence,
                                            chosen=self.options_brand(ci))))
        self._commit(case, new, steps)
        return {"transcript": transcript, "items": [self.item_view(i) for i in new]}

    def _speech_job(self, case: Case):
        """(text, future): the reply audio for the case's current findings, made once per text; a request while it is
        being made waits for that same job instead of starting another."""
        from app.ai import speech as sp
        result = self.check(case)
        parts = sp.findings_speech_parts(result["findings"], result["unchecked"])
        text = " ".join(parts)
        with self._speech_lock:
            if text in self._speech_cache:
                fut = Future()
                fut.set_result((*self._speech_cache[text], {"model": "cache"}))
                return text, fut
            fut = self._speech_running.get(text)
            if fut is None:
                fut = self._speech_pool.submit(self._make_speech, text, parts)
                self._speech_running[text] = fut
            return text, fut

    def _make_speech(self, text: str, parts: list[str]):
        from app.ai import speech as sp
        try:
            audio, mime, meta = sp.speak_parts(parts)
            with self._speech_lock:
                self._speech_cache[text] = (audio, mime)
                while len(self._speech_cache) > 64:
                    self._speech_cache.pop(next(iter(self._speech_cache)))
            return audio, mime, meta
        finally:
            with self._speech_lock:
                self._speech_running.pop(text, None)

    def prefetch_speech(self, case: Case) -> None:
        """Start making the reply audio now (called when the bag is checked), so the tap on শুনুন plays at once."""
        try:
            self._speech_job(case)
        except Exception:
            pass

    def speech(self, case: Case) -> tuple[bytes, str, str]:
        t0 = time.time()
        text, fut = self._speech_job(case)
        audio, mime, meta = fut.result()
        case.step("speak", t0, model=meta.get("model"), chars=len(text))
        return audio, mime, text

    # ---------- cases survive a server restart (on only for the live servers: EK_CASES_FILE) ----------
    def _load_cases(self) -> None:
        import pickle
        path = os.environ.get("EK_CASES_FILE")
        if not path or not os.path.exists(path):
            return
        try:
            saved = pickle.load(open(path, "rb"))
            now = time.time()
            self.cases.update({cid: c for cid, c in saved.items() if now - c.created <= TTL_SECONDS})
        except Exception:
            pass

    def _save_cases_forever(self) -> None:
        import pickle
        path = os.environ["EK_CASES_FILE"]
        while True:
            time.sleep(3)
            try:
                with self.lock:
                    snapshot = dict(self.cases)
                tmp = path + ".tmp"
                with open(tmp, "wb") as f:
                    pickle.dump(snapshot, f)
                os.replace(tmp, path)
            except Exception:
                pass

    def remove(self, case: Case, item_id: str) -> None:
        with case.lock:
            it = next(i for i in case.items if i.item_id == item_id)
            case.items.remove(it)
        case.step("remove", time.time(), item=item_id)

    def add_typed(self, case: Case, lines: list[str], rx_doctor: str = "typed prescription") -> dict:
        """Typed lines; 'Rx: ...' lines count as a prescription (shared by the sample case and the MCP tool)."""
        rx = [l.split(":", 1)[1].strip() for l in lines if l.lower().startswith("rx:")]
        bag = [l for l in lines if l.strip() and not l.lower().startswith("rx:")]
        new = []
        if rx:
            before = {i.item_id for i in case.items}
            new += self.add_text(case, "\n".join(rx))["items"]
            for it in case.items:
                if it.item_id not in before:
                    it.source, it.doc_id, it.doctor = "rx", "typed-rx", rx_doctor
            new = [self.item_view(i) for i in case.items if i.item_id not in before]
        if bag:
            new += self.add_text(case, "\n".join(bag))["items"]
        return {"items": new}

    def sample_case(self) -> dict:
        """A clearly labelled sample built at run time from the lines in config/settings.json ('sample_case'):
        every match and finding is computed live, nothing stored."""
        case = self.new_case()
        case.sample = True
        out = self.add_typed(case, list(self.settings.get("sample_case") or []), rx_doctor="ডা. নমুনা")
        return {"case_id": case.case_id, "sample": True, "items": out["items"]}

    def set_status(self, case: Case, item_id: str, taking: str) -> dict:
        """The family says whether this medicine is taken now, stopped, or not known."""
        it = next(i for i in case.items if i.item_id == item_id)
        it.taking = taking
        case.step("status", time.time(), item=item_id, taking=taking)
        return self.item_view(it)

    def resolve(self, case: Case, item_id: str) -> dict:
        """Ask the agent to look for evidence for one unclear item. It can only reorder the options and explain;
        the item still waits for the user's confirmation."""
        from app.agent.resolver import safe_resolve
        it = next(i for i in case.items if i.item_id == item_id)
        t0 = time.time()
        out = safe_resolve(self, case, it)
        case.step("agent", t0, item=item_id, tools=[s["tool"] for s in out.get("steps", [])], grounded=out.get("grounded"),
                  suggestion=self.graph.product(out["product_id"]).brand if out.get("product_id") else None)
        if out.get("product_id"):
            pid = out["product_id"]
            p = self.graph.product(pid)
            first = {"product_id": pid, "brand": p.brand, "strength": p.strength, "form": p.form,
                     "maker": p.manufacturer, "generic": "", "score": 1.0}
            it.options = [first] + [o for o in it.options if o["brand"] != p.brand][:2]
            it.agent = {"product_id": pid, "brand": p.brand, "reason_bn": self._agent_reason(p.brand, out.get("evidence")),
                        "tools": [s["tool"] for s in out["steps"]]}
        else:
            it.agent = {"product_id": None, "brand": None, "reason_bn": "", "tools": [s["tool"] for s in out.get("steps", [])]}
        return self.item_view(it)

    @staticmethod
    def _agent_reason(brand: str, evidence: str | None) -> str:
        """A fixed sentence naming where the evidence came from; the model's own words are never shown."""
        a = explain_bn.load_copy()["agent"]
        if evidence and evidence.startswith("bag:"):
            src = a["src"].get(evidence.split(":", 1)[1], a["src"]["text"])
            return a["reason_bag"].format(source=src, brand=brand)
        return a["reason_registry"].format(brand=brand)

    def confirm(self, case: Case, item_id: str, product_id: int | None, per_day: float | None = None) -> dict:
        it = next(i for i in case.items if i.item_id == item_id)
        it.product_id, it.needs_confirm, it.method = product_id, False, "user"
        if per_day is not None:
            it.per_day = per_day
        return self.item_view(it)

    # ---------- check ----------
    def check(self, case: Case) -> dict:
        t0 = time.time()
        items = [Item(i.item_id, i.source, i.doc_id, i.product_id,
                      confirmed=not i.needs_confirm, handwritten=i.handwritten, per_day=i.per_day, doctor=i.doctor,
                      taking=i.taking)
                 for i in case.items]
        meds, findings = self.rules.check(items)
        case.step("rules", t0, findings=len(findings))
        out_meds = []
        for m in meds:
            out_meds.append({"med_id": m.med_id, "brand": m.brand, "strength": m.strength, "form": m.form,
                             "unit_price": m.unit_price,   # shown when the monthly cost is unknown (no schedule)
                             "applied": site_of(m.form) != "body",   # cream, lotion, drops: 'used', not 'eaten'
                             "path": self.graph.path(m.product_id), "per_day": m.per_day, "from_rx": m.from_rx,
                             "doctors": m.doctors, "taking": m.taking, "monthly_cost": Rules.monthly_cost(m),
                             "checked": m.usable_for_red,   # False: waiting for the family's tap, left out of every rule
                             "cheaper": self.rules.cheaper(m.product_id) if m.usable_for_red else [],
                             "items": [s.item_id for s in m.sources]})
        # lines still waiting for the family's tap (or not found) were left out of every rule: say so, never "all clear"
        unchecked = sum(1 for i in case.items if i.needs_confirm or i.product_id is None)
        return {"case_id": case.case_id, "medicines": out_meds, "findings": [explain_bn.explain(f) for f in findings],
                "unchecked": unchecked, "trace": case.trace[-40:], "policy": self.policy}

    # ---------- views ----------
    def options_brand(self, it: CaseItem) -> str | None:
        return self.graph.product(it.product_id).brand if it.product_id else None

    def item_view(self, it: CaseItem) -> dict:
        chosen = None
        if it.product_id:
            p = self.graph.product(it.product_id)
            src = self.graph.source(p.id)
            chosen = {"product_id": p.id, "brand": p.brand, "strength": p.strength, "form": p.form, "maker": p.manufacturer,
                      "applied": site_of(p.form) != "body", "web": src if src.startswith("http") else None}
        return {"item_id": it.item_id, "doc_id": it.doc_id, "source": it.source, "reading": it.reading,
                "alternatives": it.alternatives, "handwritten": it.handwritten, "agree": it.agree, "chosen": chosen,
                "confidence": it.confidence, "method": it.method, "needs_confirm": it.needs_confirm,
                "options": it.options, "schedule": it.schedule, "per_day": it.per_day, "has_crop": it.crop is not None,
                "agent": it.agent, "doctor": it.doctor, "taking": it.taking}
