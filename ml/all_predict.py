import time
import pandas as pd
import numpy as np
import xgboost as xgb
from sqlalchemy import create_engine, text
from datetime import datetime, timedelta
import sys
import os

# =========================
# 1. CONFIGURATION
# =========================
DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"
IST = "Asia/Kolkata"

# Model Paths
VOL_MODEL_PATH = "nifty_vol_final.json"
DIR_MODEL_PATH = "nifty_direction_hybrid.json"

# Thresholds
DIR_CONFIDENCE = 0.55   
VOL_EXPANSION = 0.0010 

# =========================
# 2. INITIALIZATION
# =========================
print("\n" + "="*60)
print("      🚀 NIFTY 50 TRADING ENGINE (STRICT MATCH) 🚀")
print("="*60)

engine = create_engine(DB_URI)

if not os.path.exists(VOL_MODEL_PATH) or not os.path.exists(DIR_MODEL_PATH):
    print(f"CRITICAL ERROR: Models not found.")
    sys.exit(1)

vol_model = xgb.XGBRegressor()
vol_model.load_model(VOL_MODEL_PATH)

dir_model = xgb.XGBClassifier()
dir_model.load_model(DIR_MODEL_PATH)

print("[INIT] System Ready.")

# =========================
# 3. LIVE FEATURE ENGINEERING
# =========================
def calculate_features_on_the_fly(df):
    """
    MATCHES TRAINING LOGIC EXACTLY:
    1. Volatility: Realized Vol (Sum of Squares)
    2. Volume: Sum of constituents (Not Index Volume)
    3. Constituents: Real Dispersion & Returns (Not Zeros)
    """
    df = df.copy()
    
    # --- Helper Functions ---
    def log_returns(series): return np.log(series / series.shift(1))
    def realized_volatility(r, window): return np.sqrt((r ** 2).rolling(window).sum())
    def parkinson_vol(high, low): return (1.0 / (4.0 * np.log(2.0))) * (np.log(high / low) ** 2)
    def gk_vol(open_, high, low, close):
        return (0.5 * (np.log(high / low) ** 2) - (2 * np.log(2) - 1) * (np.log(close / open_) ** 2))

    # --- A. Nifty Price Features ---
    df["ret"] = log_returns(df["close"])
    
    df["rv_5"] = realized_volatility(df["ret"], 5)
    df["rv_15"] = realized_volatility(df["ret"], 15)
    df["rv_30"] = realized_volatility(df["ret"], 30)
    
    df["parkinson"] = parkinson_vol(df["high"], df["low"]).rolling(15).mean()
    df["gk"] = gk_vol(df["open"], df["high"], df["low"], df["close"]).rolling(15).mean()
    
    df["range"] = df["high"] - df["low"]
    df["abs_return"] = (df["close"] - df["open"]).abs()
    df["std_15"] = df["close"].rolling(15).std()
    
    # --- B. Volume Features (FIXED: Sum of Constituents) ---
    # We construct the sum of volumes from the 7 stocks we fetched
    const_vols = df[["hdfc_vol", "ril_vol", "icici_vol", "infy_vol", "tcs_vol", "lt_vol", "bharti_vol"]]
    
    # Handle NaNs and Sum
    df["total_const_vol"] = const_vols.fillna(0).sum(axis=1)
    
    # Calculate Spike on the SUMMED volume
    vol_mean = df["total_const_vol"].rolling(15).mean() + 1
    df["vol_spike"] = df["total_const_vol"] / vol_mean
    
    # --- C. VIX Features ---
    df["vix"] = df["vix"].ffill()
    df["vix_ret"] = log_returns(df["vix"])
    df["vix_mom_5"] = df["vix"] - df["vix"].shift(5)
    df["vix_inv"] = df["vix_mom_5"] * -1

    # --- D. Constituent Features (FIXED: Real Data) ---
    stock_cols = {
        "hdfc": "hdfc_close", "ril": "ril_close", "icici": "icici_close", 
        "infy": "infy_close", "tcs": "tcs_close", "lt": "lt_close", "bharti": "bharti_close"
    }
    
    stock_returns = pd.DataFrame(index=df.index)
    
    for name, col in stock_cols.items():
        # Calculate individual returns
        ret_col = f"{name}_ret"
        stock_returns[ret_col] = log_returns(df[col])
        df[ret_col] = stock_returns[ret_col] # Add to main df
        
    # Calculate Dispersion & Constituent RV
    df["dispersion"] = stock_returns.std(axis=1)
    df["constituent_rv"] = (stock_returns.pow(2).rolling(5).sum().pow(0.5)).mean(axis=1)

    # --- E. Trend (RSI) ---
    delta = df["close"].diff()
    gain = (delta.where(delta > 0, 0)).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    rs = gain / (loss + 1e-9)
    df["rsi"] = 100 - (100 / (1 + rs))
    
    df["trend_strength"] = (df["close"].rolling(5).mean() - df["close"].rolling(20).mean())
    df["pos_in_range"] = (df["close"] - df["low"]) / (df["high"] - df["low"] + 1e-9)
    
    # --- F. Regime & Lags ---
    df["vol_regime"] = df["rv_5"] / (df["rv_30"] + 1e-9)
    df["vol_trend"] = df["rv_5"] - df["rv_15"]
    df["past_vol_15"] = realized_volatility(df["ret"], 15)
    
    df["ret_lag_1"] = df["ret"].shift(1)
    df["ret_lag_5"] = df["ret"].shift(5)
    df["vol_lag_15"] = df["past_vol_15"].shift(15)
    df["vol_lag_30"] = df["past_vol_15"].shift(30)
    df["vol_lag_60"] = df["past_vol_15"].shift(60)
    df["vol_lag_day"] = df["past_vol_15"].shift(375)

    # --- G. Time Features ---
    df_ist = df.index.tz_localize("UTC").tz_convert(IST)
    minutes = df_ist.hour * 60 + df_ist.minute
    minute_of_day = minutes - 555 
    df["sin_time"] = np.sin(2 * np.pi * minute_of_day / 375.0)
    df["cos_time"] = np.cos(2 * np.pi * minute_of_day / 375.0)
        
    return df.iloc[[-1]]

