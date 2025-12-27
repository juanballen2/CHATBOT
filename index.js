const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

// ============================================================
// 🔑 CONFIGURACIÓN Y SEGURIDAD (MODO RAILWAY)
// ============================================================
app.set('trust proxy', 1);

const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-ultra-secret-2025";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname)); 
app.use('/images', express.static(path.join(__dirname, 'images')));

const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    knowledge: path.join(DATA_DIR, 'knowledge.json'),
    config: path.join(DATA_DIR, 'config.json'),
    leads: path.join(DATA_DIR, 'leads.json'),
    history: path.join(DATA_DIR, 'history.json'),
    bot_status: path.join(DATA_DIR, 'bot_status.json')
};

const readData = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } 
    catch (err) { return fallback; }
};

const writeData = (file, data) => {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; }
    catch (err) { return false; }
};

app.use(session({
    secret: SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

let globalKnowledge = readData(FILES.knowledge, []);

// ============================================================
// 📩 ENVÍO DE WHATSAPP
// ============================================================
async function enviarWhatsApp(destinatario, texto) {
    try {
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: destinatario,
            type: "text",
            text: { body: texto }
        }, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
        console.log(`✅ Mensaje enviado a ${destinatario}`);
        return true;
    } catch (e) { 
        console.error("Error envío WhatsApp:", e.response?.data || e.message);
        return false;
    }
}

// ============================================================
// 🧠 PROCESAMIENTO CON IA LORENA (GEMINI 2.0 FLASH)
// ============================================================
function buscarEnCatalogo(query) {
    if (!query) return [];
    const norm = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    const q = norm(query).split(" ");
    return globalKnowledge.map(item => {
        let score = 0;
        const itemText = norm(item.searchable || ""); 
        q.forEach(w => { if (itemText.includes(w)) score++; });
        return { ...item, score };
    }).filter(i => i.score > 0).sort((a,b) => b.score - a.score).slice(0, 5);
}

async function procesarConLorena(message, sessionId) {
    const botStatus = readData(FILES.bot_status, {});
    if (botStatus[sessionId] === false) {
        let allHistory = readData(FILES.history, {});
        if (!allHistory[sessionId]) allHistory[sessionId] = [];
        allHistory[sessionId].push({ role: 'user', text: message, time: new Date().toISOString() });
        writeData(FILES.history, allHistory);
        return null; 
    }

    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});
    const chatPrevio = (allHistory[sessionId] || []).slice(-8);
    const stock = buscarEnCatalogo(message);

    const prompt = `Eres Lorena, la vendedora estrella de ICC (Importadora Casa Colombia). 
    TU OBJETIVO: Vender repuestos de maquinaria pesada (Caterpillar, Komatsu, etc.) y conseguir el contacto del cliente.

    CONTEXTO DE LA EMPRESA: ${config.tech_rules || 'Somos expertos en repuestos de alta calidad.'}
    INVENTARIO DISPONIBLE: ${JSON.stringify(stock)}
    HISTORIAL DE CONVERSACIÓN: ${JSON.stringify(chatPrevio)}

    DIRECTRICES DE RESPUESTA:
    1. Sé muy amable pero profesional. Usa "tú" o "usted" según el tono del cliente.
    2. Si el cliente pregunta por un repuesto que está en el INVENTARIO, da el precio y confirma disponibilidad.
    3. Si NO está en el inventario, dile que vas a consultar con bodega y pídele su correo o nombre para avisarle.
    4. Siempre cierra con una pregunta: "¿Para qué máquina lo necesitas?" o "¿A qué ciudad lo enviamos?".
    5. IMPORTANTE: Si detectas su nombre o correo, añade al final: [DATA] {"es_lead":true, "nombre":"...", "correo":"..."} [DATA]`;

    try {
        // ✨ CONFIGURACIÓN PARA GEMINI 2.0 FLASH
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] });

        let fullText = res.data.candidates[0].content.parts[0].text;
        let textoVisible = fullText;
        let dataPart = null;

        if (fullText.includes('[DATA]')) {
            const partes = fullText.split('[DATA]');
            textoVisible = partes[0].trim();
            dataPart = partes[1];
        }

        const respuestaLimpia = textoVisible.trim();

        if (!allHistory[sessionId]) allHistory[sessionId] = [];
        allHistory[sessionId].push({ role: 'user', text: message, time: new Date().toISOString() });
        allHistory[sessionId].push({ role: 'bot', text: respuestaLimpia, time: new Date().toISOString() });
        writeData(FILES.history, allHistory);

        if (dataPart) {
            try {
                const leadData = JSON.parse(dataPart.trim());
                if(leadData.es_lead) {
                    const leads = readData(FILES.leads, []);
                    leads.push({ ...leadData, fecha: new Date().toLocaleString(), telefono: sessionId });
                    writeData(FILES.leads, leads);
                }
            } catch (e) { console.log("Error Lead"); }
        }
        return respuestaLimpia;
    } catch (err) { 
        console.error("❌ Error en Gemini 2.0:", err.response?.data || err.message);
        return "Hola, te habla Lorena de ICC. Tuvimos una pequeña interrupción, ¿me podrías repetir lo último?"; 
    }
}

