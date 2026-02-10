import { fyersHttpClient } from "./fyersHttpClient";
import axios from "axios";

class FyersApiService {
  async getProfile() {
    const response = await fyersHttpClient.get("/profile");
    return response.data;
  }

  async getFunds() {
    const response = await fyersHttpClient.get("/funds");
    return response.data;
  }

  async getHistoricalData(params: {
    symbol: string;
    resolution: string;
    range_from: string;
    range_to: string;
    cont_flag?: number;
    oi_flag?: number;
  }) {
    // Convert DD/MM/YYYY to YYYY-MM-DD
    const convertDate = (ddmmyyyy: string): string => {
      const [day, month, year] = ddmmyyyy.split('/');
      return `${year}-${month}-${day}`;
    };

    const queryParams = new URLSearchParams({
      symbol: params.symbol,
      resolution: params.resolution,
      date_format: '1', // Always use date format
      range_from: convertDate(params.range_from),
      range_to: convertDate(params.range_to)
    });


    // Historical data uses /data/history path (not /api/v3)
    // So we need to use a direct axios call with proper auth header
    const { fyersTokenManager } = await import("./fyersTokenManager.service");
    const token = await fyersTokenManager.getValidAccessToken();

    try {
      const response = await axios.get(
        `https://api-t1.fyers.in/data/history?${queryParams.toString()}`,
        {
          headers: {
            Authorization: `${process.env.FYERS_CLIENT_ID}:${token}`
          }
        }
      );
      return response.data;
    } catch (error: any) {
      if (error.response) {
        console.error("❌ Fyers API Error:", {
          status: error.response.status,
          data: error.response.data,
          params: params
        });
        throw new Error(`Fyers API returned ${error.response.status}: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

}

export const fyersApiService = new FyersApiService();
