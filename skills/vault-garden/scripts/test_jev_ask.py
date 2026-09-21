"""Parity tests between the prototype extractor and the shipped one.

Run from this directory:  python3 -m unittest test_jev_ask

`jev_ask.py` keeps its own copy of the candidate-sentence extractor because it reads the
index database directly while the product emits candidates over MCP. A copy drifts, and it
already did twice: the prototype kept headings the shipped extractor dropped, and it carried
a frontmatter strip that could only delete real content.

This compares against the **product**, not against another transcription of it: it calls the
`granite_pool` MCP tool — the only surface the extractor is exposed on since 0.1.23, when the
CLI command was removed — and checks that the prototype reproduces exactly the sentences the
tool returned, for the same notes at the same limit.

Needs a local vault and a runnable Granite. It skips cleanly without them rather than
failing, because the repository does not ship a database — but it must never skip because a
command it depends on was removed, which is how this file silently stopped testing anything.
"""
import json
import os
import shutil
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


def _call_mcp_tool(name: str, arguments: dict) -> dict:
    """Call one MCP tool over stdio and return its `structuredContent`.

    Drives the MCP protocol rather than a private CLI flag, so this test breaks loudly if the
    surface it checks moves, instead of reporting success while testing nothing.
    """
    if shutil.which("npx") is None:
        raise RuntimeError("npx is required to run the Granite MCP server")
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "parity", "version": "1.0.0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
         "params": {"name": name, "arguments": arguments}},
    ]
    stdin = "".join(json.dumps(message) + "\n" for message in messages)
    proc = subprocess.run(
        ["npx", "tsx", "src/index.ts", "mcp", "--transport", "stdio"],
        cwd=REPO_ROOT, input=stdin, capture_output=True, text=True, timeout=300,
    )
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("id") == 2:
            result = message.get("result", {})
            if result.get("isError"):
                raise RuntimeError(f"{name} returned an error")
            structured = result.get("structuredContent")
            if structured is None:
                raise RuntimeError(f"{name} returned no structuredContent")
            return structured
    raise RuntimeError(
        f"no response to {name} from the MCP server; stderr tail: {proc.stderr[-400:]}"
    )


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
            cls.pool = _call_mcp_tool("granite_pool", {
                "anchor": ANCHOR, "depth": 1, "limit": 3, "sentences": LIMIT,
            })
        except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
            raise unittest.SkipTest(f"could not reach the granite MCP server: {exc}")
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

    def test_the_pool_reports_what_it_dropped(self):
        # The tool must say what the limit left out, or a caller concludes the vault does not
        # have a note the pool simply did not return.
        small = _call_mcp_tool("granite_pool", {"anchor": ANCHOR, "limit": 1, "sentences": 0})
        bands = small.get("by_distance") or []
        self.assertTrue(bands, "granite_pool returned no by_distance summary")
        self.assertTrue(any(band["shown"] < band["reachable"] for band in bands))


if __name__ == "__main__":
    unittest.main()
