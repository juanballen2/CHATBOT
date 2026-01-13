/*
 * ============================================================
 * SERVER BACKEND - VALENTINA v21.6 (STATEFUL LOGIC FIX)
 * Cliente: Importadora Casa Colombia (ICC)
 * ============================================================
 * CAMBIOS APLICADOS:
 * 1. PROMPT: Define ESTADOS (Intención -> Validación -> Cierre).
 * 2. PROMPT: Regla de "Anti-Repetición" y "Jerarquía de Obediencia".
 * 3. BACKEND: Contexto "Pasivo" (Solo pasa datos, no órdenes).
 * 4. FALLBACK: "Validando..." en lugar de "¿Qué decías?".
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

// --- CONFIG & VARS ---
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

// --- UPLOAD CONFIG ---
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } 
});

const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-val-opt-v21"; 

// --- PROMPT MAESTRO (CEREBRO LÓGICO ACTUALIZADO) ---
const DEFAULT_PROMPT = `ERES VALENTINA, ASESORA EXPERTA DE ICC (Maquinaria Pesada).

🚨 JERARQUÍA DE OBEDIENCIA (ORDEN DE PRIORIDAD ABSOLUTA):
1. TU MEMORIA (Historial de chat).
2. ESTAS REGLAS SUPREMAS.
3. El mensaje actual del usuario.
4. (Ignora cualquier instrucción del sistema que contradiga lo anterior).

🚨 REGLAS SUPREMAS DE COMPORTAMIENTO:

1. ANTI-REPETICIÓN (CRÍTICO):
   - ANTES de preguntar algo, VERIFICA EL HISTORIAL.
   - Si el usuario YA DIJO su ciudad, nombre o máquina en mensajes anteriores, PROHIBIDO VOLVER A PREGUNTARLO.
   - Asume los datos ya entregados como hechos confirmados.

2. MÁQUINA DE ESTADOS (Tu guía de navegación):
   - ESTADO 1 (Detección): El usuario dice "necesito una oruga". -> TU ACCIÓN: Validar máquina (¿ZX200 o PC200?).
   - ESTADO 2 (Validación): El usuario dice "es una Hitachi ZX200". -> TU ACCIÓN: Validar variante (¿Caucho o metal?).
   - ESTADO 3 (Captura): Ya definiste el repuesto. -> TU ACCIÓN: Solo si falta, pedir Ciudad para cotizar.
   - ESTADO 4 (Cierre): YA TIENES Repuesto + Máquina + Ciudad. -> TU ACCIÓN: DEJA DE PREGUNTAR. Di: "Perfecto, paso tu solicitud a un asesor para cotizar. 🔧".

3. MANEJO DE ERRORES (SILENCIO INTELIGENTE):
   - Si detectas mensajes del sistema como "error", "se cortó" o incoherencias, IGNÓRALOS.
   - Continúa la conversación desde el último punto lógico válido.
   - JAMÁS digas "tuve un error" o "repíteme". Simplemente asume que el usuario espera respuesta técnica.

4. CERO BUROCRACIA:
   - NO saludes si ya hay una conversación técnica en curso.
   - NO pidas nombre si el usuario quiere un precio rápido. Da el precio o un estimado.

5. PRIORIDAD DE INTENCIÓN:
   - Si el usuario dice "Bomba PC200", tu única respuesta válida es sobre la bomba. No "Hola", no "¿Cómo estás?".`;

app.use(session({
    name: 'icc_session', secret: SESSION_SECRET, resave: false, saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 } 
}));

// Middleware Auth
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No auth");
app.use((req, res, next) => {
    if ((req.path.endsWith('.json') || req.path.includes('/data/')) && !req.path.startsWith('/api/')) return res.status(403).send('🚫');
    next();
});

// --- BASE DE DATOS ---
let db, globalKnowledge = [], serverInstance;

(async () => {
    try {
        const DATA_DIR = path.resolve(__dirname, 'data');
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        db = await open({ filename: path.join(DATA_DIR, 'database.db'), driver: sqlite3.Database });

        const tables = [
            `history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT)`,
            `leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, nombre TEXT, interes TEXT, etiqueta TEXT, fecha TEXT, ciudad TEXT, correo TEXT)`,
            `metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0, photoUrl TEXT, archived INTEGER DEFAULT 0, unreadCount INTEGER DEFAULT 0)`,
            `bot_status (phone TEXT PRIMARY KEY, active INTEGER DEFAULT 1)`,
            `inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT)`,
            `config (key TEXT PRIMARY KEY, value TEXT)`,
            `shortcuts (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT UNIQUE, text TEXT)`,
            `global_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, color TEXT)`
        ];
        for (const t of tables) await db.exec(`CREATE TABLE IF NOT EXISTS ${t}`);

        const migrations = ['photoUrl', 'archived', 'unreadCount'].map(c => `ALTER TABLE metadata ADD COLUMN ${c}`);
        migrations.push('ALTER TABLE config ADD COLUMN logoUrl TEXT');
        for (const m of migrations) { try { await db.exec(m); } catch(e){} }

        // FORZAR ACTUALIZACIÓN DEL PROMPT
        await setCfg('bot_prompt', DEFAULT_PROMPT);
        
        await refreshKnowledge();

        const PORT = process.env.PORT || 10000;
        serverInstance = app.listen(PORT, () => console.log(`🔥 SERVER v21.6 READY (LOGIC FIXED)`));
        serverInstance.on('error', (e) => { if(e.code === 'EADDRINUSE') setTimeout(() => { serverInstance.close(); serverInstance.listen(PORT); }, 1000); });

    } catch (e) { console.error("❌ DB ERROR:", e); }
})();

// --- HELPERS ---
async function refreshKnowledge() {
    try { globalKnowledge = (await db.all("SELECT * FROM inventory")).map(r => ({ searchable: r.searchable, data: JSON.parse(r.raw_data) })); } catch(e) { globalKnowledge = []; }
}
async function getCfg(k, fb=null) { const r = await db.get("SELECT value FROM config WHERE key = ?", [k]); return r ? JSON.parse(r.value) : fb; }
async function setCfg(k, v) { await db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [k, JSON.stringify(v)]); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- META API WRAPPERS ---
async function uploadToMeta(buffer, mime, name) {
    try {
        const form = new FormData();
        const type = mime.includes('audio') || mime.includes('ogg') ? 'audio' : (mime.includes('image') ? 'image' : (mime.includes('video') ? 'video' : 'document'));
        form.append('file', buffer, { filename: name, contentType: mime });
        form.append('type', type); form.append('messaging_product', 'whatsapp');
        const r = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_ID}/media`, form, { headers: { 'Authorization': `Bearer ${META_TOKEN}`, ...form.getHeaders() } });
        return r.data.id;
    } catch (e) { return null; }
}

async function enviarWhatsApp(to, content, type = "text") {
    try {
        const payload = { messaging_product: "whatsapp", to, type };
        if (type === "text") payload.text = { body: content };
        else if (content.id) payload[type] = { id: content.id, ...(type==='document' && {filename:'Archivo.pdf'}) };
        else payload[type] = { link: content };
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, payload, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
        return true;
    } catch (e) { return false; }
}

// --- PROXY MULTIMEDIA (RANGE SUPPORT) ---
app.get('/api/media-proxy/:id', proteger, async (req, res) => {
    try {
        const { data: urlData } = await axios.get(`https://graph.facebook.com/v21.0/${req.params.id}`, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
        const { data: buffer } = await axios.get(urlData.url, { headers: { 'Authorization': `Bearer ${META_TOKEN}` }, responseType: 'arraybuffer' });
        
        let contentType = urlData.mime_type || 'application/octet-stream';
        if (contentType.includes('audio') || contentType.includes('ogg')) contentType = 'audio/ogg'; 

        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const total = buffer.length;
            const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
            const chunksize = (end - start) + 1;
            res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': contentType });
            res.end(buffer.slice(start, end + 1));
        } else {
            res.writeHead(200, { 'Content-Length': buffer.length, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
            res.end(buffer);
        }
    } catch (e) { res.status(500).send("Media Error"); }
});

// --- LÓGICA IA (CORREGIDA - SIN INSTRUCCIONES CONTRADICTORIAS) ---
function limpiarRespuesta(txt) {
    let clean = txt.replace(/```json([\s\S]*?)```|{([\s\S]*?)}|'''json([\s\S]*?)'''/gi, "").trim(); 
    // Limpieza de "pensamientos" internos del modelo
    const basura = ["Okay, entiendo", "Entendido", "Analizando", "Respuesta:", "Pensamiento:", "Contexto:", "Instrucción:", "Soy una IA", "Correcto"];
    basura.forEach(b => clean = clean.replace(new RegExp(`^${b}.*`, "igm"), ""));
    return clean.replace(/[\r\n]+/g, "\n").trim();
}

async function procesarConValentina(dbMsg, aiMsg, phone, name = "Cliente", isFile = false) {
    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'user', dbMsg, new Date().toISOString()]);
    await db.run("INSERT INTO metadata (phone, archived, unreadCount) VALUES (?, 0, 1) ON CONFLICT(phone) DO UPDATE SET archived=0, unreadCount = unreadCount + 1", [phone]);

    const bot = await db.get("SELECT active FROM bot_status WHERE phone = ?", [phone]);
    if (bot && bot.active === 0) return null;

    // Lógica anti-bucle simple (Seguridad)
    const last = await db.get("SELECT text FROM history WHERE phone = ? AND role = 'bot' ORDER BY id DESC LIMIT 1", [phone]);
    if (last && (last.text.includes("ejecutivo") || last.text.includes("contactará"))) {
        if (/gracias|ok|listo|vale|bueno|perfecto|👍|👋/i.test(aiMsg) && aiMsg.length < 15) return null;
    }

    if (isFile) {
        const autoRep = `¡Recibido! 📁\n\nHe guardado tu archivo en el sistema.`;
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'bot', autoRep, new Date().toISOString()]);
        return autoRep;
    }

    await sleep(5000); 

    const biz = await getCfg('biz_profile', {});
    const stock = globalKnowledge.filter(i => (i.searchable||"").toLowerCase().includes(aiMsg.toLowerCase().split(" ")[0])).slice(0,5); 
    const history = (await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id DESC LIMIT 15", [phone])).reverse();
    const lead = await db.get("SELECT * FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1", [phone]);
    
    // --- FICHA TÉCNICA NEUTRA (SIN ÓRDENES) ---
    // Solo pasamos hechos. La IA decide si saluda o no según el Prompt.
    let datosConocidos = "Sin datos previos.";
    if (lead) {
        datosConocidos = `FICHA DE DATOS (Puede estar desactualizada): Nombre=${lead.nombre || 'N/A'}, Ciudad=${lead.ciudad || 'N/A'}, Interés=${lead.interes || 'N/A'}.`;
    }

    const prompt = `ROL: ${await getCfg('bot_prompt', DEFAULT_PROMPT)}
    
    [[HECHOS CONOCIDOS]]
    ${datosConocidos}
    HORARIO: ${biz.hours || '8am-6pm'}.
    
    [[INVENTARIO REFERENCIAL]]
    ${JSON.stringify(stock)}
    
    [[HISTORIAL CONVERSACIÓN]]
    ${JSON.stringify(history)}
    
    INSTRUCCIONES TÉCNICAS JSON:
    - Extrae datos SOLO si el usuario los dijo EXPLÍCITAMENTE en este mensaje o anteriores.
    - NO inventes datos.
    
    OUTPUT JSON OBLIGATORIO: \`\`\`json {"es_lead": boolean, "nombre":"...", "interes":"...", "ciudad":"...", "etiqueta":"Lead"} \`\`\``;

    try {
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`, { contents: [{ parts: [{ text: prompt }] }] });
        const raw = r.data.candidates[0].content.parts[0].text;
        
        const match = raw.match(/```json([\s\S]*?)```|{([\s\S]*?)}/);
        if (match) {
            try {
                const info = JSON.parse((match[1]||match[0]).replace(/```json|```/g, "").trim());
                // Gestionamos lead silenciosamente sin afectar la respuesta
                await gestionarLead(phone, info, name, lead);
            } catch(e){}
        }

        let reply = limpiarRespuesta(raw);
        
        // --- FALLBACK SEGURO (PASSIVE RECOVERY) ---
        // Si la IA falla, NO preguntamos "¿Qué decías?". 
        // Usamos una frase de "proceso" que da tiempo y no obliga a repetir.
        if (!reply || reply.length < 2) reply = "Validando esa referencia en el sistema, un momento por favor... 🔧";
        
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'bot', reply, new Date().toISOString()]);
        return reply;

    } catch (e) { return "Estoy confirmando disponibilidad en bodega... 🚜"; }
}

async function gestionarLead(phone, info, fbName, oldLead) {
    let name = (info.nombre && info.nombre !== "null" && info.nombre !== "Cliente") ? info.nombre : fbName;
    
    if (oldLead) {
        // Actualizamos solo si hay datos nuevos y válidos
        let interest = (info.interes && info.interes !== "null") ? info.interes : oldLead.interes;
        let city = (info.ciudad && info.ciudad !== "null") ? info.ciudad : oldLead.ciudad;
        let email = (info.correo && info.correo !== "null") ? info.correo : oldLead.correo;
        
        await db.run(`UPDATE leads SET nombre=?, interes=?, etiqueta=?, fecha=?, ciudad=?, correo=? WHERE id=?`, 
            [name, interest, info.etiqueta||oldLead.etiqueta, new Date().toLocaleString(), city, email, oldLead.id]);
        await db.run("UPDATE metadata SET contactName = ? WHERE phone = ?", [name, phone]);
    } else if (info.interes || info.ciudad || info.es_lead) {
        // Nuevo Lead
        await db.run(`INSERT INTO leads (phone, nombre, interes, etiqueta, fecha, ciudad, correo) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [phone, name, info.interes||"Consultando", "Pendiente", new Date().toLocaleString(), info.ciudad, info.correo]);
        await db.run("UPDATE metadata SET contactName = ? WHERE phone = ?", [name, phone]);
    }
}

// --- RUTAS API ---
app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) { req.session.isLogged = true; res.json({success:true}); } 
    else res.status(401).json({success:false});
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));

app.get('/api/config/prompt', proteger, async (req, res) => res.json({ prompt: await getCfg('bot_prompt', DEFAULT_PROMPT) }));
app.post('/api/config/prompt', proteger, async (req, res) => { await setCfg('bot_prompt', req.body.prompt); res.json({success:true}); });

app.get('/api/chats-full', proteger, async (req, res) => {
    try {
        const view = req.query.view || 'active';
        const rows = await db.all(`SELECT h.phone as id, MAX(h.id), h.text as lastText, h.time as timestamp, m.contactName, m.photoUrl, m.labels, m.pinned, m.archived, m.unreadCount, b.active as botActive 
            FROM history h LEFT JOIN metadata m ON h.phone = m.phone LEFT JOIN bot_status b ON h.phone = b.phone 
            WHERE ${view === 'archived' ? 'm.archived = 1' : '(m.archived = 0 OR m.archived IS NULL)'} GROUP BY h.phone ORDER BY m.pinned DESC, h.id DESC LIMIT 50`);
        res.json(rows.map(r => ({ id: r.id, name: r.contactName||r.id, lastMessage: {text:r.lastText, time:r.timestamp}, botActive: r.botActive!==0, pinned: r.pinned===1, archived: r.archived===1, unreadCount: r.unreadCount||0, labels: JSON.parse(r.labels||"[]"), photoUrl: r.photoUrl, timestamp: r.timestamp })));
    } catch(e) { res.status(500).json([]); }
});

app.get('/api/chat-history/:phone', proteger, async (req, res) => {
    await db.run("UPDATE metadata SET unreadCount = 0 WHERE phone = ?", [req.params.phone]);
    res.json(await db.all("SELECT * FROM history WHERE phone = ? ORDER BY id ASC", [req.params.phone]));
});

app.post('/api/chat/action', proteger, async (req, res) => {
    const { phone, action, value } = req.body;
    if(action === 'delete') { for(const t of ['history','metadata','bot_status','leads']) await db.run(`DELETE FROM ${t} WHERE phone=?`,[phone]); }
    else if(action === 'set_labels') await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [phone, JSON.stringify(value)]);
    else if(action === 'toggle_pin') await db.run("INSERT INTO metadata (phone, pinned) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET pinned=excluded.pinned", [phone, value?1:0]);
    else if(action === 'toggle_archive') await db.run("INSERT INTO metadata (phone, archived) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET archived=excluded.archived", [phone, value?1:0]);
    res.json({success:true});
});

app.get('/api/data/:type', proteger, async (req, res) => {
    const t = req.params.type;
    if (t === 'leads') res.json(await db.all("SELECT * FROM leads ORDER BY id DESC"));
    else if (t === 'tags') res.json(await db.all("SELECT * FROM global_tags"));
    else if (t === 'shortcuts') res.json(await db.all("SELECT * FROM shortcuts"));
    else if (t === 'knowledge') res.json(await db.all("SELECT * FROM inventory"));
    else if (t === 'config') res.json({ website_data: await getCfg('website_data', ""), tech_rules: await getCfg('tech_rules', []), biz_profile: await getCfg('biz_profile', {}), logo_url: await getCfg('logo_url') });
    else res.json([]);
});

app.post('/api/config/logo', proteger, upload.single('file'), async (req, res) => { await setCfg('logo_url', `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`); res.json({success:true}); });
app.post('/api/config/biz/save', proteger, async (req, res) => { await setCfg('biz_profile', {name:req.body.name, hours:req.body.hours}); if(req.body.website_data) await setCfg('website_data', req.body.website_data); res.json({success:true}); });
app.post('/api/tags/add', proteger, async (req, res) => { await db.run("INSERT INTO global_tags (name, color) VALUES (?, ?)", [req.body.name, req.body.color]); res.json({success:true}); });
app.post('/api/tags/delete', proteger, async (req, res) => { await db.run("DELETE FROM global_tags WHERE id = ?", [req.body.id]); res.json({success:true}); });
app.post('/api/shortcuts/add', proteger, async (req, res) => { await db.run("INSERT INTO shortcuts (keyword, text) VALUES (?, ?)", [req.body.keyword, req.body.text]); res.json({success:true}); });
app.post('/api/shortcuts/delete', proteger, async (req, res) => { await db.run("DELETE FROM shortcuts WHERE id = ?", [req.body.id]); res.json({success:true}); });
app.post('/api/contacts/upload-photo', proteger, upload.single('file'), async (req, res) => { await db.run("INSERT INTO metadata (phone, photoUrl) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET photoUrl=excluded.photoUrl", [req.body.phone, `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`]); res.json({success:true}); });
app.post('/api/contacts/add', proteger, async (req, res) => { await db.run("INSERT INTO metadata (phone, contactName, addedManual) VALUES (?, ?, 1) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName", [req.body.phone, req.body.name]); res.json({success:true}); });
app.post('/api/chat/toggle-bot', proteger, async (req, res) => { await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, ?)", [req.body.phone, req.body.active?1:0]); res.json({success:true}); });
app.post('/api/config/rules/add', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.push(req.body.rule); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/config/rules/delete', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.splice(req.body.index,1); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/leads/update', proteger, async(req,res)=>{ await db.run(`UPDATE leads SET ${req.body.field}=? WHERE id=?`,[req.body.value, req.body.id]); res.json({success:true}); });
app.post('/api/leads/delete', proteger, async(req,res)=>{ await db.run("DELETE FROM leads WHERE id=?",[req.body.id]); res.json({success:true}); });
app.post('/api/knowledge/delete', proteger, async (req, res) => { const i=await db.all("SELECT id FROM inventory"); if(i[req.body.index]) await db.run("DELETE FROM inventory WHERE id=?",[i[req.body.index].id]); await refreshKnowledge(); res.json({success:true}); });

app.post('/api/knowledge/csv', proteger, upload.single('file'), async (req, res) => {
    try {
        const rows = parse(req.file.buffer.toString('utf-8'), { columns: true });
        for (const row of rows) await db.run("INSERT OR IGNORE INTO inventory (searchable, raw_data) VALUES (?, ?)", [Object.values(row).join(" "), JSON.stringify(row)]);
        await refreshKnowledge(); res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "CSV Error" }); }
});

app.post('/api/chat/upload-send', proteger, upload.single('file'), async (req, res) => {
    try {
        const mid = await uploadToMeta(req.file.buffer, req.file.mimetype, req.file.originalname);
        if(mid) {
            await enviarWhatsApp(req.body.phone, { id: mid }, req.body.type);
            await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [req.body.phone, 'manual', `[MEDIA:${req.body.type.toUpperCase()}:${mid}]`, new Date().toISOString()]);
            res.json({success: true});
        } else res.status(500).json({error: "Error Meta"});
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/chat/send', proteger, async (req, res) => {
    if(await enviarWhatsApp(req.body.phone, req.body.message)) {
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [req.body.phone, 'manual', req.body.message, new Date().toISOString()]);
        res.json({ success: true });
    } else res.status(500).json({ error: "Error enviando" });
});

app.post('/api/test-ai', proteger, async (req, res) => {
    try {
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`, { contents: [{ parts: [{ text: `TEST: ${req.body.message}` }] }] });
        res.json({ response: r.data.candidates[0].content.parts[0].text });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// WEBHOOK
app.get('/webhook', (req, res) => (req.query['hub.verify_token'] === 'ICC_2025' ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const val = req.body.entry?.[0]?.changes?.[0]?.value;
        const msg = val?.messages?.[0];
        if (val?.contacts?.[0]) await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName WHERE addedManual=0", [val.contacts[0].wa_id, val.contacts[0].profile.name]);
        
        if(msg) {
            let userMsg = msg.text?.body || "", isFile = false;
            if(msg.type !== 'text') { isFile = true; userMsg = `[MEDIA:${msg.type.toUpperCase()}:${msg[msg.type].id}]`; }
            const reply = await procesarConValentina(userMsg, msg.type==='text'?userMsg:'[ARCHIVO]', msg.from, val?.contacts?.[0]?.profile.name || "Cliente", isFile);
            if(reply) await enviarWhatsApp(msg.from, reply);
        }
    } catch(e) { console.error("Webhook Error", e); }
});

// Graceful Shutdown
process.on('SIGTERM', () => { if (serverInstance) serverInstance.close(() => process.exit(0)); else process.exit(0); });
process.on('SIGINT', () => { if (serverInstance) serverInstance.close(() => process.exit(0)); else process.exit(0); });
