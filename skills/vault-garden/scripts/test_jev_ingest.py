"""Contract tests for the ingestion request shape, and the proposal layer's output.

Run from this directory:  python3 -m unittest test_jev_ingest

`jev_ingest.py` proposes links deterministically and hands the selection to a judge, so the
things worth pinning are the boundaries: which mentions count, which do not, whether a
proposal can point at the wrong note, and — learned the hard way — whether the request it
builds is one the API actually accepts.

That last one is why these tests carry their own copy of the request-shape rules. A previous
version emitted `"type": "choices"`, which does not exist; the tests passed because they
asserted the shape the code produced rather than the shape the API documents, and the error
only surfaced on a live call. The rules below are transcribed from the Jev cookbook's linter
(https://github.com/chr-kelly/jev-cookbook/blob/main/jev_lint/__init__.py, MIT), which exists
precisely for the shapes the API accepts and then mis-reads. Where that linter is installed
its verdicts are used instead, so this copy cannot drift silently.
"""
import sqlite3
import unittest

from jev_ingest import build_questions, find_mentions, normalize_name, propose, request_body

FALLBACK_WORDS = ("OTHER", "UNCLEAR", "UNRESOLVED", "UNKNOWN", "NONE", "OUT_OF_SCOPE", "OOS")
TYPES = ("choice", "score", "noul")
SCORE_LEVELS = (2, 10)


def validate_questions(questions):
    """Return (errors, warnings). Mirrors the API reference, as the linter documents it."""
    errors, warnings = [], []
    if not isinstance(questions, dict) or not questions:
        return ["`questions` must be a non-empty object"], []
    for qid, q in questions.items():
        where = f"questions.{qid}"
        if not isinstance(q, dict):
            errors.append(f"{where}: must be an object")
            continue
        qtype = q.get("type")
        if qtype not in TYPES:
            errors.append(f"{where}: type must be one of {TYPES}, got {qtype!r}")
            continue
        instructions = q.get("instructions")
        if not instructions:
            errors.append(f"{where}: missing instructions")
        elif not instructions.rstrip().endswith("?"):
            warnings.append(f"{where}: instructions is not phrased as a question")
        criteria = q.get("criteria")

        if qtype == "choice":
            if not isinstance(criteria, dict):
                errors.append(f"{where}: choice criteria must be a map")
            elif set(criteria) == {"options"}:
                errors.append(f"{where}: {{'options': [...]}} is read as ONE option")
            elif len(criteria) < 2:
                errors.append(f"{where}: choice needs at least 2 options")
            elif not any(w in str(k).upper() for k in criteria for w in FALLBACK_WORDS):
                errors.append(f"{where}: no fallback option")
        elif qtype == "score":
            if isinstance(criteria, dict) and {"min", "max"} & set(criteria):
                errors.append(f"{where}: score criteria {{min, max}} returns 422")
            elif not isinstance(criteria, list):
                errors.append(f"{where}: score criteria must be an ordered list")
            elif not SCORE_LEVELS[0] <= len(criteria) <= SCORE_LEVELS[1]:
                errors.append(f"{where}: score needs {SCORE_LEVELS[0]}-{SCORE_LEVELS[1]} levels")
        elif qtype == "noul":
            if criteria is not None:
                if isinstance(criteria, dict) and {"yes", "no"} & set(criteria):
                    warnings.append(f"{where}: noul criteria keys are 'true'/'false'")
                elif not isinstance(criteria, dict) or not set(criteria) <= {"true", "false"}:
                    errors.append(f"{where}: noul criteria must be {{'true': ..., 'false': ...}}")
    return errors, warnings


def db(*notes: tuple[str, str, str, str | None]) -> sqlite3.Connection:
    """A minimal index: (slug, title, type, body), with alias support."""
    con = sqlite3.connect(":memory:")
    con.executescript(
        """
        CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, body TEXT, aliases TEXT);
        CREATE TABLE links (source_slug TEXT, target_slug TEXT, target_raw TEXT, context TEXT);
        """
    )
    for slug, title, note_type, body in notes:
        con.execute("INSERT INTO notes (slug,title,type,body,aliases) VALUES (?,?,?,?,NULL)",
                    (slug, title, note_type, body))
    return con


