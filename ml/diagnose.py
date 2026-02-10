import pandas as pd
import numpy as np
from sqlalchemy import create_engine

# =========================
# 1. SETUP
# =========================

DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"
engine = create_engine(DB_URI)
IST = "Asia/Kolkata"

def to_ist_index(df):
    df.index = df.index.tz_localize("UTC").tz_convert(IST)
    return df

def load_data(table_name):
    # Load only timestamp and close to save memory/speed
    query = f"SELECT timestamp, close FROM {table_name} ORDER BY timestamp"
    df = pd.read_sql(query, engine, parse_dates=["timestamp"])
    df.set_index("timestamp", inplace=True)
    df = to_ist_index(df)
    return df

def filter_market_hours(df):
    # 09:15 = 555 mins, 15:30 = 930 mins
    minutes = df.index.hour * 60 + df.index.minute
    return df[(minutes >= 555) & (minutes <= 930)]

# =========================
# 2. THE DIAGNOSIS
# =========================

print("\n--- STEP 1: LOAD NIFTY (BASE) ---")
nifty = load_data("nifty_spot_1min")
initial_count = len(nifty)
print(f"Original Nifty Rows: {initial_count}")

print("\n--- STEP 2: APPLY TIME FILTER (09:15 - 15:30) ---")
nifty_filtered = filter_market_hours(nifty)
print(f"Rows after Time Filter: {len(nifty_filtered)}")
print(f"Dropped {initial_count - len(nifty_filtered)} rows due to off-market hours.")

print("\n--- STEP 3: CHECK INTERSECTIONS ---")
# Create a master dataframe to track the intersection count
master = nifty_filtered.copy()
master.columns = ["nifty_close"] # Rename to avoid confusion

# Check VIX
print("Joining VIX...", end=" ")
vix = load_data("india_vix_1min")
vix = filter_market_hours(vix)
before_vix = len(master)
master = master.join(vix["close"].rename("vix_close"), how="inner")
loss_vix = before_vix - len(master)
print(f"Loss: {loss_vix} rows.")

# Check Constituents One by One
stocks_list = [
    "hdfc_spot_1min", "ril_spot_1min", "icici_spot_1min", 
    "infy_spot_1min", "tcs_spot_1min", "lt_spot_1min", 
    "bhartiart_spot_1min"
]

for table in stocks_list:
    stock_name = table.split("_")[0] # e.g. "hdfc"
    print(f"Joining {stock_name}...", end=" ")
    
    stock_df = load_data(table)
    stock_df = filter_market_hours(stock_df)
    
    # Rename the column to be unique (FIXED HERE)
    stock_series = stock_df["close"].rename(f"{stock_name}_close")
    
    before_join = len(master)
    # Join using inner join to see data loss
    master = master.join(stock_series, how="inner")
    after_join = len(master)
    
    loss = before_join - after_join
    
    if loss > 0:
        print(f"ALERT: Lost {loss} rows.")
    else:
        print(f"OK (0 lost)")

print(f"\n--- FINAL ROW COUNT: {len(master)} ---")

# =========================
# 3. ANALYSIS
# =========================

trading_days = len(master) / 375
print(f"\nEstimated Trading Days: {trading_days:.2f}")

if len(master) == 0:
    print("CRITICAL: You have 0 rows left. Your timestamps might be misaligned between tables.")
elif len(master) < 10000:
    print("WARNING: Dataset is very small. Check the 'ALERT' lines above.")
else:
    print("SUCCESS: Data volume looks healthy.")