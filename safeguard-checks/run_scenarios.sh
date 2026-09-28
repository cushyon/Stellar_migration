#!/usr/bin/env bash
# Full safeguard scenarios against the test vault on Stellar testnet.
#
# It proves every guardrail of execute_strategy, the value floor (ratchet, stop
# rule, restart), and the emergency pause, with a real adapter and real swaps.
# It needs the test contracts, so it must NOT run on the product vault: it
# changes the config, the adapter price, the oracle, and the pause state.
#
# Shape of the test vault: the base asset XLM is the risky leg, the test token
# TST is the safe leg, priced 1 to 1 with XLM by the oracle. So "de-risk" means
# XLM -> TST and "add risk" means TST -> XLM.
#
# The adapter (contracts/test-router) swaps at a price the test sets and can pay
# under it on purpose. The mock oracle (contracts/test-oracle) returns a stale or
# deviating quote, or a crash, which the real Reflector feed cannot be asked to
# do. The script puts the vault back to its start state at the end.
#
# Usage: ./safeguard-checks/run_scenarios.sh

set -uo pipefail

NETWORK=${NETWORK:-testnet}
SOURCE=${SOURCE:-cushion-deployer}
OTHER_SOURCE=${OTHER_SOURCE:-cushion-tester}
VAULT=${VAULT:-CD6LYP5LKO27USXHLEZU7MCOWKG7J4C25HMVJOUEXVIZ74UAW27OTLMH}
ROUTER=${ROUTER:-CBQRVMZNNISIVHHUPY4SMTMPCF3QZSW6JGNHB2REZ3EBY5Q7ZBRGVIL4}
DEX_ADAPTER=${DEX_ADAPTER:-CDPKUYNWPDELEVXGYA63WI7IPK3RCKPED77PEQWVRQSXKNFYHBD2YAR6}
TST=${TST:-CAJGMOESC4BH7LZ2NMPZVUKO7WWOWIXD7SHEW5QZYDWOL226ZIYJQ5ZG}
MOCK_ORACLE=${MOCK_ORACLE:-CBO2YVCAX2BCP5ORUT6TSCCPGC4Q5PGUCYJJPPLSQT6ENVHVZ7ARCFSE}
XLM=${XLM:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}
USDC=${USDC:-CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F}
REFLECTOR=${REFLECTOR:-CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63}
REPORT=${REPORT:-safeguard-checks/report_testvault.json}

ONE=100000000000000 # 1.0 with 14 decimals, as Reflector quotes
OPERATOR=$(stellar keys address "$SOURCE")
FAR=9999999999
pass=0; fail=0; entries=()

inv() { stellar contract invoke --send=no --id "$1" --source "${2:-$SOURCE}" --network "$NETWORK" -- "${@:3}" 2>&1; }
send() { stellar contract invoke --id "$1" --source "$SOURCE" --network "$NETWORK" -- "${@:2}" >/dev/null 2>&1; }
value() { printf '%s' "$1" | tail -1 | tr -d '"'; }
code_of() { printf '%s' "$1" | grep -o 'Error(Contract, #[0-9]*)' | head -1 | grep -o '[0-9]\+'; }

# $1 = oracle, $2 = cooldown, $3 = max slippage bps, $4 = TST ticker ("XLM" = 1 to 1, "TST" = its own quote)
config() {
  echo "{\"max_trade_size\":\"10000000000\",\"cooldown_period\":$2,\"allowed_tokens\":[\"$XLM\",\"$TST\"],\"allowed_routers\":[\"$ROUTER\"],\"max_slippage_bps\":$3,\"safe_asset\":\"$TST\",\"floor_bps\":6000,\"lockin_bps\":1900,\"reflector_id\":\"$1\",\"asset_symbols\":{\"$XLM\":\"XLM\",\"$TST\":\"$4\"},\"deviation_bps\":500,\"staleness\":1800,\"decimals_offset\":3,\"mgmt_fee_bps\":0,\"perf_fee_bps\":0}"
}
# The full product config of this vault, restored at the end.
full_config() {
  echo "{\"max_trade_size\":\"300000000\",\"cooldown_period\":300,\"allowed_tokens\":[\"$XLM\",\"$TST\",\"$USDC\"],\"allowed_routers\":[\"$ROUTER\",\"$DEX_ADAPTER\"],\"max_slippage_bps\":100,\"safe_asset\":\"$TST\",\"floor_bps\":6000,\"lockin_bps\":1900,\"reflector_id\":\"$REFLECTOR\",\"asset_symbols\":{\"$XLM\":\"XLM\",\"$TST\":\"XLM\",\"$USDC\":\"USDC\"},\"deviation_bps\":500,\"staleness\":1800,\"decimals_offset\":3,\"mgmt_fee_bps\":0,\"perf_fee_bps\":0}"
}

