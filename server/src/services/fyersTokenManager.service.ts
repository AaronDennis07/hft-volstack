import axios from "axios";
import crypto from "crypto";
import { fyersTokenStore } from "../storage/fyersTokenStore";
import { FyersToken } from "../types/fyersToken.types";

class FyersTokenManager {
  private refreshPromise: Promise<string> | null = null;

  async getValidAccessToken(): Promise<string> {
    const token = await fyersTokenStore.get();
    if (!token) throw new Error("Fyers token missing");

    if (token.expiresAt > Date.now() + 60_000) {
      return token.accessToken;
    }

    return this.refreshAccessToken();
  }

  async refreshAccessToken(): Promise<string> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh();
    }

    const newToken = await this.refreshPromise;
    this.refreshPromise = null;

    return newToken;
  }

  private async performRefresh(): Promise<string> {
    const token = await fyersTokenStore.get();
    if (!token) throw new Error("Fyers refresh token missing");

    console.log("🔄 Attempting to refresh access token...");

    // Generate SHA-256 hash of app_id:secret (required by Fyers)
    const appIdHash = crypto
      .createHash("sha256")
      .update(`${process.env.FYERS_CLIENT_ID}:${process.env.FYERS_SECRET}`)
      .digest("hex");

    try {
      const response = await axios.post(
        "https://api-t1.fyers.in/api/v3/validate-refresh-token",
        {
          grant_type: "refresh_token",
          appIdHash: appIdHash,
          refresh_token: token.refreshToken,
          pin: process.env.FYERS_PIN
        }
      );

      console.log("✅ Token refreshed successfully");

      const updated: FyersToken = {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token ?? token.refreshToken,
        expiresAt: Date.now() + (response.data.expires_in || 86400) * 1000
      };

      await fyersTokenStore.save(updated);

      return updated.accessToken;
    } catch (error: any) {
      console.error("❌ Refresh token request failed");
      console.error("Status:", error.response?.status);
      console.error("Response:", JSON.stringify(error.response?.data, null, 2));
      console.error("Request payload:", {
        grant_type: "refresh_token",
        appIdHash: appIdHash.substring(0, 20) + "...",
        refresh_token: token.refreshToken.substring(0, 30) + "...",
        pin: process.env.FYERS_PIN ? "****" : "MISSING"
      });
      throw error;
    }
  }
}

export const fyersTokenManager = new FyersTokenManager();
