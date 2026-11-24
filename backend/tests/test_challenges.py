"""The two onsite challenges (CoU AI Hackathon 2026 finals, 24 Nov), each pinned by tests. The photo reader is faked
(no network); matching, the knowledge graph, reconciliation and the rules are real.

1. Let a family scan one medicine strip in several packets at once and get a single bag verdict.
   (direction: multi-strip bag scan in one photo)
2. Stay careful when a brand is unknown or the strip photo is unreadable, so nothing is wrongly called a duplicate.
"""
import os

import pytest

from app.core import graph as g

pytestmark = pytest.mark.skipif(not os.path.exists(g.DB_PATH), reason="graph not built")


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def photo(client, monkeypatch, cid, lines, kind="strip"):
    import app.ai.perceive as perceive
    from tests.test_api import fake_read
    from tests.test_robustness import jpg
    monkeypatch.setattr(perceive, "read_image", fake_read(lines, kind=kind))
    return client.post(f"/api/cases/{cid}/images", files={"file": ("a.jpg", jpg(), "image/jpeg")}).json()


def taking_now(client, cid):
    for it in client.get(f"/api/cases/{cid}").json()["items"]:
        if it["chosen"] and not it["needs_confirm"]:
            client.post(f"/api/cases/{cid}/items/{it['item_id']}/status", json={"taking": "current"})
    return client.get(f"/api/cases/{cid}/check").json()


def dups(result):
    return [f for f in result["findings"] if f["rule"].startswith("DUP")]


# ---------- Challenge 1: several strips, several packets, one bag verdict ----------

def test_c1_several_strips_in_one_photo_give_one_bag_verdict(client, monkeypatch):
    cid = client.post("/api/cases").json()["case_id"]
    out = photo(client, monkeypatch, cid, [("Napa", "500 mg", ""), ("Ace", "500 mg", ""), ("Sergel MUPS", "20 mg", "")])
    assert sorted(i["chosen"]["brand"] for i in out["items"]) == ["Ace", "Napa", "Sergel MUPS"]
    result = taking_now(client, cid)
    brand = {m["med_id"]: m["brand"] for m in result["medicines"]}
    assert [(f["severity"], sorted(brand[m] for m in f["meds"])) for f in dups(result)] == [("red", ["Ace", "Napa"])]


def test_c1_one_strip_in_several_packets_counts_once(client, monkeypatch):
    cid = client.post("/api/cases").json()["case_id"]
    photo(client, monkeypatch, cid, [("Sergel MUPS", "20 mg", "")] * 3)          # three packets in one photo
    photo(client, monkeypatch, cid, [("Sergel MUPS", "20 mg", "")])              # and once more in another photo
    result = taking_now(client, cid)
    assert [m["brand"] for m in result["medicines"]] == ["Sergel MUPS"] and dups(result) == []


# ---------- Challenge 2: unknown brand or unreadable photo -> never a wrong duplicate ----------

@pytest.mark.parametrize("brand,ingredient_line", [("Sergel MUPS", "Esomeprazole USP"), ("Napa", "Paracetamol BP"),
                                                    ("Exium", "Esomeprazole Magnesium Trihydrate")])
def test_c2_the_ingredient_printed_on_a_strip_is_not_a_second_medicine(client, monkeypatch, brand, ingredient_line):
    # 24 Nov, real photo: one Sergel MUPS strip came back as 'Sergel MUPS' + 'Esomeprazole USP'; the second line was
    # matched to Esoral MUPS, another esomeprazole brand: one strip would have become a duplicate.
    cid = client.post("/api/cases").json()["case_id"]
    out = photo(client, monkeypatch, cid, [(brand, "", ""), (ingredient_line, "", "")])
    assert [i["chosen"]["brand"] for i in out["items"]] == [brand]
    assert dups(taking_now(client, cid)) == []


def test_c2_an_unreadable_photo_adds_nothing_and_says_so(client, monkeypatch):
    cid = client.post("/api/cases").json()["case_id"]
    assert photo(client, monkeypatch, cid, [])["items"] == []
    import json
    copy = json.load(open(os.path.join(g.ROOT, "config", "copy_bn.json"), encoding="utf-8"))["ui"]
    assert "ধরে নেওয়া হয়নি" in copy["err.no_items_photo"]


@pytest.mark.parametrize("unknown", ["Zyxolin 20", "Exiom 20", "Sergal 20"])
def test_c2_an_unknown_brand_is_asked_and_kept_out_of_every_duplicate(client, unknown):
    cid = client.post("/api/cases").json()["case_id"]
    client.post(f"/api/cases/{cid}/text", json={"text": "Exium 20"})
    new = client.post(f"/api/cases/{cid}/text", json={"text": unknown}).json()["items"][0]
    assert new["needs_confirm"] is True
    result = taking_now(client, cid)
    assert dups(result) == [] and result["unchecked"] == 1


def test_c2_an_unsure_strip_reading_never_makes_a_duplicate(client, monkeypatch):
    cid = client.post("/api/cases").json()["case_id"]
    client.post(f"/api/cases/{cid}/text", json={"text": "Napa 500"})
    out = photo(client, monkeypatch, cid, [("Aec 50O", "", "")])                  # a smudged 'Ace 500'
    assert out["items"] and all(i["needs_confirm"] for i in out["items"])
    result = taking_now(client, cid)
    assert dups(result) == [] and result["unchecked"] == 1


