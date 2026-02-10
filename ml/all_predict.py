import time
import pandas as pd
import numpy as np
import xgboost as xgb
from sqlalchemy import create_engine, text
from datetime import datetime, timedelta
import sys
import os
import requests

# =========================
# 1. CONFIGURATION
# =========================
DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"
IST = "Asia/Kolkata"
API_BASE_URL = "http://localhost:3000"

# Model Paths
VOL_MODEL_PATH = "nifty_vol_final.json"
DIR_MODEL_PATH = "nifty_direction_hybrid.json"

# Thresholds
DIR_CONFIDENCE = 0.55  
VOL_EXPANSION = 0.0010 

# Stock Mapping for Constituents
STOCKS_MAP = {
    "hdfc": "hdfc_spot_1min",
    "ril": "ril_spot_1min",
    "icici": "icici_spot_1min",
    "infy": "infy_spot_1min",
    "tcs": "tcs_spot_1min",
    "lt": "lt_spot_1min",
    "bharti": "bhartiart_spot_1min",
}

# =========================
# 2. INITIALIZATION
# =========================
print("\n" + "="*60)
print("      🚀 NIFTY 50 SYNCED TRADING ENGINE 🚀")
print("="*60)

engine = create_engine(DB_URI)

# Initialize Logging Table
with engine.connect() as conn:
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS live_predictions (
            timestamp TIMESTAMP PRIMARY KEY,
            price DECIMAL,
            pred_vol DECIMAL,
            prob_up DECIMAL,
            prob_down DECIMAL,
            signal_type VARCHAR(50),
            vol_regime DECIMAL,
            rsi DECIMAL,
            vix DECIMAL
        );
    """))
    conn.commit()

# Load Models
print("[INIT] Loading AI Models...")
if not os.path.exists(VOL_MODEL_PATH) or not os.path.exists(DIR_MODEL_PATH):
    print(f"CRITICAL ERROR: Model files not found.")
    sys.exit(1)

vol_model = xgb.XGBRegressor()
vol_model.load_model(VOL_MODEL_PATH)

dir_model = xgb.XGBClassifier()
dir_model.load_model(DIR_MODEL_PATH)

print("[INIT] System Ready.")
print("-" * 60)

# =========================
# 3. MATH HELPERS (SYNCED)
# =========================
def log_returns(series): return np.log(series / series.shift(1))
def realized_vol_sum(r, window): return np.sqrt((r ** 2).rolling(window).sum()) # For Vol Model
def parkinson_vol(high, low): return (1.0 / (4.0 * np.log(2.0))) * (np.log(high / low) ** 2)
def gk_vol(open_, high, low, close):
    return (0.5 * (np.log(high / low) ** 2) - (2 * np.log(2) - 1) * (np.log(close / open_) ** 2))

# =========================
# 4. DATA SYNC HELPERS
# =========================
def get_last_timestamp():
    try:
        query = "SELECT MAX(timestamp) as last_ts FROM nifty_spot_1min"
        with engine.connect() as conn:
            result = conn.execute(text(query)).fetchone()
            return result[0] if result else None
    except Exception: return None

def sync_raw_data(from_date: str, to_date: str):
    try:
        print(f"[SYNC] Requesting API sync...")
        response = requests.post(f"{API_BASE_URL}/syncAllStocks", 
                                 json={"range_from": from_date, "range_to": to_date}, timeout=300)
        return response.status_code == 200
    except Exception: return False

def check_and_sync_data():
    last_ts = get_last_timestamp()
    now = datetime.now()
    if last_ts is None:
        from_date = (now - timedelta(days=5)).strftime("%d/%m/%Y")
        return sync_raw_data(from_date, now.strftime("%d/%m/%Y"))
    
    if last_ts.tzinfo: last_ts = last_ts.replace(tzinfo=None)
    if (now - last_ts) > timedelta(minutes=2):
        return sync_raw_data(last_ts.strftime("%d/%m/%Y"), now.strftime("%d/%m/%Y"))
    return True

# =========================
# 5. LIVE FEATURE ENGINEERING
# =========================
def generate_features_live(nifty_df, stocks_dict, vix_df):
    df = nifty_df.copy()

    # --- A. BASE CALCULATIONS ---
    df["ret"] = log_returns(df["close"])
    
    # --- B. SPLIT VOLATILITY CALCULATIONS (CRITICAL FIX) ---
    
    # 1. Standard Deviation Based (For DIRECTION Model)
    df["rv_5_std"] = df["ret"].rolling(5).std()
    df["rv_30_std"] = df["ret"].rolling(30).std()
    df["vol_regime_std"] = df["rv_5_std"] / (df["rv_30_std"] + 1e-9)

    # 2. Sum of Squares Based (For VOLATILITY Model)
    df["rv_5_sum"] = realized_vol_sum(df["ret"], 5)
    df["rv_15_sum"] = realized_vol_sum(df["ret"], 15)
    df["rv_30_sum"] = realized_vol_sum(df["ret"], 30)
    df["vol_regime_sum"] = df["rv_5_sum"] / (df["rv_30_sum"] + 1e-9)
    df["vol_trend_sum"] = df["rv_5_sum"] - df["rv_15_sum"]

    # --- C. COMMON FEATURES ---
    df["parkinson"] = parkinson_vol(df["high"], df["low"]).rolling(15).mean()
    df["gk"] = gk_vol(df["open"], df["high"], df["low"], df["close"]).rolling(15).mean()
    df["range"] = df["high"] - df["low"]
    df["abs_return"] = (df["close"] - df["open"]).abs()
    df["std_15"] = df["close"].rolling(15).std()

    # --- D. SPLIT VOL SPIKE CALCULATIONS ---
    
    # 1. Constituent Volume (For VOLATILITY Model)
    constituent_vol = pd.DataFrame(index=df.index)
    for name, s_df in stocks_dict.items():
        constituent_vol[name] = s_df["volume"]
    df["total_const_vol"] = constituent_vol.sum(axis=1)
    df["vol_spike_const"] = df["total_const_vol"] / (df["total_const_vol"].rolling(15).mean() + 1)

    # 2. Nifty Spot Volume (For DIRECTION Model)
    nifty_vol = df["volume"].replace(0, np.nan).ffill()
    df["vol_spike_nifty"] = nifty_vol / (nifty_vol.rolling(15).mean() + 1)

    # --- E. VIX & CONSTITUENTS ---
    df = df.join(vix_df["close"].rename("vix"), how="left")
    df["vix"] = df["vix"].ffill()
    df["vix_ret"] = log_returns(df["vix"])
    df["vix_mom_5"] = df["vix"] - df["vix"].shift(5)
    df["vix_inv"] = df["vix_mom_5"] * -1

    stock_returns = pd.DataFrame(index=df.index)
    for name, s_df in stocks_dict.items():
        stock_returns[f"{name}_ret"] = log_returns(s_df["close"])
    
    df = df.join(stock_returns, how="left")
    df["dispersion"] = stock_returns.std(axis=1)
    df["constituent_rv"] = (stock_returns.pow(2).rolling(5).sum().pow(0.5)).mean(axis=1)

    # --- F. TECHNICALS & TIME ---
    delta = df["close"].diff()
    gain = (delta.where(delta > 0, 0)).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    df["rsi"] = 100 - (100 / (1 + (gain / (loss + 1e-9))))
    df["trend_strength"] = (df["close"].rolling(5).mean() - df["close"].rolling(20).mean())
    
    df["past_vol_15"] = df["ret"].rolling(15).std() # Used for Lags (Matches Vol Script)
    
    df["ret_lag_1"] = df["ret"].shift(1)
    df["ret_lag_5"] = df["ret"].shift(5)

    df_ist = df.index.tz_localize("UTC").tz_convert(IST)
    minute_of_day = (df_ist.hour * 60 + df_ist.minute) - 555
    df["sin_time"] = np.sin(2 * np.pi * minute_of_day / 375.0)
    df["cos_time"] = np.cos(2 * np.pi * minute_of_day / 375.0)
    
    # Lag Features for Volatility
    df["vol_lag_15"] = df["past_vol_15"].shift(15)
    df["vol_lag_30"] = df["past_vol_15"].shift(30)
    df["vol_lag_60"] = df["past_vol_15"].shift(60)
    df["vol_lag_day"] = df["past_vol_15"].shift(375)

    return df

# =========================
# 6. STRATEGY LOOP
# =========================
def run_strategy():
    try:
        # Fetch Data
        nifty_df = pd.read_sql("SELECT * FROM nifty_spot_1min ORDER BY timestamp DESC LIMIT 600", engine, parse_dates=["timestamp"]).set_index("timestamp").sort_index()
        vix_df = pd.read_sql("SELECT * FROM india_vix_1min ORDER BY timestamp DESC LIMIT 600", engine, parse_dates=["timestamp"]).set_index("timestamp").sort_index()
        
        stocks_dict = {}
        for name, table in STOCKS_MAP.items():
            stocks_dict[name] = pd.read_sql(f"SELECT * FROM {table} ORDER BY timestamp DESC LIMIT 600", engine, parse_dates=["timestamp"]).set_index("timestamp").sort_index()

        df_feat = generate_features_live(nifty_df, stocks_dict, vix_df)
        latest = df_feat.iloc[[-1]].copy()
        
        # ---------------------------------------------------------
        # 1. VOLATILITY MODEL PREDICTION
        # ---------------------------------------------------------
        latest_vol = latest.copy()
        
        # MAP FEATURES: Using "_sum" versions and Constituent Vol
        latest_vol['rv_5'] = latest_vol['rv_5_sum']
        latest_vol['rv_15'] = latest_vol['rv_15_sum']
        latest_vol['rv_30'] = latest_vol['rv_30_sum']
        latest_vol['vol_regime'] = latest_vol['vol_regime_sum']
        latest_vol['vol_trend'] = latest_vol['vol_trend_sum']
        latest_vol['vol_spike'] = latest_vol['vol_spike_const']

        vol_feats = [
            'ret', 'rv_5', 'rv_15', 'rv_30', 'parkinson', 'gk', 'range', 'abs_return', 'std_15',
            'vol_spike', 'vix', 'vix_ret', 'vix_mom_5', 'dispersion', 'constituent_rv',
            'sin_time', 'cos_time', 'vol_regime', 'vol_trend', 
            'vol_lag_15', 'vol_lag_30', 'vol_lag_60', 'vol_lag_day', 
            'hdfc_ret', 'ril_ret', 'icici_ret', 'infy_ret', 'tcs_ret', 'lt_ret', 
            'bharti_ret', 'past_vol_15'
        ]
        
        X_vol = latest_vol.reindex(columns=vol_feats).fillna(0)
        
        if X_vol.shape[1] != 31:
            print(f"[CRITICAL] Feature count mismatch! Got {X_vol.shape[1]}, expected 31.")
            return

        pred_log_vol = vol_model.predict(X_vol)[0]
        pred_vol = float(np.exp(pred_log_vol))

        # ---------------------------------------------------------
        # 2. DIRECTION MODEL PREDICTION
        # ---------------------------------------------------------
        latest_dir = latest.copy()
        
        # MAP FEATURES: Using "_std" versions and Nifty Vol
        latest_dir['rv_5'] = latest_dir['rv_5_std']
        latest_dir['rv_30'] = latest_dir['rv_30_std']
        latest_dir['vol_regime'] = latest_dir['vol_regime_std']
        latest_dir['vol_spike'] = latest_dir['vol_spike_nifty']

        dir_feats = [
            'vol_regime', 'rv_5', 'rv_30', 'vix', 'parkinson', 
            'rsi', 'trend_strength', 'ret_lag_1', 'ret_lag_5', 
            'dispersion', 'vol_spike', 'vix_inv', 'sin_time', 'cos_time'
        ]
        
        X_dir = latest_dir.reindex(columns=dir_feats).fillna(0)
        probs = dir_model.predict_proba(X_dir)[0]
        prob_down, prob_up = float(probs[0]), float(probs[1])

        # ---------------------------------------------------------
        # 3. DECISION
        # ---------------------------------------------------------
        signal = "NEUTRAL"
        if pred_vol > VOL_EXPANSION:
            if prob_up > DIR_CONFIDENCE: signal = "STRONG BUY (CALLS)"
            elif prob_down > DIR_CONFIDENCE: signal = "STRONG SELL (PUTS)"
            else: signal = "HIGH VOL (NO DIR)"
        else:
            if prob_up > DIR_CONFIDENCE: signal = "GRIND UP (FUTS)"
            elif prob_down > DIR_CONFIDENCE: signal = "GRIND DOWN (FUTS)"
            else: signal = "LOW VOL"

        ts_ist = latest.index[0].tz_localize("UTC").tz_convert(IST)
        price = float(latest["close"].iloc[0])
        print(f"[{ts_ist.strftime('%H:%M:%S')}] {price:.2f} | Vol: {pred_vol:.5f} | Up: {prob_up:.2f} | {signal}")

        with engine.connect() as conn:
            conn.execute(text("""
                INSERT INTO live_predictions (timestamp, price, pred_vol, prob_up, prob_down, signal_type, vol_regime, rsi, vix)
                VALUES (:ts, :p, :pv, :pu, :pd, :s, :vr, :rsi, :vx) 
                ON CONFLICT (timestamp) DO UPDATE SET signal_type = EXCLUDED.signal_type
            """), {"ts": ts_ist, "p": price, "pv": pred_vol, "pu": prob_up, "pd": prob_down, "s": signal, 
                   "vr": float(latest["vol_regime_std"].iloc[0]), "rsi": float(latest["rsi"].iloc[0]), "vx": float(latest["vix"].iloc[0])})
            conn.commit()

    except Exception as e: 
        print(f"[ERROR] Strategy Failure: {e}")

# =========================
# 7. MAIN LOOP
# =========================
if __name__ == "__main__":
    while True:
        try:
            if check_and_sync_data():
                run_strategy()
            else:
                print("[MAIN] Sync failed or incomplete, waiting...")
            time.sleep(60)
        except KeyboardInterrupt:
            print("\n[MAIN] Stopped by user.")
            break
        except Exception as e:
            print(f"Loop Error: {e}")
            time.sleep(60)