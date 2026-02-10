import pandas as pd
import numpy as np
import xgboost as xgb
from sqlalchemy import create_engine
from sklearn.metrics import accuracy_score, precision_score, recall_score, confusion_matrix
import matplotlib.pyplot as plt
import seaborn as sns

# =========================
# 1. SETUP & LOAD
# =========================
DB_URI = "postgresql+psycopg2://aaron:dennis@localhost:5432/volstack"
engine = create_engine(DB_URI)

print("--- STEP 1: Loading Data ---")
query = "SELECT * FROM nifty_volatility_features_1min ORDER BY timestamp ASC"
df = pd.read_sql(query, engine, parse_dates=["timestamp"])
df.set_index("timestamp", inplace=True)
df.sort_index(inplace=True)

# =========================
# 2. FEATURE ENGINEERING (HYBRID)
# =========================
print("--- STEP 2: Engineering Hybrid Features ---")

# A. Volatility Regime
df["vol_regime"] = df["rv_5"] / (df["rv_30"] + 1e-9)

# B. Momentum Indicators
# RSI-14
delta = df["close"].diff()
gain = (delta.where(delta > 0, 0)).rolling(14).mean()
loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
rs = gain / (loss + 1e-9)
df["rsi"] = 100 - (100 / (1 + rs))

# Trend Strength
df["trend_strength"] = (df["close"].rolling(5).mean() - df["close"].rolling(20).mean())

# C. VIX Interaction
df["vix_inv"] = df["vix_mom_5"] * -1

# D. Lags
df["ret_lag_1"] = df["ret"].shift(1)
df["ret_lag_5"] = df["ret"].shift(5)

# =========================
# 3. SELECT FEATURES & TARGET
# =========================
features = [
    'vol_regime', 'rv_5', 'rv_30', 'vix', 'parkinson',
    'rsi', 'trend_strength', 'ret_lag_1', 'ret_lag_5',
    'dispersion', 'vol_spike', 'vix_inv',
    'sin_time', 'cos_time'
]

# Target: Next 15-minute return Direction (1 = UP, 0 = DOWN)
future_ret = df["ret"].rolling(15).sum().shift(-15)
df["target_dir"] = np.where(future_ret > 0.0001, 1, 0)

# Clean NaNs
df = df.dropna()

print(f"Dataset Shape: {df.shape}")
print(f"Features: {len(features)}")

# =========================
# 4. SPLIT & TRAIN
# =========================
train_size = int(len(df) * 0.70)
val_size = int(len(df) * 0.15)

train = df.iloc[:train_size]
val = df.iloc[train_size : train_size + val_size]
test = df.iloc[train_size + val_size :]

X_train, y_train = train[features], train["target_dir"]
X_val, y_val = val[features], val["target_dir"]
X_test, y_test = test[features], test["target_dir"]

print("--- STEP 3: Training Hybrid Classifier ---")
ratio = float(np.sum(y_train == 0)) / np.sum(y_train == 1)

model = xgb.XGBClassifier(
    n_estimators=3000,
    learning_rate=0.01,
    max_depth=5,
    min_child_weight=10,
    gamma=0.2,
    subsample=0.7,
    colsample_bytree=0.7,
    scale_pos_weight=ratio,
    objective='binary:logistic',
    n_jobs=-1,
    random_state=42,
    early_stopping_rounds=150,
    eval_metric=["error", "logloss"]
)

model.fit(
    X_train, y_train,
    eval_set=[(X_train, y_train), (X_val, y_val)],
    verbose=100
)

# =========================
# 5. EVALUATION
# =========================
print("--- STEP 4: Evaluating ---")

# Get Probabilities
probs = model.predict_proba(X_test)[:, 1]

# Standard Metrics (50% Threshold)
preds_std = (probs > 0.5).astype(int)

print("\n" + "="*30)
print("     STANDARD RESULTS (50%)")
print("="*30)
print(f"Accuracy:  {accuracy_score(y_test, preds_std)*100:.2f}%")
print(f"Precision: {precision_score(y_test, preds_std)*100:.2f}%")

# High Confidence Metrics
threshold = 0.55
print("\n" + "="*30)
print(f"   HIGH CONFIDENCE RESULTS (>{int(threshold*100)}%)")
print("="*30)

mask = (probs > threshold) | (probs < (1-threshold))
filtered_y = y_test[mask]
filtered_preds = preds_std[mask]

if len(filtered_y) > 0:
    print(f"Trades Taken: {len(filtered_y)} (out of {len(y_test)})")
    print(f"Win Rate:     {accuracy_score(filtered_y, filtered_preds)*100:.2f}%")
else:
    print("No trades met the confidence threshold.")
print("="*30 + "\n")

# =========================
# 6. VISUALIZATION (PREDICTION VS ACTUAL)
# =========================

# --- SAVE PLOT 1: CONFIDENCE ZOOM ---
# This plots the Model Probability vs The Actual Market Moves
plt.figure(figsize=(15, 6))
zoom = 150 # Look at last 150 minutes to see details clearly

# Slice the data
prob_slice = pd.Series(probs, index=y_test.index).iloc[-zoom:]
actual_slice = y_test.iloc[-zoom:]

# Plot Model Probability (The Blue Line)
plt.plot(prob_slice.index, prob_slice, label="Model Confidence (Prob UP)", color='#00d4ff', linewidth=2)

# Plot Threshold Lines (The Decision Zones)
plt.axhline(0.55, color='green', linestyle='--', alpha=0.5, label='Buy Threshold (0.55)')
plt.axhline(0.45, color='red', linestyle='--', alpha=0.5, label='Sell Threshold (0.45)')
plt.axhline(0.50, color='gray', linestyle=':', alpha=0.3)

# Plot ACTUAL Outcomes (Triangles)
# Green Triangle at Top = Market Actually Went UP
# Red Triangle at Bottom = Market Actually Went DOWN
up_idx = actual_slice[actual_slice == 1].index
down_idx = actual_slice[actual_slice == 0].index

plt.scatter(up_idx, [1.02]*len(up_idx), color='green', marker='v', s=30, label='Actual UP', alpha=0.6)
plt.scatter(down_idx, [-0.02]*len(down_idx), color='red', marker='^', s=30, label='Actual DOWN', alpha=0.6)

plt.title(f"Model Confidence vs Actual Direction (Last {zoom} Mins)")
plt.ylim(-0.1, 1.1)
plt.legend(loc='center left')
plt.grid(True, alpha=0.3)
plt.savefig("direction_zoom.png")
print("Graph saved as 'direction_zoom.png'")

# --- SAVE PLOT 2: FEATURE IMPORTANCE ---
plt.figure(figsize=(10, 8))
xgb.plot_importance(model, max_num_features=20, height=0.5, title="Top 20 Features (Hybrid Model)")
plt.tight_layout()
plt.savefig("direction_importance.png")
print("Graph saved as 'direction_importance.png'")

# Save Model
model.save_model("nifty_direction_hybrid.json")
print("Model saved to 'nifty_direction_hybrid.json'")