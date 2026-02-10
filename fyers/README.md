# Fyers Trading Strategy - TypeScript + Prisma

This project is a trading strategy application that fetches and stores NIFTY50 index data using the Fyers API, TypeScript, Express, and Prisma ORM with PostgreSQL.

## Features

- **TypeScript** - Fully typed codebase for better developer experience
- **Prisma ORM** - Type-safe database access with auto-generated types
- **PostgreSQL** - Running in Docker container for data persistence
- **Real-time Strategy** - Automated data fetching every 40 seconds
- **Historical Data** - Batch fetching up to 500 days with 100-day chunks
- **CSV Export** - Export candles to CSV from database

## Prerequisites

- Node.js 18+ with npm
- Docker (for PostgreSQL)
- Fyers API credentials

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Start PostgreSQL Docker Container

```bash
docker run --name some-postgres -e POSTGRES_PASSWORD=mysecretpassword -p 5432:5432 -d postgres
```

### 3. Configure Environment

Create or update `.env` file:

```env
DATABASE_URL="postgresql://postgres:mysecretpassword@localhost:5432/trading?schema=public"
```

### 4. Setup Database

```bash
# Generate Prisma Client
npm run prisma:generate

# Push schema to database
npx prisma db push
```

## Development

```bash
# Run in development mode with hot reload
npm run dev
```

## Production

```bash
# Build TypeScript to JavaScript
npm run build

# Run compiled JavaScript
npm start
```

## Available Scripts

- `npm run dev` - Run development server with hot reload
- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Run production server
- `npm run prisma:generate` - Generate Prisma Client
- `npm run prisma:migrate` - Create and apply migrations
- `npm run prisma:studio` - Open Prisma Studio (database GUI)

## API Endpoints

### Authentication

- `GET /login` - Redirect to Fyers login
- `GET /redirect` - OAuth callback endpoint
- `GET /tokens` - Get stored tokens
- `GET /profile` - Get user profile from Fyers

### Historical Data

- `GET /history` - Fetch historical candles with custom parameters
- `GET /nifty50-1min` - Fetch NIFTY50 1-minute candles (default 500 days)

### Live Strategy

- `POST /strategy/start` - Start live data collection (every 40 seconds)
- `POST /strategy/stop` - Stop live data collection
- `GET /strategy/status` - Get strategy status and database stats
- `POST /strategy/reset` - Clear all strategy data

### Database Queries

- `GET /candles` - Query candles from database (with pagination)
  - Query params: `symbol`, `limit` (default 100), `offset` (default 0)
- `GET /candles/export` - Export candles to CSV
  - Query params: `symbol`, `days` (default 30)

## Database Schema

The `candles` table stores:

- `id` - Auto-incrementing primary key
- `symbol` - Trading symbol (e.g., NSE:NIFTY50-INDEX)
- `timestamp` - Unix timestamp
- `datetime` - Human-readable datetime
- `open`, `high`, `low`, `close` - Decimal prices
- `volume` - Trading volume
- `createdAt` - Record creation timestamp

Indexes are optimized for:
- Symbol + timestamp queries (descending)
- Datetime range queries (descending)

## TypeScript Structure

```
src/
├── index.ts    # Main application file
└── utils.ts    # Token management utilities

prisma/
├── schema.prisma    # Prisma schema definition
└── migrations/      # Database migrations

dist/            # Compiled JavaScript (generated)
```

## Example Usage

### Start Live Strategy

```bash
curl -X POST http://localhost:3000/strategy/start
```

### Query Last 100 Candles

```bash
curl http://localhost:3000/candles?limit=100
```

### Export Last 30 Days to CSV

```bash
curl http://localhost:3000/candles/export?days=30
```

### Fetch 200 Days of Historical Data

```bash
curl http://localhost:3000/nifty50-1min?days=200
```

## Prisma Studio

View and edit your database with Prisma Studio:

```bash
npm run prisma:studio
```

Opens at `http://localhost:5555`

## Notes

- Fyers API has a 100-day limit per request for historical data
- The app automatically batches requests for longer periods
- All data is stored in chronological order (oldest to newest)
- Duplicate timestamps are automatically handled
- Strategy resumes from last timestamp on restart

## License

ISC
