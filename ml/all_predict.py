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

# =========================
# 2. INITIALIZATION
# =========================
print("\n" + "="*60)
print("      🚀 NIFTY 50 TRADING ENGINE + LOGGER 🚀")
print("="*60)

engine = create_engine(DB_URI)

# A. Initialize Logging Table
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

# B. Load Models
print("[INIT] Loading AI Models...")
if not os.path.exists(VOL_MODEL_PATH) or not os.path.exists(DIR_MODEL_PATH):
    print(f"CRITICAL ERROR: Models not found.")
    sys.exit(1)

vol_model = xgb.XGBRegressor()
vol_model.load_model(VOL_MODEL_PATH)

dir_model = xgb.XGBClassifier()
dir_model.load_model(DIR_MODEL_PATH)

print("[INIT] System Ready.")
print("-" * 60)

# =========================
# 2.5 DATA SYNC HELPERS
# =========================

def get_last_timestamp():
    """Get the last timestamp from the raw data table"""
    try:
        query = "SELECT MAX(timestamp) as last_ts FROM nifty_spot_1min"
        with engine.connect() as conn:
            result = conn.execute(text(query)).fetchone()
            if result and result[0]:
                return result[0]
        return None
    except Exception as e:
        print(f"[WARN] Could not get last timestamp: {e}")
        return None

def sync_raw_data(from_date: str, to_date: str):
    """Call the API to sync raw stock data"""
    try:
        print(f"[SYNC] Fetching raw data from {from_date} to {to_date}...")
        response = requests.post(
            f"{API_BASE_URL}/syncAllStocks",
            json={"range_from": from_date, "range_to": to_date},
            timeout=300 
        )
        
        if response.status_code == 200:
            print(f"[SYNC] ✅ Raw data synced successfully")
            return True
        else:
            print(f"[SYNC] ❌ API returned status {response.status_code}")
            return False
    except Exception as e:
        print(f"[SYNC] ❌ Failed to sync data: {e}")
        return False

def regenerate_features():
    """Run feature engineering to populate the historical features table"""
    try:
        print("[FEATURES] Starting feature engineering...")
        
        def to_ist_index(df):
            if df.index.tz is None:
                df.index = df.index.tz_localize("UTC")
            df.index = df.index.tz_convert(IST)
            return df

        # Load Nifty & VIX (Skipping constituents for speed as we use Nifty Vol)
        query_nifty = "SELECT timestamp, open, high, low, close, volume FROM nifty_spot_1min ORDER BY timestamp"
        df = pd.read_sql(query_nifty, engine, parse_dates=["timestamp"])
        df.set_index("timestamp", inplace=True)
        df = to_ist_index(df)

        query_vix = "SELECT timestamp, close FROM india_vix_1min ORDER BY timestamp"
        vix = pd.read_sql(query_vix, engine, parse_dates=["timestamp"])
        vix.set_index("timestamp", inplace=True)
        vix = to_ist_index(vix)

        # Helper functions
        def log_returns(series): return np.log(series / series.shift(1))
        def realized_volatility(r, window): return np.sqrt((r ** 2).rolling(window).sum())
        def parkinson_vol(high, low): return (1.0 / (4.0 * np.log(2.0))) * (np.log(high / low) ** 2)

        # 1. Price features
        df["ret"] = log_returns(df["close"])
        df["rv_5"] = realized_volatility(df["ret"], 5)
        df["rv_15"] = realized_volatility(df["ret"], 15)
        df["rv_30"] = realized_volatility(df["ret"], 30)
        df["parkinson"] = parkinson_vol(df["high"], df["low"]).rolling(15).mean()
        
        # GK Volatility
        df["gk"] = (0.5 * (np.log(df["high"] / df["low"]) ** 2) - 
                   (2 * np.log(2) - 1) * (np.log(df["close"] / df["open"]) ** 2)).rolling(15).mean()
        
        df["range"] = df["high"] - df["low"]
        df["abs_return"] = (df["close"] - df["open"]).abs()
        df["std_15"] = df["close"].rolling(15).std()

        # 2. Volume features (FIXED: Using Nifty Volume, not constituents)
        # Using ffill() to handle potential 0s in volume
        vol = df["volume"].replace(0, np.nan).ffill()
        vol_mean = vol.rolling(15).mean() + 1
        df["vol_spike"] = vol / vol_mean

        # 3. VIX features
        df = df.join(vix["close"].rename("vix"), how="left")
        df["vix"] = df["vix"].ffill() # Fill missing VIX ticks
        df["vix_ret"] = log_returns(df["vix"])
        df["vix_mom_5"] = df["vix"] - df["vix"].shift(5)

        # 4. Placeholders for Constituents (To match model schema)
        df["dispersion"] = 0.0
        df["constituent_rv"] = 0.0
        for c in ['hdfc_ret', 'ril_ret', 'icici_ret', 'infy_ret', 'tcs_ret', 'lt_ret', 'bharti_ret']:
            df[c] = 0.0

        # 5. Time features
        minutes_from_midnight = df.index.hour * 60 + df.index.minute
        df["minute_of_day"] = minutes_from_midnight - 555
        df["sin_time"] = np.sin(2 * np.pi * df["minute_of_day"] / 375.0)
        df["cos_time"] = np.cos(2 * np.pi * df["minute_of_day"] / 375.0)

        # 6. Target (Optional for inference table, but kept for structure)
        future_r = df["ret"].shift(-1)
        df["target_vol_15"] = np.sqrt((future_r ** 2).rolling(15).sum().shift(-15))

        df = df.dropna()
        
        # Save to database (Convert back to UTC for storage)
        df_to_save = df.copy()
        df_to_save.index = df_to_save.index.tz_convert("UTC").tz_localize(None)
        
        df_to_save.to_sql(
            "nifty_volatility_features_1min",
            engine,
            if_exists="replace",
            index=True,
            chunksize=5000
        )
        
        print("[FEATURES] ✅ Features saved to database")
        return True
        
    except Exception as e:
        print(f"[FEATURES] ❌ Feature generation failed: {e}")
        return False

