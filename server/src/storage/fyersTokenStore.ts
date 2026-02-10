import { FyersToken } from "../types/fyersToken.types";
import * as fs from "fs/promises";
import * as path from "path";

const TOKEN_FILE_PATH = path.join(process.cwd(), ".fyers-token.json");

export const fyersTokenStore = {
  async save(t: FyersToken) {
    try {
      await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(t, null, 2), "utf-8");
      console.log("💾 Token saved to file:", {
        hasAccessToken: !!t.accessToken,
        hasRefreshToken: !!t.refreshToken,
        expiresAt: new Date(t.expiresAt).toISOString()
      });
    } catch (error) {
      console.error("❌ Failed to save token:", error);
      throw error;
    }
  },

  async get(): Promise<FyersToken | null> {
    try {
      const data = await fs.readFile(TOKEN_FILE_PATH, "utf-8");
      const token = JSON.parse(data) as FyersToken;
      console.log("📖 Token retrieved from file:", token ? "Token exists" : "No token");
      return token;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        console.log("📖 No token file found");
        return null;
      }
      console.error("❌ Failed to read token:", error);
      return null;
    }
  },

  async clear() {
    try {
      await fs.unlink(TOKEN_FILE_PATH);
      console.log("🗑️ Token file deleted");
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        console.error("❌ Failed to delete token:", error);
      }
    }
  }
};