market() { send "$ROUTER" set_market --base "$XLM" --risky "$TST" --price_bps 10000 --slippage_bps "$1"; }

record() { # name, expected, got
  local name=$1 expected=$2 got=$3 status
  if [ "$expected" = "$got" ]; then status=pass; pass=$((pass+1)); else status=fail; fail=$((fail+1)); fi
  printf '%-40s expect %-5s got %-5s %s\n' "$name" "$expected" "$got" "$status"
  entries+=("{\"case\":\"$name\",\"expected\":\"$expected\",\"got\":\"$got\",\"status\":\"$status\"}")
}

strategy() { # source, token_in, token_out, amount_in, min_out, nonce, deadline, router, [operator]
  local out; out=$(inv "$VAULT" "$1" execute_strategy --operator "${9:-$OPERATOR}" --router "$8" \
    --token_in "$2" --token_out "$3" --amount_in "$4" --min_amount_out "$5" \
    --nonce "$6" --deadline "$7" --path '[]')
  local c; c=$(code_of "$out"); echo "${c:-ok}"
}
# A trade that must land.
trade() { # token_in, token_out, amount_in, min_out
  send "$VAULT" execute_strategy --operator "$OPERATOR" --router "$ROUTER" --token_in "$1" --token_out "$2" \
    --amount_in "$3" --min_amount_out "$4" --nonce "$(nonce_now)" --deadline "$FAR" --path '[]'
}
nonce_now() { value "$(inv "$VAULT" "$SOURCE" get_nonce)"; }
xlm_balance() { value "$(inv "$XLM" "$SOURCE" balance --id "$VAULT")"; }
tst_balance() { value "$(inv "$TST" "$SOURCE" balance --id "$VAULT")"; }
share_value() { value "$(inv "$VAULT" "$SOURCE" share_value_safe)"; }
epoch_floor() { inv "$VAULT" "$SOURCE" get_epoch | tail -1 | grep -o '"floor":"[0-9]*"' | grep -o '[0-9]\+'; }
epoch_active() { inv "$VAULT" "$SOURCE" get_epoch | tail -1 | grep -c '"active":true'; }

echo "Vault:  $VAULT (test vault, base XLM is the risky leg, TST is the safe leg)"
echo "Router: $ROUTER   Mock oracle: $MOCK_ORACLE"

# --- start from a known state -----------------------------------------------
send "$VAULT" set_config --config "$(config "$REFLECTOR" 0 100 XLM)"
market 0
[ "$(epoch_active)" = "0" ] && send "$VAULT" start_epoch
N=$(nonce_now); echo "Nonce:  $N   XLM $(xlm_balance)   TST $(tst_balance)   share value $(share_value)"; echo

# --- access, replay, deadline, allowlists, size ----------------------------
if stellar keys address "$OTHER_SOURCE" >/dev/null 2>&1; then
  OTHER=$(stellar keys address "$OTHER_SOURCE")
  record "caller is not the operator" 20 "$(strategy "$OTHER_SOURCE" "$XLM" "$TST" 100000000 1 "$N" "$FAR" "$ROUTER" "$OTHER")"
fi
record "nonce mismatch"                  26 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 99 "$FAR" "$ROUTER")"
record "deadline in the past"            27 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N" 1 "$ROUTER")"
record "token not in the allowlist"      21 "$(strategy "$SOURCE" "$USDC" "$TST" 100000000 1 "$N" "$FAR" "$ROUTER")"
record "router not in the allowlist"     29 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N" "$FAR" "$TST")"
record "trade above max_trade_size"      22 "$(strategy "$SOURCE" "$XLM" "$TST" 20000000000 1 "$N" "$FAR" "$ROUTER")"

