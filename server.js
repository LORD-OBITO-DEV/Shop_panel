require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const bodyParser = require('body-parser');
const cors = require('cors');
const shortid = require('shortid');

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public'));

const {
  PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_MODE,
  PTERO_API_KEY, PTERO_URL,
  EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE, EMAIL_USER, EMAIL_PASS, EMAIL_TO,
  BASE_URL,
  EGG_NODE_ID, NEST_JS_ID, EGG_PYTHON_ID, NEST_PY_ID,
  EGG_MINECRAFT_ID, NEST_MINECRAFT_ID
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET || !PTERO_API_KEY || !PTERO_URL || !EMAIL_USER || !EMAIL_PASS ) {
  console.warn("⚠️ Certains env variables semblent manquants — vérifie `.env`.");
}

// chemins data
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify({ orders: {}, servers: {} }, null, 2));

// helper lire/écrire JSON
function readData() {
  return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
}
function writeData(obj) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(obj, null, 2));
}

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: EMAIL_HOST || 'smtp.gmail.com',
  port: EMAIL_PORT ? parseInt(EMAIL_PORT) : 465,
  secure: EMAIL_SECURE === 'true' || true,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// --------------- PAYPAL helpers ---------------
async function getPaypalAccessToken(){
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const url = `https://api${PAYPAL_MODE==='sandbox' ? '.sandbox' : ''}.paypal.com/v1/oauth2/token`;
  const res = await fetch(url, {
    method:'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('Erreur obtention token PayPal: '+JSON.stringify(j));
  return j.access_token;
}

// Create order
app.post('/create-paypal-order', async (req,res) => {
  try {
    const {
      panel, config, duration, panelName, username, password, email, price
    } = req.body;
    if (!panel || !config || !duration || !panelName || !username || !password || !email || !price) {
      return res.status(400).json({ error: 'Données incomplètes' });
    }
    const accessToken = await getPaypalAccessToken();
    const createUrl = `https://api${PAYPAL_MODE==='sandbox' ? '.sandbox' : ''}.paypal.com/v2/checkout/orders`;
    const body = {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'EUR', value: String(price) },
        description: `Panel ${panel} - ${panelName}`
      }],
      application_context: {
        return_url: `${BASE_URL}/execute-paypal`,
        cancel_url: `${BASE_URL}/cancel`
      }
    };
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(body)
    });
    const createJson = await createRes.json();
    if (!createJson || !createJson.id) return res.status(500).json({ error: 'Erreur création order', detail:createJson });

    // stocker ordre localement avec details de commande
    const data = readData();
    data.orders[createJson.id] = {
      id: createJson.id,
      panel, config, duration, panelName, username, password, email, price,
      createdAt: Date.now()
    };
    writeData(data);

    // récupérer approval url
    const approve = createJson.links.find(l => l.rel === 'approve');
    res.json({ approvalUrl: approve && approve.href ? approve.href : null, orderId: createJson.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------- Execute / capture PayPal (redirect) ---------------
app.get('/execute-paypal', async (req,res) => {
  // PayPal redirige ici avec ?token=<ORDERID>&PayerID=...
  const orderId = req.query.token || req.query.orderId || req.query.id;
  if (!orderId) return res.status(400).send("Missing order token.");

  try {
    const accessToken = await getPaypalAccessToken();
    const captureUrl = `https://api${PAYPAL_MODE==='sandbox' ? '.sandbox' : ''}.paypal.com/v2/checkout/orders/${orderId}/capture`;
    const captureRes = await fetch(captureUrl, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${accessToken}` }
    });
    const captureJson = await captureRes.json();

    // vérifier succès
    if (!captureJson || captureJson.status !== 'COMPLETED' && captureJson.status !== 'COMPLETED') {
      console.warn('PayPal capture response:', captureJson);
      // on continue quand même (par sécurité on peut vérifier captureJson.purchase_units[*].payments.captures)
    }

    // récupérer info commande stockée
    const data = readData();
    const orderData = data.orders[orderId];
    if (!orderData) {
      console.warn('Order data introuvable pour', orderId);
      return res.send("Paiement capturé mais commande introuvable sur le serveur. Contacte le support.");
    }

    // 1) créer le serveur via Pterodactyl
    const server = await createPteroServer(orderData);

    // 2) stocker server avec expiry (timestamp)
    const expiryMs = Date.now() + (parseInt(orderData.duration) * 24 * 60 * 60 * 1000);
    data.servers[server.identifier || server.id || shortid.generate()] = {
      serverInfo: server,
      orderId,
      panelName: orderData.panelName,
      createdAt: Date.now(),
      expiresAt: expiryMs,
      panel: orderData.panel
    };
    // supprimer order de pending
    delete data.orders[orderId];
    writeData(data);

    // 3) envoyer mails (to admin and to client)
    // mail admin
    await transporter.sendMail({
      from: EMAIL_USER,
      to: EMAIL_TO,
      subject: `Nouvelle commande Pterodactyl: ${orderData.panelName}`,
      text: `Commande créée et panel deployé.\n\nDétails:\nPanel: ${orderData.panel}\nConfig: ${orderData.config}\nDurée: ${orderData.duration} jours\nNom: ${orderData.panelName}\nUsername: ${orderData.username}\nPassword: ${orderData.password}\nEmail client: ${orderData.email}\nServer info: ${JSON.stringify(server, null, 2)}\n\nExpirera le: ${new Date(expiryMs).toISOString()}`
    });

    // mail client
    await transporter.sendMail({
      from: EMAIL_USER,
      to: orderData.email,
      subject: `Votre panel ${orderData.panelName} est prêt`,
      text: `Bonjour,\n\nMerci pour ton paiement. Ton panel a été créé.\n\nDétails:\nPanel: ${orderData.panel}\nNom du panel: ${orderData.panelName}\nUsername: ${orderData.username}\nPassword: ${orderData.password}\nDurée: ${orderData.duration} jours\nURL panel (si applicable): ${PTERO_URL}\n\nLe panel expirera le: ${new Date(expiryMs).toLocaleString()}\n\nCordialement.`
    });

    // réponse utilisateur (page simple)
    res.send(`<h2>Paiement confirmé — panel créé !</h2><p>Tu as reçu un email. Si tu n'as rien reçu, contacte l'admin.</p>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur lors de la capture PayPal: ' + (err.message || err));
  }
});

// --------------- PTERODACTYL helper: create server ---------------
async function createPteroServer(orderData) {
  // orderData: { panel, config, duration, panelName, username, password, email, price }
  // ON UTILISE les env EGG_* et NEST_* fournis par toi.
  // IMPORTANT: adapte le payload suivant à la version de ton Pterodactyl (ressources, nest/egg fields, allocation).
  // Ce payload est un bon point de départ mais peut nécessiter ajustement selon ton panel.

  const memoryGo = parseInt(orderData.config.split('/')[0].replace('GO','')) || 1;
  const cpuPercent = parseInt(orderData.config.split('/')[1].replace('%CPU','')) || 40;
  const diskGo = memoryGo; // approximatif

  // choisir les ids selon le panel
  let nestId, eggId;
  if (orderData.panel === 'Node.js') {
    nestId = parseInt(NEST_JS_ID);
    eggId = parseInt(EGG_NODE_ID);
  } else if (orderData.panel === 'Python') {
    nestId = parseInt(NEST_PY_ID);
    eggId = parseInt(EGG_PYTHON_ID);
  } else if (orderData.panel === 'Minecraft') {
    nestId = parseInt(NEST_MINECRAFT_ID || 0) || null;
    eggId = parseInt(EGG_MINECRAFT_ID || 0) || null;
  }

  // fallback check
  if (!nestId || !eggId) {
    console.warn("Egg/Nest manquants pour panel", orderData.panel, ". Le serveur sera créé avec egg par défaut — vérifie les ENV.");
  }

  // payload minimal - A ADAPTER selon ton Pterodactyl
  const payload = {
    name: orderData.panelName,
    user: 0, // si tu veux associer un user tu dois créer un user via l'API Ptero et mettre son id
    nest: nestId || 1,
    egg: eggId || 1,
    docker_image: "quay.io/pterodactyl/core:base", // change si tu using specific images
    startup: "", // peut être vide si l'egg gère la startup
    allocation: { default: 0 }, // il faut souvent fournir allocation id (port) — tu devras adapter
    limits: {
      memory: memoryGo * 1024, // en MB
      swap: 0,
      disk: diskGo * 1024,
      io: 500,
      cpu: Math.round(cpuPercent)
    },
    environment: {
      "USERNAME": orderData.username,
      "PASSWORD": orderData.password
      // ajoute d'autres variables d'environnement requises par l'egg
    }
  };

  // Note: de nombreuses installations Pterodactyl requièrent avant création :
  // - récupérer une allocation (POST /api/application/allocations?server=1,ip=...,ports...)
  // - ou indiquer allocation id existante.
  // Pour la simplicité, j'essaie de POSTer sur /api/application/servers — adapte selon ton panel.

  const url = `${PTERO_URL.replace(/\/$/, '')}/api/application/servers`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PTERO_API_KEY}`,
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const j = await res.json();
  if (!res.ok) {
    console.error('Erreur création Pterodactyl:', j);
    throw new Error('Erreur création serveur Pterodactyl: ' + JSON.stringify(j));
  }
  return j; // retourne la réponse de l'API Pterodactyl
}

// --------------- Cron: vérification et suppression des panels expirés ---------------
cron.schedule('* * * * *', async () => {
  try {
    const data = readData();
    const now = Date.now();
    for (const key of Object.keys(data.servers)) {
      const srv = data.servers[key];
      if (srv.expiresAt && now >= srv.expiresAt) {
        console.log('Expiration détectée pour', key, ' — suppression en cours...');
        // supprime via API Pterodactyl
        try {
          // identifier comment identifier le serveur : selon réponse createPteroServer
          // on cherche un champ 'attributes' or 'id' ou 'identifier' — adapte si nécessaire
          const serverId = (srv.serverInfo && (srv.serverInfo.attributes && srv.serverInfo.attributes.id)) ||
                           (srv.serverInfo && srv.serverInfo.id) ||
                           (srv.serverInfo && srv.serverInfo.object && srv.serverInfo.object.id) ||
                           key;
          if (!serverId) {
            console.warn('Impossible de trouver serverId pour suppression:', srv);
          } else {
            const url = `${PTERO_URL.replace(/\/$/, '')}/api/application/servers/${serverId}`;
            const delRes = await fetch(url, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${PTERO_API_KEY}`, 'Accept': 'application/json' }
            });
            if (!delRes.ok) {
              console.warn('Erreur suppression serveur ptero', await delRes.text());
            } else {
              console.log('Serveur supprimé:', serverId);
            }
          }
        } catch (err) {
          console.error('Erreur suppression ptero:', err);
        }
        // notifier admin
        await transporter.sendMail({
          from: EMAIL_USER,
          to: EMAIL_TO,
          subject: `Panel supprimé: ${srv.panelName}`,
          text: `Le panel ${srv.panelName} lié à la commande ${srv.orderId} a été supprimé automatiquement (expiration).`
        });
        // remove from data
        delete data.servers[key];
        writeData(data);
      }
    }
  } catch (err) {
    console.error('Cron error:', err);
  }
});

// --------------- endpoint health ---------------
app.get('/health', (req,res) => res.json({ ok: true, time: Date.now() }));

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur port ${PORT}`));