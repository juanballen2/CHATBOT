/*
 * ============================================================
 * SERVER BACKEND - VALENTINA v13.5 (STABLE FIX)
 * Importadora Casa Colombia (ICC)
 * ============================================================
 */

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

// Configuración de Multer (Subida de archivos en memoria)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB Límite
});

const app = express();
app.set('trust proxy', 1);

// ============================================================
// 1. VARIABLES DE ENTORNO Y CONFIGURACIÓN
// ============================================================
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-valentina-secret-v13-final"; 

// Middleware: Aumentamos límites para Videos/Audios pesados
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

// Middleware de Seguridad: Protege archivos internos
app.use((req, res, next) => {
    if ((req.path.endsWith('.json') || req.path.includes('/data/')) && !req.path.startsWith('/api/')) {
        return res.status(403).send('🚫 Acceso Prohibido');
    }
    next();
});

// ============================================================
// 2. BASE DE DATOS (SQLITE)
// ============================================================
let db;
(async () => {
    const DATA_DIR = path.resolve(__dirname, 'data');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    db = await open({
        filename: path.join(DATA_DIR, 'database.db'),
        driver: sqlite3.Database
    });

    // Definición de Tablas
    await db.exec(`
        CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT);
        CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, nombre TEXT, interes TEXT, etiqueta TEXT, fecha TEXT, ciudad TEXT, correo TEXT); 
        CREATE TABLE IF NOT EXISTS metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0, photoUrl TEXT);
        CREATE TABLE IF NOT EXISTS bot_status (phone TEXT PRIMARY KEY, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT);
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS shortcuts (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT UNIQUE, text TEXT);
        CREATE TABLE IF NOT EXISTS global_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, color TEXT);
    `);
    
    // Migraciones automáticas (Por si vienes de una versión anterior)
    try { await db.exec(`ALTER TABLE metadata ADD COLUMN photoUrl TEXT`); } catch(e) {}
    
    // Columnas de leads
    const cols = ['nombre', 'interes', 'etiqueta', 'fecha', 'ciudad', 'correo'];
    for (const c of cols) { try { await db.exec(`ALTER TABLE leads ADD COLUMN ${c} TEXT`); } catch (e) {} }

    await refreshKnowledge();
    console.log("🚀 BACKEND v13.5 ONLINE - (DB OK)");
})();

// Caché de inventario en memoria para velocidad
let globalKnowledge = [];
async function refreshKnowledge() {
    try {
        const rows = await db.all("SELECT * FROM inventory");
        globalKnowledge = rows.map(r => ({ searchable: r.searchable, data: JSON.parse(r.raw_data) }));
    } catch(e) { globalKnowledge = []; }
}

// Helpers de Configuración
async function getCfg(key, fallback) {
    const res = await db.get("SELECT value FROM config WHERE key = ?", [key]);
    return res ? JSON.parse(res.value) : fallback;
}
async function setCfg(key, value) {
    await db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]);
}

// Configuración de Sesión
app.use(session({
    name: 'icc_session',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } 
}));

// ============================================================
// 3. MOTOR DE WHATSAPP (ENVÍO Y SUBIDA)
// ============================================================

