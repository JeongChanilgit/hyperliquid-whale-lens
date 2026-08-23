import json
import tempfile
import unittest
from pathlib import Path

from render_simple_twr_top10_dossier import render_dossier_html, validate_dossier


class Top10DossierHtmlTests(unittest.TestCase):
    def dossier(self):
        wallets = []
        for rank in range(1, 11):
            wallets.append(
                {
                    "rank": rank,
                    "wallet": "0x" + f"{rank:040x}",
                    "source_score": rank / 10,
                    "source_diagnostics": {},
                    "headline": {},
                    "current": {"status": "COMPLETE", "account_value_usd": 10000 + rank, "gross_exposure_usd": 2000, "net_exposure_usd": 1000, "effective_leverage": 0.2},
                    "performance": {"status": "COMPLETE", "completed_episode_count": rank, "win_rate": 0.5, "net_pnl_usd": 100},
                    "activity": {"status": "COMPLETE", "coverage": {"status": "COMPLETE"}, "perpetual_fill_count": rank * 2, "fill_volume_usd": 2000, "activity_day_count": 2, "coin_concentration": [{"coin": "BTC", "volume_share": 1}]},
                    "positions": {"position_count": 1, "items": [{"coin": "BTC", "side": "LONG", "notional_usd": 2000}]},
                    "orders": {"orders": []},
                    "cashflows": {"status": "COMPLETE", "coverage": {"status": "COMPLETE"}, "cash_flow_event_count": 0, "net_cash_flow_usd": 0, "type_summary": []},
                    "portfolio_series": {"status": "COMPLETE", "max_drawdown_fraction": 0.1, "aligned_series": [{"time_ms": 1, "account_value_usd": 10000, "pnl_usd": 0}, {"time_ms": 2, "account_value_usd": 10100, "pnl_usd": 100}]},
                    "recent_fills": [],
                    "recent_episodes": [],
                    "strategy_inference": {"copyability": {"assessment": "MORE_OBSERVABLE"}, "strategy_style": {}},
                    "risk_flags": [],
                    "data_quality": [],
                }
            )
        return {"generated_at_ms": 1, "evidence_window": {"start_ms": 1, "end_ms": 2}, "coverage": {"status": "COMPLETE"}, "cashflow_neutral_verified": False, "wallets": wallets}

    def test_renders_one_offline_html_with_all_wallets(self):
        dossier = self.dossier()
        html = render_dossier_html(dossier)
        self.assertIn("단순 TWR TOP10", html)
        self.assertIn("PORTFOLIO_ONLY_ESTIMATE", html)
        self.assertIn("cashflow_neutral_verified=false", html)
        for row in dossier["wallets"]:
            self.assertIn(row["wallet"], html)
        self.assertNotIn("https://", html)
        self.assertNotIn("NaN", html)
        self.assertNotIn("Infinity", html)
        self.assertIn('id="riskChart"', html)
        self.assertIn("포지션·주문", html)

    def test_rejects_wrong_subject_count_and_nonfinite(self):
        dossier = self.dossier()
        dossier["wallets"].pop()
        with self.assertRaises(ValueError):
            validate_dossier(dossier)
        dossier = self.dossier()
        dossier["wallets"][0]["source_score"] = float("nan")
        with self.assertRaises(ValueError):
            validate_dossier(dossier)


if __name__ == "__main__":
    unittest.main()
