// Import required modules
import { fyersModel as FyersAPI } from "fyers-api-v3";
import express from "express";
import { writeTokens, readTokens } from "./utlis.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fs from "fs";
import path from "path";
import pkg from "pg";
import cors from 'cors';
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// PostgreSQL connection pool
const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'trading',
    user: 'postgres',
    password: 'postgres',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Initialize database table
const initializeDatabase = async () => {
    const client = await pool.connect();
    try {
        // Create table if it doesn't exist
        await client.query(`
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
            )
        `);
        
        // Create indexes for better query performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_candles_symbol_timestamp 
            ON candles(symbol, timestamp DESC)
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_candles_datetime 
            ON candles(datetime DESC)
        `);
        
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    } finally {
        client.release();
    }
};

// Initialize database on startup
initializeDatabase();

const app = express();

// CORS configuration - MUST be before routes
app.use(cors());  // Allow all origins for testing
console.log('✅ CORS enabled for all origins (testing mode)');
// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Strategy state management
let strategyInterval = null;
let lastFetchedTimestamp = null;
let strategyRunning = false;
const SYMBOL = "NSE:NIFTY50-INDEX";

// Insert candles into PostgreSQL
const insertCandlesToDB = async (candles, symbol) => {
    if (candles.length === 0) return 0;
    
    const client = await pool.connect();
    try {
        let insertedCount = 0;
        
        for (const candle of candles) {
            const [timestamp, open, high, low, close, volume] = candle;
            const datetime = new Date(timestamp * 1000);
            
            try {
                await client.query(`
                    INSERT INTO candles (symbol, timestamp, datetime, open, high, low, close, volume)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (symbol, timestamp) DO NOTHING
                `, [symbol, timestamp, datetime, open, high, low, close, volume]);
                insertedCount++;
            } catch (err) {
                // Skip duplicates silently
                if (err.code !== '23505') { // Not a unique violation
                    console.error('Error inserting candle:', err.message);
                }
            }
        }
        
        console.log(`Inserted ${insertedCount} new candles to database`);
        return insertedCount;
    } finally {
        client.release();
    }
};

// Get last timestamp from database
const getLastTimestampFromDB = async (symbol) => {
    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT MAX(timestamp) as last_timestamp FROM candles WHERE symbol = $1',
            [symbol]
        );
        return result.rows[0]?.last_timestamp || null;
    } finally {
        client.release();
    }
};

// Strategy function that runs every 40 seconds
const runStrategy = async () => {
    try {
        const tokens = readTokens();
        if (!tokens) {
            console.log('No tokens found, skipping strategy run');
            return;
        }
        
        fyers.setAccessToken(tokens.access_token);
        
        const now = new Date();
        
        // Check database for last timestamp
        if (!lastFetchedTimestamp) {
            const dbLastTimestamp = await getLastTimestampFromDB(SYMBOL);
            if (dbLastTimestamp) {
                lastFetchedTimestamp = parseInt(dbLastTimestamp);
                console.log(`\nResuming from database - last timestamp: ${new Date(lastFetchedTimestamp * 1000).toISOString()}`);
            }
        }
        
        // If first run, get last hour of data
        let rangeFrom;
        if (!lastFetchedTimestamp) {
            const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
            rangeFrom = Math.floor(oneHourAgo.getTime() / 1000).toString();
            console.log('\nFirst strategy run - fetching last hour of data');
        } else {
            // Get data from last fetch to now
            rangeFrom = (lastFetchedTimestamp + 1).toString(); // Add 1 to avoid duplicate
            console.log(`\nFetching new candles since ${new Date(lastFetchedTimestamp * 1000).toISOString()}`);
        }
        
        const rangeTo = Math.floor(now.getTime() / 1000).toString();
        
        const inp = {
            symbol: SYMBOL,
            resolution: "1",
            date_format: "0",
            range_from: rangeFrom,
            range_to: rangeTo,
            cont_flag: "1"
        };
        
        console.log(`Fetching data from ${new Date(parseInt(rangeFrom) * 1000).toISOString()} to ${now.toISOString()}`);
        
        const history = await fyers.getHistory(inp);
        
        if (history.s === 'ok' && history.candles && history.candles.length > 0) {
            console.log(`Received ${history.candles.length} new candles`);
            
            // Sort candles oldest to newest
            history.candles.sort((a, b) => a[0] - b[0]);
            
            // Insert to database
            await insertCandlesToDB(history.candles, SYMBOL);
            
            // Update last fetched timestamp
            lastFetchedTimestamp = history.candles[history.candles.length - 1][0];
            console.log(`Last candle timestamp: ${new Date(lastFetchedTimestamp * 1000).toISOString()}`);
            
            // Here you can add your trading strategy logic
            // Example: Analyze the new candles
            const latestCandle = history.candles[history.candles.length - 1];
            const [timestamp, open, high, low, close, volume] = latestCandle;
            console.log(`Latest candle - O: ${open}, H: ${high}, L: ${low}, C: ${close}, V: ${volume}`);
            
        } else {
            console.log(`No new data available - ${history.message || 'Unknown'}`);
        }
        
    } catch (error) {
        console.error('Strategy error:', error.message);
    }
};

// Create a new instance of FyersAPI
var fyers = new FyersAPI()
const secretKey = "2NP2L1GD42"; // Replace with your actual secret key
// Set your APPID obtained from Fyers (replace "xxx-1xx" with your actual APPID)
fyers.setAppId("RK9MAYQO0K-100");

// Set the RedirectURL where the authorization code will be sent after the user grants access
// Make sure your redirectURL matches with your server URL and port
fyers.setRedirectUrl(`http://127.0.0.1:3000/redirect`);

// Generate the URL to initiate the OAuth2 authentication process and get the authorization code
var generateAuthcodeURL = fyers.generateAuthCode();

app.get('/login',(req, res) => {
    res.redirect(generateAuthcodeURL);
});

app.get('/redirect', async (req, res) => {
    const {auth_code} = req.query;
    try {
        const response = await fyers.generate_access_token({ 
            "secret_key": secretKey, 
            "auth_code": auth_code 
        });
        const { access_token, refresh_token } = response;
        writeTokens({ access_token, refresh_token, expires_in: 14});
        
        // Redirect to frontend after successful login
        res.redirect('http://localhost:5173/dashboard');
    } catch (error) {
        console.log(error);
        res.redirect('http://localhost:5173/login?error=auth_failed');
    }
});

app.get('/tokens', (req, res) => {
    const tokens = readTokens();
    if (!tokens) {
        return res.status(401).json({ error: 'No tokens found' });
    }
    res.json(tokens);
});

app.get('/profile', async (req, res) => {
    const tokens = readTokens();    
    
    if (!tokens) {
        return res.status(401).json({ error: 'No tokens found. Please login first.' });
    }
    
    fyers.setAccessToken(tokens.access_token);
    
    try {
        const profile = await fyers.get_profile();
        res.json(profile);  
    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch profile',
            message: error.message
        });
    }   
});

