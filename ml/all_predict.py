import time
import pandas as pd
import numpy as np
import xgboost as xgb
from sqlalchemy import create_engine, text
from datetime import datetime, time as dtime, timedelta
import sys
import os
import requests
import json

# =========================
# 1. CONFIGURATION
# =========================
DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"
IST = "Asia/Kolkata"
API_BASE_URL = "http://localhost:3000"

# Model Paths
VOL_MODEL_PATH = "nifty_vol_final.json"
DIR_MODEL_PATH = "nifty_direction_hybrid.json"

# Base Model Thresholds
DIR_CONFIDENCE = 0.55  
VOL_EXPANSION = 0.0010 

# --- STRATEGY SPECIFIC CONFIGURATION ---
# Strategy 1 (Sniper)
S1_START_TIME = dtime(10, 30)
S1_END_TIME = dtime(12, 00)
S1_PROB_THRESH = 0.53
S1_TARGET = 30
S1_STOP = 20
S1_TIME_LIMIT = 45

# Strategy 2 (High Vol)
S2_VOL_THRESH = 0.002
S2_PROB_THRESH = 0.51
S2_TARGET = 50
S2_CHECK_TIME = 15
S2_MOMENTUM_REQ = 20 # Pts profit required by check time

# Strategy 3 (Reversal)
S3_RSI_THRESH = 65
S3_TARGET = 15
S3_STOP = 10
S3_TIME_LIMIT = 20

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
print("      🚀 NIFTY 50 SYNCED TRADING ENGINE + STRATEGY MANAGER 🚀")
print("="*60)

engine = create_engine(DB_URI)

