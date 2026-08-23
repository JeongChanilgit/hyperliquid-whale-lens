from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from render_simple_twr_3d import _count_records, apply_presentation_filter, render_html


class TWR3DHtmlTests(unittest.TestCase):
    def test_count_rows_accept_wallet_records(self):
        rows = _count_records({"wallets": [{"wallet": "0xAbC", "status": "COMPLETE"}]})
        self.assertEqual(rows["0xabc"]["status"], "COMPLETE")

    def test_excludes_rank_one_and_preserves_remaining_source_ranks(self):
        dataset = {
            "record_count": 3,
            "plot_record_count": 3,
            "records": [
                {"rank": 1, "wallet": "0x1", "return_pct": 9000, "plot_eligible": True},
                {"rank": 2, "wallet": "0x2", "return_pct": 900, "plot_eligible": True},
                {"rank": 3, "wallet": "0x3", "return_pct": 700, "plot_eligible": True},
            ],
        }

        filtered = apply_presentation_filter(dataset, [1])

        self.assertEqual([row["rank"] for row in filtered["records"]], [2, 3])
        self.assertEqual(filtered["record_count"], 2)
        self.assertEqual(filtered["presentation_filter"]["excluded_wallets"], ["0x1"])
        self.assertTrue(filtered["presentation_filter"]["axis_domains_recomputed_from_visible_records"])

    def test_renders_offline_interactive_scene(self):
        dataset = {
            "source": {"window_end_ms": 200},
            "records": [
                {
                    "wallet": "0xabc",
                    "rank": 1,
                    "return_pct": 400,
                    "mdd_pct": 25,
                    "trade_count_raw": 10,
                    "trade_count_plot_log10": 1,
                    "raw_perpetual_fill_count_30d": 20,
                    "latest_account_value_usd": 10000,
                }
            ],
        }
        html = render_html(dataset)
        self.assertIn("1위 제외 · 300%+ 계좌 3D 성과 지도", html)
        self.assertIn("pointermove", html)
        self.assertIn("wheel", html)
        self.assertIn("xd=extent(xs),yd=extent(ys),zd=extent(zs)", html)
        self.assertNotIn("https://", html)
        self.assertNotIn("<script src=", html)
        embedded = html.split('<script id="data" type="application/json">', 1)[1].split("</script>", 1)[0]
        self.assertEqual(json.loads(embedded)["records"][0]["trade_count_raw"], 10)
        executable = html.rsplit("<script>", 1)[1].split("</script>", 1)[0]
        node = shutil.which("node")
        if node:
            with tempfile.TemporaryDirectory() as directory:
                script_path = Path(directory) / "scene.js"
                script_path.write_text(executable, encoding="utf-8")
                checked = subprocess.run(
                    [node, "--check", str(script_path)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
            self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == "__main__":
    unittest.main()
