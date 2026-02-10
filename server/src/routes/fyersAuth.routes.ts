import { Router } from "express";
import { fyersAuthService } from "../services/fyersAuth.service";
import { fyersTokenStore } from "../storage/fyersTokenStore";

const router = Router();

router.get("/login", (req, res) => {
  const clientId = process.env.FYERS_CLIENT_ID;
  const redirectUri = process.env.FYERS_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      error: "Missing FYERS_CLIENT_ID or FYERS_REDIRECT_URI"
    });
  }

  const loginUrl =
    "https://api-t1.fyers.in/api/v3/generate-authcode" +
    `?client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    "&response_type=code" +
    "&state=fyers_login";

  console.log("Redirecting to:", loginUrl);
  res.redirect(loginUrl);
});

router.get("/callback", async (req, res) => {
  const authCode = req.query.auth_code as string;
  const s = req.query.s as string;
  const code = req.query.code as string;
  const state = req.query.state as string;

  console.log("Callback received:", { s, code, authCode: authCode?.substring(0, 20) + "...", state });

  if (!authCode) {
    return res.status(400).json({ 
      error: "No authorization code received",
      query: req.query 
    });
  }

  try {
    const result = await fyersAuthService.login(authCode);
    
    console.log("✅ Login successful!");
    
    // Verify token was saved
    const savedToken = await fyersTokenStore.get();
    console.log("Token verification:", savedToken ? "Token saved successfully" : "⚠️ Token NOT saved!");
    
    // Success - redirect to your frontend or send success response
    res.json({ 
      success: true, 
      message: "Login successful - you can now access /getProfile and /getFunds",
      tokenSaved: !!savedToken,
      redirectTo: "/getProfile"
    });
  } catch (error: any) {
    console.error("❌ Fyers login error:", error.response?.data || error.message);
    res.status(500).json({ 
      error: "Login failed",
      details: error.response?.data || error.message
    });
  }
});

router.post("/logout", async (req, res) => {
  try {
    await fyersAuthService.logout();
    res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ error: "Logout failed" });
  }
});

export default router;
