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
// 🔑 CONFIGURACIÓN Y LLAVES (Render)
// ============================================================
const API_KEY = process.env.GEMINI_KEY || "AIzaSyACJytpDnPzl9y5FeoQ5sx8m-iyhPXINto"; 
const ADMIN_USER = process.env.ADMIN_USER || "admin"; 
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025"; 
const META_VERIFY_TOKEN = "ICC_2025"; 
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN; // Tu Token de Meta

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

// ============================================================
// 📁 HELPERS DE DATOS (No se pierde nada)
// ============================================================
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

const normalizarParaBusqueda = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[-.\s]/g, "").trim() : "";

// ============================================================
// 🔊 LA BOCA: FUNCIÓN PARA ENVIAR A WHATSAPP
// ============================================================
async function enviarWhatsApp(phoneId, to, text) {
    if (!META_ACCESS_TOKEN) return console.log("⚠️ No hay Token de Meta configurado.");
    
    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
    const data = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { body: text }
    };

    try {
        await axios.post(url, data, {
            headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });
        console.log(`✅ Mensaje enviado a ${to}`);
    } catch (e) {
        console.error("❌ Error enviando WA:", e.response ? e.response.data : e.message);
    }
}

// ============================================================
// 🤖 EL CEREBRO: PROCESAR CON LORENA
// ============================================================
async function procesarConLorena(message, sessionId = 'test-user') {
    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});

    const consultaLimpia = normalizarParaBusqueda(message);
    const palabrasClave = message.toLowerCase().split(/\s+/).filter(p => p.length > 1);
    
    const coincidencias = globalKnowledge.map(item => {
        const textoProducto = normalizarParaBusqueda(item.searchable);
        let score = 0;
        if (textoProducto.includes(consultaLimpia)) score += 100;
        palabrasClave.forEach(key => {
            if (textoProducto.includes(key)) score += 20;
        });
        return { ...item, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);

    const prompt = `
    ${config.prompt || "Eres Lorena de ICC, asesora experta."}
    REGLAS: ${config.tech_rules || "Atención técnica."}
    INSTRUCCIONES:
    1. SI HAY STOCK: Confirma SKU y ofrece facturar.
    2. SI NO HAY STOCK: Di "Estoy validando..." y pide Nombre, Ciudad, Celular y Correo.
    3. EXTRACCIÓN: Si el usuario da sus datos, genera al final [DATA] {"es_lead":true, "nombre":"...", "telefono":"...", "ciudad":"...", "correo":"...", "interes":"..."} [DATA].
    
    PRODUCTOS:
    ${coincidencias.length > 0 ? coincidencias.map(c => `- ${c.originalRow}`).join('\n') : "Sin stock exacto."}

    HISTORIAL: ${(allHistory[sessionId] || []).map(m => `${m.role}: ${m.text}`).slice(-5).join('\n')}
    CLIENTE: "${message}"`;

    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };

        const googleReq = https.request(options, (googleRes) => {
            let body = '';
            googleRes.on('data', d => body += d);
            googleRes.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    const fullReply = json.candidates[0].content.parts[0].text;
                    const finalReply = fullReply.split('[DATA]')[0].trim();
                    const dataPart = fullReply.split('[DATA]')[1];

                    if (!allHistory[sessionId]) allHistory[sessionId] = [];
                    allHistory[sessionId].push({ role: 'user', text: message, timestamp: Date.now() });
                    allHistory[sessionId].push({ role: 'bot', text: finalReply, timestamp: Date.now() });
                    writeData(FILES.history, allHistory);

                    if (dataPart) {
                        try {
                            const extraction = JSON.parse(dataPart.replace(/```json|```/g, "").trim());
                            if (extraction.es_lead) {
                                const leads = readData(FILES.leads, []);
                                leads.push({ fecha: new Date().toLocaleDateString('es-CO'), ...extraction });
                                writeData(FILES.leads, leads);
                            }
                        } catch (e) {}
                    }
                    resolve(finalReply);
                } catch (e) { resolve("Deme un momento, estoy verificando disponibilidad..."); }
            });
        });
        googleReq.on('error', (e) => reject(e));
        googleReq.write(payload);
        googleReq.end();
    });
}