app.get('/history', async (req, res) => {
    const tokens = readTokens();    
    
    if (!tokens) {
        return res.status(401).json({ error: 'No tokens found. Please login first.' });
    }
    
    fyers.setAccessToken(tokens.access_token);
    
    const symbol = req.query.symbol || "NSE:NIFTY50-INDEX";
    const rangeFrom = req.query.range_from || Math.floor(new Date("2026-01-23").getTime() / 1000).toString();
    const rangeTo = req.query.range_to || Math.floor(new Date("2026-01-24").getTime() / 1000).toString();
    
    const inp = {
        symbol: symbol,
        resolution: req.query.resolution || "1",
        date_format: "0",
        range_from: rangeFrom,
        range_to: rangeTo,
        cont_flag: "1"
    };
    
    try {
        const history = await fyers.getHistory(inp);
        res.json(history);  
    } catch (error) {
        console.error('History fetch error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch history',
            message: error.message
        });
    }   
});

app.get('/nifty50-1min', async (req, res) => {
    const tokens = readTokens();    
    
    if (!tokens) {
        return res.status(401).json({ error: 'No tokens found. Please login first.' });
    }
    
    fyers.setAccessToken(tokens.access_token);
    
    // Default to 500 days, batch in 100-day chunks (API limit)
    const totalDays = parseInt(req.query.days) || 500;
    const batchSize = 100; // API limit
    const symbol = req.query.symbol || "NSE:NIFTY50-INDEX";
    
    const today = new Date();
    const startDate = new Date();
    startDate.setDate(today.getDate() - totalDays);
    
    console.log(`Fetching ${totalDays} days of data in ${Math.ceil(totalDays / batchSize)} batches of ${batchSize} days each`);
    console.log(`From: ${startDate.toISOString()} To: ${today.toISOString()}`);
    
    try {
        let allCandles = [];
        let batchCount = 0;
        
        // Create batches from oldest to newest
        for (let daysAgo = totalDays; daysAgo > 0; daysAgo -= batchSize) {
            const batchEndDaysAgo = Math.max(0, daysAgo - batchSize);
            
            const batchStart = new Date();
            batchStart.setDate(today.getDate() - daysAgo);
            
            const batchEnd = new Date();
            batchEnd.setDate(today.getDate() - batchEndDaysAgo);
            
            const rangeFrom = Math.floor(batchStart.getTime() / 1000).toString();
            const rangeTo = Math.floor(batchEnd.getTime() / 1000).toString();
            
            batchCount++;
            console.log(`\nBatch ${batchCount}: ${batchStart.toISOString().split('T')[0]} to ${batchEnd.toISOString().split('T')[0]}`);
            
            const inp = {
                symbol: symbol,
                resolution: "1",
                date_format: "0",
                range_from: rangeFrom,
                range_to: rangeTo,
                cont_flag: "1"
            };
            
            const history = await fyers.getHistory(inp);
            
            if (history.s === 'ok' && history.candles && history.candles.length > 0) {
                console.log(`Batch ${batchCount}: Received ${history.candles.length} candles`);
                allCandles = allCandles.concat(history.candles);
            } else {
                console.log(`Batch ${batchCount}: No data or error - ${history.message || 'Unknown'}`);
            }
            
            // Small delay between requests to avoid rate limiting
            if (daysAgo > batchSize) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
        console.log(`\nTotal candles fetched: ${allCandles.length}`);
        
        // Sort candles from oldest to newest (by timestamp)
        allCandles.sort((a, b) => a[0] - b[0]);
        
        // Save to CSV if data is available
        if (allCandles.length > 0) {
            const csvHeader = 'timestamp,datetime,open,high,low,close,volume\n';
            const csvRows = allCandles.map(candle => {
                const [timestamp, open, high, low, close, volume] = candle;
                const datetime = new Date(timestamp * 1000).toISOString();
                return `${timestamp},${datetime},${open},${high},${low},${close},${volume}`;
            });
            
            const csvContent = csvHeader + csvRows.join('\n');
            const symbolName = symbol.replace(/:/g, '_').replace(/-/g, '_');
            const csvFilePath = path.join(__dirname, `${symbolName}_1min_${totalDays}days.csv`);
            
            fs.writeFileSync(csvFilePath, csvContent, 'utf-8');
            console.log(`CSV saved to: ${csvFilePath}`);
            console.log(`Total rows in CSV: ${csvRows.length}`);
            
            res.json({ 
                s: 'ok',
                symbol: symbol,
                resolution: '1',
                totalDays: totalDays,
                batches: batchCount,
                candles: allCandles,
                csvFile: csvFilePath,
                totalCandles: allCandles.length,
                dateRange: {
                    from: new Date(allCandles[0][0] * 1000).toISOString(),
                    to: new Date(allCandles[allCandles.length - 1][0] * 1000).toISOString()
                }
            });
        } else {
            res.json({ 
                s: 'error',
                message: 'No data fetched',
                totalDays: totalDays,
                batches: batchCount
            });
        }
    } catch (error) {
        console.error('NIFTY 1min fetch error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch NIFTY 1min data',
            message: error.message
        });
    }   
});

