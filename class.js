// GET /api/class - the teacher dashboard reads class results from here.
const { redis } = require("./_redis");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET" });

  // Optional: set TEACHER_PIN in Vercel and only people who know it can read the class data.
  const pin = process.env.TEACHER_PIN;
  if (pin && req.headers["x-teacher-pin"] !== pin) {
    return res.status(401).json({ error: "Teacher PIN required" });
  }

  try {
    const rows = (await redis(["HVALS", "ss:attempts"])) || [];
    const byStudent = {};
    for (const raw of rows) {
      let a; try { a = JSON.parse(raw); } catch { continue; }
      const s = byStudent[a.sid] || (byStudent[a.sid] = { id: a.sid, name: a.name || "Student", topics: {} });
      if (a.name) s.name = a.name;
      const t = s.topics[a.topic] || (s.topics[a.topic] = { c: 0, n: 0 });
      t.n++; if (a.ok) t.c++;
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ students: Object.values(byStudent) });
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ error: "Could not read data" });
  }
};
