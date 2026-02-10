import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOKEN_FILE = path.join(__dirname, '..', 'tokens.json');
const MS_IN_DAY = 24 * 60 * 60 * 1000;

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in_days: number;
}

export interface TokenInput {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export const readTokens = (): Tokens | null => {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
};

export const writeTokens = ({ access_token, refresh_token, expires_in }: TokenInput): void => {
  const expiresAt = Date.now() + expires_in * MS_IN_DAY;

  const data: Tokens = {
    access_token,
    refresh_token,
    expires_at: expiresAt,
    expires_in_days: expires_in
  };

  const tmp = TOKEN_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, TOKEN_FILE);
};

export const isAccessTokenExpired = (bufferMinutes: number = 5): boolean => {
  const tokens = readTokens();
  if (!tokens) return true;

  const bufferMs = bufferMinutes * 60 * 1000;
  return Date.now() + bufferMs >= tokens.expires_at;
};