// Start strategy endpoint
app.post('/strategy/start', async (req, res) => {
    if (strategyRunning) {
        return res.json({ 
            success: false,
            message: 'Strategy already running',
            lastFetch: lastFetchedTimestamp ? new Date(lastFetchedTimestamp * 1000).toISOString() : null
        });
    }
    
    const tokens = readTokens();
    if (!tokens) {
        return res.status(401).json({ error: 'No tokens found. Please login first.' });
    }
    
    // Run immediately
    runStrategy();
    
    // Then run every 40 seconds
    strategyInterval = setInterval(runStrategy, 40000);
    strategyRunning = true;
    
    console.log('Strategy started - running every 40 seconds');
    
    res.json({ 
        success: true,
        message: 'Strategy started successfully',
        interval: '40 seconds',
        symbol: SYMBOL
    });
});

// Stop strategy endpoint
app.post('/strategy/stop', (req, res) => {
    if (!strategyRunning) {
        return res.json({ 
            success: false,
            message: 'Strategy not running'
        });
    }
    
    clearInterval(strategyInterval);
    strategyInterval = null;
    strategyRunning = false;
    
    console.log('Strategy stopped');
    
    res.json({ 
        success: true,
        message: 'Strategy stopped successfully',
        lastFetch: lastFetchedTimestamp ? new Date(lastFetchedTimestamp * 1000).toISOString() : null
    });
});

