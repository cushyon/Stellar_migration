#!/usr/bin/env bash
# Full safeguard scenarios against the test vault on Stellar testnet.
#
# It proves every guardrail of execute_strategy, plus the emergency pause, with a real
# adapter and a real swap. It needs the test contracts, so it must NOT run on the
# product vault: it changes the config, the adapter rate, and the pause state.
#
# The adapter (contracts/test-router) pays a price that the test chooses. The mock
# oracle (contracts/test-oracle) returns a stale or deviating quote, which the real
# Reflector feed cannot be asked to do. The script puts the vault back to its start
# state at the end, so it can run again.
#
# Usage: ./safeguard-checks/run_scenarios.sh

set -uo pipefail

NETWORK=${NETWORK:-testnet}
SOURCE=${SOURCE:-cushion-deployer}
OTHER_SOURCE=${OTHER_SOURCE:-cushion-tester}
VAULT=${VAULT:-CBNHFG6WLQ3YKGL554SR37SKYL6VUSWCQ4EIBTCFYPL4RQJX2QDOHT4P}
ROUTER=${ROUTER:-CCLL54JPXNQGWVYRMQT35THZJ3HIPJOGN3LFGN63MHB3CQEI2IMFWU5W}
TST=${TST:-CAJGMOESC4BH7LZ2NMPZVUKO7WWOWIXD7SHEW5QZYDWOL226ZIYJQ5ZG}
MOCK_ORACLE=${MOCK_ORACLE:-CC4M55ZEATXYRJBDA2RNGIM3IX6Y5GYI6K4EFEFNS4OVC5VD5COVUZZM}
XLM=${XLM:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}
USDC=${USDC:-CA2E53VHFZ6YSWQIEIPBXJQGT6VW3VKWWZO555XKRQXYJ63GEBJJGHY7}
REFLECTOR=${REFLECTOR:-CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63}
REPORT=${REPORT:-safeguard-checks/report_testvault.json}

OPERATOR=$(stellar keys address "$SOURCE")
FAR=9999999999
pass=0; fail=0; entries=()

inv() { stellar contract invoke --send=no --id "$1" --source "${2:-$SOURCE}" --network "$NETWORK" -- "${@:3}" 2>&1; }
send() { stellar contract invoke --id "$1" --source "$SOURCE" --network "$NETWORK" -- "${@:2}" >/dev/null 2>&1; }
code_of() { printf '%s' "$1" | grep -o 'Error(Contract, #[0-9]*)' | head -1 | grep -o '[0-9]\+'; }

config() { # $1 = oracle id, $2 = cooldown
  echo "{\"max_trade_size\":\"300000000\",\"cooldown_period\":$2,\"allowed_tokens\":[\"$XLM\",\"$TST\"],\"allowed_routers\":[\"$ROUTER\"],\"max_slippage_bps\":100,\"floor_bps\":6000,\"reflector_id\":\"$1\",\"asset_symbols\":{\"$XLM\":\"XLM\",\"$TST\":\"XLM\"},\"deviation_bps\":500,\"staleness\":1800,\"decimals_offset\":3,\"mgmt_fee_bps\":0,\"perf_fee_bps\":0}"
}

record() { # name, expected (number or "ok"), got
  local name=$1 expected=$2 got=$3 status
  if [ "$expected" = "$got" ]; then status=pass; pass=$((pass+1)); else status=fail; fail=$((fail+1)); fi
  printf '%-34s expect %-5s got %-5s %s\n' "$name" "$expected" "$got" "$status"
  entries+=("{\"case\":\"$name\",\"expected\":\"$expected\",\"got\":\"$got\",\"status\":\"$status\"}")
}

strategy() { # source, token_in, token_out, amount_in, min_out, nonce, deadline, router
  local out; out=$(inv "$VAULT" "$1" execute_strategy --operator "${9:-$OPERATOR}" --router "$8" \
    --token_in "$2" --token_out "$3" --amount_in "$4" --min_amount_out "$5" \
    --nonce "$6" --deadline "$7" --path '[]')
  local c; c=$(code_of "$out"); echo "${c:-ok}"
}

nonce_now() { inv "$VAULT" "$SOURCE" get_nonce | tail -1 | tr -d '"'; }

echo "Vault:  $VAULT (test vault)"
echo "Router: $ROUTER   Token: $TST   Mock oracle: $MOCK_ORACLE"
N=$(nonce_now); echo "Nonce:  $N"; echo

# Start from a known state. The cooldown check runs before the swap, so a cooldown
# left over from an earlier run would hide every check that follows it.
send "$VAULT" set_config --config "$(config "$REFLECTOR" 0)"

# --- access, replay, deadline, allowlists ---------------------------------
if stellar keys address "$OTHER_SOURCE" >/dev/null 2>&1; then
  OTHER=$(stellar keys address "$OTHER_SOURCE")
  record "caller is not the operator" 20 "$(strategy "$OTHER_SOURCE" "$XLM" "$TST" 100000000 1 "$N" "$FAR" "$ROUTER" "$OTHER")"
