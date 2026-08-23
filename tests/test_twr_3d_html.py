from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from render_simple_twr_3d import _count_records, render_html


class TWR3DHtmlTests(unittest.TestCase):
    def test_count_rows_accept_wallet_records(self):
        rows = _count_records({"wallets": [{"wallet": "0xAbC", "status": "COMPLETE"}]})
        self.assertEqual(rows["0xabc"]["status"], "COMPLETE")

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
        self.assertIn("300%+ 계좌 3D 성과 지도", html)
        self.assertIn("pointermove", html)
        self.assertIn("wheel", html)
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
