const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const https = require('https');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

// ============================================================
// 🔑 CONFIGURACIÓN Y CONSTANTES
// ============================================================
app.set('trust proxy', 1);

const API_KEY = "AIzaSyACJytpDnPzl9y5FeoQ5sx8m-iyhPXINto"; 
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = process.env.SESSION_SECRET || "icc-ultra-secret-2025";
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "ICC_2025";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

// ============================================================
// 💾 SESIÓN (DESACTIVADA PRÁCTICAMENTE)
// ============================================================
app.use(session({
    secret: SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    cookie: { secure: false }
}));

let globalKnowledge = readData(FILES.knowledge, []);

// ============================================================
// 🧠 LÓGICA INTELIGENTE (LORENA)
// ============================================================
function buscarEnCatalogo(query) {
    if (!query) return [];
    const normalizar = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    const qNorm = normalizar(query).split(" "); 
    
    return globalKnowledge.map(item => {
        const itemNorm = normalizar(item.searchable);
        let coincidencias = 0;
        qNorm.forEach(word => { if (itemNorm.includes(word)) coincidencias++; });
        return { ...item, score: coincidencias };
    })
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function procesarConLorena(message, sessionId = 'tester') {
    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});
    
    const historialChat = (allHistory[sessionId] || []).slice(-6);
    const historialTexto = historialChat.map(m => `${m.role === 'user' ? 'Cliente' : 'Lorena'}: ${m.text}`).join('\n');
    const stockEncontrado = buscarEnCatalogo(message);

    const prompt = `Eres Lorena de ICC. Info empresa: ${config.tech_rules || ''}. Inventario: ${JSON.stringify(stockEncontrado)}. Cliente dice: ${message}`;

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const textoBot = response.data.candidates[0].content.parts[0].text;
        return textoBot;
    } catch (error) { return "Lo siento, ¿puedes repetir?"; }
}

// ============================================================
// 🚦 RUTAS Y EL FAMOSO BYPASS
// ============================================================

// EL PORTERO AHORA DEJA PASAR A TODO EL MUNDO
const proteger = (req, res, next) => {
    console.log("BYPASS: Entrando sin contraseña");
    return next(); 
};

app.get('/login', (req, res) => res.redirect('/'));

app.post('/auth', (req, res) => {
    req.session.isLogged = true;
    res.json({ success: true });
});

app.get('/logout', (req, res) => res.redirect('/'));

app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === META_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.message && !body.entry) {
        const reply = await procesarConLorena(body.message, 'web-tester');
        return res.json({ reply });
    }
    res.sendStatus(200);
});

// RUTAS DEL API PROTEGIDAS (Pero el portero las deja pasar)
app.post('/api/save-personality', proteger, (req, res) => {
    const config = readData(FILES.config, {});
    config.prompt = req.body.prompt;
    writeData(FILES.config, config);
    res.json({ success: true });
});

app.post('/save-context', proteger, (req, res) => {
    const config = readData(FILES.config, {});
    config.tech_rules = req.body.context;
    writeData(FILES.config, config);
    res.json({ success: true });
});

app.post('/api/knowledge/csv', proteger, upload.single('file'), (req, res) => {
    try {
        const content = req.file.buffer.toString('utf-8');
        const records = parse(content, { columns: true, skip_empty_lines: true });
        globalKnowledge = records.map(r => ({ searchable: Object.values(r).join(" "), data: r }));
        writeData(FILES.knowledge, globalKnowledge);
        res.json({ success: true, total: globalKnowledge.length });
    } catch (e) { res.status(500).json({ error: "Error en CSV" }); }
});

app.get('/api/data/:type', proteger, (req, res) => res.json(readData(FILES[req.params.type], [])));

// LA RUTA PRINCIPAL
app.get('/', proteger, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 LORENA ONLINE - BYPASS ACTIVO`));
