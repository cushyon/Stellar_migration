import os
import sys
import traceback
from contextlib import asynccontextmanager
from datetime import datetime

from dotenv import load_dotenv

# Load the env before the strategy import: strategy.py reads its parameters at import time.
load_dotenv()

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from strategy import cppi_strategy

print("=== Application Starting ===")
print(f"Start time: {datetime.now()}")
print(f"Environment: {os.getenv('ENVIRONMENT', 'Not set')}")
print(f"Python version: {sys.version}")
print(f"PORT: {os.getenv('PORT', '8000')}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("\n=== FastAPI Startup Event ===")
    print(f"Startup time: {datetime.now()}")
    print(f"ALLOWED_ORIGINS: {os.getenv('ALLOWED_ORIGINS', 'Not set')}")
    print("=== FastAPI Startup Complete ===\n")
    yield
    print("\n=== FastAPI Shutdown Event ===")
    print(f"Shutdown time: {datetime.now()}")
    print("=== FastAPI Shutdown Complete ===\n")


app = FastAPI(
    title="Cushion CPPI Engine",
    description="CPPI strategy with ratchet steps for the Cushion Stellar vault (risky XLM, safe USDC)",
    version="0.1.0",
    lifespan=lifespan,
)

# The orchestrator calls this service server to server, so CORS is closed unless ALLOWED_ORIGINS is set.
allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )


# Request log without headers (headers can carry credentials)
@app.middleware("http")
async def log_requests(request: Request, call_next):
    print(f"\n=== Request Started ===")
    print(f"Time: {datetime.now()}")
    print(f"Request: {request.method} {request.url.path}")

    try:
        response = await call_next(request)
        print(f"Response status: {response.status_code}")
        print("=== Request Completed ===\n")
        return response
    except Exception as e:
        print(f"Error processing request: {str(e)}")
        print(f"Error type: {type(e).__name__}")
        print(f"Full traceback:\n{traceback.format_exc()}")
        print("=== Request Failed ===\n")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": "Internal server error"}
        )


def error_response(status_code, message):
    return JSONResponse(
        status_code=status_code,
        content={
            "status": "error",
            "message": message,
            "timestamp": str(datetime.now())
        }
    )


@app.get("/")
async def root():
    print("Root endpoint called")
    return {"message": "Cushion CPPI Engine", "status": "ok"}


@app.get("/health")
async def health_check():
    print("Health check endpoint called")
    return {
        "status": "healthy",
        "timestamp": str(datetime.now()),
        "environment": os.getenv("ENVIRONMENT", "production")
    }


# Same body as the Solana endpoint (/strategy/solana), so the orchestrator code stays the same.
class StellarStrategyRequest(BaseModel):
    price_risky: float  # Latest price of the risky asset (XLM, USD)
    price_safe: float  # Latest price of the safe asset (USDC, USD)
    nav: float  # Portfolio NAV at the previous rebalance (USD)
    max_nav: float  # Highest NAV observed so far (USD)
    risky_amount: float  # Units of XLM currently held
    safe_amount: float  # Units of USDC currently held
    initial_capital: float  # Capital at inception (USD)


@app.post("/strategy/stellar")
async def stellar_strategy(request: StellarStrategyRequest):
    """
    Execute the Stellar CPPI strategy (risky XLM, safe USDC) with ratchet steps

    This endpoint accepts the parameters as StellarStrategyRequest type and returns the calculated
    percents and limit order for portfolio rebalancing, plus the values that the orchestrator must store.
    """
    print(f"\n=== Stellar Rebalance Request Started at {datetime.now()} ===")
    print(f"Request data: {request.model_dump()}")

    # Validate input parameters
    if request.risky_amount < 0 or request.safe_amount < 0:
        return error_response(400, "Amount cannot be negative")

    if request.price_risky <= 0 or request.price_safe <= 0:
        return error_response(400, "Prices must be positive")

    if request.initial_capital <= 0:
        return error_response(400, "Initial capital must be positive")

    if request.nav < 0 or request.max_nav < 0:
        return error_response(400, "NAV cannot be negative")

    if request.risky_amount == 0 and request.safe_amount == 0:
        return error_response(400, "Portfolio is empty")

    try:
        print(f"Starting Stellar CPPI calculation at {datetime.now()}")
        calculation_start = datetime.now()

        (
            new_quantity_risky,
            new_quantity_safe,
            new_nav,
            new_max_nav,
            limit_order,
            floor_value,
            ratchet_steps,
        ) = cppi_strategy(
            request.price_risky,
            request.price_safe,
            request.nav,
            request.max_nav,
            request.risky_amount,
            request.safe_amount,
            request.initial_capital
        )

        calculation_duration = (datetime.now() - calculation_start).total_seconds()
        print(f"Stellar CPPI calculation completed in {calculation_duration:.4f} seconds")

        percentage_risky = new_quantity_risky * request.price_risky / new_nav * 100
        percentage_safe = new_quantity_safe * request.price_safe / new_nav * 100

        response_data = {
            "percentageAsset1": percentage_risky,  # XLM share of the NAV, in %
            "percentageAsset2": percentage_safe,  # USDC share of the NAV, in %
            "limitOrderPrice": limit_order,  # XLM price in USD that triggers a sale of all XLM into USDC (0 = none)
            "quantityRisky": new_quantity_risky,  # target XLM units
            "quantitySafe": new_quantity_safe,  # target USDC units
            "newNav": new_nav,  # NAV now, in USD
            "newMaxNav": new_max_nav,  # store it: max_nav for the next call
            "floorValue": floor_value,  # protected value in USD after the ratchet steps
            "ratchetSteps": ratchet_steps,  # profit lock-in steps reached
        }
        print(f"Results: {response_data}")
        print(f"=== Stellar Rebalance Request Completed ===\n")
        return response_data

    except Exception as e:
        print(f"Error in stellar strategy: {str(e)}")
        print(f"Error type: {type(e).__name__}")
        print(f"Full traceback:\n{traceback.format_exc()}")
        print(f"=== Stellar Rebalance Request Failed ===\n")
        return error_response(500, "Calculation failed")
