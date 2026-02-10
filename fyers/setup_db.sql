-- Create trading database
CREATE DATABASE trading;

-- Connect to trading database
\c trading

-- Create candles table
CREATE TABLE IF NOT EXISTS candles (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(50) NOT NULL,
    timestamp BIGINT NOT NULL,
    datetime TIMESTAMP NOT NULL,
    open DECIMAL(12, 2) NOT NULL,
    high DECIMAL(12, 2) NOT NULL,
    low DECIMAL(12, 2) NOT NULL,
    close DECIMAL(12, 2) NOT NULL,
    volume BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(symbol, timestamp)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_candles_symbol_timestamp 
ON candles(symbol, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_candles_datetime 
ON candles(datetime DESC);

-- Grant permissions (adjust user as needed)
GRANT ALL PRIVILEGES ON DATABASE trading TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;
