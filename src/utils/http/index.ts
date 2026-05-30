import axios, { type AxiosInstance } from "axios";

interface AuthOptions {
  username: string;
  password?: string;
}

export function createHttpClient(baseURL: string, auth?: AuthOptions): AxiosInstance {
  const opts: Record<string, unknown> = { baseURL };
  if (auth?.username) opts.auth = { username: auth.username, password: auth.password };
  return axios.create(opts);
}
