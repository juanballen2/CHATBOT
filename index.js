/*
 * SERVER BACKEND - v34.1 (CORE INTEGRA: BÚSQUEDA GLOBAL 8K + PDF NATIVO SALESFORCE)
 * ============================================================
 * 1. FIX: Inyección de busyTimeout (10s) para SQLite.
 * 2. ADD: Soporte Omnicanal Inteligente en /api/chat/send.
 * 3. ADD: Soporte completo para Videos MP4 y Fotos en Campañas.
 * 4. FIX: Integración real con JSFORCE y Pool Singleton para +10 usuarios simultáneos.
 * 5. FIX: Traductor de LeadSource y limpieza del '57' en teléfonos.
 * 6. ADD: Los comentarios ahora crean un chat separado (ID_comentarios).
 * 7. FIX: Sanitización Regex en rutas Bulk/Action para DMs originales.
 * 8. ADD: Rutas Nativas para Extractor Inteligente (/extractor).
 * 9. FIX: Re-ingeniería del Webhook Omnicanal para capturar Ecos.
 * 10. ADD: Rutas de verificación de Lead y creación de Tareas (Tasks).
 * 11. FIX: Estado de Tareas configurado en 'Open'.
 * 12. FIX: Manejo robusto de errores y sanitización Anti-Markdown en Gemini 2.5 Flash.
 * 13. FIX: Solución al bucle de Login forzando req.session.save().
 * 14. FIX: Emisión Socket.io en tiempo real al etiquetar y gestionar tags/config.
 * 15. ADD: Retorno de metadatos de registro existente en /api/extractor/salesforce para crear Tareas.
 * 16. FIX PRODUCTOS: Filtro Product2.IsActive = true (oculta vendidas), LIMIT 150, búsqueda global y sinónimos (EXC/EXCAVADORA).
 * 17. ADD PDF NATIVO SF: Descarga directa desde QuoteTemplate (quoteTemplateDataViewer.apexp) e inserción en QuoteDocument.
 * ============================================================
 */

const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io'); 
const session = require('express-session');
const fs = require('fs');
const fsPromises = fs.promises; 
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx'); 
const { parse } = require('csv-parse/sync');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const jsforce = require('jsforce'); 

// --- 1. CONFIGURACIÓN DEL SERVIDOR ---
const app = express();
const server = http.createServer(app); 
const io = new Server(server, {        
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } 
});

const messageQueue = new Map(); 
const DEBOUNCE_TIME = 4500; 

// --- 2. VARIABLES DE ENTORNO ---
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID; 
const IG_TOKEN = process.env.IG_TOKEN; 
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icbot-secure-v29-final"; 
const VERIFY_TOKEN = "ICC_2025"; 

const SF_USER = process.env.SF_USERNAME || 'marketing@casacolombia.com.co';
const SF_PASS = process.env.SF_PASSWORD || 'Crm2026..';
const SF_TOKEN = process.env.SF_TOKEN || 'IRKsWeCW6ooQw4ORheVQmLRt';

const DEFAULT_PROMPT = `Eres Lorena, Asistente Comercial de Importadora Casa Colombia. Tu objetivo principal es atender al cliente, resolver sus dudas y perfilarlo recopilando sus datos para pasarlo a un asesor humano.
REGLA DE ORO: NUNCA ASUMAS EL NOMBRE DEL CLIENTE. Si el cliente no te ha dicho explícitamente "Me llamo X", debes preguntárselo obligatoriamente (Nombre y Apellido) para su registro.`;

// --- 2.1 POOL DE CONEXIÓN PERSISTENTE A SALESFORCE (SOPORTE MULTI-USUARIO) ---
let cachedSfConn = null;
let sfLastLoginTime = 0;
let sfLoginPromise = null;
let cachedQuoteTemplates = null;

async function getSfConnection() {
    const now = Date.now();
    if (cachedSfConn && (now - sfLastLoginTime < 45 * 60 * 1000)) {
        return cachedSfConn;
    }
    if (sfLoginPromise) return sfLoginPromise;

    sfLoginPromise = (async () => {
        try {
            const conn = new jsforce.Connection({ loginUrl: 'https://login.salesforce.com' });
            await conn.login(SF_USER, SF_PASS + SF_TOKEN);
            cachedSfConn = conn;
            sfLastLoginTime = Date.now();
            console.log("⚡ Sesión de Salesforce iniciada / renovada en el Pool.");
            return conn;
        } finally {
            sfLoginPromise = null;
        }
    })();

    return sfLoginPromise;
}

async function runSfOperation(fn) {
    try {
        const conn = await getSfConnection();
        return await fn(conn);
    } catch (err) {
        if (err.errorCode === 'INVALID_SESSION_ID' || (err.message && err.message.includes('Session expired'))) {
            cachedSfConn = null;
            const conn = await getSfConnection();
            return await fn(conn);
        }
        throw err;
    }
}

// Descubre automáticamente los IDs (0EH...) de las Plantillas de Presupuesto en Salesforce
async function getSfQuoteTemplates(conn) {
    if (cachedQuoteTemplates && cachedQuoteTemplates.length > 0) return cachedQuoteTemplates;
    try {
        const metaList = await conn.metadata.list([{ type: 'QuoteTemplate' }]);
        const arr = Array.isArray(metaList) ? metaList : (metaList ? [metaList] : []);
        cachedQuoteTemplates = arr.map(t => ({
            id: t.id,
            fullName: t.fullName,
            cleanName: (t.fullName || '').replace(/_/g, ' ')
        }));
        return cachedQuoteTemplates;
    } catch (e) {
        console.error("⚠️ No se pudieron listar QuoteTemplates por Metadata API:", e.message);
        return [];
    }
}

function normalizeStrMatch(s) {
    return (s || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

// Descarga el binario PDF renderizado por el motor nativo de plantillas de Salesforce
async function fetchOfficialSalesforcePdf(conn, quoteId, templateId) {
    if (!templateId) return null;
    const targetPath = `/quote/quoteTemplateDataViewer.apexp?id=${quoteId}&summlid=${templateId}`;
    let currentUrl = `${conn.instanceUrl}${targetPath}`;
    let cookieHeader = `sid=${conn.accessToken}`;

    for (let hop = 0; hop < 5; hop++) {
        const res = await axios.get(currentUrl, {
            headers: {
                'Cookie': cookieHeader,
                'Authorization': `Bearer ${conn.accessToken}`,
                'User-Agent': 'Mozilla/5.0'
            },
            responseType: 'arraybuffer',
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400
        });

        if (res.headers['set-cookie']) {
            const newCookies = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
            cookieHeader = `${cookieHeader}; ${newCookies}`;
        }

        if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307) {
            let loc = res.headers.location;
            if (!loc) break;
            if (loc.startsWith('/')) {
                const u = new URL(currentUrl);
                loc = `${u.protocol}//${u.host}${loc}`;
            }
            currentUrl = loc;
            continue;
        }

        const buf = Buffer.from(res.data);
        if (buf.length > 4 && buf.slice(0, 4).toString() === '%PDF') {
            return buf;
        }
        break;
    }
    return null;
}

// --- 3. SESIONES ---
app.use(session({
    name: 'icc_session_id', 
    secret: SESSION_SECRET, 
    resave: true, 
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 86400000 } 
}));

const proteger = (req, res, next) => {
    if (req.session.isLogged) next();
    else res.status(401).send("No autorizado.");
};

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

        await db.exec("PRAGMA journal_mode = WAL;");
        await db.exec("PRAGMA synchronous = NORMAL;");
        await db.configure('busyTimeout', 10000); 
        
        console.log("📂 Base de Datos Conectada de forma segura.");

        const tables = [
            `history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT, msg_type TEXT DEFAULT 'dm', media_id TEXT)`,
            `leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, nombre TEXT, interes TEXT, producto_especifico TEXT, etiqueta TEXT, fecha TEXT, ciudad TEXT, departamento TEXT, correo TEXT, source TEXT DEFAULT 'Organico', status_tag TEXT, farewell_sent INTEGER DEFAULT 0, followup_day INTEGER DEFAULT 0, sf_id TEXT)`,
            `metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0, photoUrl TEXT, archived INTEGER DEFAULT 0, unreadCount INTEGER DEFAULT 0, last_interaction TEXT, channel TEXT DEFAULT 'whatsapp')`,
            `bot_status (phone TEXT PRIMARY KEY, active INTEGER DEFAULT 1)`,
            `inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT)`,
            `config (key TEXT PRIMARY KEY, value TEXT)`,
            `shortcuts (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT UNIQUE, text TEXT)`,
            `global_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, color TEXT)`,
            `knowledge_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, url TEXT, summary TEXT, active INTEGER DEFAULT 1, date TEXT)`,
            `templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, category TEXT, language TEXT, data TEXT)`
        ];

        for (const t of tables) await db.exec(`CREATE TABLE IF NOT EXISTS ${t}`);

        const migrations = [
            "ALTER TABLE metadata ADD COLUMN photoUrl TEXT",
            "ALTER TABLE metadata ADD COLUMN archived INTEGER DEFAULT 0",
            "ALTER TABLE metadata ADD COLUMN unreadCount INTEGER DEFAULT 0",
            "ALTER TABLE metadata ADD COLUMN last_interaction TEXT",
            "ALTER TABLE metadata ADD COLUMN channel TEXT DEFAULT 'whatsapp'",
            "ALTER TABLE leads ADD COLUMN source TEXT DEFAULT 'Organico'",
            "ALTER TABLE leads ADD COLUMN status_tag TEXT",
            "ALTER TABLE leads ADD COLUMN farewell_sent INTEGER DEFAULT 0",
            "ALTER TABLE config ADD COLUMN logoUrl TEXT",
            "ALTER TABLE leads ADD COLUMN departamento TEXT",
            "ALTER TABLE leads ADD COLUMN producto_especifico TEXT",
            "ALTER TABLE leads ADD COLUMN followup_day INTEGER DEFAULT 0",
            "ALTER TABLE leads ADD COLUMN sf_id TEXT",
            "ALTER TABLE history ADD COLUMN msg_type TEXT DEFAULT 'dm'",
            "ALTER TABLE history ADD COLUMN media_id TEXT"
        ];
        for (const m of migrations) { try { await db.exec(m); } catch(e){} }

        const indexes = [
            "CREATE INDEX IF NOT EXISTS idx_history_phone ON history(phone)",
            "CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone)",
            "CREATE INDEX IF NOT EXISTS idx_metadata_phone ON metadata(phone)"
        ];
        for (const idx of indexes) { try { await db.exec(idx); } catch(e){} }

        await refreshKnowledge();
        iniciarCronJobs();
        await verificarTokenMeta();     
        await escanearFuentesHistoricas(); 

        const PORT = process.env.PORT || 10000;
        serverInstance = server.listen(PORT, () => console.log(`🔥 BACKEND ONLINE (Port ${PORT})`));

    } catch (e) { console.error("❌ DB FATAL ERROR:", e); }
})();

io.on('connection', (socket) => {
    socket.on('disconnect', () => {});
});

async function verificarTokenMeta() {
    try {
        const r = await axios.get(`https://graph.facebook.com/v21.0/me?access_token=${META_TOKEN}`);
        console.log(`✅ TOKEN META WHATSAPP OK. Conectado como: ${r.data.name}`);
    } catch (e) {
        console.error("❌ ERROR CRÍTICO: Token Meta de WhatsApp Inválido o Expirado.");
    }
}

async function escanearFuentesHistoricas() {
    try {
        const leads = await db.all("SELECT id, phone, source FROM leads WHERE source IS NULL OR source = 'Organico'");
        for (const lead of leads) {
            const history = await db.all("SELECT text FROM history WHERE phone = ?", [lead.phone]);
            for (const msg of history) {
                const fuente = analizarTextoFuente(msg.text); 
                if (fuente) {
                    await db.run("UPDATE leads SET source = ? WHERE id = ?", [fuente, lead.id]);
                    break; 
                }
            }
        }
    } catch (e) { console.error("Error historial:", e); }
}

async function refreshKnowledge() {
    try { 
        globalKnowledge = (await db.all("SELECT * FROM inventory")).map(r => ({ 
            searchable: r.searchable, 
            data: JSON.parse(r.raw_data) 
        })); 
    } catch(e) { globalKnowledge = []; }
}
async function getCfg(k, fb=null) { 
    try {
        const r = await db.get("SELECT value FROM config WHERE key = ?", [k]); 
        return r ? JSON.parse(r.value) : fb; 
    } catch(e) { return fb; }
}
async function setCfg(k, v) { 
    await db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [k, JSON.stringify(v)]); 
}
function analizarTextoFuente(texto) {
    if(!texto) return null;
    const t = texto.toLowerCase();
    if (t.includes('storeicc.com') || t.includes('deseo asesoría')) return 'Tienda Virtual';
    if (t.includes('importadoracasacolombia.com')) return 'Sitio web';
    return null;
}

