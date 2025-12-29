const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data'); 

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

app.set('trust proxy', 1);

// ============================================================
// 1. VARIABLES DE ENTORNO
// ============================================================
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-secret-rules-v6-2";

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
// 2. GESTIÓN DE DATOS
// ============================================================
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    knowledge: path.join(DATA_DIR, 'knowledge.json'),
    config: path.join(DATA_DIR, 'config.json'),
    leads: path.join(DATA_DIR, 'leads.json'),
    history: path.join(DATA_DIR, 'history.json'),
    bot_status: path.join(DATA_DIR, 'bot_status.json'),
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
// 3. WHATSAPP ENGINE (MEDIA + TEXTO)
// ============================================================
async function enviarWhatsApp(destinatario, contenido, tipo = "text") {
    try {
        let payload = { messaging_product: "whatsapp", to: destinatario, type: tipo };
        
        if (tipo === "text") {
            payload.text = { body: contenido };
        } 
        else if (contenido.id) { 
            if(tipo === 'image') payload.image = { id: contenido.id };
            if(tipo === 'document') payload.document = { id: contenido.id, filename: "Archivo_ICC.pdf" };
            if(tipo === 'audio') payload.audio = { id: contenido.id };
        }
        else {
            if(tipo === 'image') payload.image = { link: contenido };
            if(tipo === 'document') payload.document = { link: contenido };
        }

        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, payload, { 
            headers: { 'Authorization': `Bearer ${META_TOKEN}` } 
        });
        return true;
    } catch (e) { return false; }
}

