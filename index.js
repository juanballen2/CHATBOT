const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const https = require('https');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');
const cheerio = require('cheerio');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

// CONFIGURACIÓN DE SEGURIDAD
const API_KEY = process.env.GEMINI_KEY || "AIzaSyACJytpDnPzl9y5FeoQ5sx8m-iyhPXINto"; 
const ADMIN_USER = process.env.ADMIN_USER || "admin"; 
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025"; 

app.use(express.json());
app.use(session({
    secret: 'icc-ultra-secret-key-2025',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 }
}));

const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    knowledge: path.join(DATA_DIR, 'knowledge.json'),
    config: path.join(DATA_DIR, 'config.json'),
    leads: path.join(DATA_DIR, 'leads.json'),
    history: path.join(DATA_DIR, 'history.json')
};

let globalKnowledge = [];

// HELPERS (Para no perder datos)
const readData = (file, fallback) => {
    try {
        if (!fs.existsSync(file)) return fallback;
        const content = fs.readFileSync(file, 'utf8');
        return content ? JSON.parse(content) : fallback;
    } catch (err) { return fallback; }
};

const writeData = (file, data) => {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (err) { }
};

// LÓGICA DE LORENA (Cerebro)
async function procesarConLorena(message, sessionId = 'test-user') {
    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});
    // ... (Tu lógica de búsqueda y prompt que ya definimos)
    // Asegúrate de incluir el bloque de respuesta de Gemini aquí
}

// RUTAS DE ACCESO
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.isLogged = true;
        return res.json({ success: true });
    }
    res.status(401).send();
});

// WEBHOOK (Para Chat y WhatsApp)
app.post('/webhook', async (req, res) => {
    if (req.body.message) {
        const reply = await procesarConLorena(req.body.message);
        return res.json({ reply });
    }
    // Lógica para WhatsApp real...
    res.sendStatus(200);
});

// SEGURIDAD DEL DASHBOARD
app.use((req, res, next) => {
    if (req.session.isLogged || req.path === '/login' || req.path === '/auth') return next();
    res.redirect('/login');
});
app.use(express.static(__dirname));

// ENDPOINTS ADMINISTRATIVOS (CSV, URL, etc.)
app.post('/api/knowledge/csv', upload.single('file'), (req, res) => {
    const content = req.file.buffer.toString();
    const records = parse(content, { columns: true, skip_empty_lines: true });
    globalKnowledge = records.map(r => ({ searchable: Object.values(r).join(" "), originalRow: Object.entries(r).map(([k,v])=>`${k}:${v}`).join("|") }));
    writeData(FILES.knowledge, globalKnowledge);
    res.json({ success: true, total: globalKnowledge.length });
});

app.post('/api/knowledge/url', async (req, res) => {
    try {
        const { url } = req.body;
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(response.data);
        const contenido = $('p, h1, h2, li').text().substring(0, 1000);
        const total = [...readData(FILES.knowledge, []), { searchable: contenido, originalRow: `WEB: ${contenido} (${url})` }];
        writeData(FILES.knowledge, total);
        globalKnowledge = total;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    globalKnowledge = readData(FILES.knowledge, []);
    console.log(`🚀 MOTOR ICC 2.5 LISTO EN PUERTO ${PORT}`);
});
