// filepath: volstack/client/src/services/api.ts
import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(
  (config) => {
    const tokens = localStorage.getItem('volstack_tokens');
    if (tokens) {
      const { access_token } = JSON.parse(tokens);
      config.headers.Authorization = `Bearer ${access_token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      localStorage.removeItem('volstack_tokens');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authService = {
  getTokens: async () => {
    const { data } = await api.get('/tokens');
    return data;
  },
  initiateLogin: () => {
    window.location.href = `${API_BASE_URL}/login`;
  },
  getProfile: async () => {
    const { data } = await api.get('/profile');
    return data;
  },
  logout: () => {
    localStorage.removeItem('volstack_tokens');
  },
};

export const tradingService = {
  getHistory: async (params: { symbol?: string; range_from?: string; range_to?: string; }) => {
    const { data } = await api.get('/history', { params });
    return data;
  },
  startStrategy: async () => {
    const { data } = await api.post('/strategy/start');
    return data;
  },
  stopStrategy: async () => {
    const { data } = await api.post('/strategy/stop');
    return data;
  },
  getStrategyStatus: async () => {
    const { data } = await api.get('/strategy/status');
    return data;
  },
  getCandles: async (params: { symbol?: string; limit?: number; offset?: number; }) => {
    const { data } = await api.get('/candles', { params });
    return data;
  },
  exportCandles: async (params: { symbol?: string; days?: number; }) => {
    const { data } = await api.get('/candles/export', { params });
    return data;
  },
  resetStrategy: async () => {
    const { data } = await api.post('/strategy/reset');
    return data;
  },
};