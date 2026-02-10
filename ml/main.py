import pandas as pd
import numpy as np
from sqlalchemy import create_engine

# =========================
# 1. SETUP & CONNECTION
# =========================

DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"
engine = create_engine(DB_URI)
IST = "Asia/Kolkata"

def to_ist_index(df):
    df.index = df.index.tz_localize("UTC").tz_convert(IST)
    return df

def load_table(table):
    print(f"Loading {table}...")
    query = f"SELECT timestamp, open, high, low, close, volume FROM {table} ORDER BY timestamp"
    df = pd.read_sql(query, engine, parse_dates=["timestamp"])
    df.set_index("timestamp", inplace=True)
    df = to_ist_index(df)
    df = df.astype(float, errors="ignore")
    return df

def load_vix():
    print("Loading india_vix_1min...")
    query = "SELECT timestamp, close FROM india_vix_1min ORDER BY timestamp"
    df = pd.read_sql(query, engine, parse_dates=["timestamp"])
    df.set_index("timestamp", inplace=True)
    df = to_ist_index(df)
    df["close"] = df["close"].astype(float)
    return df

# =========================
# 2. MATH FUNCTIONS
# =========================

def log_returns(series):
    return np.log(series / series.shift(1))

def realized_volatility(r, window):
    return np.sqrt((r ** 2).rolling(window).sum())

def parkinson_vol(high, low):
    return (1.0 / (4.0 * np.log(2.0))) * (np.log(high / low) ** 2)

def gk_vol(open_, high, low, close):
    return (
        0.5 * (np.log(high / low) ** 2)
        - (2 * np.log(2) - 1) * (np.log(close / open_) ** 2)
    )

# =========================
# 3. LOAD & FILTER DATA
# =========================

nifty = load_table("nifty_spot_1min")
vix = load_vix()

stocks = {
    "hdfc": load_table("hdfc_spot_1min"),
    "ril": load_table("ril_spot_1min"),
    "icici": load_table("icici_spot_1min"),
    "infy": load_table("infy_spot_1min"),
    "tcs": load_table("tcs_spot_1min"),
    "lt": load_table("lt_spot_1min"),
    "bharti": load_table("bhartiart_spot_1min"),
}

# FILTER MARKET HOURS (09:15 to 15:30)
def filter_market_hours(df):
    minutes = df.index.hour * 60 + df.index.minute
    return df[(minutes >= 555) & (minutes <= 930)]

nifty = filter_market_hours(nifty)
vix = filter_market_hours(vix)
for k, v in stocks.items():
    stocks[k] = filter_market_hours(v)

# =========================
# 4. FEATURE ENGINEERING
# =========================

df = nifty.copy()

# --- A. Price Features ---
df["ret"] = log_returns(df["close"])
df["rv_5"] = realized_volatility(df["ret"], 5)
df["rv_15"] = realized_volatility(df["ret"], 15)
df["rv_30"] = realized_volatility(df["ret"], 30)

df["parkinson"] = parkinson_vol(df["high"], df["low"]).rolling(15).mean()
df["gk"] = gk_vol(df["open"], df["high"], df["low"], df["close"]).rolling(15).mean()

df["range"] = df["high"] - df["low"]
df["abs_return"] = (df["close"] - df["open"]).abs()
df["std_15"] = df["close"].rolling(15).std()

# --- B. Synthetic Volume Feature (The Fix) ---
# Sum volume of all constituents to get a "Market Volume" proxy
constituent_vol = pd.DataFrame()
for name, s in stocks.items():
    constituent_vol[name] = s["volume"]

# Sum across columns (axis=1) to get total volume per minute
df["total_const_vol"] = constituent_vol.sum(axis=1)

# Calculate Volume Spike using this synthetic volume
# Adding 1 to denominator to avoid division by zero
vol_mean = df["total_const_vol"].rolling(15).mean() + 1
df["vol_spike"] = df["total_const_vol"] / vol_mean

# --- C. VIX Features ---
vix_feats = pd.DataFrame(index=vix.index)
vix_feats["vix"] = vix["close"]
vix_feats["vix_ret"] = log_returns(vix["close"])
vix_feats["vix_mom_5"] = vix["close"] - vix["close"].shift(5)
df = df.join(vix_feats, how="left")

# --- D. Constituent Dispersion ---
stock_returns = pd.DataFrame()
for name, s in stocks.items():
    stock_returns[f"{name}_ret"] = log_returns(s["close"])

df = df.join(stock_returns, how="left")
df["dispersion"] = stock_returns.std(axis=1)
df["constituent_rv"] = (stock_returns.pow(2).rolling(5).sum().pow(0.5)).mean(axis=1)

# --- E. Time Features (Corrected) ---
minutes_from_midnight = df.index.hour * 60 + df.index.minute
df["minute_of_day"] = minutes_from_midnight - 555 # 0 at 09:15
df["sin_time"] = np.sin(2 * np.pi * df["minute_of_day"] / 375.0)
df["cos_time"] = np.cos(2 * np.pi * df["minute_of_day"] / 375.0)

# =========================
# 5. TARGET & CLEANUP
# =========================

# Target: Next 15 mins volatility
future_r = df["ret"].shift(-1)
df["target_vol_15"] = np.sqrt((future_r ** 2).rolling(15).sum().shift(-15))

# Final Clean
# We expect to lose ~45 rows (30 for rolling start + 15 for target end)
original_len = len(df)
df = df.dropna()
final_len = len(df)

print(f"Data Processed. Rows: {original_len} -> {final_len}")
print(f"Dropped {original_len - final_len} rows (expected due to rolling windows).")

# =========================
# 6. SAVE TO POSTGRES (UTC)
# =========================

df_to_save = df.copy()
df_to_save.index = df_to_save.index.tz_convert("UTC").tz_localize(None)

print("Saving to Postgres...")
df_to_save.to_sql(
    "nifty_volatility_features_1min",
    engine,
    if_exists="replace",
    index=True,
    chunksize=5000 # Good for large writes
)
print("Success.")