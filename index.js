/*
 * SERVER BACKEND - VALENTINA v25.4 (STABLE + STREAMING FIX)
 * Cliente: Importadora Casa Colombia (ICC)
 * ============================================================
 * CORRECCIONES ACUMULADAS:
 * 1. Debounce: Fix para enviar mensaje después de la espera.
 * 2. Data Sanitization: Filtro para evitar "unknown" en la DB.
 * 3. Media Streaming: Solución definitiva para Fotos y Audios (Pipe).
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

// --- 1. CONFIGURACIÓN DEL SERVIDOR ---
const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } 
});

// COLA DE MENSAJES (DEBOUNCE)
const messageQueue = new Map(); 
const DEBOUNCE_TIME = 8000; 

// --- 2. VARIABLES DE ENTORNO ---
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-val-secure-v23"; 

const DEFAULT_PROMPT = `ERES VALENTINA, ASISTENTE DE VENTAS DE IMPORTADORA CASA COLOMBIA (ICC).`;

// --- 3. SESIONES ---
app.use(session({
    name: 'icc_session', 
    secret: SESSION_SECRET, 
    resave: false, 
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 } 
}));

const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No autorizado");

app.use((req, res, next) => {
    if ((req.path.endsWith('.json') || req.path.includes('/data/')) && !req.path.startsWith('/api/')) {
        return res.status(403).send('🚫 Acceso Denegado');
    }
    next();
});

// --- 4. BASE DE DATOS ---
let db, globalKnowledge = [], serverInstance;

(async () => {
    try {
        const DATA_DIR = path.resolve(__dirname, 'data');
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        
        db = await open({ 
            filename: path.join(DATA_DIR, 'database.db'), 
            driver: sqlite3.Database 
        });

        const tables = [
            `history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT)`,
            `leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, nombre TEXT, interes TEXT, etiqueta TEXT, fecha TEXT, ciudad TEXT, correo TEXT, source TEXT DEFAULT 'Organico', status_tag TEXT, farewell_sent INTEGER DEFAULT 0)`,
            `metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0, photoUrl TEXT, archived INTEGER DEFAULT 0, unreadCount INTEGER DEFAULT 0, last_interaction TEXT)`,
            `bot_status (phone TEXT PRIMARY KEY, active INTEGER DEFAULT 1)`,
            `inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT)`,
            `config (key TEXT PRIMARY KEY, value TEXT)`,
            `shortcuts (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT UNIQUE, text TEXT)`,
            `global_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, color TEXT)`,
            `knowledge_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, url TEXT, summary TEXT, active INTEGER DEFAULT 1, date TEXT)`
        ];

        for (const t of tables) await db.exec(`CREATE TABLE IF NOT EXISTS ${t}`);

        const migrations = ['photoUrl', 'archived', 'unreadCount', 'last_interaction'].map(c => `ALTER TABLE metadata ADD COLUMN ${c}`);
        migrations.push("ALTER TABLE leads ADD COLUMN source TEXT DEFAULT 'Organico'");
        migrations.push("ALTER TABLE leads ADD COLUMN status_tag TEXT");
        migrations.push("ALTER TABLE leads ADD COLUMN farewell_sent INTEGER DEFAULT 0");
        migrations.push('ALTER TABLE config ADD COLUMN logoUrl TEXT');

        for (const m of migrations) { try { await db.exec(m); } catch(e){} }

        await refreshKnowledge();
        iniciarCronJobs();

        const PORT = process.env.PORT || 10000;
        serverInstance = app.listen(PORT, () => console.log(`🔥 BACKEND v25.4 ONLINE (Port ${PORT})`));
        
        serverInstance.on('error', (e) => { 
            if(e.code === 'EADDRINUSE') {
                setTimeout(() => { serverInstance.close(); serverInstance.listen(PORT); }, 1000); 
            }
        });

    } catch (e) { console.error("❌ DB ERROR:", e); }
})();

// --- 5. UTILIDADES ---
async function refreshKnowledge() {
    try { 
        globalKnowledge = (await db.all("SELECT * FROM inventory")).map(r => ({ 
            searchable: r.searchable, 
            data: JSON.parse(r.raw_data) 
        })); 
    } catch(e) { globalKnowledge = []; }
}

async function getCfg(k, fb=null) { 
    const r = await db.get("SELECT value FROM config WHERE key = ?", [k]); 
    return r ? JSON.parse(r.value) : fb; 
}
async function setCfg(k, v) { 
    await db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [k, JSON.stringify(v)]); 
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function detectarFuente(mensaje) {
    if (!mensaje) return 'Organico';
    const msg = mensaje.toLowerCase();
    if (msg.includes('importadoracasacolombia.com')) return 'Web';
    if (msg.includes('storeicc.com') || msg.includes('deseo asesoría')) return 'Tienda Virtual';
    return 'Organico';
}

// --- 6. META API ---
async function uploadToMeta(buffer, mime, name) {
    try {
        const form = new FormData();
        const type = mime.includes('audio') || mime.includes('ogg') ? 'audio' : (mime.includes('image') ? 'image' : (mime.includes('video') ? 'video' : 'document'));
        form.append('file', buffer, { filename: name, contentType: mime });
        form.append('type', type); 
        form.append('messaging_product', 'whatsapp');
        const r = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_ID}/media`, form, { headers: { 'Authorization': `Bearer ${META_TOKEN}`, ...form.getHeaders() } });
        return r.data.id;
    } catch (e) { return null; }
}

async function enviarWhatsApp(to, content, type = "text") {
    try {
        const payload = { messaging_product: "whatsapp", to, type };
        if (type === "text") {
            payload.text = { body: content };
        } else if (content.id) {
            payload[type] = { id: content.id };
            if(type === 'document') payload[type].filename = 'Archivo Adjunto.pdf';
        } else {
            payload[type] = { link: content };
        }
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, payload, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
        console.log(`✅ Mensaje enviado a ${to}`);
        return true;
    } catch (e) { 
        console.error("❌ ERROR META:", e.response ? JSON.stringify(e.response.data) : e.message); 
        return false; 
    }
}

// --- PROXY DE MEDIOS (STREAMING - SOLUCIÓN FOTOS Y AUDIO) ---
app.get('/api/media-proxy/:id', proteger, async (req, res) => {
    try {
        // 1. Obtener la URL de descarga de Meta
        const { data: urlData } = await axios.get(`https://graph.facebook.com/v21.0/${req.params.id}`, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
        
        // 2. Iniciar el Stream (Tubería) Directo
        const response = await axios({
            method: 'GET',
            url: urlData.url,
            responseType: 'stream', // CLAVE: No cargar en memoria, usar stream
            headers: { 'Authorization': `Bearer ${META_TOKEN}` } 
        });

        // 3. Configurar cabeceras correctas para el navegador
        let contentType = response.headers['content-type'];
        if (contentType && (contentType.includes('audio') || contentType.includes('ogg'))) {
            contentType = 'audio/ogg'; // Forzar compatibilidad
        }

        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        if(response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);

        // 4. Conectar la tubería: Lo que entra de Meta -> sale al Navegador
        response.data.pipe(res);

    } catch (e) { 
        console.error("Media Proxy Error:", e.message);
        res.status(500).send("Error Media"); 
    }
});

// --- 7. CEREBRO IA ---
function limpiarRespuesta(txt) {
    let clean = txt.replace(/```json([\s\S]*?)```|{([\s\S]*?)}/gi, "").trim(); 
    return clean.replace(/[\r\n]+/g, "\n").trim();
}

async function procesarConValentina(dbMsg, aiMsg, phone, name = "Cliente", isFile = false) {
    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'user', dbMsg, new Date().toISOString()]);
    await db.run("INSERT INTO metadata (phone, archived, unreadCount, last_interaction) VALUES (?, 0, 1, ?) ON CONFLICT(phone) DO UPDATE SET archived=0, unreadCount = unreadCount + 1, last_interaction=excluded.last_interaction", [phone, new Date().toISOString()]);

    const bot = await db.get("SELECT active FROM bot_status WHERE phone = ?", [phone]);
    if (bot && bot.active === 0) return null;

    if (isFile) {
        const rFile = "¡Recibido! 📁 Lo reviso enseguida.";
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'bot', rFile, new Date().toISOString()]);
        return rFile;
    }

    let personalidadLorena = await getCfg('bot_prompt');
    const configUsar = (personalidadLorena && personalidadLorena.length > 5) ? personalidadLorena : DEFAULT_PROMPT;
    const webSources = await db.all("SELECT summary FROM knowledge_sources WHERE active = 1");
    const webContext = webSources.map(w => w.summary).join("\n\n");
    const techRules = await getCfg('tech_rules', []);
    const biz = await getCfg('biz_profile', {});
    const history = (await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id DESC LIMIT 15", [phone])).reverse();
    const lead = await db.get("SELECT * FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1", [phone]);
    
    let memoriaDatos = `DATOS CAPTURADOS:\n- Teléfono: ${phone}\n`;
    if (lead) {
        if (lead.nombre && lead.nombre !== "Cliente" && lead.nombre !== "null") memoriaDatos += `- Nombre: ${lead.nombre}\n`;
        if (lead.ciudad && lead.ciudad !== "null") memoriaDatos += `- Ciudad: ${lead.ciudad}\n`;
        if (lead.interes) memoriaDatos += `- Interés previo: ${lead.interes}\n`;
    } else {
        memoriaDatos += "- ESTADO: Cliente Nuevo (Falta Nombre y Ciudad).";
    }

    const busqueda = aiMsg.toLowerCase().split(" ").slice(0,3).join(" ");
    const stock = globalKnowledge.filter(i => (i.searchable||"").toLowerCase().includes(busqueda)).slice(0,5);

    const promptFinal = `
    === PERSONALIDAD Y REGLAS DE NEGOCIO ===
    ${configUsar}
    === CONTEXTO WEB (ICC) ===
    ${webContext || "No hay datos web extra."}
    === CONTEXTO TÉCNICO DEL CLIENTE ===
    ${memoriaDatos}
    === INVENTARIO DISPONIBLE (Referencia) ===
    ${JSON.stringify(stock)}
    === REGLAS TÉCNICAS ADICIONALES ===
    ${techRules.join("\n")}
    Horario: ${biz.hours || '8am-6pm'}
    === HISTORIAL ===
    ${JSON.stringify(history)}
    === INSTRUCCIÓN OBLIGATORIA DEL SISTEMA ===
    Al final de tu respuesta, SIEMPRE analiza si tienes datos nuevos del cliente y genera este JSON oculto.
    \`\`\`json
    {"es_lead": boolean, "nombre":"...", "interes":"...", "ciudad":"...", "correo":"...", "etiqueta":"Lead", "datos_completos": boolean}
    \`\`\`
    `;

    try {
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`, { contents: [{ parts: [{ text: promptFinal }] }] });
        const raw = r.data.candidates[0].content.parts[0].text;
        
        const match = raw.match(/```json([\s\S]*?)```|{([\s\S]*?)}/);
        if (match) {
            try {
                const info = JSON.parse((match[1]||match[0]).replace(/```json|```/g, "").trim());
                await gestionarLead(phone, info, name, lead, dbMsg); 
            } catch(e) {}
        }

        let reply = limpiarRespuesta(raw);
        if (!reply || reply.length < 2) reply = "¿En qué más te puedo ayudar?";
        
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'bot', reply, new Date().toISOString()]);
        return reply;

    } catch (e) { 
        console.error("AI Error:", e);
        return "Un momento, estoy validando esa información... 🔧"; 
    }
}

// --- GESTIÓN DE LEADS (ANTI-UNKNOWN) ---
async function gestionarLead(phone, info, fbName, oldLead, originalMsg) {
    const limpiarDato = (d) => (!d || /^(unknown|null|n\/a|no menciona|cliente|pend)$/i.test(d.toString().trim())) ? null : d.trim();

    let name = limpiarDato(info.nombre) || fbName;
    let ciudadLimpia = limpiarDato(info.ciudad); 
    let interesLimpio = limpiarDato(info.interes) || (oldLead ? oldLead.interes : "Consultando");

    let datosCompletos = (name !== fbName && ciudadLimpia !== null);
    let farewellReset = (datosCompletos && oldLead && !oldLead.fecha) ? ", farewell_sent = 0" : "";

    if (oldLead) {
        await db.run(`UPDATE leads SET nombre=?, interes=?, etiqueta=?, fecha=?, ciudad=?, correo=? ${farewellReset} WHERE id=?`, 
            [name, interesLimpio, info.etiqueta || oldLead.etiqueta, new Date().toISOString(), ciudadLimpia || oldLead.ciudad, info.correo || oldLead.correo, oldLead.id]);
        await db.run("UPDATE metadata SET contactName = ? WHERE phone = ?", [name, phone]);
    } else if (interesLimpio || ciudadLimpia || info.es_lead) {
        const fuente = detectarFuente(originalMsg);
        await db.run(`INSERT INTO leads (phone, nombre, interes, etiqueta, fecha, ciudad, correo, source, farewell_sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`, 
            [phone, name, interesLimpio, "Pendiente", new Date().toISOString(), ciudadLimpia, info.correo, fuente]);
        await db.run("UPDATE metadata SET contactName = ? WHERE phone = ?", [name, phone]);
    }
}

// --- 8. CRON JOBS (ANTI-UNKNOWN SQL) ---
function iniciarCronJobs() {
    setInterval(async () => {
        try {
            const now = new Date();
            const leadsTerminados = await db.all(`SELECT * FROM leads WHERE farewell_sent = 0 AND ciudad IS NOT NULL AND LOWER(ciudad) NOT IN ('unknown', 'null', 'n/a') AND nombre IS NOT NULL AND fecha < datetime('now', '-1 hour') AND fecha > datetime('now', '-24 hour')`);
            
            for (const l of leadsTerminados) {
                const meta = await db.get("SELECT last_interaction FROM metadata WHERE phone = ?", [l.phone]);
                const lastMsgDate = new Date(meta?.last_interaction || 0);
                if (now - lastMsgDate > 30 * 60 * 1000) {
                    const msgDespedida = "Hasta pronto, uno de nuestros ejecutivos comerciales se contactará con usted 🤝";
                    await enviarWhatsApp(l.phone, msgDespedida);
                    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [l.phone, 'bot', msgDespedida, now.toISOString()]);
                    await db.run("UPDATE leads SET farewell_sent = 1 WHERE id = ?", [l.id]);
                }
            }
            const olvidados = await db.all(`SELECT m.phone FROM metadata m LEFT JOIN leads l ON m.phone = l.phone WHERE l.id IS NULL AND m.last_interaction < datetime('now', '-24 hour') AND m.last_interaction > datetime('now', '-48 hour') AND m.archived = 0`);
            for (const o of olvidados) {
                const lastMsg = await db.get("SELECT role FROM history WHERE phone = ? ORDER BY id DESC LIMIT 1", [o.phone]);
                if (lastMsg && lastMsg.role === 'bot') {
                    const msgRecuerdo = "Hola 👋, noté que no terminamos nuestra consulta. ¿Sigues interesado en repuestos?";
                    await enviarWhatsApp(o.phone, msgRecuerdo);
                    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [o.phone, 'bot', msgRecuerdo, now.toISOString()]);
                    await db.run("UPDATE metadata SET last_interaction = ? WHERE phone = ?", [now.toISOString(), o.phone]);
                }
            }
        } catch (e) { console.error("Cron Error:", e); }
    }, 60000 * 5); 
}

// --- 9. RUTAS API ---
app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) { req.session.isLogged = true; res.json({success:true}); } else { res.status(401).json({success:false}); }
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.get('/api/config/prompt', proteger, async (req, res) => res.json({ prompt: await getCfg('bot_prompt', DEFAULT_PROMPT) }));
app.post('/api/config/prompt', proteger, async (req, res) => { await setCfg('bot_prompt', req.body.prompt); res.json({success:true}); });
app.get('/api/data/web-knowledge', proteger, async (req, res) => { res.json(await db.all("SELECT * FROM knowledge_sources ORDER BY id DESC")); });
app.post('/api/data/web-knowledge', proteger, async (req, res) => { await db.run("INSERT INTO knowledge_sources (type, url, summary, date) VALUES (?, ?, ?, ?)", ['web', req.body.url, req.body.summary, new Date().toLocaleString()]); res.json({success:true}); });
app.post('/api/data/web-knowledge/delete', proteger, async (req, res) => { await db.run("DELETE FROM knowledge_sources WHERE id = ?", [req.body.id]); res.json({success:true}); });

app.get('/api/chats-full', proteger, async (req, res) => {
    try {
        const view = req.query.view || 'active';
        const search = req.query.search ? `%${req.query.search}%` : null;
        let whereClause = '(m.archived = 0 OR m.archived IS NULL)';
        if (view === 'archived') whereClause = 'm.archived = 1';
        else if (view === 'unread') whereClause = 'm.unreadCount > 0 AND (m.archived = 0 OR m.archived IS NULL)';
        let params = [];
        if (search) { whereClause += ` AND (m.contactName LIKE ? OR h.phone LIKE ? OR h.text LIKE ?)`; params.push(search, search, search); }
        const query = `SELECT h.phone as id, MAX(h.id) as max_id, h.text as lastText, h.time as timestamp, m.contactName, m.photoUrl, m.labels, m.pinned, m.archived, m.unreadCount, b.active as botActive, l.source, l.status_tag FROM history h LEFT JOIN metadata m ON h.phone = m.phone LEFT JOIN bot_status b ON h.phone = b.phone LEFT JOIN leads l ON h.phone = l.phone WHERE ${whereClause} GROUP BY h.phone ORDER BY m.pinned DESC, max_id DESC LIMIT 50`;
        const rows = await db.all(query, params);
        res.json(rows.map(r => ({ id: r.id, name: r.contactName || r.id, lastMessage: { text: r.lastText, time: r.timestamp }, botActive: r.botActive !== 0, pinned: r.pinned === 1, archived: r.archived === 1, unreadCount: r.unreadCount || 0, labels: JSON.parse(r.labels || "[]"), photoUrl: r.photoUrl, timestamp: r.timestamp, source: r.source, statusTag: r.status_tag })));
    } catch(e) { res.status(500).json([]); }
});

app.get('/api/chat-history/:phone', proteger, async (req, res) => {
    await db.run("UPDATE metadata SET unreadCount = 0 WHERE phone = ?", [req.params.phone]);
    res.json(await db.all("SELECT * FROM history WHERE phone = ? ORDER BY id ASC", [req.params.phone]));
});

app.post('/api/chat/action', proteger, async (req, res) => {
    const { phone, action, value } = req.body;
    const cleanPhone = phone.replace(/\D/g, ''); 
    if(action === 'delete') { for(const t of ['history','metadata','bot_status','leads']) await db.run(`DELETE FROM ${t} WHERE phone=?`,[cleanPhone]); }
    else if(action === 'set_labels') {
        const etiquetasStr = JSON.stringify(value);
        await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [cleanPhone, etiquetasStr]);
        const tagPrincipal = value.length > 0 ? value[0].text : "Sin Etiqueta";
        await db.run("UPDATE leads SET status_tag = ? WHERE phone = ?", [tagPrincipal, cleanPhone]);
    }
    else if(action === 'toggle_pin') await db.run("INSERT INTO metadata (phone, pinned) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET pinned=excluded.pinned", [cleanPhone, value?1:0]);
    else if(action === 'toggle_archive') await db.run("INSERT INTO metadata (phone, archived) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET archived=excluded.archived", [cleanPhone, value?1:0]);
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
app.post('/api/chat/toggle-bot', proteger, async (req, res) => { await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, ?)", [req.body.phone, req.body.active?1:0]); res.json({success:true}); });
app.post('/api/config/rules/add', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.push(req.body.rule); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/config/rules/delete', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.splice(req.body.index,1); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/leads/update', proteger, async(req,res)=>{ await db.run(`UPDATE leads SET ${req.body.field}=? WHERE id=?`,[req.body.value, req.body.id]); res.json({success:true}); });
app.post('/api/leads/delete', proteger, async(req,res)=>{ await db.run("DELETE FROM leads WHERE id=?",[req.body.id]); res.json({success:true}); });
app.post('/api/knowledge/delete', proteger, async (req, res) => { const i=await db.all("SELECT id FROM inventory"); if(i[req.body.index]) await db.run("DELETE FROM inventory WHERE id=?",[i[req.body.index].id]); await refreshKnowledge(); res.json({success:true}); });
app.post('/api/knowledge/clear', proteger, async (req, res) => { await db.run("DELETE FROM inventory"); await refreshKnowledge(); res.json({success:true}); });
app.post('/api/knowledge/csv', proteger, upload.single('file'), async (req, res) => { try { const rows = parse(req.file.buffer.toString('utf-8'), { columns: true }); for (const row of rows) await db.run("INSERT OR IGNORE INTO inventory (searchable, raw_data) VALUES (?, ?)", [Object.values(row).join(" "), JSON.stringify(row)]); await refreshKnowledge(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: "CSV Error" }); } });

app.post('/api/chat/upload-send', proteger, upload.single('file'), async (req, res) => { try { const mid = await uploadToMeta(req.file.buffer, req.file.mimetype, req.file.originalname); if(mid) { await enviarWhatsApp(req.body.phone, { id: mid }, req.body.type); await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [req.body.phone, 'manual', `[MEDIA:${req.body.type.toUpperCase()}:${mid}]`, new Date().toISOString()]); await db.run("UPDATE metadata SET last_interaction = ? WHERE phone = ?", [new Date().toISOString(), req.body.phone]); res.json({success: true}); } else res.status(500).json({error: "Error Meta"}); } catch(e) { res.status(500).json({error: e.message}); } });
app.post('/api/chat/send', proteger, async (req, res) => { const { phone, message } = req.body; const cleanPhone = phone.replace(/\D/g, ''); try { const sent = await enviarWhatsApp(cleanPhone, message); if(sent) { await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [cleanPhone, 'manual', message, new Date().toISOString()]); await db.run(`INSERT INTO metadata (phone, contactName, addedManual, archived, unreadCount, last_interaction) VALUES (?, ?, 1, 0, 0, ?) ON CONFLICT(phone) DO UPDATE SET last_interaction=excluded.last_interaction`, [cleanPhone, cleanPhone, new Date().toISOString()]); res.json({ success: true }); } else res.status(500).json({ error: "Error enviando" }); } catch(e) { res.status(500).json({ error: "Error interno" }); } });

// --- WEBHOOK ---
app.get('/webhook', (req, res) => (req.query['hub.verify_token'] === 'ICC_2025' ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));

app.post('/webhook', async (req, res) => { 
    res.sendStatus(200); 
    try { 
        const val = req.body.entry?.[0]?.changes?.[0]?.value; 
        const msg = val?.messages?.[0]; 
        
        if (val?.contacts?.[0]) await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName WHERE addedManual=0", [val.contacts[0].wa_id, val.contacts[0].profile.name]); 
        
        if(msg) { 
            const phone = msg.from;
            let userMsg = msg.text?.body || "";
            let isFile = false;

            if(msg.type !== 'text') { isFile = true; userMsg = `[MEDIA:${msg.type.toUpperCase()}:${msg[msg.type].id}]`; } 
            
            if (messageQueue.has(phone)) { clearTimeout(messageQueue.get(phone).timer); }

            const currentData = messageQueue.get(phone) || { text: [], name: val?.contacts?.[0]?.profile.name || "Cliente" };
            currentData.text.push(userMsg); 

            // DEBOUNCE TIMER
            const timer = setTimeout(async () => {
                const fullText = currentData.text.join("\n"); 
                messageQueue.delete(phone); 

                const reply = await procesarConValentina(fullText, isFile ? '[ARCHIVO]' : fullText, phone, currentData.name, isFile); 
                
                if (reply) {
                    await enviarWhatsApp(phone, reply);
                }

            }, DEBOUNCE_TIME);

            currentData.timer = timer;
            messageQueue.set(phone, currentData);
        } 
    } catch(e) { console.error("Webhook Error", e); } 
});

process.on('SIGTERM', () => { if (serverInstance) serverInstance.close(() => process.exit(0)); else process.exit(0); });
process.on('SIGINT', () => { if (serverInstance) serverInstance.close(() => process.exit(0)); else process.exit(0); });
