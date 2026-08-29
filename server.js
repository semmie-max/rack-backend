const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("./db");
require("dotenv").config();

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not set. Refusing to start with an insecure default.");
}

// --- SendByte email helper ---
async function sendEmail(to, subject, html) {
  try {
    const res = await fetch("https://api.sendbyte.africa/v1/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SENDBYTE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.SENDBYTE_FROM || "Rack <notifications@rack.io>",
        to,
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("SendByte error:", err);
    }
  } catch (err) {
    console.error("Failed to send email:", err);
  }
}

const app = express();
app.use(cors());
app.use(express.json());const app = express();
app.use(cors());
app.use(express.json());

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Root test route
app.get("/", (req, res) => {
  res.send("Rack backend API is running!");
});

// Signup route
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users (email, password) VALUES (?, ?)",
      [email, hashedPassword]
    );

    const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({ message: "Account created.", token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Login route
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = jwt.sign({ email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.json({ message: "Login successful.", token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// --- Auth Middleware: protects routes that need a logged-in user ---
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { email }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

// --- List all racks belonging to the logged-in user ---
app.get("/api/forms", authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM forms WHERE user_email = ? ORDER BY updated_at DESC", [req.user.email]);

    const forms = await Promise.all(
      rows.map(async (f) => {
        const [responses] = await pool.query("SELECT * FROM responses WHERE form_id = ? ORDER BY submitted_at DESC", [f.id]);
        const [viewRows] = await pool.query("SELECT COUNT(*) AS count FROM form_views WHERE form_id = ?", [f.id]);
        return {
          id: f.id,
          slug: f.slug,
          title: f.title,
          description: f.description,
          status: f.status,
          createdAt: f.created_at,
          updatedAt: f.updated_at,
          settings: f.settings,
          questions: f.questions,
          viewCount: viewRows[0].count,
          responses: responses.map((r) => ({
            id: r.id,
            submittedAt: r.submitted_at,
            email: r.email,
            answers: r.answers,
            votedCandidate: r.voted_candidate || undefined,
            voteCount: r.vote_count || undefined,
            totalPaid: r.total_paid ? Number(r.total_paid) : undefined,
            lat: r.lat || undefined,
            lon: r.lon || undefined,
          })),
        };
      })
    );

    res.json({ forms });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load racks." });
  }
});

// --- Create a brand new rack ---
app.post("/api/forms", authMiddleware, async (req, res) => {
  try {
    const { id, title, description, status, settings, questions } = req.body;
    if (!id || !title) return res.status(400).json({ error: "id and title are required." });

    let slug = slugify(title) || "form";
    const [existingSlug] = await pool.query("SELECT id FROM forms WHERE slug = ?", [slug]);
    if (existingSlug.length > 0) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    }

    await pool.query(
      "INSERT INTO forms (id, user_email, title, description, status, settings, questions, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, req.user.email, title, description || "", status || "draft", JSON.stringify(settings || {}), JSON.stringify(questions || []), slug]
    );

    res.status(201).json({ message: "Rack created.", slug });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create rack." });
  }
});

// --- Update an existing rack (owner only) ---
app.put("/api/forms/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, status, settings, questions } = req.body;

    const [existing] = await pool.query("SELECT user_email FROM forms WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Rack not found." });
    if (existing[0].user_email !== req.user.email) return res.status(403).json({ error: "Not your rack." });

    await pool.query(
      "UPDATE forms SET title = ?, description = ?, status = ?, settings = ?, questions = ? WHERE id = ?",
      [title, description || "", status, JSON.stringify(settings || {}), JSON.stringify(questions || []), id]
    );

    res.json({ message: "Rack updated." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update rack." });
  }
});

// --- Delete a rack (owner only) ---
app.delete("/api/forms/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await pool.query("SELECT user_email FROM forms WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Rack not found." });
    if (existing[0].user_email !== req.user.email) return res.status(403).json({ error: "Not your rack." });

    await pool.query("DELETE FROM forms WHERE id = ?", [id]);
    res.json({ message: "Rack deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete rack." });
  }
});