fi
record "nonce mismatch"              26 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 99 "$FAR" "$ROUTER")"
record "deadline in the past"        27 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N" 1 "$ROUTER")"
record "token not in the allowlist"  21 "$(strategy "$SOURCE" "$USDC" "$TST" 100000000 1 "$N" "$FAR" "$ROUTER")"
record "router not in the allowlist" 29 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N" "$FAR" "$TST")"
record "trade above max_trade_size"  22 "$(strategy "$SOURCE" "$XLM" "$TST" 400000000 1 "$N" "$FAR" "$ROUTER")"

# --- realized price checks -------------------------------------------------
send "$ROUTER" set_rate --rate_bps 5000
record "output below min_amount_out" 24 "$(strategy "$SOURCE" "$XLM" "$TST" 300000000 290000000 "$N" "$FAR" "$ROUTER")"
send "$ROUTER" set_rate --rate_bps 9000
record "output below the oracle cap" 43 "$(strategy "$SOURCE" "$XLM" "$TST" 300000000 1 "$N" "$FAR" "$ROUTER")"

# --- a trade that passes every check ---------------------------------------
send "$ROUTER" set_rate --rate_bps 10000
nav_before=$(inv "$VAULT" "$SOURCE" total_assets | tail -1 | tr -d '"')
send "$VAULT" execute_strategy --operator "$OPERATOR" --router "$ROUTER" --token_in "$XLM" --token_out "$TST" \
  --amount_in 300000000 --min_amount_out 299000000 --nonce "$N" --deadline "$FAR" --path '[]'
N2=$(nonce_now)
nav_after=$(inv "$VAULT" "$SOURCE" total_assets | tail -1 | tr -d '"')
record "fair swap is accepted"       "$((N+1))" "$N2"
record "fair swap keeps the NAV"     "$nav_before" "$nav_after"

# --- cooldown and floor ----------------------------------------------------
send "$VAULT" set_config --config "$(config "$REFLECTOR" 300)"
record "second trade inside cooldown" 23 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N2" "$FAR" "$ROUTER")"
send "$VAULT" set_config --config "$(config "$REFLECTOR" 0)"
record "trade that breaks the floor"  28 "$(strategy "$SOURCE" "$XLM" "$TST" 300000000 1 "$N2" "$FAR" "$ROUTER")"
record "trade that stops at the floor" ok "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N2" "$FAR" "$ROUTER")"

# --- oracle circuit breaker (mock feed) ------------------------------------
send "$VAULT" set_config --config "$(config "$MOCK_ORACLE" 0)"
send "$MOCK_ORACLE" set --price 100000000000000 --age 0 --history 100000000000000
record "mock oracle, healthy quote"   ok "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N2" "$FAR" "$ROUTER")"
send "$MOCK_ORACLE" set --price 100000000000000 --age 3600 --history 100000000000000
record "quote older than staleness"   40 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N2" "$FAR" "$ROUTER")"
send "$MOCK_ORACLE" set --price 200000000000000 --age 0 --history 100000000000000
record "quote far from recent prices" 41 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N2" "$FAR" "$ROUTER")"
send "$MOCK_ORACLE" set --price 100000000000000 --age 0 --history 100000000000000
send "$VAULT" set_config --config "$(config "$REFLECTOR" 0)"

# --- emergency pause -------------------------------------------------------
send "$VAULT" pause --caller "$OPERATOR"
record "paused: strategy is blocked" 1000 "$(strategy "$SOURCE" "$XLM" "$TST" 100000000 1 "$N2" "$FAR" "$ROUTER")"
dep=$(code_of "$(inv "$VAULT" "$SOURCE" deposit --from "$OPERATOR" --assets 100000000 --receiver "$OPERATOR")")
record "paused: deposit is blocked"  1000 "${dep:-ok}"
wit=$(code_of "$(inv "$VAULT" "$SOURCE" withdraw --caller "$OPERATOR" --assets 100000000 --receiver "$OPERATOR" --owner "$OPERATOR")")
record "paused: withdraw still works" ok "${wit:-ok}"
send "$VAULT" unpause --caller "$OPERATOR"

# --- put the vault back to its start state ---------------------------------
send "$VAULT" execute_strategy --operator "$OPERATOR" --router "$ROUTER" --token_in "$TST" --token_out "$XLM" \
  --amount_in 300000000 --min_amount_out 299000000 --nonce "$N2" --deadline "$FAR" --path '[]'
send "$VAULT" set_config --config "$(config "$REFLECTOR" 300)"
base=$(inv "$XLM" "$SOURCE" balance --id "$VAULT" | tail -1 | tr -d '"')
record "vault is back to base only"  "$nav_before" "$base"

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