// --- ESCUDOS DE PROTECCIÓN PARA PICKLISTS EN SALESFORCE ---
function limpiarCategoriaSF(cat) {
    if (!cat) return "Otros";
    const validas = ["Maquinaria nueva", "Maquinaria usada", "Volquetas", "Martillos Hidráulicos", "Brazos largos", "Accesorios", "Repuestos", "Servicio", "Otros"];
    if (cat === "Consultando" || cat === "Otro") return "Otros";
    if (validas.includes(cat)) return cat;
    return "Otros"; 
}

function limpiarUbicacionSF(ubi) {
    if (!ubi) return "";
    const u = ubi.trim();
    if (u.toLowerCase().includes("valle del cauca") || u.toLowerCase() === "valle") return "Valle";
    if (u.toLowerCase() === "norte de santander") return "Norte De Santander";
    if (u.toLowerCase() === "san andres" || u.toLowerCase().includes("providencia")) return "San Andrés Y Providencia";
    if (u.toLowerCase() === "bogota" || u.toLowerCase() === "bogotá d.c.") return "Bogotá";
    
    const validas = ["Amazonas","Antioquia","Arauca","Atlántico","Bolívar","Bogotá","Boyacá","Caldas","Caquetá","Casanare","Cauca","Cesar","Chocó","Córdoba","Cundinamarca","Distrito Capital","Guainía","Guaviare","Huila","La Guajira","Magdalena","Meta","Nariño","Norte De Santander","Putumayo","Quindío","Risaralda","San Andrés Y Providencia","Santander","Sucre","Tolima","Valle","Vaupés","Vichada"];
    
    const match = validas.find(v => v.toLowerCase() === u.toLowerCase());
    return match || ""; 
}

async function uploadToMeta(buffer, mime, name) {
    try {
        const form = new FormData();
        const type = mime.includes('audio') || mime.includes('ogg') ? 'audio' : (mime.includes('image') ? 'image' : (mime.includes('video') ? 'video' : 'document'));
        const safeName = name.replace(/[^a-zA-Z0-9.]/g, '_') || 'imagen.jpg';

        form.append('file', buffer, { filename: safeName, contentType: mime });
        form.append('type', type); 
        form.append('messaging_product', 'whatsapp');
        
        const r = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_ID}/media`, form, { 
            headers: { 'Authorization': `Bearer ${META_TOKEN}`, ...form.getHeaders() } 
        });
        return r.data.id;
    } catch (e) { 
        console.error("❌ ERROR SUBIENDO A META:", e.response ? JSON.stringify(e.response.data) : e.message);
        return null; 
    }
}

async function enviarWhatsApp(to, content, type = "text") {
    try {
        const payload = { messaging_product: "whatsapp", to, type };
        
        if (type === "text") { 
            payload.text = { body: content }; 
        } else if (type === "template") { 
            payload.template = content; 
        } else if (content.id) { 
            payload[type] = { id: content.id }; 
            if(type === 'document') payload[type].filename = 'Archivo Adjunto.pdf'; 
        } else { 
            payload[type] = { link: content }; 
        }
        
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, payload, { 
            headers: { 'Authorization': `Bearer ${META_TOKEN}` } 
        });
        return true;
    } catch (e) { 
        console.error("❌ RECHAZO DE META:", e.response ? JSON.stringify(e.response.data) : e.message);
        return false; 
    }
}

async function enviarOmnicanal(recipientId, text, channel) {
    try {
        const payload = {
            recipient: { id: recipientId },
            message: { text: text }
        };
        await axios.post(`https://graph.facebook.com/v21.0/me/messages?access_token=${IG_TOKEN}`, payload);
        return true;
    } catch (e) {
        return false;
    }
}

// ============================================================
// 🔥 RUTAS DE LA INTERFAZ WEB 🔥
// ============================================================

app.post('/auth', (req, res) => { 
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) { 
        req.session.isLogged = true; 
        req.session.save(() => {
            res.json({success:true}); 
        });
    } else { 
        res.status(401).json({success:false}); 
    } 
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));

app.get('/inbox', proteger, (req, res) => res.sendFile(path.join(__dirname, 'inbox.html')));
app.get('/inbox.css', (req, res) => res.sendFile(path.join(__dirname, 'inbox.css')));
app.get('/inbox.js', (req, res) => res.sendFile(path.join(__dirname, 'inbox.js')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

app.get('/extractor', proteger, (req, res) => {
    res.sendFile(path.join(__dirname, 'extractor.html'));
});

app.get('/prototipo-cotizador', (req, res) => {
    res.sendFile(path.join(__dirname, 'cotizador.html'));
});
app.get('/cotizador', (req, res) => {
    res.sendFile(path.join(__dirname, 'cotizador.html'));
});

app.get('/api/media-proxy/:id', proteger, async (req, res) => {
    const mediaId = req.params.id ? req.params.id.replace(/\D/g, '') : '';
    if (!mediaId) return res.status(404).send("ID Inválido");

    try {
        const cacheDir = path.join(__dirname, 'data', 'media_cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        
        const files = await fsPromises.readdir(cacheDir);
        const existingFile = files.find(f => f.startsWith(mediaId));
        
        if (existingFile) {
            return res.sendFile(path.join(cacheDir, existingFile));
        }

        const metaRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, { 
            headers: { 'Authorization': `Bearer ${META_TOKEN}` } 
        });
        
        const urlData = metaRes.data;
        if (!urlData || !urlData.url) throw new Error("Meta no devolvió una URL válida");

        const fileRes = await axios({ 
            method: 'get', 
            url: urlData.url, 
            headers: { 'Authorization': `Bearer ${META_TOKEN}` }, 
            responseType: 'arraybuffer' 
        });

        let contentType = fileRes.headers['content-type'] || urlData.mime_type || 'application/octet-stream';
        let ext = '.bin';
        
        if (contentType.includes('audio') || (urlData.mime_type && urlData.mime_type.includes('audio'))) {
            contentType = 'audio/ogg; codecs=opus'; 
            ext = '.ogg';
        } else if (contentType.includes('video')) {
            contentType = 'video/mp4'; 
            ext = '.mp4';
        } else if (contentType.includes('jpeg') || contentType.includes('jpg')) {
            contentType = 'image/jpeg';
            ext = '.jpg';
        } else if (contentType.includes('png')) {
            contentType = 'image/png';
            ext = '.png';
        }

        const filePath = path.join(cacheDir, `${mediaId}${ext}`);
        await fsPromises.writeFile(filePath, fileRes.data);

        res.sendFile(filePath, { headers: { 'Content-Type': contentType } });

        setTimeout(async () => {
            try { 
                await fsPromises.access(filePath);
                await fsPromises.unlink(filePath); 
            } catch(e){}
        }, 10 * 60 * 1000);

    } catch (e) { 
        if (!res.headersSent) res.status(500).send("Error procesando medio"); 
    }
});

app.get('/api/meta/post-preview/:media_id', proteger, async (req, res) => {
    try {
        const mediaId = req.params.media_id;
        const token = IG_TOKEN || META_TOKEN; 
        
        if (!token) return res.status(500).json({ success: false, error: "Tokens no configurados" });

        const metaRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}?fields=media_url,caption,permalink_url,thumbnail_url&access_token=${token}`);
        
        res.json({
            success: true,
            media_url: metaRes.data.thumbnail_url || metaRes.data.media_url,
            caption: metaRes.data.caption || 'Publicación',
            permalink: metaRes.data.permalink_url || '#'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: "No se pudo obtener la vista previa de Meta" });
    }
});

async function procesarConICBOT(dbMsg, aiMsg, phone, name = "Cliente", isFile = false) {
    const fuenteDetectada = analizarTextoFuente(dbMsg);
    if (fuenteDetectada) {
        const leadExistente = await db.get("SELECT id, source FROM leads WHERE phone = ?", [phone]);
        if (leadExistente) {
            if (!leadExistente.source || leadExistente.source === 'Organico') await db.run("UPDATE leads SET source = ? WHERE id = ?", [fuenteDetectada, leadExistente.id]);
        } else {
            await db.run(`INSERT INTO leads (phone, nombre, source, etiqueta, fecha, farewell_sent) VALUES (?, ?, ?, ?, ?, 0)`, [phone, name, fuenteDetectada, "Pendiente", new Date().toISOString()]);
        }
    }

    const bot = await db.get("SELECT active FROM bot_status WHERE phone = ?", [phone]);
    if (bot && bot.active === 0) { return null; }

    const lead = await db.get("SELECT * FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1", [phone]);

    let promptUsuario = await getCfg('bot_prompt');
    const configUsar = (promptUsuario && promptUsuario.length > 5) ? promptUsuario : DEFAULT_PROMPT;
    
    const webSources = await db.all("SELECT summary FROM knowledge_sources WHERE active = 1");
    const webContext = webSources.map(w => w.summary).join("\n\n");
    const techRules = await getCfg('tech_rules', []);
    const biz = await getCfg('biz_profile', {});
    const history = (await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id DESC LIMIT 15", [phone])).reverse();
    
    let memoriaDatos = `ID CLIENTE: ${phone}\nNombre en WhatsApp (No confiable):${name}\n`;
    if (lead) {
        if (lead.nombre) memoriaDatos += `Nombre verificado: ${lead.nombre}\n`;
        if (lead.ciudad) memoriaDatos += `Ciudad: ${lead.ciudad}\n`;
        if (lead.correo) memoriaDatos += `Correo: ${lead.correo}\n`;
        if (lead.interes) memoriaDatos += `Categoría Interés: ${lead.interes}\n`;
        if (lead.producto_especifico) memoriaDatos += `Producto Específico: ${lead.producto_especifico}\n`;
    }

    const busqueda = (aiMsg && typeof aiMsg === 'string') ? aiMsg.toLowerCase().split(" ").slice(0,3).join(" ") : "";
    const stock = globalKnowledge.filter(i => (i.searchable||"").toLowerCase().includes(busqueda)).slice(0,5);

    const promptSistema = `
${configUsar}

=== DATOS DE CONTEXTO DEL SISTEMA ===
Reglas Técnicas: ${techRules.join(" | ")}
Horario: ${biz.hours || ''}
Contexto Web: ${webContext}
Memoria del cliente actual: 
${memoriaDatos}
Inventario: ${JSON.stringify(stock)}

=== INSTRUCCIÓN FUNCIONAL ===
1. Responde al cliente de forma natural. NUNCA repitas tu saludo inicial si ya te presentaste en la conversación actual.
2. REGLA DE NOMBRE: Si el cliente da su nombre explícitamente, asígnalo en el campo correspondiente.
3. AUTO-APAGADO (ANTI-BUCLES): Si ya tienes el Nombre, Ciudad, Categoría y PRODUCTO ESPECÍFICO, envía ESTE EXACTO MENSAJE: "Perfecto, [Nombre]. Ya pasé sus datos y su solicitud. Pronto un ejecutivo comercial se contactará con usted. Recuerde que los datos brindados serán usados de acuerdo a nuestra política de protección de datos: https://www.importadoracasacolombia.com/aviso-de-privacidad". SOLO DESPUÉS de dar esa despedida, pon "apagar_bot" en true.
4. Tu salida DEBE SER ESTRICTAMENTE un JSON con la siguiente estructura exacta:
{
  "mensaje_para_cliente": "Tu respuesta directa y conversacional para el cliente aquí. Sin justificaciones ni pensamientos internos.",
  "datos_internos": {
    "es_lead": false,
    "nombre": "...",
    "categoria_interes": "...",
    "producto_especifico": "...",
    "ciudad": "...",
    "correo": "...",
    "etiqueta": "Lead",
    "apagar_bot": false
  }
}
Categorías permitidas: Maquinaria nueva, Maquinaria usada, Volquetas, Martillos Hidráulicos, Brazos largos, Accesorios, Repuestos, Servicio, Otros.
    `;

    const chatContents = [];
    for (const msg of history) {
        const mappedRole = (msg.role === 'bot' || msg.role === 'manual') ? 'model' : 'user';
        
        if (chatContents.length > 0 && chatContents[chatContents.length - 1].role === mappedRole) {
            chatContents[chatContents.length - 1].parts[0].text += `\n${msg.text}`;
        } else {
            chatContents.push({
                role: mappedRole,
                parts: [{ text: msg.text }]
            });
        }
    }

    if (chatContents.length === 0) {
        chatContents.push({ role: 'user', parts: [{ text: aiMsg }] });
    }

    try {
        const requestBody = {
            system_instruction: { parts: [{ text: promptSistema }] },
            contents: chatContents,
            generationConfig: {
                responseMimeType: "application/json"
            }
        };

        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, requestBody);
        
        const rawText = r.data.candidates[0].content.parts[0].text;
        const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const infoIA = JSON.parse(cleanText);
        
        await gestionarLead(phone, infoIA.datos_internos, name, lead); 
        
        let reply = infoIA.mensaje_para_cliente;
        if (!reply || reply.length < 2) reply = "¿En qué te puedo ayudar?";
        
        const timestamp = new Date().toISOString();
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'bot', reply, timestamp]);
        
        io.emit('new_message', { phone: phone, role: 'bot', text: reply, time: timestamp });
        io.emit('update_chats_list');

        return reply;
    } catch (e) { 
        console.error("❌ ERROR REAL DE GEMINI:", e.response ? JSON.stringify(e.response.data) : e.message);
        return "Dame un momento, estoy verificando esa información."; 
    }
}

async function gestionarLead(phone, info, fbName, oldLead) {
    if (!info) return; 
    const limpiarDato = (d) => (!d || /^(unknown|null|n\/a|no menciona|cliente|pend)$/i.test(d.toString().trim())) ? null : d.trim();
    
    let name = limpiarDato(info.nombre) || (oldLead && oldLead.nombre && oldLead.nombre !== fbName ? oldLead.nombre : fbName);
    let ciudadLimpia = limpiarDato(info.ciudad); 
    let dpto = ciudadLimpia || (oldLead ? oldLead.departamento : null);
    let interesLimpio = limpiarDato(info.categoria_interes) || limpiarDato(info.interes) || (oldLead ? oldLead.interes : "Otros");
    let productoLimpio = limpiarDato(info.producto_especifico) || (oldLead ? oldLead.producto_especifico : null);
    let correoLimpio = limpiarDato(info.correo) || (oldLead ? oldLead.correo : null);
    let farewellReset = (oldLead && !oldLead.fecha) ? ", farewell_sent = 0" : "";

    if (oldLead) {
        await db.run(`UPDATE leads SET nombre=?, interes=?, producto_especifico=?, etiqueta=?, fecha=?, ciudad=?, departamento=?, correo=? ${farewellReset} WHERE id=?`, 
            [name, interesLimpio, productoLimpio, info.etiqueta || oldLead.etiqueta, new Date().toISOString(), ciudadLimpia || oldLead.ciudad, dpto, correoLimpio, oldLead.id]);
        await db.run("UPDATE metadata SET contactName = ? WHERE phone = ?", [name, phone]);
    } else if (interesLimpio || ciudadLimpia || info.es_lead) {
        await db.run(`INSERT INTO leads (phone, nombre, interes, producto_especifico, etiqueta, fecha, ciudad, departamento, correo, source, farewell_sent, followup_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Organico', 0, 0)`, 
            [phone, name, interesLimpio, productoLimpio, "Pendiente", new Date().toISOString(), ciudadLimpia, dpto, correoLimpio]);
        await db.run("UPDATE metadata SET contactName = ? WHERE phone = ?", [name, phone]);
    }

    if (info.apagar_bot === true) {
        await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, 0)", [phone]);
    }
}

function iniciarCronJobs() {
    setInterval(async () => {
        try {
            const cacheDir = path.join(__dirname, 'data', 'media_cache');
            if (fs.existsSync(cacheDir)) {
                const files = await fsPromises.readdir(cacheDir);
                const now = Date.now();
                for (const file of files) {
                    const filePath = path.join(cacheDir, file);
                    const stats = await fsPromises.stat(filePath);
                    if (now - stats.mtimeMs > 1800000) {
                        await fsPromises.unlink(filePath);
                    }
                }
            }
        } catch(e) {}
    }, 60000 * 30);

    setInterval(async () => {
        try {
            const horaBogota = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Bogota"}));
            if (horaBogota.getHours() === 7 && horaBogota.getMinutes() < 15) {
                const todayStr = horaBogota.toISOString().split('T')[0];
                const lastRun = await getCfg('last_followup_date');
                if (lastRun === todayStr) return; 

                await setCfg('last_followup_date', todayStr);

                const query = `
                    SELECT l.*, m.last_interaction 
                    FROM leads l 
                    JOIN metadata m ON l.phone = m.phone 
                    WHERE LOWER(l.etiqueta) = 'pendiente' AND m.last_interaction IS NOT NULL
                `;
                const leadsPendientes = await db.all(query);
                
                for (const l of leadsPendientes) {
                    const horasInactivo = (Date.now() - new Date(l.last_interaction).getTime()) / (1000 * 60 * 60);

                    if (horasInactivo >= 24) {
                        let fDay = l.followup_day || 0;
                        fDay++;
                        let cerrar = false;

                        if (fDay === 1 || fDay === 2) {
                            const templatePayload = { name: "plantilla_de_retoma", language: { code: "es_CO" } };
                            const sent = await enviarWhatsApp(l.phone, templatePayload, 'template');
                            if (sent) {
                                const timestamp = new Date().toISOString();
                                const msgGuardado = `[CAMPAÑA]\n📢 Plantilla: plantilla_de_retoma enviada exitosamente`;
                                await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [l.phone, 'bot', msgGuardado, timestamp]);
                                io.emit('new_message', { phone: l.phone, role: 'bot', text: msgGuardado, time: timestamp });
                            }
                        } else if (fDay >= 3) {
                            cerrar = true;
                        }

                        if (cerrar) {
                            await db.run("UPDATE leads SET etiqueta = 'Perdido', followup_day = ? WHERE id = ?", [fDay, l.id]);
                            await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, 0)", [l.phone]);
                        } else {
                            await db.run("UPDATE leads SET followup_day = ? WHERE id = ?", [fDay, l.id]);
                        }
                    }
                }
                io.emit('update_chats_list');
            }
        } catch (e) {}
    }, 10 * 60 * 1000); 
}

