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
// 🔑 CONFIGURACIÓN
// ============================================================
app.set('trust proxy', 1);

const API_KEY = "AIzaSyACJytpDnPzl9y5FeoQ5sx8m-iyhPXINto"; 
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = process.env.SESSION_SECRET || "icc-ultra-secret-2025";

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
    history: path.join(DATA_DIR, 'history.json')
};

const readData = (file, fallback) => {
    try {
        if (!fs.existsSync(file)) return fallback;
        const content = fs.readFileSync(file, 'utf8');
        return content ? JSON.parse(content) : fallback;
    } catch (err) { return fallback; }
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
// 🧠 LÓGICA DE BÚSQUEDA E IA (LORENA)
// ============================================================
function buscarEnCatalogo(query) {
    if (!query) return [];
    const normalizar = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    const qNorm = normalizar(query).split(" "); 
    return globalKnowledge.map(item => {
        const itemNorm = normalizar(item.searchable);
        let score = 0;
        qNorm.forEach(word => { if (itemNorm.includes(word)) score++; });
        return { ...item, score };
    }).filter(i => i.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

async function procesarConLorena(message, sessionId = 'tester') {
    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});
    const historialChat = (allHistory[sessionId] || []).slice(-6);
    const stock = buscarEnCatalogo(message);

    const prompt = `Eres Lorena de ICC. Reglas: ${config.tech_rules || 'Vende repuestos'}. 
    Inventario hallado: ${JSON.stringify(stock)}. Historial: ${JSON.stringify(historialChat)}. 
    Cliente: ${message}. Responde amable y busca el Lead (Nombre, Correo). 
    Si captas datos, añade al final: [DATA] {"es_lead":true, "nombre":"...", "correo":"..."} [DATA]`;

    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] });

        const fullText = res.data.candidates[0].content.parts[0].text;
        const [textoBot, dataPart] = fullText.split('[DATA]');

        // Guardar Historial
        if (!allHistory[sessionId]) allHistory[sessionId] = [];
        allHistory[sessionId].push({ role: 'user', text: message }, { role: 'bot', text: textoBot.trim() });
        writeData(FILES.history, allHistory);

        // Guardar Lead si existe
        if (dataPart) {
            try {
                const leadData = JSON.parse(dataPart.trim());
                const leads = readData(FILES.leads, []);
                leads.push({ ...leadData, fecha: new Date().toLocaleString(), telefono: sessionId });
                writeData(FILES.leads, leads);
            } catch (e) { console.log("Error en Lead JSON"); }
        }
        return textoBot.trim();
    } catch (err) { return "Lo siento, estamos revisando el sistema. ¿Me repites?"; }
}

// ============================================================
// 🚦 RUTAS Y WEBHOOK (VERIFICACIÓN META)
// ============================================================
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.isLogged = true;
        req.session.save(() => res.json({ success: true }));
    } else res.status(401).json({ success: false });
});

const proteger = (req, res, next) => req.session.isLogged ? next() : res.redirect('/login');

app.get('/webhook', (req, res) => {
    const token = 'ICC_2025';
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
        return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.message && !body.entry) { // Test desde Dashboard
        const reply = await procesarConLorena(body.message, 'web-tester');
        return res.json({ reply });
    }
    if (body.object === 'whatsapp_business_account') { // Mensaje real WhatsApp
        const entry = body.entry?.[0]?.changes?.[0]?.value;
        if (entry?.messages?.[0]) {
            const msg = entry.messages[0];
            await procesarConLorena(msg.text.body, msg.from);
        }
        return res.sendStatus(200);
    }
    res.sendStatus(200);
});

// APIs DASHBOARD
app.get('/api/data/:type', proteger, (req, res) => res.json(readData(FILES[req.params.type], [])));
app.post('/save-context', proteger, (req, res) => {
    const config = readData(FILES.config, {});
    config.tech_rules = req.body.context;
    writeData(FILES.config, config);
    res.json({ success: true });
});
app.post('/api/knowledge/csv', proteger, upload.single('file'), (req, res) => {
    const content = req.file.buffer.toString('utf-8');
    const records = parse(content, { columns: true, skip_empty_lines: true });
    globalKnowledge = records.map(r => ({ searchable: Object.values(r).join(" "), data: r }));
    writeData(FILES.knowledge, globalKnowledge);
    res.json({ success: true });
});

app.get('/', proteger, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.listen(process.env.PORT || 10000, () => console.log(`🚀 ICC SISTEMA COMPLETO`));
