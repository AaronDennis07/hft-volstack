import pandas as pd
import numpy as np
import xgboost as xgb
from sqlalchemy import create_engine
import sys

# =========================
# 1. SETUP & CONNECTION
# =========================
DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"
engine = create_engine(DB_URI)
IST = "Asia/Kolkata"

print("--- STEP 1: Loading Saved Model ---")
try:
    model = xgb.XGBRegressor()
    model.load_model("nifty_vol_final.json")
    print("Model loaded successfully.")
except Exception as e:
    print(f"Error loading model: {e}")
    sys.exit(1)

# =========================
# 2. FETCH LATEST DATA
# =========================
print("--- STEP 2: Fetching Latest Data from Postgres ---")
# We need ~400 rows minimum to calculate the 'vol_lag_day' (375 mins)
# We fetch 600 to be safe.
query = """
    SELECT * FROM nifty_volatility_features_1min 
    ORDER BY "timestamp" DESC 
    LIMIT 600
"""
df = pd.read_sql(query, engine, parse_dates=["timestamp"])

# Sort chronologically (Oldest -> Newest) for rolling calculations
df.set_index("timestamp", inplace=True)
df.sort_index(inplace=True)

if len(df) < 400:
    print(f"WARNING: Only fetched {len(df)} rows. 'vol_lag_day' (Seasonality) will be NaN.")

# =========================
# 3. RE-ENGINEER FEATURES (Match Train.py Logic)
# =========================
print("--- STEP 3: Engineering Features on Live Data ---")

# A. Volatility Regime & Trend
df["vol_regime"] = df["rv_5"] / (df["rv_30"] + 1e-9)
df["vol_trend"] = df["rv_5"] - df["rv_15"]

# B. Autoregression (Lags)
# We must recreate 'past_vol_15' to get the lags
df["past_vol_15"] = df["ret"].rolling(15).std()

df["vol_lag_15"] = df["past_vol_15"].shift(15)
df["vol_lag_30"] = df["past_vol_15"].shift(30)
df["vol_lag_60"] = df["past_vol_15"].shift(60)
df["vol_lag_day"] = df["past_vol_15"].shift(375)

# =========================
# 4. ALIGN FEATURES
# =========================
# This list MUST exactly match the order in train.py
# 1. Standard Features
feature_list = [
    'ret', 'rv_5', 'rv_15', 'rv_30', 
    'parkinson', 'gk', 'range', 'abs_return', 'std_15',
    'vol_spike', 
    'vix', 'vix_ret', 'vix_mom_5',
    'dispersion', 'constituent_rv',
    'sin_time', 'cos_time', 'vol_regime', 'vol_trend',
    'vol_lag_15', 'vol_lag_30', 'vol_lag_60', 'vol_lag_day'
]

# 2. Add Constituent Returns (Dynamic check like in train.py)
# We look for columns ending in _ret, excluding 'ret' and 'vix_ret'
const_feats = [c for c in df.columns if "_ret" in c and "vix" not in c and c != "ret"]

# Important: Sort or ensure order matches training. 
# In train.py, it was: features += const_feats
# We trust pandas preserves column order from SQL, but to be safe, we append them found in df.
feature_list += const_feats

print(f"Total Features used for prediction: {len(feature_list)}")

# =========================
# 5. SELECT LAST ROW & PREDICT
# =========================
# Get the very last minute (Latest Data)
latest_row = df.iloc[[-1]][feature_list].copy()

# Check for NaNs (Lags might be NaN if data flow is broken)
if latest_row.isnull().values.any():
    print("WARNING: Latest row contains NaN values (likely due to Lags). Filling with 0 to force prediction.")
    latest_row = latest_row.fillna(0)

# Predict Log-Vol
log_pred = model.predict(latest_row)[0]

# Inverse Transform (Log -> Real)
real_pred = np.exp(log_pred)

# Compare with Current Volatility (rv_5)
current_vol = latest_row['rv_5'].values[0]
change_pct = ((real_pred - current_vol) / current_vol) * 100

# =========================
# 6. OUTPUT REPORT
# =========================
timestamp_ist = latest_row.index[0].tz_localize("UTC").tz_convert(IST)

print("\n" + "="*50)
print(f"   TIME (IST): {timestamp_ist.strftime('%Y-%m-%d %H:%M:%S')}")
print("="*50)
print(f"CURRENT 5-MIN VOLATILITY:     {current_vol:.6f}")
print(f"PREDICTED 15-MIN VOLATILITY:  {real_pred:.6f}")
print(f"EXPECTED CHANGE:              {change_pct:+.2f}%")
print("-" * 50)

if real_pred > current_vol * 1.15:
    print(">>> SIGNAL: VOLATILITY EXPANSION (BUY OPTIONS / LONG VEGA) 🚀")
elif real_pred < current_vol * 0.85:
    print(">>> SIGNAL: VOLATILITY CRUSH (SELL OPTIONS / SHORT VEGA) 📉")
else:
    print(">>> SIGNAL: NEUTRAL / CHOPPY ↔️")
print("="*50)

print("Feature vector shape:", latest_row.shape)