# --- realized price checks -------------------------------------------------
market 5000
record "output below min_amount_out"     24 "$(strategy "$SOURCE" "$XLM" "$TST" 300000000 290000000 "$N" "$FAR" "$ROUTER")"
market 1000
record "output below the oracle cap"     43 "$(strategy "$SOURCE" "$XLM" "$TST" 300000000 1 "$N" "$FAR" "$ROUTER")"
market 0

# --- a fair de-risk trade passes every check ---------------------------------
nav_before=$(value "$(inv "$VAULT" "$SOURCE" total_assets)")
trade "$XLM" "$TST" 300000000 299000000
record "fair swap XLM -> TST is accepted"   "$((N+1))" "$(nonce_now)"
record "fair swap keeps the NAV"            "$nav_before" "$(value "$(inv "$VAULT" "$SOURCE" total_assets)")"

# --- cooldown ----------------------------------------------------------------
send "$VAULT" set_config --config "$(config "$REFLECTOR" 300 100 XLM)"
record "second trade inside cooldown"    23 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$(nonce_now)" "$FAR" "$ROUTER")"
send "$VAULT" set_config --config "$(config "$REFLECTOR" 0 100 XLM)"

# --- the value floor ---------------------------------------------------------
# De-risk far past the old 60% allocation rule: the value floor welcomes it.
xlm_before=$(xlm_balance)
trade "$XLM" "$TST" 500000000 499000000
record "de-risk of 50 more XLM is accepted" "50" "$(( (xlm_before - $(xlm_balance)) / 10000000 ))"
# Add risk with a terrible fill: 80 TST should buy 80 XLM, the adapter pays 15%.
# Value after would be 20 + 12 = 32 of 100, under the floor of 60. Loosen the
# oracle cap so the floor, not the cap, has to refuse it.
send "$VAULT" set_config --config "$(config "$REFLECTOR" 0 9000 XLM)"
market 8500
record "add risk that breaks the floor"  28 "$(strategy "$SOURCE" "$TST" "$XLM" 800000000 1 "$(nonce_now)" "$FAR" "$ROUTER")"
market 0
send "$VAULT" set_config --config "$(config "$REFLECTOR" 0 100 XLM)"
# Add risk at a fair price: allowed while the value is above the floor.
xlm_before=$(xlm_balance)
trade "$TST" "$XLM" 600000000 599000000
record "add risk at a fair price is accepted" "60" "$(( ($(xlm_balance) - xlm_before) / 10000000 ))"

# --- oracle circuit breaker and a staged crash (mock feed) -------------------
send "$VAULT" set_config --config "$(config "$MOCK_ORACLE" 0 100 TST)"
send "$MOCK_ORACLE" set --price "$ONE" --age 0 --history "$ONE"
send "$MOCK_ORACLE" set_symbol --symbol TST --price "$ONE" --age 0 --history "$ONE"
record "mock oracle, healthy quote"       ok "$(strategy "$SOURCE" "$XLM" "$TST" 10000000 1 "$(nonce_now)" "$FAR" "$ROUTER")"
send "$MOCK_ORACLE" set --price "$ONE" --age 3600 --history "$ONE"
record "quote older than staleness"       40 "$(strategy "$SOURCE" "$XLM" "$TST" 10000000 1 "$(nonce_now)" "$FAR" "$ROUTER")"
# The deviation breaker checks the non-base leg, so the deviation is staged on TST,
# with the base quote fresh again.
send "$MOCK_ORACLE" set --price "$ONE" --age 0 --history "$ONE"
send "$MOCK_ORACLE" set_symbol --symbol TST --price 200000000000000 --age 0 --history "$ONE"
record "quote far from recent prices"     41 "$(strategy "$SOURCE" "$XLM" "$TST" 10000000 1 "$(nonce_now)" "$FAR" "$ROUTER")"
send "$MOCK_ORACLE" set_symbol --symbol TST --price "$ONE" --age 0 --history "$ONE"
# XLM falls to 0.4: the vault holds 80 XLM and 20 TST, value 32 + 20 = 52 of 100, under the floor.
send "$MOCK_ORACLE" set --price 40000000000000 --age 0 --history 40000000000000
# The adapter follows the staged price, 1 TST = 2.5 XLM, so the price cap stays quiet
# and the floor rule alone answers.
send "$ROUTER" set_market --base "$XLM" --risky "$TST" --price_bps 25000 --slippage_bps 0
record "crash: the strategy has stopped"  true "$(value "$(inv "$VAULT" "$SOURCE" strategy_stopped)")"
record "stopped: adding risk is refused"  44 "$(strategy "$SOURCE" "$TST" "$XLM" 10000000 1 "$(nonce_now)" "$FAR" "$ROUTER")"
record "stopped: de-risk is still allowed" ok "$(strategy "$SOURCE" "$XLM" "$TST" 50000000 1 "$(nonce_now)" "$FAR" "$ROUTER")"
# A new epoch may start once the strategy has stopped; not while it is live.
floor_stopped=$(epoch_floor)
record "restart the epoch while stopped"  ok "$(code_of "$(inv "$VAULT" "$SOURCE" start_epoch)" || echo ok)"
send "$VAULT" start_epoch
record "the new floor is lower"           true "$([ "$(epoch_floor)" -lt "$floor_stopped" ] && echo true || echo false)"
send "$MOCK_ORACLE" set --price "$ONE" --age 0 --history "$ONE"
record "restart refused while live"       46 "$(code_of "$(inv "$VAULT" "$SOURCE" start_epoch)")"
market 0

