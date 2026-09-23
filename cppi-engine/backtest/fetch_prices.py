"""Download XLM/USDT 15-minute candles from Binance for the CPPI backtest.

The period is fixed, so two downloads give the same file (reproducible run).
XLMUSDT, not XLMUSDC: for this period, Binance returns XLMUSDC candles only from 2024-12-04.
USDT stands for USD here (the difference is small next to XLM moves).
Output: backtest/data/xlmusdt_15m.csv with the columns open_time (UTC) and open.

Run from cppi-engine/: poetry run python backtest/fetch_prices.py
"""

import csv
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SYMBOL = "XLMUSDT"
INTERVAL = "15m"
INTERVAL_MS = 15 * 60 * 1000
START = datetime(2023, 9, 1, tzinfo=timezone.utc)  # first candle (included)
END = datetime(2026, 9, 1, tzinfo=timezone.utc)  # last candle (excluded)
LIMIT = 1000  # max candles per request on /api/v3/klines

OUTPUT = Path(__file__).parent / "data" / "xlmusdt_15m.csv"


def fetch_klines(start_ms, end_ms):
    url = (
        "https://api.binance.com/api/v3/klines"
        f"?symbol={SYMBOL}&interval={INTERVAL}&limit={LIMIT}"
        f"&startTime={start_ms}&endTime={end_ms - 1}"
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                return json.load(response)
        except OSError as e:
            if attempt == 2:
                raise
            print(f"Attempt {attempt + 1} failed: {e}. Retrying...")
            time.sleep(2 ** attempt)


def main():
    start_ms = int(START.timestamp() * 1000)
    end_ms = int(END.timestamp() * 1000)
    rows = []
    cursor = start_ms
    while cursor < end_ms:
        klines = fetch_klines(cursor, end_ms)
        if not klines:
            break
        for k in klines:
            rows.append((k[0], k[1]))  # open time (ms), open price (string, kept as is)
        cursor = klines[-1][0] + INTERVAL_MS
        print(f"{len(rows)} candles, up to {datetime.fromtimestamp(klines[-1][0] / 1000, timezone.utc)}")
        time.sleep(0.2)

    # The file must cover the full period. Stop if Binance starts late.
    if not rows or rows[0][0] != start_ms:
        first = datetime.fromtimestamp(rows[0][0] / 1000, timezone.utc) if rows else None
        raise SystemExit(f"First candle is {first}, expected {START}. {SYMBOL} does not cover the period.")

    # Report missing candles (Binance maintenance). The backtest uses the last known price for them.
    expected = (end_ms - start_ms) // INTERVAL_MS
    gaps = [(a, b) for (a, _), (b, _) in zip(rows, rows[1:]) if b - a != INTERVAL_MS]
    print(f"Candles: {len(rows)} of {expected} expected. Gaps: {len(gaps)}")
    for a, b in gaps[:10]:
        print(f"  gap after {datetime.fromtimestamp(a / 1000, timezone.utc)}: {(b - a) // INTERVAL_MS - 1} candles missing")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["open_time", "open"])
        for open_ms, open_price in rows:
            stamp = datetime.fromtimestamp(open_ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            writer.writerow([stamp, open_price])
    print(f"Saved {OUTPUT}")


if __name__ == "__main__":
    main()