// ============================================================
// 🔥 API DE CONFIGURACIÓN, ETIQUETAS Y CONOCIMIENTO (BLINDADO) 🔥
// ============================================================

app.get('/api/data/:type', proteger, async (req, res) => {
    try {
        const t = req.params.type;
        if (t === 'leads') res.json(await db.all("SELECT * FROM leads ORDER BY id DESC"));
        else if (t === 'tags') res.json(await db.all("SELECT * FROM global_tags ORDER BY id DESC"));
        else if (t === 'shortcuts') res.json(await db.all("SELECT * FROM shortcuts ORDER BY id DESC"));
        else if (t === 'knowledge') res.json(await db.all("SELECT * FROM inventory"));
        else if (t === 'config') res.json({ website_data: await getCfg('website_data', ""), tech_rules: await getCfg('tech_rules', []), biz_profile: await getCfg('biz_profile', {}), logo_url: await getCfg('logo_url') });
        else res.json([]);
    } catch(e) { res.status(500).json([]); }
});

app.post('/api/knowledge/update', proteger, async (req, res) => {
    const { id, data } = req.body;
    try {
        const searchable = Object.values(data).join(" ");
        await db.run("UPDATE inventory SET raw_data = ?, searchable = ? WHERE id = ?", [JSON.stringify(data), searchable, id]);
        await refreshKnowledge();
        res.json({success:true});
    } catch(e) { res.status(500).json({error: "Error actualizando"}); }
});

app.post('/api/knowledge/csv', proteger, upload.single('file'), async (req, res) => { 
    try { 
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
        for (const row of rows) {
            const cleanRow = {};
            for(const k in row) cleanRow[k.toLowerCase().trim()] = row[k];
            await db.run("INSERT OR IGNORE INTO inventory (searchable, raw_data) VALUES (?, ?)", [Object.values(cleanRow).join(" "), JSON.stringify(cleanRow)]); 
        }
        await refreshKnowledge(); 
        res.json({ success: true, count: rows.length }); 
    } catch(e) { res.status(500).json({ error: "Error procesando archivo" }); } 
});

app.post('/api/config/logo', proteger, upload.single('file'), async (req, res) => { 
    try {
        if(!req.file) return res.status(400).json({error: "Sin archivo"});
        await setCfg('logo_url', `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`); 
        res.json({success:true}); 
    } catch(e) { res.status(500).json({error: "Error guardando logo"}); }
});

app.post('/api/config/biz/save', proteger, async (req, res) => { 
    try {
        await setCfg('biz_profile', {name:req.body.name || "", hours:req.body.hours || ""}); 
        res.json({success:true}); 
    } catch(e) { res.status(500).json({error: "Error guardando perfil"}); }
});

app.post('/api/tags/add', proteger, async (req, res) => { 
    try {
        const name = (req.body.name || "").trim();
        const color = req.body.color || "#E9511D";
        if (!name) return res.status(400).json({error: "El nombre de la etiqueta es vacío"});
        await db.run("INSERT OR IGNORE INTO global_tags (name, color) VALUES (?, ?)", [name, color]); 
        await db.run("UPDATE global_tags SET color = ? WHERE name = ?", [color, name]);
        const tags = await db.all("SELECT * FROM global_tags ORDER BY id DESC");
        io.emit('tags_updated', tags);
        res.json({success:true, tags}); 
    } catch(e) { res.status(500).json({error: "Error creando etiqueta"}); }
});

app.post('/api/tags/delete', proteger, async (req, res) => { 
    try {
        await db.run("DELETE FROM global_tags WHERE id = ?", [req.body.id]); 
        const tags = await db.all("SELECT * FROM global_tags ORDER BY id DESC");
        io.emit('tags_updated', tags);
        res.json({success:true, tags}); 
    } catch(e) { res.status(500).json({error: "Error eliminando etiqueta"}); }
});

app.post('/api/tags/update', proteger, async (req, res) => { 
    try {
        const name = (req.body.name || "").trim();
        await db.run("UPDATE global_tags SET name = ?, color = ? WHERE id = ?", [name, req.body.color, req.body.id]); 
        const tags = await db.all("SELECT * FROM global_tags ORDER BY id DESC");
        io.emit('tags_updated', tags);
        res.json({success:true, tags});
    } catch(e) { res.status(500).json({error: "Error editando etiqueta"}); }
});

app.post('/api/shortcuts/add', proteger, async (req, res) => { 
    try {
        const kw = (req.body.keyword || "").trim();
        if(!kw) return res.status(400).json({error: "Falta comando"});
        await db.run("INSERT OR REPLACE INTO shortcuts (keyword, text) VALUES (?, ?)", [kw, req.body.text]); 
        res.json({success:true}); 
    } catch(e) { res.status(500).json({error: "Error guardando atajo"}); }
});

app.post('/api/shortcuts/delete', proteger, async (req, res) => { 
    try {
        await db.run("DELETE FROM shortcuts WHERE id = ?", [req.body.id]); 
        res.json({success:true}); 
    } catch(e) { res.status(500).json({error: "Error borrando atajo"}); }
});

app.post('/api/contacts/upload-photo', proteger, upload.single('file'), async (req, res) => { 
    try {
        await db.run("INSERT INTO metadata (phone, photoUrl) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET photoUrl=excluded.photoUrl", [req.body.phone, `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`]); 
        io.emit('update_chats_list');
        res.json({success:true}); 
    } catch(e) { res.status(500).json({error: "Error subiendo foto"}); }
});

app.post('/api/chat/toggle-bot', proteger, async (req, res) => { 
    try {
        await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, ?)", [req.body.phone, req.body.active?1:0]); 
        io.emit('update_chats_list');
        res.json({success:true}); 
    } catch(e) { res.status(500).json({error: "Error cambiando estado del bot"}); }
});

app.post('/api/config/rules/add', proteger, async (req, res) => { 
    try {
        let r = await getCfg('tech_rules', []); 
        if(req.body.rule) r.push(req.body.rule); 
        await setCfg('tech_rules', r); 
        res.json({success:true, rules:r}); 
    } catch(e) { res.status(500).json({error: "Error agregando regla"}); }
});

app.post('/api/config/rules/delete', proteger, async (req, res) => { 
    try {
        let r = await getCfg('tech_rules', []); 
        r.splice(req.body.index, 1); 
        await setCfg('tech_rules', r); 
        res.json({success:true, rules:r}); 
    } catch(e) { res.status(500).json({error: "Error borrando regla"}); }
});

app.post('/api/leads/update', proteger, async(req,res)=>{ 
    try {
        await db.run(`UPDATE leads SET ${req.body.field}=? WHERE id=?`,[req.body.value, req.body.id]); 
        io.emit('update_chats_list');
        res.json({success:true}); 
    } catch(e) { res.status(500).json({error: "Error actualizando lead"}); }
});

app.post('/api/leads/delete', proteger, async(req,res)=>{ 
    try {
        await db.run("DELETE FROM leads WHERE id=?",[req.body.id]); 
        io.emit('update_chats_list');
        res.json({success:true}); 
    } catch(e) { res.status(500).json({error: "Error borrando lead"}); }
});

