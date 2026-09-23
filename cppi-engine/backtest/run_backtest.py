"""CPPI backtest with ratchet steps on XLM.

Same method as the 2025 SOL backtest (cushyon/backtesting, dailybacktestoptim.py):
- Daily rebalance at one hour of the day (0-23 UTC). One run for each hour.
- Risky asset: XLM (Binance XLMUSDT, 15-minute open prices). Safe asset: USD with a fixed yearly yield.
- CPPI with ratchet steps, the same rules as cppi-engine/strategy.py. No fees, no slippage.
- Grid search over multiplier x floor x profit lock-in.
- Score of a parameter set = number of hours where the CPPI NAV ends above the safe asset.
- Best parameters = highest score. In a tie, the first set in grid order wins (as in the SOL script).

Changes from the SOL script:
1. No drop_duplicates on prices (it removed every candle whose price was already seen).
2. The safe asset grows with elapsed time, not with the row number.
3. Sharpe and Sortino use 365 days a year (crypto trades every day). The SOL script used 252.
4. The grid runs vectorized (all parameter sets at the same time), in seconds.
5. The 3D chart uses the score array (the SOL script indexed a list like a dict and crashed).
6. New outputs: ties at the best score, a second ranking of the tied sets, floor breach events,
   days below the floor, max drawdown, XLM buy and hold, and the Solana parameter sets for comparison.

Run from cppi-engine/: poetry run python backtest/run_backtest.py
"""

import json
from itertools import product
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.backends.backend_pdf import PdfPages

DATA = Path(__file__).parent / "data" / "xlmusdt_15m.csv"
RESULTS = Path(__file__).parent / "results"

SAFE_YIELDS = [0.0, 0.06]  # 0% = idle USDC in the vault, 6% = the SOL backtest value
DAYS_PER_YEAR = 365

# Same grid as the SOL backtest
MULTIPLIERS = [round(x, 2) for x in np.arange(3, 9, 0.5)]  # 12 values, 3 to 8.5
FLOORS = [round(x, 2) for x in np.arange(0.6, 0.9, 0.01)]  # 31 values, 0.60 to 0.90 (float rounding adds 0.90)
PROFIT_LOCKINS = [round(x, 2) for x in np.arange(0.01, 0.2, 0.01)]  # 19 values, 0.01 to 0.19

COMPARISON_HOURS = [3, 15, 16]  # 3 and 15 as in the SOL script, 16 = hour of the live Solana cron

# Parameter sets of the Solana strategy, shown for comparison
REFERENCE_SETS = {
    "legacy_code_2025_04": (8.0, 0.6, 0.19),  # python_backend executionfile.py, first version
    "sol_backtest_2025_04": (8.0, 0.6, 0.16),  # cppi_backtest_results_optim.pdf
    "sol_backtest_2025_05": (8.5, 0.69, 0.13),  # cppi_backtest_results_optim_2023.pdf
}
TOP_TIED = 5  # tied sets to list in the second ranking


# 1. Prices
def load_prices(safe_yield):
    df = pd.read_csv(DATA, parse_dates=["open_time"]).set_index("open_time")
    prices = df.rename(columns={"open": "Risky"})[["Risky"]]
    years = (prices.index - prices.index[0]).total_seconds() / (DAYS_PER_YEAR * 24 * 3600)
    prices["Safe"] = prices["Risky"].iloc[0] * (1 + safe_yield) ** np.asarray(years)
    return prices


def rebalance_prices(prices, hour):
    schedule = pd.date_range(
        start=prices.index.min().ceil("D") + pd.Timedelta(hours=hour),
        end=prices.index.max(),
        freq="24h",
    )
    # Last known price at each rebalance time (covers a missing candle)
    return prices.reindex(schedule, method="ffill").dropna()