// Función Crítica: Subir archivos a Meta (Con Fix de Audio OGG)
async function uploadToMeta(buffer, mimeType, filename) {
    try {
        const form = new FormData();
        
        let finalMime = mimeType;
        let finalName = filename;
        let type = 'document';

        // Lógica de detección de tipo forzada
        if (mimeType.includes('audio') || mimeType.includes('webm') || mimeType.includes('ogg')) {
            // FIX: WhatsApp requiere audio/ogg para notas de voz
            type = 'audio';
            finalMime = 'audio/ogg'; 
            finalName = 'audio.ogg'; // Nombre genérico para asegurar compatibilidad
            console.log(`🎤 Subiendo Audio: Convertido a ${finalMime}`);
        } else if (mimeType.includes('image')) {
            type = 'image';
        } else if (mimeType.includes('video')) {
            type = 'video';
        }

        form.append('file', buffer, { filename: finalName, contentType: finalMime });
        form.append('type', type);
        form.append('messaging_product', 'whatsapp');
        
        const response = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, form, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}`, ...form.getHeaders() }
        });
        return response.data.id;
    } catch (error) { 
        console.error("Meta Upload Error:", error.response?.data || error.message);
        return null; 
    }
}

// Función de Envío de Mensajes
async function enviarWhatsApp(destinatario, contenido, tipo = "text") {
    try {
        let payload = { messaging_product: "whatsapp", to: destinatario, type: tipo };
        
        if (tipo === "text") { 
            payload.text = { body: contenido }; 
        } else if (contenido.id) { 
            // Envío por ID (Media ya subida)
            if(tipo === 'image') payload.image = { id: contenido.id };
            if(tipo === 'document') payload.document = { id: contenido.id, filename: "Archivo.pdf" };
            if(tipo === 'audio') payload.audio = { id: contenido.id };
            if(tipo === 'video') payload.video = { id: contenido.id }; 
        } else {
            // Envío por URL
            if(tipo === 'image') payload.image = { link: contenido };
            if(tipo === 'document') payload.document = { link: contenido };
        }
        
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, payload, { 
            headers: { 'Authorization': `Bearer ${META_TOKEN}` } 
        });
        return true;
    } catch (e) { 
        console.error("WhatsApp Send Error:", e.response?.data || e.message);
        return false; 
    }
}

// Proxy para ver archivos multimedia en el navegador
app.get('/api/media-proxy/:id', async (req, res) => {
    if (!req.session.isLogged) return res.status(401).send("No auth");
    try {
        // 1. Obtener URL de descarga
        const urlRes = await axios.get(`https://graph.facebook.com/v21.0/${req.params.id}`, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}` }
        });
        // 2. Descargar Stream
        const media = await axios.get(urlRes.data.url, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}` },
            responseType: 'stream'
        });
        if (urlRes.data.mime_type) res.setHeader('Content-Type', urlRes.data.mime_type);
        media.data.pipe(res);
    } catch (e) { res.status(500).send("Error Media"); }
});

// ============================================================
// 4. CEREBRO IA (VALENTINA)
// ============================================================

// Búsqueda difusa en inventario
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

// Procesamiento principal con Gemini
async function procesarConValentina(message, sessionId, mediaDesc = "") {
    // Guardar mensaje usuario
    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'user', mediaDesc || message, new Date().toISOString()]);
    
    // Chequear si el bot está activo
    const status = await db.get("SELECT active FROM bot_status WHERE phone = ?", [sessionId]);
    if (status && status.active === 0) return null;

    // Recuperar contexto
    const websiteData = await getCfg('website_data', "");
    const bizProfile = await getCfg('biz_profile', {});
    const techRules = await getCfg('tech_rules', []);
    const stock = buscarEnCatalogo(message);
    const chatPrevio = (await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id DESC LIMIT 15", [sessionId])).reverse();

    // Prompt del Sistema
    const prompt = `
    Eres Valentina, IA de ${bizProfile.name || 'Importadora Casa Colombia (ICC)'}.
    
    [DATOS NEGOCIO]
    - Horario: ${bizProfile.hours || 'No definido'}
    - Web/Info: ${websiteData}
    
    [OBJETIVO]
    Filtrar al cliente obteniendo: Nombre, Ciudad e Interés (Repuesto/Máquina).
    NO cierres ventas, solo perfila.
    
    [TONO]
    Formal, "usted", corto y conciso. Una sola pregunta a la vez.

    [INVENTARIO REF]: ${JSON.stringify(stock)}
    [REGLAS TÉCNICAS]: ${techRules.join(". ")}

    [DETECTAR DATOS]
    Si el cliente da datos nuevos, añade este JSON al final de tu respuesta:
    \`\`\`json
    {"es_lead":true,"nombre":"...","ciudad":"...","interes":"...","correo":"...","etiqueta":"Cotización"}
    \`\`\`
    `;

    try {
        const resAI = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt + `\nCHAT PREVIO:\n${JSON.stringify(chatPrevio)}\nUSUARIO:${message}` }] }] });

        let fullText = resAI.data.candidates[0].content.parts[0].text;
        
        // Extracción de JSON (Datos Lead)
        const match = fullText.match(/```json([\s\S]*?)```|{([\s\S]*?)}$/i);
        let textoVisible = fullText;

        if (match) {
            textoVisible = fullText.replace(match[0], "").trim();
            try {
                const info = JSON.parse((match[1]||match[2]||match[0]).replace(/```json/g,"").replace(/```/g,"").trim());
                if(info.es_lead) await gestionarLead(sessionId, info);
            } catch(e) {}
        }
        
        // Guardar respuesta bot
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'bot', textoVisible, new Date().toISOString()]);
        return textoVisible;
    } catch (err) { 
        console.error("Gemini Error:", err.message);
        return "Disculpa, dame un momento, estoy validando la información."; 
    }
}

