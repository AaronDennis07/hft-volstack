import 'dotenv/config';
import express from 'express';
import fyersAuthRoutes from './routes/fyersAuth.routes';
import { fyersApiService } from './services/fyersApi.service';
import { fyersTokenStore } from './storage/fyersTokenStore';
import { prisma } from './lib/prisma'
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/auth', fyersAuthRoutes);

app.get('/', async(req, res) => {
  const token = await fyersTokenStore.get();
  res.json({
    status: "Fyers Trading Server is running!",
    authenticated: !!token,
    message: token ? "✅ Logged in" : "❌ Not logged in - visit /auth/login"
  });
});

app.get('/status', async (req, res) => {
  const { fyersTokenStore } = await import('./storage/fyersTokenStore');
  const token = await fyersTokenStore.get();
  
  res.json({
    authenticated: !!token,
    message: token 
      ? "Logged in. Token expires at: " + new Date(token.expiresAt).toISOString()
      : "Not logged in. Visit /auth/login to authenticate"
  });
});

app.get('/getProfile', async (req, res) => {
  try {
    const token = await fyersTokenStore.get();
    console.log("🔍 Checking token before profile fetch:", token ? "Token exists" : "No token found");
    
    const profile = await fyersApiService.getProfile();
    res.json(profile);
  } catch (error: any) {
    console.error("❌ Profile error:", error.message);
    
    const token = await fyersTokenStore.get();
    
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ 
        error: "Not authenticated",
        message: "Please login first at /auth/login",
        tokenPresent: !!token
      });
    }
    
    res.status(500).json({ 
      token: token,
      error: error.message || "Failed to fetch profile"
    });
  }
});

app.get('/getFunds', async (req, res) => {
  try {
    const funds = await fyersApiService.getFunds();
    res.json(funds);
  } catch (error: any) {
    console.error("Funds error:", error.message);
    
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ 
        error: "Not authenticated",
        message: "Please login first at /auth/login"
      });
    }
    
    res.status(500).json({ 
      error: error.message || "Failed to fetch funds"
    });
  }
});

app.get('/getHistoricalData', async (req, res) => {
  try {
    const { symbol, resolution, range_from, range_to, cont_flag, oi_flag } = req.query;

    // Validate required parameters
    if (!symbol || !resolution || !range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: symbol, resolution, range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: "/getHistoricalData?symbol=NSE:SBIN-EQ&resolution=1D&range_from=01/01/2024&range_to=02/01/2024"
      });
    }

    // Validate date format (DD/MM/YYYY)
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from as string) || !dateRegex.test(range_to as string)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format",
        example: "range_from=01/01/2024&range_to=02/01/2024"
      });
    }

    const data = await fyersApiService.getHistoricalData({
      symbol: symbol as string,
      resolution: resolution as string,
      range_from: range_from as string,
      range_to: range_to as string,
      cont_flag: cont_flag ? parseInt(cont_flag as string) : undefined,
      oi_flag: oi_flag ? parseInt(oi_flag as string) : undefined
    });

    res.json(data);
  } catch (error: any) {
    console.error("Historical data error:", error.message);
    
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ 
        error: "Not authenticated",
        message: "Please login first at /auth/login"
      });
    }
    
    res.status(500).json({ 
      error: error.message || "Failed to fetch historical data",
      details: error.response?.data
    });
  }
});

app.get('/prisma-test', async (req, res) => {
    const deleteAll = await prisma.test.deleteMany();
    console.log('Deleted tests:', deleteAll)
    const test = await prisma.test.create({
    data: {
      name: 'Alice'
    }
  })
  console.log('Created test:', test)

  // Fetch all users with their posts
  const allTests = await prisma.test.findMany()
  console.log('All tests:', JSON.stringify(allTests, null, 2))
  return res.json(allTests);
});

app.post('/syncNifty50Data', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    // Validate required parameters
    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    // Validate date format (DD/MM/YYYY)
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    console.log(`📊 Fetching NIFTY50 1-min data from ${range_from} to ${range_to}...`);

    // Fetch historical data from Fyers
    const data = await fyersApiService.getHistoricalData({
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "1",
      range_from: range_from,
      range_to: range_to    
    });
    console.log(data)
    if (data.s !== "ok" || !data.candles) {
      return res.status(500).json({
        error: "Failed to fetch data from Fyers",
        details: data
      });
    }

    console.log(`📈 Received ${data.candles.length} candles`);

    // Store data in database
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const candle of data.candles) {
      const [timestamp, open, high, low, close, volume] = candle;
    //   console.log(candle)
      try {
        await prisma.niftySpot1Min.upsert({
          where: { timestamp: new Date(timestamp * 1000) },
          update: {
            open: open,
            high: high,
            low: low,
            close: close,
            volume: volume !== undefined && volume !== null ? BigInt(volume) : null
          },
          create: {
            timestamp: new Date(timestamp * 1000),
            open: open,
            high: high,
            low: low,
            close: close,
            volume: BigInt(volume)
          }
        });
        inserted++;
      } catch (error: any) {
        if (error.code === 'P2002') {
          updated++;
        } else {
          skipped++;
          console.error(`Failed to insert candle at ${new Date(timestamp * 1000)}:`, error.message);
        }
      }
    }

    console.log(`✅ Sync complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped`);

    res.json({
      success: true,
      message: "NIFTY50 data synced successfully",
      stats: {
        total: data.candles.length,
        inserted,
        updated,
        skipped
      },
      dateRange: {
        from: range_from,
        to: range_to
      }
    });

  } catch (error: any) {
    console.error("❌ Sync error:", error.message);
    
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ 
        error: "Not authenticated",
        message: "Please login first at /auth/login"
      });
    }
    
    res.status(500).json({ 
      error: error.message || "Failed to sync NIFTY50 data",
      details: error.response?.data
    });
  }
});