// --- Owner fetch: get one rack even if it's a draft (for editing in the builder) ---
app.get("/api/forms/:id/edit", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query("SELECT * FROM forms WHERE id = ?", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "Rack not found." });
    if (rows[0].user_email !== req.user.email) return res.status(403).json({ error: "Not your rack." });

    const [responses] = await pool.query("SELECT * FROM responses WHERE form_id = ? ORDER BY submitted_at DESC", [id]);
    const f = rows[0];

    res.json({
      id: f.id,
      slug: f.slug,
      title: f.title,
      description: f.description,
      status: f.status,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
      settings: f.settings,
      questions: f.questions,
      responses: responses.map((r) => ({
        id: r.id,
        submittedAt: r.submitted_at,
        email: r.email,
        answers: r.answers,
        votedCandidate: r.voted_candidate || undefined,
        voteCount: r.vote_count || undefined,
        totalPaid: r.total_paid ? Number(r.total_paid) : undefined,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load rack." });
  }
});

// --- Public fetch: anyone with the link can view (no auth needed) ---
app.get("/api/forms/:id/public", async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query("SELECT * FROM forms WHERE id = ?", [id]);
    if (rows.length === 0) return res.status(404).json({ found: false });

    const f = rows[0];
    res.json({
      found: true,
      id: f.id,
      title: f.title,
      description: f.description,
      status: f.status,
      settings: f.settings,
      questions: f.questions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load rack." });
  }
});

// --- Public fetch by slug: for the /form/:slug clean-URL links ---
app.get("/api/forms/slug/:slug/public", async (req, res) => {
  try {
    const { slug } = req.params;
    const [rows] = await pool.query("SELECT * FROM forms WHERE slug = ?", [slug]);
    if (rows.length === 0) return res.status(404).json({ found: false });

    const f = rows[0];
    res.json({
      found: true,
      id: f.id,
      slug: f.slug,
      title: f.title,
      description: f.description,
      status: f.status,
      settings: f.settings,
      questions: f.questions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load rack." });
  }
});

// --- Public view log: fires once when someone opens the live link ---
app.post("/api/forms/:id/view", async (req, res) => {
  try {
    const { id } = req.params;
    const viewId = "view_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    await pool.query("INSERT INTO form_views (id, form_id) VALUES (?, ?)", [viewId, id]);
    res.status(201).json({ message: "View recorded." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record view." });
  }
});

// --- Public submit: anyone with the link can submit a response ---
app.post("/api/forms/:id/responses", async (req, res) => {
  try {
    const { id } = req.params;
    const { email, answers, votedCandidate, voteCount, totalPaid, lat, lon } = req.body;

    const [rows] = await pool.query("SELECT * FROM forms WHERE id = ?", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "Rack not found." });

    const form = rows[0];
    if (form.status !== "published" || !form.settings?.acceptingResponses) {
      return res.status(403).json({ error: "This rack is not accepting responses." });
    }

    // If this was a paid-voting submission, bump the candidate's vote count inside the questions JSON
    let questions = form.questions;
    if (votedCandidate) {
      questions = questions.map((q) => {
        if (q.type === "paid_voting" && q.candidates) {
          return {
            ...q,
            candidates: q.candidates.map((c) =>
              c.name === votedCandidate ? { ...c, votes: c.votes + (voteCount || 1) } : c
            ),
          };
        }
        return q;
      });
      await pool.query("UPDATE forms SET questions = ? WHERE id = ?", [JSON.stringify(questions), id]);
    }

    const responseId = "resp_" + Date.now();
    await pool.query(
      "INSERT INTO responses (id, form_id, email, answers, voted_candidate, vote_count, total_paid, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [responseId, id, email || "Anonymous", JSON.stringify(answers || {}), votedCandidate || null, voteCount || null, totalPaid || null, lat || null, lon || null]
    );

    res.status(201).json({ message: "Response recorded." });

    // --- Fire and forget emails, don't block the response ---
    const answerRows = Object.entries(answers || {})
      .map(([qId, val]) => {
        const q = (questions || []).find((qq) => qq.id === qId);
        const label = q ? q.title : qId;
        const value = Array.isArray(val) ? val.join(", ") : val;
        return `<tr><td style="padding:6px 0;color:#888;font-size:13px;">${label}</td><td style="padding:6px 0;font-size:13px;">${value}</td></tr>`;
      })
      .join("");

    // Email 1: to the creator, notifying them of the new submission
    sendEmail(
      form.user_email,
      `New response on "${form.title}"`,
      `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
          <h2 style="color:#ab1f09;">New Submission Received</h2>
          <p>Your rack <strong>${form.title}</strong> just received a new response.</p>
          <p><strong>From:</strong> ${email || "Anonymous"}</p>
          ${votedCandidate ? `<p><strong>Voted for:</strong> ${votedCandidate} (${voteCount || 1} votes)</p>` : ""}
          ${totalPaid ? `<p><strong>Amount paid:</strong> $${Number(totalPaid).toFixed(2)}</p>` : ""}
          <table style="width:100%;border-collapse:collapse;margin-top:12px;">${answerRows}</table>
          <p style="margin-top:20px;font-size:12px;color:#888;">View all responses in your Rack dashboard.</p>
        </div>
      `
    );

    // Email 2: to the person who filled the form, confirming their submission
    if (email && email !== "Anonymous") {
      sendEmail(
        email,
        `Your response to "${form.title}" was received`,
        `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
            <h2 style="color:#ab1f09;">Thanks for filling this out!</h2>
            <p>Here's a copy of what you submitted to <strong>${form.title}</strong>.</p>
            ${votedCandidate ? `<p><strong>You voted for:</strong> ${votedCandidate} (${voteCount || 1} votes)</p>` : ""}
            ${totalPaid ? `<p><strong>Amount paid:</strong> $${Number(totalPaid).toFixed(2)}</p>` : ""}
            <table style="width:100%;border-collapse:collapse;margin-top:12px;">${answerRows}</table>
            <p style="margin-top:20px;font-size:13px;color:#555;">${form.settings?.confirmationMessage || "Thank you for your submission."}</p>
          </div>
        `
      );
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit response." });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Rack backend running on port ${PORT}`);
});