// ============================================================
// 🔓 RUTAS PÚBLICAS (Antes de la protección)
// ============================================================

// Pantalla de Login (Corregido para Render)
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Autenticación
app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.isLogged = true;
        return res.json({ success: true });
    }
    res.status(401).send();
});

// Webhook GET (Verificación de Meta)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token === META_VERIFY_TOKEN) return res.status(200).send(challenge);
    res.sendStatus(403);
});

// Webhook POST (Recepción de mensajes)
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        
        // 1. Mensaje del Dashboard
        if (body.message) {
            const reply = await procesarConLorena(body.message);
            return res.json({ reply });
        }

        // 2. Mensaje de WhatsApp Real
        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry[0].changes[0].value;
            const msg = entry.messages ? entry.messages[0] : null;
            const phoneId = entry.metadata.phone_number_id;

            if (msg && msg.text) {
                const reply = await procesarConLorena(msg.text.body, msg.from);
                await enviarWhatsApp(phoneId, msg.from, reply); // Lorena responde sola
            }
            return res.sendStatus(200);
        }
        res.sendStatus(404);
    } catch (err) { res.status(200).send(); }
});

// ============================================================
// 🛡️ RUTAS PROTEGIDAS (Solo Admin)
// ============================================================
const proteger = (req, res, next) => {
    if (req.session.isLogged) return next();
    res.redirect('/login');
};

app.use(proteger);
app.use(express.static(__dirname));

// Endpoints de configuración (CSV, URL, etc - Se mantienen igual)
app.get('/api/data/:type', (req, res) => {
    const type = req.params.type;
    if (FILES[type]) return res.json(readData(FILES[type], (type === 'config' ? {} : [])));
    res.status(404).send();
});

app.post('/save-context', (req, res) => {
    const config = readData(FILES.config, {});
    config.tech_rules = req.body.context;
    writeData(FILES.config, config);
    res.json({ success: true });
});

app.post('/api/save-personality', (req, res) => {
    const config = readData(FILES.config, {});
    config.prompt = req.body.prompt;
    writeData(FILES.config, config);
    res.json({ success: true });
});

app.post('/api/knowledge/csv', upload.single('file'), (req, res) => {
    try {
        const actual = readData(FILES.knowledge, []);
        const content = req.file.buffer.toString('utf-8');
        const delimiter = content.includes(';') ? ';' : ',';
        const records = parse(content, { columns: true, skip_empty_lines: true, delimiter: delimiter });
        const nuevos = records.map(row => ({
            searchable: Object.values(row).join(" "),
            originalRow: Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(" | ")
        }));
        const total = [...actual, ...nuevos];
        writeData(FILES.knowledge, total);
        globalKnowledge = total;
        res.json({ success: true, total: total.length });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/knowledge/url', async (req, res) => {
    try {
        let { url } = req.body;
        if (!url.startsWith('http')) url = 'https://' + url;
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(response.data);
        $('script, style, nav, footer, header').remove();
        const titulo = $('title').text() || "Web";
        const contenido = $('p, h1, h2, h3, li').text().replace(/\s+/g, ' ').trim();
        const total = [...readData(FILES.knowledge, []), { searchable: `${titulo} ${contenido}`, originalRow: `WEB: ${contenido.substring(0, 500)}... (${url})` }];
        writeData(FILES.knowledge, total);
        globalKnowledge = total;
        res.json({ success: true, title: titulo });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/reset-history', (req, res) => {
    writeData(FILES.history, {});
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    globalKnowledge = readData(FILES.knowledge, []);
    console.log(`🚀 MOTOR ICC 2.5 LISTO EN PUERTO ${PORT}`);
});
