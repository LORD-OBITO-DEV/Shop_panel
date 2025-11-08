import express from "express";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import axios from "axios";
import paypal from "paypal-rest-sdk";

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.static("public")); // dossier contenant ton index.html

// === PAYPAL CONFIGURATION ===
paypal.configure({
  mode: process.env.PAYPAL_MODE || "sandbox",
  client_id: process.env.PAYPAL_CLIENT_ID,
  client_secret: process.env.PAYPAL_SECRET,
});

// === ROUTE CRÉATION COMMANDE PAYPAL ===
app.post("/create-paypal-order", async (req, res) => {
  const { panel, config, duration, panelName, username, password, email, price } = req.body;

  if (!panel || !price) {
    return res.status(400).json({ error: "Paramètres manquants" });
  }

  const create_payment_json = {
    intent: "sale",
    payer: { payment_method: "paypal" },
    redirect_urls: {
      return_url: "https://shop-panel-dx3h.onrender.com/success",
      cancel_url: "https://shop-panel-dx3h.onrender.com/cancel",
    },
    transactions: [
      {
        item_list: {
          items: [
            {
              name: `${panel} Panel`,
              sku: "001",
              price: price.toString(),
              currency: "EUR",
              quantity: 1,
            },
          ],
        },
        amount: {
          currency: "EUR",
          total: price.toString(),
        },
        description: `Achat d'un panel ${panel} (${config}) pour ${duration} jours.`,
      },
    ],
  };

  paypal.payment.create(create_payment_json, (error, payment) => {
    if (error) {
      console.error("Erreur création order PayPal:", error.response);
      return res.json({ error: "Erreur création order PayPal" });
    } else {
      const approvalUrl = payment.links.find(l => l.rel === "approval_url")?.href;
      res.json({ approvalUrl });
    }
  });
});

// === ROUTE DE SUCCESS PAYPAL ===
app.get("/success", async (req, res) => {
  const { paymentId, PayerID } = req.query;
  paypal.payment.execute(paymentId, { payer_id: PayerID }, async (error, payment) => {
    if (error) {
      console.error(error.response);
      return res.send("Erreur lors du paiement PayPal.");
    }

    const details = payment.transactions[0];
    const buyer = payment.payer.payer_info.email;
    const panelType = details.item_list.items[0].name;

    try {
      // === Création panel automatique sur Pterodactyl ===
      await createPterodactylServer(panelType);

      // === Envoi d’un mail de confirmation ===
      await sendMail(buyer, panelType);

      res.send(`
        <h2>Paiement réussi ✅</h2>
        <p>Merci ${buyer}, ton panel a été créé avec succès !</p>
        <a href="/">Retour</a>
      `);
    } catch (e) {
      console.error("Erreur création panel ou mail:", e);
      res.send("Paiement ok, mais erreur lors de la création du panel.");
    }
  });
});

// === ROUTE D'ANNULATION ===
app.get("/cancel", (req, res) => {
  res.send("<h3>Paiement annulé ❌</h3><a href='/'>Retour</a>");
});

// === CRÉATION PANEL AUTO ===
async function createPterodactylServer(type) {
  const url = process.env.PTERO_URL;
  const key = process.env.PTERO_API_KEY;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" };

  let egg = process.env.PTERO_JS_EGG;
  let nest = process.env.PTERO_JS_NEST;
  if (type.includes("Python")) {
    egg = process.env.PTERO_PYTHON_EGG;
    nest = process.env.PTERO_PYTHON_NEST;
  }

  const data = {
    name: `Auto-${type}-${Date.now()}`,
    user: 1,
    egg,
    docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
    startup: "npm start",
    environment: {},
    limits: { memory: 1024, swap: 0, disk: 1024, io: 500, cpu: 50 },
    feature_limits: { databases: 1, backups: 1 },
    allocation: { default: 1 },
  };

  const res = await axios.post(`${url}/api/application/servers`, data, { headers });
  return res.data;
}

// === MAIL DE CONFIRMATION ===
async function sendMail(to, panelType) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  await transporter.sendMail({
    from: `"LORD OBITO TECH" <${process.env.EMAIL_USER}>`,
    to,
    subject: "Panel créé avec succès ✅",
    text: `Ton panel ${panelType} a été créé. Merci pour ta confiance.`,
  });
}

// === LANCEMENT SERVEUR ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));
