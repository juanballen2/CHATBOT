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

// ============================================================
// 🔑 CONFIGURACIÓN Y SEGURIDAD (Render & Meta)
// ============================================================
app.set('trust proxy', 1); 

const API_KEY = "AIzaSyACJytpDnPzl9y5FeoQ5sx8m-iyhPXINto"; 
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = process.env.SESSION_SECRET || "icc-ultra-secret-2025";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN; // Usa el System User Token (Permanente)
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "ICC_2025";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: true, 
        sameSite: 'lax',
        maxAge: 3600000 * 8 
    }
}));

// ============================================================
// 📂 GESTIÓN DE DATOS (Persistencia Local)
// ============================================================
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    knowledge: path.join(DATA_DIR, 'knowledge.json'),
    config: path.join(DATA_DIR, 'config.json'),
    leads: path.join(DATA_DIR, 'leads.json'),
    history: path.join(DATA_DIR, 'history.json')
};

let globalKnowledge = [];

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

const normalizarParaBusqueda = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[-.\s]/g, "").trim() : "";

// ============================================================
// 🤖 LÓGICA DE LORENA (RAG + MEMORIA + LEADS)
// ============================================================
async function enviarWhatsApp(phoneId, to, text) {
    if (!META_ACCESS_TOKEN) return console.log("⚠️ Sin Token de Meta.");
    try {
        await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
            messaging_product: "whatsapp", to, type: "text", text: { body: text }
        }, { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` } });
    } catch (e) { console.error("❌ Error WhatsApp:", e.message); }
}

async function procesarConLorena(message, sessionId = 'tester') {
    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});
    const queryNorm = normalizarParaBusqueda(message);
    
    // 1. MEMORIA: Recuperar últimos 6 mensajes
    const historialLimpio = (allHistory[sessionId] || [])
        .map(m => `${m.role === 'user' ? 'Cliente' : 'Lorena'}: ${m.text}`)
        .slice(-6).join('\n');

    // 2. CONOCIMIENTO: Búsqueda en catálogo
    const coincidencias = globalKnowledge.map(item => ({
        ...item, score: normalizarParaBusqueda(item.searchable).includes(queryNorm) ? 100 : 0
    })).filter(i => i.score > 0).slice(0, 5);

    const prompt = `
    ${config.prompt || "Eres Lorena de ICC, asesora experta en maquinaria y repuestos."}
    REGLAS: ${config.tech_rules || "Hablar siempre de Usted. No repetir saludos."}
    
    HISTORIAL DE CONVERSACIÓN:
    ${historialLimpio}

    STOCK DISPONIBLE:
    ${JSON.stringify(coincidencias)}

    INSTRUCCIÓN DE LEADS: Si detectas Nombre, Ciudad o Interés, genera: 
    [DATA] {"es_lead": true, "nombre": "...", "telefono": "${sessionId}", "ciudad": "...", "interes": "..."} [DATA]

    MENSAJE ACTUAL DEL CLIENTE: "${message}"`;

    return new Promise((resolve) => {
        const payload = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            method: 'POST', headers: { 'Content-Type': 'application/json' }
        };
        const reqGoogle = https.request(options, (resG) => {
            let body = '';
            resG.on('data', d => body += d);
            resG.on('end', () => {
                try {
                    const fullReply = JSON.parse(body).candidates[0].content.parts[0].text;
                    const partes = fullReply.split('[DATA]');
                    const textoBot = partes[0].trim();
                    const dataPart = partes[1];

                    // Actualizar Historial
                    if (!allHistory[sessionId]) allHistory[sessionId] = [];
                    allHistory[sessionId].push({ role: 'user', text: message });
                    allHistory[sessionId].push({ role: 'bot', text: textoBot });
                    writeData(FILES.history, allHistory);

                    // Procesar Lead
                    if (dataPart) {
                        try {
                            const lead = JSON.parse(dataPart.replace(/```json|```/g, "").trim());
                            if (lead.es_lead) {
                                const leads = readData(FILES.leads, []);
                                leads.push({ fecha: new Date().toLocaleString('es-CO'), ...lead });
                                writeData(FILES.leads, leads);
                            }
                        } catch (e) {}
                    }
                    resolve(textoBot);
                } catch (e) { resolve("Deme un momento, estoy verificando en bodega..."); }
            });
        });
        reqGoogle.write(payload); reqGoogle.end();
    });
}

// ============================================================
// 🔓 RUTAS PÚBLICAS
// ============================================================
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.isLogged = true;
        return res.json({ success: true });
    }
    res.status(401).json({ error: "Fallo de ingreso" });
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === META_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.message) return res.json({ reply: await procesarConLorena(body.message) });
    if (body.object === 'whatsapp_business_account') {
        const entry = body.entry[0].changes[0].value;
        if (entry.messages && entry.messages[0]) {
            const msg = entry.messages[0];
            const reply = await procesarConLorena(msg.text.body, msg.from);
            await enviarWhatsApp(entry.metadata.phone_number_id, msg.from, reply);
        }
    }
    res.sendStatus(200);
});

// ============================================================
// 🛡️ RUTAS PROTEGIDAS (DASHBOARD)
// ============================================================
const proteger = (req, res, next) => {
    if (req.session.isLogged) return next();
    res.redirect('/login');
};

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
        globalKnowledge = records.map(r => ({
            searchable: Object.values(r).join(" "),
            originalRow: Object.entries(r).map(([k,v]) => `${k}:${v}`).join("|")
        }));
        writeData(FILES.knowledge, globalKnowledge);
        res.json({ success: true, total: globalKnowledge.length });
    } catch (e) { res.status(500).send(); }
} );

app.get('/api/data/:type', proteger, (req, res) => {
    res.json(readData(FILES[req.params.type], []));
});

app.post('/api/data/clear-leads', proteger, (req, res) => {
    writeData(FILES.leads, []);
    res.json({ success: true });
});

app.get('/', proteger, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(__dirname));

// ============================================================
// 🚀 INICIO
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    globalKnowledge = readData(FILES.knowledge, []);
    console.log(`🚀 MOTOR ICC 3.0 LISTO - PUERTO ${PORT}`);
});