app.get('/getNifty50Data', async (req, res) => {
  try {
    const { start_date, end_date, limit, order } = req.query;

    let where: any = {};

    if (start_date) {
      // Validate date format
      const startDate = new Date(start_date as string);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({
          error: "Invalid start_date format",
          message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss"
        });
      }
      where.timestamp = { ...where.timestamp, gte: startDate };
    }

    if (end_date) {
      // Validate date format
      const endDate = new Date(end_date as string);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({
          error: "Invalid end_date format",
          message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss"
        });
      }
      where.timestamp = { ...where.timestamp, lte: endDate };
    }

    const limitNum = limit ? parseInt(limit as string) : 100;
    
    // Validate limit
    if (limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({
        error: "Invalid limit",
        message: "Limit must be between 1 and 10000"
      });
    }

    const data = await prisma.niftySpot1Min.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { timestamp: order === 'desc' ? 'desc' : 'asc' },
      take: limitNum
    });

    // Convert Decimal to number for JSON response
    const formattedData = data.map(candle => {
      // Convert UTC to IST (UTC+5:30) for ISO format display
      
      return {
        timestamp: candle.timestamp.toISOString(),
        timestamp_ist: candle.timestamp.toString(),
        open: parseFloat(candle.open.toString()),
        high: parseFloat(candle.high.toString()),
        low: parseFloat(candle.low.toString()),
        close: parseFloat(candle.close.toString()),
        volume: candle.volume !== null ? Number(candle.volume) : null
      };
    });

    res.json({
      success: true,
      count: formattedData.length,
      query: {
        start_date: start_date || null,
        end_date: end_date || null,
        limit: limitNum
      },
      data: formattedData
    });

  } catch (error: any) {
    console.error("❌ Get data error:", error.message);
    res.status(500).json({ 
      error: error.message || "Failed to fetch NIFTY50 data"
    });
  }
});

// =============================
// HELPER FUNCTIONS FOR STOCK DATA SYNC
// =============================

interface StockConfig {
  symbol: string;
  model: any;
  name: string;
}

// Helper to chunk date ranges into smaller periods
function chunkDateRange(startDate: string, endDate: string, chunkDays: number = 90): Array<{from: string, to: string}> {
  const chunks: Array<{from: string, to: string}> = [];
  
  // Parse DD/MM/YYYY format
  const parseDate = (ddmmyyyy: string): Date => {
    const [day, month, year] = ddmmyyyy.split('/').map(Number);
    return new Date(year, month - 1, day);
  };
  
  // Format back to DD/MM/YYYY
  const formatDate = (date: Date): string => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  };
  
  let currentStart = parseDate(startDate);
  const finalEnd = parseDate(endDate);
  
  while (currentStart < finalEnd) {
    let currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + chunkDays);
    
    if (currentEnd > finalEnd) {
      currentEnd = finalEnd;
    }
    
    chunks.push({
      from: formatDate(currentStart),
      to: formatDate(currentEnd)
    });
    
    currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() + 1);
  }
  
  return chunks;
}

