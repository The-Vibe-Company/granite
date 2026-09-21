"""Contract tests for the ingestion proposal layer.

Run from this directory:  python3 -m unittest test_jev_ingest

`jev_ingest.py` proposes links deterministically and hands the selection to a judge, so the
things worth pinning are the boundaries: which mentions count, which do not, and whether a
proposal can ever point at the wrong note. A wrong link is silent and durable, so the tests
lean on the cases where a plausible implementation picks the wrong target.
"""
import sqlite3
import unittest

from jev_ingest import find_mentions, normalize_name, propose


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


if __name__ == "__main__":
    unittest.main()
