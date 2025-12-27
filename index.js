const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

// ============================================================
// 🔑 CONFIGURACIÓN Y SEGURIDAD
// ============================================================
app.set('trust proxy', 1);

const API_KEY = "AIzaSyACJytpDnPzl9y5FeoQ5sx8m-iyhPXINto"; 
const META_TOKEN = "EAAL9wuZCZBtTwBQSJFtJAGqFQYpUHIPvXasybuUNQPEYdhIwiIL2MNfS6g80opN9YGPeQHCEBGMkKPibOpZAHF9rtqMr0hYG0ZAv1x3BgjgrDFiCrA9UY8CcuuQBtIi8HZBvgbFAbnF2tqXYHcQA9j2C3uRXpuZAwvsXcpfA3ZAdb4aZCrOdrJZCp93EZB149DFwZDZD";
const PHONE_NUMBER_ID = "913148698549581";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-ultra-secret-2025";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname)); 
app.use('/images', express.static(path.join(__dirname, 'images'))); // Restauré la carpeta de imágenes por si acaso

const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    knowledge: path.join(DATA_DIR, 'knowledge.json'),
    config: path.join(DATA_DIR, 'config.json'),
    leads: path.join(DATA_DIR, 'leads.json'),
    history: path.join(DATA_DIR, 'history.json')
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
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 } // 24 horas de sesión
}));

let globalKnowledge = readData(FILES.knowledge, []);

// ============================================================
// 📩 ENVÍO DE WHATSAPP
// ============================================================
async function enviarWhatsApp(destinatario, texto) {
    try {
        // Actualizado a v21.0 (versión más estable)
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: destinatario,
            type: "text",
            text: { body: texto }
        }, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
        console.log(`✅ Mensaje enviado a ${destinatario}`);
    } catch (e) { console.error("Error envío WhatsApp:", e.response?.data || e.message); }
}

// ============================================================
// 🧠 PROCESAMIENTO CON IA LORENA
// ============================================================
function buscarEnCatalogo(query) {
    if (!query) return [];
    const norm = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    const q = norm(query).split(" ");
    return globalKnowledge.map(item => {
        let score = 0;
        const itemText = norm(item.searchable || ""); // Protección contra vacíos
        q.forEach(w => { if (itemText.includes(w)) score++; });
        return { ...item, score };
    }).filter(i => i.score > 0).sort((a,b) => b.score - a.score).slice(0, 5);
}

async function procesarConLorena(message, sessionId) {
    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});
    const chatPrevio = (allHistory[sessionId] || []).slice(-8); // Contexto de 8 mensajes
    const stock = buscarEnCatalogo(message);

    const prompt = `Eres Lorena, la vendedora estrella de ICC (Importadora Casa Colombia). 
    TU OBJETIVO: Vender repuestos de maquinaria pesada (Caterpillar, Komatsu, etc.) y conseguir el contacto del cliente.

    CONTEXTO DE LA EMPRESA: ${config.tech_rules || 'Somos expertos en repuestos de alta calidad.'}
    INVENTARIO DISPONIBLE: ${JSON.stringify(stock)}
    HISTORIAL DE CONVERSACIÓN: ${JSON.stringify(chatPrevio)}

    DIRECTRICES DE RESPUESTA:
    1. Sé muy amable pero profesional. Usa "tú" o "usted" según el tono del cliente.
    2. Si el cliente pregunta por un repuesto que está en el INVENTARIO, da el precio y confirma disponibilidad.
    3. Si NO está en el inventario, dile que vas a consultar con bodega y pídele su correo o nombre para avisarle.
    4. Siempre cierra con una pregunta: "¿Para qué máquina lo necesitas?" o "¿A qué ciudad lo enviamos?".
    5. IMPORTANTE: Si detectas su nombre o correo, añade al final: [DATA] {"es_lead":true, "nombre":"...", "correo":"..."} [DATA]`;

    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] });

        let fullText = res.data.candidates[0].content.parts[0].text;
        
        // Manejo seguro de split
        let textoVisible = fullText;
        let dataPart = null;

        if (fullText.includes('[DATA]')) {
            const partes = fullText.split('[DATA]');
            textoVisible = partes[0].trim();
            dataPart = partes[1];
        }

        const respuestaLimpia = textoVisible.trim();

        // Guardar en Historial
        if (!allHistory[sessionId]) allHistory[sessionId] = [];
        allHistory[sessionId].push({ role: 'user', text: message, time: new Date().toISOString() });
        allHistory[sessionId].push({ role: 'bot', text: respuestaLimpia, time: new Date().toISOString() });
        writeData(FILES.history, allHistory);

        // Procesar Lead
        if (dataPart) {
            try {
                const leadData = JSON.parse(dataPart.trim());
                if(leadData.es_lead) {
                    const leads = readData(FILES.leads, []);
                    leads.push({ ...leadData, fecha: new Date().toLocaleString(), telefono: sessionId });
                    writeData(FILES.leads, leads);
                }
            } catch (e) { console.log("Error procesando JSON Lead"); }
        }
        return respuestaLimpia;
    } catch (err) { 
        console.error(err);
        return "Hola, te habla Lorena de ICC. Tuvimos una pequeña interrupción, ¿me podrías repetir el repuesto que buscas?"; 
    }
}

// ============================================================
// 🚦 RUTAS WEBHOOK
// ============================================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === 'ICC_2025') return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    
    // Soporte para Tester del Dashboard
    if (body.message && !body.entry) {
        const r = await procesarConLorena(body.message, 'tester-web');
        return res.json({ reply: r });
    }
    
    // Soporte para WhatsApp Real
    if (body.object === 'whatsapp_business_account') {
        res.sendStatus(200); // Respuesta rápida a Meta para evitar reintentos
        try {
            const entry = body.entry?.[0]?.changes?.[0]?.value;
            const msg = entry?.messages?.[0];
            if (msg?.text?.body) {
                const respuesta = await procesarConLorena(msg.text.body, msg.from);
                await enviarWhatsApp(msg.from, respuesta);
            }
        } catch (e) {
            console.error("Error en Webhook:", e);
        }
    } else {
        res.sendStatus(200);
    }
});

// ============================================================
// ⚙️ APIS DASHBOARD
// ============================================================
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No autorizado");

app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isLogged = true;
        return req.session.save(() => res.json({ success: true }));
    }
    res.status(401).json({ success: false });
});

// 🔄 RUTA RESTAURADA: Guardar Configuración/Contexto desde Dashboard
app.post('/save-context', proteger, (req, res) => {
    const config = readData(FILES.config, {});
    config.tech_rules = req.body.context;
    writeData(FILES.config, config);
    res.json({ success: true });
});

app.get('/api/data/:type', proteger, (req, res) => res.json(readData(FILES[req.params.type], [])));

// 🔄 RUTA OPTIMIZADA: Carga de CSV
app.post('/api/knowledge/csv', proteger, upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No se envió archivo" });
        const records = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true });
        globalKnowledge = records.map(r => ({ searchable: Object.values(r).join(" "), data: r }));
        writeData(FILES.knowledge, globalKnowledge);
        res.json({ success: true, count: globalKnowledge.length });
    } catch (e) {
        res.status(500).json({ error: "Error procesando CSV" });
    }
});

app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.listen(process.env.PORT || 10000, () => console.log("🚀 LORENA ICC ACTIVADA"));