async function syncStockData(config: StockConfig, range_from: string, range_to: string) {
  // Calculate date difference to determine if chunking is needed
  const parseDate = (ddmmyyyy: string): Date => {
    const [day, month, year] = ddmmyyyy.split('/').map(Number);
    return new Date(year, month - 1, day);
  };
  
  const startDate = parseDate(range_from);
  const endDate = parseDate(range_to);
  const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  
  console.log(`📊 Fetching ${config.name} 1-min data from ${range_from} to ${range_to} (${daysDiff} days)...`);
  
  // If date range is > 90 days, chunk it
  if (daysDiff > 90) {
    console.log(`⚠️  Date range too large (${daysDiff} days), chunking into 90-day 90...`);
    const chunks = chunkDateRange(range_from, range_to, 90);
    console.log(`📦 Split into ${chunks.length} chunks`);
    
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalCandles = 0;
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`📦 Processing chunk ${i + 1}/${chunks.length}: ${chunk.from} to ${chunk.to}`);
      
      try {
        const data = await fyersApiService.getHistoricalData({
          symbol: config.symbol,
          resolution: "1",
          range_from: chunk.from,
          range_to: chunk.to
        });

        if (data.s !== "ok" || !data.candles) {
          console.error(`❌ Chunk ${i + 1} failed: ${JSON.stringify(data)}`);
          continue;
        }

        console.log(`📈 Received ${data.candles.length} candles for ${config.name} (chunk ${i + 1})`);
        totalCandles += data.candles.length;

        for (const candle of data.candles) {
          const [timestamp, open, high, low, close, volume] = candle;
          
          try {
            await config.model.upsert({
              where: { timestamp: new Date(timestamp * 1000) },
              update: {
                open: open,
                high: high,
                low: low,
                close: close,
                volume: volume !== undefined && volume !== null ? BigInt(volume) : null
              },
              create: {
                timestamp: new Date(timestamp * 1000),
                open: open,
                high: high,
                low: low,
                close: close,
                volume: BigInt(volume)
              }
            });
            totalInserted++;
          } catch (error: any) {
            if (error.code === 'P2002') {
              totalUpdated++;
            } else {
              totalSkipped++;
            }
          }
        }
        
        // Rate limiting: wait 2 seconds between chunks
        if (i < chunks.length - 1) {
          console.log(`⏳ Waiting 2s before next chunk...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error: any) {
        console.error(`❌ Error processing chunk ${i + 1}:`, error.message);
        throw error;
      }
    }
    
    console.log(`✅ ${config.name}: Processed ${totalCandles} total candles across ${chunks.length} chunks`);
    return { total: totalCandles, inserted: totalInserted, updated: totalUpdated, skipped: totalSkipped };
  }
  
  // Original logic for date ranges <= 90 days
  const data = await fyersApiService.getHistoricalData({
    symbol: config.symbol,
    resolution: "1",
    range_from: range_from,
    range_to: range_to
  });

  if (data.s !== "ok" || !data.candles) {
    throw new Error(`Failed to fetch data from Fyers: ${JSON.stringify(data)}`);
  }

  console.log(`📈 Received ${data.candles.length} candles for ${config.name}`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const candle of data.candles) {
    const [timestamp, open, high, low, close, volume] = candle;
    
    try {
      await config.model.upsert({
        where: { timestamp: new Date(timestamp * 1000) },
        update: {
          open: open,
          high: high,
          low: low,
          close: close,
          volume: volume !== undefined && volume !== null ? BigInt(volume) : null
        },
        create: {
          timestamp: new Date(timestamp * 1000),
          open: open,
          high: high,
          low: low,
          close: close,
          volume: BigInt(volume)
        }
      });
      inserted++;
    } catch (error: any) {
      if (error.code === 'P2002') {
        updated++;
      } else {
        skipped++;
        console.error(`Failed to insert candle for ${config.name} at ${new Date(timestamp * 1000)}:`, error.message);
      }
    }
  }

  return { total: data.candles.length, inserted, updated, skipped };
}

// Helper function for India VIX syncing with chunking support
async function syncIndiaVixData(range_from: string, range_to: string) {
  const parseDate = (ddmmyyyy: string): Date => {
    const [day, month, year] = ddmmyyyy.split('/').map(Number);
    return new Date(year, month - 1, day);
  };
  
  const startDate = parseDate(range_from);
  const endDate = parseDate(range_to);
  const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  
  console.log(`📊 Fetching India VIX data from ${range_from} to ${range_to} (${daysDiff} days)...`);
  
  // If date range is > 90 days, chunk it
  if (daysDiff > 90) {
    console.log(`⚠️  Date range too large (${daysDiff} days), chunking into 90-day periods...`);
    const chunks = chunkDateRange(range_from, range_to, 90);
    console.log(`📦 Split into ${chunks.length} chunks`);
    
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalCandles = 0;
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`📦 Processing chunk ${i + 1}/${chunks.length}: ${chunk.from} to ${chunk.to}`);
      
      try {
        const data = await fyersApiService.getHistoricalData({
          symbol: "NSE:INDIAVIX-INDEX",
          resolution: "1",
          range_from: chunk.from,
          range_to: chunk.to
        });

        if (data.s !== "ok" || !data.candles) {
          console.error(`❌ Chunk ${i + 1} failed: ${JSON.stringify(data)}`);
          continue;
        }

        console.log(`📈 Received ${data.candles.length} VIX candles (chunk ${i + 1})`);
        totalCandles += data.candles.length;

        for (const candle of data.candles) {
          const [timestamp, , , , close] = candle;
          
          try {
            await prisma.indiaVix1Min.upsert({
              where: { timestamp: new Date(timestamp * 1000) },
              update: { close: close },
              create: {
                timestamp: new Date(timestamp * 1000),
                close: close
              }
            });
            totalInserted++;
          } catch (error: any) {
            if (error.code === 'P2002') {
              totalUpdated++;
            } else {
              totalSkipped++;
            }
          }
        }
        
        // Rate limiting: wait 2 seconds between chunks
        if (i < chunks.length - 1) {
          console.log(`⏳ Waiting 2s before next chunk...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error: any) {
        console.error(`❌ Error processing chunk ${i + 1}:`, error.message);
        throw error;
      }
    }
    
    console.log(`✅ India VIX: Processed ${totalCandles} total candles across ${chunks.length} chunks`);
    return { total: totalCandles, inserted: totalInserted, updated: totalUpdated, skipped: totalSkipped };
  }
  
  // Original logic for date ranges <= 90 days
  const data = await fyersApiService.getHistoricalData({
    symbol: "NSE:INDIAVIX-INDEX",
    resolution: "1",
    range_from: range_from,
    range_to: range_to
  });

  if (data.s !== "ok" || !data.candles) {
    throw new Error(`Failed to fetch India VIX data from Fyers: ${JSON.stringify(data)}`);
  }

  console.log(`📈 Received ${data.candles.length} VIX candles`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const candle of data.candles) {
    const [timestamp, , , , close] = candle;
    
    try {
      await prisma.indiaVix1Min.upsert({
        where: { timestamp: new Date(timestamp * 1000) },
        update: { close: close },
        create: {
          timestamp: new Date(timestamp * 1000),
          close: close
        }
      });
      inserted++;
    } catch (error: any) {
      if (error.code === 'P2002') {
        updated++;
      } else {
        skipped++;
      }
    }
  }

  return { total: data.candles.length, inserted, updated, skipped };
}


