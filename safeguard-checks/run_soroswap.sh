#!/usr/bin/env bash
# Trade on Soroswap through the vault, on Stellar testnet.
#
# It proves two things at once:
#  - the vault can execute a real DEX trade through the adapter, under its own rules;
#  - the oracle slippage cap refuses a trade when the pool price is far from the feed.
#
# The testnet pool sits about 20% away from the Reflector price, so on this network
# the two directions are not symmetric: selling USDC into the pool is favourable and
# passes, buying USDC is unfavourable and the vault refuses it with error 43. On a
# market where the pool tracks the feed, both directions pass.
#
# It must NOT run on the product vault: it changes the config of the test vault.
#
# Usage: ./safeguard-checks/run_soroswap.sh

set -uo pipefail

NETWORK=${NETWORK:-testnet}
SOURCE=${SOURCE:-cushion-deployer}
VAULT=${VAULT:-CD6LYP5LKO27USXHLEZU7MCOWKG7J4C25HMVJOUEXVIZ74UAW27OTLMH}
ADAPTER=${ADAPTER:-CDPKUYNWPDELEVXGYA63WI7IPK3RCKPED77PEQWVRQSXKNFYHBD2YAR6}
# Soroswap testnet, from public/testnet.contracts.json of soroswap/core (2026-09-27).
SOROSWAP_ROUTER=${SOROSWAP_ROUTER:-CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD}
XLM=${XLM:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}
# Soroswap's testnet USDC, from public/tokens.json. Not the USDC of the product vault.
USDC=${USDC:-CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F}
REFLECTOR=${REFLECTOR:-CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63}
REPORT=${REPORT:-safeguard-checks/report_soroswap.json}

SELL_AMOUNT=${SELL_AMOUNT:-10000000} # 1 USDC (7 decimals)
BUY_AMOUNT=${BUY_AMOUNT:-30000000} # 3 XLM, for the refused direction
MAX_SLIPPAGE_BPS=${MAX_SLIPPAGE_BPS:-500}

OPERATOR=$(stellar keys address "$SOURCE")
entries=()

inv() { stellar contract invoke --send=no --id "$1" --source "$SOURCE" --network "$NETWORK" -- "${@:2}" 2>&1; }
send() { stellar contract invoke --id "$1" --source "$SOURCE" --network "$NETWORK" -- "${@:2}" 2>&1; }
value() { printf '%s' "$1" | tail -1 | tr -d '"'; }
code_of() { printf '%s' "$1" | grep -o 'Error(Contract, #[0-9]*)' | head -1 | grep -o '[0-9]\+'; }

report() { # name, expected, observed
  printf '%-34s %-26s %s\n' "$1" "$2" "$3"
  entries+=("{\"case\":\"$1\",\"expected\":\"$2\",\"observed\":\"$3\"}")
}

# The safe asset of this vault is the test token TST (the epoch floor is
# measured in it, and it cannot change while the epoch is live), so it stays in
# the allowlist. USDC trades change the risk both ways here.
TST=${TST:-CAJGMOESC4BH7LZ2NMPZVUKO7WWOWIXD7SHEW5QZYDWOL226ZIYJQ5ZG}
TEST_ROUTER=${TEST_ROUTER:-CBQRVMZNNISIVHHUPY4SMTMPCF3QZSW6JGNHB2REZ3EBY5Q7ZBRGVIL4}
config() { # $1 = max slippage bps, $2 = cooldown
  echo "{\"max_trade_size\":\"300000000\",\"cooldown_period\":${2:-0},\"allowed_tokens\":[\"$XLM\",\"$TST\",\"$USDC\"],\"allowed_routers\":[\"$TEST_ROUTER\",\"$ADAPTER\"],\"max_slippage_bps\":$1,\"safe_asset\":\"$TST\",\"floor_bps\":6000,\"lockin_bps\":1900,\"reflector_id\":\"$REFLECTOR\",\"asset_symbols\":{\"$XLM\":\"XLM\",\"$TST\":\"XLM\",\"$USDC\":\"USDC\"},\"deviation_bps\":500,\"staleness\":1800,\"decimals_offset\":3,\"mgmt_fee_bps\":0,\"perf_fee_bps\":0}"
}

strategy() { # token_in, token_out, amount_in, min_out
  send "$VAULT" execute_strategy --operator "$OPERATOR" --router "$ADAPTER" \
    --token_in "$1" --token_out "$2" --amount_in "$3" --min_amount_out "$4" \
    --nonce "$(value "$(inv "$VAULT" get_nonce)")" --deadline 9999999999 --path '[]'
}