async function uploadToMeta(buffer, mimeType, filename) {
    try {
        const form = new FormData();
        form.append('file', buffer, { filename: filename, contentType: mimeType });
        form.append('type', mimeType.includes('image') ? 'image' : (mimeType.includes('pdf') ? 'document' : 'audio'));
        form.append('messaging_product', 'whatsapp');

        const response = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, form, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}`, ...form.getHeaders() }
        });
        return response.data.id;
    } catch (error) { return null; }
}

// ============================================================
// 4. IA LORENA (LÓGICA MEJORADA DE REGLAS)
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
    let currentHistory = readData(FILES.history, {});
    if (!currentHistory[sessionId]) currentHistory[sessionId] = [];
    currentHistory[sessionId].push({ role: 'user', text: mediaDesc || message, time: new Date().toISOString() });
    writeData(FILES.history, currentHistory);

    if (botStatus[sessionId] === false) return null;

    const config = readData(FILES.config, {});
    const chatPrevio = (currentHistory[sessionId] || []).slice(-10);
    const stock = buscarEnCatalogo(message);

    // ✅ AQUÍ ESTÁ LA MAGIA: Convertimos la lista de reglas en texto para la IA
    let reglasTexto = "";
    if (Array.isArray(config.tech_rules)) {
        reglasTexto = config.tech_rules.map(r => `- ${r}`).join("\n");
    } else {
        reglasTexto = config.tech_rules || "Sin reglas definidas.";
    }

    const prompt = `
    PERSONALIDAD: ${config.prompt || "Eres Lorena, asistente de ICC."}
    
    REGLAS DE NEGOCIO OBLIGATORIAS:
    ${reglasTexto}
    
    DATOS WEB: ${config.website_data || ""}
    INVENTARIO: ${JSON.stringify(stock)}
    
    SI DETECTAS LEAD O VENTA, FINALIZA CON:
    [DATA]
    { "es_lead": true, "nombre": "...", "interes": "...", "etiqueta": "lead_caliente" }
    [DATA]
    `;

    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt + `\nHISTORIAL: ${JSON.stringify(chatPrevio)}\nUSUARIO: ${message}` }] }] });

        let fullText = res.data.candidates[0].content.parts[0].text;
        let textoVisible = fullText;

        const regexData = /\[DATA\]([\s\S]*?)\[DATA\]/;
        const match = fullText.match(regexData);

        if (match && match[1]) {
            textoVisible = fullText.replace(regexData, "").trim();
            try {
                const info = JSON.parse(match[1].replace(/```json|```/g, "").trim());
                if(info.es_lead) {
                    const leads = readData(FILES.leads, []);
                    if (!leads.some(l => l.telefono === sessionId && new Date(l.fecha).toDateString() === new Date().toDateString())) {
                        leads.push({ ...info, fecha: new Date().toLocaleString(), telefono: sessionId });
                        writeData(FILES.leads, leads);
                    }
                }
                if(info.etiqueta) {
                    const metadata = readData(FILES.metadata, {});
                    if(!metadata[sessionId]) metadata[sessionId] = {};
                    if(!metadata[sessionId].labels) metadata[sessionId].labels = [];
                    if(!metadata[sessionId].labels.includes(info.etiqueta)) {
                        metadata[sessionId].labels.push(info.etiqueta);
                        writeData(FILES.metadata, metadata);
                    }
                }
            } catch(e) {}
        }

        let freshHistory = readData(FILES.history, {});
        if (!freshHistory[sessionId]) freshHistory[sessionId] = [];
        freshHistory[sessionId].push({ role: 'bot', text: textoVisible, time: new Date().toISOString() });
        writeData(FILES.history, freshHistory);

        return textoVisible;
    } catch (err) { return "Dame un momento..."; }
}

// ============================================================
// 5. API ENDPOINTS 
// ============================================================
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No autorizado");

app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isLogged = true;
        req.session.save(() => res.json({ success: true }));
    } else res.status(401).json({ success: false });
});

// GET DATOS (Incluyendo las reglas como array)
app.get('/api/data/:type', proteger, (req, res) => {
    const t = req.params.type;
    if (!FILES[t]) return res.status(404).json({});
    
    let data = readData(FILES[t], []);
    
    // Si piden config, aseguramos que tech_rules sea array para que el Front no falle
    if (t === 'config') {
        if (!data.tech_rules) data.tech_rules = [];
        if (typeof data.tech_rules === 'string') data.tech_rules = [data.tech_rules]; // Migración automática
    }

    res.json(data);
});

// NUEVO: GESTIÓN DE REGLAS (AGREGAR / BORRAR)
app.post('/api/config/rules/add', proteger, (req, res) => {
    const { rule } = req.body;
    let config = readData(FILES.config, {});
    
    if (!Array.isArray(config.tech_rules)) config.tech_rules = []; // Asegurar Array
    
    // Agregamos la nueva regla
    config.tech_rules.push(rule);
    
    writeData(FILES.config, config);
    res.json({ success: true, rules: config.tech_rules });
});

app.post('/api/config/rules/delete', proteger, (req, res) => {
    const { index } = req.body;
    let config = readData(FILES.config, {});
    
    if (Array.isArray(config.tech_rules)) {
        config.tech_rules.splice(index, 1); // Borramos por índice
        writeData(FILES.config, config);
    }
    
    res.json({ success: true, rules: config.tech_rules });
});

// Guardar Personalidad y Web (Por separado)
app.post('/api/save-prompt-web', proteger, (req, res) => {
    let config = readData(FILES.config, {});
    if (req.body.prompt !== undefined) config.prompt = req.body.prompt;
    if (req.body.website_data !== undefined) config.website_data = req.body.website_data;
    
    writeData(FILES.config, config);
    res.json({ success: true });
});

// Test AI
app.post('/api/test-ai', proteger, async (req, res) => {
    try {
        const c = readData(FILES.config, {});
        // Simulamos el prompt igual que en producción
        let reglasTexto = Array.isArray(c.tech_rules) ? c.tech_rules.join("\n") : c.tech_rules;
        
        const fullPrompt = `PERSONALIDAD: ${c.prompt}\nREGLAS: ${reglasTexto}\nWEB: ${c.website_data}\nUSER: "${req.body.message}"`;
        
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] });
        res.json({ response: r.data.candidates[0].content.parts[0].text, logic_log: fullPrompt });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Media Upload
app.post('/api/chat/upload-send', proteger, upload.single('file'), async (req, res) => {
    try {
        const { phone, type } = req.body;
        const file = req.file;
        if (!file || !phone) return res.status(400).json({ error: "Datos faltantes" });
        const metaId = await uploadToMeta(file.buffer, file.mimetype, file.originalname);
        if (!metaId) return res.status(500).json({ error: "Error en Meta" });
        const enviado = await enviarWhatsApp(phone, { id: metaId }, type);
        if (enviado) {
            let h = readData(FILES.history, {});
            if (!h[phone]) h[phone] = [];
            let icon = type === 'audio' ? '🎤 [Audio]' : (type === 'image' ? '📷 [Imagen]' : '📄 [Archivo]');
            h[phone].push({ role: 'manual', text: icon, time: new Date().toISOString() });
            writeData(FILES.history, h);
            res.json({ success: true });
        } else res.status(500).json({ error: "Error enviando" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Chat Management
app.get('/api/chats-full', proteger, (req, res) => {
    const history = readData(FILES.history, {});
    const metadata = readData(FILES.metadata, {});
    const botStatus = readData(FILES.bot_status, {});
    const list = Array.from(new Set([...Object.keys(history), ...Object.keys(metadata)])).map(id => {
        const msgs = history[id] || [];
        const meta = metadata[id] || {};
        return {
            id,
            name: meta.contactName || id,
            lastMessage: msgs.length > 0 ? msgs[msgs.length - 1] : { text: "Nuevo", time: new Date().toISOString() },
            botActive: botStatus[id] !== false,
            pinned: meta.pinned || false,
            labels: meta.labels || [],
            timestamp: msgs.length > 0 ? msgs[msgs.length - 1].time : new Date().toISOString()
        };
    }).sort((a,b) => (a.pinned === b.pinned) ? new Date(b.timestamp) - new Date(a.timestamp) : (a.pinned ? -1 : 1));
    res.json(list);
});

app.post('/api/contacts/add', proteger, (req, res) => {
    let m = readData(FILES.metadata, {});
    if(!m[req.body.phone]) m[req.body.phone] = {};
    m[req.body.phone].contactName = req.body.name;
    writeData(FILES.metadata, m);
    res.json({ success: true });
});

app.post('/api/chat/action', proteger, (req, res) => {
    const { phone, action, value } = req.body;
    let m = readData(FILES.metadata, {});
    if(!m[phone]) m[phone] = {};
    if(action === 'pin') m[phone].pinned = value;
    if(action === 'label') m[phone].labels = value;
    if(action === 'delete') {
        let h = readData(FILES.history, {});
        delete h[phone]; delete m[phone];
        writeData(FILES.history, h);
    }
    writeData(FILES.metadata, m);
    res.json({ success: true });
});

app.post('/api/chat/send', proteger, async (req, res) => {
    if(await enviarWhatsApp(req.body.phone, req.body.message)) {
        let h = readData(FILES.history, {});
        if(!h[req.body.phone]) h[req.body.phone] = [];
        h[req.body.phone].push({ role: 'manual', text: req.body.message, time: new Date().toISOString() });
        writeData(FILES.history, h);
        res.json({ success: true });
    } else res.status(500).json({ error: "Error" });
});

app.post('/api/chat/toggle-bot', proteger, (req, res) => {
    let s = readData(FILES.bot_status, {});
    s[req.body.phone] = req.body.active;
    writeData(FILES.bot_status, s);
    res.json({ success: true });
});

app.post('/api/knowledge/csv', proteger, upload.single('file'), (req, res) => {
    try {
        const n = parse(req.file.buffer.toString('utf-8'), { columns: true });
        let k = readData(FILES.knowledge, []);
        k = [...k, ...n.map(r => ({ searchable: Object.values(r).join(" "), data: r }))];
        let unique = Array.from(new Set(k.map(a => a.searchable))).map(s => k.find(a => a.searchable === s));
        writeData(FILES.knowledge, unique);
        globalKnowledge = unique;
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "CSV Error" }); }
});

app.post('/api/knowledge/delete', proteger, (req, res) => {
    let k = readData(FILES.knowledge, []);
    k.splice(req.body.index, 1);
    writeData(FILES.knowledge, k);
    globalKnowledge = k;
    res.json({ success: true });
});

app.get('/webhook', (req, res) => (req.query['hub.verify_token'] === 'ICC_2025' ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if(msg) {
            let txt = msg.text?.body || (msg.image ? "📷 Foto" : (msg.audio ? "🎤 Audio" : "Archivo"));
            let r = await procesarConLorena(txt, msg.from);
            if(r) await enviarWhatsApp(msg.from, r);
        }
    } catch(e) {}
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => req.session.isLogged ? res.redirect('/') : res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.get('/index.html', (req, res) => res.redirect('/'));
app.use(express.static(__dirname, { index: false }));

app.listen(process.env.PORT || 10000, () => console.log("🚀 LORENA 6.2 - RULES ENGINE READY"));
