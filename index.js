const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session); // Mantiene la sesión viva
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
app.set('trust proxy', 1);

// Estas variables ahora pueden leerse del archivo config.json si se actualizan desde el panel
const API_KEY = "AIzaSyACJytpDnPzl9y5FeoQ5sx8m-iyhPXINto"; 
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = process.env.SESSION_SECRET || "icc-ultra-secret-2025";
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "ICC_2025";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Directorio para datos
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Archivos JSON
const FILES = {
    knowledge: path.join(DATA_DIR, 'knowledge.json'),
    config: path.join(DATA_DIR, 'config.json'),
    leads: path.join(DATA_DIR, 'leads.json'),
    history: path.join(DATA_DIR, 'history.json')
};

// ============================================================
// 💾 GESTIÓN DE DATOS Y SESIONES
// ============================================================

// Lectura segura de datos
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

// Configuración de Sesión "Blindada"
app.use(session({
    store: new FileStore({ path: path.join(DATA_DIR, 'sessions'), ttl: 86400 }), // Guarda en archivo
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Importante: false evita problemas con proxys en Render
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 24 Horas
    }
}));

let globalKnowledge = readData(FILES.knowledge, []);

// ============================================================
// 🧠 LÓGICA INTELIGENTE (Búsqueda + Gemini)
// ============================================================

// 1. Buscador "Borroso" (Entiende errores ortográficos)
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
    .slice(0, 5); // Top 5 coincidencias
}

// 2. Cerebro Principal
async function procesarConLorena(message, sessionId = 'tester') {
    const config = readData(FILES.config, {});
    let allHistory = readData(FILES.history, {});
    
    // Recuperar últimos 6 mensajes para contexto
    const historialChat = (allHistory[sessionId] || []).slice(-6);
    const historialTexto = historialChat.map(m => `${m.role === 'user' ? 'Cliente' : 'Lorena'}: ${m.text}`).join('\n');

    // Buscar en stock
    const stockEncontrado = buscarEnCatalogo(message);

    // PROMPT MAESTRO ACTUALIZADO (Pide Apellido y Correo)
    const prompt = `
    ROL: Eres Lorena, la asistente comercial experta de Importadora Casa Colombia (ICC).
    TU OBJETIVO: Asesorar, dar información de la empresa y VENDER repuestos/maquinaria.
    
    🧠 BASE DE CONOCIMIENTO (INFORMACIÓN DE LA EMPRESA):
    Usa esto para responder preguntas generales (quiénes somos, horarios, servicios):
    "${config.tech_rules || "Somos ICC, líderes en maquinaria amarilla y repuestos en Colombia. Atendemos de 8am a 5pm."}"

    📦 INVENTARIO (SOLO SI PREGUNTAN POR REPUESTOS):
    ${stockEncontrado.length > 0 ? JSON.stringify(stockEncontrado) : "No hay coincidencia exacta en este momento."}

    📜 HISTORIAL:
    ${historialTexto}

    🚨 REGLAS DE ORO:
    1. Si preguntan cosas generales, usa la BASE DE CONOCIMIENTO.
    2. Si preguntan por repuestos, usa el INVENTARIO.
    3. Trata siempre de "Usted".

    🕵️‍♂️ CAZADOR DE LEADS (IMPORTANTE):
    Tu meta oculta es completar la ficha del cliente. Intenta obtener sutilmente:
    - Nombre y APELLIDO.
    - Correo Electrónico.
    - Interés (Qué máquina o repuesto busca).
    
    FORMATO JSON DE SALIDA:
    Si el cliente da datos o muestra interés de compra, agrega AL FINAL de tu respuesta este bloque (llena con null lo que no tengas):
    [DATA] {"es_lead": true, "nombre": "...", "apellido": "...", "correo": "...", "telefono": "${sessionId}", "interes": "..."} [DATA]

    MENSAJE DEL CLIENTE: "${message}"
    Respuesta de Lorena:`;

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

        // Guardar Historial
        if (!allHistory[sessionId]) allHistory[sessionId] = [];
        allHistory[sessionId].push({ role: 'user', text: message });
        allHistory[sessionId].push({ role: 'bot', text: textoBot });
        writeData(FILES.history, allHistory);

        // Procesar Lead
        if (dataPart) {
            try {
                const cleanJson = dataPart.replace(/\]|\[/g, '').trim();
                const lead = JSON.parse(cleanJson);
                if (lead.es_lead) {
                    const leads = readData(FILES.leads, []);
                    // Combinar nombre y apellido para visualización
                    const nombreCompleto = `${lead.nombre || ''} ${lead.apellido || ''}`.trim();
                    
                    leads.push({ 
                        fecha: new Date().toLocaleString('es-CO'), 
                        nombre: nombreCompleto || 'Desconocido',
                        correo: lead.correo || 'Pendiente',
                        telefono: lead.telefono,
                        ciudad: lead.ciudad || 'N/A',
                        interes: lead.interes
                    });
                    writeData(FILES.leads, leads);
                }
            } catch (e) { console.error("Error parseando Lead:", e); }
        }

        return textoBot;

    } catch (error) {
        console.error("Error Gemini:", error.message);
        return "Disculpe, estamos actualizando el inventario. ¿Me repite la pregunta?";
    }
}

