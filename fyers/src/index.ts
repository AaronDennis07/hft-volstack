import { fyersModel as FyersAPI } from 'fyers-api-v3';
import express, { Request, Response } from 'express';
import { writeTokens, readTokens } from './utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import cors from 'cors';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Prisma Client with PostgreSQL adapter for Prisma 7
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:mysecretpassword@localhost:5432/trading?schema=public';
const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Test database connection
prisma.$connect()
  .then(() => console.log('Connected to PostgreSQL via Prisma try'))
  .catch((error) => console.error('Failed to connect to database:', error));

const app = express();

// Strategy state management
let strategyInterval: NodeJS.Timeout | null = null;
let lastFetchedTimestamp: number | null = null;
let strategyRunning: boolean = false;
const SYMBOL = 'NSE:NIFTY50-INDEX';
app.use(cors());  // Allow all origins for testing
console.log('✅ CORS enabled for all origins (testing mode)');
// Insert candles into PostgreSQL using Prisma (batch insert 10,000 at a time)
const insertCandlesToDB = async (candles: number[][], symbol: string): Promise<number> => {
  console.log(`insertCandlesToDB called with ${candles.length} candles for symbol: ${symbol}`);
  if (candles.length === 0) {
    console.log('No candles to insert, returning 0');
    return 0;
  }

  const BATCH_SIZE = 10000;
  let totalInserted = 0;

  // Process in batches of 10,000
  for (let i = 0; i < candles.length; i += BATCH_SIZE) {
    const batch = candles.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(candles.length / BATCH_SIZE);
    
    console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} candles)...`);

    const data = batch.map((candle) => {
      const [timestamp, open, high, low, close, volume] = candle;
      return {
        symbol,
        timestamp: BigInt(timestamp),
        datetime: new Date(timestamp * 1000),
        open: new Prisma.Decimal(open),
        high: new Prisma.Decimal(high),
        low: new Prisma.Decimal(low),
        close: new Prisma.Decimal(close),
        volume: BigInt(volume),
      };
    });

    try {
      const result = await prisma.candle.createMany({
        data,
        skipDuplicates: true,
      });
      
      totalInserted += result.count;
      console.log(`Batch ${batchNumber}: Inserted ${result.count} candles (${totalInserted} total so far)`);
    } catch (error: any) {
      console.error(`Error inserting batch ${batchNumber}:`, error.message);
    }
  }

  console.log(`Database insertion complete:`);
  console.log(`  - Total inserted: ${totalInserted} new candles`);
  console.log(`  - Duplicates skipped: ${candles.length - totalInserted}`);
  return totalInserted;
};

// Get last timestamp from database
const getLastTimestampFromDB = async (symbol: string): Promise<number | null> => {
  const result = await prisma.candle.findFirst({
    where: { symbol },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });

  return result ? Number(result.timestamp) : null;
};

// Strategy function that runs every 40 seconds
const runStrategy = async (): Promise<void> => {
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
        lastFetchedTimestamp = dbLastTimestamp;
        console.log(`\nResuming from database - last timestamp: ${new Date(lastFetchedTimestamp * 1000).toISOString()}`);
      }
    }

    // If first run, get last hour of data
    let rangeFrom: string;
    if (!lastFetchedTimestamp) {
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      rangeFrom = Math.floor(oneHourAgo.getTime() / 1000).toString();
      console.log('\nFirst strategy run - fetching last hour of data');
    } else {
      // Get data from last fetch to now
      rangeFrom = (lastFetchedTimestamp + 1).toString();
      console.log(`\nFetching new candles since ${new Date(lastFetchedTimestamp * 1000).toISOString()}`);
    }

    const rangeTo = Math.floor(now.getTime() / 1000).toString();

    const inp = {
      symbol: SYMBOL,
      resolution: '1',
      date_format: '0',
      range_from: rangeFrom,
      range_to: rangeTo,
      cont_flag: '1',
    };

    console.log(`Fetching data from ${new Date(parseInt(rangeFrom) * 1000).toISOString()} to ${now.toISOString()}`);

    const history = await fyers.getHistory(inp);

    if (history.s === 'ok' && history.candles && history.candles.length > 0) {
      console.log(`Received ${history.candles.length} new candles`);

      // Sort candles oldest to newest
      history.candles.sort((a: number[], b: number[]) => a[0] - b[0]);

      // Insert to database
      await insertCandlesToDB(history.candles, SYMBOL);

      // Update last fetched timestamp
      lastFetchedTimestamp = history.candles[history.candles.length - 1][0];
      if (lastFetchedTimestamp !== null) {
        console.log(`Last candle timestamp: ${new Date(lastFetchedTimestamp * 1000).toISOString()}`);
      }

      // Here you can add your trading strategy logic
      const latestCandle = history.candles[history.candles.length - 1];
      const [timestamp, open, high, low, close, volume] = latestCandle;
      console.log(`Latest candle - O: ${open}, H: ${high}, L: ${low}, C: ${close}, V: ${volume}`);
    } else {
      console.log(`No new data available - ${history.message || 'Unknown'}`);
    }
  } catch (error: any) {
    console.error('Strategy error:', error.message);
  }
};

// Create a new instance of FyersAPI
const fyers = new FyersAPI();
const secretKey = '2NP2L1GD42';
fyers.setAppId('RK9MAYQO0K-100');
fyers.setRedirectUrl('http://127.0.0.1:3000/redirect');

const generateAuthcodeURL = fyers.generateAuthCode();

app.get('/login', (req: Request, res: Response) => {
  res.redirect(generateAuthcodeURL);
});

app.get('/redirect', (req: Request, res: Response) => {
  const { auth_code } = req.query;
  fyers
    .generate_access_token({ secret_key: secretKey, auth_code: auth_code as string })
    .then((response: any) => {
      const { access_token, refresh_token } = response;
      writeTokens({ access_token, refresh_token, expires_in: 14 });
    })
    .catch((error: any) => {
      console.log(error);
    });
  res.json({ auth_code });
});

app.get('/tokens', (req: Request, res: Response) => {
  const tokens = readTokens();
  res.json(tokens);
});

app.get('/profile', async (req: Request, res: Response) => {
  const tokens = readTokens();

  if (!tokens) {
    return res.status(401).json({ error: 'No tokens found. Please login first.' });
  }

  fyers.setAccessToken(tokens.access_token);
  console.log('Access token:', tokens.access_token);
  console.log('Token expires at:', new Date(tokens.expires_at).toISOString());
  console.log('Is expired:', Date.now() >= tokens.expires_at);

  try {
    const profile = await fyers.get_profile();
    console.log('Profile response:', profile);
    res.json(profile);
  } catch (error: any) {
    console.error('Profile fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch profile',
      message: error.message,
      details: error.response?.data || error.toString(),
    });
  }
});

app.get('/history', async (req: Request, res: Response) => {
  const tokens = readTokens();

  if (!tokens) {
    return res.status(401).json({ error: 'No tokens found. Please login first.' });
  }

  fyers.setAccessToken(tokens.access_token);
  console.log('Access token:', tokens.access_token);

  const symbol = (req.query.symbol as string) || 'NSE:NIFTY50-INDEX';
  const rangeFrom = (req.query.range_from as string) || Math.floor(new Date('2026-01-23').getTime() / 1000).toString();
  const rangeTo = (req.query.range_to as string) || Math.floor(new Date('2026-01-24').getTime() / 1000).toString();

  const inp = {
    symbol,
    resolution: (req.query.resolution as string) || '1',
    date_format: '0',
    range_from: rangeFrom,
    range_to: rangeTo,
    cont_flag: '1',
  };

  console.log('History request params:', inp);

  try {
    const history = await fyers.getHistory(inp);
    console.log('History response:', history);
    res.json(history);
  } catch (error: any) {
    console.error('History fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch history',
      message: error.message,
      details: error.response?.data || error.toString(),
    });
  }
});

app.get('/nifty50-1min', async (req: Request, res: Response) => {
  console.log('\n========== /nifty50-1min ENDPOINT CALLED ==========');
  const tokens = readTokens();

  if (!tokens) {
    console.log('ERROR: No tokens found');
    return res.status(401).json({ error: 'No tokens found. Please login first.' });
  }
  console.log('✓ Tokens found and loaded');

  fyers.setAccessToken(tokens.access_token);

  const totalDays = parseInt(req.query.days as string) || 500;
  const batchSize = 100;
  const symbol = (req.query.symbol as string) || 'NSE:NIFTY50-INDEX';

  const today = new Date();
  const startDate = new Date();
  startDate.setDate(today.getDate() - totalDays);

  console.log(`Fetching ${totalDays} days of data in ${Math.ceil(totalDays / batchSize)} batches of ${batchSize} days each`);
  console.log(`From: ${startDate.toISOString()} To: ${today.toISOString()}`);
  console.log(`Symbol: ${symbol}`);

  try {
    let allCandles: number[][] = [];
    let batchCount = 0;
    console.log('Starting batch fetching loop...');

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
        symbol,
        resolution: '1',
        date_format: '0',
        range_from: rangeFrom,
        range_to: rangeTo,
        cont_flag: '1',
      };

      const history = await fyers.getHistory(inp);
      console.log(`Batch ${batchCount}: API response status: ${history.s}`);

      if (history.s === 'ok' && history.candles && history.candles.length > 0) {
        console.log(`Batch ${batchCount}: Received ${history.candles.length} candles`);
        allCandles = allCandles.concat(history.candles);
      } else {
        console.log(`Batch ${batchCount}: No data or error - ${history.message || 'Unknown'}`);
      }

      if (daysAgo > batchSize) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    console.log(`\nTotal candles fetched: ${allCandles.length}`);

    allCandles.sort((a, b) => a[0] - b[0]);
    console.log('Candles sorted chronologically');

    if (allCandles.length > 0) {
      // Insert all candles to database
      console.log('\n========== DATABASE INSERTION STARTING ==========');
      console.log(`Attempting to insert ${allCandles.length} candles for symbol: ${symbol}`);
      const insertedCount = await insertCandlesToDB(allCandles, symbol);
      console.log(`========== DATABASE INSERTION COMPLETE: ${insertedCount} candles inserted ==========\n`);
      
      console.log('Creating CSV file...');
      const csvHeader = 'timestamp,datetime,open,high,low,close,volume\n';
      const csvRows = allCandles.map((candle) => {
        const [timestamp, open, high, low, close, volume] = candle;
        const datetime = new Date(timestamp * 1000).toISOString();
        return `${timestamp},${datetime},${open},${high},${low},${close},${volume}`;
      });

      const csvContent = csvHeader + csvRows.join('\n');
      const symbolName = symbol.replace(/:/g, '_').replace(/-/g, '_');
      const csvFilePath = path.join(__dirname, '..', `${symbolName}_1min_${totalDays}days.csv`);

      fs.writeFileSync(csvFilePath, csvContent, 'utf-8');
      console.log(`CSV saved to: ${csvFilePath}`);
      console.log(`Total rows in CSV: ${csvRows.length}`);

      console.log('\n========== ENDPOINT SUCCESSFUL ==========');
      console.log(`Total candles: ${allCandles.length}`);
      console.log(`CSV file: ${csvFilePath}`);
      console.log('==========================================\n');
      
      res.json({
        s: 'ok',
        symbol,
        resolution: '1',
        totalDays,
        batches: batchCount,
        candles: allCandles,
        csvFile: csvFilePath,
        totalCandles: allCandles.length,
        storedInDatabase: true,
        insertedCount,
        dateRange: {
          from: new Date(allCandles[0][0] * 1000).toISOString(),
          to: new Date(allCandles[allCandles.length - 1][0] * 1000).toISOString(),
        },
      });
    } else {
      res.json({
        s: 'error',
        message: 'No data fetched',
        totalDays,
        batches: batchCount,
      });
    }
  } catch (error: any) {
    console.error('\n========== ERROR IN /nifty50-1min ENDPOINT ==========');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('=================================================\n');
    res.status(500).json({
      error: 'Failed to fetch NIFTY 1min data',
      message: error.message,
      details: error.response?.data || error.toString(),
    });
  }
});

// Start strategy endpoint
app.post('/strategy/start', async (req: Request, res: Response) => {
  if (strategyRunning) {
    return res.json({
      status: 'already_running',
      message: 'Strategy is already running',
      lastFetch: lastFetchedTimestamp ? new Date(lastFetchedTimestamp * 1000).toISOString() : null,
    });
  }

  const tokens = readTokens();
  if (!tokens) {
    return res.status(401).json({ error: 'No tokens found. Please login first.' });
  }

  runStrategy();

  strategyInterval = setInterval(runStrategy, 40000);
  strategyRunning = true;

  console.log('Strategy started - running every 40 seconds');

  res.json({
    status: 'started',
    message: 'Strategy started successfully',
    interval: '40 seconds',
    database: 'PostgreSQL with Prisma',
    symbol: SYMBOL,
  });
});

// Stop strategy endpoint
app.post('/strategy/stop', (req: Request, res: Response) => {
  if (!strategyRunning) {
    return res.json({
      status: 'not_running',
      message: 'Strategy is not running',
    });
  }

  if (strategyInterval) {
    clearInterval(strategyInterval);
    strategyInterval = null;
  }
  strategyRunning = false;

  console.log('Strategy stopped');

  res.json({
    status: 'stopped',
    message: 'Strategy stopped successfully',
    lastFetch: lastFetchedTimestamp ? new Date(lastFetchedTimestamp * 1000).toISOString() : null,
  });
});

// Get strategy status
app.get('/strategy/status', async (req: Request, res: Response) => {
  const count = await prisma.candle.count({
    where: { symbol: SYMBOL },
  });

  const firstCandle = await prisma.candle.findFirst({
    where: { symbol: SYMBOL },
    orderBy: { datetime: 'asc' },
    select: { datetime: true },
  });

  const lastCandle = await prisma.candle.findFirst({
    where: { symbol: SYMBOL },
    orderBy: { datetime: 'desc' },
    select: { datetime: true },
  });

  res.json({
    running: strategyRunning,
    symbol: SYMBOL,
    lastFetch: lastFetchedTimestamp ? new Date(lastFetchedTimestamp * 1000).toISOString() : null,
    database: 'PostgreSQL with Prisma',
    totalCandles: count,
    firstCandle: firstCandle?.datetime || null,
    lastCandle: lastCandle?.datetime || null,
  });
});

// Reset strategy
app.post('/strategy/reset', async (req: Request, res: Response) => {
  if (strategyRunning) {
    return res.status(400).json({
      error: 'Cannot reset while strategy is running',
      message: 'Stop the strategy first',
    });
  }

  await prisma.candle.deleteMany({
    where: { symbol: SYMBOL },
  });

  lastFetchedTimestamp = null;

  console.log('Strategy reset - database cleared');

  res.json({
    status: 'reset',
    message: 'Strategy data cleared from database',
  });
});

// Query candles from database
app.get('/candles', async (req: Request, res: Response) => {
  const symbol = (req.query.symbol as string) || SYMBOL;
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;

  const candles = await prisma.candle.findMany({
    where: { symbol },
    orderBy: { timestamp: 'desc' },
    take: limit,
    skip: offset,
    select: {
      timestamp: true,
      datetime: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });

  res.json({
    symbol,
    count: candles.length,
    candles: candles.map((c) => ({
      ...c,
      timestamp: Number(c.timestamp),
      open: c.open.toString(),
      high: c.high.toString(),
      low: c.low.toString(),
      close: c.close.toString(),
      volume: Number(c.volume),
    })),
  });
});

// Export candles to CSV from database
app.get('/candles/export', async (req: Request, res: Response) => {
  const symbol = (req.query.symbol as string) || SYMBOL;
  const days = parseInt(req.query.days as string) || 30;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const candles = await prisma.candle.findMany({
    where: {
      symbol,
      datetime: { gte: cutoffDate },
    },
    orderBy: { timestamp: 'asc' },
    select: {
      timestamp: true,
      datetime: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });

  if (candles.length === 0) {
    return res.status(404).json({ error: 'No data found for the specified period' });
  }

  const csvHeader = 'timestamp,datetime,open,high,low,close,volume\n';
  const csvRows = candles.map(
    (row) =>
      `${row.timestamp},${row.datetime.toISOString()},${row.open},${row.high},${row.low},${row.close},${row.volume}`
  );

  const csvContent = csvHeader + csvRows.join('\n');
  const symbolName = symbol.replace(/:/g, '_').replace(/-/g, '_');
  const csvFilePath = path.join(__dirname, '..', `${symbolName}_export_${days}days.csv`);

  fs.writeFileSync(csvFilePath, csvContent, 'utf-8');

  res.json({
    message: 'CSV exported successfully',
    file: csvFilePath,
    rows: candles.length,
    dateRange: {
      from: candles[0].datetime,
      to: candles[candles.length - 1].datetime,
    },
  });
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  if (strategyInterval) {
    clearInterval(strategyInterval);
  }
  await prisma.$disconnect();
  process.exit(0);
});
