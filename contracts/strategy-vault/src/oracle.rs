use soroban_sdk::{contracttype, Address};

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Oracle trait — structured for future TWAP + external feed integration.
#[allow(dead_code)]
pub trait Oracle {
    fn get_price(&self, base: &Address, quote: &Address) -> Option<PriceData>;
    fn get_twap(&self, base: &Address, quote: &Address, period: u64) -> Option<PriceData>;
}

/// Mock oracle for testing with configurable fixed prices.
#[allow(dead_code)]
pub struct MockOracle {
    pub price: i128,
    pub timestamp: u64,
}

#[allow(dead_code)]
impl MockOracle {
    pub fn new(price: i128, timestamp: u64) -> Self {
        Self { price, timestamp }
    }
}

impl Oracle for MockOracle {
    fn get_price(&self, _base: &Address, _quote: &Address) -> Option<PriceData> {
        Some(PriceData {
            price: self.price,
            timestamp: self.timestamp,
        })
    }

    fn get_twap(&self, _base: &Address, _quote: &Address, _period: u64) -> Option<PriceData> {
        Some(PriceData {
            price: self.price,
            timestamp: self.timestamp,
        })
    }
}