app.post('/api/knowledge/delete', proteger, async (req, res) => { await db.run("DELETE FROM inventory WHERE id=?",[req.body.id]); await refreshKnowledge(); res.json({success:true}); });
app.post('/api/knowledge/clear', proteger, async (req, res) => { await db.run("DELETE FROM inventory"); await refreshKnowledge(); res.json({success:true}); });
app.post('/api/config/prompt', proteger, async (req, res) => { await setCfg('bot_prompt', req.body.prompt); res.json({success:true}); });
app.get('/api/config/prompt', proteger, async (req, res) => res.json({ prompt: await getCfg('bot_prompt', DEFAULT_PROMPT) }));
app.post('/api/data/web-knowledge', proteger, async (req, res) => { await db.run("INSERT INTO knowledge_sources (type, url, summary, date) VALUES (?, ?, ?, ?)", ['web', req.body.url, req.body.summary, new Date().toLocaleString()]); res.json({success:true}); });
app.get('/api/data/web-knowledge', proteger, async (req, res) => { res.json(await db.all("SELECT * FROM knowledge_sources ORDER BY id DESC")); });
app.post('/api/data/web-knowledge/delete', proteger, async (req, res) => { await db.run("DELETE FROM knowledge_sources WHERE id = ?", [req.body.id]); res.json({success:true}); });

// ============================================================
// 🔥 INTEGRACIÓN REAL CON SALESFORCE (USANDO EL POOL SINGLETON)
// ============================================================

app.post('/api/salesforce/check-lead', proteger, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Falta teléfono" });

    let telefonoFinal = phone.replace(/\D/g, '');
    if (telefonoFinal.startsWith("57") && telefonoFinal.length > 10) {
        telefonoFinal = telefonoFinal.substring(2); 
    }

    try {
        const checkResult = await runSfOperation(async (sfConn) => {
            let q_lead = await sfConn.query(`SELECT Id, Name, OwnerId, Company FROM Lead WHERE (Phone LIKE '%${telefonoFinal}%' OR MobilePhone LIKE '%${telefonoFinal}%') AND IsConverted = FALSE LIMIT 1`);
            if (q_lead.totalSize > 0) {
                const rec = q_lead.records[0];
                return { 
                    exists: true, 
                    data: { 
                        tipo: 'Candidato', id: rec.Id, nombre: rec.Name, owner_id: rec.OwnerId, who_id: rec.Id, what_id: null, 
                        link: `https://importadoracolombia.lightning.force.com/lightning/r/Lead/${rec.Id}/view` 
                    } 
                };
            }

            let q_contact = await sfConn.query(`SELECT Id, Name, OwnerId, AccountId FROM Contact WHERE (Phone LIKE '%${telefonoFinal}%' OR MobilePhone LIKE '%${telefonoFinal}%') LIMIT 1`);
            if (q_contact.totalSize > 0) {
                const rec = q_contact.records[0];
                return { 
                    exists: true, 
                    data: { 
                        tipo: 'Contacto', id: rec.Id, nombre: rec.Name, owner_id: rec.OwnerId, who_id: rec.Id, what_id: rec.AccountId, 
                        link: `https://importadoracolombia.lightning.force.com/lightning/r/Contact/${rec.Id}/view` 
                    } 
                };
            }

            let q_account = await sfConn.query(`SELECT Id, Name, OwnerId FROM Account WHERE Phone LIKE '%${telefonoFinal}%' LIMIT 1`);
            if (q_account.totalSize > 0) {
                const rec = q_account.records[0];
                return { 
                    exists: true, 
                    data: { 
                        tipo: 'Cuenta', id: rec.Id, nombre: rec.Name, owner_id: rec.OwnerId, who_id: null, what_id: rec.Id, 
                        link: `https://importadoracolombia.lightning.force.com/lightning/r/Account/${rec.Id}/view` 
                    } 
                };
            }

            return { exists: false };
        });

        return res.json({ success: true, ...checkResult });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/salesforce/create-task', proteger, async (req, res) => {
    const { who_id, what_id, owner_id, descripcion } = req.body;
    try {
        const result = await runSfOperation(async (sfConn) => {
            const hoy = new Date().toISOString().split('T')[0];
            const nueva_tarea = {
                Subject: 'Contactar',
                ActivityDate: hoy,
                Status: 'Open', 
                Description: descripcion || "Sin detalle especificado",
                OwnerId: owner_id
            };

            if (who_id) nueva_tarea.WhoId = who_id;
            if (what_id) nueva_tarea.WhatId = what_id;

            return await sfConn.sobject("Task").create(nueva_tarea);
        });
        
        if (result.success) {
            res.json({ 
                success: true, 
                taskId: result.id, 
                link: `https://importadoracolombia.lightning.force.com/lightning/r/Task/${result.id}/view` 
            });
        } else {
            res.status(500).json({ success: false, message: "Salesforce rechazó la tarea" });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/salesforce/sync-lead', proteger, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Falta teléfono" });

    try {
        const lead = await db.get("SELECT * FROM leads WHERE phone = ?", [phone]);
        if (!lead) return res.status(404).json({ success: false, message: "No encontrado en la BD local" });

        let leadSource = "Redes sociales"; 
        const src = (lead.source || "").toLowerCase();

        if (src.includes("tienda")) leadSource = "Tienda Virtual";
        else if (src.includes("web")) leadSource = "Sitio web";
        else if (src.includes("excel") || src.includes("masivo") || src.includes("campaña") || src.includes("whatsapp")) leadSource = "WhatsApp";

        let firstName = "Cliente";
        let lastName = "ICC";
        if (lead.nombre) {
            const parts = lead.nombre.trim().split(" ");
            firstName = parts[0];
            lastName = parts.length > 1 ? parts.slice(1).join(" ") : "ICC";
        }

        let telefonoFinal = lead.phone;
        if (telefonoFinal.startsWith("57") && telefonoFinal.length > 10) {
            telefonoFinal = telefonoFinal.substring(2); 
        }

        let interesLimpio = limpiarCategoriaSF(lead.interes);
        let dptoSF = limpiarUbicacionSF(lead.departamento || lead.ciudad);

        const sfData = {
            FirstName: firstName,
            LastName: lastName,
            Phone: telefonoFinal,
            Email: lead.correo || "",
            Company: lead.nombre || "Cliente ICC",
            DescripciondeProducto__c: lead.producto_especifico || "",
            Producto_de_su_inter_s__c: interesLimpio,
            Ubicaci_n__c: dptoSF,
            LeadSource: leadSource
        };

        if (lead.etiqueta && lead.etiqueta.startsWith("005")) {
            sfData.OwnerId = lead.etiqueta;
        }

        const syncOutcome = await runSfOperation(async (sfConn) => {
            const search = await sfConn.query(`SELECT Id, Name, OwnerId FROM Lead WHERE (Phone LIKE '%${telefonoFinal}%' OR MobilePhone LIKE '%${telefonoFinal}%') AND IsConverted = FALSE LIMIT 1`);
            if (search.totalSize > 0) {
                const rec = search.records[0];
                return {
                    duplicate: true,
                    existingRecord: {
                        tipo: 'Candidato', id: rec.Id, nombre: rec.Name, owner_id: rec.OwnerId, who_id: rec.Id, what_id: null,
                        link: `https://importadoracolombia.lightning.force.com/lightning/r/Lead/${rec.Id}/view`
                    }
                };
            }
            const created = await sfConn.sobject("Lead").create(sfData);
            return { duplicate: false, created };
        });

        if (syncOutcome.duplicate) {
            return res.status(400).json({ 
                success: false, 
                isDuplicate: true,
                existingRecord: syncOutcome.existingRecord,
                message: "Este cliente ya existe en Salesforce. Puedes crearle una Tarea ('Contactar') directamente." 
            });
        }

        if (syncOutcome.created && syncOutcome.created.success) {
            await db.run("UPDATE leads SET sf_id = ? WHERE id = ?", [syncOutcome.created.id, lead.id]);
            io.emit('update_chats_list');
            res.json({ success: true, sfId: syncOutcome.created.id });
        } else {
            res.status(500).json({ success: false, message: "Salesforce rechazó los datos." });
        }

    } catch (error) {
        if (error.message && error.message.toLowerCase().includes("duplicate")) {
            return res.status(400).json({ success: false, isDuplicate: true, message: "Salesforce detectó un DUPLICADO. Este cliente ya existe. Por favor, créale una Tarea en lugar de un Lead nuevo." });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/salesforce/sync-bulk', proteger, async (req, res) => {
    try {
        const leads = await db.all("SELECT * FROM leads WHERE sf_id IS NULL OR sf_id = ''");
        if (leads.length === 0) return res.json({ success: true, count: 0 });

        let count = 0;
        await runSfOperation(async (sfConn) => {
            for (const lead of leads) {
                try {
                    let leadSource = "Redes sociales";
                    const src = (lead.source || "").toLowerCase();
                    if (src.includes("tienda")) leadSource = "Tienda Virtual";
                    else if (src.includes("web")) leadSource = "Sitio web";
                    else if (src.includes("excel") || src.includes("masivo") || src.includes("campaña") || src.includes("whatsapp")) leadSource = "WhatsApp";

                    let firstName = "Cliente"; let lastName = "ICC";
                    if (lead.nombre) {
                        const parts = lead.nombre.trim().split(" ");
                        firstName = parts[0]; lastName = parts.length > 1 ? parts.slice(1).join(" ") : "ICC";
                    }

                    let telefonoFinal = lead.phone;
                    if (telefonoFinal.startsWith("57") && telefonoFinal.length > 10) {
                        telefonoFinal = telefonoFinal.substring(2); 
                    }

                    let interesLimpio = limpiarCategoriaSF(lead.interes);
                    let dptoSF = limpiarUbicacionSF(lead.departamento || lead.ciudad);

                    const sfData = {
                        FirstName: firstName, LastName: lastName, Phone: telefonoFinal,
                        Email: lead.correo || "", Company: lead.nombre || "Cliente ICC",
                        DescripciondeProducto__c: lead.producto_especifico || "",
                        Producto_de_su_inter_s__c: interesLimpio,
                        Ubicaci_n__c: dptoSF,
                        LeadSource: leadSource
                    };

                    if (lead.etiqueta && lead.etiqueta.startsWith("005")) sfData.OwnerId = lead.etiqueta;

                    const search = await sfConn.query(`SELECT Id FROM Lead WHERE Phone LIKE '%${telefonoFinal}%' OR MobilePhone LIKE '%${telefonoFinal}%'`);
                    if (search.totalSize === 0) {
                        const result = await sfConn.sobject("Lead").create(sfData);
                        if (result.success) {
                            await db.run("UPDATE leads SET sf_id = ? WHERE id = ?", [result.id, lead.id]);
                            count++;
                        }
                    }
                } catch(e) {}
            }
        });

        io.emit('update_chats_list');
        res.json({ success: true, count: count });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error crítico sincronizando con Salesforce." });
    }
});

app.post('/api/chat/analyze-lead', proteger, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Falta teléfono" });

    try {
        const history = await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id ASC LIMIT 50", [phone]);
        if (!history || history.length === 0) return res.json({ success: false, message: "No hay historial para analizar." });

        let convoText = history.map(h => `${h.role === 'user' ? 'Cliente' : 'Asesor'}:${h.text}`).join('\n');

        const promptEstractor = `
        Actúa como un analista de datos experto. Lee la siguiente conversación entre un cliente y un asesor de ventas de maquinaria pesada.
        Tu ÚNICO objetivo es extraer los datos del cliente para llenar el CRM. No respondas nada más.
        NUNCA inventes información. Si el cliente no ha dicho un dato, déjalo como string vacío "".

        Conversación:
        ${convoText}

        Devuelve ESTRICTAMENTE un JSON con esta estructura exacta:
        {
          "nombre": "Nombre del cliente si lo dijo",
          "ciudad": "Ciudad si la mencionó",
          "correo": "Correo electrónico si lo dio",
          "categoria_interes": "Una de: Maquinaria nueva, Maquinaria usada, Volquetas, Martillos Hidráulicos, Brazos largos, Accesorios, Repuestos, Servicio, Otros",
          "producto_especifico": "Modelo exacto o detalle de lo que busca"
        }`;

        const requestBody = {
            contents: [{ role: 'user', parts: [{ text: promptEstractor }] }],
            generationConfig: { responseMimeType: "application/json" }
        };

        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, requestBody);
        const rawText = r.data.candidates[0].content.parts[0].text;
        const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const extractedData = JSON.parse(cleanText);

        res.json({ success: true, data: extractedData });
    } catch (error) {
        res.status(500).json({ success: false, error: "Error analizando chat" });
    }
});

app.get('/api/chats-full', proteger, async (req, res) => {
    try {
        const view = req.query.view || 'active';
        const search = req.query.search ? `%${req.query.search}%` : null;
        const channelFilter = req.query.channel; 
        
        let whereClause = '(m.archived = 0 OR m.archived IS NULL)';
        if (view === 'archived') whereClause = 'm.archived = 1';
        else if (view === 'unread') whereClause = 'm.unreadCount > 0 AND (m.archived = 0 OR m.archived IS NULL)';
        
        if (channelFilter === 'whatsapp') {
            whereClause += " AND (m.channel = 'whatsapp' OR m.channel IS NULL)";
        } else if (channelFilter === 'omni') {
            whereClause += " AND m.channel IN ('instagram', 'messenger')";
        }
        
        let params = [];
        if (search) { whereClause += ` AND (m.contactName LIKE ? OR h.phone LIKE ? OR h.text LIKE ?)`; params.push(search, search, search); }
        
        const query = `SELECT h.phone as id, MAX(h.id) as max_id, h.text as lastText, h.time as timestamp, m.contactName, m.photoUrl, m.labels, m.pinned, m.archived, m.unreadCount, m.channel, b.active as botActive, l.source, l.status_tag, l.sf_id, l.interes, l.producto_especifico FROM history h LEFT JOIN metadata m ON h.phone = m.phone LEFT JOIN bot_status b ON h.phone = b.phone LEFT JOIN leads l ON h.phone = l.phone WHERE ${whereClause} GROUP BY h.phone ORDER BY m.pinned DESC, max_id DESC LIMIT 5000`;
        const rows = await db.all(query, params);
        
        res.json(rows.map(r => {
            let parsedLabels = [];
            try { 
                parsedLabels = JSON.parse(r.labels || "[]"); 
                if (!Array.isArray(parsedLabels)) parsedLabels = r.labels ? [{ text: r.labels, color: "#555555" }] : [];
            } catch(e) { 
                parsedLabels = r.labels ? [{ text: r.labels, color: "#555555" }] : []; 
            }

            return { 
                id: r.id, 
                phone: r.id,
                name: r.contactName || r.id, 
                lastMessage: { text: r.lastText, time: r.timestamp }, 
                botActive: r.botActive !== 0, 
                pinned: r.pinned === 1, 
                archived: r.archived === 1, 
                unreadCount: r.unreadCount || 0, 
                labels: parsedLabels, 
                photoUrl: r.photoUrl, 
                timestamp: r.timestamp, 
                source: r.source, 
                statusTag: r.status_tag, 
                sfId: r.sf_id,
                interes: r.interes,
                producto_especifico: r.producto_especifico,
                channel: r.channel || 'whatsapp' 
            };
        }));
    } catch(e) { res.status(500).json([]); }
});

app.get('/api/chat-history/:phone(*)', proteger, async (req, res) => {
    try {
        const phone = req.params.phone;
        await db.run("UPDATE metadata SET unreadCount = 0 WHERE phone = ?", [phone]);
        const historial = await db.all("SELECT * FROM history WHERE phone = ? ORDER BY id ASC", [phone]);
        res.json(historial || []);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.post('/api/contacts/bulk-update', proteger, async (req, res) => {
    const { phones, action, value } = req.body; 
    try {
        if (!phones || !Array.isArray(phones)) return res.status(400).json({error: "Lista de teléfonos inválida"});
        
        for (const phone of phones) {
            const cleanPhone = phone.replace(/[^0-9a-zA-Z_]/g, '');
            if (action === 'set_label') {
                await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [cleanPhone, JSON.stringify([value])]); 
                await db.run("UPDATE leads SET status_tag = ? WHERE phone = ?", [value.text, cleanPhone]);
            } else if (action === 'add_label') {
                const current = await db.get("SELECT labels FROM metadata WHERE phone = ?", [cleanPhone]);
                let labels = [];
                try { labels = current ? JSON.parse(current.labels || "[]") : []; } catch(e){ labels = []; }
                if (!Array.isArray(labels)) labels = [];
                if (!labels.find(l => (l.text || l) === value.text)) {
                    labels.push(value);
                    await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [cleanPhone, JSON.stringify(labels)]);
                    await db.run("UPDATE leads SET status_tag = ? WHERE phone = ?", [labels.map(l => l.text || l).join(', '), cleanPhone]);
                }
            }
        }
        io.emit('update_chats_list');
        res.json({success: true});
    } catch (e) {
        res.status(500).json({error: "Error en actualización masiva"});
    }
});

app.post('/api/chat/action', proteger, async (req, res) => {
    try {
        const { phone, action, value } = req.body;
        const cleanPhone = phone.replace(/[^0-9a-zA-Z_]/g, ''); 
        
        if(action === 'delete') { 
            for(const t of ['history','metadata','bot_status','leads']) {
                await db.run(`DELETE FROM ${t} WHERE phone=?`,[cleanPhone]); 
            }
        }
        else if(action === 'set_labels') { 
            const safeArray = Array.isArray(value) ? value : [];
            await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [cleanPhone, JSON.stringify(safeArray)]); 
            await db.run("UPDATE leads SET status_tag = ? WHERE phone = ?", [safeArray.length > 0 ? safeArray.map(v => v.text || v).join(', ') : "Sin Etiqueta", cleanPhone]); 
        }
        else if(action === 'toggle_pin') { 
            await db.run("INSERT INTO metadata (phone, pinned) VALUES (?, 1) ON CONFLICT(phone) DO UPDATE SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END", [cleanPhone]); 
        }
        else if(action === 'toggle_archive') { 
            await db.run("INSERT INTO metadata (phone, archived) VALUES (?, 1) ON CONFLICT(phone) DO UPDATE SET archived = CASE WHEN archived = 1 THEN 0 ELSE 1 END", [cleanPhone]); 
        }
        
        io.emit('update_chats_list');
        res.json({success:true});
    } catch(e) {
        res.status(500).json({error: "Error aplicando acción al chat"});
    }
});

app.post('/api/chat/upload-send', proteger, upload.single('file'), async (req, res) => { 
    try { const mid = await uploadToMeta(req.file.buffer, req.file.mimetype, req.file.originalname); 
        if(mid) { await enviarWhatsApp(req.body.phone, { id: mid }, req.body.type); 
            const msgType = `[MEDIA:${req.body.type.toUpperCase()}:${mid}]`;
            const timestamp = new Date().toISOString();
            await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [req.body.phone, 'manual', msgType, timestamp]); 
            await db.run("UPDATE metadata SET last_interaction = ? WHERE phone = ?", [timestamp, req.body.phone]); 
            
            io.emit('new_message', { phone: req.body.phone, role: 'manual', text: msgType, time: timestamp });
            io.emit('update_chats_list');

            res.json({success: true}); 
        } else { res.status(500).json({error: "Error Meta"}); }
    } catch(e) { res.status(500).json({error: e.message}); } 
});

app.post('/api/chat/send', proteger, async (req, res) => { 
    const { phone, message } = req.body; 
    try { 
        let finalId = phone;
        if (finalId.includes('_comentarios')) {
            finalId = finalId.replace('_comentarios', '');
        }

        const metaInfo = await db.get("SELECT channel FROM metadata WHERE phone = ?", [phone]);
        const channel = metaInfo ? metaInfo.channel : 'whatsapp';
        
        let sent = false;

        if (channel === 'whatsapp') {
            finalId = finalId.replace(/\D/g, ''); 
            sent = await enviarWhatsApp(finalId, message); 
        } else {
            sent = await enviarOmnicanal(finalId, message, channel);
        }

        if(sent) { 
            const timestamp = new Date().toISOString();
            await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'manual', message, timestamp]); 
            await db.run(`INSERT INTO metadata (phone, contactName, addedManual, archived, unreadCount, last_interaction) VALUES (?, ?, 1, 0, 0, ?) ON CONFLICT(phone) DO UPDATE SET last_interaction=excluded.last_interaction`, [phone, finalId, timestamp]); 
            
            io.emit('new_message', { phone: phone, role: 'manual', text: message, time: timestamp });
            io.emit('update_chats_list');

            res.json({ success: true }); 
        } else res.status(500).json({ error: "Error enviando el mensaje por la API" }); 
    } catch(e) { res.status(500).json({ error: "Error interno del servidor" }); } 
});