# Initialize Tables (Predictions + Strategy Tables)
with engine.connect() as conn:
    # 1. Raw Predictions Log
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
    
    # 2. Active Trades (State Persistence)
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS active_trades (
            id SERIAL PRIMARY KEY,
            strategy_name VARCHAR(50),
            entry_time TIMESTAMP,
            entry_price DECIMAL,
            target_price DECIMAL,
            stop_loss_price DECIMAL,
            exit_time_limit TIMESTAMP,
            meta_data JSONB 
        );
    """))

    # 3. Completed Trades (Results Log)
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS completed_trades (
            id SERIAL PRIMARY KEY,
            strategy_name VARCHAR(50),
            entry_time TIMESTAMP,
            exit_time TIMESTAMP,
            entry_price DECIMAL,
            exit_price DECIMAL,
            pnl_points DECIMAL,
            exit_reason VARCHAR(100)
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
# 3. MATH HELPERS
# =========================
def log_returns(series): return np.log(series / series.shift(1))
def realized_vol_sum(r, window): return np.sqrt((r ** 2).rolling(window).sum())
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
# 5. FEATURE ENGINEERING
# =========================
def generate_features_live(nifty_df, stocks_dict, vix_df):
    df = nifty_df.copy()
    df["ret"] = log_returns(df["close"])
    
    # Vol Calc
    df["rv_5_std"] = df["ret"].rolling(5).std()
    df["rv_30_std"] = df["ret"].rolling(30).std()
    df["vol_regime_std"] = df["rv_5_std"] / (df["rv_30_std"] + 1e-9)

    df["rv_5_sum"] = realized_vol_sum(df["ret"], 5)
    df["rv_15_sum"] = realized_vol_sum(df["ret"], 15)
    df["rv_30_sum"] = realized_vol_sum(df["ret"], 30)
    df["vol_regime_sum"] = df["rv_5_sum"] / (df["rv_30_sum"] + 1e-9)
    df["vol_trend_sum"] = df["rv_5_sum"] - df["rv_15_sum"]

    df["parkinson"] = parkinson_vol(df["high"], df["low"]).rolling(15).mean()
    df["gk"] = gk_vol(df["open"], df["high"], df["low"], df["close"]).rolling(15).mean()
    df["range"] = df["high"] - df["low"]
    df["abs_return"] = (df["close"] - df["open"]).abs()
    df["std_15"] = df["close"].rolling(15).std()

    # Vol Spikes
    constituent_vol = pd.DataFrame(index=df.index)
    for name, s_df in stocks_dict.items():
        constituent_vol[name] = s_df["volume"]
    df["total_const_vol"] = constituent_vol.sum(axis=1)
    df["vol_spike_const"] = df["total_const_vol"] / (df["total_const_vol"].rolling(15).mean() + 1)

    nifty_vol = df["volume"].replace(0, np.nan).ffill()
    df["vol_spike_nifty"] = nifty_vol / (nifty_vol.rolling(15).mean() + 1)

    # VIX & Dispersion
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

    # Technicals
    delta = df["close"].diff()
    gain = (delta.where(delta > 0, 0)).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    df["rsi"] = 100 - (100 / (1 + (gain / (loss + 1e-9))))
    df["trend_strength"] = (df["close"].rolling(5).mean() - df["close"].rolling(20).mean())
    
    df["past_vol_15"] = df["ret"].rolling(15).std()
    df["ret_lag_1"] = df["ret"].shift(1)
    df["ret_lag_5"] = df["ret"].shift(5)

    df_ist = df.index.tz_localize("UTC").tz_convert(IST)
    minute_of_day = (df_ist.hour * 60 + df_ist.minute) - 555
    df["sin_time"] = np.sin(2 * np.pi * minute_of_day / 375.0)
    df["cos_time"] = np.cos(2 * np.pi * minute_of_day / 375.0)
    
    df["vol_lag_15"] = df["past_vol_15"].shift(15)
    df["vol_lag_30"] = df["past_vol_15"].shift(30)
    df["vol_lag_60"] = df["past_vol_15"].shift(60)
    df["vol_lag_day"] = df["past_vol_15"].shift(375)

    return df

# =========================================================
# 6. STRATEGY MANAGEMENT SYSTEM (NEW INTEGRATION)
# =========================================================
def close_trade(conn, trade_id, exit_reason, entry_time, entry_price, current_time, current_price, strategy_name):
    # Short Trade PnL: Entry - Exit
    pnl = entry_price - current_price
    
    # 1. Archive to History
    conn.execute(text("""
        INSERT INTO completed_trades (strategy_name, entry_time, exit_time, entry_price, exit_price, pnl_points, exit_reason)
        VALUES (:sn, :et, :xt, :ep, :xp, :pnl, :er)
    """), {
        "sn": strategy_name, "et": entry_time, "xt": current_time, 
        "ep": entry_price, "xp": current_price, "pnl": pnl, "er": exit_reason
    })
    
    # 2. Remove from Active
    conn.execute(text("DELETE FROM active_trades WHERE id = :id"), {"id": trade_id})
    print(f"🛑 [EXIT] {strategy_name} | PnL: {pnl:.2f} | Reason: {exit_reason}")

def open_trade(conn, strategy_name, current_time, current_price, target, stop, time_limit, meta=None):
    # Calculate Prices
    target_price = current_price - target # Short
    stop_price = current_price + stop if stop else None # Short
    
    exit_time = None
    if time_limit:
        exit_time = current_time + timedelta(minutes=time_limit)

    conn.execute(text("""
        INSERT INTO active_trades (strategy_name, entry_time, entry_price, target_price, stop_loss_price, exit_time_limit, meta_data)
        VALUES (:sn, :et, :ep, :tp, :sl, :xt, :md)
    """), {
        "sn": strategy_name, "et": current_time, "ep": current_price,
        "tp": target_price, "sl": stop_price, "xt": exit_time, 
        "md": json.dumps(meta) if meta else None
    })
    print(f"✅ [ENTRY] {strategy_name} | Price: {current_price} | Target: {target_price}")

def manage_strategies(conn, current_time, current_price, pred_vol, prob_down, signal_type, rsi):
    # 1. FETCH ALL ACTIVE TRADES
    # We load all open positions to see which strategies are busy
    active_rows = conn.execute(text("SELECT * FROM active_trades")).fetchall()
    
    # Create a list of currently running strategy names to prevent duplicate entries
    active_strategy_names = [row[1] for row in active_rows] # row[1] is strategy_name
    
    # --- A. MANAGE EXITS (Check EVERY active trade) ---
    for trade in active_rows:
        t_id = trade[0]
        s_name = trade[1]
        e_time = trade[2]
        e_price = float(trade[3]) # Entry Price
        t_price = float(trade[4]) # Target
        s_price = float(trade[5]) if trade[5] else None # Stop
        x_limit = trade[6]        # Time Limit
        # meta = trade[7] (JSON) - logic handled below if needed

        # 1. EOD Exit (Universal Priority)
        if current_time.date() > e_time.date() or (current_time.hour >= 15 and current_time.minute >= 25):
             close_trade(conn, t_id, "EOD EXIT", e_time, e_price, current_time, current_price, s_name)
             continue # Move to next trade

        # 2. Target Check (Short)
        if current_price <= t_price:
            close_trade(conn, t_id, "TARGET REACHED", e_time, e_price, current_time, current_price, s_name)
            continue

        # 3. Stop Loss Check (Short)
        if s_price and current_price >= s_price:
            close_trade(conn, t_id, "STOP LOSS HIT", e_time, e_price, current_time, current_price, s_name)
            continue

        # 4. Time Limit Check
        if x_limit and current_time >= x_limit:
            close_trade(conn, t_id, "TIME LIMIT EXIT", e_time, e_price, current_time, current_price, s_name)
            continue

        # 5. Strategy 2 Momentum Check (Special Logic)
        if s_name == "Strat 2 (High Vol)":
            check_dt = e_time + timedelta(minutes=S2_CHECK_TIME)
            # If we are PAST the check time
            if current_time >= check_dt:
                current_profit = e_price - current_price
                # If profit is LESS than 20 points, EXIT
                if current_profit < S2_MOMENTUM_REQ:
                    close_trade(conn, t_id, "MOMENTUM FAIL (15m)", e_time, e_price, current_time, current_price, s_name)
                    continue

    # --- B. CHECK NEW ENTRIES (Parallel Checks) ---
    # We only enter if that SPECIFIC strategy is not already active
    
    # Strategy 1: Grind Down Sniper
    # Time: 10:30-12:00 | Signal: GRIND DOWN | Prob > 0.53
    if "Strat 1 (Sniper)" not in active_strategy_names:
        s1_time_ok = S1_START_TIME <= current_time.time() <= S1_END_TIME
        if s1_time_ok and prob_down > S1_PROB_THRESH and "GRIND DOWN" in signal_type:
            open_trade(conn, "Strat 1 (Sniper)", current_time, current_price, S1_TARGET, S1_STOP, S1_TIME_LIMIT)

    # Strategy 2: High Vol Momentum
    # Vol > 0.002 | Signal: HIGH VOL | Prob > 0.51
    if "Strat 2 (High Vol)" not in active_strategy_names:
        if pred_vol > S2_VOL_THRESH and prob_down > S2_PROB_THRESH and "HIGH VOL" in signal_type:
            # Note: No hard stop passed, logic uses momentum check later
            open_trade(conn, "Strat 2 (High Vol)", current_time, current_price, S2_TARGET, None, None, meta={"type": "high_vol"})

    # Strategy 3: Range Reversal
    # Signal: LOW VOL or DEAD | RSI > 65
    if "Strat 3 (Reversal)" not in active_strategy_names:
        is_low_vol = "LOW VOL" in signal_type or "DEAD MARKET" in signal_type
        if is_low_vol and rsi > S3_RSI_THRESH:
            open_trade(conn, "Strat 3 (Reversal)", current_time, current_price, S3_TARGET, S3_STOP, S3_TIME_LIMIT)
# =========================
# 7. MAIN EXECUTION
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
        
        # --- PREDICTION ---
        # 1. Volatility
        latest_vol = latest.copy()
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
        pred_vol = float(np.exp(vol_model.predict(X_vol)[0]))

        # 2. Direction
        latest_dir = latest.copy()
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

        # 3. Decision
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
        # Ensure ts_ist is naive for DB compatibility if needed, or keep aware depending on Postgres setup
        # Generally Postgres handles timezone aware, but consistency helps.
        
        price = float(latest["close"].iloc[0])
        curr_rsi = float(latest["rsi"].iloc[0])
        
        print(f"[{ts_ist.strftime('%H:%M:%S')}] {price:.2f} | Vol: {pred_vol:.5f} | Down: {prob_down:.2f} | {signal}")

        with engine.connect() as conn:
            # A. Log Prediction
            conn.execute(text("""
                INSERT INTO live_predictions (timestamp, price, pred_vol, prob_up, prob_down, signal_type, vol_regime, rsi, vix)
                VALUES (:ts, :p, :pv, :pu, :pd, :s, :vr, :rsi, :vx) 
                ON CONFLICT (timestamp) DO UPDATE SET signal_type = EXCLUDED.signal_type
            """), {"ts": ts_ist, "p": price, "pv": pred_vol, "pu": prob_up, "pd": prob_down, "s": signal, 
                   "vr": float(latest["vol_regime_std"].iloc[0]), "rsi": curr_rsi, "vx": float(latest["vix"].iloc[0])})
            
            # B. Manage Strategies (Check Entries/Exits)
            manage_strategies(conn, ts_ist, price, pred_vol, prob_down, signal, curr_rsi)
            
            conn.commit()

    except Exception as e: 
        print(f"[ERROR] Strategy Failure: {e}")
        import traceback
        traceback.print_exc()

# =========================
# 8. MAIN LOOP
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