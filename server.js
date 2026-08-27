const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("./db");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

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

    const token = jwt.sign({ email }, process.env.JWT_SECRET || "defaultsecret", { expiresIn: "7d" });

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

    const token = jwt.sign({ email: user.email }, process.env.JWT_SECRET || "defaultsecret", { expiresIn: "7d" });

    res.json({ message: "Login successful.", token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Rack backend running on port ${PORT}`);
});