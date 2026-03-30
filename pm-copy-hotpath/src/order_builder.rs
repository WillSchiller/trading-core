//! CLOB HTTP order path (`https://clob.polymarket.com`) via `polymarket-client-sdk`.
//!
//! **Warm path (startup):** `authenticate()` derives L2 credentials and reuses the shared `reqwest` client inside the SDK — that is the practical “pre-warm” (no static EIP-712 template: nonce / expiration change every order).
//!
//! **Hot path:** `market_order` / `limit_order` builders → `sign` → `post_order` (FAK then optional GTC on BUY, FAK on SELL).

use std::str::FromStr as _;
use std::sync::Arc;

use alloy::signers::Signer as _;
use alloy::signers::local::PrivateKeySigner;
use polymarket_client_sdk::POLYGON;
use polymarket_client_sdk::clob::types::{Amount, OrderType, Side, SignatureType};
use polymarket_client_sdk::clob::{Client, Config};
use polymarket_client_sdk::types::{Decimal, U256};
use rust_decimal_macros::dec;
use tracing::{instrument, warn};

use crate::config::AppConfig;
use crate::types::{CopySide, HotPathError, TradeSignal};

#[derive(Debug, Clone)]
pub struct OrderResult {
    pub order_id: String,
    pub status: &'static str,
    pub fill_price: f64,
}

#[derive(Debug, Clone)]
pub enum OrderOutcome {
    FakFilled(OrderResult),
    GtcPosted(OrderResult),
    BalanceError,
    PriceBand,
    BookEmpty,
    BelowMinimum,
    DryRun,
}

type AuthClient = polymarket_client_sdk::clob::Client<
    polymarket_client_sdk::auth::state::Authenticated<polymarket_client_sdk::auth::Normal>,
>;

pub struct OrderExecutor {
    client: AuthClient,
    signer: Arc<PrivateKeySigner>,
    dry_run: bool,
}

impl OrderExecutor {
    pub async fn connect(config: &AppConfig) -> Result<Option<Self>, HotPathError> {
        let pk = match std::env::var(polymarket_client_sdk::PRIVATE_KEY_VAR) {
            Ok(k) if !k.is_empty() => k,
            _ => {
                if config.dry_run {
                    return Ok(None);
                }
                return Err(HotPathError::Config(format!(
                    "Set {} for live trading (or enable dry_run)",
                    polymarket_client_sdk::PRIVATE_KEY_VAR
                )));
            }
        };

        let signer = Arc::new(
            PrivateKeySigner::from_str(&pk)
                .map_err(|e| HotPathError::Clob(e.to_string()))?
                .with_chain_id(Some(POLYGON)),
        );

        let clob_cfg = Config::builder().use_server_time(true).build();
        let base = Client::new(&config.clob_http_url, clob_cfg)?;

        let sig_ty = match config.signature_type {
            1 => SignatureType::Proxy,
            2 => SignatureType::GnosisSafe,
            _ => SignatureType::Eoa,
        };

        let mut auth_b = base.authentication_builder(signer.as_ref());
        if sig_ty != SignatureType::Eoa {
            auth_b = auth_b.signature_type(sig_ty);
        }

        let client = auth_b.authenticate().await?;

        Ok(Some(Self {
            client,
            signer,
            dry_run: config.dry_run,
        }))
    }

    /// Same-side copy: **BUY** = USDC notional FAK (+ GTC fallback); **SELL** = share FAK at trader price (no GTC fallback in this minimal path).
    #[instrument(skip(self), fields(token = %signal.token_id, trader = %signal.trader, side = ?signal.side))]
    pub async fn execute_copy(
        &self,
        signal: &TradeSignal,
        size_usd: f64,
        min_entry: f64,
        max_entry: f64,
    ) -> Result<OrderOutcome, HotPathError> {
        match signal.side {
            CopySide::Buy => {
                self.execute_copy_buy(signal, size_usd, min_entry, max_entry)
                    .await
            }
            CopySide::Sell => {
                tracing::debug!("SELL signal ignored — handled by Node position tracker");
                Ok(OrderOutcome::DryRun)
            }
        }
    }

    async fn execute_copy_buy(
        &self,
        signal: &TradeSignal,
        size_usd: f64,
        min_entry: f64,
        max_entry: f64,
    ) -> Result<OrderOutcome, HotPathError> {
        if size_usd < 1.0 {
            warn!(size_usd, "below $1 minimum");
            return Ok(OrderOutcome::BelowMinimum);
        }

        if signal.price < min_entry || signal.price > max_entry {
            warn!(
                price = signal.price,
                min_entry, max_entry, "entry price band"
            );
            return Ok(OrderOutcome::PriceBand);
        }

        let token_id =
            U256::from_str(&signal.token_id).map_err(|e| HotPathError::Clob(e.to_string()))?;

        let tick = dec!(0.01);
        let rounded = (Decimal::from_f64_retain(signal.price)
            .ok_or_else(|| HotPathError::Config("bad signal.price".to_owned()))?
            / tick)
            .round_dp(0)
            * tick;

        if self.dry_run {
            tracing::info!(
                %token_id,
                %rounded,
                size_usd,
                "dry_run: BUY FAK then maybe GTC"
            );
            return Ok(OrderOutcome::DryRun);
        }

        let usdc = Decimal::from_f64_retain(size_usd)
            .ok_or_else(|| HotPathError::Config("bad size_usd".to_owned()))?;
        let amount = Amount::usdc(usdc).map_err(|e| HotPathError::Clob(e.to_string()))?;

        let market = self
            .client
            .market_order()
            .token_id(token_id)
            .amount(amount)
            .side(Side::Buy)
            .price(rounded)
            .order_type(OrderType::FAK)
            .build()
            .await?;

        let signed = self
            .client
            .sign(self.signer.as_ref(), market)
            .await
            .map_err(HotPathError::from)?;
        match self.client.post_order(signed).await {
            Ok(posted) if posted.success => {
                tracing::info!(order_id = %posted.order_id, "BUY FAK posted");
                return Ok(OrderOutcome::FakFilled(OrderResult {
                    order_id: posted.order_id,
                    status: "filled",
                    fill_price: rounded.to_string().parse().unwrap_or(signal.price),
                }));
            }
            Ok(posted) => {
                tracing::debug!("FAK not matched, falling through to GTC");
                let _ = posted;
            }
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("not enough balance") {
                    tracing::debug!("FAK rejected: no balance — skipping GTC");
                    return Ok(OrderOutcome::BalanceError);
                }
                tracing::debug!(error = %e, "FAK error, falling through to GTC");
            }
        }