app.post('/api/chat/send-template', proteger, upload.single('file'), async (req, res) => {
    const phone = req.body.phone;
    if (!phone) return res.status(400).json({ error: "Falta teléfono" });
    
    const cleanPhone = phone.replace(/\D/g, '');
    const templateName = req.body.templateName;
    const language = req.body.language || "es_CO";
    const previewText = req.body.previewText;

    let components = [];
    if (req.body.components) {
        try { components = JSON.parse(req.body.components); } catch(e) {}
    }

    try {
        if (req.file) {
            const mediaId = await uploadToMeta(req.file.buffer, req.file.mimetype, req.file.originalname);
            if (mediaId) {
                let mediaType = 'document';
                if (req.file.mimetype.startsWith('image/')) mediaType = 'image';
                else if (req.file.mimetype.startsWith('video/')) mediaType = 'video';

                components.push({
                    type: "header",
                    parameters: [{ type: mediaType, [mediaType]: { id: mediaId } }]
                });
            } else {
                return res.status(500).json({ error: "Meta rechazó la carga del archivo." });
            }
        }

        const payload = {
            name: templateName,
            language: { code: language }
        };

        if (components.length > 0) {
            payload.components = components;
        }

        const sent = await enviarWhatsApp(cleanPhone, payload, 'template');
        
        if (sent) {
            const timestamp = new Date().toISOString();
            const logMsg = previewText || `[CAMPAÑA]\n📢 Plantilla: ${templateName}`;
            
            await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [cleanPhone, 'manual', logMsg, timestamp]);
            await db.run(`INSERT INTO metadata (phone, contactName, addedManual, archived, unreadCount, last_interaction) VALUES (?, ?, 1, 0, 0, ?) ON CONFLICT(phone) DO UPDATE SET last_interaction=excluded.last_interaction`, [cleanPhone, cleanPhone, timestamp]);
            
            io.emit('new_message', { phone: cleanPhone, role: 'manual', text: logMsg, time: timestamp });
            io.emit('update_chats_list');

            res.json({ success: true });
        } else {
            res.status(500).json({ error: "Rechazado por Meta (Revisa la consola de tu servidor para ver el mensaje exacto de Meta)" });
        }
    } catch (e) {
        console.error("Error enviando plantilla:", e);
        res.status(500).json({ error: "Error interno enviando plantilla" });
    }
});

app.post('/api/chat/bulk-excel', proteger, upload.fields([{ name: 'excel', maxCount: 1 }, { name: 'media', maxCount: 1 }]), async (req, res) => {
    try {
        if (!req.files || !req.files.excel) return res.status(400).json({ error: "Falta el archivo Excel" });
        
        const templateName = req.body.templateName;
        const language = req.body.language || "es_CO";
        
        if (!templateName) return res.status(400).json({ error: "Falta el nombre de la plantilla" });

        let mediaId = null;
        let mediaType = 'image';

        if (req.files.media && req.files.media[0]) {
            const mediaFile = req.files.media[0];
            if (mediaFile.mimetype.startsWith('video/')) {
                mediaType = 'video';
            } else if (mediaFile.mimetype.startsWith('application/')) {
                mediaType = 'document';
            }
            
            const safeName = mediaFile.originalname.replace(/[^a-zA-Z0-9.]/g, '_') || `archivo.${mediaType === 'video' ? 'mp4' : 'jpg'}`;
            mediaId = await uploadToMeta(mediaFile.buffer, mediaFile.mimetype, safeName);
            if (!mediaId) return res.status(500).json({ error: "Error al subir el archivo multimedia a los servidores de Meta" });
        }

        const workbook = XLSX.read(req.files.excel[0].buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        let successCount = 0;
        let errorCount = 0;

        for (const row of rows) {
            let phoneVal = null;
            let nameVal = "Cliente";

            for (const key in row) {
                const k = key.toLowerCase().trim();
                if (k.includes('telefono') || k.includes('celular') || k.includes('phone') || k === 'tel') phoneVal = row[key];
                if (k.includes('nombre') || k.includes('name') || k.includes('cliente')) nameVal = row[key];
            }

            if (!phoneVal) continue;
            let cleanPhone = phoneVal.toString().replace(/\D/g, '');
            
            if (cleanPhone.length === 10) cleanPhone = '57' + cleanPhone;
            if (cleanPhone.length < 10) continue; 

            let components = [];
            
            if (mediaId) {
                components.push({
                    type: "header",
                    parameters: [{ type: mediaType, [mediaType]: { id: mediaId } }]
                });
            }

            const payload = {
                name: templateName,
                language: { code: language }
            };

            if (components.length > 0) {
                payload.components = components;
            }

            try {
                const sent = await enviarWhatsApp(cleanPhone, payload, 'template');
                if (sent) {
                    successCount++;
                    const timestamp = new Date().toISOString();
                    const logMsg = `[CAMPAÑA EXCEL]\n📢 Plantilla: ${templateName}\n📝 Contacto: ${nameVal}${mediaId ? `\n🎞️ [${mediaType.toUpperCase()} Adjunto]` : ''}`;
                    
                    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [cleanPhone, 'manual', logMsg, timestamp]);
                    await db.run(`INSERT INTO metadata (phone, contactName, addedManual, archived, unreadCount, last_interaction) VALUES (?, ?, 1, 0, 0, ?) ON CONFLICT(phone) DO UPDATE SET last_interaction=excluded.last_interaction`, [cleanPhone, nameVal, timestamp]);

                    const existingLead = await db.get("SELECT id FROM leads WHERE phone = ?", [cleanPhone]);
                    if (!existingLead) {
                        await db.run(`INSERT INTO leads (phone, nombre, source, etiqueta, fecha, status_tag, farewell_sent, followup_day) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`, 
                            [cleanPhone, nameVal, 'Campaña Excel', 'Pendiente', timestamp, 'PROMO']);
                    }

                    io.emit('new_message', { phone: cleanPhone, role: 'manual', text: logMsg, time: timestamp });
                } else {
                    errorCount++;
                }
            } catch(e) {
                errorCount++;
            }

            await new Promise(r => setTimeout(r, 250)); 
        }

        io.emit('update_chats_list');
        res.json({ success: true, sent: successCount, failed: errorCount });

    } catch (error) {
        res.status(500).json({ error: "Error procesando el archivo Excel" });
    }
});

