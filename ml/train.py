import pandas as pd
import numpy as np
import xgboost as xgb
from sqlalchemy import create_engine
from sklearn.metrics import mean_absolute_error, mean_squared_error
import matplotlib.pyplot as plt
import seaborn as sns
import joblib

# =========================
# 1. SETUP & DATA LOADING
# =========================

DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"
engine = create_engine(DB_URI)

print("--- STEP 1: Loading Data from Postgres ---")
query = """
    SELECT * FROM nifty_volatility_features_1min 
    ORDER BY "timestamp" ASC
"""
df = pd.read_sql(query, engine, parse_dates=["timestamp"])
df.set_index("timestamp", inplace=True)
df.sort_index(inplace=True)

print(f"Loaded {len(df)} rows.")

# =========================
# 2. FEATURE ENGINEERING
# =========================

print("--- STEP 2: Engineering Features ---")

# A. Volatility Regime & Trend
# ----------------------------
# Ratio of Short-term vs Long-term Vol (Panic Detector)
df["vol_regime"] = df["rv_5"] / (df["rv_30"] + 1e-9)
# Volatility Trend (Momentum)
df["vol_trend"] = df["rv_5"] - df["rv_15"]

# B. Autoregression (Lags)
# ------------------------
# Create a baseline of "Past Volatility" (what happened 15 mins ago)
df["past_vol_15"] = df["ret"].rolling(15).std()

# Lag 1: Volatility 15 mins ago
df["vol_lag_15"] = df["past_vol_15"].shift(15)
# Lag 2: Volatility 30 mins ago
df["vol_lag_30"] = df["past_vol_15"].shift(30)
# Lag 3: Volatility 1 hour ago
df["vol_lag_60"] = df["past_vol_15"].shift(60)
# Lag 4: Volatility exactly 1 day ago (Seasonality)
df["vol_lag_day"] = df["past_vol_15"].shift(375)

# C. Define Feature List
# ----------------------
features = [
    # Price Action
    'ret', 'rv_5', 'rv_15', 'rv_30', 
    'parkinson', 'gk', 'range', 'abs_return', 'std_15',
    
    # Volume (Synthetic)
    'vol_spike', 
    
    # VIX & Market Internals
    'vix', 'vix_ret', 'vix_mom_5',
    'dispersion', 'constituent_rv',
    
    # Time, Regime & Lags
    'sin_time', 'cos_time', 'vol_regime', 'vol_trend',
    'vol_lag_15', 'vol_lag_30', 'vol_lag_60', 'vol_lag_day'
]

# Add Constituent Returns
const_feats = [c for c in df.columns if "_ret" in c and "vix" not in c and c != "ret"]
features += const_feats

target_col = 'target_vol_15'

# =========================
# 3. CLEANING & LOG TRANSFORMATION
# =========================

print("--- STEP 3: Preparing Target & Cleaning ---")

# Drop rows where target is NaN (End of data)
df = df.dropna(subset=[target_col])

# Drop rows where Lags are NaN (Start of data - loss of ~1 day)
df = df.dropna(subset=features)

# Remove zeros to avoid log(-inf)
df = df[df[target_col] > 1e-9]

# Log-Transform the Target (Critical for Volatility models)
df["log_target"] = np.log(df[target_col])

print(f"Training on {len(df)} rows after cleanup.")
print(f"Number of Features: {len(features)}")

# =========================
# 4. TIME-SERIES SPLIT
# =========================

# 70% Train, 15% Validation, 15% Test
train_size = int(len(df) * 0.70)
val_size = int(len(df) * 0.15)

train = df.iloc[:train_size]
val = df.iloc[train_size : train_size + val_size]
test = df.iloc[train_size + val_size :]

X_train, y_train = train[features], train["log_target"]
X_val, y_val = val[features], val["log_target"]
X_test, y_test_log = test[features], test["log_target"]
y_test_actual = test[target_col]

# =========================
# 5. TRAIN XGBOOST (REGULARIZED)
# =========================

print("--- STEP 4: Training XGBoost (Strict Regularization) ---")

model = xgb.XGBRegressor(
    n_estimators=5000,
    learning_rate=0.005,        # Slower learning
    max_depth=5,                # Shallower trees to prevent memorizing noise
    min_child_weight=10,        # Requires more data to create a branch
    gamma=0.2,                  # Minimum loss reduction required to split
    subsample=0.6,              # Sample less data per tree
    colsample_bytree=0.6,       # Sample fewer features per tree
    objective='reg:squarederror',
    n_jobs=-1,
    random_state=42,
    early_stopping_rounds=150
)

model.fit(
    X_train, y_train,
    eval_set=[(X_train, y_train), (X_val, y_val)],
    verbose=100
)

# =========================
# 6. EVALUATION & VISUALIZATION (SAVED TO FILE)
# =========================

print("--- STEP 5: Evaluating Performance ---")

# Predict & Inverse Transform
log_preds = model.predict(X_test)
final_preds = np.exp(log_preds)

# Metrics
rmse = np.sqrt(mean_squared_error(y_test_actual, final_preds))
mae = mean_absolute_error(y_test_actual, final_preds)
base_vol = y_test_actual.mean()
mape = (np.abs((y_test_actual - final_preds) / y_test_actual)).mean() * 100

print("\n" + "="*30)
print("       FINAL RESULTS       ")
print("="*30)
print(f"Average Volatility:   {base_vol:.6f}")
print(f"Model MAE:            {mae:.6f}")
print(f"Model RMSE:           {rmse:.6f}")
print(f"Relative Error (MAE): {(mae/base_vol)*100:.2f}%")
print(f"MAPE (Mean % Error):  {mape:.2f}%")
print("="*30 + "\n")

# --- SAVE PLOT 1: PREDICTION ZOOM ---
plt.figure(figsize=(15, 6))
zoom = 1000
# Plot Actual vs Predicted
plt.plot(y_test_actual.values[-zoom:], label="Actual Vol", color='black', alpha=0.6, linewidth=1.5)
plt.plot(final_preds[-zoom:], label="Predicted Vol", color='#00d4ff', alpha=0.9, linewidth=1.5)
plt.title(f"Volatility Prediction (Last {zoom} Mins) - MAPE: {mape:.2f}%")
plt.legend()
plt.grid(True, alpha=0.3)
plt.savefig("prediction_zoom.png")
print("Graph saved as 'prediction_zoom.png'")
# plt.close()

# --- SAVE PLOT 2: FEATURE IMPORTANCE ---
plt.figure(figsize=(10, 12))
xgb.plot_importance(model, max_num_features=25, height=0.5, importance_type='weight', title="Top 25 Features")
plt.tight_layout()
plt.savefig("feature_importance.png")
print("Graph saved as 'feature_importance.png'")
# plt.close()

# =========================
# 7. SAVE MODEL
# =========================

model.save_model("nifty_vol_final.json")
print("Model saved to 'nifty_vol_final.json'")