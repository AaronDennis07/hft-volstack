// filepath: volstack/client/src/types/index.ts
export type TokenData = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

export type User = {
  id: string;
  name: string;
  email: string;
};

export type AuthContextType = {
  isAuthenticated: boolean;
  user: User | null;
  login: () => void;
  logout: () => void;
  loading: boolean;
};