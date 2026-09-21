"""Contract tests for the sentence-citation parser in `jev_answer.py`.

Run from this directory:  python3 -m unittest test_jev_answer

The parser decides which sentence a judge cited as evidence. Getting it wrong is not a
crash: it silently attributes a real quote to the wrong thing, so the boundary cases below
are the ones worth pinning.
"""
import unittest

from jev_answer import evidence_sentence


class EvidenceSentenceTest(unittest.TestCase):
    SENTENCES = ["first sentence", "second sentence", "third sentence"]

    def test_resolves_a_valid_index(self):
        self.assertEqual(evidence_sentence("s0", self.SENTENCES), "first sentence")
        self.assertEqual(evidence_sentence("s2", self.SENTENCES), "third sentence")

    def test_none_means_no_evidence(self):
        self.assertIsNone(evidence_sentence("none", self.SENTENCES))

    def test_out_of_range_is_no_evidence_rather_than_the_last_sentence(self):
        # The regression this pins: a loose parse mapped "s-1" onto the final sentence,
        # presenting a genuine quote the model never cited.
        self.assertIsNone(evidence_sentence("s-1", self.SENTENCES))
        self.assertIsNone(evidence_sentence("s99", self.SENTENCES))

    def test_non_index_shapes_are_no_evidence(self):
        for picked in ("sentence2", "s", "s1x", "", "0", None, 3, ["s0"], {"choice": "s0"}):
            with self.subTest(picked=picked):
                self.assertIsNone(evidence_sentence(picked, self.SENTENCES))

    def test_an_empty_sentence_list_never_resolves(self):
        self.assertIsNone(evidence_sentence("s0", []))


if __name__ == "__main__":
    unittest.main()
