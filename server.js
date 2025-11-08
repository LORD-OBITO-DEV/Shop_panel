import express from "express";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import axios from "axios";
import fetch from "node-fetch";

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.static("public")); // ton index.html

const PAYPAL_API = process.env.PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

// === GET ACCESS TOKEN PAYPAL ===
async function getAccessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  return data.access_token;
}

// === ROUTE CREATE ORDER ===
app.post("/create-paypal-order", async (req, res) => {
  const { panel, config, duration, panelName, username, password, email, price } = req.body;
  if (!panel || !price) return res.status(400).json({ error: "Paramètres manquants" });

  try {
    const accessToken = await getAccessToken();
    const body = {
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: "EUR", value: price.toString() },
        description: `Achat panel ${panel} (${config}) pour ${duration} jours.`
      }]
    };

    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const orderData = await orderRes.json();
    res.json({ orderId: orderData.id });
  } catch (e) {
    console.error("Erreur création order PayPal:", e);
    res.status(500).json({ error: "Erreur création order PayPal" });
  }
});

// === ROUTE EXECUTE / CAPTURE ===
app.get("/execute-paypal", async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).send("Order ID manquant");

  try {
    const accessToken = await getAccessToken();
    const captureRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    const captureData = await captureRes.json();

    // === Création automatique panel ===
    const panelType = captureData.purchase_units[0].description;
    await createPterodactylServer(panelType);

    // === Envoi mail ===
    const buyer = captureData.payer.email_address;
    await sendMail(buyer, panelType);

    res.send(`
      <h2>Paiement réussi ✅</h2>
      <p>Merci ${buyer}, ton panel a été créé avec succès !</p>
      <a href="/">Retour</a>
    `);
  } catch (e) {
    console.error("Erreur capture / panel:", e);
    res.send("Erreur lors de la capture PayPal ou création du panel.");
  }
});

// === CRÉATION PANEL PTERODACTYL ===
async function createPterodactylServer(type) {
  const url = process.env.PTERO_URL;
  const key = process.env.PTERO_API_KEY;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" };

  let egg = process.env.PTERO_JS_EGG;
  let nest = process.env.PTERO_JS_NEST;
  if (type.includes("Python")) { egg = process.env.PTERO_PYTHON_EGG; nest = process.env.PTERO_PYTHON_NEST; }

  const data = {
    name: `Auto-${type}-${Date.now()}`,
    user: 1,
    egg,
    docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
    startup: "npm start",
    environment: {},
    limits: { memory: 1024, swap: 0, disk: 1024, io: 500, cpu: 50 },
    feature_limits: { databases: 1, backups: 1 },
    allocation: { default: 1 }
  };

  const res = await axios.post(`${url}/api/application/servers`, data, { headers });
  return res.data;
}

// === MAIL DE CONFIRMATION ===
async function sendMail(to, panelType) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });

  await transporter.sendMail({
    from: `"LORD OBITO TECH" <${process.env.EMAIL_USER}>`,
    to,
    subject: "Panel créé avec succès ✅",
    text: `Ton panel ${panelType} a été créé. Merci pour ta confiance.`
  });
}

// === NUMÉROS ORANGE / WAVE ===
app.get("/numbers", (req,res)=> {
  res.json({ orange: process.env.ORANGE_NUMBER || "+225XXXXXXXX", wave: process.env.WAVE_NUMBER || "+225XXXXXXXX" });
});

// === LANCEMENT SERVEUR ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🚀 Serveur actif sur le port ${PORT}`));
