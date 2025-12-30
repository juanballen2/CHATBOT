const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

app.set('trust proxy', 1);

// ============================================================
// 1. CONFIGURACIÓN Y VARIABLES
// ============================================================
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-secret-v7-final"; 

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// 🛡️ SEGURIDAD DE ARCHIVOS
app.use((req, res, next) => {
    if ((req.path.endsWith('.json') || req.path.includes('/data/')) && !req.path.startsWith('/api/')) {
        return res.status(403).send('🚫 Acceso Prohibido');
    }
    next();
});

// ============================================================
// 2. MOTOR SQLITE "SELF-HEALING" (AUTOREPARABLE)
// ============================================================
let db;
(async () => {
    const DATA_DIR = path.resolve(__dirname, 'data');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    db = await open({
        filename: path.join(DATA_DIR, 'database.db'),
        driver: sqlite3.Database
    });

    // 1. Tablas Base
    await db.exec(`
        CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT);
        CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT); 
        CREATE TABLE IF NOT EXISTS metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS bot_status (phone TEXT PRIMARY KEY, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT);
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    `);

    // 2. PROTOCOLO DE REPARACIÓN DE COLUMNAS
    const columnasRequeridas = [
        { name: 'nombre', type: 'TEXT' },
        { name: 'interes', type: 'TEXT' },
        { name: 'etiqueta', type: 'TEXT' },
        { name: 'fecha', type: 'TEXT' },
        { name: 'ciudad', type: 'TEXT' }, 
        { name: 'correo', type: 'TEXT' }  
    ];

    console.log("🔧 Iniciando diagnóstico de base de datos...");
    for (const col of columnasRequeridas) {
        try {
            await db.exec(`ALTER TABLE leads ADD COLUMN ${col.name} ${col.type}`);
            console.log(`   ✅ Columna inyectada: ${col.name}`);
        } catch (e) {
            // Columna ya existe
        }
    }
    
    await refreshKnowledge();
    console.log("🚀 LORENA BACKEND v8.0 - LÓGICA 24H & SLOT FILLING ACTIVADA");
})();

let globalKnowledge = [];
async function refreshKnowledge() {
    try {
        const rows = await db.all("SELECT * FROM inventory");
        globalKnowledge = rows.map(r => ({ searchable: r.searchable, data: JSON.parse(r.raw_data) }));
    } catch(e) { globalKnowledge = []; }
}

async function getCfg(key, fallback) {
    const res = await db.get("SELECT value FROM config WHERE key = ?", [key]);
    return res ? JSON.parse(res.value) : fallback;
}
async function setCfg(key, value) {
    await db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]);
}

app.use(session({
    name: 'icc_session',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } 
}));

