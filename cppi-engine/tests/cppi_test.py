import pytest

from strategy import cppi_strategy, ratchet_floor

# Test parameters (pyproject.toml): floor 0.6, multiplier 8, profit_lockin 0.19, limit order safety 1.02


def test_floor_at_inception():
    """No gain yet: the floor is floor x initial capital"""
    floor_value, ratchet_steps = ratchet_floor(max_nav=100.0, initial_capital=100.0)

    assert ratchet_steps == 0
    assert floor_value == pytest.approx(60.0)


def test_ratchet_steps_raise_the_floor():
    """max_nav 138.5 is two full steps of 19 above 100: the floor is 100 x (0.6 + 2 x 0.19)"""
    floor_value, ratchet_steps = ratchet_floor(max_nav=138.5, initial_capital=100.0)

    assert ratchet_steps == 2
    assert floor_value == pytest.approx(98.0)


def test_max_nav_below_initial_capital_keeps_the_base_floor():
    """A max_nav below the initial capital must not give negative steps"""
    floor_value, ratchet_steps = ratchet_floor(max_nav=50.0, initial_capital=100.0)

    assert ratchet_steps == 0
    assert floor_value == pytest.approx(60.0)


def test_full_risky_allocation_when_cushion_is_large():
    """Cushion 40 x multiplier 8 is more than the NAV: all the NAV goes to XLM"""
    quantityrisky, quantitysafe, new_nav, max_nav, limit_order, floor_value, ratchet_steps = cppi_strategy(
        pricerisky=0.5, pricesafe=1.0, nav=100.0, max_nav=100.0,
        quantityrisky=100.0, quantitysafe=50.0, initial_capital=100.0
    )

    assert new_nav == pytest.approx(100.0)
    assert quantityrisky == pytest.approx(200.0)
    assert quantitysafe == pytest.approx(0.0)
    assert floor_value == pytest.approx(60.0)
    # NAV touches the floor when 200 XLM are worth 60 USD: 0.30 USD, times 1.02
    assert limit_order == pytest.approx(0.306)


def test_new_high_raises_max_nav_and_floor():
    """NAV 120 is a new high and one full step above 100: the floor goes to 79"""
    quantityrisky, quantitysafe, new_nav, max_nav, limit_order, floor_value, ratchet_steps = cppi_strategy(
        pricerisky=1.0, pricesafe=1.0, nav=110.0, max_nav=110.0,
        quantityrisky=120.0, quantitysafe=0.0, initial_capital=100.0
    )

    assert new_nav == pytest.approx(120.0)
    assert max_nav == pytest.approx(120.0)
    assert ratchet_steps == 1
    assert floor_value == pytest.approx(79.0)


def test_floor_stays_locked_when_nav_falls():
    """max_nav 140 locked two steps (floor 98). NAV falls to 110: the floor stays at 98"""
    quantityrisky, quantitysafe, new_nav, max_nav, limit_order, floor_value, ratchet_steps = cppi_strategy(
        pricerisky=1.0, pricesafe=1.0, nav=140.0, max_nav=140.0,
        quantityrisky=110.0, quantitysafe=0.0, initial_capital=100.0
    )

    assert max_nav == pytest.approx(140.0)
    assert floor_value == pytest.approx(98.0)
    # cushion 12 x multiplier 8 = 96 USD of XLM, 14 USD of USDC
    assert quantityrisky == pytest.approx(96.0)
    assert quantitysafe == pytest.approx(14.0)


def test_nav_below_floor_moves_everything_to_safe():
    """NAV 55 is below the floor of 60: no XLM and no limit order"""
    quantityrisky, quantitysafe, new_nav, max_nav, limit_order, floor_value, ratchet_steps = cppi_strategy(
        pricerisky=1.0, pricesafe=1.0, nav=70.0, max_nav=100.0,
        quantityrisky=55.0, quantitysafe=0.0, initial_capital=100.0
    )

    assert quantityrisky == pytest.approx(0.0)
    assert quantitysafe == pytest.approx(55.0)
    assert limit_order == 0


def test_limit_order_is_the_floor_breach_price_with_safety():
    """NAV 61.25, cushion 1.25 x 8 = 10 USD of XLM and 51.25 USD of USDC"""
    quantityrisky, quantitysafe, new_nav, max_nav, limit_order, floor_value, ratchet_steps = cppi_strategy(
        pricerisky=1.0, pricesafe=1.0, nav=100.0, max_nav=100.0,
        quantityrisky=0.0, quantitysafe=61.25, initial_capital=100.0
    )

    assert quantityrisky == pytest.approx(10.0)
    assert quantitysafe == pytest.approx(51.25)
    # 51.25 + 10 x price = 60 when price = 0.875, times 1.02
    assert limit_order == pytest.approx(0.8925)
