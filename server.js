import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import fs from "fs";
import cron from "node-cron";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

// === CONFIG ENV ===
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  PAYPAL_MODE,
  PTERO_API_KEY,
  PTERO_URL,
  PTERO_NODE_NAME,
  PTERO_JS_EGG,
  PTERO_JS_NEST,
  PTERO_PYTHON_EGG,
  PTERO_PYTHON_NEST,
  EMAIL_USER,
  EMAIL_PASS,
  EMAIL_TO,
} = process.env;

// === DATA LOCAL ===
const dataPath = "./data.json";
const readData = () => (fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath)) : { orders: {} });
const writeData = (data) => fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

// === EMAIL CONFIG ===
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// === PAYPAL TOKEN ===
async function getPaypalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  const url = `https://api${PAYPAL_MODE === "sandbox" ? ".sandbox" : ""}.paypal.com/v1/oauth2/token`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || "Erreur PayPal Auth");
  return json.access_token;
}

// === CRÉER UNE COMMANDE PAYPAL ===
app.post("/create-paypal-order", async (req, res) => {
  try {
    const { panel, config, duration, panelName, username, password, email, price } = req.body;
    if (!panel || !config || !duration || !panelName || !username || !password || !email || !price)
      return res.status(400).json({ error: "Données incomplètes" });

    const accessToken = await getPaypalAccessToken();
    const createUrl = `https://api${PAYPAL_MODE === "sandbox" ? ".sandbox" : ""}.paypal.com/v2/checkout/orders`;

    const body = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: "EUR", value: parseFloat(price).toFixed(2) },
          description: `Panel ${panel} - ${panelName}`,
        },
      ],
      application_context: {
        brand_name: "LORD OBITO TECH",
        landing_page: "NO_PREFERENCE", // ✅ Permet paiement par carte sans compte
        user_action: "PAY_NOW",
        payment_method: {
          payer_selected: "PAYPAL",
          payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED",
        },
        return_url: `${process.env.BASE_URL || "https://shop-panel-dx3h.onrender.com"}/execute-paypal`,
        cancel_url: `${process.env.BASE_URL || "https://shop-panel-dx3h.onrender.com"}/cancel`,
      },
    };

    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const createJson = await createRes.json();
    if (!createRes.ok) {
      console.error("Erreur PayPal:", createJson);
      return res.status(500).json({ error: "Erreur création order", details: createJson });
    }

    const data = readData();
    data.orders[createJson.id] = {
      id: createJson.id,
      panel, config, duration, panelName, username, password, email, price,
      createdAt: Date.now(),
      paid: false,
    };
    writeData(data);

    const approve = createJson.links.find((l) => l.rel === "approve");
    return res.json({ approvalUrl: approve.href, orderId: createJson.id });
  } catch (err) {
    console.error("Erreur PayPal (exception):", err);
    return res.status(500).json({ error: err.message });
  }
});

// === CAPTURE DU PAIEMENT ===
app.get("/execute-paypal", async (req, res) => {
  const { token } = req.query;
  try {
    const accessToken = await getPaypalAccessToken();
    const captureUrl = `https://api${PAYPAL_MODE === "sandbox" ? ".sandbox" : ""}.paypal.com/v2/checkout/orders/${token}/capture`;

    const captureRes = await fetch(captureUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
    });

    const captureJson = await captureRes.json();
    if (!captureRes.ok) throw new Error("Erreur capture paiement");

    const data = readData();
    const order = data.orders[token];
    if (order) {
      order.paid = true;
      order.expireAt = Date.now() + getDurationMs(order.duration);
      writeData(data);

      // === Création du panel ===
      await createPteroPanel(order);

      // === Envoi de mail
      await transporter.sendMail({
        from: EMAIL_USER,
        to: EMAIL_TO,
        subject: `🧾 Nouveau paiement - ${order.panelName}`,
        text: `Nouveau panel créé :
Type: ${order.panel}
Nom: ${order.panelName}
User: ${order.username}
Durée: ${order.duration}
Email: ${order.email}
Prix: ${order.price} €`,
      });
    }

    return res.send("✅ Paiement confirmé et panel en cours de création !");
  } catch (err) {
    console.error("Erreur capture:", err);
    return res.status(500).send("Erreur de validation du paiement.");
  }
});

// === CRÉATION PANEL PTERODACTYL ===
async function createPteroPanel(order) {
  const egg = order.panel === "Node.js" ? PTERO_JS_EGG : PTERO_PYTHON_EGG;
  const nest = order.panel === "Node.js" ? PTERO_JS_NEST : PTERO_PYTHON_NEST;

  const body = {
    name: order.panelName,
    user: 1, // ID admin ou user par défaut
    egg,
    docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
    startup: "npm start",
    environment: { STARTUP_CMD: "npm start" },
    limits: { memory: parseInt(order.config.split("/")[0]), cpu: parseInt(order.config.split("/")[1]) },
    feature_limits: { databases: 1, backups: 1, allocations: 1 },
    deploy: { locations: [1], dedicated_ip: false, port_range: [] },
  };

  const res = await fetch(`${PTERO_URL}api/application/servers`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PTERO_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) console.error("Erreur création panel:", json);
  else console.log("✅ Panel créé:", json.attributes?.identifier || json);
}

// === FONCTION DURÉE (ms) ===
function getDurationMs(duration) {
  switch (duration) {
    case "7j": return 7 * 24 * 60 * 60 * 1000;
    case "15j": return 15 * 24 * 60 * 60 * 1000;
    case "30j": return 30 * 24 * 60 * 60 * 1000;
    default: return 7 * 24 * 60 * 60 * 1000;
  }
}

// === CRON SUPPRESSION PANELS EXPIRÉS ===
cron.schedule("0 * * * *", async () => {
  const data = readData();
  for (const id in data.orders) {
    const order = data.orders[id];
    if (order.expireAt && Date.now() > order.expireAt && order.paid) {
      console.log(`⛔ Suppression panel expiré: ${order.panelName}`);
      await deletePanel(order.panelName);
      delete data.orders[id];
    }
  }
  writeData(data);
});

async function deletePanel(name) {
  try {
    const res = await fetch(`${PTERO_URL}api/application/servers/${name}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${PTERO_API_KEY}`, "Accept": "application/json" },
    });
    if (res.ok) console.log(`🗑️ Panel ${name} supprimé.`);
  } catch (err) {
    console.error("Erreur suppression panel:", err);
  }
}

// === DÉMARRAGE SERVEUR ===
app.listen(3000, () => console.log("🚀 Serveur actif sur le port 3000"));
