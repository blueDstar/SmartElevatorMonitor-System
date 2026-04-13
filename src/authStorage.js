export const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:5000';
export const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || API_BASE;

const TOKEN_KEY = 'smartelevator_token';
const USER_KEY = 'smartelevator_user';

export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getAuthHeaders(includeJson = true) {
  const headers = {};
  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getStoredToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function withAccessToken(url) {
  const token = getStoredToken();
  if (!token) return url;
  const join = url.includes('?') ? '&' : '?';
  return `${url}${join}access_token=${encodeURIComponent(token)}`;
}

export function saveSession(user, token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // ignore
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

export function loadStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