        let gtc_raw = (rounded + dec!(0.05)).min(dec!(0.99));
        let gtc_price = (gtc_raw / tick).round_dp(0) * tick;

        // CLOB minimum is ~5 shares; use whichever is larger: $size_usd worth or 5 shares
        let natural_shares = Decimal::from_f64_retain(size_usd).unwrap() / gtc_price;
        let size_shares = natural_shares.max(dec!(5)).round_dp(2);

        let limit = self
            .client
            .limit_order()
            .token_id(token_id)
            .price(gtc_price)
            .size(size_shares)
            .side(Side::Buy)
            .order_type(OrderType::GTC)
            .build()
            .await?;

        let signed = self
            .client
            .sign(self.signer.as_ref(), limit)
            .await
            .map_err(HotPathError::from)?;
        match self.client.post_order(signed).await {
            Ok(posted) if posted.success => {
                tracing::info!(order_id = %posted.order_id, %gtc_price, "BUY GTC fallback posted");
                return Ok(OrderOutcome::GtcPosted(OrderResult {
                    order_id: posted.order_id,
                    status: "pending",
                    fill_price: gtc_price.to_string().parse().unwrap_or(signal.price),
                }));
            }
            Ok(posted) => {
                warn!(?posted, "BUY GTC fallback rejected");
            }
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("not enough balance") {
                    return Ok(OrderOutcome::BalanceError);
                }
                warn!(error = %e, "GTC error");
            }
        }

        Ok(OrderOutcome::BookEmpty)
    }

    pub async fn get_order(
        &self,
        order_id: &str,
    ) -> Result<polymarket_client_sdk::clob::types::response::OpenOrderResponse, HotPathError> {
        self.client
            .order(order_id)
            .await
            .map_err(HotPathError::from)
    }

    pub async fn cancel_order(&self, order_id: &str) -> Result<(), HotPathError> {
        self.client
            .cancel_order(order_id)
            .await
            .map_err(HotPathError::from)?;
        Ok(())
    }

    pub async fn execute_sell(
        &self,
        signal: &TradeSignal,
        shares: f64,
    ) -> Result<Option<OrderResult>, HotPathError> {
        if shares < 1.0 {
            warn!(shares, "SELL below minimum share size (1)");
            return Ok(None);
        }

        let token_id =
            U256::from_str(&signal.token_id).map_err(|e| HotPathError::Clob(e.to_string()))?;

        let tick = dec!(0.01);
        let sell_price = (Decimal::from_f64_retain(signal.price)
            .ok_or_else(|| HotPathError::Config("bad signal.price".to_owned()))?
            / tick)
            .round_dp(0)
            * tick;
        let sell_price = sell_price.min(dec!(0.99));

        if self.dry_run {
            tracing::info!(%token_id, %sell_price, shares, "dry_run: SELL FAK");
            return Ok(None);
        }

        let share_dec = Decimal::from_f64_retain(shares)
            .ok_or_else(|| HotPathError::Config("bad shares".to_owned()))?
            .round_dp(2)
            .max(dec!(1));
        let amount = Amount::shares(share_dec).map_err(|e| HotPathError::Clob(e.to_string()))?;

        // Try FAK first
        let market = self
            .client
            .market_order()
            .token_id(token_id)
            .amount(amount)
            .side(Side::Sell)
            .price(sell_price)
            .order_type(OrderType::FAK)
            .build()
            .await?;

        let signed = self
            .client
            .sign(self.signer.as_ref(), market)
            .await
            .map_err(HotPathError::from)?;

        match self.client.post_order(signed).await {
            Ok(posted) if posted.success => {
                tracing::info!(order_id = %posted.order_id, "SELL FAK posted");
                return Ok(Some(OrderResult {
                    order_id: posted.order_id,
                    status: "sold",
                    fill_price: sell_price.to_string().parse().unwrap_or(signal.price),
                }));
            }
            Ok(_) => {
                tracing::debug!("SELL FAK not matched, trying GTC");
            }
            Err(e) => {
                tracing::debug!(error = %e, "SELL FAK error, trying GTC");
            }
        }

        // GTC fallback
        let limit = self
            .client
            .limit_order()
            .token_id(token_id)
            .price(sell_price)
            .size(share_dec)
            .side(Side::Sell)
            .order_type(OrderType::GTC)
            .build()
            .await?;

        let signed = self
            .client
            .sign(self.signer.as_ref(), limit)
            .await
            .map_err(HotPathError::from)?;
        let posted = self.client.post_order(signed).await?;

        if posted.success {
            tracing::info!(order_id = %posted.order_id, %sell_price, "SELL GTC posted");
            return Ok(Some(OrderResult {
                order_id: posted.order_id,
                status: "pending_sell",
                fill_price: sell_price.to_string().parse().unwrap_or(signal.price),
            }));
        }

        warn!("SELL GTC rejected");
        Ok(None)
    }
}
