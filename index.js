const express = require('express');
const session = require('express-session');
// const FileStore = require('session-file-store')(session); // <--- COMENTADO PARA QUE NO FALLE
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
// Confiar en el Proxy de Railway/Render (CRÍTICO PARA QUE FUNCIONE EL LOGIN)
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
// 💾 SESIÓN BLINDADA PARA NUBE (HTTPS/RAILWAY)
// ============================================================
app.use(session({
    secret: SESSION_SECRET,
    resave: true,            // Fuerza a guardar la sesión siempre
    saveUninitialized: true, // Crea sesión desde el primer momento
    proxy: true,             // Necesario para Railway/Render
    cookie: { 
        secure: true,        // ¡OJO! True porque usa HTTPS (Candadito)
        httpOnly: true,      // Evita robo de cookies por scripts
        sameSite: 'none',    // Permite flujo correcto en navegadores modernos
        maxAge: 1000 * 60 * 60 * 24 // 24 Horas
    }
}));

let globalKnowledge = readData(FILES.knowledge, []);

// ============================================================
// 🧠 LÓGICA INTELIGENTE
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

    const prompt = `
    ROL: Eres Lorena, asistente comercial de Importadora Casa Colombia (ICC).
    OBJETIVO: Vender repuestos/maquinaria y capturar datos. Trata siempre de "Usted".
    
    🧠 BASE DE CONOCIMIENTO (EMPRESA):
    "${config.tech_rules || "Somos ICC, expertos en maquinaria amarilla y repuestos."}"

    📦 INVENTARIO (REPUESTOS):
    ${stockEncontrado.length > 0 ? JSON.stringify(stockEncontrado) : "No hay coincidencia exacta."}

    📜 HISTORIAL:
    ${historialTexto}

    🚨 REGLAS:
    1. Preguntas generales -> Usa BASE DE CONOCIMIENTO.
    2. Preguntas de stock -> Usa INVENTARIO.
    3. CAPTURA DE LEADS: Intenta obtener Nombre, APELLIDO y Correo.

    FORMATO JSON FINAL (OBLIGATORIO SI HAY DATOS):
    [DATA] {"es_lead": true, "nombre": "...", "apellido": "...", "correo": "...", "telefono": "${sessionId}", "interes": "..."} [DATA]

    MENSAJE CLIENTE: "${message}"`;

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const fullText = response.data.candidates[0].content.parts[0].text;
        const partes = fullText.split('[DATA]');
        const textoBot = partes[0].trim();
        const dataPart = partes[1];

        if (!allHistory[sessionId]) allHistory[sessionId] = [];
        allHistory[sessionId].push({ role: 'user', text: message });
        allHistory[sessionId].push({ role: 'bot', text: textoBot });
        writeData(FILES.history, allHistory);

        if (dataPart) {
            try {
                const cleanJson = dataPart.replace(/\]|\[/g, '').trim();
                const lead = JSON.parse(cleanJson);
                if (lead.es_lead) {
                    const leads = readData(FILES.leads, []);
                    leads.push({ 
                        fecha: new Date().toLocaleString('es-CO'), 
                        nombre: `${lead.nombre || ''} ${lead.apellido || ''}`.trim(),
                        correo: lead.correo || 'Pendiente',
                        telefono: lead.telefono,
                        ciudad: lead.ciudad || 'N/A',
                        interes: lead.interes
                    });
                    writeData(FILES.leads, leads);
                }
            } catch (e) {}
        }
        return textoBot;

    } catch (error) {
        return "Disculpe, estamos verificando inventario. ¿Me repite?";
    }
}

async function enviarWhatsApp(phoneId, to, text) {
    const config = readData(FILES.config, {});
    const token = config.meta_token || process.env.META_ACCESS_TOKEN;
    if (!token) return;
    try {
        await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, 
        { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
        { headers: { 'Authorization': `Bearer ${token}` } });
    } catch (e) {}
}

// ============================================================
// 🚦 RUTAS
// ============================================================
app.use('/images', express.static(path.join(__dirname, 'images')));

app.get('/login', (req, res) => {
    if (req.session.isLogged) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.isLogged = true;
        // Importante: Guardar explícitamente antes de responder
        req.session.save(err => {
            if(err) return res.status(500).json({error: "Error guardando sesión"});
            res.json({ success: true });
        });
    } else {
        res.status(401).json({ error: "Credenciales inválidas" });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

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
    if (body.object === 'whatsapp_business_account') {
        const entry = body.entry?.[0]?.changes?.[0]?.value;
        if (entry?.messages?.[0]) {
            const msg = entry.messages[0];
            const reply = await procesarConLorena(msg.text.body, msg.from);
            await enviarWhatsApp(entry.metadata.phone_number_id, msg.from, reply);
        }
    }
    res.sendStatus(200);
});

const proteger = (req, res, next) => {
    if (req.session.isLogged) return next();
    res.status(401).send("Sesión expirada");
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

app.post('/api/save-general-config', proteger, (req, res) => {
    const currentConfig = readData(FILES.config, {});
    const newConfig = { ...currentConfig, ...req.body };
    writeData(FILES.config, newConfig);
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

app.post('/api/data/clear-leads', proteger, (req, res) => {
    writeData(FILES.leads, []);
    res.json({ success: true });
});

app.get('/', proteger, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(process.env.PORT || 10000, () => console.log(`🚀 LORENA ONLINE`));
