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
// 🔑 SEGURIDAD Y CONFIGURACIÓN (Variables de Entorno)
// ============================================================
// ¡NUNCA dejes llaves reales aquí! Usa el panel de Render -> Environment
const API_KEY = process.env.GEMINI_KEY; 
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = process.env.SESSION_SECRET || "secreto-ultra-seguro-icc";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "ICC_2025";

// Aumentamos límites para recibir CSVs pesados sin que se cuelgue
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', // Solo HTTPS en producción
        httpOnly: true, // Protege contra ataques XSS (nadie ve la cookie desde consola)
        maxAge: 3600000 * 8 // 8 horas de sesión
    }
}));

// ============================================================
// 📂 GESTIÓN DE BASE DE DATOS LOCAL
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
    try { 
        fs.writeFileSync(file, JSON.stringify(data, null, 2)); 
        return true;
    } catch (err) { return false; }
};

const normalizarParaBusqueda = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[-.\s]/g, "").trim() : "";

// ============================================================
// 🔊 INTEGRACIÓN WHATSAPP (LA BOCA)
// ============================================================
async function enviarWhatsApp(phoneId, to, text) {
    if (!META_ACCESS_TOKEN) return console.log("⚠️ Error: META_ACCESS_TOKEN no configurado.");
    
    try {
        await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to,
            type: "text",
            text: { body: text }
        }, {
            headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` }
        });
        console.log(`✅ WhatsApp enviado a: ${to}`);
    } catch (e) {
        console.error("❌ Error enviando WhatsApp:", e.response ? e.response.data : e.message);
    }
}

// ============================================================
// 🤖 CEREBRO DE LORENA (RAG + LEAD CAPTURE)
// ============================================================
async function procesarConLorena(message, sessionId = 'tester') {
    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});

    const consultaLimpia = normalizarParaBusqueda(message);
    const palabras = message.toLowerCase().split(/\s+/).filter(p => p.length > 2);
    
    // Búsqueda en catálogo (CSV cargado)
    const coincidencias = globalKnowledge.map(item => {
        const texto = normalizarParaBusqueda(item.searchable);
        let score = texto.includes(consultaLimpia) ? 100 : 0;
        palabras.forEach(p => { if (texto.includes(p)) score += 15; });
        return { ...item, score };
    }).filter(i => i.score > 0).sort((a, b) => b.score - a.score).slice(0, 7);

    // Ajuste de tono formal "Usted" (según perfil de usuario)
    const promptLorena = `
    ${config.prompt || "Eres Lorena, asesora de Importadora Casa Colombia (ICC). Siempre habla con respeto 'usteando' al cliente."}
    REGLAS: ${config.tech_rules || "Dar información técnica precisa."}
    
    CONOCIMIENTO ACTUAL (STOCK):
    ${coincidencias.length > 0 ? coincidencias.map(c => `- ${c.originalRow}`).join('\n') : "No tenemos información exacta en este momento."}

    INSTRUCCIÓN DE LEADS: Si el cliente pide algo que no está o quieres cerrar la venta, solicita: Nombre, Ciudad y Celular. 
    Si te dan datos, genera al final: [DATA] {"es_lead":true, "nombre":"...", "telefono":"...", "ciudad":"..."} [DATA]

    MENSAJE DEL CLIENTE: "${message}"`;

    // Llamada a Gemini
    return new Promise((resolve) => {
        const payload = JSON.stringify({ contents: [{ parts: [{ text: promptLorena }] }] });
        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };

        const reqGoogle = https.request(options, (resGoogle) => {
            let body = '';
            resGoogle.on('data', d => body += d);
            resGoogle.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    const raw = json.candidates[0].content.parts[0].text;
                    const finalReply = raw.split('[DATA]')[0].trim();
                    const dataPart = raw.split('[DATA]')[1];

                    // Guardar Lead
                    if (dataPart) {
                        try {
                            const lead = JSON.parse(dataPart.replace(/```json|```/g, "").trim());
                            if (lead.es_lead) {
                                const leads = readData(FILES.leads, []);
                                leads.push({ ...lead, fecha: new Date().toLocaleString('es-CO') });
                                writeData(FILES.leads, leads);
                            }
                        } catch (e) {}
                    }
                    resolve(finalReply);
                } catch (e) { resolve("Lo siento, estoy verificando el sistema. ¿Me repite su duda?"); }
            });
        });
        reqGoogle.write(payload); reqGoogle.end();
    });
}

// ============================================================
// 🛡️ RUTAS Y SEGURIDAD
// ============================================================

// Webhook GET (Meta Verification)
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
        return res.send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
});

// Webhook POST (WhatsApp + Tester)
app.post('/webhook', async (req, res) => {
    const body = req.body;
    
    // Caso 1: Mensaje desde el Dashboard (Tester)
    if (body.message) {
        const r = await procesarConLorena(body.message);
        return res.json({ reply: r });
    }

    // Caso 2: Mensaje real de WhatsApp
    if (body.object === 'whatsapp_business_account') {
        try {
            const entry = body.entry[0].changes[0].value;
            if (entry.messages && entry.messages[0]) {
                const msg = entry.messages[0];
                const phoneId = entry.metadata.phone_number_id;
                const reply = await procesarConLorena(msg.text.body, msg.from);
                await enviarWhatsApp(phoneId, msg.from, reply);
            }
        } catch (e) {}
        return res.sendStatus(200);
    }
    res.sendStatus(404);
});

// LOGIN Y ACCESO
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.isLogged = true;
        return res.json({ success: true });
    }
    res.status(401).json({ error: "Credenciales inválidas" });
});

// Middleware de protección: Bloquea el acceso a /data y archivos JSON
const proteger = (req, res, next) => {
    if (req.path.includes('.json') || req.path.startsWith('/data')) {
        return res.status(403).send("Acceso Denegado");
    }
    if (req.session.isLogged) return next();
    if (['/login', '/auth', '/webhook'].includes(req.path)) return next();
    res.redirect('/login');
};

app.use(proteger);
app.use(express.static(__dirname));

// ============================================================
// 📊 API ADMINISTRATIVA (CSV / DATA)
// ============================================================

app.post('/api/knowledge/csv', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).send("No hay archivo");
        
        const content = req.file.buffer.toString('utf-8');
        const delimiter = content.includes(';') ? ';' : ',';
        const records = parse(content, { columns: true, skip_empty_lines: true, delimiter });
        
        const total = records.map(r => ({
            searchable: Object.values(r).join(" "),
            originalRow: Object.entries(r).map(([k,v]) => `${k}: ${v}`).join(" | ")
        }));

        globalKnowledge = total;
        writeData(FILES.knowledge, total);
        
        // Enviamos respuesta rápida para que el cliente no se quede cargando
        res.json({ success: true, total: total.length });
    } catch (err) {
        console.error("Error CSV:", err);
        res.status(500).send("Error procesando CSV");
    }
});

app.get('/api/data/:type', (req, res) => {
    const type = req.params.type;
    if (FILES[type]) return res.json(readData(FILES[type], []));
    res.sendStatus(404);
});

// ELIMINAR LEADS (Botón de limpieza)
app.post('/api/data/clear-leads', (req, res) => {
    writeData(FILES.leads, []);
    res.json({ success: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    globalKnowledge = readData(FILES.knowledge, []);
    console.log(`🚀 MOTOR ICC 2.5 ACTIVO - PUERTO ${PORT}`);
});
