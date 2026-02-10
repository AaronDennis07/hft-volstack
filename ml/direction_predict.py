import pandas as pd
import numpy as np
import xgboost as xgb
from sqlalchemy import create_engine
import sys
import os

# =========================
# 1. SETUP
# =========================
DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"
engine = create_engine(DB_URI)
IST = "Asia/Kolkata"

# Threshold for "High Confidence" (Matches your training win rate)
CONFIDENCE_THRESHOLD = 0.55 

print("--- STEP 1: Loading Direction Model ---")
model_path = "nifty_direction_hybrid.json"

if not os.path.exists(model_path):
    print(f"CRITICAL ERROR: Model file '{model_path}' not found.")
    print("Did you run 'direction_train.py' first?")
    sys.exit(1)

try:
    model = xgb.XGBClassifier()
    model.load_model(model_path)
    print("Model loaded successfully.")
except Exception as e:
    print(f"Error loading model: {e}")
    sys.exit(1)

# =========================
# 2. FEATURE ENGINEERING (MATCHING TRAIN_DIRECTION.PY)
# =========================
def generate_features(df):
    df = df.copy()
    
    # 1. Base Calcs
    df["ret"] = np.log(df["close"] / df["close"].shift(1))
    df["rv_5"] = df["ret"].rolling(5).std()
    df["rv_30"] = df["ret"].rolling(30).std()
    
    # 2. Volatility Regime
    df["vol_regime"] = df["rv_5"] / (df["rv_30"] + 1e-9)
    
    # 3. Parkinson Vol
    df["parkinson"] = ((1.0 / (4.0 * np.log(2.0))) * (np.log(df["high"] / df["low"]) ** 2)).rolling(15).mean()
    
    # 4. RSI-14 (Manual Calculation to match training)
    delta = df["close"].diff()
    gain = (delta.where(delta > 0, 0)).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    rs = gain / (loss + 1e-9)
    df["rsi"] = 100 - (100 / (1 + rs))
    
    # 5. Trend Strength (MACD Proxy)
    df["trend_strength"] = (df["close"].rolling(5).mean() - df["close"].rolling(20).mean())
    
    # 6. VIX Interaction
    # Vix Return
    df["vix_ret"] = np.log(df["vix"] / df["vix"].shift(1))
    # Vix Momentum
    df["vix_mom_5"] = df["vix"] - df["vix"].shift(5)
    # Inverse Vix (The Feature)
    df["vix_inv"] = df["vix_mom_5"] * -1
    
    # 7. Vol Spike (Synthetic Volume)
    # FIX: Replaced .fillna(method='ffill') with .ffill() for Pandas 2.0+
    vol = df["volume"].replace(0, np.nan).ffill()
    vol_mean = vol.rolling(15).mean() + 1
    df["vol_spike"] = vol / vol_mean
    
    # 8. Dispersion (Placeholder if not live)
    df["dispersion"] = 0.0 # Unless you calculate it live
    
    # 9. Lags
    df["ret_lag_1"] = df["ret"].shift(1)
    df["ret_lag_5"] = df["ret"].shift(5)
    
    # 10. Time
    df_ist = df.index.tz_localize("UTC").tz_convert(IST)
    minutes = df_ist.hour * 60 + df_ist.minute
    minute_of_day = minutes - 555 
    df["sin_time"] = np.sin(2 * np.pi * minute_of_day / 375.0)
    df["cos_time"] = np.cos(2 * np.pi * minute_of_day / 375.0)
    
    return df

# =========================
# 3. FETCH & PREDICT
# =========================
print("--- STEP 2: Fetching Live Data ---")
# Need roughly 50 rows for MA20, RSI14, Rolling30
query = """
    SELECT n.timestamp, n.open, n.high, n.low, n.close, n.volume, v.close as vix
    FROM nifty_spot_1min n
    JOIN india_vix_1min v ON n.timestamp = v.timestamp
    ORDER BY n.timestamp DESC
    LIMIT 100
"""
df_live = pd.read_sql(query, engine, parse_dates=["timestamp"])
df_live.set_index("timestamp", inplace=True)
df_live = df_live.sort_index()

# Generate Features
print("--- STEP 3: Engineering & Predicting ---")
df_features = generate_features(df_live)
latest_row = df_features.iloc[[-1]].copy()

# Feature List (MUST BE EXACT 14 FEATURES)
features = [
    'vol_regime', 'rv_5', 'rv_30', 'vix', 'parkinson',
    'rsi', 'trend_strength', 'ret_lag_1', 'ret_lag_5',
    'dispersion', 'vol_spike', 'vix_inv',
    'sin_time', 'cos_time'
]

X_live = latest_row[features]

# Predict Probability (Class 1 = UP)
# Returns [prob_down, prob_up]
probs = model.predict_proba(X_live)[0]
prob_up = probs[1]
prob_down = probs[0]

# Output
timestamp_ist = latest_row.index[0].tz_localize("UTC").tz_convert(IST)
current_price = latest_row["close"].values[0]

print("\n" + "="*50)
print(f"   TIME: {timestamp_ist.strftime('%H:%M:%S')}  |  PRICE: {current_price}")
print("="*50)
print(f"PROBABILITY (UP):   {prob_up*100:.2f}%")
print(f"PROBABILITY (DOWN): {prob_down*100:.2f}%")
print("-" * 50)

# DECISION LOGIC (The 58% Win Rate Strategy)
if prob_up > CONFIDENCE_THRESHOLD:
    print(f">>> SIGNAL: 🟢 BULLISH MOMENTUM DETECTED (Conf: {prob_up:.2f})")
    print(">>> ACTION: BUY CALLS / LONG FUTURES")
    
elif prob_down > CONFIDENCE_THRESHOLD: 
    print(f">>> SIGNAL: 🔴 BEARISH MOMENTUM DETECTED (Conf: {prob_down:.2f})")
    print(">>> ACTION: BUY PUTS / SHORT FUTURES")
    
else:
    print(">>> SIGNAL: ⚪ NO CLEAR DIRECTION (NOISE)")
    print(f">>> ACTION: STAY CASH (Model confidence < {CONFIDENCE_THRESHOLD})")

print("="*50)