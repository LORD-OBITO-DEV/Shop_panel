import express from "express";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import axios from "axios";
import fetch from "node-fetch";

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.static("public"));

// === PAYPAL API CONFIG ===
const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_API = process.env.PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

async function getAccessToken() {
  const auth = Buffer.from(PAYPAL_CLIENT + ":" + PAYPAL_SECRET).toString("base64");
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  return data.access_token;
}

// === CREATE PAYPAL ORDER ===
app.post("/create-paypal-order", async (req, res) => {
  const { panel, config, duration, panelName, username, password, email, price } = req.body;
  if (!panel || !price) return res.status(400).json({ error: "Paramètres manquants" });

  const accessToken = await getAccessToken();
  const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: "EUR", value: price.toString() },
        description: `Achat panel ${panel} (${config}) pour ${duration} jours`
      }],
      application_context: {
        return_url: `https://${process.env.HOSTNAME}/execute-paypal`,
        cancel_url: `https://${process.env.HOSTNAME}/cancel`
      }
    })
  });
  const order = await orderRes.json();
  res.json({ id: order.id });
});

// === EXECUTE PAYPAL ===
app.get("/execute-paypal", async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).send("Order ID manquant");

  try {
    const accessToken = await getAccessToken();
    const captureRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }
    });
    const captureData = await captureRes.json();

    // === EXTRACT INFO ===
    const purchase = captureData.purchase_units[0];
    const buyerEmail = captureData.payer.email_address;
    const desc = purchase.description;
    const panel = desc.split(" ")[2];
    const config = desc.match(/\((.*?)\)/)[1];
    const duration = parseInt(desc.match(/pour (\d+) jours/)[1]);
    const panelName = `Auto-${panel}-${Date.now()}`;
    const username = `user${Math.floor(Math.random()*9999)}`;
    const password = Math.random().toString(36).slice(-8);
    const expiryMs = Date.now() + duration*24*60*60*1000;

    // === CREATE PTERODACTYL SERVER ===
    await createPterodactylServer(panel);

    // === SEND EMAIL ===
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: buyerEmail,
      subject: `Votre panel ${panelName} est prêt`,
      text: `Bonjour,

Merci pour ton paiement. Ton panel a été créé.

Détails:
Panel: ${panel}
Nom du panel: ${panelName}
Username: ${username}
Password: ${password}
Durée: ${duration} jours
URL panel: ${process.env.PTERO_URL}

Le panel expirera le: ${new Date(expiryMs).toLocaleString()}

Cordialement.`
    });

    res.send(`<h2>Paiement confirmé — panel créé ! ✅</h2>
              <p>Tu as reçu un email à ${buyerEmail}. Si tu n'as rien reçu, contacte l'admin.</p>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur lors de la capture PayPal: ' + (err.message || err));
  }
});

// === CANCEL ===
app.get("/cancel", (req,res)=>res.send("<h3>Paiement annulé ❌</h3><a href='/'>Retour</a>"));

// === CREATE PTERODACTYL SERVER FUNCTION ===
async function createPterodactylServer(type){
  const url = process.env.PTERO_URL;
  const key = process.env.PTERO_API_KEY;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const data = {
    name: `Auto-${type}-${Date.now()}`,
    user: 1,
    egg: process.env.PTERO_JS_EGG,
    docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
    startup: "npm start",
    environment: {},
    limits: { memory: 1024, swap: 0, disk: 1024, io: 500, cpu: 50 },
    feature_limits: { databases: 1, backups: 1 },
    allocation: { default: 1 }
  };
  await axios.post(`${url}/api/application/servers`, data, { headers });
}

// === LANCEMENT SERVEUR ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🚀 Serveur actif sur le port ${PORT}`));
