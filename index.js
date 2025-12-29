const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');
const cors = require('cors');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

app.set('trust proxy', 1);

// ============================================================
// 🔐 VARIABLES DE ENTORNO
// ============================================================
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-ultra-secret-2025";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// 🛡️ SEGURIDAD DE ARCHIVOS
app.use((req, res, next) => {
    if ((req.path.endsWith('.json') || req.path.includes('/data/')) && !req.path.startsWith('/api/')) {
        return res.status(403).send('Acceso Prohibido');
    }
    next();
});

// ============================================================
// 📂 GESTIÓN DE DATOS
// ============================================================
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    knowledge: path.join(DATA_DIR, 'knowledge.json'),
    config: path.join(DATA_DIR, 'config.json'),
    leads: path.join(DATA_DIR, 'leads.json'),
    history: path.join(DATA_DIR, 'history.json'),
    bot_status: path.join(DATA_DIR, 'bot_status.json'),
    tags: path.join(DATA_DIR, 'tags.json'),
    metadata: path.join(DATA_DIR, 'metadata.json')
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
    name: 'icc_session', secret: SESSION_SECRET, resave: true, saveUninitialized: true,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

let globalKnowledge = readData(FILES.knowledge, []);

// ============================================================
// 📩 WHATSAPP SEND
// ============================================================
async function enviarWhatsApp(destinatario, contenido, tipo = "text") {
    try {
        let payload = { messaging_product: "whatsapp", to: destinatario, type: tipo };
        if (tipo === "text") payload.text = { body: contenido };
        else if (tipo === "image") payload.image = { link: contenido };
        else if (tipo === "document") payload.document = { link: contenido, filename: "Adjunto_ICC.pdf" };

        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, payload, { 
            headers: { 'Authorization': `Bearer ${META_TOKEN}` } 
        });
        return true;
    } catch (e) { return false; }
}

// ============================================================
// 🧠 CEREBRO LORENA (REGEX + LEADS FIXED)
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
    
    // 1. Guardar mensaje User
    let currentHistory = readData(FILES.history, {});
    if (!currentHistory[sessionId]) currentHistory[sessionId] = [];
    currentHistory[sessionId].push({ role: 'user', text: mediaDesc || message, time: new Date().toISOString() });
    writeData(FILES.history, currentHistory);

    if (botStatus[sessionId] === false) return null;

    const config = readData(FILES.config, {});
    const chatPrevio = (currentHistory[sessionId] || []).slice(-10);
    const stock = buscarEnCatalogo(message);

    const prompt = `
    ${config.prompt || "Eres Lorena de ICC."}
    CONTEXTO: ${config.tech_rules || ""}
    WEB: ${config.website_data || ''}
    STOCK: ${JSON.stringify(stock)}
    
    SI DETECTAS OPORTUNIDAD DE VENTA O DATOS DE CONTACTO, FINALIZA TU RESPUESTA CON:
    [DATA]
    { "es_lead": true, "nombre": "...", "interes": "...", "etiqueta": "lead_caliente" }
    [DATA]
    `;

    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt + `\nHISTORIAL: ${JSON.stringify(chatPrevio)}\nUSER: ${message}` }] }] });

        let fullText = res.data.candidates[0].content.parts[0].text;
        let textoVisible = fullText;

        // --- EXTRACCIÓN ROBUSTA DE LEADS ---
        const regexData = /\[DATA\]([\s\S]*?)\[DATA\]/;
        const match = fullText.match(regexData);

        if (match && match[1]) {
            textoVisible = fullText.replace(regexData, "").trim();
            try {
                const jsonClean = match[1].replace(/```json|```/g, "").trim();
                const info = JSON.parse(jsonClean);
                if(info.es_lead) {
                    const leads = readData(FILES.leads, []);
                    const yaExiste = leads.some(l => l.telefono === sessionId && new Date(l.fecha).toDateString() === new Date().toDateString());
                    if (!yaExiste) {
                        leads.push({ ...info, fecha: new Date().toLocaleString(), telefono: sessionId });
                        writeData(FILES.leads, leads);
                    }
                }
                if(info.etiqueta) {
                    const metadata = readData(FILES.metadata, {});
                    if(!metadata[sessionId]) metadata[sessionId] = {};
                    metadata[sessionId].labels = [info.etiqueta]; 
                    writeData(FILES.metadata, metadata);
                }
            } catch(e) {}
        }

        // 2. Guardar Bot
        let freshHistory = readData(FILES.history, {});
        if (!freshHistory[sessionId]) freshHistory[sessionId] = [];
        freshHistory[sessionId].push({ role: 'bot', text: textoVisible, time: new Date().toISOString() });
        writeData(FILES.history, freshHistory);

        return textoVisible;
    } catch (err) { return "Un momento, revisando sistema..."; }
}

// ============================================================
// 🚦 WEBHOOK
// ============================================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === 'ICC_2025') return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200); 
    try {
        const entry = req.body.entry?.[0]?.changes?.[0]?.value;
        const msg = entry?.messages?.[0];
        if (msg) {
            let texto = msg.text ? msg.text.body : (msg.image ? "📷 [Imagen]" : (msg.document ? "📄 [Doc]" : ""));
            const from = msg.from;
            const respuesta = await procesarConLorena(texto, from);
            if (respuesta) await enviarWhatsApp(from, respuesta);
        }
    } catch (e) {}
});