def check_and_sync_data():
    """Main orchestration: Check last timestamp and sync if needed"""
    try:
        last_ts = get_last_timestamp()
        now = datetime.now()
        
        if last_ts is None:
            print("[SYNC] No data found. Need initial setup.")
            to_date = now.strftime("%d/%m/%Y")
            from_date = (now - timedelta(days=5)).strftime("%d/%m/%Y")
            if sync_raw_data(from_date, to_date):
                return regenerate_features()
            return False
        
        if not isinstance(last_ts, datetime):
            last_ts = pd.to_datetime(last_ts)
        
        # Ensure last_ts is naive for comparison if 'now' is naive
        if last_ts.tzinfo:
            last_ts = last_ts.replace(tzinfo=None)

        time_diff = now - last_ts
        
        # If data is older than 2 minutes, sync
        if time_diff > timedelta(minutes=2):
            from_date = (last_ts + timedelta(days=0)).strftime("%d/%m/%Y") # Start from last known date
            to_date = now.strftime("%d/%m/%Y")
            
            print(f"[SYNC] Data lag: {time_diff}. Syncing {from_date} -> {to_date}...")
            
            if sync_raw_data(from_date, to_date):
                return regenerate_features()
            return False
        else:
            return True # Data is fresh
            
    except Exception as e:
        print(f"[SYNC] ❌ Sync check failed: {e}")
        return False