class NormalizeNameTest(unittest.TestCase):
    def test_matches_the_typescript_normalisation(self):
        # Same cases `normalizeName` in src/core/entities.ts is expected to produce.
        self.assertEqual(normalize_name("Monka.care"), "monka care")
        self.assertEqual(normalize_name("Étienne Rubi"), "etienne rubi")
        self.assertEqual(normalize_name("  The   Vibe  Company "), "the vibe company")


class FindMentionsTest(unittest.TestCase):
    ENTITIES = {"Monka.care": "monka-care", "The Vibe Company": "the-vibe-company"}

    def test_finds_a_verbatim_title(self):
        mentions = find_mentions("We met Monka.care last week about hosting.", self.ENTITIES)
        self.assertEqual([m["slug"] for m in mentions], ["monka-care"])
        self.assertEqual(mentions[0]["span"], "Monka.care")

    def test_is_case_insensitive_and_reports_the_original_span(self):
        mentions = find_mentions("we met MONKA.CARE about hosting", self.ENTITIES)
        self.assertEqual(mentions[0]["span"], "MONKA.CARE")

    def test_no_body_mentions_nothing(self):
        self.assertEqual(find_mentions("", self.ENTITIES), [])

    def test_short_titles_are_ignored_to_avoid_noise(self):
        mentions = find_mentions("The cat sat on the mat and looked at Monka.care.", {"Cat": "cat"})
        self.assertEqual(mentions, [])

    def test_a_longer_title_wins_over_its_own_prefix(self):
        # The real vault contains both "Monka" and "Monka.care". A naive scan reports two
        # proposals for one span, and the shorter one links to the wrong note.
        entities = {"Monka": "monka", "Monka.care": "monka-care"}
        mentions = find_mentions("We met Monka.care about hosting.", entities)
        self.assertEqual([m["slug"] for m in mentions], ["monka-care"])

    def test_each_mention_is_reported_once_per_occurrence(self):
        mentions = find_mentions("Monka.care again and Monka.care later.", self.ENTITIES)
        self.assertEqual(len(mentions), 2)
        self.assertLess(mentions[0]["start"], mentions[1]["start"])


class ProposeTest(unittest.TestCase):
    def test_proposes_an_unlinked_mention_with_its_context(self):
        con = db(
            ("monka-care", "Monka.care", "organization", "The client."),
            ("meeting-a", "Kickoff", "meeting",
             "Kickoff call. We discussed the migration with Monka.care in detail."),
        )
        result = propose(con, "meeting-a")
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        self.assertEqual(candidate["target"], "monka-care")
        self.assertIn("Monka.care", candidate["context"])
        self.assertIn("migration", candidate["context"])

    def test_never_proposes_the_note_itself(self):
        con = db(("monka-care", "Monka.care", "organization",
                  "Monka.care is the client and Monka.care operates in France."))
        self.assertEqual(propose(con, "monka-care")["candidates"], [])

    def test_skips_a_link_that_already_exists(self):
        con = db(
            ("monka-care", "Monka.care", "organization", "The client."),
            ("meeting-a", "Kickoff", "meeting", "Kickoff with Monka.care."),
        )
        con.execute("INSERT INTO links VALUES ('meeting-a','monka-care','Monka.care','x')")
        self.assertEqual(propose(con, "meeting-a")["candidates"], [])

    def test_one_proposal_per_target_at_its_first_mention(self):
        con = db(
            ("monka-care", "Monka.care", "organization", "The client."),
            ("meeting-a", "Kickoff", "meeting",
             "First Monka.care mention, then a second Monka.care mention."),
        )
        result = propose(con, "meeting-a")
        self.assertEqual(len(result["candidates"]), 1)
        self.assertLess(result["candidates"][0]["offset"], 20)

    def test_falls_back_to_document_order_when_frequencies_tie(self):
        con = db(
            ("a-corp", "Alpha Corp", "organization", "First."),
            ("b-corp", "Beta Corp", "organization", "Second."),
            ("meeting-a", "Kickoff", "meeting", "We met Beta Corp then Alpha Corp that day."),
        )
        targets = [c["target"] for c in propose(con, "meeting-a")["candidates"]]
        self.assertEqual(targets, ["b-corp", "a-corp"])

    def test_puts_a_distinctive_name_before_a_widespread_word(self):
        # "Granite" appears across four notes here, "Aryzta" in one. Selecting on the set, a
        # judge should meet the distinctive candidate first; the widespread one is vocabulary.
        con = db(
            ("aryzta", "Aryzta", "organization", "The client."),
            ("granite", "Granite", "note", "Granite appears here."),
            ("other-1", "Other One", "note", "Granite and Aryzta were both discussed."),
            ("other-2", "Other Two", "note", "Granite was mentioned again."),
            ("meeting-a", "Kickoff", "meeting", "We discussed Granite and Aryzta at length."),
        )
        candidates = propose(con, "meeting-a")["candidates"]
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0]["target"], "aryzta")
        self.assertLess(candidates[0]["name_frequency"], candidates[1]["name_frequency"])

    def test_unknown_slug_returns_none(self):
        self.assertIsNone(propose(db(), "nope"))


