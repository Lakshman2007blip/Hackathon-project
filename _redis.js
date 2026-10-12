// Tiny helper that talks to your Upstash Redis database over HTTPS.
// No npm packages needed. Vercel adds these variables for you when you connect the database.
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command) {
  if (!DB_URL || !DB_TOKEN) throw new Error("Database is not connected to this project");
  const r = await fetch(DB_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + DB_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || "Database error");
  return j.result;
}

module.exports = { redis };
