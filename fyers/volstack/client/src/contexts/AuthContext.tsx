import React, { createContext, useState, useEffect, ReactNode } from 'react';
import { authService } from '../services/api';
import type { AuthContextType, TokenData, User } from '../types';

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = async () => {
    try {
      const tokens: TokenData = await authService.getTokens();
      
      if (tokens && tokens.access_token && Date.now() < tokens.expires_at) {
        localStorage.setItem('volstack_tokens', JSON.stringify(tokens));
        const profile = await authService.getProfile();
        setUser(profile.data);
        setIsAuthenticated(true);
      } else {
        setIsAuthenticated(false);
        localStorage.removeItem('volstack_tokens');
      }
    } catch (error) {
      setIsAuthenticated(false);
      localStorage.removeItem('volstack_tokens');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  const login = () => {
    authService.initiateLogin();
  };

  const logout = () => {
    authService.logout();
    setIsAuthenticated(false);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};