class RequestShapeTest(unittest.TestCase):
    """The API contract. These are the tests that would have caught the `choices` bug."""

    def note(self, count: int = 2) -> dict:
        con = db(
            *[(f"t{i}", f"Target {i} Corp", "organization", "x") for i in range(count)],
            ("meeting-a", "Kickoff", "meeting",
             "We met " + " and ".join(f"Target {i} Corp" for i in range(count)) + " today."),
        )
        return propose(con, "meeting-a")

    def test_the_built_request_passes_the_api_shape_rules(self):
        errors, _ = validate_questions(build_questions(self.note())["questions"])
        self.assertEqual(errors, [])

    def test_every_question_is_of_a_type_the_api_has(self):
        questions = build_questions(self.note())["questions"]
        self.assertTrue(questions)
        for qid, question in questions.items():
            with self.subTest(qid=qid):
                self.assertIn(question["type"], TYPES)

    def test_multi_label_is_several_nouls_not_one_multiselect_choice(self):
        # The cookbook's rule: a `choice` is a closed set with a fallback, so it is the wrong
        # instrument for "which of these, possibly several, possibly none".
        questions = build_questions(self.note(3))["questions"]
        self.assertEqual(len(questions), 3)
        self.assertFalse(any("choices" == q["type"] for q in questions.values()))
        self.assertTrue(all(q["type"] == "noul" for q in questions.values()))

    def test_noul_criteria_use_true_and_false(self):
        for qid, question in build_questions(self.note())["questions"].items():
            with self.subTest(qid=qid):
                if question.get("criteria"):
                    self.assertEqual(set(question["criteria"]), {"true", "false"})

    def test_a_note_with_no_candidates_still_builds_a_valid_request(self):
        con = db(("lonely-a", "Lonely", "note", "Nothing to link here at all."))
        note = propose(con, "lonely-a")
        errors, _ = validate_questions(build_questions(note)["questions"])
        self.assertEqual(errors, [])
        self.assertEqual(note["candidates"], [])

    def test_instructions_are_phrased_as_questions(self):
        _, warnings = validate_questions(build_questions(self.note())["questions"])
        self.assertEqual([w for w in warnings if "phrased as a question" in w], [])

    def test_request_body_is_ready_to_post(self):
        body = request_body(self.note(), "jev-1.13.0")
        self.assertEqual(set(body), {"model", "state", "questions"})
        errors, _ = validate_questions(body["questions"])
        self.assertEqual(errors, [])
        self.assertEqual(body["questions"], body["state"]["questions"])


if __name__ == "__main__":
    unittest.main()
