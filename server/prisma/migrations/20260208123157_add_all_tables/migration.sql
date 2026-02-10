-- CreateTable
CREATE TABLE "Test" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Test_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nifty_spot_1min" (
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(10,2) NOT NULL,
    "high" DECIMAL(10,2) NOT NULL,
    "low" DECIMAL(10,2) NOT NULL,
    "close" DECIMAL(10,2) NOT NULL,
    "volume" BIGINT,

    CONSTRAINT "nifty_spot_1min_pkey" PRIMARY KEY ("timestamp")
);

-- CreateTable
CREATE TABLE "hdfc_spot_1min" (
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(10,2) NOT NULL,
    "high" DECIMAL(10,2) NOT NULL,
    "low" DECIMAL(10,2) NOT NULL,
    "close" DECIMAL(10,2) NOT NULL,
    "volume" BIGINT,

    CONSTRAINT "hdfc_spot_1min_pkey" PRIMARY KEY ("timestamp")
);

-- CreateTable
CREATE TABLE "ril_spot_1min" (
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(10,2) NOT NULL,
    "high" DECIMAL(10,2) NOT NULL,
    "low" DECIMAL(10,2) NOT NULL,
    "close" DECIMAL(10,2) NOT NULL,
    "volume" BIGINT,

    CONSTRAINT "ril_spot_1min_pkey" PRIMARY KEY ("timestamp")
);

-- CreateTable
CREATE TABLE "icici_spot_1min" (
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(10,2) NOT NULL,
    "high" DECIMAL(10,2) NOT NULL,
    "low" DECIMAL(10,2) NOT NULL,
    "close" DECIMAL(10,2) NOT NULL,
    "volume" BIGINT,

    CONSTRAINT "icici_spot_1min_pkey" PRIMARY KEY ("timestamp")
);

-- CreateTable
CREATE TABLE "infy_spot_1min" (
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(10,2) NOT NULL,
    "high" DECIMAL(10,2) NOT NULL,
    "low" DECIMAL(10,2) NOT NULL,
    "close" DECIMAL(10,2) NOT NULL,
    "volume" BIGINT,

    CONSTRAINT "infy_spot_1min_pkey" PRIMARY KEY ("timestamp")
);

-- CreateTable
CREATE TABLE "tcs_spot_1min" (
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(10,2) NOT NULL,
    "high" DECIMAL(10,2) NOT NULL,
    "low" DECIMAL(10,2) NOT NULL,
    "close" DECIMAL(10,2) NOT NULL,
    "volume" BIGINT,

    CONSTRAINT "tcs_spot_1min_pkey" PRIMARY KEY ("timestamp")
);

-- CreateTable
CREATE TABLE "bhartiart_spot_1min" (
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(10,2) NOT NULL,
    "high" DECIMAL(10,2) NOT NULL,
    "low" DECIMAL(10,2) NOT NULL,
    "close" DECIMAL(10,2) NOT NULL,
    "volume" BIGINT,

    CONSTRAINT "bhartiart_spot_1min_pkey" PRIMARY KEY ("timestamp")
);

-- CreateTable
CREATE TABLE "lt_spot_1min" (
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(10,2) NOT NULL,
    "high" DECIMAL(10,2) NOT NULL,
    "low" DECIMAL(10,2) NOT NULL,
    "close" DECIMAL(10,2) NOT NULL,
    "volume" BIGINT,

    CONSTRAINT "lt_spot_1min_pkey" PRIMARY KEY ("timestamp")
);

-- CreateTable
CREATE TABLE "india_vix_1min" (
    "timestamp" TIMESTAMP(3) NOT NULL,
    "close" DECIMAL(10,2),

    CONSTRAINT "india_vix_1min_pkey" PRIMARY KEY ("timestamp")
);