// =============================
// OPTION CHAIN ENDPOINTS
// =============================


// =============================
// INDIVIDUAL STOCK ENDPOINTS
// =============================

// HDFC Bank
app.post('/syncHDFCData', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format"
      });
    }

    const stats = await syncStockData(
      { symbol: "NSE:HDFCBANK-EQ", model: prisma.hDFCSpot1Min, name: "HDFC Bank" },
      range_from,
      range_to
    );

    res.json({
      success: true,
      message: "HDFC Bank data synced successfully",
      stats,
      dateRange: { from: range_from, to: range_to }
    });
  } catch (error: any) {
    console.error("❌ HDFC sync error:", error.message);
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ error: "Not authenticated", message: "Please login first at /auth/login" });
    }
    res.status(500).json({ error: error.message || "Failed to sync HDFC data" });
  }
});

app.get('/getHDFCData', async (req, res) => {
  try {
    const { start_date, end_date, limit, order } = req.query;
    let where: any = {};

    if (start_date) {
      const startDate = new Date(start_date as string);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({ error: "Invalid start_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, gte: startDate };
    }

    if (end_date) {
      const endDate = new Date(end_date as string);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({ error: "Invalid end_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, lte: endDate };
    }

    const limitNum = limit ? parseInt(limit as string) : 100;
    if (limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({ error: "Invalid limit", message: "Limit must be between 1 and 10000" });
    }

    const data = await prisma.hDFCSpot1Min.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { timestamp: order === 'desc' ? 'desc' : 'asc' },
      take: limitNum
    });

    const formattedData = data.map(candle => ({
      timestamp: candle.timestamp.toISOString(),
      timestamp_ist: candle.timestamp.toString(),
      open: parseFloat(candle.open.toString()),
      high: parseFloat(candle.high.toString()),
      low: parseFloat(candle.low.toString()),
      close: parseFloat(candle.close.toString()),
      volume: candle.volume !== null ? Number(candle.volume) : null
    }));

    res.json({
      success: true,
      count: formattedData.length,
      query: { start_date: start_date || null, end_date: end_date || null, limit: limitNum },
      data: formattedData
    });
  } catch (error: any) {
    console.error("❌ Get HDFC data error:", error.message);
    res.status(500).json({ error: error.message || "Failed to fetch HDFC data" });
  }
});

// Reliance
app.post('/syncRelianceData', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format"
      });
    }

    const stats = await syncStockData(
      { symbol: "NSE:RELIANCE-EQ", model: prisma.rILSpot1Min, name: "Reliance" },
      range_from,
      range_to
    );

    res.json({
      success: true,
      message: "Reliance data synced successfully",
      stats,
      dateRange: { from: range_from, to: range_to }
    });
  } catch (error: any) {
    console.error("❌ Reliance sync error:", error.message);
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ error: "Not authenticated", message: "Please login first at /auth/login" });
    }
    res.status(500).json({ error: error.message || "Failed to sync Reliance data" });
  }
});