// ============================================================
// NUEVO WEBHOOK OMNICANAL (MESSENGER, INSTAGRAM & COMENTARIOS)
// ============================================================

async function getOmniProfile(senderId) {
    try {
        if (!IG_TOKEN) return { name: senderId, photo: null };
        const res = await axios.get(`https://graph.facebook.com/v21.0/${senderId}?fields=name,profile_pic&access_token=${IG_TOKEN}`);
        return { name: res.data.name || senderId, photo: res.data.profile_pic || null };
    } catch(e) {
        return { name: senderId, photo: null };
    }
}

app.get('/api/omnicanal/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/api/omnicanal/webhook', async (req, res) => {
    res.sendStatus(200); 
    
    try {
        const body = req.body;

        if (body.object === 'page' || body.object === 'instagram') {
            const entries = body.entry || [];
            
            for (let entry of entries) {
                const messagingEvents = entry.messaging || [];
                
                for (let event of messagingEvents) {
                    if (event.message) {
                        const isEcho = !!event.message.is_echo;
                        
                        const targetId = isEcho ? event.recipient.id : event.sender.id;
                        
                        if (isEcho && event.message.app_id && event.message.app_id.toString() === process.env.META_APP_ID) {
                            continue;
                        }

                        const text = event.message.text || "[Multimedia/Adjunto]";
                        const source = body.object === 'page' ? 'messenger' : 'instagram';
                        const timestamp = new Date().toISOString();
                        const role = isEcho ? 'manual' : 'user';

                        let metaInfo = await db.get("SELECT contactName FROM metadata WHERE phone = ?", [targetId]);
                        let finalName = targetId;
                        let photoUrl = null;

                        if (!metaInfo || metaInfo.contactName === targetId) {
                            const profileData = await getOmniProfile(targetId);
                            finalName = profileData.name;
                            photoUrl = profileData.photo;
                        } else {
                            finalName = metaInfo.contactName;
                        }

                        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [targetId, role, text, timestamp]);
                        
                        const unreadIncr = isEcho ? 0 : 1;
                        
                        await db.run(`INSERT INTO metadata (phone, contactName, photoUrl, archived, unreadCount, last_interaction, channel) 
                                      VALUES (?, ?, ?, 0, ?, ?, ?) 
                                      ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName, photoUrl=COALESCE(excluded.photoUrl, photoUrl), archived=0, unreadCount = unreadCount + ?, last_interaction=excluded.last_interaction, channel=excluded.channel`, 
                                      [targetId, finalName, photoUrl, unreadIncr, timestamp, source, unreadIncr]);
                        
                        io.emit('new_message', { phone: targetId, role: role, text: text, time: timestamp });
                        io.emit('update_chats_list');

                        console.log(`📢 TIEMPO REAL (${source.toUpperCase()}) - ChatID:${targetId} | Rol: ${role} | Msj:${text}`);
                    }
                }

                // 2. ATRAPAR COMENTARIOS EN PUBLICACIONES
                const changesEvents = entry.changes || [];
                for (let change of changesEvents) {
                    if (change.field === 'comments') {
                        const val = change.value;
                        const originalId = val.from.id;
                        const targetId = originalId + '_comentarios';
                        const senderName = (val.from.name || originalId) + ' (Comentarios)';
                        
                        const rawText = val.text || '';
                        const text = `💬 [COMENTARIO EN POST]: ${rawText}`;
                        const source = body.object === 'page' ? 'messenger' : 'instagram';
                        const timestamp = new Date().toISOString();

                        const mediaId = val.media?.id || val.post?.id || val.post_id || null;

                        await db.run("INSERT INTO history (phone, role, text, time, msg_type, media_id) VALUES (?, ?, ?, ?, 'comment', ?)", [targetId, 'user', text, timestamp, mediaId]);
                        
                        await db.run(`INSERT INTO metadata (phone, contactName, archived, unreadCount, last_interaction, channel) 
                                      VALUES (?, ?, 0, 1, ?, ?) 
                                      ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName, archived=0, unreadCount = unreadCount + 1, last_interaction=excluded.last_interaction, channel=excluded.channel`, 
                                      [targetId, senderName, timestamp, source]);
                        
                        io.emit('new_message', { phone: targetId, role: 'user', text: text, time: timestamp, msg_type: 'comment', media_id: mediaId });
                        io.emit('update_chats_list');

                        console.log(`📣 ${source.toUpperCase()} COMENTARIO - De:${senderName} | Msj: ${rawText} | PostID:${mediaId}`);
                    }
                }
            }
        }
    } catch (error) {
        console.error("❌ Error en Webhook Omnicanal:", error);
    }
});

// ============================================================
// WEBHOOK ORIGINAL (SOLO WHATSAPP CLOUD API)
// ============================================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => { 
    res.sendStatus(200); 
    try { 
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const val = changes?.value; 
        
        if (val?.statuses && val.statuses[0]) {
            return;
        }

        const msg = val?.messages?.[0]; 
        if (msg && msg.from === PHONE_ID) return;

        if (val?.contacts?.[0]?.profile?.name) {
            await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName WHERE addedManual=0", [val.contacts[0].wa_id, val.contacts[0].profile.name]); 
        }
        
        if(msg) { 
            const phone = msg.from; 
            
            if (msg.referral) {
                const refSource = `Meta Ads: ${msg.referral.source_url || 'N/A'}`;
                const existeLead = await db.get("SELECT id FROM leads WHERE phone = ?", [phone]);
                if (existeLead) {
                    await db.run("UPDATE leads SET source = ? WHERE phone = ?", [refSource, phone]);
                } else {
                    await db.run(`INSERT INTO leads (phone, nombre, source, etiqueta, fecha, farewell_sent, followup_day) VALUES (?, ?, ?, ?, ?, 0, 0)`, 
                        [phone, val?.contacts?.[0]?.profile?.name || "Cliente Ads", refSource, "Pendiente", new Date().toISOString()]);
                }
            }

            let userMsg = msg.text?.body || ""; 
            let isFile = false;

            if(msg.type !== 'text') { 
                isFile = true; 
                let caption = msg[msg.type]?.caption || ""; 
                if (msg[msg.type] && msg[msg.type].id) {
                    userMsg = `[MEDIA:${msg.type.toUpperCase()}:${msg[msg.type].id}]${caption}`; 
                } else {
                    userMsg = `[EVENTO:${msg.type.toUpperCase()}]${caption}`;
                }
            } 
            
            if (userMsg) {
                const timestamp = new Date().toISOString();
                await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'user', userMsg, timestamp]);
                await db.run("INSERT INTO metadata (phone, archived, unreadCount, last_interaction) VALUES (?, 0, 1, ?) ON CONFLICT(phone) DO UPDATE SET archived=0, unreadCount = unreadCount + 1, last_interaction=excluded.last_interaction", [phone, timestamp]);
                
                io.emit('new_message', { phone: phone, role: 'user', text: userMsg, time: timestamp });
                io.emit('update_chats_list');
            }

            if (messageQueue.has(phone)) { clearTimeout(messageQueue.get(phone).timer); }

            const safeName = val?.contacts?.[0]?.profile?.name || "Cliente";
            const currentData = messageQueue.get(phone) || { text: [], name: safeName, isFile: false };
            
            currentData.text.push(userMsg); 
            if(isFile) currentData.isFile = true;

            const timer = setTimeout(async () => {
                const data = messageQueue.get(phone); 
                const fullText = data.text.join("\n"); 
                messageQueue.delete(phone); 
                
                const reply = await procesarConICBOT(
                    fullText, 
                    data.isFile ? '[ARCHIVO]' : fullText, 
                    phone, 
                    data.name, 
                    data.isFile 
                ); 
                
                if (reply) {
                    await enviarWhatsApp(phone, reply);
                }

            }, DEBOUNCE_TIME);

            currentData.timer = timer;
            messageQueue.set(phone, currentData);
        } 
    } catch(e) {} 
});

// ============================================================
// 🔥 MÓDULO: EXTRACTOR INTELIGENTE INDEPENDIENTE 🔥
// ============================================================

app.post('/api/extractor/process', upload.single('image'), async (req, res) => {
    try {
        if (!API_KEY || API_KEY.trim() === '' || API_KEY === 'undefined') {
            return res.status(500).json({ success: false, message: "⚠️ GEMINI_API_KEY no está configurada." });
        }

        const { type, data } = req.body;
        let contents = [];

        const promptReglas = `
        Analiza la información provista, extrae los datos del cliente y clasifica los campos según las siguientes reglas de negocio.
        REGLAS DE CLASIFICACIÓN PARA 'categoria_producto':
        - "Maquinaria nueva": Equipos Shantui o especifica "nuevo".
        - "Maquinaria usada": Hitachi, Komatsu, CAT o "usado".
        - "Volquetas": Shacman o "volqueta".
        - "Martillos Hidráulicos": Martillos, Beilite, Max Power.
        - "Repuestos": motores, bombas, empaquetaduras, dientes, tren rodaje, zapatas, cadenas, filtros, aceites.
        - "Accesorios": pontones o aditamentos.
        - "Brazos largos": brazos largos.
        - "Servicio": mano de obra, taller o mantenimiento.
        - "Otros": No se puede identificar.

        REGLAS DE GEOLOCALIZACIÓN PARA 'ubicacion':
        1. Identifica departamento correspondiente de Colombia.
        2. Si menciona Bogotá, asígnale exactamente "Bogotá".
        3. Si no hay ubicación, pon "No proporcionado".

        Devuelve ESTRICTAMENTE un JSON, sin texto adicional ni bloques de markdown (\`\`\`json):
        {
            "nombre": "Valor", "apellido": "Valor", "telefono": "Valor indicativo completo",
            "producto_detalle": "Valor", "categoria_producto": "Valor clasificado",
            "correo": "Valor", "ubicacion": "Nombre exacto del departamento o 'No proporcionado'"
        }`;

        if (type === 'text') {
            contents = [{ role: 'user', parts: [{ text: `${promptReglas}\n\nTexto:\n${data}` }] }];
        } else if (type === 'image' && req.file) {
            const base64Data = req.file.buffer.toString('base64');
            contents = [{ role: 'user', parts: [
                { text: promptReglas },
                { inlineData: { mimeType: req.file.mimetype, data: base64Data } }
            ]}];
        }

        const requestBody = {
            contents: contents,
            generationConfig: { responseMimeType: "application/json" }
        };

        const gRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, requestBody);
        const rawText = gRes.data.candidates[0].content.parts[0].text;
        const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const extractedData = JSON.parse(cleanText);

        res.json({ success: true, data: extractedData });

    } catch (error) {
        const detail = error.response?.data?.error?.message || error.message;
        console.error("Error en Extractor IA:", detail);
        res.status(500).json({ success: false, message: `Fallo en la IA: ${detail}` });
    }
});

