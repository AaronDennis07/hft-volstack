import pandas as pd
import numpy as np
import torch
import torch.nn as nn
import os
from torch.utils.data import Dataset, DataLoader
from sqlalchemy import create_engine
from sklearn.preprocessing import StandardScaler

# ==========================================
# 1. Data Fetching & Feature Engineering
# ==========================================

def fetch_and_preprocess_data(db_uri):
    engine = create_engine(db_uri)
    query = "SELECT timestamp, ticker, open, high, low, close, volume FROM \"stocks_daily\" ORDER BY timestamp, ticker"
    df = pd.read_sql(query, engine)
    
    for col in ['open', 'high', 'low', 'close', 'volume']:
        df[col] = df[col].astype(float)
        
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    
    dfs = []
    for ticker, group in df.groupby('ticker'):
        group = group.sort_values('timestamp').copy()
        
        # Log Returns & Target
        group['log_return'] = np.log(group['close'] / group['close'].shift(1))
        group['next_open'] = group['open'].shift(-1)
        group['next_close'] = group['close'].shift(-1)
        group['target'] = (group['next_close'] - group['next_open']) / group['next_open']
        
        # Features
        group['vol_5d'] = group['log_return'].rolling(5).std()
        group['vol_20d'] = group['log_return'].rolling(20).std()
        group['ma_10'] = group['close'].rolling(10).mean()
        group['price_to_ma10'] = group['close'] / group['ma_10']
        
        dfs.append(group)

    return pd.concat(dfs).dropna()

# ==========================================
# 2. Dataset Preparation
# ==========================================

class UniverseDataset(Dataset):
    def __init__(self, df, target_dates, lookback_window=20, scaler=None):
        self.lookback = lookback_window
        self.all_dates = sorted(df['timestamp'].unique())
        self.target_dates = sorted(target_dates)
        self.tickers = sorted(df['ticker'].unique())
        self.feature_cols = ['log_return', 'vol_5d', 'vol_20d', 'price_to_ma10']
        
        self.data_dict = {}
        self.target_dict = {}
        for date in self.all_dates:
            day_data = df[df['timestamp'] == date].set_index('ticker')
            day_features = day_data.reindex(self.tickers)[self.feature_cols].fillna(0).values
            day_targets = day_data.reindex(self.tickers)['target'].fillna(0).values
            self.data_dict[date] = day_features
            self.target_dict[date] = day_targets
            
        if scaler is None:
            self.scaler = StandardScaler()
            self.is_train = True
        else:
            self.scaler = scaler
            self.is_train = False

        if self.is_train:
            all_train_features = []
            for d in self.target_dates:
                idx = self.all_dates.index(d)
                window_dates = self.all_dates[idx - self.lookback + 1 : idx + 1]
                x_window = np.array([self.data_dict[wd] for wd in window_dates])
                all_train_features.append(x_window)
            
            all_train_features = np.concatenate(all_train_features, axis=0)
            self.scaler.fit(all_train_features.reshape(-1, len(self.feature_cols)))

    def __len__(self):
        return len(self.target_dates)

    def __getitem__(self, idx):
        target_date = self.target_dates[idx]
        master_idx = self.all_dates.index(target_date)
        window_dates = self.all_dates[master_idx - self.lookback + 1 : master_idx + 1]
        
        x_window = np.array([self.data_dict[d] for d in window_dates])
        x_window = np.transpose(x_window, (1, 0, 2)) 
        
        N, W, F = x_window.shape
        x_window = self.scaler.transform(x_window.reshape(-1, F)).reshape(N, W, F)
        y = self.target_dict[target_date]
        
        return torch.tensor(x_window, dtype=torch.float32), torch.tensor(y, dtype=torch.float32), str(target_date.date())

# ==========================================
# 3. Model Architecture
# ==========================================