// Guardado/Actualización de Leads
async function gestionarLead(phone, info) {
    let nombre = info.nombre !== "null" ? info.nombre : "Cliente";
    await db.run(`INSERT INTO leads (phone, nombre, interes, etiqueta, fecha, ciudad, correo) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
        [phone, nombre, info.interes, info.etiqueta, new Date().toLocaleString(), info.ciudad, info.correo]);
}

// ============================================================
// 5. API ENDPOINTS (RUTAS DEL SERVIDOR)
// ============================================================

// Middleware de Autenticación
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No auth");

// Login
app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isLogged = true;
        req.session.save(() => res.json({ success: true }));
    } else res.status(401).json({ success: false });
});

// --- RUTAS DE DATOS (GET) ---
app.get('/api/data/:type', proteger, async (req, res) => {
    const t = req.params.type;
    try {
        if (t === 'leads') return res.json(await db.all("SELECT * FROM leads ORDER BY id DESC"));
        if (t === 'config') return res.json({ 
            website_data: await getCfg('website_data', ""), 
            tech_rules: await getCfg('tech_rules', []),
            biz_profile: await getCfg('biz_profile', {})
        });
        if (t === 'tags') return res.json(await db.all("SELECT * FROM global_tags"));
        if (t === 'shortcuts') return res.json(await db.all("SELECT * FROM shortcuts"));
        if (t === 'knowledge') return res.json(await db.all("SELECT * FROM inventory"));
        if (t === 'history') {
            const rows = await db.all("SELECT * FROM history ORDER BY id ASC");
            const grouped = rows.reduce((acc, curr) => { (acc[curr.phone] = acc[curr.phone] || []).push(curr); return acc; }, {});
            return res.json(grouped);
        }
        res.json([]);
    } catch(e) { res.json([]); }
});

// --- LISTA DE CHATS COMPLETA (CON FOTO Y STATUS) ---
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
            photoUrl: meta.photoUrl || null, // URL Base64 de la foto
            timestamp: lastMsg ? lastMsg.time : new Date().toISOString()
        };
    }));
    // Ordenar por fecha reciente
    list.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(list);
});

// --- GESTIÓN DE ETIQUETAS (ADD/DELETE) ---
app.post('/api/tags/add', proteger, async (req, res) => {
    try { await db.run("INSERT INTO global_tags (name, color) VALUES (?, ?)", [req.body.name, req.body.color]); res.json({success:true}); } catch(e){res.status(400).send("Error");}
});
app.post('/api/tags/delete', proteger, async (req, res) => {
    await db.run("DELETE FROM global_tags WHERE id = ?", [req.body.id]);
    res.json({success:true});
});

// --- GESTIÓN DE ATAJOS (ADD/DELETE) ---
app.post('/api/shortcuts/add', proteger, async (req, res) => {
    try { await db.run("INSERT INTO shortcuts (keyword, text) VALUES (?, ?)", [req.body.keyword, req.body.text]); res.json({success:true}); } catch(e) { res.status(400).json({error: "Existe"}); }
});
app.post('/api/shortcuts/delete', proteger, async (req, res) => {
    await db.run("DELETE FROM shortcuts WHERE id = ?", [req.body.id]);
    res.json({success:true});
});

// --- GESTIÓN DE CONTACTOS Y FOTOS ---
app.post('/api/contacts/upload-photo', proteger, upload.single('file'), async (req, res) => {
    if(!req.file) return res.status(400).send("No file");
    console.log("📸 Guardando Foto Perfil:", req.body.phone);
    // Convertir a Base64 para almacenar en DB
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await db.run("INSERT INTO metadata (phone, photoUrl) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET photoUrl=excluded.photoUrl", [req.body.phone, b64]);
    res.json({success:true});
});
app.post('/api/contacts/add', proteger, async (req, res) => {
    await db.run("INSERT INTO metadata (phone, contactName, addedManual) VALUES (?, ?, 1) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName, addedManual=1", [req.body.phone, req.body.name]);
    res.json({ success: true, phone: req.body.phone });
});

// --- ACCIONES DE CHAT (SUBIR ARCHIVO, ENVIAR TXT, ETIQUETAR) ---
app.post('/api/chat/upload-send', proteger, upload.single('file'), async (req, res) => {
    try {
        const { phone, type } = req.body; 
        if(!req.file) return res.status(400).json({error: "No file"});
        
        // Subir a Meta y obtener ID
        const mediaId = await uploadToMeta(req.file.buffer, req.file.mimetype, req.file.originalname);
        
        if(mediaId) {
            await enviarWhatsApp(phone, { id: mediaId }, type);
            let tag = `[MEDIA:${type.toUpperCase()}:${mediaId}]`;
            await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'manual', tag, new Date().toISOString()]);
            res.json({success: true});
        } else {
            res.status(500).json({error: "Error Meta"});
        }
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/chat/send', proteger, async (req, res) => {
    if(await enviarWhatsApp(req.body.phone, req.body.message)) {
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [req.body.phone, 'manual', req.body.message, new Date().toISOString()]);
        res.json({ success: true });
    } else res.status(500).json({ error: "Error enviando" });
});

app.post('/api/chat/action', proteger, async (req, res) => {
    const { phone, action, value } = req.body;
    if(action === 'set_labels') await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [phone, JSON.stringify(value)]);
    if(action === 'delete') { await db.run("DELETE FROM history WHERE phone=?",[phone]); await db.run("DELETE FROM metadata WHERE phone=?",[phone]); }
    res.json({ success: true });
});

app.post('/api/chat/toggle-bot', proteger, async (req, res) => {
    console.log(`🤖 Toggle Bot: ${req.body.phone} -> ${req.body.active}`);
    await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, ?)", [req.body.phone, req.body.active ? 1 : 0]);
    res.json({ success: true });
});

// --- CONFIGURACIÓN Y LEADS ---
app.post('/api/config/biz/save', proteger, async (req, res) => { await setCfg('biz_profile', req.body); await setCfg('website_data', req.body.website_data); res.json({success:true}); });
app.post('/api/config/rules/add', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.push(req.body.rule); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/config/rules/delete', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.splice(req.body.index,1); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/leads/update', proteger, async(req,res)=>{ const{id,field,value}=req.body; await db.run(`UPDATE leads SET ${field}=? WHERE id=?`,[value,id]); res.json({success:true}); });
app.post('/api/leads/delete', proteger, async(req,res)=>{ await db.run("DELETE FROM leads WHERE id=?",[req.body.id]); res.json({success:true}); });

// --- INVENTARIO ---
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
    if (items[req.body.index]) { await db.run("DELETE FROM inventory WHERE id = ?", [items[req.body.index].id]); await refreshKnowledge(); }
    res.json({ success: true });
});

// --- SANDBOX (TEST IA) ---
app.post('/api/test-ai', proteger, async (req, res) => {
    try {
        const fullPrompt = `ERES VALENTINA (Modo Test). USER: "${req.body.message}"`;
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] });
        res.json({ response: r.data.candidates[0].content.parts[0].text, logic_log: fullPrompt });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 6. WEBHOOK DE META (RECEPCIÓN DE MENSAJES)
// ============================================================
app.get('/webhook', (req, res) => (req.query['hub.verify_token'] === 'ICC_2025' ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const val = req.body.entry?.[0]?.changes?.[0]?.value;
        const msg = val?.messages?.[0];
        
        // Guardar nombre del contacto si viene en el webhook
        if (val?.contacts?.[0]) {
            await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=contactName WHERE addedManual=0", [val.contacts[0].wa_id, val.contacts[0].profile.name]);
        }

        if(msg) {
            let userMsg = "";
            let mediaDesc = "";

            if (msg.type === "text") {
                userMsg = msg.text.body;
            } else if (msg.type === "image") {
                userMsg = `[MEDIA:IMAGE:${msg.image.id}]`; 
                mediaDesc = "📷 FOTO RECIBIDA";
            } else if (msg.type === "video") { 
                userMsg = `[MEDIA:VIDEO:${msg.video.id}]`; 
                mediaDesc = "🎥 VIDEO RECIBIDO";
            } else if (msg.type === "document") {
                userMsg = `[MEDIA:DOC:${msg.document.id}]`;
                mediaDesc = "📄 DOCUMENTO RECIBIDO";
            } else if (msg.type === "audio") {
                userMsg = `[MEDIA:AUDIO:${msg.audio.id}]`;
                mediaDesc = "🎤 AUDIO RECIBIDO";
            }

            const inputIA = mediaDesc ? `(El usuario envió: ${mediaDesc})` : userMsg;
            const respuesta = await procesarConValentina(inputIA, msg.from, userMsg); 
            
            if(respuesta) await enviarWhatsApp(msg.from, respuesta);
        }
    } catch(e) { console.error("Webhook Error:", e); }
});

// ============================================================
// 7. INICIO DE SERVIDOR Y RUTAS ESTÁTICAS
// ============================================================
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => req.session.isLogged ? res.redirect('/') : res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.use(express.static(__dirname, { index: false }));

app.listen(process.env.PORT || 10000, () => console.log("🔥 VALENTINA v13.5 READY"));
