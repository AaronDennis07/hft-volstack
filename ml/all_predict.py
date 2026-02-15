import pandas as pd
from sqlalchemy import create_engine, text
from datetime import datetime, timedelta, time as dtime
import json
import sys

# =========================
# CONFIGURATION
# =========================
DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"

# STRATEGY PARAMETERS
S1_START, S1_END = dtime(10, 30), dtime(12, 00)
S1_PROB, S1_TARGET, S1_STOP, S1_LIMIT = 0.53, 30, 20, 45

S2_VOL, S2_PROB, S2_TARGET, S2_CHECK_TIME, S2_REQ = 0.002, 0.51, 50, 15, 20

S3_RSI, S3_TARGET, S3_STOP, S3_LIMIT = 65, 15, 10, 20

# =========================
# DATABASE INIT
# =========================
engine = create_engine(DB_URI)

def init_db(conn):
    # 1. State Tracking Table
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS strategy_cursor (
            id INT PRIMARY KEY,
            last_processed_timestamp TIMESTAMP
        )
    """))
    # Initialize cursor if empty
    conn.execute(text("""
        INSERT INTO strategy_cursor (id, last_processed_timestamp)
        VALUES (1, '2000-01-01 00:00:00')
        ON CONFLICT (id) DO NOTHING
    """))
    
    # 2. Trade Tables (Ensure they exist)
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
        )
    """))
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
        )
    """))
    conn.commit()

# =========================
# CORE LOGIC
# =========================
def close_trade(conn, t_id, reason, entry_time, entry_price, curr_time, curr_price, s_name):
    pnl = entry_price - curr_price # Short PnL
    conn.execute(text("""
        INSERT INTO completed_trades (strategy_name, entry_time, exit_time, entry_price, exit_price, pnl_points, exit_reason)
        VALUES (:sn, :et, :xt, :ep, :xp, :pnl, :er)
    """), {"sn": s_name, "et": entry_time, "xt": curr_time, "ep": entry_price, "xp": curr_price, "pnl": pnl, "er": reason})
    
    conn.execute(text("DELETE FROM active_trades WHERE id = :id"), {"id": t_id})
    print(f"💰 EXIT: {s_name} | PnL: {pnl:.2f} | {reason} at {curr_time}")

def open_trade(conn, s_name, time, price, target, stop, limit, meta=None):
    tp = price - target
    sl = price + stop if stop else None
    xt = time + timedelta(minutes=limit) if limit else None
    conn.execute(text("""
        INSERT INTO active_trades (strategy_name, entry_time, entry_price, target_price, stop_loss_price, exit_time_limit, meta_data)
        VALUES (:sn, :et, :ep, :tp, :sl, :xt, :md)
    """), {"sn": s_name, "et": time, "ep": price, "tp": tp, "sl": sl, "xt": xt, "md": json.dumps(meta) if meta else None})
    print(f"🚀 ENTRY: {s_name} at {price} on {time}")

def process_row(conn, row):
    curr_time = row['timestamp'] # live_predictions column name
    curr_price = float(row['price'])
    pred_vol = float(row['pred_vol'])
    prob_down = float(row['prob_down'])
    signal = str(row['signal_type'])
    rsi = float(row['rsi'])

    # --- A. MANAGE ACTIVE TRADES (Check Exits) ---
    active_rows = conn.execute(text("SELECT * FROM active_trades")).fetchall()
    active_strategies = [r[1] for r in active_rows]

    for t in active_rows:
        t_id, s_name, e_time, e_price, t_price, s_price, x_limit, meta = t
        e_price, t_price = float(e_price), float(t_price)
        if s_price: s_price = float(s_price)

        # 1. EOD Exit (15:25 or Date Change)
        if curr_time.date() > e_time.date() or (curr_time.hour >= 15 and curr_time.minute >= 25):
            close_trade(conn, t_id, "EOD EXIT", e_time, e_price, curr_time, curr_price, s_name)
            continue

        # 2. Target
        if curr_price <= t_price:
            close_trade(conn, t_id, "TARGET REACHED", e_time, e_price, curr_time, curr_price, s_name)
            continue

        # 3. Stop Loss
        if s_price and curr_price >= s_price:
            close_trade(conn, t_id, "STOP LOSS", e_time, e_price, curr_time, curr_price, s_name)
            continue

        # 4. Time Limit
        if x_limit and curr_time >= x_limit:
            close_trade(conn, t_id, "TIME LIMIT", e_time, e_price, curr_time, curr_price, s_name)
            continue

        # 5. Strat 2 Momentum Check
        if s_name == "Strat 2 (High Vol)":
            check_dt = e_time + timedelta(minutes=S2_CHECK_TIME)
            # Check exactly at or after the 15m mark
            if curr_time >= check_dt:
                # We interpret "move is not in 15 mins" as: Profit < 20pts -> Exit
                if (e_price - curr_price) < S2_REQ:
                    close_trade(conn, t_id, "MOMENTUM FAIL", e_time, e_price, curr_time, curr_price, s_name)
                    continue

    # --- B. CHECK NEW ENTRIES ---
    
    # Strat 1 (Sniper)
    if "Strat 1 (Sniper)" not in active_strategies:
        if S1_START <= curr_time.time() <= S1_END and prob_down > S1_PROB and "GRIND DOWN" in signal:
            open_trade(conn, "Strat 1 (Sniper)", curr_time, curr_price, S1_TARGET, S1_STOP, S1_LIMIT)

    # Strat 2 (High Vol)
    if "Strat 2 (High Vol)" not in active_strategies:
        if pred_vol > S2_VOL and prob_down > S2_PROB and "HIGH VOL" in signal:
            open_trade(conn, "Strat 2 (High Vol)", curr_time, curr_price, S2_TARGET, None, None, meta={"type": "high_vol"})

    # Strat 3 (Reversal)
    if "Strat 3 (Reversal)" not in active_strategies:
        if ("LOW VOL" in signal or "DEAD MARKET" in signal) and rsi > S3_RSI:
            open_trade(conn, "Strat 3 (Reversal)", curr_time, curr_price, S3_TARGET, S3_STOP, S3_LIMIT)

# =========================
# MAIN EXECUTION
# =========================
def main():
    with engine.connect() as conn:
        init_db(conn)
        
        # 1. Get Cursor
        cursor_res = conn.execute(text("SELECT last_processed_timestamp FROM strategy_cursor WHERE id=1")).fetchone()
        last_processed = cursor_res[0]
        print(f"[INIT] Last Processed: {last_processed}")

        # 2. Fetch New Data (Batch)
        # Fetching all new rows from predictions table
        query = text("SELECT * FROM live_predictions WHERE timestamp > :lp ORDER BY timestamp ASC")
        new_data = conn.execute(query, {"lp": last_processed}).fetchall()
        
        if not new_data:
            print("[INFO] No new data to process.")
            return

        print(f"[INFO] Processing {len(new_data)} new rows...")

        # 3. Process Loop
        # We define column mapping based on standard alchemy return
        # Adjust indices if schema differs, but standard SELECT * follows create order
        cols = ["timestamp", "price", "pred_vol", "prob_up", "prob_down", "signal_type", "vol_regime", "rsi", "vix"]
        
        for row_tuple in new_data:
            # Convert tuple to dict for readability
            row = dict(zip(cols, row_tuple))
            
            process_row(conn, row)
            
            # Update Cursor (in-memory for now, commit at end or periodically)
            last_processed = row['timestamp']

        # 4. Save Final State
        conn.execute(text("UPDATE strategy_cursor SET last_processed_timestamp = :ts WHERE id=1"), {"ts": last_processed})
        conn.commit()
        print(f"[DONE] Processed up to {last_processed}. State saved.")

if __name__ == "__main__":
    main()