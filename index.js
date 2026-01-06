/*
 * ============================================================
 * SERVER BACKEND - VALENTINA v17.0 (FULL UNCOMPRESSED)
 * Cliente: Importadora Casa Colombia (ICC)
 * Novedades: Contador de Mensajes + Inyección de Contexto + Anti-Duplicados
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

// --- CONFIGURACIÓN DE CARGA ---
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

const app = express();
app.set('trust proxy', 1);

// --- VARIABLES DE ENTORNO ---
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-valentina-secret-final-v17"; 

// --- PERSONALIDAD POR DEFECTO (Respaldo) ---
const DEFAULT_PROMPT = `ROL: Eres Valentina, asesora comercial de Importadora Casa Colombia.
OBJETIVO: Recopilar Nombre, Celular, Correo y Ciudad.
REGLAS: No uses comillas. Si saludan, saluda. Si piden repuesto, pide datos. No des precios sin tener los datos.`;

// --- MIDDLEWARES ---
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

// Seguridad de Archivos
app.use((req, res, next) => {
    if ((req.path.endsWith('.json') || req.path.includes('/data/')) && !req.path.startsWith('/api/')) {
        return res.status(403).send('🚫 Acceso Prohibido');
    }
    next();
});

// --- BASE DE DATOS ---
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
        CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, nombre TEXT, interes TEXT, etiqueta TEXT, fecha TEXT, ciudad TEXT, correo TEXT); 
        CREATE TABLE IF NOT EXISTS metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0, photoUrl TEXT, archived INTEGER DEFAULT 0, unreadCount INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS bot_status (phone TEXT PRIMARY KEY, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT);
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS shortcuts (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT UNIQUE, text TEXT);
        CREATE TABLE IF NOT EXISTS global_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, color TEXT);
    `);
    
    // 2. Migraciones (Silent) para compatibilidad
    try { await db.exec(`ALTER TABLE metadata ADD COLUMN photoUrl TEXT`); } catch(e) {}
    try { await db.exec(`ALTER TABLE metadata ADD COLUMN archived INTEGER DEFAULT 0`); } catch(e) {}
    try { await db.exec(`ALTER TABLE metadata ADD COLUMN unreadCount INTEGER DEFAULT 0`); } catch(e) {} // NUEVO v17.0
    try { await db.exec(`ALTER TABLE config ADD COLUMN logoUrl TEXT`); } catch(e) {}
    
    const cols = ['nombre', 'interes', 'etiqueta', 'fecha', 'ciudad', 'correo'];
    for (const c of cols) { try { await db.exec(`ALTER TABLE leads ADD COLUMN ${c} TEXT`); } catch (e) {} }

    // 3. Inicializar Prompt si no existe
    const currentPrompt = await getCfg('bot_prompt');
    if(!currentPrompt) {
        await setCfg('bot_prompt', DEFAULT_PROMPT);
    }

    await refreshKnowledge();
    console.log("🚀 BACKEND v17.0 ONLINE (NOTIFICATIONS + CONTEXT)");
})();

// Caché de Conocimiento
let globalKnowledge = [];
async function refreshKnowledge() {
    try {
        const rows = await db.all("SELECT * FROM inventory");
        globalKnowledge = rows.map(r => ({ searchable: r.searchable, data: JSON.parse(r.raw_data) }));
    } catch(e) { globalKnowledge = []; }
}

async function getCfg(key, fallback=null) {
    try {
        const res = await db.get("SELECT value FROM config WHERE key = ?", [key]);
        return res ? JSON.parse(res.value) : fallback;
    } catch(e) { return fallback; }
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

// --- META API UTILS ---
async function uploadToMeta(buffer, mimeType, filename) {
    try {
        const form = new FormData();
        let finalMime = mimeType, finalName = filename, type = 'document';
        if (mimeType.includes('audio') || mimeType.includes('webm') || mimeType.includes('ogg')) {
            type = 'audio'; finalMime = 'audio/ogg'; finalName = 'audio.ogg'; 
        } else if (mimeType.includes('image')) { type = 'image'; }
        else if (mimeType.includes('video')) { type = 'video'; }

        form.append('file', buffer, { filename: finalName, contentType: finalMime });
        form.append('type', type);
        form.append('messaging_product', 'whatsapp');
        
        const response = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, form, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}`, ...form.getHeaders() }
        });
        return response.data.id;
    } catch (error) { return null; }
}

async function enviarWhatsApp(destinatario, contenido, tipo = "text") {
    try {
        let payload = { messaging_product: "whatsapp", to: destinatario, type: tipo };
        if (tipo === "text") { payload.text = { body: contenido }; } 
        else if (contenido.id) { 
            if(tipo === 'image') payload.image = { id: contenido.id };
            if(tipo === 'document') payload.document = { id: contenido.id, filename: "Archivo.pdf" };
            if(tipo === 'audio') payload.audio = { id: contenido.id };
            if(tipo === 'video') payload.video = { id: contenido.id }; 
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

app.get('/api/media-proxy/:id', async (req, res) => {
    if (!req.session.isLogged) return res.status(401).send("No auth");
    try {
        const urlRes = await axios.get(`https://graph.facebook.com/v21.0/${req.params.id}`, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
        const media = await axios.get(urlRes.data.url, { headers: { 'Authorization': `Bearer ${META_TOKEN}` }, responseType: 'stream' });
        if (urlRes.data.mime_type) res.setHeader('Content-Type', urlRes.data.mime_type);
        media.data.pipe(res);
    } catch (e) { res.status(500).send("Error Media"); }
});

// --- CEREBRO IA (VALENTINA) ---
function buscarEnCatalogo(query) {
    if (!query || typeof query !== 'string' || query.startsWith('[')) return [];
    const norm = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    const q = norm(query).split(" ");
    return globalKnowledge.map(item => {
        let score = 0; const itemText = norm(item.searchable || ""); 
        q.forEach(w => { if (itemText.includes(w)) score++; });
        return { ...item, score };
    }).filter(i => i.score > 0).sort((a,b) => b.score - a.score).slice(0, 5);
}

// === [CORRECCIÓN v17.0: INYECCIÓN DE CONTEXTO + NOTIFICACIONES] ===
async function procesarConValentina(message, sessionId, mediaDesc = "", contactName = "Cliente") {
    // 1. Guardar mensaje del usuario
    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'user', mediaDesc || message, new Date().toISOString()]);
    
    // 2. ACTUALIZAR METADATA: Desarchivar Y Aumentar contador de no leídos (NUEVO)
    await db.run("INSERT INTO metadata (phone, archived, unreadCount) VALUES (?, 0, 1) ON CONFLICT(phone) DO UPDATE SET archived=0, unreadCount = unreadCount + 1", [sessionId]);

    const status = await db.get("SELECT active FROM bot_status WHERE phone = ?", [sessionId]);
    if (status && status.active === 0) return null;

    // 3. CARGAR DATOS (Incluyendo Contexto de Negocio NUEVO)
    const bizProfile = await getCfg('biz_profile', {});
    const websiteData = await getCfg('website_data', "No hay información extra configurada."); // <--- AQUI VIAJAN LAS SEDES Y HORARIOS
    const stock = buscarEnCatalogo(message); 
    const chatPrevio = (await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id DESC LIMIT 15", [sessionId])).reverse();
    const dynamicPrompt = await getCfg('bot_prompt', DEFAULT_PROMPT);

    const finalPrompt = `
    ${dynamicPrompt}

    // --- 🌍 CONTEXTO DE NEGOCIO (VERDAD SUPREMA) ---
    NOMBRE EMPRESA: ${bizProfile.name || 'Importadora Casa Colombia'}
    HORARIOS, SEDES Y DATOS CLAVE: 
    """
    ${websiteData}
    """
    *Instrucción:* Si preguntan algo que está en este bloque (horario, sedes), RESPONDE usando esta información.

    // --- ⚙️ DATOS TÉCNICOS ---
    CLIENTE: ${contactName}
    INVENTARIO RELACIONADO: ${JSON.stringify(stock)}
    HISTORIAL: ${JSON.stringify(chatPrevio)}
    MENSAJE ENTRANTE: ${message}

    FORMATO JSON OBLIGATORIO AL FINAL DE LA RESPUESTA:
    \`\`\`json {"es_lead": boolean, "nombre":"...", "celular":"...", "interes":"...", "ciudad":"...", "correo":"...", "etiqueta":"Lead|Pendiente"} \`\`\`
    `;

    try {
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: finalPrompt }] }] });
        
        let txt = r.data.candidates[0].content.parts[0].text;
        
        // Extracción JSON
        const match = txt.match(/```json([\s\S]*?)```|{([\s\S]*?)}$/i);
        let visible = txt;
        
        if (match) {
            visible = txt.replace(match[0], "").trim();
            try {
                const jsonStr = (match[1]||match[2]||match[0]).replace(/```json/g,"").replace(/```/g,"").trim();
                const info = JSON.parse(jsonStr);
                
                // Si hay datos útiles, gestionamos (Anti-Duplicados v16.7)
                if(info.nombre || info.celular || info.interes || info.correo || info.ciudad) {
                    await gestionarLead(sessionId, info, contactName);
                }
            } catch(e) {}
        }
        
        // Limpieza
        visible = visible.replace(/^["']+|["']+$/g, '').trim();
        if (!visible || visible.length < 2) {
            visible = "¡Entendido! 🛠️ Estoy validando tu solicitud. Por favor confírmame tus datos para continuar.";
        }
        
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'bot', visible, new Date().toISOString()]);
        return visible;
    } catch (e) { return "Dame un momento, estoy verificando la información... 🚜"; }
}

// === [LÓGICA ANTI-DUPLICADOS (MANTENIDA)] ===
async function gestionarLead(phone, info, fallbackName) {
    let nombreFinal = (info.nombre && info.nombre !== "null") ? info.nombre : fallbackName;
    
    // 1. Verificar si ya existe
    const existe = await db.get("SELECT id, interes, ciudad, correo, etiqueta FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1", [phone]);

    if (existe) {
        // 2. ACTUALIZAR
        const nuevoInteres = info.interes || existe.interes;
        const nuevaCiudad = info.ciudad || existe.ciudad;
        const nuevoCorreo = info.correo || existe.correo;
        const nuevaEtiqueta = (info.etiqueta && info.etiqueta !== "Pendiente") ? info.etiqueta : existe.etiqueta;

        await db.run(`UPDATE leads SET nombre=?, interes=?, etiqueta=?, fecha=?, ciudad=?, correo=? WHERE id=?`, 
            [nombreFinal, nuevoInteres, nuevaEtiqueta, new Date().toLocaleString(), nuevaCiudad, nuevoCorreo, existe.id]);
            
    } else {
        // 3. CREAR
        if (info.interes || info.correo || info.ciudad || info.es_lead) {
            await db.run(`INSERT INTO leads (phone, nombre, interes, etiqueta, fecha, ciudad, correo) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
                [phone, nombreFinal, info.interes || "Consultando", info.etiqueta || "Pendiente", new Date().toLocaleString(), info.ciudad, info.correo]);
        }
    }
    
    // Etiquetas visuales
    if(info.etiqueta) {
        try {
            const row = await db.get("SELECT labels FROM metadata WHERE phone = ?", [phone]);
            let currentLabels = JSON.parse(row?.labels || "[]");
            if(!currentLabels.includes(info.etiqueta) && info.etiqueta !== "Pendiente") {
                currentLabels.push(info.etiqueta);
                await db.run("UPDATE metadata SET labels = ? WHERE phone = ?", [JSON.stringify(currentLabels), phone]);
            }
        } catch(e){}
    }
}

// ============================================================
// API ENDPOINTS (TODOS COMPLETOS)
// ============================================================
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No auth");

app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isLogged = true;
        req.session.save(() => res.json({ success: true }));
    } else res.status(401).json({ success: false });
});

// ENDPOINTS DE PERSONALIDAD
app.get('/api/config/prompt', proteger, async (req, res) => {
    const prompt = await getCfg('bot_prompt', DEFAULT_PROMPT);
    res.json({ prompt });
});

app.post('/api/config/prompt', proteger, async (req, res) => {
    await setCfg('bot_prompt', req.body.prompt);
    res.json({ success: true });
});

// --- ENDPOINT CHATS (MODIFICADO v17.0: DEVUELVE UNREAD COUNT) ---
app.get('/api/chats-full', proteger, async (req, res) => {
    try {
        const view = req.query.view || 'active'; 
        const whereClause = view === 'archived' ? 'm.archived = 1' : '(m.archived = 0 OR m.archived IS NULL)';
        const query = `
            SELECT h.phone as id, MAX(h.id) as max_id, h.text as lastText, h.time as timestamp,
                m.contactName, m.photoUrl, m.labels, m.pinned, m.archived, m.unreadCount, b.active as botActive
            FROM history h
            LEFT JOIN metadata m ON h.phone = m.phone
            LEFT JOIN bot_status b ON h.phone = b.phone
            WHERE ${whereClause}
            GROUP BY h.phone
            ORDER BY m.pinned DESC, h.id DESC
            LIMIT 50
        `;
        const rows = await db.all(query);
        res.json(rows.map(r => ({
            id: r.id, name: r.contactName || r.id, lastMessage: { text: r.lastText, time: r.timestamp },
            botActive: r.botActive !== 0, pinned: r.pinned === 1, archived: r.archived === 1,
            unreadCount: r.unreadCount || 0, // <--- DATO NUEVO PARA EL FRONT
            labels: JSON.parse(r.labels || "[]"), photoUrl: r.photoUrl || null, timestamp: r.timestamp
        })));
    } catch(e) { res.status(500).json([]); }
});

// --- ENDPOINT HISTORIAL (MODIFICADO v17.0: RESETEA EL CONTADOR) ---
app.get('/api/chat-history/:phone', proteger, async (req, res) => {
    // Al pedir el historial, significa que el humano abrió el chat -> Resetear a 0
    await db.run("UPDATE metadata SET unreadCount = 0 WHERE phone = ?", [req.params.phone]);
    res.json(await db.all("SELECT * FROM history WHERE phone = ? ORDER BY id ASC", [req.params.phone]));
});

app.post('/api/chat/action', proteger, async (req, res) => {
    const { phone, action, value } = req.body;
    try {
        if(action === 'set_labels') {
            await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [phone, JSON.stringify(value)]);
        }
        else if(action === 'toggle_pin') {
            await db.run("INSERT INTO metadata (phone, pinned) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET pinned=excluded.pinned", [phone, value ? 1 : 0]);
        }
        else if(action === 'toggle_archive') {
            await db.run("INSERT INTO metadata (phone, archived) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET archived=excluded.archived", [phone, value ? 1 : 0]);
        }
        else if(action === 'delete') {
            await db.run("DELETE FROM history WHERE phone=?",[phone]);
            await db.run("DELETE FROM metadata WHERE phone=?",[phone]);
            await db.run("DELETE FROM bot_status WHERE phone=?",[phone]);
            await db.run("DELETE FROM leads WHERE phone=?",[phone]);
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:type', proteger, async (req, res) => {
    const t = req.params.type;
    try {
        if (t === 'leads') return res.json(await db.all("SELECT * FROM leads ORDER BY id DESC"));
        if (t === 'config') return res.json({ 
            website_data: await getCfg('website_data', ""), tech_rules: await getCfg('tech_rules', []),
            biz_profile: await getCfg('biz_profile', {}), logo_url: await getCfg('logo_url', null)
        });
        if (t === 'tags') return res.json(await db.all("SELECT * FROM global_tags"));
        if (t === 'shortcuts') return res.json(await db.all("SELECT * FROM shortcuts"));
        if (t === 'knowledge') return res.json(await db.all("SELECT * FROM inventory"));
        res.json([]);
    } catch(e) { res.json([]); }
});

app.post('/api/config/logo', proteger, upload.single('file'), async (req, res) => {
    if(!req.file) return res.status(400).send("No file");
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await setCfg('logo_url', b64);
    res.json({success:true, url: b64});
});
app.post('/api/config/biz/save', proteger, async (req, res) => { 
    await setCfg('biz_profile', { name: req.body.name, hours: req.body.hours });
    if(req.body.website_data !== undefined) await setCfg('website_data', req.body.website_data);
    res.json({success:true}); 
});

app.post('/api/tags/add', proteger, async (req, res) => { await db.run("INSERT INTO global_tags (name, color) VALUES (?, ?)", [req.body.name, req.body.color]); res.json({success:true}); });
app.post('/api/tags/delete', proteger, async (req, res) => { await db.run("DELETE FROM global_tags WHERE id = ?", [req.body.id]); res.json({success:true}); });
app.post('/api/shortcuts/add', proteger, async (req, res) => { await db.run("INSERT INTO shortcuts (keyword, text) VALUES (?, ?)", [req.body.keyword, req.body.text]); res.json({success:true}); });
app.post('/api/shortcuts/delete', proteger, async (req, res) => { await db.run("DELETE FROM shortcuts WHERE id = ?", [req.body.id]); res.json({success:true}); });

app.post('/api/contacts/upload-photo', proteger, upload.single('file'), async (req, res) => {
    if(!req.file) return res.status(400).send("No file");
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await db.run("INSERT INTO metadata (phone, photoUrl) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET photoUrl=excluded.photoUrl", [req.body.phone, b64]);
    res.json({success:true});
});
app.post('/api/contacts/add', proteger, async (req, res) => {
    await db.run("INSERT INTO metadata (phone, contactName, addedManual) VALUES (?, ?, 1) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName, addedManual=1", [req.body.phone, req.body.name]);
    res.json({ success: true, phone: req.body.phone });
});

app.post('/api/chat/upload-send', proteger, upload.single('file'), async (req, res) => {
    try {
        const { phone, type } = req.body; 
        if(!req.file) return res.status(400).json({error: "No file"});
        const mediaId = await uploadToMeta(req.file.buffer, req.file.mimetype, req.file.originalname);
        if(mediaId) {
            await enviarWhatsApp(phone, { id: mediaId }, type);
            await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'manual', `[MEDIA:${type.toUpperCase()}:${mediaId}]`, new Date().toISOString()]);
            await db.run("UPDATE metadata SET archived = 0 WHERE phone = ?", [phone]);
            res.json({success: true});
        } else { res.status(500).json({error: "Error Meta"}); }
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/chat/send', proteger, async (req, res) => {
    if(await enviarWhatsApp(req.body.phone, req.body.message)) {
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [req.body.phone, 'manual', req.body.message, new Date().toISOString()]);
        await db.run("UPDATE metadata SET archived = 0 WHERE phone = ?", [req.body.phone]);
        res.json({ success: true });
    } else res.status(500).json({ error: "Error enviando" });
});

app.post('/api/chat/toggle-bot', proteger, async (req, res) => {
    await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, ?)", [req.body.phone, req.body.active ? 1 : 0]);
    res.json({ success: true });
});

app.post('/api/config/rules/add', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.push(req.body.rule); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/config/rules/delete', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.splice(req.body.index,1); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/leads/update', proteger, async(req,res)=>{ const{id,field,value}=req.body; await db.run(`UPDATE leads SET ${field}=? WHERE id=?`,[value,id]); res.json({success:true}); });
app.post('/api/leads/delete', proteger, async(req,res)=>{ await db.run("DELETE FROM leads WHERE id=?",[req.body.id]); res.json({success:true}); });

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

app.post('/api/test-ai', proteger, async (req, res) => {
    try {
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: `TEST: ${req.body.message}` }] }] });
        res.json({ response: r.data.candidates[0].content.parts[0].text });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/webhook', (req, res) => (req.query['hub.verify_token'] === 'ICC_2025' ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const val = req.body.entry?.[0]?.changes?.[0]?.value;
        const msg = val?.messages?.[0];
        let contactName = "Cliente";
        if (val?.contacts?.[0]) {
            contactName = val.contacts[0].profile.name;
            await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName WHERE addedManual=0", [val.contacts[0].wa_id, contactName]);
        }
        if(msg) {
            let userMsg = "", mediaDesc = "";
            if (msg.type === "text") userMsg = msg.text.body;
            else if (msg.type === "image") { userMsg = `[MEDIA:IMAGE:${msg.image.id}]`; mediaDesc = "📷 FOTO"; }
            else if (msg.type === "audio") { userMsg = `[MEDIA:AUDIO:${msg.audio.id}]`; mediaDesc = "🎤 AUDIO"; }
            else if (msg.type === "document") { userMsg = `[MEDIA:DOC:${msg.document.id}]`; mediaDesc = "📄 DOC"; }

            const respuesta = await procesarConValentina(mediaDesc || userMsg, msg.from, userMsg, contactName); 
            if(respuesta) await enviarWhatsApp(msg.from, respuesta);
        }
    } catch(e) { console.error("Error Webhook", e); }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => req.session.isLogged ? res.redirect('/') : res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.use(express.static(__dirname, { index: false }));

app.listen(process.env.PORT || 10000, () => console.log("🔥 SERVER v17.0 READY"));