echo "Vault:   $VAULT (test vault)"
echo "Adapter: $ADAPTER -> Soroswap router $SOROSWAP_ROUTER"

# The pool and the feed, side by side.
pair=$(value "$(inv "$(value "$(inv "$SOROSWAP_ROUTER" get_factory)")" get_pair --token_a "$XLM" --token_b "$USDC")")
reserves=$(inv "$pair" get_reserves | tail -1)
send "$VAULT" set_config --config "$(config "$MAX_SLIPPAGE_BPS")" >/dev/null
# Under the value floor, the sale of USDC for XLM adds risk: it needs a live epoch
# that is not stopped. A stress run leaves the test vault stopped and without XLM,
# so start a new epoch and put back the XLM that the refused direction sells.
if [ "$(value "$(inv "$VAULT" strategy_stopped)")" = "true" ]; then send "$VAULT" start_epoch >/dev/null; fi
if [ "$(value "$(inv "$XLM" balance --id "$VAULT")")" -lt "$BUY_AMOUNT" ]; then
  send "$VAULT" deposit --from "$OPERATOR" --assets "$BUY_AMOUNT" --receiver "$OPERATOR" >/dev/null
fi
oracle_price=$(value "$(inv "$VAULT" safe_price --asset "$USDC")")
echo "Pair:    $pair reserves $reserves"
echo "Oracle:  1 USDC = $(awk -v p="$oracle_price" 'BEGIN { printf "%.4f", p / 100000000000000 }') XLM"
echo

# --- 1. The unfavourable direction must be refused ------------------------
out=$(inv "$VAULT" execute_strategy --operator "$OPERATOR" --router "$ADAPTER" \
  --token_in "$XLM" --token_out "$USDC" --amount_in "$BUY_AMOUNT" --min_amount_out 1 \
  --nonce "$(value "$(inv "$VAULT" get_nonce)")" --deadline 9999999999 --path '[]')
report "buy USDC above the oracle price" "refused with 43" "error $(code_of "$out" || echo none)"

# --- 2. Make sure the vault holds USDC to sell ----------------------------
held=$(value "$(inv "$USDC" balance --id "$VAULT")")
if [ "$held" -lt "$SELL_AMOUNT" ]; then
  # Buy USDC on Soroswap with the operator account, then send it to the vault.
  send "$SOROSWAP_ROUTER" swap_exact_tokens_for_tokens --amount_in 200000000 --amount_out_min 1 \
    --path "[\"$XLM\",\"$USDC\"]" --to "$OPERATOR" --deadline 9999999999 >/dev/null
  send "$USDC" transfer --from "$OPERATOR" --to "$VAULT" --amount "$SELL_AMOUNT" >/dev/null
fi

# --- 3. The favourable direction must pass --------------------------------
nav_before=$(value "$(inv "$VAULT" total_assets)")
xlm_before=$(value "$(inv "$XLM" balance --id "$VAULT")")
out=$(strategy "$USDC" "$XLM" "$SELL_AMOUNT" 40000000)
hash=$(printf '%s' "$out" | grep -o 'tx/[0-9a-f]\{64\}' | head -1 | cut -d/ -f2)
nav_after=$(value "$(inv "$VAULT" total_assets)")
xlm_after=$(value "$(inv "$XLM" balance --id "$VAULT")")
received=$(( xlm_after - xlm_before ))
report "sell 1 USDC for XLM" "executed onchain" "${hash:-no hash} (+$(awk -v r="$received" 'BEGIN { printf "%.4f", r / 10000000 }') XLM)"
report "NAV follows the trade" "NAV rises with the fill" "$nav_before -> $nav_after"

send "$VAULT" set_config --config "$(config 100 300)" >/dev/null

echo
mkdir -p "$(dirname "$REPORT")"
{
  printf '{\n  "network": "%s",\n  "vault": "%s",\n  "adapter": "%s",\n  "soroswap_router": "%s",\n  "pair": "%s",\n' \
    "$NETWORK" "$VAULT" "$ADAPTER" "$SOROSWAP_ROUTER" "$pair"
  printf '  "pair_reserves": %s,\n  "oracle_price_usdc_in_xlm": "%s",\n  "max_slippage_bps": %s,\n' \
    "$reserves" "$oracle_price" "$MAX_SLIPPAGE_BPS"
  printf '  "checked_at": "%s",\n  "cases": [\n    ' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  first=1
  for e in "${entries[@]}"; do [ $first -eq 1 ] || printf ',\n    '; printf '%s' "$e"; first=0; done
  printf '\n  ]\n}\n'
} > "$REPORT"
echo "report: $REPORT"