// ============================================================
// 3. WHATSAPP ENGINE (CONEXIÓN META)
// ============================================================
async function enviarWhatsApp(destinatario, contenido, tipo = "text") {
    try {
        let payload = { messaging_product: "whatsapp", to: destinatario, type: tipo };
        if (tipo === "text") { payload.text = { body: contenido }; } 
        else if (contenido.id) { 
            if(tipo === 'image') payload.image = { id: contenido.id };
            if(tipo === 'document') payload.document = { id: contenido.id, filename: "Archivo_ICC.pdf" };
            if(tipo === 'audio') payload.audio = { id: contenido.id };
        } else {
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
// 4. LORENA "HUNTER" (LÓGICA ACTUALIZADA v2.0)
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
    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'user', mediaDesc || message, new Date().toISOString()]);
    
    const status = await db.get("SELECT active FROM bot_status WHERE phone = ?", [sessionId]);
    if (status && status.active === 0) return null;

    const promptBase = await getCfg('prompt', "Eres Lorena, asistente de ventas ágil de Importadora Casa Colombia.");
    const websiteData = await getCfg('website_data', "No hay información web extra.");
    const techRules = await getCfg('tech_rules', []);
    const reglasTexto = Array.isArray(techRules) ? techRules.map(r => `- ${r}`).join("\n") : "Sin reglas definidas.";

    // Historial reciente para contexto
    const historyRows = await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id DESC LIMIT 15", [sessionId]);
    const chatPrevio = historyRows.reverse();
    const stock = buscarEnCatalogo(message);

    // --- PROMPT DE INGENIERÍA MEJORADO (ANTI-LORO + SLOT FILLING) ---
    const promptLorena = `
    [IDENTIDAD]
    ${promptBase}
    Estás en WhatsApp. Sé breve, útil y usa pocos emojis.
    TU OBJETIVO: Filtrar al cliente y obtener sus datos para crear la cotización. NO das precios finales.

    [CONOCIMIENTO]
    WEB: ${websiteData}
    REGLAS TÉCNICAS: ${reglasTexto}
    INVENTARIO (Referencia): ${JSON.stringify(stock)}

    [LÓGICA DE INTERACCIÓN - SLOT FILLING]
    Analiza el HISTORIAL DE CHAT adjunto.
    1. Revisa qué datos YA nos dio el cliente anteriormente (Nombre, Ciudad, Repuesto, Correo).
    2. Identifica qué datos FALTAN.
    
    [REGLAS OBLIGATORIAS]
    - Si el cliente ya saludó, NO saludes de nuevo. Ve al grano.
    - Si ya tienes un dato (ej: Nombre), NO lo pidas otra vez.
    - Si el cliente repite "urgente", confirma que ya lo sabes y pide solo el dato faltante.
    
    [GUIÓN DINÁMICO]
    - Inicio: Saluda y pregunta qué repuesto necesita.
    - Desarrollo: Si sabes el repuesto pero falta Nombre/Ciudad, pídelos amablemente.
    - Cierre: Si tienes TODO (Nombre + Ciudad + Repuesto), di: "¡Listo! Ya pasé tu solicitud al asesor humano. En breve te contactan con el precio."

    [EXTRACCIÓN DE INFORMACIÓN]
    Siempre que detectes datos del cliente, genera este JSON al final (invisible para el usuario):
    [DATA]
    {
      "es_lead": true,
      "nombre": "Nombre detectado o null",
      "interes": "Repuesto detectado o null",
      "ciudad": "Ciudad detectada o null",
      "correo": "Correo detectado o null",
      "etiqueta": "Cotización"
    }
    [DATA]
    `;

    try {
        const resAI = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: promptLorena + `\n\n--- HISTORIAL CHAT ---\n${JSON.stringify(chatPrevio)}\n\n--- MENSAJE ACTUAL ---\nUSUARIO: ${message}` }] }] });

        let fullText = resAI.data.candidates[0].content.parts[0].text;
        let textoVisible = fullText;
        
        // Extracción y Lógica de Base de Datos
        const regexData = /\[DATA\]\s*(\{[\s\S]*?\})\s*\[DATA\]/i;
        const match = fullText.match(regexData);

        if (match && match[1]) {
            textoVisible = fullText.replace(/\[DATA\][\s\S]*?\[DATA\]/gi, "").trim(); 
            try {
                const info = JSON.parse(match[1]);
                if(info.es_lead) {
                    // === LÓGICA DE NEGOCIO: REGLA DE 24 HORAS ===
                    let nombreFinal = info.nombre;
                    
                    // Buscamos SOLO el último lead de este número
                    const leadExistente = await db.get("SELECT * FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1", [sessionId]);
                    const meta = await db.get("SELECT contactName FROM metadata WHERE phone = ?", [sessionId]);
                    
                    if (!nombreFinal || nombreFinal.toLowerCase() === "null") {
                        nombreFinal = leadExistente?.nombre || meta?.contactName || "Cliente WhatsApp";
                    }

                    // Calculamos tiempo
                    let esMismaConversacion = false;
                    if (leadExistente) {
                        // Intentamos parsear la fecha (formato locale string puede variar, pero intentamos comparar)
                        // Para mayor seguridad en update usamos el ID, y asumimos continuidad si es reciente.
                        // Calculo aproximado basado en ID o si la fecha es parseable:
                        const fechaLead = new Date(leadExistente.fecha); // Esto depende del locale del servidor
                        const ahora = new Date();
                        
                        if (!isNaN(fechaLead.getTime())) {
                             const horasDif = (ahora - fechaLead) / (1000 * 60 * 60);
                             if (horasDif < 24) esMismaConversacion = true;
                        } else {
                            // Fallback si la fecha no es parseable: asumimos nueva venta por seguridad
                            esMismaConversacion = false; 
                        }
                    }

                    // Preparamos datos (rellenando huecos con lo viejo si es update)
                    const datos = {
                        nombre: nombreFinal,
                        interes: info.interes && info.interes !== "null" ? info.interes : (esMismaConversacion ? leadExistente.interes : "General"),
                        ciudad: info.ciudad && info.ciudad !== "null" ? info.ciudad : (esMismaConversacion ? leadExistente.ciudad : "No indicada"),
                        correo: info.correo && info.correo !== "null" ? info.correo : (esMismaConversacion ? leadExistente.correo : "No indicado"),
                        etiqueta: info.etiqueta || "Lead"
                    };

                    if (esMismaConversacion) {
                        // ACTUALIZAR (UPDATE)
                        await db.run(
                            `UPDATE leads SET nombre=?, interes=?, etiqueta=?, ciudad=?, correo=?, fecha=? WHERE id = ?`,
                            [datos.nombre, datos.interes, datos.etiqueta, datos.ciudad, datos.correo, new Date().toLocaleString(), leadExistente.id]
                        );
                        console.log(`🔄 LEAD ACTUALIZADO (Misma sesión <24h): ${datos.nombre}`);
                    } else {
                        // CREAR NUEVO (INSERT)
                        await db.run(
                            `INSERT INTO leads (phone, nombre, interes, etiqueta, fecha, ciudad, correo) 
                             VALUES (?, ?, ?, ?, ?, ?, ?)`, 
                            [sessionId, datos.nombre, datos.interes, datos.etiqueta, new Date().toLocaleString(), datos.ciudad, datos.correo]
                        );
                        console.log(`✅ NUEVO LEAD CREADO: ${datos.nombre}`);
                    }
                }
            } catch(e) { console.error("⚠️ Error procesando JSON de Lorena:", e.message); }
        }

        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'bot', textoVisible, new Date().toISOString()]);
        return textoVisible;
    } catch (err) { 
        console.error("Error API IA:", err);
        return "Dame un segundo, estoy verificando la señal. ¿Me repites eso?"; 
    }
}

