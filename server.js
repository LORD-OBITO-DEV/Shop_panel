import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
app.use(express.static("public"));
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  PAYPAL_MODE,
  EMAIL_USER,
  EMAIL_PASS,
  EMAIL_TO,
  PTERO_URL,
} = process.env;

// === CONFIG TRANSPORTEUR EMAIL ===
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// === ROUTE PRINCIPALE ===
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// === CREATION D’UN ORDER PAYPAL ===
app.post("/create-order", async (req, res) => {
  const { amount } = req.body;
  const response = await fetch(`https://api-m.${PAYPAL_MODE === "live" ? "" : "sandbox."}paypal.com/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64")}`,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: amount } }],
    }),
  });

  const data = await response.json();
  res.json(data);
});

// === CAPTURE DU PAIEMENT ===
app.post("/capture-order", async (req, res) => {
  const { orderID, email, panelName, duration, username, password } = req.body;

  const response = await fetch(`https://api-m.${PAYPAL_MODE === "live" ? "" : "sandbox."}paypal.com/v2/checkout/orders/${orderID}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64")}`,
    },
  });

  const data = await response.json();

  if (data.status === "COMPLETED") {
    const expiryDate = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);

    await transporter.sendMail({
      from: EMAIL_USER,
      to: email,
      subject: `Votre panel ${panelName} est prêt`,
      text: `Bonjour,\n\nMerci pour ton paiement. Ton panel a été créé.\n\nDétails:\nNom du panel: ${panelName}\nUsername: ${username}\nPassword: ${password}\nDurée: ${duration} jours\nURL panel: ${PTERO_URL}\n\nLe panel expirera le: ${expiryDate.toLocaleString()}\n\nCordialement,\nLORD OBITO TECH.`,
    });

    res.send(`<h2>Paiement confirmé — panel créé !</h2><p>Un email de confirmation a été envoyé à ${email}.</p>`);
  } else {
    res.status(500).send("Erreur lors de la capture du paiement PayPal.");
  }
});

// === LANCEMENT SERVEUR ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));