# 2. Core CPPI (vectorized over parameter sets)
def simulate(returns_risky, returns_safe, multiplier, floor, profit_lockin, initial_capital, record=False):
    """
    Run the daily CPPI with ratchet steps for many parameter sets at the same time.

    Parameters:
    - returns_risky, returns_safe: daily returns between rebalances, shape (days,)
    - multiplier, floor, profit_lockin: parameter arrays, shape (sets,)
    - initial_capital: NAV at the start
    - record: if True, also return the NAV and floor history

    Returns a dict:
    - first_nav: nav after the first day, shape (sets,)
    - final_nav: nav after the last day, shape (sets,)
    - sharpe, sortino: same definition as calculate_risk_metrics on the daily NAV series, shape (sets,)
    - breach_events: rebalances where the NAV is under the floor and was not at the previous rebalance, shape (sets,)
    - days_below_floor: rebalances where the NAV is under the floor (a CPPI with no cushion stays in the safe asset), shape (sets,)
    - history (only if record): nav after each day, nav and floor at each rebalance, shape (days, sets)
    """
    multiplier = np.asarray(multiplier, dtype=float)
    floor = np.asarray(floor, dtype=float)
    profit_lockin = np.asarray(profit_lockin, dtype=float)

    nav = np.full(multiplier.shape, float(initial_capital))
    max_nav = nav.copy()
    floor_value = initial_capital * floor
    first_nav = None
    history = {"nav": [], "nav_at_rebalance": [], "floor_at_rebalance": []} if record else None

    # Running sums for Sharpe and Sortino. As in the SOL script, the NAV series starts after
    # the first day, so the first return used is day 2 / day 1.
    zeros = np.zeros(multiplier.shape)
    sum_r, sum_r2, count = zeros.copy(), zeros.copy(), 0
    sum_down, sum_down2, count_down = zeros.copy(), zeros.copy(), zeros.copy()
    days_below_floor = np.zeros(multiplier.shape, dtype=int)
    breach_events = np.zeros(multiplier.shape, dtype=int)
    was_below = np.zeros(multiplier.shape, dtype=bool)

    for day, (r_risky, r_safe) in enumerate(zip(returns_risky, returns_safe)):
        # Ratchet: a new NAV high can raise the floor by whole profit lock-in steps
        up = nav > max_nav
        max_nav = np.where(up, nav, max_nav)
        ratchet_steps = np.floor((max_nav - initial_capital) / (initial_capital * profit_lockin))
        new_floor = initial_capital * (floor + ratchet_steps * profit_lockin)
        floor_value = np.where(up & (new_floor > floor_value), new_floor, floor_value)

        below = nav < floor_value
        days_below_floor += below
        breach_events += below & ~was_below
        was_below = below
        if record:
            history["nav_at_rebalance"].append(nav.copy())
            history["floor_at_rebalance"].append(floor_value.copy())

        # Allocation
        cushion = nav - floor_value
        risky_target = np.maximum(np.minimum(cushion * multiplier, nav), 0)
        safe_target = nav - risky_target

        # Update NAV with the asset returns until the next rebalance
        previous_nav = nav
        nav = risky_target * (1 + r_risky) + safe_target * (1 + r_safe)

        if day == 0:
            first_nav = nav.copy()
        else:
            r = nav / previous_nav - 1
            sum_r += r
            sum_r2 += r * r
            count += 1
            down = r < 0
            sum_down += np.where(down, r, 0)
            sum_down2 += np.where(down, r * r, 0)
            count_down += down
        if record:
            history["nav"].append(nav.copy())

    # Sample standard deviations (ddof=1, as pandas)
    with np.errstate(divide="ignore", invalid="ignore"):
        mean = sum_r / count
        std = np.sqrt((sum_r2 - count * mean ** 2) / (count - 1))
        mean_down = sum_down / count_down
        std_down = np.sqrt((sum_down2 - count_down * mean_down ** 2) / (count_down - 1))
        sharpe = np.where(std > 0, np.sqrt(DAYS_PER_YEAR) * mean / std, 0)
        sortino = np.where(std_down > 0, np.sqrt(DAYS_PER_YEAR) * mean / std_down, 0)

    out = {
        "first_nav": first_nav,
        "final_nav": nav,
        "sharpe": np.nan_to_num(sharpe),
        "sortino": np.nan_to_num(sortino),
        "breach_events": breach_events,
        "days_below_floor": days_below_floor,
    }
    if record:
        out["history"] = {key: np.array(values) for key, values in history.items()}
    return out


# 3. Risk metrics
def calculate_risk_metrics(returns):
    """Sharpe and Sortino ratios of daily returns (no risk-free rate, as in the SOL script)"""
    metrics = {}
    std = returns.std()
    metrics["Sharpe"] = np.sqrt(DAYS_PER_YEAR) * returns.mean() / std if std != 0 else 0
    downside = returns[returns < 0]
    downside_std = downside.std()
    metrics["Sortino"] = np.sqrt(DAYS_PER_YEAR) * returns.mean() / downside_std if downside_std != 0 else 0
    return metrics


def max_drawdown(series):
    return float((series / series.cummax() - 1).min())


