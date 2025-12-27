const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

app.set('trust proxy', 1);

// CONFIGURACIÓN DE VARIABLES
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-ultra-secret-2025";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname)); 

const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    knowledge: path.join(DATA_DIR, 'knowledge.json'),
    config: path.join(DATA_DIR, 'config.json'),
    leads: path.join(DATA_DIR, 'leads.json'),
    history: path.join(DATA_DIR, 'history.json'),
    bot_status: path.join(DATA_DIR, 'bot_status.json'),
    tags: path.join(DATA_DIR, 'tags.json')
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
// 📩 MOTOR DE ENVÍO (TEXTO / IMAGEN / DOC)
// ============================================================
async function enviarWhatsApp(destinatario, contenido, tipo = "text") {
    try {
        let payload = { messaging_product: "whatsapp", to: destinatario, type: tipo };
        if (tipo === "text") payload.text = { body: contenido };
        else if (tipo === "image") payload.image = { link: contenido };
        else if (tipo === "document") payload.document = { link: contenido, filename: "Archivo_ICC.pdf" };

        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, payload, { 
            headers: { 'Authorization': `Bearer ${META_TOKEN}` } 
        });
        return true;
    } catch (e) { 
        console.error("Error envío WhatsApp:", e.response?.data || e.message);
        return false;
    }
}

// ============================================================
// 🧠 CEREBRO LORENA (GEMINI 2.0 + LEADS + TAGS)
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

async function procesarConLorena(message, sessionId, mediaDesc = "") {
    const botStatus = readData(FILES.bot_status, {});
    let allHistory = readData(FILES.history, {});
    
    // Si el bot está apagado para este chat, solo guardamos lo que llega
    if (botStatus[sessionId] === false) {
        if (!allHistory[sessionId]) allHistory[sessionId] = [];
        allHistory[sessionId].push({ role: 'user', text: mediaDesc || message, time: new Date().toISOString() });
        writeData(FILES.history, allHistory);
        return null; 
    }

    const config = readData(FILES.config, {});
    const chatPrevio = (allHistory[sessionId] || []).slice(-10);
    const stock = buscarEnCatalogo(message);

    const prompt = `Eres Lorena de ICC. Vende repuestos Caterpillar/Komatsu.
    PERSONALIDAD: ${config.tech_rules || 'Profesional'}
    INFO WEB: ${config.website_data || ''}
    STOCK DISPONIBLE: ${JSON.stringify(stock)}
    HISTORIAL: ${JSON.stringify(chatPrevio)}
    
    INSTRUCCIÓN: Responde amable y cierra con pregunta. 
    AL FINAL añade: [DATA] {"es_lead":Boolean, "nombre":"...", "interes":"...", "etiqueta":"lead_caliente"|"duda_tecnica"|"curioso"} [DATA]`;

    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] });

        let fullText = res.data.candidates[0].content.parts[0].text;
        let textoVisible = fullText.split('[DATA]')[0].trim();
        
        // Procesar metadatos de la IA
        if (fullText.includes('[DATA]')) {
            try {
                const info = JSON.parse(fullText.split('[DATA]')[1].trim());
                if(info.es_lead) {
                    const leads = readData(FILES.leads, []);
                    leads.push({ ...info, fecha: new Date().toLocaleString(), telefono: sessionId });
                    writeData(FILES.leads, leads);
                }
                const tags = readData(FILES.tags, {});
                tags[sessionId] = info.etiqueta || "lead";
                writeData(FILES.tags, tags);
            } catch(e) {}
        }

        // Guardar historial
        if (!allHistory[sessionId]) allHistory[sessionId] = [];
        allHistory[sessionId].push({ role: 'user', text: mediaDesc || message, time: new Date().toISOString() });
        allHistory[sessionId].push({ role: 'bot', text: textoVisible, time: new Date().toISOString() });
        writeData(FILES.history, allHistory);

        return textoVisible;
    } catch (err) { return "Lorena ICC: Tuvimos un pequeño error, ¿me repites?"; }
}