// ============================================================
// ⚙️ API PANEL (DASHBOARD & FRONTEND)
// ============================================================
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No autorizado");

app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isLogged = true;
        return req.session.save(() => res.json({ success: true }));
    }
    res.status(401).json({ success: false });
});

// ✅ CORRECCIÓN DASHBOARD: Fallback inteligente para no romper el front
app.get('/api/data/:type', proteger, (req, res) => {
    const t = req.params.type;
    if (!FILES[t]) return res.status(404).json({});
    
    // Si es Historial, Config, BotStatus o Metadata -> Objeto {}
    // Si es Leads o Knowledge -> Array []
    const isObject = ['history', 'config', 'bot_status', 'metadata', 'tags'].includes(t);
    res.json(readData(FILES[t], isObject ? {} : [])); 
});

// 2. CHATS MERGEADOS CON CONTACTOS
app.get('/api/chats-full', proteger, (req, res) => {
    const history = readData(FILES.history, {});
    const metadata = readData(FILES.metadata, {}); 
    const botStatus = readData(FILES.bot_status, {});
    
    const allPhones = new Set([...Object.keys(history), ...Object.keys(metadata)]);
    
    const chatList = Array.from(allPhones).map(phone => {
        const msgs = history[phone] || [];
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : { text: "Nuevo contacto", time: new Date().toISOString() };
        const meta = metadata[phone] || {};
        
        return {
            id: phone,
            name: meta.contactName || phone, 
            lastMessage: lastMsg,
            botActive: botStatus[phone] !== false,
            pinned: meta.pinned || false,
            labels: meta.labels || [],
            muted: meta.muted || false,
            timestamp: lastMsg.time 
        };
    });

    chatList.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.timestamp) - new Date(a.timestamp);
    });

    res.json(chatList);
});

// 3. AGREGAR CONTACTO CORPORATIVO
app.post('/api/contacts/add', proteger, (req, res) => {
    const { phone, name } = req.body;
    const metadata = readData(FILES.metadata, {});
    
    if(!metadata[phone]) metadata[phone] = {};
    metadata[phone].contactName = name;
    metadata[phone].addedManual = true;
    
    writeData(FILES.metadata, metadata);
    res.json({ success: true });
});

// 4. ACCIONES Y BOT
app.post('/api/chat/action', proteger, (req, res) => {
    const { phone, action, value } = req.body; 
    const metadata = readData(FILES.metadata, {});
    if (!metadata[phone]) metadata[phone] = {};

    if (action === 'pin') metadata[phone].pinned = value;
    else if (action === 'mute') metadata[phone].muted = value;
    else if (action === 'label') metadata[phone].labels = value;
    else if (action === 'delete') {
        let h = readData(FILES.history, {});
        delete h[phone]; delete metadata[phone];
        writeData(FILES.history, h); writeData(FILES.metadata, metadata);
        return res.json({ success: true });
    }
    writeData(FILES.metadata, metadata);
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

// 5. CONFIGURACIÓN (SOBRESCRITURA CORRECTA)
app.post('/api/save-config', proteger, (req, res) => {
    let config = readData(FILES.config, {});
    const { prompt, tech_rules } = req.body;
    
    if (prompt !== undefined) config.prompt = prompt;
    if (tech_rules !== undefined) config.tech_rules = tech_rules;
    
    writeData(FILES.config, config);
    res.json({ success: true });
});

app.post('/api/test-ai', proteger, async (req, res) => {
    const { message, context } = req.body;
    try {
        const config = readData(FILES.config, {});
        const fullPrompt = `${config.prompt || ""} \nCTX: ${context || ""} \nUser: "${message}"`;
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] });
        res.json({ response: r.data.candidates[0].content.parts[0].text, logic_log: fullPrompt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. INVENTARIO
app.post('/api/knowledge/csv', proteger, upload.single('file'), (req, res) => {
    try {
        const newRecords = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true });
        const formattedNew = newRecords.map(r => ({ searchable: Object.values(r).join(" "), data: r }));
        const currentData = readData(FILES.knowledge, []);
        const combined = [...currentData, ...formattedNew];
        globalKnowledge = Array.from(new Set(combined.map(a => a.searchable))).map(s => combined.find(a => a.searchable === s));
        writeData(FILES.knowledge, globalKnowledge);
        res.json({ success: true, count: globalKnowledge.length });
    } catch (e) { res.status(500).send("CSV Error"); }
});

app.post('/api/knowledge/delete', proteger, (req, res) => {
    globalKnowledge.splice(req.body.index, 1);
    writeData(FILES.knowledge, globalKnowledge);
    res.json({ success: true });
});

// ============================================================
// 🔒 RUTAS DE SEGURIDAD (ANTI-BYPASS) - ¡AQUÍ ESTÁ EL FIX!
// ============================================================

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('icc_session');
        res.redirect('/login');
    });
});

app.get('/login', (req, res) => {
    if (req.session.isLogged) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/', (req, res) => {
    if (!req.session.isLogged) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Evita que entren directo a index.html
app.get('/index.html', (req, res) => {
    if (!req.session.isLogged) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// IMPORTANTE: { index: false } evita servir index.html automáticamente
app.use(express.static(__dirname, { index: false }));

app.listen(process.env.PORT || 10000, () => console.log("🚀 LORENA 5.2 - SECURE & DASHBOARD FIX"));
