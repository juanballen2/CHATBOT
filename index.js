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
// 🔑 CONFIGURACIÓN (Usa variables de entorno en Render)
// ============================================================
const API_KEY = process.env.GEMINI_KEY || "AIzaSyACJytpDnPzl9y5FeoQ5sx8m-iyhPXINto"; 
const ADMIN_USER = process.env.ADMIN_USER || "admin"; 
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025"; 
const META_VERIFY_TOKEN = "ICC_2025"; 
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN; 

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

// HELPERS
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

// ENVIAR WHATSAPP
async function enviarWhatsApp(phoneId, to, text) {
    if (!META_ACCESS_TOKEN) return console.log("⚠️ No hay Token de Meta.");
    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
    try {
        await axios.post(url, {
            messaging_product: "whatsapp",
            to: to,
            text: { body: text }
        }, { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` } });
    } catch (e) { console.error("❌ Error WA:", e.message); }
}

// CEREBRO LORENA
async function procesarConLorena(message, sessionId = 'test-user') {
    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});

    const consultaLimpia = normalizarParaBusqueda(message);
    const palabrasClave = message.toLowerCase().split(/\s+/).filter(p => p.length > 1);
    
    const coincidencias = globalKnowledge.map(item => {
        const textoProducto = normalizarParaBusqueda(item.searchable);
        let score = 0;
        if (textoProducto.includes(consultaLimpia)) score += 100;
        palabrasClave.forEach(key => { if (textoProducto.includes(key)) score += 20; });
        return { ...item, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);

    const prompt = `
    ${config.prompt || "Eres Lorena de ICC, asesora experta."}
    REGLAS: ${config.tech_rules || "Atención técnica."}
    PRODUCTOS: ${coincidencias.length > 0 ? coincidencias.map(c => `- ${c.originalRow}`).join('\n') : "Sin stock."}
    HISTORIAL: ${(allHistory[sessionId] || []).map(m => `${m.role}: ${m.text}`).slice(-5).join('\n')}
    MENSAJE: "${message}"`;

    return new Promise((resolve) => {
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
                    allHistory[sessionId].push({ role: 'user', text: message });
                    allHistory[sessionId].push({ role: 'bot', text: finalReply });
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
                } catch (e) { resolve("Deme un momento..."); }
            });
        });
        googleReq.write(payload);
        googleReq.end();
    });
}

// RUTAS PÚBLICAS
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) { req.session.isLogged = true; return res.json({ success: true }); }
    res.status(401).send();
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
        if (entry.messages) {
            const reply = await procesarConLorena(entry.messages[0].text.body, entry.messages[0].from);
            await enviarWhatsApp(entry.metadata.phone_number_id, entry.messages[0].from, reply);
        }
    }
    res.sendStatus(200);
});

// RUTAS PROTEGIDAS
app.use((req, res, next) => req.session.isLogged ? next() : res.redirect('/login'));
app.use(express.static(__dirname));

app.get('/api/data/:type', (req, res) => res.json(readData(FILES[req.params.type], [])));
app.post('/api/knowledge/csv', upload.single('file'), (req, res) => {
    const records = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true });
    globalKnowledge = records.map(r => ({ searchable: Object.values(r).join(" "), originalRow: Object.entries(r).map(([k,v]) => `${k}:${v}`).join("|") }));
    writeData(FILES.knowledge, globalKnowledge);
    res.json({ success: true, total: globalKnowledge.length });
});
// (Agrega aquí las demás funciones de guardado que ya tenías)

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { globalKnowledge = readData(FILES.knowledge, []); console.log(`🚀 MOTOR ICC 2.5 LISTO EN PUERTO ${PORT}`); });