// ============================================================
// 5. API ENDPOINTS (RUTAS)
// ============================================================
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No autorizado");

app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isLogged = true;
        req.session.save(() => res.json({ success: true }));
    } else res.status(401).json({ success: false });
});

app.get('/api/data/:type', proteger, async (req, res) => {
    const t = req.params.type;
    try {
        if (t === 'leads') {
            const rows = await db.all("SELECT * FROM leads ORDER BY id DESC");
            return res.json(rows.map(r => ({ ...r, telefono: r.phone, fecha: r.fecha })));
        }
        if (t === 'config') return res.json({ 
            prompt: await getCfg('prompt', ""), 
            website_data: await getCfg('website_data', ""), 
            tech_rules: await getCfg('tech_rules', []) 
        });
        if (t === 'knowledge') return res.json(await db.all("SELECT * FROM inventory"));
        if (t === 'history') {
            const rows = await db.all("SELECT * FROM history ORDER BY id ASC");
            const grouped = rows.reduce((acc, curr) => {
                if(!acc[curr.phone]) acc[curr.phone] = [];
                acc[curr.phone].push({ role: curr.role, text: curr.text, time: curr.time });
                return acc;
            }, {});
            return res.json(grouped);
        }
        res.status(404).json([]);
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/leads/delete', proteger, async (req, res) => {
    await db.run("DELETE FROM leads WHERE id = ?", [req.body.id]);
    res.json({ success: true });
});

app.post('/api/save-prompt-web', proteger, async (req, res) => {
    if (req.body.prompt !== undefined) await setCfg('prompt', req.body.prompt);
    if (req.body.website_data !== undefined) await setCfg('website_data', req.body.website_data);
    res.json({ success: true });
});

app.post('/api/config/rules/add', proteger, async (req, res) => {
    let rules = await getCfg('tech_rules', []);
    if (req.body.rule) rules.push(req.body.rule);
    await setCfg('tech_rules', rules);
    res.json({ success: true, rules });
});

app.post('/api/config/rules/delete', proteger, async (req, res) => {
    let rules = await getCfg('tech_rules', []);
    rules.splice(req.body.index, 1);
    await setCfg('tech_rules', rules);
    res.json({ success: true, rules });
});

app.post('/api/contacts/add', proteger, async (req, res) => {
    await db.run("INSERT INTO metadata (phone, contactName, addedManual) VALUES (?, ?, 1) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName, addedManual=1", [req.body.phone, req.body.name]);
    res.json({ success: true });
});

app.post('/api/chat/action', proteger, async (req, res) => {
    const { phone, action, value } = req.body;
    if(action === 'pin') await db.run("INSERT INTO metadata (phone, pinned) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET pinned=excluded.pinned", [phone, value ? 1 : 0]);
    if(action === 'label') {
        const row = await db.get("SELECT labels FROM metadata WHERE phone = ?", [phone]);
        let labs = JSON.parse(row?.labels || "[]");
        if(value && !labs.includes(value)) labs.push(value);
        await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [phone, JSON.stringify(labs)]);
    }
    if(action === 'delete') {
        await db.run("DELETE FROM history WHERE phone = ?", [phone]);
        await db.run("DELETE FROM metadata WHERE phone = ?", [phone]);
    }
    res.json({ success: true });
});

