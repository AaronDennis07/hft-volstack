import axios from "axios";
import { fyersTokenManager } from "./fyersTokenManager.service";
import { fyersTokenStore } from "../storage/fyersTokenStore";

export const fyersHttpClient = axios.create({
  baseURL: "https://api-t1.fyers.in/api/v3"
});

/* Request interceptor */
fyersHttpClient.interceptors.request.use(async (config) => {
  const token = await fyersTokenManager.getValidAccessToken();

  config.headers = config.headers || {};
  config.headers.Authorization = `${process.env.FYERS_CLIENT_ID}:${token}`;

  console.log(`🌐 API Request: ${config.method?.toUpperCase()} ${config.url}`);
  console.log(`🔑 Auth Header: ${process.env.FYERS_CLIENT_ID}:${token.substring(0, 20)}...`);

  return config;
});

/* Response interceptor */
fyersHttpClient.interceptors.response.use(
  (response) => {
    console.log(`✅ API Response: ${response.status} ${response.config.url}`);
    return response;
  },
  async (error) => {
    if (!error.config) return Promise.reject(error);

    const originalRequest = error.config as any;
    const status = error.response?.status;

    console.log(`❌ API Error: ${status} ${originalRequest.url}`);

    if (status === 401 && !originalRequest._retry) {
      console.log("🔄 Attempting to refresh token and retry...");
      originalRequest._retry = true;

      try {
        const newToken = await fyersTokenManager.refreshAccessToken();

        originalRequest.headers.Authorization = `${process.env.FYERS_CLIENT_ID}:${newToken}`;

        console.log("🔁 Retrying request with new token...");
        return fyersHttpClient(originalRequest);
      } catch (refreshError: any) {
        console.error("❌ Token refresh failed:", refreshError.response?.status || refreshError.message);
        console.error("💡 If refresh keeps failing, you may need to re-authenticate at /auth/login");
        
        // Don't auto-clear tokens - let user decide when to re-authenticate
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);