app.post('/api/extractor/salesforce', proteger, async (req, res) => {
    try {
        const payload = req.body;
        
        let telefonoFinal = (payload.telefono || "").replace(/\D/g, '');
        if (telefonoFinal.startsWith("57") && telefonoFinal.length > 10) telefonoFinal = telefonoFinal.substring(2);

        if (!telefonoFinal) {
            return res.status(400).json({ success: false, message: "El número de teléfono es obligatorio para validar en Salesforce." });
        }

        let categoriaLimpia = limpiarCategoriaSF(payload.categoria_producto);
        let dptoSF = limpiarUbicacionSF(payload.ubicacion);

        const extOutcome = await runSfOperation(async (sfConn) => {
            const q_lead = await sfConn.query(`SELECT Id, Name, OwnerId FROM Lead WHERE (Phone LIKE '%${telefonoFinal}%' OR MobilePhone LIKE '%${telefonoFinal}%') AND IsConverted = FALSE LIMIT 1`);
            if (q_lead.totalSize > 0) {
                const rec = q_lead.records[0];
                return { 
                    duplicate: true,
                    existingRecord: {
                        tipo: 'Candidato', id: rec.Id, nombre: rec.Name, owner_id: rec.OwnerId, who_id: rec.Id, what_id: null,
                        link: `https://importadoracolombia.lightning.force.com/lightning/r/Lead/${rec.Id}/view`
                    },
                    message: `Este cliente ya existe como Candidato (${rec.Name}). ¿Deseas asignarle una Tarea de seguimiento?` 
                };
            }

            const q_contact = await sfConn.query(`SELECT Id, Name, OwnerId, AccountId FROM Contact WHERE (Phone LIKE '%${telefonoFinal}%' OR MobilePhone LIKE '%${telefonoFinal}%') LIMIT 1`);
            if (q_contact.totalSize > 0) {
                const rec = q_contact.records[0];
                return { 
                    duplicate: true,
                    existingRecord: {
                        tipo: 'Contacto', id: rec.Id, nombre: rec.Name, owner_id: rec.OwnerId, who_id: rec.Id, what_id: rec.AccountId,
                        link: `https://importadoracolombia.lightning.force.com/lightning/r/Contact/${rec.Id}/view`
                    },
                    message: `Este cliente ya existe como Contacto (${rec.Name}). ¿Deseas asignarle una Tarea de seguimiento?` 
                };
            }

            const q_account = await sfConn.query(`SELECT Id, Name, OwnerId FROM Account WHERE Phone LIKE '%${telefonoFinal}%' LIMIT 1`);
            if (q_account.totalSize > 0) {
                const rec = q_account.records[0];
                return { 
                    duplicate: true,
                    existingRecord: {
                        tipo: 'Cuenta', id: rec.Id, nombre: rec.Name, owner_id: rec.OwnerId, who_id: null, what_id: rec.Id,
                        link: `https://importadoracolombia.lightning.force.com/lightning/r/Account/${rec.Id}/view`
                    },
                    message: `Este cliente ya existe como Cuenta (${rec.Name}). ¿Deseas asignarle una Tarea de seguimiento?` 
                };
            }

            const sfData = {
                FirstName: payload.nombre && payload.nombre !== "No proporcionado" ? payload.nombre : "Cliente",
                LastName: payload.apellido && payload.apellido !== "No proporcionado" ? payload.apellido : "Extraído",
                Phone: telefonoFinal,
                Email: payload.correo && payload.correo !== "No proporcionado" ? payload.correo : "",
                Company: `${payload.nombre || 'Cliente'} ${payload.apellido || 'ICC'}`.trim(),
                DescripciondeProducto__c: payload.producto_detalle && payload.producto_detalle !== "No proporcionado" ? payload.producto_detalle : "",
                Producto_de_su_inter_s__c: categoriaLimpia,
                Ubicaci_n__c: dptoSF,
                LeadSource: payload.origen || "WhatsApp" 
            };

            if (payload.ejecutivo && payload.ejecutivo.startsWith("005")) {
                sfData.OwnerId = payload.ejecutivo;
            }

            const created = await sfConn.sobject("Lead").create(sfData);
            return { duplicate: false, created };
        });

        if (extOutcome.duplicate) {
            return res.status(400).json({
                success: false,
                isDuplicate: true,
                existingRecord: extOutcome.existingRecord,
                message: extOutcome.message
            });
        }

        if (extOutcome.created && extOutcome.created.success) {
            res.json({ success: true, sfId: extOutcome.created.id });
        } else {
            res.status(500).json({ success: false, message: "Salesforce rechazó la creación." });
        }
    } catch (error) {
        console.error("Error Salesforce Extractor:", error);
        if (error.message && error.message.toLowerCase().includes("duplicate")) {
            return res.status(400).json({ 
                success: false, 
                isDuplicate: true,
                message: "Salesforce detectó un DUPLICADO por reglas internas (ej. Correo repetido). Usa el botón de Crear Tarea." 
            });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================
// 🚀 MÓDULO CORE INTEGRA: COTIZADOR EJECUTIVO MULTI-USUARIO
// ============================================================

// 0. Obtener Plantillas Oficiales de Presupuesto de Salesforce (IDs 0EH...)
app.get('/api/cotizador/templates', async (req, res) => {
    try {
        const templates = await runSfOperation(async (conn) => {
            return await getSfQuoteTemplates(conn);
        });
        res.json({ success: true, templates });
    } catch (e) {
        res.json({ success: false, templates: [] });
    }
});

// 1. Buscador en tiempo real de Cuentas (por NIT, Cédula o Nombre) y alerta de duplicados
app.get('/api/cotizador/search-accounts', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q || q.length < 2) return res.json({ success: true, records: [] });

        const cleanNum = q.replace(/\D/g, '');
        const safeText = q.replace(/'/g, "\\'");

        let whereClause = `Name LIKE '%${safeText}%' OR Nombre_de_la_Empresa__c LIKE '%${safeText}%' OR Nombre_de_la_Persona__c LIKE '%${safeText}%'`;
        if (cleanNum.length >= 5 && cleanNum.length <= 15) {
            const nitSinDV = cleanNum.length === 10 ? cleanNum.substring(0, 9) : cleanNum;
            whereClause += ` OR N_mero_de_NIT__c = ${cleanNum} OR N_mero_de_C_dula__c = ${cleanNum} OR N_mero_de_NIT__c = ${nitSinDV}`;
        }

        const records = await runSfOperation(async (conn) => {
            const result = await conn.query(`
                SELECT Id, Name, RecordTypeId, Phone, Correo_de_facturaci_n__c, 
                       N_mero_de_NIT__c, N_mero_de_C_dula__c, Industry, 
                       Ubicaci_n__c, Ciudad__c, Direccion_detalle__c, CurrencyIsoCode, OwnerId
                FROM Account 
                WHERE ${whereClause}
                ORDER BY LastModifiedDate DESC 
                LIMIT 15
            `);
            return result.records;
        });

        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Buscador en tiempo real de Contactos (filtrable por Cuenta o texto)
app.get('/api/cotizador/search-contacts', async (req, res) => {
    try {
        const q = (req.query.q || '').trim().replace(/'/g, "\\'");
        const accountId = (req.query.accountId || '').trim();

        let conditions = [];
        if (accountId) conditions.push(`AccountId = '${accountId}'`);
        if (q) conditions.push(`(Name LIKE '%${q}%' OR Phone LIKE '%${q}%' OR Email LIKE '%${q}%')`);

        const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const records = await runSfOperation(async (conn) => {
            const result = await conn.query(`
                SELECT Id, Name, Phone, MobilePhone, Email, AccountId, Account.Name 
                FROM Contact 
                ${whereSql}
                ORDER BY LastModifiedDate DESC 
                LIMIT 15
            `);
            return result.records;
        });

        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Buscador Global/Específico entre los +8.000 Productos (Filtra vendidas/inactivas + soporta abreviaturas EXC.)
app.get('/api/cotizador/search-products', async (req, res) => {
    try {
        const pricebookId = (req.query.pricebookId || 'ALL').trim();
        const currency = (req.query.currency || 'COP').trim();
        const includeInactive = req.query.includeInactive === 'true';
        const q = (req.query.q || '').trim().replace(/'/g, "\\'");

        let searchFilter = '';
        if (q) {
            const terms = q.split(/\s+/).filter(Boolean);
            const termClauses = terms.map(t => {
                const low = t.toLowerCase();
                if (low.startsWith('excav')) {
                    // En Salesforce muchos productos usan "EXC." en vez de "EXCAVADORA"
                    return `(Product2.Name LIKE '%${t}%' OR Product2.Name LIKE '%EXC%' OR Product2.Family LIKE '%${t}%' OR Product2.Description LIKE '%${t}%')`;
                }
                return `(Product2.Name LIKE '%${t}%' OR Product2.ProductCode LIKE '%${t}%' OR Product2.Family LIKE '%${t}%' OR Product2.Description LIKE '%${t}%')`;
            });
            searchFilter = `AND ${termClauses.join(' AND ')}`;
        }

        const activeFilter = includeInactive
            ? `AND IsActive = true`
            : `AND IsActive = true AND Product2.IsActive = true`;

        const records = await runSfOperation(async (conn) => {
            let pbClause = '';
            if (pricebookId && pricebookId !== 'ALL') {
                pbClause = `AND Pricebook2Id = '${pricebookId}'`;
            }

            let resQuery = await conn.query(`
                SELECT Id, Pricebook2Id, Pricebook2.Name, Pricebook2.IsStandard,
                       Product2Id, Product2.Name, Product2.ProductCode, Product2.Family, Product2.Description, Product2.IsActive,
                       UnitPrice, CurrencyIsoCode
                FROM PricebookEntry
                WHERE CurrencyIsoCode = '${currency}'
                  ${activeFilter}
                  ${pbClause}
                  ${searchFilter}
                ORDER BY Pricebook2.IsStandard ASC, Product2.Name ASC
                LIMIT 150
            `);

            // Si buscó en una lista específica y no encontró, busca globalmente en todas las listas activas
            if (resQuery.records.length === 0 && pricebookId !== 'ALL') {
                resQuery = await conn.query(`
                    SELECT Id, Pricebook2Id, Pricebook2.Name, Pricebook2.IsStandard,
                           Product2Id, Product2.Name, Product2.ProductCode, Product2.Family, Product2.Description, Product2.IsActive,
                           UnitPrice, CurrencyIsoCode
                    FROM PricebookEntry
                    WHERE CurrencyIsoCode = '${currency}'
                      ${activeFilter}
                      ${searchFilter}
                    ORDER BY Pricebook2.IsStandard ASC, Product2.Name ASC
                    LIMIT 150
                `);
            }

            // Filtrar máquinas que tengan explícitamente "VENDIDA" o "VENDIDO" en el nombre/descripción a menos que pidan ver inactivos
            let finalRecords = resQuery.records;
            if (!includeInactive) {
                finalRecords = finalRecords.filter(r => {
                    const fullTxt = `${r.Product2?.Name || ''} ${r.Product2?.Description || ''}`.toUpperCase();
                    return !fullTxt.includes('VENDIDA') && !fullTxt.includes('VENDIDO');
                });
            }

            return finalRecords;
        });

        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. Lector Inteligente de RUT (PDF o Imagen) o Texto para Auto-llenar Cuenta
app.post('/api/cotizador/extract-rut', upload.single('file'), async (req, res) => {
    try {
        if (!API_KEY) return res.status(500).json({ success: false, message: "Falta GEMINI_API_KEY" });

        const promptRut = `
        Eres un analista tributario y comercial experto en Colombia (DIAN / RUT).
        Extrae con precisión quirúrgica los datos del documento o texto adjunto para crear una Cuenta en Salesforce.

        REGLAS ESTRICTAS:
        1. 'tipo_registro': Si es Persona Jurídica (Empresa) devuelve "Empresas". Si es Persona Natural devuelve "Particulares".
        2. 'nit_o_cedula': Devuelve ÚNICAMENTE los dígitos numéricos del NIT o Cédula, SIN puntos, SIN guiones y SIN el dígito de verificación (casilla 6 del RUT).
        3. 'nombre_cuenta': Si es empresa, la Razón Social (casilla 35). Si es persona natural, Nombres y Apellidos completos.
        4. 'ubicacion': Homologa el departamento a uno de estos valores exactos: Amazonas, Antioquia, Arauca, Atlántico, Bolívar, Bogotá, Boyacá, Caldas, Caquetá, Casanare, Cauca, Cesar, Chocó, Córdoba, Cundinamarca, Distrito Capital, Guainía, Guaviare, Huila, La Guajira, Magdalena, Meta, Nariño, Norte De Santander, Putumayo, Quindío, Risaralda, San Andrés Y Providencia, Santander, Sucre, Tolima, Valle, Vaupés, Vichada. (Si es Bogotá D.C., usa "Bogotá").
        5. 'industria': Clasifica según la actividad económica en una de: Demolición, Movimiento de tierra, Minería, Agricultura, Infraestructura, Alquiler, Fluvial, Urbanismo, Otros.

        Devuelve ESTRICTAMENTE este JSON:
        {
            "tipo_registro": "Empresas o Particulares",
            "nombre_cuenta": "",
            "nit_o_cedula": "",
            "telefono": "",
            "correo": "",
            "industria": "Otros",
            "ubicacion": "Bogotá",
            "ciudad": "",
            "direccion": ""
        }`;

        let parts = [{ text: promptRut }];
        if (req.file) {
            parts.push({
                inlineData: {
                    mimeType: req.file.mimetype,
                    data: req.file.buffer.toString('base64')
                }
            });
        } else if (req.body.text) {
            parts.push({ text: `Texto del cliente:\n${req.body.text}` });
        } else {
            return res.status(400).json({ success: false, message: "No se envió archivo ni texto." });
        }

        const gRes = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
            { contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: "application/json" } }
        );

        const rawText = gRes.data.candidates[0].content.parts[0].text;
        const cleanJson = JSON.parse(rawText.replace(/```json/g, '').replace(/```/g, '').trim());
        cleanJson.nit_o_cedula = (cleanJson.nit_o_cedula || '').toString().replace(/\D/g, '');

        res.json({ success: true, data: cleanJson });
    } catch (error) {
        const detail = error.response?.data?.error?.message || error.message;
        res.status(500).json({ success: false, message: `Error leyendo documento: ${detail}` });
    }
});

// 5. Transacción Todo-En-Uno: Cuenta + Archivo RUT + Oportunidad + Productos + Presupuesto + PDF Oficial SF
app.post('/api/cotizador/procesar-todo', upload.single('rutFile'), async (req, res) => {
    try {
        const payload = JSON.parse(req.body.payload);
        const rutFile = req.file;

        const result = await runSfOperation(async (conn) => {
            let accountId = payload.account.existingAccountId || null;
            let accountName = payload.account.name;
            let rutUploadedId = null;

            // PASO A: CREAR CUENTA SI ES NUEVA
            if (!accountId) {
                const isEmpresa = payload.account.recordType === 'Empresas';
                const numDoc = Number((payload.account.nit || '').toString().replace(/\D/g, '')) || null;
                const interesesStr = Array.isArray(payload.account.intereses) && payload.account.intereses.length > 0
                    ? payload.account.intereses.join(';')
                    : 'Otros';

                const newAccData = {
                    RecordTypeId: isEmpresa ? '012Dn000000mInkIAE' : '012Dn000000mInlIAE',
                    Name: payload.account.name,
                    Phone: payload.account.phone || '',
                    Correo_de_facturaci_n__c: payload.account.email || '',
                    Industry: payload.account.industry || null,
                    Monto_de_cr_dito__c: Number(payload.account.creditAmount || 0),
                    Estado__c: payload.account.status || 'Activo',
                    CurrencyIsoCode: payload.account.currency || 'COP',
                    Ubicaci_n__c: limpiarUbicacionSF(payload.account.ubicacion) || 'Bogotá',
                    Ciudad__c: payload.account.ciudad || 'Bogotá',
                    Direccion_detalle__c: payload.account.direccion || 'Pendiente',
                    Producto_de_su_interes__c: interesesStr,
                    Description: payload.account.description || '',
                    Hist_rico_de_ventas__c: payload.account.historico || '',
                    Futuros_intereses__c: payload.account.futuros || ''
                };

                if (payload.account.parentId) newAccData.ParentId = payload.account.parentId;
                if (payload.ownerId && payload.ownerId.startsWith('005')) newAccData.OwnerId = payload.ownerId;

                if (isEmpresa) {
                    newAccData.Nombre_de_la_Empresa__c = payload.account.empresaName || payload.account.name;
                    if (numDoc) newAccData.N_mero_de_NIT__c = numDoc;
                } else {
                    newAccData.Nombre_de_la_Persona__c = payload.account.personaName || payload.account.name;
                    if (numDoc) newAccData.N_mero_de_C_dula__c = numDoc;
                }

                const accRes = await conn.sobject('Account').create(newAccData);
                if (!accRes.success) throw new Error("No se pudo crear la Cuenta en Salesforce.");
                accountId = accRes.id;
            }

            // PASO A.2: SI SUBIÓ ARCHIVO RUT, CARGARLO AUTOMÁTICAMENTE A "ARCHIVOS" DE LA CUENTA
            if (rutFile && accountId) {
                try {
                    const cvRes = await conn.sobject('ContentVersion').create({
                        Title: `RUT_${accountName.replace(/[^a-zA-Z0-9 ]/g, '').trim()}`,
                        PathOnClient: rutFile.originalname || 'RUT_Cliente.pdf',
                        VersionData: rutFile.buffer.toString('base64'),
                        FirstPublishLocationId: accountId
                    });
                    if (cvRes.success) rutUploadedId = cvRes.id;
                } catch (cvErr) {
                    console.error("⚠️ Error subiendo adjunto RUT a la cuenta:", cvErr.message);
                }
            }

            // PASO B: Determinar Pricebook2Id real de los productos seleccionados
            let finalPricebookId = (payload.opportunity.pricebookId && payload.opportunity.pricebookId !== 'ALL')
                ? payload.opportunity.pricebookId
                : '01sDn000001UtQvIAK';
            if (payload.items && payload.items.length > 0 && payload.items[0].pricebook2Id) {
                finalPricebookId = payload.items[0].pricebook2Id;
            }

            // PASO C: CREAR OPORTUNIDAD
            const oppIntereses = Array.isArray(payload.opportunity.intereses) && payload.opportunity.intereses.length > 0
                ? payload.opportunity.intereses.join(';')
                : 'Otros';

            const newOppData = {
                Name: payload.opportunity.name,
                AccountId: accountId,
                StageName: payload.opportunity.stage || 'Cotización',
                CloseDate: payload.opportunity.closeDate,
                CurrencyIsoCode: payload.opportunity.currency || 'COP',
                Pricebook2Id: finalPricebookId,
                Producto_de_interes__c: oppIntereses,
                Loss_Reason_del__c: payload.opportunity.lossReason || 'No aplica',
                Description: payload.opportunity.description || ''
            };

            if (payload.opportunity.origin) newOppData.Type = payload.opportunity.origin;
            if (payload.ownerId && payload.ownerId.startsWith('005')) {
                newOppData.OwnerId = payload.ownerId;
            }

            const oppRes = await conn.sobject('Opportunity').create(newOppData);
            if (!oppRes.success) throw new Error("No se pudo crear la Oportunidad en Salesforce.");
            const opportunityId = oppRes.id;

            // PASO D: INSERTAR PRODUCTOS EN LA OPORTUNIDAD (OpportunityLineItem)
            if (payload.items && payload.items.length > 0) {
                for (const item of payload.items) {
                    const discFactor = 1 - (Number(item.discountPct || 0) / 100);
                    const netUnitPrice = Math.round(Number(item.unitPrice) * discFactor * 100) / 100;
                    await conn.sobject('OpportunityLineItem').create({
                        OpportunityId: opportunityId,
                        PricebookEntryId: item.pricebookEntryId,
                        Quantity: Number(item.quantity || 1),
                        UnitPrice: netUnitPrice,
                        Description: item.description || ''
                    });
                }
            }

            // PASO E: CREAR PRESUPUESTO (Quote)
            const newQuoteData = {
                Name: payload.quote.name || payload.opportunity.name,
                OpportunityId: opportunityId,
                Pricebook2Id: finalPricebookId,
                Status: payload.quote.status || 'En Revisión',
                Tiempo_de_entrega_d_as__c: payload.quote.deliveryTime || 'Inmediata',
                Forma_de_pago__c: payload.quote.paymentMethod || 'Contado',
                Descripcion_de_forma_de_pago__c: payload.quote.paymentDescription || 'Pago de contado.',
                Validez_de_ofertas_d_as__c: Number(payload.quote.validityDays || 15),
                ExpirationDate: payload.quote.expirationDate,
                Description: payload.quote.description || 'Cotización comercial.',
                Garant_a__c: payload.quote.warranty || '6 meses',
                Tax: Number(payload.quote.totalTax || 0),
                ShippingHandling: Number(payload.quote.shipping || 0),
                Email: payload.quote.email || payload.account.email || '',
                Phone: payload.quote.phone || payload.account.phone || ''
            };

            if (payload.quote.contactId) newQuoteData.ContactId = payload.quote.contactId;

            const quoteRes = await conn.sobject('Quote').create(newQuoteData);
            if (!quoteRes.success) throw new Error("No se pudo crear el Presupuesto (Quote) en Salesforce.");
            const quoteId = quoteRes.id;

            // PASO F: INSERTAR PRODUCTOS EN EL PRESUPUESTO (QuoteLineItem con % Descuento nativo)
            if (payload.items && payload.items.length > 0) {
                for (const item of payload.items) {
                    await conn.sobject('QuoteLineItem').create({
                        QuoteId: quoteId,
                        PricebookEntryId: item.pricebookEntryId,
                        Product2Id: item.product2Id,
                        Quantity: Number(item.quantity || 1),
                        UnitPrice: Number(item.unitPrice),
                        Discount: Number(item.discountPct || 0),
                        Description: item.description || ''
                    });
                }
            }

            // PASO G: RESOLVER PLANTILLA DE PDF EN SALESFORCE Y GENERAR QUOTEDOCUMENT OFICIAL
            const templates = await getSfQuoteTemplates(conn);
            const desiredTpl = payload.quote.templateName || '';
            let matchedTpl = templates.find(t => t.id === desiredTpl)
                || templates.find(t => normalizeStrMatch(t.fullName).includes(normalizeStrMatch(desiredTpl)) || normalizeStrMatch(desiredTpl).includes(normalizeStrMatch(t.fullName)))
                || templates[0];

            let quoteDocumentId = null;
            let resolvedTemplateId = matchedTpl ? matchedTpl.id : null;

            if (resolvedTemplateId) {
                try {
                    const pdfBuf = await fetchOfficialSalesforcePdf(conn, quoteId, resolvedTemplateId);
                    if (pdfBuf) {
                        const qdRes = await conn.sobject('QuoteDocument').create({
                            QuoteId: quoteId,
                            Document: pdfBuf.toString('base64')
                        });
                        if (qdRes.success) quoteDocumentId = qdRes.id;
                    }
                } catch (pdfErr) {
                    console.error("⚠️ Aviso generando QuoteDocument automático:", pdfErr.message);
                }
            }

            const sfPdfViewerUrl = resolvedTemplateId
                ? `https://importadoracolombia.my.salesforce.com/quote/quoteTemplateDataViewer.apexp?id=${quoteId}&summlid=${resolvedTemplateId}`
                : `https://importadoracolombia.lightning.force.com/lightning/r/Quote/${quoteId}/view`;

            return {
                accountId,
                opportunityId,
                quoteId,
                rutUploadedId,
                quoteDocumentId,
                templateId: resolvedTemplateId,
                links: {
                    account: `https://importadoracolombia.lightning.force.com/lightning/r/Account/${accountId}/view`,
                    opportunity: `https://importadoracolombia.lightning.force.com/lightning/r/Opportunity/${opportunityId}/view`,
                    quote: `https://importadoracolombia.lightning.force.com/lightning/r/Quote/${quoteId}/view`,
                    sfNativePdf: sfPdfViewerUrl,
                    downloadPdfApi: `/api/cotizador/download-sf-pdf?quoteId=${quoteId}&templateName=${encodeURIComponent(desiredTpl)}&templateId=${resolvedTemplateId || ''}`
                }
            };
        });

        res.json({ success: true, data: result });
    } catch (error) {
        console.error("❌ Error en Cotizador Todo-En-Uno:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 6. Endpoint para descargar el PDF Oficial generado por las Plantillas de Salesforce
app.get('/api/cotizador/download-sf-pdf', async (req, res) => {
    try {
        const quoteId = (req.query.quoteId || '').trim();
        let templateId = (req.query.templateId || '').trim();
        const templateName = (req.query.templateName || '').trim();

        if (!quoteId) return res.status(400).send("Falta quoteId");

        const pdfOutcome = await runSfOperation(async (conn) => {
            // 1. Si no vino el templateId, lo buscamos por nombre en los metadatos de Salesforce
            if (!templateId) {
                const templates = await getSfQuoteTemplates(conn);
                const matched = templates.find(t => normalizeStrMatch(t.fullName).includes(normalizeStrMatch(templateName)) || normalizeStrMatch(templateName).includes(normalizeStrMatch(t.fullName))) || templates[0];
                if (matched) templateId = matched.id;
            }

            // 2. Intentar descargar el binario directo del motor de plantillas de Salesforce
            if (templateId) {
                const livePdf = await fetchOfficialSalesforcePdf(conn, quoteId, templateId);
                if (livePdf) return { buffer: livePdf };
            }

            // 3. Fallback: si ya existe un QuoteDocument adjunto al Quote en Salesforce, leer su binario
            const qdQuery = await conn.query(`SELECT Id, Document FROM QuoteDocument WHERE QuoteId = '${quoteId}' ORDER BY CreatedDate DESC LIMIT 1`);
            if (qdQuery.totalSize > 0) {
                const docId = qdQuery.records[0].Id;
                const docRes = await axios.get(`${conn.instanceUrl}/services/data/v50.0/sobjects/QuoteDocument/${docId}/Document`, {
                    headers: { 'Authorization': `Bearer ${conn.accessToken}` },
                    responseType: 'arraybuffer'
                });
                return { buffer: Buffer.from(docRes.data) };
            }

            return {
                redirectUrl: templateId
                    ? `https://importadoracolombia.my.salesforce.com/quote/quoteTemplateDataViewer.apexp?id=${quoteId}&summlid=${templateId}`
                    : `https://importadoracolombia.lightning.force.com/lightning/r/Quote/${quoteId}/view`
            };
        });

        if (pdfOutcome.buffer) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="Cotizacion_ICC_${quoteId}.pdf"`);
            return res.send(pdfOutcome.buffer);
        } else {
            return res.redirect(pdfOutcome.redirectUrl);
        }
    } catch (error) {
        console.error("❌ Error descargando PDF oficial de SF:", error.message);
        res.status(500).send("Error descargando el PDF desde Salesforce: " + error.message);
    }
});