app.get('/getRelianceData', async (req, res) => {
  try {
    const { start_date, end_date, limit, order } = req.query;
    let where: any = {};

    if (start_date) {
      const startDate = new Date(start_date as string);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({ error: "Invalid start_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, gte: startDate };
    }

    if (end_date) {
      const endDate = new Date(end_date as string);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({ error: "Invalid end_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, lte: endDate };
    }

    const limitNum = limit ? parseInt(limit as string) : 100;
    if (limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({ error: "Invalid limit", message: "Limit must be between 1 and 10000" });
    }

    const data = await prisma.rILSpot1Min.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { timestamp: order === 'desc' ? 'desc' : 'asc' },
      take: limitNum
    });

    const formattedData = data.map(candle => ({
      timestamp: candle.timestamp.toISOString(),
      timestamp_ist: candle.timestamp.toString(),
      open: parseFloat(candle.open.toString()),
      high: parseFloat(candle.high.toString()),
      low: parseFloat(candle.low.toString()),
      close: parseFloat(candle.close.toString()),
      volume: candle.volume !== null ? Number(candle.volume) : null
    }));

    res.json({
      success: true,
      count: formattedData.length,
      query: { start_date: start_date || null, end_date: end_date || null, limit: limitNum },
      data: formattedData
    });
  } catch (error: any) {
    console.error("❌ Get Reliance data error:", error.message);
    res.status(500).json({ error: error.message || "Failed to fetch Reliance data" });
  }
});

// ICICI Bank
app.post('/syncICICIData', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format"
      });
    }

    const stats = await syncStockData(
      { symbol: "NSE:ICICIBANK-EQ", model: prisma.iCICISpot1Min, name: "ICICI Bank" },
      range_from,
      range_to
    );

    res.json({
      success: true,
      message: "ICICI Bank data synced successfully",
      stats,
      dateRange: { from: range_from, to: range_to }
    });
  } catch (error: any) {
    console.error("❌ ICICI sync error:", error.message);
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ error: "Not authenticated", message: "Please login first at /auth/login" });
    }
    res.status(500).json({ error: error.message || "Failed to sync ICICI data" });
  }
});

app.get('/getICICIData', async (req, res) => {
  try {
    const { start_date, end_date, limit, order } = req.query;
    let where: any = {};

    if (start_date) {
      const startDate = new Date(start_date as string);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({ error: "Invalid start_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, gte: startDate };
    }

    if (end_date) {
      const endDate = new Date(end_date as string);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({ error: "Invalid end_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, lte: endDate };
    }

    const limitNum = limit ? parseInt(limit as string) : 100;
    if (limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({ error: "Invalid limit", message: "Limit must be between 1 and 10000" });
    }

    const data = await prisma.iCICISpot1Min.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { timestamp: order === 'desc' ? 'desc' : 'asc' },
      take: limitNum
    });

    const formattedData = data.map(candle => ({
      timestamp: candle.timestamp.toISOString(),
      timestamp_ist: candle.timestamp.toString(),
      open: parseFloat(candle.open.toString()),
      high: parseFloat(candle.high.toString()),
      low: parseFloat(candle.low.toString()),
      close: parseFloat(candle.close.toString()),
      volume: candle.volume !== null ? Number(candle.volume) : null
    }));

    res.json({
      success: true,
      count: formattedData.length,
      query: { start_date: start_date || null, end_date: end_date || null, limit: limitNum },
      data: formattedData
    });
  } catch (error: any) {
    console.error("❌ Get ICICI data error:", error.message);
    res.status(500).json({ error: error.message || "Failed to fetch ICICI data" });
  }
});

// Infosys
app.post('/syncInfosysData', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format"
      });
    }

    const stats = await syncStockData(
      { symbol: "NSE:INFY-EQ", model: prisma.iNFYSpot1Min, name: "Infosys" },
      range_from,
      range_to
    );

    res.json({
      success: true,
      message: "Infosys data synced successfully",
      stats,
      dateRange: { from: range_from, to: range_to }
    });
  } catch (error: any) {
    console.error("❌ Infosys sync error:", error.message);
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ error: "Not authenticated", message: "Please login first at /auth/login" });
    }
    res.status(500).json({ error: error.message || "Failed to sync Infosys data" });
  }
});

app.get('/getInfosysData', async (req, res) => {
  try {
    const { start_date, end_date, limit, order } = req.query;
    let where: any = {};

    if (start_date) {
      const startDate = new Date(start_date as string);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({ error: "Invalid start_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, gte: startDate };
    }

    if (end_date) {
      const endDate = new Date(end_date as string);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({ error: "Invalid end_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, lte: endDate };
    }

    const limitNum = limit ? parseInt(limit as string) : 100;
    if (limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({ error: "Invalid limit", message: "Limit must be between 1 and 10000" });
    }

    const data = await prisma.iNFYSpot1Min.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { timestamp: order === 'desc' ? 'desc' : 'asc' },
      take: limitNum
    });

    const formattedData = data.map(candle => ({
      timestamp: candle.timestamp.toISOString(),
      timestamp_ist: candle.timestamp.toString(),
      open: parseFloat(candle.open.toString()),
      high: parseFloat(candle.high.toString()),
      low: parseFloat(candle.low.toString()),
      close: parseFloat(candle.close.toString()),
      volume: candle.volume !== null ? Number(candle.volume) : null
    }));

    res.json({
      success: true,
      count: formattedData.length,
      query: { start_date: start_date || null, end_date: end_date || null, limit: limitNum },
      data: formattedData
    });
  } catch (error: any) {
    console.error("❌ Get Infosys data error:", error.message);
    res.status(500).json({ error: error.message || "Failed to fetch Infosys data" });
  }
});

// TCS
app.post('/syncTCSData', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format"
      });
    }

    const stats = await syncStockData(
      { symbol: "NSE:TCS-EQ", model: prisma.tCSpot1Min, name: "TCS" },
      range_from,
      range_to
    );

    res.json({
      success: true,
      message: "TCS data synced successfully",
      stats,
      dateRange: { from: range_from, to: range_to }
    });
  } catch (error: any) {
    console.error("❌ TCS sync error:", error.message);
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ error: "Not authenticated", message: "Please login first at /auth/login" });
    }
    res.status(500).json({ error: error.message || "Failed to sync TCS data" });
  }
});

