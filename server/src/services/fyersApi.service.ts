import { fyersHttpClient } from "./fyersHttpClient";

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

    // Use fyersHttpClient to benefit from automatic token refresh interceptor
    // Pass full URL - axios will ignore baseURL when a full URL is provided
    const response = await fyersHttpClient.get(
      `https://api-t1.fyers.in/data/history?${queryParams.toString()}`
    );
    return response.data;
  }

}

export const fyersApiService = new FyersApiService();
