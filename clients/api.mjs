import { readFileSync } from "node:fs";
export function credentials(env = process.env) {
  let file = {};
  if (env.TEAM_AGENT_CREDENTIALS_FILE)
    file = JSON.parse(readFileSync(env.TEAM_AGENT_CREDENTIALS_FILE, "utf8"));
  const url = String(
    env.TEAM_AGENT_URL ||
      file.url ||
      "https://inkboard-team.inkboard-server.workers.dev",
  ).replace(/\/$/, "");
  const token = env.TEAM_AGENT_TOKEN || file.token;
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    )
  )
    throw Error("TEAM_AGENT_URL must use HTTPS");
  if (!token)
    throw Error(
      "请在工作台生成本机AI接入凭证，并设置 TEAM_AGENT_TOKEN 或 TEAM_AGENT_CREDENTIALS_FILE",
    );
  return { url, token };
}
export async function request(path, body, method) {
  const { url, token } = credentials();
  const response = await fetch(url + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(result.error || "TeamAgent HTTP " + response.status);
  return result;
}
