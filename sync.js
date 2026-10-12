// POST /api/sync  - the student app sends new answers here when it is online.
const { redis } = require("./_redis");

const TOPICS = ["int", "fra", "equ", "are", "rat"];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const list = Array.isArray(req.body) ? req.body : null;
  if (!list || list.length === 0 || list.length > 500) {
    return res.status(400).json({ error: "Send between 1 and 500 records" });
  }

  // Check every record so bad or oversized data never reaches the database.
  const command = ["HSET", "ss:attempts"];
  let saved = 0;
  for (const a of list) {
    const valid =
      a && typeof a.sid === "string" && a.sid.length <= 40 &&
      typeof a.qid === "string" && a.qid.length <= 10 &&
      TOPICS.includes(a.topic) && typeof a.ok === "boolean" && Number.isFinite(a.ts);
    if (!valid) continue;
    const name = String(a.name || "").slice(0, 20);
    // The key makes each answer unique, so sending the same answer twice never double counts.
    command.push(a.sid + "|" + a.qid + "|" + a.ts,
                 JSON.stringify({ sid: a.sid, name, qid: a.qid, topic: a.topic, ok: a.ok, ts: a.ts }));
    saved++;
  }
  if (!saved) return res.status(400).json({ error: "No valid records" });

  try {
    await redis(command);
    return res.status(200).json({ ok: true, saved });
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ error: "Could not save" });
  }
};