app.get('/getTCSData', async (req, res) => {
  try {
    const { start_date, end_date, limit, order } = req.query;
    let where: any = {};

    if (start_date) {
      const startDate = new Date(start_date as string);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({ error: "Invalid start_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, gte: startDate };
    }

    if (end_date) {
      const endDate = new Date(end_date as string);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({ error: "Invalid end_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, lte: endDate };
    }

    const limitNum = limit ? parseInt(limit as string) : 100;
    if (limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({ error: "Invalid limit", message: "Limit must be between 1 and 10000" });
    }

    const data = await prisma.tCSpot1Min.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { timestamp: order === 'desc' ? 'desc' : 'asc' },
      take: limitNum
    });

    const formattedData = data.map(candle => ({
      timestamp: candle.timestamp.toISOString(),
      timestamp_ist: candle.timestamp.toString(),
      open: parseFloat(candle.open.toString()),
      high: parseFloat(candle.high.toString()),
      low: parseFloat(candle.low.toString()),
      close: parseFloat(candle.close.toString()),
      volume: candle.volume !== null ? Number(candle.volume) : null
    }));

    res.json({
      success: true,
      count: formattedData.length,
      query: { start_date: start_date || null, end_date: end_date || null, limit: limitNum },
      data: formattedData
    });
  } catch (error: any) {
    console.error("❌ Get TCS data error:", error.message);
    res.status(500).json({ error: error.message || "Failed to fetch TCS data" });
  }
});

// Bharti Airtel
app.post('/syncBhartiAirtelData', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format"
      });
    }

    const stats = await syncStockData(
      { symbol: "NSE:BHARTIARTL-EQ", model: prisma.bHARTIARTSpot1Min, name: "Bharti Airtel" },
      range_from,
      range_to
    );

    res.json({
      success: true,
      message: "Bharti Airtel data synced successfully",
      stats,
      dateRange: { from: range_from, to: range_to }
    });
  } catch (error: any) {
    console.error("❌ Bharti Airtel sync error:", error.message);
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ error: "Not authenticated", message: "Please login first at /auth/login" });
    }
    res.status(500).json({ error: error.message || "Failed to sync Bharti Airtel data" });
  }
});

app.get('/getBhartiAirtelData', async (req, res) => {
  try {
    const { start_date, end_date, limit, order } = req.query;
    let where: any = {};

    if (start_date) {
      const startDate = new Date(start_date as string);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({ error: "Invalid start_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, gte: startDate };
    }

    if (end_date) {
      const endDate = new Date(end_date as string);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({ error: "Invalid end_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, lte: endDate };
    }

    const limitNum = limit ? parseInt(limit as string) : 100;
    if (limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({ error: "Invalid limit", message: "Limit must be between 1 and 10000" });
    }

    const data = await prisma.bHARTIARTSpot1Min.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { timestamp: order === 'desc' ? 'desc' : 'asc' },
      take: limitNum
    });

    const formattedData = data.map(candle => ({
      timestamp: candle.timestamp.toISOString(),
      timestamp_ist: candle.timestamp.toString(),
      open: parseFloat(candle.open.toString()),
      high: parseFloat(candle.high.toString()),
      low: parseFloat(candle.low.toString()),
      close: parseFloat(candle.close.toString()),
      volume: candle.volume !== null ? Number(candle.volume) : null
    }));

    res.json({
      success: true,
      count: formattedData.length,
      query: { start_date: start_date || null, end_date: end_date || null, limit: limitNum },
      data: formattedData
    });
  } catch (error: any) {
    console.error("❌ Get Bharti Airtel data error:", error.message);
    res.status(500).json({ error: error.message || "Failed to fetch Bharti Airtel data" });
  }
});

// L&T
app.post('/syncLTData', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format"
      });
    }

    const stats = await syncStockData(
      { symbol: "NSE:LT-EQ", model: prisma.lTSpot1Min, name: "L&T" },
      range_from,
      range_to
    );

    res.json({
      success: true,
      message: "L&T data synced successfully",
      stats,
      dateRange: { from: range_from, to: range_to }
    });
  } catch (error: any) {
    console.error("❌ L&T sync error:", error.message);
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ error: "Not authenticated", message: "Please login first at /auth/login" });
    }
    res.status(500).json({ error: error.message || "Failed to sync L&T data" });
  }
});

