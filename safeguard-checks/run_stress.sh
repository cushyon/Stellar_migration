#!/usr/bin/env bash
# Stress runs: stage a market move, then let the keeper react, on testnet.
#
# It answers the question "does the protection work when the market moves?".
# The mock oracle stages the price of the risky asset, the test adapter stages the
# price the venue pays, and the keeper runs one cycle after each change.
#
# It must NOT run on the product vault: it changes the config, the oracle, the
# adapter rate, and the pause state of the test vault. It restores them at the end.
#
# Needs: the strategy engine on STRATEGY_ENGINE_URL, a Postgres for the indexer,
# and the operator key in the stellar-cli identity SOURCE.
#
# Usage: ./safeguard-checks/run_stress.sh

set -uo pipefail

NETWORK=${NETWORK:-testnet}
SOURCE=${SOURCE:-cushion-deployer}
VAULT=${VAULT:-CBNHFG6WLQ3YKGL554SR37SKYL6VUSWCQ4EIBTCFYPL4RQJX2QDOHT4P}
ROUTER=${ROUTER:-CBQRVMZNNISIVHHUPY4SMTMPCF3QZSW6JGNHB2REZ3EBY5Q7ZBRGVIL4}
TST=${TST:-CAJGMOESC4BH7LZ2NMPZVUKO7WWOWIXD7SHEW5QZYDWOL226ZIYJQ5ZG}
MOCK_ORACLE=${MOCK_ORACLE:-CBO2YVCAX2BCP5ORUT6TSCCPGC4Q5PGUCYJJPPLSQT6ENVHVZ7ARCFSE}
XLM=${XLM:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}
REFLECTOR=${REFLECTOR:-CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63}
ENGINE=${STRATEGY_ENGINE_URL:-http://localhost:8000}
INDEXER=${INDEXER:-indexer}
REPORT=${REPORT:-safeguard-checks/report_stress.json}

# The onchain floor is a backstop here, not the CPPI target: the CPPI allocation
# can hold more risky asset than `floor_bps` allows. The product vault keeps 6000.
STRESS_FLOOR_BPS=${STRESS_FLOOR_BPS:-2000}
ONE=100000000000000 # 1.0 with 14 decimals, as Reflector quotes
CURRENT_PRICE=$ONE
START_BASE=${START_BASE:-1000000000} # 100 XLM

OPERATOR=$(stellar keys address "$SOURCE")
entries=()

inv() { stellar contract invoke --send=no --id "$1" --source "$SOURCE" --network "$NETWORK" -- "${@:2}" 2>&1; }
send() { stellar contract invoke --id "$1" --source "$SOURCE" --network "$NETWORK" -- "${@:2}" >/dev/null 2>&1; }
balance() { inv "$1" balance --id "$VAULT" | tail -1 | tr -d '"'; }

config() { # $1 = oracle, $2 = cooldown, $3 = floor bps
  echo "{\"max_trade_size\":\"300000000\",\"cooldown_period\":$2,\"allowed_tokens\":[\"$XLM\",\"$TST\"],\"allowed_routers\":[\"$ROUTER\"],\"max_slippage_bps\":100,\"floor_bps\":$3,\"reflector_id\":\"$1\",\"asset_symbols\":{\"$XLM\":\"XLM\",\"$TST\":\"TST\"},\"deviation_bps\":500,\"staleness\":1800,\"decimals_offset\":3,\"mgmt_fee_bps\":0,\"perf_fee_bps\":0}"
}

# Stage a market price. The oracle quotes it and the adapter trades at it, so the
# venue and the price feed agree, as they would in a real market.
price() { # $1 = price of TST in base units x 1e14, $2 = age, $3 = history price
  send "$MOCK_ORACLE" set_symbol --symbol TST --price "$1" --age "${2:-0}" --history "${3:-$1}"
  send "$ROUTER" set_market --base "$XLM" --risky "$TST" --price_bps "$(( $1 / 10000000000 ))" --slippage_bps 0
}

# Make the adapter pay under the market price, to test the execution guards.
venue_pays_under() { # $1 = bps under the price
  send "$ROUTER" set_market --base "$XLM" --risky "$TST" --price_bps "$(( CURRENT_PRICE / 10000000000 ))" --slippage_bps "$1"
}

keeper_cycle() { # prints the keeper decision line
  ( cd "$INDEXER" && \
    KEEPER_ENABLED=true KEEPER_DRY_RUN=false KEEPER_VAULT_ID="$VAULT" \
    KEEPER_RISKY_ASSET_ID="$TST" KEEPER_ROUTER_ID="$ROUTER" \
    KEEPER_OPERATOR_PUBLIC="$OPERATOR" KEEPER_OPERATOR_SECRET="$(stellar keys show "$SOURCE" 2>/dev/null)" \
    STRATEGY_ENGINE_URL="$ENGINE" RISKY_ASSET_IDS="$TST" KEEPER_REJECT_BACKOFF_SECONDS=0 \
    PATH="$HOME/.asdf/shims:$PATH" npx tsx src/scripts/keeper-once.ts 2>/dev/null \
    | grep -E '^\[keeper\]' | tail -1 )
}

# Sell the risky leg back to base. One call can move at most max_trade_size,
# so it repeats until the balance is zero or a call stops making progress.
sell_all_risky() {
  local left previous=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    left=$(balance "$TST")
    [ "$left" = "0" ] && return 0
    [ "$left" = "$previous" ] && return 1
    previous=$left
    [ "$left" -gt 300000000 ] && left=300000000
    send "$VAULT" execute_strategy --operator "$OPERATOR" --router "$ROUTER" --token_in "$TST" --token_out "$XLM" \
      --amount_in "$left" --min_amount_out 1 --nonce "$(inv "$VAULT" get_nonce | tail -1 | tr -d '"')" \
      --deadline 9999999999 --path '[]'
  done
}

# Target of the last keeper decision, read from the indexer database.
target() {
  PATH="$HOME/.asdf/shims:$PATH" psql -d "${PGDATABASE:-cushion_indexer}" -tA -c \
    "select round(target_risky_pct::numeric, 1) from strategy_run where vault = '$VAULT' and target_risky_pct is not null order by ts desc limit 1" 2>/dev/null | tr -d ' '
}

# Start a fresh strategy epoch: forget the stored high-water mark and bring the
# vault back to its start size. A staged crash really costs the vault value, and
# the CPPI has no way back once the NAV sits under its floor, so a second run
# without this reset would find a vault that must stay in the safe asset.
reset_state() {
  PATH="$HOME/.asdf/shims:$PATH" psql -d "${PGDATABASE:-cushion_indexer}" -q -c \
    "delete from strategy_state where vault = '$VAULT'" >/dev/null 2>&1
  local base missing
  base=$(balance "$XLM")
  missing=$(( START_BASE - base ))
  if [ "$missing" -gt 0 ]; then
    send "$VAULT" deposit --from "$OPERATOR" --assets "$missing" --receiver "$OPERATOR"
  fi
}

allocation() { # risky share of the NAV, in %
  local base risky nav
  base=$(balance "$XLM"); risky=$(balance "$TST")
  nav=$(inv "$VAULT" total_assets | tail -1 | tr -d '"')
  awk -v b="$base" -v r="$risky" -v n="$nav" 'BEGIN { if (n > 0) printf "%.1f", (n - b) * 100 / n; else print "0.0" }'
}

report() { # name, expectation, observed
  printf '%-32s %-34s %s\n' "$1" "$2" "$3"
  entries+=("{\"scenario\":\"$1\",\"expected\":\"$2\",\"observed\":\"$3\"}")
}

echo "Vault: $VAULT (test vault)   Oracle: $MOCK_ORACLE   Engine: $ENGINE"
curl -s -m 5 "$ENGINE/health" >/dev/null || { echo "The strategy engine does not answer on $ENGINE"; exit 1; }

# --- put the vault in a known state ---------------------------------------
send "$VAULT" set_config --config "$(config "$MOCK_ORACLE" 0 "$STRESS_FLOOR_BPS")"
send "$MOCK_ORACLE" set --price "$ONE" --age 0 --history "$ONE"
price "$ONE"
sell_all_risky
reset_state
echo "start: $(( $(balance "$XLM") / 10000000 )) XLM in the vault, allocation $(allocation)% risky"
echo

# --- 1. calm market: the keeper builds the target allocation ---------------
for i in 1 2 3; do keeper_cycle > /dev/null; done
report "calm market, three cycles" "allocation reaches the target" "target $(target)%, actual $(allocation)%"

# --- 2. the price falls 30%: the keeper must de-risk -----------------------
price 70000000000000
before=$(allocation)
for i in 1 2; do keeper_cycle > /dev/null; done
report "price -30%" "the keeper sells the risky leg" "from ${before}% to $(allocation)%, target $(target)%"

# --- 3. the price falls to a third of the start: protection takes over -----
price 30000000000000
for i in 1 2 3 4 5 6; do keeper_cycle > /dev/null; done
report "price -70%" "the keeper keeps selling" "target $(target)%, actual $(allocation)%"

# --- 4. the oracle stops being fresh: no trade at all ----------------------
price 30000000000000 3600
line=$(keeper_cycle)
report "quote 1 hour old" "no trade" "${line:-no decision}"

# --- 5. the last price walks away from the recent ones ---------------------
price 60000000000000 0 30000000000000
line=$(keeper_cycle)
report "last price 2x the recent mean" "no trade" "${line:-no decision}"

# --- 6. the venue pays under the oracle price ------------------------------
price 30000000000000 0 30000000000000
CURRENT_PRICE=30000000000000
venue_pays_under 1000
send "$VAULT" execute_strategy --operator "$OPERATOR" --router "$ROUTER" --token_in "$XLM" --token_out "$TST" \
  --amount_in 100000000 --min_amount_out 1 --nonce "$(inv "$VAULT" get_nonce | tail -1 | tr -d '"')" \
  --deadline 9999999999 --path '[]'
out=$(inv "$VAULT" execute_strategy --operator "$OPERATOR" --router "$ROUTER" --token_in "$XLM" --token_out "$TST" \
  --amount_in 100000000 --min_amount_out 1 --nonce "$(inv "$VAULT" get_nonce | tail -1 | tr -d '"')" \
  --deadline 9999999999 --path '[]')
code=$(printf '%s' "$out" | grep -o 'Error(Contract, #[0-9]*)' | head -1 | grep -o '[0-9]\+')
report "venue pays 10% under" "rejected with 43" "error ${code:-none}"
venue_pays_under 0

# --- 7. the guardian pauses the vault --------------------------------------
send "$VAULT" pause --caller "$OPERATOR"
line=$(keeper_cycle)
report "vault paused" "no trade" "${line:-no decision}"
send "$VAULT" unpause --caller "$OPERATOR"

# --- put the vault back ----------------------------------------------------
price "$ONE"
sell_all_risky
# Back to the product settings. The ticker goes back to XLM, because Reflector
# has no quote for the test token and the vault must stay able to price it.
send "$VAULT" set_config --config "$(echo "$(config "$REFLECTOR" 300 6000)" | sed "s/\"$TST\":\"TST\"/\"$TST\":\"XLM\"/")"
report "vault restored" "0.0% risky, Reflector back" "$(allocation)% risky"

echo
mkdir -p "$(dirname "$REPORT")"
{
  printf '{\n  "network": "%s",\n  "vault": "%s",\n  "oracle": "%s",\n  "floor_bps_during_stress": %s,\n' \
    "$NETWORK" "$VAULT" "$MOCK_ORACLE" "$STRESS_FLOOR_BPS"
  printf '  "checked_at": "%s",\n  "scenarios": [\n    ' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  first=1
  for e in "${entries[@]}"; do [ $first -eq 1 ] || printf ',\n    '; printf '%s' "$e"; first=0; done
  printf '\n  ]\n}\n'
} > "$REPORT"
echo "report: $REPORT"