# --- the ratchet: a new high lifts the floor, a fall leaves it ---------------
floor_before=$(epoch_floor)
# XLM at 1.0 again after the restart at 0.4: the value made a new high. Any trade runs the ratchet.
trade "$XLM" "$TST" 10000000 9900000
floor_after=$(epoch_floor)
record "new high lifts the floor"         true "$([ "$floor_after" -gt "$floor_before" ] && echo true || echo false)"
send "$MOCK_ORACLE" set --price 80000000000000 --age 0 --history 80000000000000
send "$ROUTER" set_market --base "$XLM" --risky "$TST" --price_bps 12500 --slippage_bps 0
trade "$XLM" "$TST" 10000000 1
record "a fall never lowers the floor"    "$floor_after" "$(epoch_floor)"
send "$MOCK_ORACLE" set --price "$ONE" --age 0 --history "$ONE"
market 0
send "$VAULT" set_config --config "$(config "$REFLECTOR" 0 100 XLM)"

# --- emergency pause -----------------------------------------------------------
send "$VAULT" pause --caller "$OPERATOR"
record "paused: strategy is blocked"     1000 "$(strategy "$SOURCE" "$XLM" "$TST" 10000000 1 "$(nonce_now)" "$FAR" "$ROUTER")"
dep=$(code_of "$(inv "$VAULT" "$SOURCE" deposit --from "$OPERATOR" --assets 100000000 --receiver "$OPERATOR")")
record "paused: deposit is blocked"      1000 "${dep:-ok}"
wit=$(code_of "$(inv "$VAULT" "$SOURCE" withdraw --caller "$OPERATOR" --assets 100000000 --receiver "$OPERATOR" --owner "$OPERATOR")")
record "paused: withdraw still works"    ok "${wit:-ok}"
send "$VAULT" unpause --caller "$OPERATOR"

# --- put the vault back: all XLM, product config ------------------------------
left=$(tst_balance)
[ "$left" != "0" ] && trade "$TST" "$XLM" "$left" 1
send "$VAULT" set_config --config "$(full_config)"
record "vault is back to XLM only"       "0" "$(tst_balance)"

echo
echo "pass: $pass  fail: $fail"
mkdir -p "$(dirname "$REPORT")"
{
  printf '{\n  "network": "%s",\n  "vault": "%s",\n  "router": "%s",\n  "token": "%s",\n  "mock_oracle": "%s",\n' \
    "$NETWORK" "$VAULT" "$ROUTER" "$TST" "$MOCK_ORACLE"
  printf '  "checked_at": "%s",\n  "pass": %s,\n  "fail": %s,\n  "cases": [\n    ' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pass" "$fail"
  first=1
  for e in "${entries[@]}"; do [ $first -eq 1 ] || printf ',\n    '; printf '%s' "$e"; first=0; done
  printf '\n  ]\n}\n'
} > "$REPORT"
echo "report: $REPORT"
[ "$fail" -eq 0 ]