// Get strategy status
app.get('/strategy/status', async (req, res) => {
    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT COUNT(*) as count, MIN(datetime) as first_candle, MAX(datetime) as last_candle FROM candles WHERE symbol = $1',
            [SYMBOL]
        );
        
        res.json({
            running: strategyRunning,
            symbol: SYMBOL,
            lastFetch: lastFetchedTimestamp ? new Date(lastFetchedTimestamp * 1000).toISOString() : null,
            totalCandles: parseInt(result.rows[0].count),
            firstCandle: result.rows[0].first_candle,
            lastCandle: result.rows[0].last_candle
        });
    } finally {
        client.release();
    }
});

// Reset strategy (clear database and state)
app.post('/strategy/reset', async (req, res) => {
    if (strategyRunning) {
        return res.status(400).json({ 
            error: 'Cannot reset while strategy is running',
            message: 'Stop the strategy first'
        });
    }
    
    const client = await pool.connect();
    try {
        await client.query('DELETE FROM candles WHERE symbol = $1', [SYMBOL]);
        lastFetchedTimestamp = null;
        
        console.log('Strategy reset - database cleared');
        
        res.json({ 
            success: true,
            message: 'Strategy data cleared from database'
        });
    } finally {
        client.release();
    }
});

// Query candles from database
app.get('/candles', async (req, res) => {
    const symbol = req.query.symbol || SYMBOL;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT timestamp, datetime, open, high, low, close, volume 
            FROM candles 
            WHERE symbol = $1 
            ORDER BY timestamp DESC 
            LIMIT $2 OFFSET $3
        `, [symbol, limit, offset]);
        
        res.json({
            symbol: symbol,
            count: result.rows.length,
            candles: result.rows
        });
    } finally {
        client.release();
    }
});

// Export candles to CSV from database
app.get('/candles/export', async (req, res) => {
    const symbol = req.query.symbol || SYMBOL;
    const days = parseInt(req.query.days) || 30;
    
    const client = await pool.connect();
    try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        
        const result = await client.query(`
            SELECT timestamp, datetime, open, high, low, close, volume 
            FROM candles 
            WHERE symbol = $1 AND datetime >= $2
            ORDER BY timestamp ASC
        `, [symbol, cutoffDate]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No data found for the specified period' });
        }
        
        const csvHeader = 'timestamp,datetime,open,high,low,close,volume\n';
        const csvRows = result.rows.map(row => 
            `${row.timestamp},${row.datetime.toISOString()},${row.open},${row.high},${row.low},${row.close},${row.volume}`
        );
        
        const csvContent = csvHeader + csvRows.join('\n');
        const symbolName = symbol.replace(/:/g, '_').replace(/-/g, '_');
        const csvFilePath = path.join(__dirname, `${symbolName}_export_${days}days.csv`);
        
        fs.writeFileSync(csvFilePath, csvContent, 'utf-8');
        
        res.json({
            message: 'CSV exported successfully',
            file: csvFilePath,
            rows: result.rows.length,
            dateRange: {
                from: result.rows[0].datetime,
                to: result.rows[result.rows.length - 1].datetime
            }
        });
    } finally {
        client.release();
    }
});

app.listen(3000, () => {
    console.log('Server is running on port 3000');
    console.log('CORS enabled for http://localhost:5173');
});