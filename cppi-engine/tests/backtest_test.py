import pytest

np = pytest.importorskip("numpy", reason="backtest group not installed (poetry install --with backtest)")
pytest.importorskip("pandas", reason="backtest group not installed (poetry install --with backtest)")
pytest.importorskip("matplotlib", reason="backtest group not installed (poetry install --with backtest)")

import pandas as pd

from backtest.run_backtest import calculate_risk_metrics, simulate
from strategy import cppi_strategy

# A daily XLM path with a rally (ratchet steps), a crash (floor), and a recovery
RISKY_RETURNS = np.array([0.05, 0.08, 0.10, -0.02, 0.12, 0.07, -0.15, -0.20, -0.05, 0.03, 0.25, -0.10, 0.04])
SAFE_RETURNS = np.full(len(RISKY_RETURNS), 0.0002)


def sol_script_loop(returns_risky, returns_safe, multiplier, floor, profit_lockin, initial_capital):
    """The loop of cushyon/backtesting dailybacktestoptim.py (cppi_strategy), unchanged"""
    nav = initial_capital
    floor_value = initial_capital * floor
    max_nav = nav
    nav_history = []
    for risky, safe in zip(returns_risky, returns_safe):
        if nav > max_nav:
            max_nav = nav
            ratchet_steps = int((max_nav - initial_capital) / (initial_capital * profit_lockin))
            new_floor = initial_capital * (floor + ratchet_steps * profit_lockin)
            if new_floor > floor_value:
                floor_value = new_floor
        cushion = nav - floor_value
        risky_target = max(min(cushion * multiplier, nav), 0)
        safe_target = nav - risky_target
        nav = risky_target * (1 + risky) + safe_target * (1 + safe)
        nav_history.append(nav)
    return nav_history


def test_vectorized_grid_matches_the_sol_script_loop():
    """Every parameter set of the vectorized run gives the NAV path of the original loop"""
    sets = [(3.0, 0.6, 0.01), (8.0, 0.6, 0.16), (8.5, 0.69, 0.13), (5.5, 0.89, 0.19)]
    multipliers = [s[0] for s in sets]
    floors = [s[1] for s in sets]
    lockins = [s[2] for s in sets]

    history = simulate(RISKY_RETURNS, SAFE_RETURNS, multipliers, floors, lockins, 0.1148, record=True)["history"]

    for i, (multiplier, floor, lockin) in enumerate(sets):
        expected = sol_script_loop(RISKY_RETURNS, SAFE_RETURNS, multiplier, floor, lockin, 0.1148)
        assert history["nav"][:, i] == pytest.approx(expected, rel=1e-12)


def test_backtest_matches_the_production_strategy():
    """The backtest tests the shipped logic: strategy.py (test params 0.6 / 8 / 0.19) gives the same NAV path"""
    initial_capital = 1000.0
    price_risky = 0.30
    quantity_risky = 0.0
    quantity_safe = initial_capital  # USDC at 1.0, no yield
    nav = initial_capital
    max_nav = initial_capital
    production_navs = []

    for r in RISKY_RETURNS:
        quantity_risky, quantity_safe, nav, max_nav, *_ = cppi_strategy(
            price_risky, 1.0, nav, max_nav, quantity_risky, quantity_safe, initial_capital
        )
        price_risky = price_risky * (1 + r)
        production_navs.append(quantity_risky * price_risky + quantity_safe)
        nav = production_navs[-1]

    history = simulate(RISKY_RETURNS, np.zeros(len(RISKY_RETURNS)), [8.0], [0.6], [0.19], initial_capital, record=True)["history"]

    assert history["nav"][:, 0] == pytest.approx(production_navs, rel=1e-12)


def test_floor_breach_is_recorded_at_rebalance():
    """A crash larger than 1 / multiplier pushes the NAV under the floor before the next rebalance"""
    risky = np.array([-0.30, 0.0])
    safe = np.zeros(2)

    run = simulate(risky, safe, [8.0], [0.6], [0.19], 100.0, record=True)
    history = run["history"]

    # Day 1: all in XLM (cushion 40 x 8 > 100), NAV falls to 70, above the floor of 60
    assert history["nav"][0, 0] == pytest.approx(70.0)
    assert not (history["nav_at_rebalance"][1, 0] < history["floor_at_rebalance"][1, 0])
    assert run["breach_events"][0] == 0
    assert run["days_below_floor"][0] == 0

    run = simulate(np.array([-0.45, 0.0]), safe, [8.0], [0.6], [0.19], 100.0, record=True)
    history = run["history"]

    # A 45% gap: NAV 55 is under the floor of 60 at the next rebalance
    assert history["nav_at_rebalance"][1, 0] < history["floor_at_rebalance"][1, 0]
    assert run["breach_events"][0] == 1
    assert run["days_below_floor"][0] == 1


def test_cash_lock_counts_one_breach_event():
    """After a gap under the floor, the NAV stays in the safe asset: one event, many days below the floor"""
    risky = np.array([-0.45, 0.10, 0.10, 0.10])
    safe = np.zeros(4)

    run = simulate(risky, safe, [8.0], [0.6], [0.19], 100.0)

    assert run["breach_events"][0] == 1
    assert run["days_below_floor"][0] == 3
    assert run["final_nav"][0] == pytest.approx(55.0)


def test_running_sharpe_and_sortino_match_pandas():
    """The running sums give the same ratios as calculate_risk_metrics on the NAV series"""
    sets = [(3.0, 0.6, 0.01), (8.0, 0.6, 0.16), (8.5, 0.69, 0.13)]
    run = simulate(
        RISKY_RETURNS, SAFE_RETURNS,
        [s[0] for s in sets], [s[1] for s in sets], [s[2] for s in sets], 100.0, record=True
    )

    for i in range(len(sets)):
        expected = calculate_risk_metrics(pd.Series(run["history"]["nav"][:, i]).pct_change().dropna())
        assert run["sharpe"][i] == pytest.approx(expected["Sharpe"], rel=1e-9)
        assert run["sortino"][i] == pytest.approx(expected["Sortino"], rel=1e-9)
