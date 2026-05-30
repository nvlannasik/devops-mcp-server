import { type AxiosInstance } from "axios";
import { createHttpClient } from "../../utils/http/index.js";
import config from "../../config/index.js";

let _client: AxiosInstance | null = null;

export function getClient(): AxiosInstance {
  if (!_client) {
    const { url, username, password } = config.loki;
    _client = createHttpClient(url, username ? { username, password } : undefined);
  }
  return _client;
}
