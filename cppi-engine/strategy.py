import os

# CPPI with ratchet steps, risky asset XLM, safe asset USDC.
# Ported from the 2025 Solana strategy (JitoSOL / USDC) with profit lock-in.
#
# PARAM: set with Wajih - do not default. The server does not start without these values.
# Legacy Solana values, for reference only: floor 0.6, multiplier 8, profit_lockin 0.19,
# limit order safety 1.02. The 2025-04-24 Solana backtest used profit_lockin 0.16.


def required_float(name):
    value = os.getenv(name)
    if value is None or value.strip() == "":
        raise RuntimeError(f"Missing required env var: {name} (PARAM: set with Wajih)")
    return float(value)


floor = required_float("CPPI_FLOOR") # Capital-protection floor: share of the initial capital that is protected (e.g., 0.6)
multiplier = required_float("CPPI_MULTIPLIER") # Risky exposure = multiplier x cushion
profit_lockin = required_float("CPPI_PROFIT_LOCKIN") # Ratchet step: each gain of profit_lockin x initial capital raises the floor by the same amount
limit_order_safety = required_float("CPPI_LIMIT_ORDER_SAFETY") # The limit order sits this factor above the floor-breach price (e.g., 1.02)

if not 0 < floor < 1:
    raise RuntimeError("CPPI_FLOOR must be between 0 and 1")
if multiplier <= 0:
    raise RuntimeError("CPPI_MULTIPLIER must be positive")
if profit_lockin <= 0:
    raise RuntimeError("CPPI_PROFIT_LOCKIN must be positive")
if limit_order_safety < 1:
    raise RuntimeError("CPPI_LIMIT_ORDER_SAFETY must be 1 or more")


def ratchet_floor(max_nav, initial_capital):
    # Floor for the number of ratchet steps that max_nav reached.
    # max_nav never goes down, so the floor never goes down.
    ratchet_steps = int((max_nav - initial_capital) / (initial_capital * profit_lockin))
    ratchet_steps = max(ratchet_steps, 0) # a max_nav below the initial capital must not lower the floor
    floor_value = initial_capital * (floor + ratchet_steps * profit_lockin)
    return floor_value, ratchet_steps


def cppi_strategy(
    pricerisky, # Latest price of the risky asset (XLM, USD, float)
    pricesafe, # Latest price of the safe asset (e.g., USDC = 1, float)
    nav, # Portfolio NAV at the *previous* rebalance (e.g., 80000 USD, float)
    max_nav, # Highest NAV observed so far (e.g., 100000 USD, float)
    quantityrisky, # Units of the risky asset currently held (e.g., 4000 XLM, float)
    quantitysafe, # Units of the safe asset currently held (e.g., 1000 USDC, float)
    initial_capital # Capital at inception (e.g., 1000 USD, float)
    ):
    global floor
    global multiplier
    global profit_lockin
    global limit_order_safety

    floor_value, ratchet_steps = ratchet_floor(max_nav, initial_capital)

    new_nav = quantityrisky*pricerisky + quantitysafe*pricesafe

    print("XLM Strategy")
    print("initial_capital: ", initial_capital)
    print("floor: ", floor)
    print("multiplier: ", multiplier)
    print("profit_lockin: ", profit_lockin)
    print("new_nav: ", new_nav)
    print("nav: ", nav)
    print("max_nav argument before update: ", max_nav)
    print("Floor value argument before update:", floor_value)
    print("ratchet_steps before update: ", ratchet_steps)

    if new_nav > max_nav :
        max_nav = new_nav
        print("new max_nav argument after update: ", max_nav)
        new_floor, new_ratchet_steps = ratchet_floor(max_nav, initial_capital)
        if new_floor > floor_value :
            floor_value = new_floor
            ratchet_steps = new_ratchet_steps
            print("new Floor value argument after update: ", floor_value)
            print("new ratchet_steps after update: ", ratchet_steps)

    cushion = new_nav - floor_value
    risky_target = max(min(cushion * multiplier, new_nav), 0)
    safe_target = new_nav - risky_target
    print("cushion: ", cushion)
    print("risky_target: ", risky_target)
    print("safe_target: ", safe_target)

    # --- Convert dollar targets to asset quantities ------------------------
    quantityrisky = risky_target/pricerisky
    quantitysafe = safe_target/pricesafe

    # Limit order: XLM price at which the NAV touches the floor, times the safety factor.
    # If the safe leg alone covers the floor, no limit order is necessary.
    if quantityrisky != 0 and floor_value > safe_target : #avoid division by 0
        limit_order = ((floor_value - safe_target) / quantityrisky) * limit_order_safety
    else :
        limit_order = 0 #no risky asset or floor already covered, we don't need a limit order
    print("limit_order: ", limit_order)

    return quantityrisky, quantitysafe, new_nav, max_nav, limit_order, floor_value, ratchet_steps
    # quantityrisky: quantity of risky asset to own in token,
    # quantitysafe: quantity of safe asset to own in token,
    # new_nav: net asset value now in USD,
    # max_nav: max value of nav until now in USD,
    # limit_order: price in USD of risky asset triggering a sale of all remaining risky assets into safe assets,
    # floor_value: protected value in USD after the ratchet steps,
    # ratchet_steps: number of profit lock-in steps reached by max_nav