# =========================
# 4. TRADING LOGIC
# =========================
def run_strategy():
    try:
        # A. Fetch ALL Data (Nifty + VIX + 7 Stocks)
        # This big query is necessary to get the inputs for "Dispersion" and "Sum Volume"
        query = """
            SELECT 
                n.timestamp, n.open, n.high, n.low, n.close, n.volume,
                v.close as vix,
                h.close as hdfc_close, h.volume as hdfc_vol,
                r.close as ril_close, r.volume as ril_vol,
                i.close as icici_close, i.volume as icici_vol,
                in_fy.close as infy_close, in_fy.volume as infy_vol,
                t.close as tcs_close, t.volume as tcs_vol,
                l.close as lt_close, l.volume as lt_vol,
                b.close as bharti_close, b.volume as bharti_vol
            FROM nifty_spot_1min n
            LEFT JOIN india_vix_1min v ON n.timestamp = v.timestamp
            LEFT JOIN hdfc_spot_1min h ON n.timestamp = h.timestamp
            LEFT JOIN ril_spot_1min r ON n.timestamp = r.timestamp
            LEFT JOIN icici_spot_1min i ON n.timestamp = i.timestamp
            LEFT JOIN infy_spot_1min in_fy ON n.timestamp = in_fy.timestamp
            LEFT JOIN tcs_spot_1min t ON n.timestamp = t.timestamp
            LEFT JOIN lt_spot_1min l ON n.timestamp = l.timestamp
            LEFT JOIN bhartiart_spot_1min b ON n.timestamp = b.timestamp
            ORDER BY n.timestamp DESC
            LIMIT 600
        """
        
        # Load and set index
        df_live = pd.read_sql(query, engine, parse_dates=["timestamp"])
        df_live.set_index("timestamp", inplace=True)
        df_live = df_live.sort_index()
        
        # Forward Fill EVERYTHING (Crucial for live data stability)
        df_live = df_live.ffill()
        
        if len(df_live) < 400:
            print("[WAIT] Not enough data yet (Need > 400 mins)...")
            return

        # B. Calculate Features
        latest = calculate_features_on_the_fly(df_live)
        timestamp_ist = latest.index[0].tz_localize("UTC").tz_convert(IST)
        
        # C. Predict Volatility
        vol_feats = [
            'ret', 'rv_5', 'rv_15', 'rv_30', 'parkinson', 'gk', 'range', 'abs_return', 'std_15',
            'vol_spike', 'vix', 'vix_ret', 'vix_mom_5', 'dispersion', 'constituent_rv',
            'sin_time', 'cos_time', 'vol_regime', 'vol_trend',
            'vol_lag_15', 'vol_lag_30', 'vol_lag_60', 'vol_lag_day',
            'hdfc_ret', 'ril_ret', 'icici_ret', 'infy_ret', 'tcs_ret', 'lt_ret', 'bharti_ret',
            'past_vol_15'
        ]
        
        X_vol = latest[vol_feats].fillna(0)
        pred_log_vol = vol_model.predict(X_vol)[0]
        pred_vol = float(np.exp(pred_log_vol))
        
        # D. Predict Direction
        dir_feats = [
            'vol_regime', 'rv_5', 'rv_30', 'vix', 'parkinson',
            'rsi', 'trend_strength', 'ret_lag_1', 'ret_lag_5',
            'dispersion', 'vol_spike', 'vix_inv',
            'sin_time', 'cos_time'
        ]
        
        X_dir = latest[dir_feats].fillna(0)
        probs = dir_model.predict_proba(X_dir)[0]
        prob_down, prob_up = float(probs[0]), float(probs[1])
        
        # E. Decision
        is_high_vol = pred_vol > VOL_EXPANSION
        signal_msg = "NEUTRAL"
        
        if is_high_vol:
            if prob_up > DIR_CONFIDENCE: signal_msg = "STRONG BUY (CALLS)"
            elif prob_down > DIR_CONFIDENCE: signal_msg = "STRONG SELL (PUTS)"
            else: signal_msg = "HIGH VOL / NO DIR"
        else:
            if prob_up > DIR_CONFIDENCE: signal_msg = "GRIND UP (FUTURES)"
            elif prob_down > DIR_CONFIDENCE: signal_msg = "GRIND DOWN (FUTURES)"
            else: signal_msg = "DEAD MARKET"
        
        # F. Log
        price = float(latest["close"].values[0])
        print(f"[{timestamp_ist.strftime('%H:%M:%S')}] {price:.2f} | Vol: {pred_vol:.5f} | Up: {prob_up:.2f} | Signal: {signal_msg}")
        
        insert_query = text("""
            INSERT INTO live_predictions 
            (timestamp, price, pred_vol, prob_up, prob_down, signal_type, vol_regime, rsi, vix)
            VALUES (:timestamp, :price, :pred_vol, :prob_up, :prob_down, :signal_type, :vol_regime, :rsi, :vix)
            ON CONFLICT (timestamp) DO UPDATE 
            SET signal_type = EXCLUDED.signal_type;
        """)
        
        with engine.connect() as conn:
            conn.execute(insert_query, {
                "timestamp": timestamp_ist, "price": price, "pred_vol": pred_vol,
                "prob_up": prob_up, "prob_down": prob_down, "signal_type": signal_msg,
                "vol_regime": float(latest["vol_regime"].values[0]), 
                "rsi": float(latest["rsi"].values[0]), 
                "vix": float(latest["vix"].values[0])
            })
            conn.commit()

    except Exception as e:
        print(f"[ERROR] Strategy Loop Failed: {e}")

# =========================
# 5. EXECUTION LOOP
# =========================
if __name__ == "__main__":
    print("\n[MAIN] Starting trading loop...")
    while True:
        try:
            run_strategy()
            print("[MAIN] Sleeping for 60 seconds...\n")
            time.sleep(60)
        except KeyboardInterrupt:
            print("\n[MAIN] Stopped.")
            break
        except Exception as e:
            print(f"[MAIN] Error: {e}")
            time.sleep(60)