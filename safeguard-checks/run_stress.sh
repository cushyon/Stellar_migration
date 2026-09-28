#!/usr/bin/env bash
# Stress runs: stage a market move, then let the keeper react, on testnet.
#
# It answers the question "does the protection work when the market moves?".
# The mock oracle stages the price of XLM, the adapter trades at that same
# price, and the keeper runs one cycle after each change.
#
# Shape of the test vault: the base asset XLM is the risky leg, the test token
# TST is the safe leg. The contract enforces a value floor of 60% of the share
# value at the start of the epoch, measured in TST, and it ratchets up.
#
# It must NOT run on the product vault: it changes the config, the oracle, the
# adapter price, and the pause state of the test vault. It restores them at the end.
#
# Needs: the strategy engine on STRATEGY_ENGINE_URL, a Postgres for the indexer,
# and the operator key in the stellar-cli identity SOURCE.
#
# Usage: ./safeguard-checks/run_stress.sh

set -uo pipefail

NETWORK=${NETWORK:-testnet}
SOURCE=${SOURCE:-cushion-deployer}
VAULT=${VAULT:-CD6LYP5LKO27USXHLEZU7MCOWKG7J4C25HMVJOUEXVIZ74UAW27OTLMH}
ROUTER=${ROUTER:-CBQRVMZNNISIVHHUPY4SMTMPCF3QZSW6JGNHB2REZ3EBY5Q7ZBRGVIL4}
DEX_ADAPTER=${DEX_ADAPTER:-CDPKUYNWPDELEVXGYA63WI7IPK3RCKPED77PEQWVRQSXKNFYHBD2YAR6}
TST=${TST:-CAJGMOESC4BH7LZ2NMPZVUKO7WWOWIXD7SHEW5QZYDWOL226ZIYJQ5ZG}
MOCK_ORACLE=${MOCK_ORACLE:-CBO2YVCAX2BCP5ORUT6TSCCPGC4Q5PGUCYJJPPLSQT6ENVHVZ7ARCFSE}
XLM=${XLM:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}
USDC=${USDC:-CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F}
REFLECTOR=${REFLECTOR:-CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63}
ENGINE=${STRATEGY_ENGINE_URL:-http://localhost:8000}
INDEXER=${INDEXER:-indexer}
REPORT=${REPORT:-safeguard-checks/report_stress.json}

ONE=100000000000000 # 1.0 with 14 decimals, as Reflector quotes
CURRENT_PRICE=$ONE
START_NAV=${START_NAV:-1000000000} # 100 XLM of value at the start of a run

OPERATOR=$(stellar keys address "$SOURCE")
entries=()

inv() { stellar contract invoke --send=no --id "$1" --source "$SOURCE" --network "$NETWORK" -- "${@:2}" 2>&1; }
send() { stellar contract invoke --id "$1" --source "$SOURCE" --network "$NETWORK" -- "${@:2}" >/dev/null 2>&1; }
value() { printf '%s' "$1" | tail -1 | tr -d '"'; }
balance() { value "$(inv "$1" balance --id "$VAULT")"; }

config() { # $1 = oracle, $2 = cooldown
  echo "{\"max_trade_size\":\"300000000\",\"cooldown_period\":$2,\"allowed_tokens\":[\"$XLM\",\"$TST\"],\"allowed_routers\":[\"$ROUTER\"],\"max_slippage_bps\":100,\"safe_asset\":\"$TST\",\"floor_bps\":6000,\"lockin_bps\":1900,\"reflector_id\":\"$1\",\"asset_symbols\":{\"$XLM\":\"XLM\",\"$TST\":\"TST\"},\"deviation_bps\":500,\"staleness\":1800,\"decimals_offset\":3,\"mgmt_fee_bps\":0,\"perf_fee_bps\":0}"
}
# The full product config of this vault, restored at the end.
full_config() {
  echo "{\"max_trade_size\":\"300000000\",\"cooldown_period\":300,\"allowed_tokens\":[\"$XLM\",\"$TST\",\"$USDC\"],\"allowed_routers\":[\"$ROUTER\",\"$DEX_ADAPTER\"],\"max_slippage_bps\":100,\"safe_asset\":\"$TST\",\"floor_bps\":6000,\"lockin_bps\":1900,\"reflector_id\":\"$REFLECTOR\",\"asset_symbols\":{\"$XLM\":\"XLM\",\"$TST\":\"XLM\",\"$USDC\":\"USDC\"},\"deviation_bps\":500,\"staleness\":1800,\"decimals_offset\":3,\"mgmt_fee_bps\":0,\"perf_fee_bps\":0}"
}

# Stage the XLM price in USD (x 1e14). TST stays at 1.0. The adapter trades at
# the same price, so the venue and the feed agree, as they would in a real market:
# one TST costs 1e14 / xlm_price XLM, so price_bps = 1e18 / xlm_price.
price() { # $1 = XLM price x 1e14, $2 = age, $3 = history price
  CURRENT_PRICE=$1
  send "$MOCK_ORACLE" set --price "$1" --age "${2:-0}" --history "${3:-$1}"
  send "$MOCK_ORACLE" set_symbol --symbol TST --price "$ONE" --age 0 --history "$ONE"
  send "$ROUTER" set_market --base "$XLM" --risky "$TST" --price_bps "$(( 1000000000000000000 / $1 ))" --slippage_bps 0
}
venue_pays_under() { # $1 = bps under the price
  send "$ROUTER" set_market --base "$XLM" --risky "$TST" --price_bps "$(( 1000000000000000000 / CURRENT_PRICE ))" --slippage_bps "$1"
}

keeper_cycle() { # prints the keeper decision line
  ( cd "$INDEXER" && \
    KEEPER_ENABLED=true KEEPER_DRY_RUN=false KEEPER_VAULT_ID="$VAULT" KEEPER_ROUTER_ID="$ROUTER" \
    KEEPER_OPERATOR_PUBLIC="$OPERATOR" KEEPER_OPERATOR_SECRET="$(stellar keys show "$SOURCE" 2>/dev/null)" \
    STRATEGY_ENGINE_URL="$ENGINE" KEEPER_REJECT_BACKOFF_SECONDS=0 \
    PATH="$HOME/.asdf/shims:$PATH" npx tsx src/scripts/keeper-once.ts 2>/dev/null \
    | grep -E '^\[keeper\]' | tail -1 )
}

# Start a fresh epoch when the last run stopped the strategy, and bring the vault
# back to its start size. A staged crash really costs the vault value, and the
# strategy has no way back once the value sits under the floor. The epoch restarts
# while the last staged price still stands: a price reset first could lift the
# value over the floor again, and then the vault refuses a new epoch (46).
reset_state() {
  PATH="$HOME/.asdf/shims:$PATH" psql -d "${PGDATABASE:-cushion_indexer}" -q -c \
    "delete from strategy_state where vault = '$VAULT'" >/dev/null 2>&1
  if [ "$(value "$(inv "$VAULT" strategy_stopped)")" = "true" ]; then send "$VAULT" start_epoch; fi
  price "$ONE"
  local nav missing
  nav=$(value "$(inv "$VAULT" total_assets)")
  missing=$(( START_NAV - nav ))
  if [ "$missing" -gt 0 ]; then send "$VAULT" deposit --from "$OPERATOR" --assets "$missing" --receiver "$OPERATOR"; fi
}

# Target of the last keeper decision, read from the indexer database.
target() {
  PATH="$HOME/.asdf/shims:$PATH" psql -d "${PGDATABASE:-cushion_indexer}" -tA -c \
    "select round(target_risky_pct::numeric, 1) from strategy_run where vault = '$VAULT' and target_risky_pct is not null order by ts desc limit 1" 2>/dev/null | tr -d ' '
}

allocation() { # XLM (the risky leg) as a share of the NAV, in %
  local base nav
  base=$(balance "$XLM"); nav=$(value "$(inv "$VAULT" total_assets)")
  awk -v b="$base" -v n="$nav" 'BEGIN { if (n > 0) printf "%.1f", b * 100 / n; else print "0.0" }'
}
floor_state() { # where the floor sits under the share value, in %
  local floor value
  floor=$(inv "$VAULT" get_epoch | tail -1 | sed 's/.*"floor":"\([0-9]*\)".*/\1/')
  value=$(value "$(inv "$VAULT" share_value_safe)")
  awk -v f="$floor" -v v="$value" 'BEGIN { if (v > 0) printf "floor at %.0f%% of the share value", f * 100 / v; else print "no value" }'
}

report() { # name, expectation, observed
  printf '%-32s %-36s %s\n' "$1" "$2" "$3"
  entries+=("{\"scenario\":\"$1\",\"expected\":\"$2\",\"observed\":\"$3\"}")
}

echo "Vault: $VAULT (test vault)   Oracle: $MOCK_ORACLE   Engine: $ENGINE"
curl -s -m 5 "$ENGINE/health" >/dev/null || { echo "The strategy engine does not answer on $ENGINE"; exit 1; }

# --- put the vault in a known state ---------------------------------------
send "$VAULT" set_config --config "$(config "$MOCK_ORACLE" 0)"
reset_state
echo "start: NAV $(( $(value "$(inv "$VAULT" total_assets)") / 10000000 )) XLM, allocation $(allocation)% XLM, $(floor_state)"
echo

# --- 1. calm market: the keeper builds the target allocation ---------------
for i in 1 2 3; do keeper_cycle > /dev/null; done
report "calm market, three cycles" "allocation reaches the target" "target $(target)%, actual $(allocation)% XLM"

# --- 2. XLM falls 30%: the keeper must de-risk ------------------------------
price 70000000000000
before=$(allocation)
for i in 1 2; do keeper_cycle > /dev/null; done
report "XLM -30%" "the keeper sells XLM" "from ${before}% to $(allocation)%, target $(target)%"

# --- 3. XLM falls to 30% of the start: the floor takes over ----------------
price 30000000000000
for i in 1 2 3 4 5 6; do keeper_cycle > /dev/null; done
report "XLM -70%" "everything in the safe asset, strategy stopped" "target $(target)%, actual $(allocation)% XLM, stopped $(value "$(inv "$VAULT" strategy_stopped)")"

# --- 4. the oracle stops being fresh: no trade at all ----------------------
price 30000000000000 3600
line=$(keeper_cycle)
report "quote 1 hour old" "no trade" "${line:-no decision}"

# --- 5. the safe leg quote walks away from its recent prices ---------------
price 30000000000000
send "$MOCK_ORACLE" set_symbol --symbol TST --price 200000000000000 --age 0 --history "$ONE"
line=$(keeper_cycle)
report "TST quote 2x the recent mean" "no trade" "${line:-no decision}"
send "$MOCK_ORACLE" set_symbol --symbol TST --price "$ONE" --age 0 --history "$ONE"

# --- 6. the venue pays under the oracle price ------------------------------
# The vault holds only TST after the crash, so the trade sells TST. The oracle
# cap (43) runs before the stop rule (44), so the bad fill is what gets refused.
venue_pays_under 1000
out=$(inv "$VAULT" execute_strategy --operator "$OPERATOR" --router "$ROUTER" --token_in "$TST" --token_out "$XLM" \
  --amount_in 10000000 --min_amount_out 1 --nonce "$(value "$(inv "$VAULT" get_nonce)")" \
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
send "$VAULT" set_config --config "$(full_config)"
report "vault restored" "safe asset held, product config back" "$(allocation)% XLM, stopped $(value "$(inv "$VAULT" strategy_stopped)")"

echo
mkdir -p "$(dirname "$REPORT")"
{
  printf '{\n  "network": "%s",\n  "vault": "%s",\n  "oracle": "%s",\n  "floor_bps": 6000,\n' \
    "$NETWORK" "$VAULT" "$MOCK_ORACLE"
  printf '  "checked_at": "%s",\n  "scenarios": [\n    ' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  first=1
  for e in "${entries[@]}"; do [ $first -eq 1 ] || printf ',\n    '; printf '%s' "$e"; first=0; done
  printf '\n  ]\n}\n'
} > "$REPORT"
echo "report: $REPORT"
