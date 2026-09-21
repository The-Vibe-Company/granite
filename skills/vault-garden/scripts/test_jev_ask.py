"""Parity tests between the prototype extractor and the shipped one.

Run from this directory:  python3 -m unittest test_jev_ask

`jev_ask.py` keeps its own copy of the candidate-sentence extractor because it reads the
index database directly while the product emits candidates to JSON. A copy drifts, and it
already did: the prototype kept headings the shipped extractor dropped, and it carried a
frontmatter strip that could only delete real content, so the candidate set it judged was
not the set the product produces.

This compares against the **product**, not against another transcription of it: it runs
the `granite_pool` tool returns and checks that the prototype's extractor reproduces exactly the
sentences the CLI emitted, for the same notes at the same limit. If the shipped extractor
changes and the copy does not, this fails.

Needs a local vault and a runnable CLI; it skips cleanly without them rather than failing,
because the repository does not ship a database.
"""
import json
import os
import sqlite3
import subprocess
import unittest
from pathlib import Path

from jev_ask import sentences

REPO_ROOT = Path(__file__).resolve().parents[3]
ANCHOR = os.environ.get("GRANITE_TEST_ANCHOR", "monka-care")
LIMIT = 6


def _vault_db() -> Path | None:
    root = Path(os.environ.get("GRANITE_VAULT", Path.home() / ".granite"))
    for candidate in (root / ".granite" / "index.db", root / "index.db"):
        if candidate.exists():
            return candidate
    return None


class ExtractorParityTest(unittest.TestCase):
    db: Path
    pool: dict

    @classmethod
    def setUpClass(cls):
        db = _vault_db()
        if db is None:
            raise unittest.SkipTest("no local Granite vault index; parity needs real notes")
        cls.db = db
        try:
            proc = subprocess.run(
                ["npx", "tsx", "src/index.ts", "pool", ANCHOR,
                 "--depth", "1", "--limit", "3", "--sentences", str(LIMIT), "--json"],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=300, check=True,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise unittest.SkipTest(f"could not run the granite CLI: {exc}")
        payload = json.loads(proc.stdout)
        if not payload.get("success"):
            raise unittest.SkipTest(f"pool command did not succeed: {payload.get('error')}")
        cls.pool = payload["data"]
        if not cls.pool.get("candidates"):
            raise unittest.SkipTest("anchor has no candidates in this vault")

    def body_for(self, slug: str) -> str | None:
        con = sqlite3.connect(self.db)
        try:
            row = con.execute("SELECT body FROM notes WHERE slug = ?", (slug,)).fetchone()
        finally:
            con.close()
        return row[0] if row else None

    def test_reproduces_the_shipped_sentences(self):
        checked = 0
        for candidate in self.pool["candidates"]:
            body = self.body_for(candidate["slug"])
            if body is None:
                continue
            with self.subTest(slug=candidate["slug"]):
                self.assertEqual(sentences(body, LIMIT), candidate["sentences"])
            checked += 1
        self.assertGreater(checked, 0, "compared nothing; the fixture is not exercising parity")

    def test_no_frontmatter_strip_is_needed_because_the_index_is_already_clean(self):
        # The prototype reads the index `body` column, which is post-frontmatter, so a
        # frontmatter strip can only ever fire on a legitimate horizontal rule and delete
        # the content between the rules. Assert the premise on the real data.
        con = sqlite3.connect(self.db)
        try:
            total = con.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
            delimiter_start = con.execute(
                "SELECT COUNT(*) FROM notes WHERE substr(body,1,4) = ?", ("---\n",)
            ).fetchone()[0]
        finally:
            con.close()
        self.assertGreater(total, 0)
        self.assertEqual(delimiter_start, 0)

    def test_a_body_opening_with_a_horizontal_rule_loses_nothing(self):
        body = "\n".join([
            "---",
            "This paragraph sits between two horizontal rules and is real note content.",
            "---",
            "Monka migre son infrastructure vers Scaleway en juin 2026.",
        ])
        out = sentences(body, LIMIT)
        self.assertTrue(any("real note content" in s for s in out))


if __name__ == "__main__":
    unittest.main()