// 3. Envío a WhatsApp (Con soporte para Token desde Config)
async function enviarWhatsApp(phoneId, to, text) {
    const config = readData(FILES.config, {});
    // Usa el token del env O el guardado en el panel
    const token = config.meta_token || process.env.META_ACCESS_TOKEN;
    
    if (!token) return console.log("⚠️ Falta Token Meta");

    try {
        await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, 
        { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
        { headers: { 'Authorization': `Bearer ${token}` } });
    } catch (e) { console.error("Error WhatsApp Out:", e.response ? e.response.data : e.message); }
}

// ============================================================
// 🚦 RUTAS DEL SERVIDOR
// ============================================================

// Estáticos
app.use('/images', express.static(path.join(__dirname, 'images')));

// 1. Autenticación
app.get('/login', (req, res) => {
    if (req.session.isLogged) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.isLogged = true;
        req.session.save(() => res.json({ success: true })); // Guarda sesión forzosamente
    } else {
        res.status(401).json({ error: "Credenciales inválidas" });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// 2. Webhooks (Públicos)
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === META_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    
    // Tester Web
    if (body.message && !body.entry) {
        const reply = await procesarConLorena(body.message, 'web-tester');
        return res.json({ reply });
    }
    
    // WhatsApp Real
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

// 3. Middleware de Protección (Todo lo de abajo requiere Login)
const proteger = (req, res, next) => {
    if (req.session.isLogged) return next();
    res.status(401).send("Sesión expirada");
};

// 4. API del Dashboard
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

// NUEVA RUTA: Guardar Integraciones y Config General
app.post('/api/save-general-config', proteger, (req, res) => {
    const currentConfig = readData(FILES.config, {});
    const newConfig = { ...currentConfig, ...req.body };
    writeData(FILES.config, newConfig);
    res.json({ success: true });
});

app.post('/api/knowledge/csv', proteger, upload.single('file'), (req, res) => {
    if(!req.file) return res.status(400).json({error: "Falta archivo"});
    try {
        const content = req.file.buffer.toString('utf-8');
        const records = parse(content, { columns: true, skip_empty_lines: true });
        globalKnowledge = records.map(r => ({
            searchable: Object.values(r).join(" "),
            data: r
        }));
        writeData(FILES.knowledge, globalKnowledge);
        res.json({ success: true, total: globalKnowledge.length });
    } catch (e) { res.status(500).json({ error: "Error en CSV" }); }
});

app.get('/api/data/:type', proteger, (req, res) => {
    const data = readData(FILES[req.params.type], []);
    res.json(data);
});

app.post('/api/data/clear-leads', proteger, (req, res) => {
    writeData(FILES.leads, []);
    res.json({ success: true });
});

// 5. Servir Frontend Protegido
app.get('/', proteger, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// 6. Arranque
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 LORENA IA 3.0 LISTA EN PUERTO ${PORT}`);
});