# 4. Grid search and report for one safe yield
def run_backtest(safe_yield):
    label = f"safe{round(safe_yield * 100)}"
    print(f"\n=== XLM CPPI backtest, safe yield {safe_yield:.0%} ===")
    prices = load_prices(safe_yield)

    grid = list(product(MULTIPLIERS, FLOORS, PROFIT_LOCKINS))
    grid_m = np.array([g[0] for g in grid])
    grid_f = np.array([g[1] for g in grid])
    grid_p = np.array([g[2] for g in grid])
    scores = np.zeros(len(grid), dtype=int)
    sum_sharpe = np.zeros(len(grid))
    sum_sortino = np.zeros(len(grid))
    sum_final = np.zeros(len(grid))
    worst_final = np.full(len(grid), np.inf)
    breach_events = np.zeros(len(grid), dtype=int)
    days_below_floor = np.zeros(len(grid), dtype=int)

    hourly = {}
    for hour in range(24):
        reb_prices = rebalance_prices(prices, hour)
        returns = reb_prices.pct_change().dropna()
        initial_capital = reb_prices["Risky"].iloc[0]
        run = simulate(
            returns["Risky"].to_numpy(), returns["Safe"].to_numpy(),
            grid_m, grid_f, grid_p, initial_capital
        )
        # Same test as the SOL script: both series are normalized at the end of the first day
        safe = reb_prices["Safe"].to_numpy()
        safe_growth = safe[-1] / safe[1]
        final = run["final_nav"] / run["first_nav"] * 100
        scores += (final > safe_growth * 100).astype(int)
        sum_sharpe += run["sharpe"]
        sum_sortino += run["sortino"]
        sum_final += final
        worst_final = np.minimum(worst_final, final)
        breach_events += run["breach_events"]
        days_below_floor += run["days_below_floor"]
        hourly[hour] = (reb_prices, returns, initial_capital)

    grid_df = pd.DataFrame({
        "multiplier": grid_m,
        "floor": grid_f,
        "profit_lockin": grid_p,
        "score": scores,
        "mean_sharpe": (sum_sharpe / 24).round(3),
        "mean_sortino": (sum_sortino / 24).round(3),
        "mean_final_nav": (sum_final / 24).round(2),
        "worst_hour_final_nav": worst_final.round(2),
        "breach_events": breach_events,  # sum over the 24 hours
        "days_below_floor": days_below_floor,  # sum over the 24 hours
    })

    best_index = int(np.argmax(scores))  # first maximum = SOL tie rule
    best_score = int(scores[best_index])
    multiplier, floor, profit_lockin = grid[best_index]
    tied = grid_df[grid_df["score"] == best_score]
    print(f"Best parameters: Multiplier={multiplier}, Floor={floor}, Profit Lock-in={profit_lockin}")
    print(f"Best score: {best_score} of 24 hours. Parameter sets with this score: {len(tied)} of {len(grid)}")

    # Full history for the best parameters, hour by hour
    results = {}
    rows = []
    for hour in range(24):
        reb_prices, returns, initial_capital = hourly[hour]
        run = simulate(
            returns["Risky"].to_numpy(), returns["Safe"].to_numpy(),
            [multiplier], [floor], [profit_lockin], initial_capital, record=True
        )
        history = run["history"]
        results_df = pd.DataFrame({
            "NAV": history["nav"][:, 0],
            "Risky": reb_prices["Risky"].to_numpy()[1:],
            "Safe": reb_prices["Safe"].to_numpy()[1:],
        }, index=returns.index)
        for col in ["NAV", "Risky", "Safe"]:
            results_df[col] = results_df[col] / results_df[col].iloc[0] * 100
        results[hour] = results_df

        metrics = calculate_risk_metrics(results_df["NAV"].pct_change().dropna())
        rows.append({
            "hour": hour,
            "final_nav": round(float(results_df["NAV"].iloc[-1]), 2),
            "final_xlm": round(float(results_df["Risky"].iloc[-1]), 2),
            "final_safe": round(float(results_df["Safe"].iloc[-1]), 2),
            "beats_safe": bool(results_df["NAV"].iloc[-1] > results_df["Safe"].iloc[-1]),
            "sharpe": round(float(metrics["Sharpe"]), 3),
            "sortino": round(float(metrics["Sortino"]), 3),
            "nav_max_drawdown": round(max_drawdown(results_df["NAV"]), 4),
            "xlm_max_drawdown": round(max_drawdown(results_df["Risky"]), 4),
            "breach_events": int(run["breach_events"][0]),
            "days_below_floor": int(run["days_below_floor"][0]),
        })
    summary_df = pd.DataFrame(rows).set_index("hour")

    RESULTS.mkdir(parents=True, exist_ok=True)
    summary_df.to_csv(RESULTS / f"xlm_cppi_{label}_hours.csv")
    grid_df.to_csv(RESULTS / f"xlm_cppi_{label}_grid.csv", index=False)

    # 3D parameter search, colored by score
    fig = plt.figure(figsize=(12, 10))
    ax = fig.add_subplot(111, projection="3d")
    scatter = ax.scatter3D(grid_m, grid_f, grid_p, c=scores, cmap="viridis", s=20, alpha=0.8)
    cbar = plt.colorbar(scatter)
    cbar.set_label("Total Score (hours where CPPI NAV > safe asset)")
    ax.set_xlabel("Multiplier")
    ax.set_ylabel("Floor")
    ax.set_zlabel("Profit Lock-in")
    ax.set_title(f"3D Parameter Search for XLM CPPI Strategy (safe yield {safe_yield:.0%})")
    ax.view_init(elev=30, azim=45)
    plt.savefig(RESULTS / f"xlm_cppi_{label}_grid.png", dpi=100, bbox_inches="tight")
    plt.close(fig)

    # PDF report: one chart per hour, then the risk metrics
    metrics_df = summary_df[["sharpe", "sortino"]]
    with PdfPages(RESULTS / f"xlm_cppi_{label}.pdf") as pdf:
        for hour in range(24):
            fig, ax = plt.subplots(figsize=(10, 6))
            ax.plot(results[hour].index, results[hour]["Risky"], label="XLM Price", color="blue")
            ax.plot(results[hour].index, results[hour]["Safe"], label=f"Safe Asset ({safe_yield:.0%}/yr)", color="green")
            ax.plot(results[hour].index, results[hour]["NAV"], label="CPPI NAV", color="orange")
            ax.set_title(f"XLM CPPI Backtest - Rebalance Hour: {hour}:00 UTC. M : {multiplier} F : {floor} P : {profit_lockin}")
            ax.set_xlabel("Date")
            ax.set_ylabel("Value (Normalized)")
            ax.legend()
            ax.grid(True)
            pdf.savefig(fig)
            plt.close(fig)

        fig, ax = plt.subplots(figsize=(12, 7))
        ax.plot(metrics_df.index, metrics_df["sharpe"], label="Sharpe Ratio", marker="o", color="#45B7D1")
        ax.plot(metrics_df.index, metrics_df["sortino"], label="Sortino Ratio", marker="x", color="#FF9863")
        ax.set_xticks(range(24))
        ax.set_title("Comparison of 24 XLM CPPI Strategies by Hour: Risk-Adjusted Metrics")
        ax.set_xlabel("Rebalance Hour (UTC)")
        ax.set_ylabel("Ratio Value")
        ax.axhline(y=0, color="gray", linestyle="--")
        ax.legend()
        ax.grid(True)
        pdf.savefig(fig)
        plt.close(fig)

    # NAV at a few rebalance hours
    fig = plt.figure(figsize=(14, 7))
    for hour in COMPARISON_HOURS:
        plt.plot(results[hour].index, results[hour]["NAV"], label=f"NAV, rebalance at {hour}:00 UTC")
    plt.plot(results[16].index, results[16]["Risky"], label="XLM Price", color="gray", alpha=0.5)
    plt.title(f"XLM CPPI NAV by Rebalance Hour. M : {multiplier} F : {floor} P : {profit_lockin}")
    plt.xlabel("Date")
    plt.ylabel("Value (Normalized)")
    plt.legend()
    plt.grid(True)
    plt.savefig(RESULTS / f"xlm_cppi_{label}_hours.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    def records(df):
        return json.loads(df.to_json(orient="records"))

    references = {}
    for name, (m, f, p) in REFERENCE_SETS.items():
        match = grid_df[(grid_df["multiplier"] == m) & (grid_df["floor"] == f) & (grid_df["profit_lockin"] == p)]
        references[name] = records(match)[0]

    summary = {
        "safe_yield": safe_yield,
        "period": [str(prices.index[0]), str(prices.index[-1])],
        "best_sol_method": {"multiplier": multiplier, "floor": floor, "profit_lockin": profit_lockin},
        "best_score": best_score,
        "tied_sets": len(tied),
        "grid_sets": len(grid),
        "tied_range": {
            col: [float(tied[col].min()), float(tied[col].max())]
            for col in ["multiplier", "floor", "profit_lockin"]
        },
        "tied_top_by_mean_sortino": records(tied.sort_values("mean_sortino", ascending=False).head(TOP_TIED)),
        "tied_top_by_mean_sharpe": records(tied.sort_values("mean_sharpe", ascending=False).head(TOP_TIED)),
        "reference_sets": references,
        "best_sharpe_hour": int(metrics_df["sharpe"].idxmax()),
        "best_sortino_hour": int(metrics_df["sortino"].idxmax()),
        "hour_16": rows[16],
    }
    print(summary_df.to_string())
    print("Tied sets, top by mean Sortino:")
    print(tied.sort_values("mean_sortino", ascending=False).head(TOP_TIED).to_string(index=False))
    print("Reference sets:")
    print(pd.DataFrame(references).T.to_string())
    return summary


# 5. Run the complete backtest
if __name__ == "__main__":
    summaries = [run_backtest(safe_yield) for safe_yield in SAFE_YIELDS]
    with open(RESULTS / "summary.json", "w") as f:
        json.dump(summaries, f, indent=2)
    print(f"\nReports saved in {RESULTS}")