# =========================
# 3. LIVE FEATURE ENGINEERING
# =========================
def generate_features(df):
    """
    Identical logic to regenerate_features, but for a small live dataframe.
    """
    df = df.copy()
    
    # Price
    df["ret"] = np.log(df["close"] / df["close"].shift(1))
    df["rv_5"] = df["ret"].rolling(5).std()
    df["rv_15"] = df["ret"].rolling(15).std()
    df["rv_30"] = df["ret"].rolling(30).std()
    
    # Volatility
    df["parkinson"] = ((1.0 / (4.0 * np.log(2.0))) * (np.log(df["high"] / df["low"]) ** 2)).rolling(15).mean()
    df["gk"] = (0.5 * (np.log(df["high"] / df["low"]) ** 2) - (2 * np.log(2) - 1) * (np.log(df["close"] / df["open"]) ** 2)).rolling(15).mean()
    df["range"] = df["high"] - df["low"]
    df["abs_return"] = (df["close"] - df["open"]).abs()
    df["std_15"] = df["close"].rolling(15).std()
    
    # Volume (NIFTY VOLUME)
    vol = df["volume"].replace(0, np.nan).ffill()
    vol_mean = vol.rolling(15).mean() + 1
    df["vol_spike"] = vol / vol_mean
    
    # VIX
    df["vix_ret"] = np.log(df["vix"] / df["vix"].shift(1))
    df["vix_mom_5"] = df["vix"] - df["vix"].shift(5)
    df["vix_inv"] = df["vix_mom_5"] * -1

    # Trend
    delta = df["close"].diff()
    gain = (delta.where(delta > 0, 0)).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    rs = gain / (loss + 1e-9)
    df["rsi"] = 100 - (100 / (1 + rs))
    df["trend_strength"] = (df["close"].rolling(5).mean() - df["close"].rolling(20).mean())
    df["pos_in_range"] = (df["close"] - df["low"]) / (df["high"] - df["low"] + 1e-9)
    
    # Regime & Lags
    df["vol_regime"] = df["rv_5"] / (df["rv_30"] + 1e-9)
    df["vol_trend"] = df["rv_5"] - df["rv_15"]
    df["past_vol_15"] = df["ret"].rolling(15).std()
    
    df["ret_lag_1"] = df["ret"].shift(1)
    df["ret_lag_5"] = df["ret"].shift(5)
    df["vol_lag_15"] = df["past_vol_15"].shift(15)
    df["vol_lag_30"] = df["past_vol_15"].shift(30)
    df["vol_lag_60"] = df["past_vol_15"].shift(60)
    df["vol_lag_day"] = df["past_vol_15"].shift(375)

    # Time
    df_ist = df.index.tz_localize("UTC").tz_convert(IST)
    minutes = df_ist.hour * 60 + df_ist.minute
    minute_of_day = minutes - 555 
    df["sin_time"] = np.sin(2 * np.pi * minute_of_day / 375.0)
    df["cos_time"] = np.cos(2 * np.pi * minute_of_day / 375.0)
    
    # Placeholders
    df["dispersion"] = 0.0
    df["constituent_rv"] = 0.0
    for c in ['hdfc_ret', 'ril_ret', 'icici_ret', 'infy_ret', 'tcs_ret', 'lt_ret', 'bharti_ret']:
        df[c] = 0.0
        
    return df

# =========================
# 4. TRADING LOGIC
# =========================
def run_strategy():
    try:
        # A. Fetch Data
        query = """
            SELECT n.timestamp, n.open, n.high, n.low, n.close, n.volume, v.close as vix
            FROM nifty_spot_1min n
            JOIN india_vix_1min v ON n.timestamp = v.timestamp
            ORDER BY n.timestamp DESC
            LIMIT 600
        """
        df_live = pd.read_sql(query, engine, parse_dates=["timestamp"])
        df_live.set_index("timestamp", inplace=True)
        df_live = df_live.sort_index()
        
        if len(df_live) < 400:
            print("[WAIT] Not enough data yet...")
            return

        # B. Engineer Features
        df_feat = generate_features(df_live)
        latest = df_feat.iloc[[-1]].copy()
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
        
        # E. Decision Logic
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
        
        price = float(latest["close"].values[0])
        print(f"[{timestamp_ist.strftime('%H:%M:%S')}] {price:.2f} | Vol: {pred_vol:.5f} | Up: {prob_up:.2f} | Signal: {signal_msg}")
        
        # F. Log to Database
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
                "vol_regime": float(latest["vol_regime"].values[0]), "rsi": float(latest["rsi"].values[0]), "vix": float(latest["vix"].values[0])
            })
            conn.commit()
            
    except Exception as e:
        print(f"[ERROR] Strategy Loop Failed: {e}")

# =========================
# 5. EXECUTION LOOP
# =========================
if __name__ == "__main__":
    print("\n[MAIN] Starting trading loop...")
    print("[MAIN] Press Ctrl+C to stop\n")
    
    while True:
        try:
            # Step 1: Check and sync data (API call)
            if check_and_sync_data():
                # Step 2: Run strategy
                run_strategy()
            else:
                print("[MAIN] ⚠️ Data sync failed or waiting for market data...")
            
            print(f"[MAIN] Sleeping for 60 seconds...\n")
            time.sleep(60)
            
        except KeyboardInterrupt:
            print("\n[MAIN] 🛑 Stopped by user")
            break
        except Exception as e:
            print(f"[MAIN] ❌ Loop error: {e}")
            time.sleep(60)