// ============================================================
// 🚦 RUTAS WEBHOOK
// ============================================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === 'ICC_2025') return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.message && !body.entry) {
        const r = await procesarConLorena(body.message, 'tester-web');
        return res.json({ reply: r || "(Bot en pausa manual)" });
    }
    if (body.object === 'whatsapp_business_account') {
        res.sendStatus(200);
        try {
            const entry = body.entry?.[0]?.changes?.[0]?.value;
            const msg = entry?.messages?.[0];
            if (msg?.text?.body) {
                const respuesta = await procesarConLorena(msg.text.body, msg.from);
                if (respuesta) await enviarWhatsApp(msg.from, respuesta);
            }
        } catch (e) { console.error("Error en Webhook:", e); }
    } else { res.sendStatus(200); }
});

// ============================================================
// ⚙️ APIS DASHBOARD
// ============================================================
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No autorizado");

app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isLogged = true;
        return req.session.save(() => res.json({ success: true }));
    }
    res.status(401).json({ success: false });
});

app.post('/save-context', proteger, (req, res) => {
    const config = readData(FILES.config, {});
    config.tech_rules = req.body.context;
    writeData(FILES.config, config);
    res.json({ success: true });
});

app.post('/api/chat/send', proteger, async (req, res) => {
    const { phone, message } = req.body;
    const enviado = await enviarWhatsApp(phone, message);
    if (enviado) {
        let allHistory = readData(FILES.history, {});
        if (!allHistory[phone]) allHistory[phone] = [];
        allHistory[phone].push({ role: 'manual', text: message, time: new Date().toISOString() });
        writeData(FILES.history, allHistory);
        res.json({ success: true });
    } else { res.status(500).json({ error: "No se pudo enviar" }); }
});

app.post('/api/chat/toggle-bot', proteger, (req, res) => {
    const { phone, active } = req.body;
    let botStatus = readData(FILES.bot_status, {});
    botStatus[phone] = active; 
    writeData(FILES.bot_status, botStatus);
    res.json({ success: true, status: active });
});

app.get('/api/data/:type', proteger, (req, res) => res.json(readData(FILES[req.params.type], [])));

app.post('/api/knowledge/csv', proteger, upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No se envió archivo" });
        const records = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true });
        globalKnowledge = records.map(r => ({ searchable: Object.values(r).join(" "), data: r }));
        writeData(FILES.knowledge, globalKnowledge);
        res.json({ success: true, count: globalKnowledge.length });
    } catch (e) { res.status(500).json({ error: "Error CSV" }); }
});

app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.listen(process.env.PORT || 10000, () => console.log("🚀 LORENA ICC ACTIVADA"));
