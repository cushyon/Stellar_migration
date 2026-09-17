import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

VALID_REQUEST = {
    "price_risky": 0.5,
    "price_safe": 1.0,
    "nav": 10000.0,
    "max_nav": 10000.0,
    "risky_amount": 10000.0,
    "safe_amount": 5000.0,
    "initial_capital": 10000.0
}


def test_stellar_strategy_success():
    """Test successful POST request to /strategy/stellar endpoint"""
    # Arrange: prepare test data
    request_data = dict(VALID_REQUEST)

    # Act: make POST request
    response = client.post("/strategy/stellar", json=request_data)

    # Assert: verify response
    assert response.status_code == 200

    json = response.json()
    for key in ["percentageAsset1", "percentageAsset2", "limitOrderPrice", "newNav", "newMaxNav", "floorValue"]:
        assert isinstance(json[key], (int, float))
    assert isinstance(json["ratchetSteps"], int)
    assert json["limitOrderPrice"] > 0
    assert json["floorValue"] == pytest.approx(6000.0)

    # Verify percentages add up to approximately 100%
    total_percentage = json["percentageAsset1"] + json["percentageAsset2"]
    assert 99.0 <= total_percentage <= 101.0, f"Total percentage should be ~100%, got {total_percentage}"


def test_stellar_strategy_negative_amounts():
    """Test POST request with negative amounts (should return 400)"""
    request_data = dict(VALID_REQUEST, risky_amount=-50.0)

    response = client.post("/strategy/stellar", json=request_data)

    assert response.status_code == 400
    assert response.json()["status"] == "error"
    assert "cannot be negative" in response.json()["message"].lower()


def test_stellar_strategy_invalid_prices():
    """Test POST request with invalid (zero or negative) prices"""
    request_data = dict(VALID_REQUEST, price_risky=0.0)

    response = client.post("/strategy/stellar", json=request_data)

    assert response.status_code == 400
    assert response.json()["status"] == "error"
    assert "must be positive" in response.json()["message"].lower()


def test_stellar_strategy_zero_initial_capital():
    """Test POST request with zero initial capital (would divide by zero)"""
    request_data = dict(VALID_REQUEST, initial_capital=0.0)

    response = client.post("/strategy/stellar", json=request_data)

    assert response.status_code == 400
    assert "initial capital" in response.json()["message"].lower()


def test_stellar_strategy_empty_portfolio():
    """Test POST request with no XLM and no USDC (NAV 0 would divide by zero)"""
    request_data = dict(VALID_REQUEST, risky_amount=0.0, safe_amount=0.0)

    response = client.post("/strategy/stellar", json=request_data)

    assert response.status_code == 400
    assert "empty" in response.json()["message"].lower()


def test_stellar_strategy_missing_fields():
    """Test POST request with missing required fields"""
    request_data = {
        "price_risky": 0.5,
        "price_safe": 1.0
    }

    response = client.post("/strategy/stellar", json=request_data)

    assert response.status_code == 422


def test_stellar_strategy_invalid_types():
    """Test POST request with invalid data types"""
    request_data = dict(VALID_REQUEST, price_risky="invalid")

    response = client.post("/strategy/stellar", json=request_data)

    assert response.status_code == 422


def test_health():
    """Test the health endpoint"""
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
