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
// 🔐 CONFIGURACIÓN Y VARIABLES
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

// 🛡️ SEGURIDAD DE RUTAS
app.use((req, res, next) => {
    // Protege archivos JSON directos, pero permite acceso a las rutas API que definimos abajo
    if ((req.path.endsWith('.json') || req.path.includes('/data/')) && !req.path.startsWith('/api/')) {
        return res.status(403).send('Acceso Prohibido');
    }
    next();
});

// ============================================================
// 📂 GESTIÓN DE DATOS (FILE SYSTEM)
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

// SESIONES
app.use(session({
    name: 'icc_session',
    secret: SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 } // 24 horas
}));

let globalKnowledge = readData(FILES.knowledge, []);

// ============================================================
// 📩 MOTOR DE ENVÍO WHATSAPP
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
    } catch (e) { 
        console.error("Error envío WhatsApp:", e.response?.data || e.message);
        return false;
    }
}

// ============================================================
// 🧠 CEREBRO LORENA (CORREGIDO)
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
    
    REGLAS TÉCNICAS: ${config.tech_rules || "Sé profesional."}
    INFO WEB: ${config.website_data || ''}
    STOCK DISPONIBLE: ${JSON.stringify(stock)}
    HISTORIAL: ${JSON.stringify(chatPrevio)}
    
    INSTRUCCIÓN: Responde corto y natural. Si es venta, usa [DATA].
    `;

    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt + `\nMENSAJE USUARIO: ${message}` }] }] });

        let fullText = res.data.candidates[0].content.parts[0].text;
        let textoVisible = fullText.split('[DATA]')[0].trim();
        
        // Procesar Leads
        if (fullText.includes('[DATA]')) {
            try {
                const jsonStr = fullText.split('[DATA]')[1].replace(/```json|```/g, "").trim();
                const info = JSON.parse(jsonStr);
                if(info.es_lead) {
                    const leads = readData(FILES.leads, []);
                    leads.push({ ...info, fecha: new Date().toLocaleString(), telefono: sessionId });
                    writeData(FILES.leads, leads);
                }
                if(info.etiqueta) {
                    const metadata = readData(FILES.metadata, {});
                    if(!metadata[sessionId]) metadata[sessionId] = {};
                    metadata[sessionId].labels = [info.etiqueta]; 
                    writeData(FILES.metadata, metadata);
                }
            } catch(e) { console.error("Error parsing DATA json", e); }
        }

        // 2. Guardar mensaje Bot (Releyendo historial por si acaso)
        let freshHistory = readData(FILES.history, {});
        if (!freshHistory[sessionId]) freshHistory[sessionId] = [];
        freshHistory[sessionId].push({ role: 'bot', text: textoVisible, time: new Date().toISOString() });
        writeData(FILES.history, freshHistory);

        return textoVisible;
    } catch (err) { 
        console.error(err);
        return "Lorena ICC: Dame un momento, estoy consultando..."; 
    }
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
        const body = req.body;
        const entry = body.entry?.[0]?.changes?.[0]?.value;
        const msg = entry?.messages?.[0];
        if (msg) {
            let texto = msg.text ? msg.text.body : "";
            let desc = msg.image ? "📷 [Imagen]" : msg.document ? "📄 [Documento]" : "";
            const from = msg.from;
            const respuesta = await procesarConLorena(texto || desc, from, desc);
            if (respuesta) await enviarWhatsApp(from, respuesta);
        }
    } catch (e) { console.error("Error Webhook:", e); }
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

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('icc_session');
        res.redirect('/login');
    });
});

// ✅ RUTA NUEVA: Esta faltaba para que funcione el Dashboard y el Inventario
app.get('/api/data/:type', proteger, (req, res) => {
    const type = req.params.type;
    // Mapeo seguro para saber qué archivos se pueden leer
    if (!FILES[type]) return res.status(404).json({ error: "Data type not found" });
    
    // Si es tipo 'history' devuelve objeto {}, si es lista (leads/knowledge) devuelve []
    const fallback = (type === 'history' || type === 'tags' || type === 'bot_status' || type === 'metadata' || type === 'config') ? {} : [];
    
    res.json(readData(FILES[type], fallback));
});

// 2. CHATS LIST (Sidebar)
app.get('/api/chats-full', proteger, (req, res) => {
    const history = readData(FILES.history, {});
    const metadata = readData(FILES.metadata, {}); 
    const botStatus = readData(FILES.bot_status, {});
    
    const chatList = Object.keys(history).map(phone => {
        const msgs = history[phone];
        const lastMsg = msgs[msgs.length - 1] || {};
        const meta = metadata[phone] || { pinned: false, labels: [], muted: false };
        
        return {
            id: phone,
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

// 3. ACCIONES DE CHAT
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
        writeData(FILES.history, h);
        writeData(FILES.metadata, metadata);
        return res.json({ success: true, deleted: true });
    }
    writeData(FILES.metadata, metadata);
    res.json({ success: true });
});

// 4. ENVÍOS Y BOT
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

// 5. CONFIG Y PRUEBAS IA
app.get('/api/config', proteger, (req, res) => {
    res.json(readData(FILES.config, { prompt: "", tech_rules: "", website_data: "" }));
});

app.post('/api/save-config', proteger, (req, res) => {
    const { prompt, tech_rules, website_data } = req.body;
    const config = readData(FILES.config, {});
    
    if (prompt !== undefined) config.prompt = prompt;
    if (tech_rules !== undefined) config.tech_rules = tech_rules;
    
    writeData(FILES.config, config);
    res.json({ success: true });
});

// ✅ CORREGIDO: Ahora devuelve 'logic_log' para ver qué piensa el bot
app.post('/api/test-ai', proteger, async (req, res) => {
    const { message, context } = req.body;
    try {
        const config = readData(FILES.config, {});
        // Guardamos el prompt real para mostrarlo en el frontend
        const fullPrompt = `
        ${config.prompt || ""}
        CONTEXTO DE PRUEBA: ${context || config.tech_rules || ""}
        Responde al mensaje: "${message}"
        `;
        
        const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] });
            
        res.json({ 
            response: response.data.candidates[0].content.parts[0].text,
            logic_log: fullPrompt // ¡Esto es lo que faltaba!
        });
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

// STATIC
app.use(express.static(__dirname));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.listen(process.env.PORT || 10000, () => console.log("🚀 LORENA ICC 4.5 - FULLY CONNECTED"));
