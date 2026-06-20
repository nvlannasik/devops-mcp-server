import { type AxiosInstance } from "axios";
import { createHttpClient } from "../../utils/http/index.js";
import config from "../../config/index.js";

let _client: AxiosInstance | null = null;

export function getClient(): AxiosInstance {
  if (!_client) {
    const { url, username, password } = config.prometheus;
    _client = createHttpClient(url, username ? { username, password } : undefined, config.upstreamTimeoutMs);
  }
  return _client;
}