app.post('/api/test-ai', proteger, async (req, res) => {
    try {
        const prompt = await getCfg('prompt', "");
        const web = await getCfg('website_data', "");
        const rules = await getCfg('tech_rules', []);
        const fullPrompt = `PERSONALIDAD: ${prompt}\nREGLAS: ${rules.join("\n")}\nWEB: ${web}\nUSER: "${req.body.message}"`;
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] });
        res.json({ response: r.data.candidates[0].content.parts[0].text, logic_log: fullPrompt });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats-full', proteger, async (req, res) => {
    const historyPhones = await db.all("SELECT DISTINCT phone FROM history");
    const metadataList = await db.all("SELECT * FROM metadata");
    const statusList = await db.all("SELECT * FROM bot_status");
    const phones = Array.from(new Set([...historyPhones.map(h=>h.phone), ...metadataList.map(m=>m.phone)]));
    const list = await Promise.all(phones.map(async id => {
        const lastMsg = await db.get("SELECT text, time FROM history WHERE phone = ? ORDER BY id DESC LIMIT 1", [id]);
        const meta = metadataList.find(m => m.phone === id) || {};
        const bStatus = statusList.find(s => s.phone === id);
        return {
            id,
            name: meta.contactName || id,
            lastMessage: lastMsg || { text: "Nuevo", time: new Date().toISOString() },
            botActive: bStatus ? bStatus.active === 1 : true,
            pinned: meta.pinned === 1,
            labels: JSON.parse(meta.labels || "[]"),
            timestamp: lastMsg ? lastMsg.time : new Date().toISOString()
        };
    }));
    list.sort((a,b) => (a.pinned === b.pinned) ? new Date(b.timestamp) - new Date(a.timestamp) : (a.pinned ? -1 : 1));
    res.json(list);
});

app.post('/api/chat/send', proteger, async (req, res) => {
    if(await enviarWhatsApp(req.body.phone, req.body.message)) {
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [req.body.phone, 'manual', req.body.message, new Date().toISOString()]);
        res.json({ success: true });
    } else res.status(500).json({ error: "Error" });
});

app.post('/api/chat/toggle-bot', proteger, async (req, res) => {
    await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, ?)", [req.body.phone, req.body.active ? 1 : 0]);
    res.json({ success: true });
});

app.post('/api/knowledge/csv', proteger, upload.single('file'), async (req, res) => {
    try {
        const n = parse(req.file.buffer.toString('utf-8'), { columns: true });
        for (const row of n) {
            const searchable = Object.values(row).join(" ");
            await db.run("INSERT OR IGNORE INTO inventory (searchable, raw_data) VALUES (?, ?)", [searchable, JSON.stringify(row)]);
        }
        await refreshKnowledge();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "CSV Error" }); }
});

app.post('/api/knowledge/delete', proteger, async (req, res) => {
    const items = await db.all("SELECT id FROM inventory");
    if (items[req.body.index]) {
        await db.run("DELETE FROM inventory WHERE id = ?", [items[req.body.index].id]);
        await refreshKnowledge();
    }
    res.json({ success: true });
});

app.get('/webhook', (req, res) => (req.query['hub.verify_token'] === 'ICC_2025' ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const value = req.body.entry?.[0]?.changes?.[0]?.value;
        const msg = value?.messages?.[0];
        if (value?.contacts?.[0]) {
            const cName = value.contacts[0].profile.name;
            const phone = value.contacts[0].wa_id;
            await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=contactName WHERE addedManual=0", [phone, cName]);
        }
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
app.use(express.static(__dirname, { index: false }));

app.listen(process.env.PORT || 10000, () => console.log("🚀 LORENA 7.9 SQL - BASE DE DATOS AUTOREPARABLE ACTIVADA"));