app.get('/getLTData', async (req, res) => {
  try {
    const { start_date, end_date, limit, order } = req.query;
    let where: any = {};

    if (start_date) {
      const startDate = new Date(start_date as string);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({ error: "Invalid start_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, gte: startDate };
    }

    if (end_date) {
      const endDate = new Date(end_date as string);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({ error: "Invalid end_date format", message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" });
      }
      where.timestamp = { ...where.timestamp, lte: endDate };
    }

    const limitNum = limit ? parseInt(limit as string) : 100;
    if (limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({ error: "Invalid limit", message: "Limit must be between 1 and 10000" });
    }

    const data = await prisma.lTSpot1Min.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { timestamp: order === 'desc' ? 'desc' : 'asc' },
      take: limitNum
    });

    const formattedData = data.map(candle => ({
      timestamp: candle.timestamp.toISOString(),
      timestamp_ist: candle.timestamp.toString(),
      open: parseFloat(candle.open.toString()),
      high: parseFloat(candle.high.toString()),
      low: parseFloat(candle.low.toString()),
      close: parseFloat(candle.close.toString()),
      volume: candle.volume !== null ? Number(candle.volume) : null
    }));

    res.json({
      success: true,
      count: formattedData.length,
      query: { start_date: start_date || null, end_date: end_date || null, limit: limitNum },
      data: formattedData
    });
  } catch (error: any) {
    console.error("❌ Get L&T data error:", error.message);
    res.status(500).json({ error: error.message || "Failed to fetch L&T data" });
  }
});

// =============================
// BULK SYNC ENDPOINT
// =============================

app.post('/syncAllStocks', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "Required: range_from (DD/MM/YYYY), range_to (DD/MM/YYYY)",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format"
      });
    }

    console.log(`🚀 Starting bulk sync for all stocks from ${range_from} to ${range_to}...`);

    const stockConfigs: StockConfig[] = [
      { symbol: "NSE:NIFTY50-INDEX", model: prisma.niftySpot1Min, name: "NIFTY50" },
      { symbol: "NSE:HDFCBANK-EQ", model: prisma.hDFCSpot1Min, name: "HDFC Bank" },
      { symbol: "NSE:RELIANCE-EQ", model: prisma.rILSpot1Min, name: "Reliance" },
      { symbol: "NSE:ICICIBANK-EQ", model: prisma.iCICISpot1Min, name: "ICICI Bank" },
      { symbol: "NSE:INFY-EQ", model: prisma.iNFYSpot1Min, name: "Infosys" },
      { symbol: "NSE:TCS-EQ", model: prisma.tCSpot1Min, name: "TCS" },
      { symbol: "NSE:BHARTIARTL-EQ", model: prisma.bHARTIARTSpot1Min, name: "Bharti Airtel" },
      { symbol: "NSE:LT-EQ", model: prisma.lTSpot1Min, name: "L&T" }
    ];

    const results: any = {};
    let totalErrors = 0;

    for (const config of stockConfigs) {
      try {
        const stats = await syncStockData(config, range_from, range_to);
        results[config.name] = { success: true, stats };
        console.log(`✅ ${config.name} synced successfully`);
      } catch (error: any) {
        results[config.name] = { success: false, error: error.message };
        totalErrors++;
        console.error(`❌ ${config.name} sync failed:`, error.message);
      }
    }

    // Sync India VIX
    try {
      const vixStats = await syncIndiaVixData(range_from, range_to);
      results["India VIX"] = { success: true, stats: vixStats };
      console.log(`✅ India VIX synced successfully`);
    } catch (error: any) {
      results["India VIX"] = { success: false, error: error.message };
      totalErrors++;
      console.error(`❌ India VIX sync failed:`, error.message);
    }

    const summary = {
      success: totalErrors === 0,
      message: totalErrors === 0 
        ? "All stocks synced successfully" 
        : `Completed with ${totalErrors} error(s)`,
      dateRange: { from: range_from, to: range_to },
      results
    };

    res.json(summary);
  } catch (error: any) {
    console.error("❌ Bulk sync error:", error.message);
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ error: "Not authenticated", message: "Please login first at /auth/login" });
    }
    res.status(500).json({ error: error.message || "Failed to sync stocks" });
  }
});


// =============================
// INDIA VIX ENDPOINTS
// =============================

app.post('/syncIndiaVix', async (req, res) => {
  try {
    const { range_from, range_to } = req.body;

    if (!range_from || !range_to) {
      return res.status(400).json({
        error: "Missing required parameters",
        message: "range_from and range_to are required in DD/MM/YYYY format",
        example: { range_from: "01/01/2024", range_to: "02/01/2024" }
      });
    }

    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(range_from) || !dateRegex.test(range_to)) {
      return res.status(400).json({
        error: "Invalid date format",
        message: "Dates must be in DD/MM/YYYY format"
      });
    }

    const stats = await syncIndiaVixData(range_from, range_to);

    res.json({
      success: true,
      message: "India VIX data synced successfully",
      stats,
      dateRange: { from: range_from, to: range_to }
    });
  } catch (error: any) {
    console.error("❌ India VIX sync error:", error.message);
    if (error.message === "Fyers token missing") {
      return res.status(401).json({ error: "Not authenticated", message: "Please login first at /auth/login" });
    }
    res.status(500).json({ error: error.message || "Failed to sync India VIX data" });
  }
});

