from fastapi import FastAPI, HTTPException
import requests
import pandas as pd
import datetime
import os
from sqlalchemy import create_engine

# Import your existing ML function
# Ensure your model script (e.g., quant_model.py) is in the same directory
from quant_model import predict_next_session 

app = FastAPI(title="Quant Engine API")

# Configuration
DB_URI = os.getenv("DATABASE_URL", "postgresql://aaron:dennis@ec2-13-239-249-77.ap-southeast-2.compute.amazonaws.com:5432/volstack")
SYNC_API_URL = "http://localhost:3000/syncStocksDaily"
MODEL_PATH = "best_quant_model.pt"
SCALER_PATH = "quant_scaler.pkl"

TICKERS = [
    "NSE:ADANIENT-EQ", "NSE:ADANIPORTS-EQ", "NSE:APOLLOHOSP-EQ", "NSE:ASIANPAINT-EQ", 
    "NSE:AXISBANK-EQ", "NSE:BAJAJ-AUTO-EQ", "NSE:BAJFINANCE-EQ", "NSE:BAJAJFINSV-EQ", 
    "NSE:BEL-EQ", "NSE:BHARTIARTL-EQ", "NSE:BPCL-EQ", "NSE:BRITANNIA-EQ", 
    "NSE:CIPLA-EQ", "NSE:COALINDIA-EQ", "NSE:DIVISLAB-EQ", "NSE:DRREDDY-EQ", 
    "NSE:EICHERMOT-EQ", "NSE:GRASIM-EQ", "NSE:HCLTECH-EQ", "NSE:HDFCBANK-EQ", 
    "NSE:HEROMOTOCO-EQ", "NSE:HINDALCO-EQ", "NSE:HINDUNILVR-EQ", "NSE:ICICIBANK-EQ", 
    "NSE:INDUSINDBK-EQ", "NSE:INFY-EQ", "NSE:ITC-EQ", "NSE:JSWSTEEL-EQ", 
    "NSE:KOTAKBANK-EQ", "NSE:LT-EQ", "NSE:M&M-EQ", "NSE:MARUTI-EQ", 
    "NSE:NESTLEIND-EQ", "NSE:NTPC-EQ", "NSE:ONGC-EQ", "NSE:POWERGRID-EQ", 
    "NSE:RELIANCE-EQ", "NSE:SBIN-EQ", "NSE:SHRIRAMFIN-EQ", "NSE:SUNPHARMA-EQ", 
    "NSE:TATACONSUM-EQ", "NSE:TMPV-EQ", "NSE:TATASTEEL-EQ", "NSE:TCS-EQ", 
    "NSE:TECHM-EQ", "NSE:TITAN-EQ", "NSE:TRENT-EQ", "NSE:ULTRACEMCO-EQ", "NSE:WIPRO-EQ",
    "NSE:UPL-EQ", "NSE:PIDILITIND-EQ", "NSE:GODREJCP-EQ"
]

def get_latest_db_date(engine):
    """Queries the database to find the most recent OHLCV record."""
    query = 'SELECT MAX(timestamp) as last_date FROM "stocks_daily"'
    df = pd.read_sql(query, engine)
    latest_date = df['last_date'].iloc[0]
    
    # If table is completely empty, fallback to a default start date
    if pd.isnull(latest_date):
        return pd.to_datetime("2026-03-09").date()
    return pd.to_datetime(latest_date).date()

@app.get("/trigger-prediction")
def trigger_prediction():
    engine = create_engine(DB_URI)
    
    # 1. Check Data Freshness
    latest_db_date = get_latest_db_date(engine)
    today = datetime.date.today()
    
    print(f"Latest DB Date: {latest_db_date} | Today: {today}")
    
    # 2. Trigger Sync if Outdated
    if latest_db_date < today:
        # Calculate range: The day after our last DB entry up to today
        sync_start_date = latest_db_date + datetime.timedelta(days=1)
        
        # Format dates to DD/MM/YYYY for the Node.js API
        range_from_str = sync_start_date.strftime("%d/%m/%Y")
        range_to_str = today.strftime("%d/%m/%Y")
        
        sync_payload = {
            "range_from": range_from_str,
            "range_to": range_to_str,
            "symbols": TICKERS
        }
        
        print(f"Triggering Data Sync: {range_from_str} to {range_to_str}")
        try:
            sync_response = requests.post(SYNC_API_URL, json=sync_payload)
            sync_response.raise_for_status()
            print("✅ Data Sync Successful.")
        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=502, detail=f"Data sync API failed: {str(e)}")
    else:
        print("✅ Database is up to date. Skipping sync.")

    # 3. Run PyTorch Inference
    print("Initiating Spatio-Temporal Transformer Inference...")
    try:
        # Assuming predict_next_session returns the Pandas DataFrame (pred_df)
        pred_df = predict_next_session(
            db_uri=DB_URI,
            model_path=MODEL_PATH,
            scaler_path=SCALER_PATH,
            tickers=TICKERS,
            lookback_window=20
        )
        
        # 4. Format the Response
        longs = pred_df[pred_df['action'] == 'LONG'].to_dict(orient='records')
        shorts = pred_df[pred_df['action'] == 'SHORT'].to_dict(orient='records')
        
        return {
            "status": "success",
            "target_date": pred_df['target_date'].iloc[0],
            "signals": {
                "TOP_5_LONGS": longs,
                "BOTTOM_5_SHORTS": shorts
            }
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ML Prediction Engine failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    # Runs the API on port 8000
    uvicorn.run(app, host="0.0.0.0", port=8000)