// ============================================================
// 🚦 WEBHOOK (DETECCIÓN MULTIMEDIA)
// ============================================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === 'ICC_2025') return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        res.sendStatus(200);
        const entry = body.entry?.[0]?.changes?.[0]?.value;
        const msg = entry?.messages?.[0];
        if (msg) {
            let texto = msg.text ? msg.text.body : "";
            let desc = msg.image ? "📷 [Imagen recibida]" : msg.document ? "📄 [Documento recibido]" : "";
            const r = await procesarConLorena(texto || desc, msg.from, desc);
            if (r) await enviarWhatsApp(msg.from, r);
        }
    } else { res.sendStatus(200); }
});

// ============================================================
// ⚙️ APIS PANEL (CRUD Y GESTIÓN)
// ============================================================
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No autorizado");

// 🆕 Borrar Chat (WhatsApp Style)
app.post('/api/chat/delete', proteger, (req, res) => {
    const { phone } = req.body;
    let h = readData(FILES.history, {});
    let t = readData(FILES.tags, {});
    delete h[phone]; delete t[phone];
    writeData(FILES.history, h); writeData(FILES.tags, t);
    res.json({ success: true });
});

// 🆕 Enviar Multimedia Manual
app.post('/api/chat/send-media', proteger, async (req, res) => {
    const { phone, url, type } = req.body;
    if (await enviarWhatsApp(phone, url, type)) {
        let h = readData(FILES.history, {});
        if (!h[phone]) h[phone] = [];
        h[phone].push({ role: 'manual', text: `📎 [Enviado ${type}]: ${url}`, time: new Date().toISOString() });
        writeData(FILES.history, h);
        res.json({ success: true });
    } else { res.status(500).send("Error"); }
});

// 🆕 Sincronizar Info Web
app.post('/save-website', proteger, (req, res) => {
    const config = readData(FILES.config, {});
    config.website_data = req.body.urlData;
    writeData(FILES.config, config);
    res.json({ success: true });
});

// 🆕 Borrar Producto Individual
app.post('/api/knowledge/delete', proteger, (req, res) => {
    globalKnowledge.splice(req.body.index, 1);
    writeData(FILES.knowledge, globalKnowledge);
    res.json({ success: true });
});

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
    if (await enviarWhatsApp(phone, message)) {
        let h = readData(FILES.history, {});
        if (!h[phone]) h[phone] = [];
        h[phone].push({ role: 'manual', text: message, time: new Date().toISOString() });
        writeData(FILES.history, h);
        res.json({ success: true });
    } else { res.status(500).json({ error: "No enviado" }); }
});

app.post('/api/chat/toggle-bot', proteger, (req, res) => {
    let s = readData(FILES.bot_status, {});
    s[req.body.phone] = req.body.active;
    writeData(FILES.bot_status, s);
    res.json({ success: true });
});

app.get('/api/data/:type', proteger, (req, res) => {
    const type = req.params.type;
    const fallback = (type==='history'||type==='tags'||type==='bot_status') ? {} : [];
    res.json(readData(FILES[type], fallback));
});

// 🔄 Acumulación de CSV
app.post('/api/knowledge/csv', proteger, upload.single('file'), (req, res) => {
    try {
        const newRecords = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true });
        const formattedNew = newRecords.map(r => ({ searchable: Object.values(r).join(" "), data: r }));
        const currentData = readData(FILES.knowledge, []);
        const combined = [...currentData, ...formattedNew];
        // Quitar duplicados
        globalKnowledge = Array.from(new Set(combined.map(a => a.searchable))).map(s => combined.find(a => a.searchable === s));
        writeData(FILES.knowledge, globalKnowledge);
        res.json({ success: true, count: globalKnowledge.length });
    } catch (e) { res.status(500).send("CSV Error"); }
});

app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.listen(process.env.PORT || 10000, () => console.log("🚀 LORENA ICC ACTIVADA"));