app.get('/getIndiaVixData', async (req, res) => {
  try {
    const { start_date, end_date, limit } = req.query;

    let where: any = {};

    if (start_date) {
      const startDate = new Date(start_date as string);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({
          error: "Invalid start_date format",
          message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss"
        });
      }
      where.timestamp = { ...where.timestamp, gte: startDate };
    }

    if (end_date) {
      const endDate = new Date(end_date as string);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({
          error: "Invalid end_date format",
          message: "Use ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss"
        });
      }
      where.timestamp = { ...where.timestamp, lte: endDate };
    }

    const limitNum = limit ? parseInt(limit as string) : 100;
    
    if (limitNum < 1 || limitNum > 10000) {
      return res.status(400).json({
        error: "Invalid limit",
        message: "Limit must be between 1 and 10000"
      });
    }

    const data = await prisma.indiaVix1Min.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { timestamp: 'desc' },
      take: limitNum
    });

    // Convert to IST and format
    const formattedData = data.map(row => ({
      timestamp: row.timestamp.toISOString().replace('Z', '+05:30'),
      timestamp_ist: row.timestamp.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      vix: row.close ? parseFloat(row.close.toString()) : null
    }));

    res.json({
      success: true,
      count: formattedData.length,
      query: {
        start_date: start_date || null,
        end_date: end_date || null,
        limit: limitNum
      },
      data: formattedData
    });

  } catch (error: any) {
    console.error("❌ Get India VIX error:", error.message);
    res.status(500).json({ 
      error: error.message || "Failed to fetch India VIX data"
    });
  }
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║            🚀 FYERS API SERVER RUNNING                           ║
╠═══════════════════════════════════════════════════════════════════╣
║  AUTHENTICATION & INFO                                            ║
║    GET  http://localhost:${PORT}/                                      ║
║    GET  http://localhost:${PORT}/status                                ║
║    GET  http://localhost:${PORT}/getProfile                            ║
║    GET  http://localhost:${PORT}/getFunds                              ║
║    GET  http://localhost:${PORT}/getHistoricalData                     ║
║                                                                   ║
║  STOCK DATA ENDPOINTS (1-minute candles)                          ║
║  ────────────────────────────────────────────────────────────     ║
║  📊 NIFTY50:                                                      ║
║    POST http://localhost:${PORT}/syncNifty50Data                       ║
║    GET  http://localhost:${PORT}/getNifty50Data                        ║
║                                                                   ║
║  🏦 HDFC Bank:                                                    ║
║    POST http://localhost:${PORT}/syncHDFCData                          ║
║    GET  http://localhost:${PORT}/getHDFCData                           ║
║                                                                   ║
║  ⛽ Reliance:                                                     ║
║    POST http://localhost:${PORT}/syncRelianceData                      ║
║    GET  http://localhost:${PORT}/getRelianceData                       ║
║                                                                   ║
║  🏦 ICICI Bank:                                                   ║
║    POST http://localhost:${PORT}/syncICICIData                         ║
║    GET  http://localhost:${PORT}/getICICIData                          ║
║                                                                   ║
║  💻 Infosys:                                                      ║
║    POST http://localhost:${PORT}/syncInfosysData                       ║
║    GET  http://localhost:${PORT}/getInfosysData                        ║
║                                                                   ║
║  💼 TCS:                                                          ║
║    POST http://localhost:${PORT}/syncTCSData                           ║
║    GET  http://localhost:${PORT}/getTCSData                            ║
║                                                                   ║
║  📱 Bharti Airtel:                                                ║
║    POST http://localhost:${PORT}/syncBhartiAirtelData                  ║
║    GET  http://localhost:${PORT}/getBhartiAirtelData                   ║
║                                                                   ║
║  🏗️  L&T:                                                         ║
║    POST http://localhost:${PORT}/syncLTData                            ║
║    GET  http://localhost:${PORT}/getLTData                             ║
║                                                                   ║
║  📈 India VIX:                                                    ║
║    POST http://localhost:${PORT}/syncIndiaVix                          ║
║    GET  http://localhost:${PORT}/getIndiaVixData                       ║
║                                                                   ║
║  🔄 BULK SYNC ALL STOCKS:                                         ║
║    POST http://localhost:${PORT}/syncAllStocks                         ║
║         Body: { range_from: "DD/MM/YYYY", range_to: "DD/MM/YYYY" }    ║
║                                                                   ║
║  Query Parameters for GET endpoints:                              ║
║    ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&limit=100&order=asc     ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
});