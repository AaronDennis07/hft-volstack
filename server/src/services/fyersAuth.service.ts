import axios from "axios";
import crypto from "crypto";
import { fyersTokenStore } from "../storage/fyersTokenStore";

class FyersAuthService {
  async login(authCode: string) {
    console.log("Attempting to exchange auth_code for access token...");
    
    // Generate SHA-256 hash of app_id:secret
    const appIdHash = crypto
      .createHash("sha256")
      .update(`${process.env.FYERS_CLIENT_ID}:${process.env.FYERS_SECRET}`)
      .digest("hex");
    
    const payload = {
      grant_type: "authorization_code",
      appIdHash: appIdHash,
      code: authCode
    };
    
    console.log("Request payload:", { ...payload, appIdHash: appIdHash.substring(0, 20) + "..." });
    
    const response = await axios.post(
      "https://api-t1.fyers.in/api/v3/validate-authcode",
      payload
    );
    
    console.log("Token response:", {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token || "",
      expiresAt: Date.now() + (response.data.expires_in || 86400) * 1000
    });
    
    await fyersTokenStore.save({
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token || "",
      expiresAt: Date.now() + (response.data.expires_in || 86400) * 1000
    });

    return response.data;
  }

  async logout() {
    await fyersTokenStore.clear();
  }
}

export const fyersAuthService = new FyersAuthService();
