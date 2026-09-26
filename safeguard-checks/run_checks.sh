#!/usr/bin/env bash
# Safeguard checks against a deployed vault on Stellar testnet.
#
# Each case calls execute_strategy with one broken input and expects one error code.
# A reverted Soroban call changes no state, so the evidence is the answer of the network
# to the simulation. stellar-cli does not submit a transaction whose simulation fails.
#
# Usage:
#   ./safeguard-checks/run_checks.sh                 # uses the values below
#   VAULT=C... ROUTER=C... ./safeguard-checks/run_checks.sh
#
# Error codes: 20 UnauthorizedOperator, 21 TokenNotAllowed, 22 TradeSizeExceeded,
# 23 CooldownNotElapsed, 24 SlippageExceeded, 26 NonceMismatch, 27 DeadlineExpired,
# 28 FloorBreached, 29 RouterNotAllowed, 40 OracleStale, 41 OracleDeviation, 43 SlippageCapExceeded.

set -uo pipefail

NETWORK=${NETWORK:-testnet}
VAULT=${VAULT:-CAH4EGSDBIEJB5TQFH4Q37372UJBY27UN2UBF426YDR2IUVJWACJLBAE}
SOURCE=${SOURCE:-cushion-deployer}
OTHER_SOURCE=${OTHER_SOURCE:-cushion-tester}
XLM=${XLM:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}
USDC=${USDC:-CA2E53VHFZ6YSWQIEIPBXJQGT6VW3VKWWZO555XKRQXYJ63GEBJJGHY7}
# Router to use in the cases that must pass the router allowlist. Empty allowlist: every router fails.
ROUTER=${ROUTER:-$USDC}
REPORT=${REPORT:-safeguard-checks/report_live.json}

OPERATOR=$(stellar keys address "$SOURCE")
FAR_FUTURE=9999999999
PAST=1

pass_count=0
fail_count=0
entries=()

# run_case <name> <expected code> <source identity> <execute_strategy args...>
run_case() {
  local name=$1 expected=$2 source=$3
  shift 3
  local out code status
  out=$(stellar contract invoke --send=no --id "$VAULT" --source "$source" --network "$NETWORK" \
        -- execute_strategy "$@" 2>&1)
  code=$(printf '%s' "$out" | grep -o 'Error(Contract, #[0-9]*)' | head -1 | grep -o '[0-9]\+')
  if [ "$code" = "$expected" ]; then
    status=pass
    pass_count=$((pass_count + 1))
  else
    status=fail
    fail_count=$((fail_count + 1))
  fi
  printf '%-28s expected #%-3s got #%-4s %s\n' "$name" "$expected" "${code:-none}" "$status"
  entries+=("{\"case\":\"$name\",\"expected\":$expected,\"got\":${code:-null},\"status\":\"$status\"}")
}

echo "Vault:    $VAULT"
echo "Network:  $NETWORK"
echo "Operator: $OPERATOR"
nonce=$(stellar contract invoke --send=no --id "$VAULT" --source "$SOURCE" --network "$NETWORK" -- get_nonce 2>/dev/null | tr -d '"')
echo "Nonce:    $nonce"
echo

# 1. A caller that is not the operator (checked first, before every other rule).
if stellar keys address "$OTHER_SOURCE" >/dev/null 2>&1; then
  other=$(stellar keys address "$OTHER_SOURCE")
  run_case "unauthorized operator" 20 "$OTHER_SOURCE" \
    --operator "$other" --router "$ROUTER" --token_in "$XLM" --token_out "$XLM" \
    --amount_in 1000000000 --min_amount_out 1 --nonce "$nonce" --deadline "$FAR_FUTURE" --path '[]'
else
  echo "unauthorized operator     skipped: identity $OTHER_SOURCE does not exist"
fi

# 2. Replay protection: a nonce that is not the stored one.
run_case "nonce mismatch" 26 "$SOURCE" \
  --operator "$OPERATOR" --router "$ROUTER" --token_in "$XLM" --token_out "$XLM" \
  --amount_in 1000000000 --min_amount_out 1 --nonce 99 --deadline "$FAR_FUTURE" --path '[]'

# 3. A deadline in the past.
run_case "deadline expired" 27 "$SOURCE" \
  --operator "$OPERATOR" --router "$ROUTER" --token_in "$XLM" --token_out "$XLM" \
  --amount_in 1000000000 --min_amount_out 1 --nonce "$nonce" --deadline "$PAST" --path '[]'

# 4. A token that the allowlist does not contain.
run_case "token not allowed" 21 "$SOURCE" \
  --operator "$OPERATOR" --router "$ROUTER" --token_in "$USDC" --token_out "$XLM" \
  --amount_in 1000000000 --min_amount_out 1 --nonce "$nonce" --deadline "$FAR_FUTURE" --path '[]'

# 5. A router that the venue allowlist does not contain.
run_case "router not allowed" 29 "$SOURCE" \
  --operator "$OPERATOR" --router "$ROUTER" --token_in "$XLM" --token_out "$XLM" \
  --amount_in 1000000000 --min_amount_out 1 --nonce "$nonce" --deadline "$FAR_FUTURE" --path '[]'

echo
echo "pass: $pass_count  fail: $fail_count"

mkdir -p "$(dirname "$REPORT")"
{
  printf '{\n  "network": "%s",\n  "vault": "%s",\n  "operator": "%s",\n  "nonce": %s,\n' \
    "$NETWORK" "$VAULT" "$OPERATOR" "${nonce:-null}"
  printf '  "checked_at": "%s",\n  "pass": %s,\n  "fail": %s,\n  "cases": [\n    ' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pass_count" "$fail_count"
  local_first=1
  for e in "${entries[@]}"; do
    [ $local_first -eq 1 ] || printf ',\n    '
    printf '%s' "$e"
    local_first=0
  done
  printf '\n  ]\n}\n'
} > "$REPORT"
echo "report: $REPORT"

[ "$fail_count" -eq 0 ]
