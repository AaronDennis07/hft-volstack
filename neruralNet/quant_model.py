import pandas as pd
import numpy as np
import torch
from sqlalchemy import create_engine
import joblib 
import datetime

def predict_next_session(db_uri, model_path, scaler_path, tickers, lookback_window=20):
    print("\n--- Initializing Live Inference Engine ---")
    
    # 1. Fetch data and Engineer Features
    engine = create_engine(db_uri)
    query = """
        SELECT timestamp, ticker, open, high, low, close, volume 
        FROM "stocks_daily" 
        WHERE timestamp >= (CURRENT_DATE - INTERVAL '60 days')
        ORDER BY timestamp, ticker
    """
    df = pd.read_sql(query, engine)
    
    for col in ['open', 'high', 'low', 'close', 'volume']:
        df[col] = df[col].astype(float)
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    
    dfs = []
    for ticker, group in df.groupby('ticker'):
        group = group.sort_values('timestamp').copy()
        group['log_return'] = np.log(group['close'] / group['close'].shift(1))
        group['vol_5d'] = group['log_return'].rolling(5).std()
        group['vol_20d'] = group['log_return'].rolling(20).std()
        group['ma_10'] = group['close'].rolling(10).mean()
        group['price_to_ma10'] = group['close'] / group['ma_10']
        dfs.append(group.dropna(subset=['log_return', 'vol_5d', 'vol_20d', 'price_to_ma10']))
        
    live_df = pd.concat(dfs)
    
    # 2. Extract exactly the last 20 trading dates
    all_dates = sorted(live_df['timestamp'].unique())
    latest_20_dates = all_dates[-lookback_window:]
    last_trading_date = latest_20_dates[-1]
    
    # Calculate Target Date (Assuming T+1 is the next weekday for logging purposes)
    # Note: If today is Friday, this makes the target Monday.
    target_date = last_trading_date + pd.offsets.BDay(1)
    
    print(f"Data window ends: {last_trading_date.strftime('%Y-%m-%d')}")
    print(f"Target Prediction Date: {target_date.strftime('%Y-%m-%d')}")
    
    # 3. Build the Input Tensor
    feature_cols = ['log_return', 'vol_5d', 'vol_20d', 'price_to_ma10']
    x_window = []
    
    for date in latest_20_dates:
        day_data = live_df[live_df['timestamp'] == date].set_index('ticker')
        day_features = day_data.reindex(tickers)[feature_cols].fillna(0).values
        x_window.append(day_features)
        
    x_window = np.array(x_window)
    x_window = np.transpose(x_window, (1, 0, 2)) 
    
    # 4. Load the Scaler and Apply it
    scaler = joblib.load(scaler_path)
    N, W, F = x_window.shape
    x_window_scaled = scaler.transform(x_window.reshape(-1, F)).reshape(N, W, F)
    x_tensor = torch.tensor(x_window_scaled, dtype=torch.float32).unsqueeze(0) 
    
    # 5. Load Model and Predict
    model = QuantTransformer(num_features=4, hidden_size=64)
    model.load_state_dict(torch.load(model_path))
    model.eval()
    
    with torch.no_grad():
        predictions = model(x_tensor).squeeze(0).numpy()
        
    # 6. Process and Rank Results
    results = list(zip(tickers, predictions))
    results.sort(key=lambda x: x[1], reverse=True) # Sort highest to lowest
    
    # Create a DataFrame for easy database insertion
    pred_df = pd.DataFrame(results, columns=['ticker', 'conviction_score'])
    pred_df['target_date'] = target_date.date()
    pred_df['prediction_timestamp'] = pd.Timestamp.now()
    pred_df['rank'] = range(1, len(pred_df) + 1)
    
    # Assign actions for the Top 5 and Bottom 5
    pred_df['action'] = "NONE"
    pred_df.loc[pred_df['rank'] <= 5, 'action'] = "LONG"
    pred_df.loc[pred_df['rank'] > len(pred_df) - 5, 'action'] = "SHORT"
    
    # 7. Push to PostgreSQL
    print("\nSaving detailed predictions to PostgreSQL (daily_predictions table)...")
    try:
        # if_exists='append' ensures we just add new rows every day
        pred_df.to_sql('daily_predictions', engine, if_exists='append', index=False, method='multi')
        print("✅ Successfully saved 52 predictions to database.")
    except Exception as e:
        print(f"❌ Database error (Usually means you already predicted for this date): {e}")

    # Output Terminal Summary
    longs = pred_df[pred_df['action'] == 'LONG']
    shorts = pred_df[pred_df['action'] == 'SHORT']
    
    print(f"\n🟢 {target_date.strftime('%b %d, %Y')} - TOP 5 LONGS:")
    print(longs[['rank', 'ticker', 'conviction_score']].to_string(index=False))
    
    print(f"\n🔴 {target_date.strftime('%b %d, %Y')} - BOTTOM 5 SHORTS:")
    print(shorts[['rank', 'ticker', 'conviction_score']].to_string(index=False))

    return pred_df