def test_c2_a_real_brand_named_after_an_ingredient_is_still_a_medicine(client, monkeypatch):
    # 'Calamine' is a registered lotion brand; Itchsol cream contains calamine. Both strips in one photo stay two.
    cid = client.post("/api/cases").json()["case_id"]
    out = photo(client, monkeypatch, cid, [("Itchsol", "", ""), ("Calamine", "", "")])
    assert sorted(i["chosen"]["brand"] for i in out["items"]) == ["Calamine", "Itchsol"]


# 24 Nov, real dermatologist prescription: the diagnosis 'T. corporis' (tinea corporis) was sometimes listed as a
# medicine ('T.' read as Tablet) and matched to a drug. A diagnosis is not a medicine.
def test_the_reader_is_told_a_diagnosis_is_not_a_medicine():
    from app.ai.perceive import PROMPT, SCHEMA
    assert "diagnosis" in PROMPT.lower() and "tinea" in PROMPT.lower()
    assert "diagnosis_text" in SCHEMA["properties"]


@pytest.mark.parametrize("line", ["T. corporis", "T. cruris c BA", "Tinea versicolor", "T.capitis", "Scabies", "Acne vulgaris"])
def test_c2_a_diagnosis_line_is_not_added_as_a_medicine(client, monkeypatch, line):
    cid = client.post("/api/cases").json()["case_id"]
    out = photo(client, monkeypatch, cid, [(line, "", ""), ("Des", "5 mg", "")], kind="prescription")
    assert [i["chosen"]["brand"] for i in out["items"]] == ["Des"]


# 24 Nov, on the phone: opening the camera while a prescription was being read dropped that connection; the server
# finished and saved it, but the phone never heard. Each upload carries an id, and the case says which are done.
def test_the_case_says_which_uploads_are_finished(client, monkeypatch):
    import app.ai.perceive as perceive
    from tests.test_api import fake_read
    from tests.test_robustness import jpg
    cid = client.post("/api/cases").json()["case_id"]
    monkeypatch.setattr(perceive, "read_image", fake_read([("Napa", "500 mg", ""), ("Ace", "500 mg", "")], kind="strip"))
    client.post(f"/api/cases/{cid}/images", files={"file": ("a.jpg", jpg(), "image/jpeg")}, data={"upload_id": "u-1"})
    monkeypatch.setattr(perceive, "read_image", fake_read([("Seclo", "20 mg", "")], kind="prescription", doctor="Dr Z"))
    client.post(f"/api/cases/{cid}/images", files={"file": ("b.jpg", jpg(), "image/jpeg")}, data={"upload_id": "u-2"})
    client.post(f"/api/cases/{cid}/images", files={"file": ("b.jpg", jpg(), "image/jpeg")}, data={"upload_id": "u-3"})
    case = client.get(f"/api/cases/{cid}").json()
    assert len(case["uploads"]["u-1"]["items"]) == 2 and len(case["uploads"]["u-2"]["items"]) == 1
    assert case["uploads"]["u-3"]["duplicate_of"] is not None            # the same prescription again


def test_an_upload_is_known_as_reading_while_it_is_read_and_failed_if_reading_fails(client, monkeypatch):
    # A phone that reloads (Android, after the camera) must see that a photo is still being read, and wait for it.
    import threading
    import app.ai.perceive as perceive
    from app.ai.gemini import GeminiError
    from tests.test_api import fake_read
    from tests.test_robustness import jpg
    cid = client.post("/api/cases").json()["case_id"]
    gate, seen = threading.Event(), {}
    slow = fake_read([("Napa", "500 mg", "")], kind="strip")

    def read(data):
        seen["during"] = client.get(f"/api/cases/{cid}").json()["uploads"]["u-slow"]["state"]
        gate.wait(5)
        return slow(data)
    monkeypatch.setattr(perceive, "read_image", read)
    gate.set()
    client.post(f"/api/cases/{cid}/images", files={"file": ("a.jpg", jpg(), "image/jpeg")}, data={"upload_id": "u-slow"})
    assert seen["during"] == "reading"
    assert client.get(f"/api/cases/{cid}").json()["uploads"]["u-slow"]["state"] == "done"

    def broken(data):
        raise GeminiError("model down")
    monkeypatch.setattr(perceive, "read_image", broken)
    client.post(f"/api/cases/{cid}/images", files={"file": ("b.jpg", jpg(), "image/jpeg")}, data={"upload_id": "u-bad"})
    assert client.get(f"/api/cases/{cid}").json()["uploads"]["u-bad"]["state"] == "failed"


def test_two_photos_of_one_prescription_sent_together_count_once(monkeypatch):
    # Both were read before either was saved, so the 'same prescription again?' check saw no earlier copy and both
    # counted: the rules then saw two doctors prescribing the same medicines (a false duplicate).
    import threading
    import app.ai.perceive as perceive
    from app.conversation import Engine
    from tests.test_api import fake_read
    from tests.test_robustness import jpg
    both_read = threading.Barrier(2, timeout=10)
    read = fake_read([("Seclo", "20 mg", "1+0+1"), ("Napa", "500 mg", "1+1+1")], kind="prescription", doctor="Dr Z", date="1/11/26")

    def together(data):
        out = read(data)
        both_read.wait()
        return out
    monkeypatch.setattr(perceive, "read_image", together)
    e = Engine()
    case = e.new_case()
    outs = []
    ts = [threading.Thread(target=lambda: outs.append(e.add_image(case, jpg()))) for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(o["duplicate_of"] is not None for o in outs) == [False, True]
    assert len(case.items) == 2 and len(case.docs) == 1