class QuantTransformer(nn.Module):
    def __init__(self, num_features, hidden_size=64, num_heads=4, num_layers=2, dropout=0.1):
        super().__init__()
        self.gru = nn.GRU(input_size=num_features, hidden_size=hidden_size, batch_first=True)
        encoder_layer = nn.TransformerEncoderLayer(d_model=hidden_size, nhead=num_heads, dropout=dropout, batch_first=True)
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        self.fc = nn.Sequential(
            nn.Linear(hidden_size, hidden_size // 2),
            nn.ReLU(),
            nn.Linear(hidden_size // 2, 1)
        )

    def forward(self, x):
        B, N, W, F = x.shape
        x = x.view(B * N, W, F)
        _, h_n = self.gru(x) 
        h_n = h_n.squeeze(0).view(B, N, -1)
        out = self.transformer(h_n) 
        out = self.fc(out).squeeze(-1)
        return out

# ==========================================
# 4. Comprehensive Metrics Calculator
# ==========================================

def calculate_metrics(pred, target):
    """Calculates IC, Pearson Loss, MSE, and Directional Hit Rate."""
    # 1. Pearson Correlation (IC)
    pred_mean = pred.mean(dim=1, keepdim=True)
    target_mean = target.mean(dim=1, keepdim=True)
    cov = ((pred - pred_mean) * (target - target_mean)).sum(dim=1)
    pred_std = torch.sqrt(((pred - pred_mean)**2).sum(dim=1) + 1e-8)
    target_std = torch.sqrt(((target - target_mean)**2).sum(dim=1) + 1e-8)
    
    ic = cov / (pred_std * target_std)
    loss = (1 - ic).mean()
    
    # 2. Mean Squared Error (MSE)
    mse = torch.nn.functional.mse_loss(pred, target)
    
    # 3. Directional Hit Rate (Accuracy)
    # Checks if the predicted sign matches the actual target sign
    hit_rate = ((pred > 0) == (target > 0)).float().mean()
    
    return loss, ic.mean(), mse, hit_rate

# ==========================================
# 5. Training Loop with Early Stopping
# ==========================================

def train_model(db_uri):
    print("Fetching and aligning database records...")
    df = fetch_and_preprocess_data(db_uri)
    
    split_date = pd.to_datetime('2024-01-01')
    all_valid_dates = sorted(df['timestamp'].unique())[20:] 
    
    train_dates = [d for d in all_valid_dates if d < split_date]
    test_dates = [d for d in all_valid_dates if d >= split_date]
    
    print(f"Train Set: {len(train_dates)} days | Test Set: {len(test_dates)} days")
    
    train_dataset = UniverseDataset(df, target_dates=train_dates, lookback_window=20)
    test_dataset = UniverseDataset(df, target_dates=test_dates, lookback_window=20, scaler=train_dataset.scaler)
    
    train_loader = DataLoader(train_dataset, batch_size=16, shuffle=True)
    test_loader = DataLoader(test_dataset, batch_size=16, shuffle=False)
    
    model = QuantTransformer(num_features=4, hidden_size=64)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    
    epochs = 50
    best_test_ic = -float('inf')
    patience, patience_counter = 10, 0
    save_path = "best_quant_model.pt"
    
    print("\n--- Starting Deep Learning ---")
    
    for epoch in range(epochs):
        # --- TRAINING ---
        model.train()
        t_loss, t_ic, t_mse, t_hit = 0.0, 0.0, 0.0, 0.0
        
        for batch_x, batch_y, _ in train_loader:
            optimizer.zero_grad()
            predictions = model(batch_x)
            loss, ic, mse, hit = calculate_metrics(predictions, batch_y)
            loss.backward()
            optimizer.step()
            
            t_loss += loss.item()
            t_ic += ic.item()
            t_mse += mse.item()
            t_hit += hit.item()
            
        # --- TESTING ---
        model.eval()
        v_loss, v_ic, v_mse, v_hit = 0.0, 0.0, 0.0, 0.0
        
        with torch.no_grad():
            for batch_x, batch_y, _ in test_loader:
                predictions = model(batch_x)
                loss, ic, mse, hit = calculate_metrics(predictions, batch_y)
                
                v_loss += loss.item()
                v_ic += ic.item()
                v_mse += mse.item()
                v_hit += hit.item()
                
        # Calculate Averages
        avg_v_ic = v_ic / len(test_loader)
        
        print(f"Epoch {epoch+1:02d} | "
              f"Train - IC: {t_ic/len(train_loader)*100:+.2f}%, Hit Rate: {t_hit/len(train_loader)*100:.1f}%, MSE: {t_mse/len(train_loader):.5f} | "
              f"Test - IC: {avg_v_ic*100:+.2f}%, Hit Rate: {v_hit/len(test_loader)*100:.1f}%, MSE: {v_mse/len(test_loader):.5f}")

        # Checkpointing Logic
        if avg_v_ic > best_test_ic:
            best_test_ic = avg_v_ic
            torch.save(model.state_dict(), save_path)
            patience_counter = 0
        else:
            patience_counter += 1
            
        if patience_counter >= patience:
            print(f"\n[!] Early Stopping Triggered! Best Test IC was {best_test_ic*100:+.2f}%")
            break

    return test_dataset, save_path

# ==========================================
# 6. Live Inference / Prediction Step
# ==========================================

def predict_recent_days(test_dataset, model_path):
    print(f"\n--- Running Inference on Last 3 Days ---")
    
    # Load the optimally trained model
    model = QuantTransformer(num_features=4, hidden_size=64)
    model.load_state_dict(torch.load(model_path))
    model.eval()
    
    tickers = test_dataset.tickers
    
    # Grab the last 3 dates from the test dataset
    last_3_indices = range(len(test_dataset) - 3, len(test_dataset))
    
    with torch.no_grad():
        for idx in last_3_indices:
            x_window, actual_y, target_date = test_dataset[idx]
            
            # Add batch dimension: (1, N, W, F)
            x_window = x_window.unsqueeze(0) 
            
            # Predict
            predictions = model(x_window).squeeze(0).numpy()
            actuals = actual_y.numpy()
            
            # Pair tickers with predictions and actuals
            results = list(zip(tickers, predictions, actuals))
            # Sort by predicted return descending
            results.sort(key=lambda x: x[1], reverse=True)
            
            # Extract formatted date
            date_str = pd.to_datetime(target_date).strftime('%Y-%m-%d')
            
            print(f"\nTarget Date: {date_str}")
            print("🟢 TOP 5 LONGS (Buy):")
            for i in range(5):
                ticker, pred, act = results[i]
                print(f"  {i+1}. {ticker:<18} | Predicted Score: {pred:+.5f} | Actual Return: {act*100:+.2f}%")
                
            print("\n🔴 BOTTOM 5 SHORTS (Sell):")
            for i in range(1, 6):
                ticker, pred, act = results[-i]
                print(f"  {i}. {ticker:<18} | Predicted Score: {pred:+.5f} | Actual Return: {act*100:+.2f}%")

if __name__ == "__main__":
    db_uri = "postgresql://aaron:dennis@ec2-13-239-249-77.ap-southeast-2.compute.amazonaws.com:5432/volstack"
    
    # 1. Train and save the best model
    test_dataset, saved_model_path = train_model(db_uri)
    joblib.dump(test_dataset.scaler, 'quant_scaler.pkl')
    print("✅ Saved the True Scaler!")
    
    # 2. Run inference on the last 3 days
    if os.path.exists(saved_model_path):
        predict_recent_days(test_dataset, saved_model_path)