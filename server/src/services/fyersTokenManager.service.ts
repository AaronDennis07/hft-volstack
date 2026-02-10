import axios from "axios";
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

    const response = await axios.post(
      "https://api-t1.fyers.in/api/v3/validate-refresh-token",
      {
        grant_type: "refresh_token",
        refresh_token: token.refreshToken
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
  }
}

export const fyersTokenManager = new FyersTokenManager();
