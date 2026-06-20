import axios, { type AxiosInstance } from "axios";

interface AuthOptions {
  username: string;
  password?: string;
}

export function createHttpClient(baseURL: string, auth?: AuthOptions, timeoutMs?: number): AxiosInstance {
  // default timeout so an unresponsive Prometheus/Loki fails fast instead of hanging the request
  const opts: Record<string, unknown> = { baseURL, timeout: timeoutMs ?? 30000 };
  if (auth?.username) opts.auth = { username: auth.username, password: auth.password };
  return axios.create(opts);
}
