/*
 * SERVER BACKEND - v30.2 (ICBOT + WEBSOCKETS REALTIME + SALESFORCE CRM)
 * ============================================================
 * 1. FIX: Renombrado oficial a ICBOT completado.
 * 2. ADD: Índices SQL (idx_history_phone, idx_leads_phone).
 * 3. ADD: Cronjob de Limpieza robusto 'media_cache'.
 * 4. FIX: Audios/Videos con soporte Range 206 (codecs=opus).
 * 5. ADD: Sistema Anti-bucle (Auto-apagado del bot).
 * 6. FIX: Prioridad absoluta al nombre dado por el cliente.
 * 7. ADD: WEBSOCKETS (Socket.io) para eliminar el Polling del frontend.
 * 8. MOD: Cronjob seguimiento 7:00 AM (2 días) + Cierre automático.
 * 9. MOD: Segmentación de Categoría vs Producto Específico.
 * 10.FIX: Se eliminó el bloqueo duro de archivos adjuntos para que la IA los procese.
 * 11.ADD: Integración nativa Salesforce CRM (Duplicados + Cargue Masivo + Cache Token).
 * ============================================================
 */

const express = require('express');
const http = require('http'); // <-- WEBSOCKETS: Necesitamos el server nativo
const { Server } = require('socket.io'); // <-- WEBSOCKETS: La librería mágica
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx'); 
const { parse } = require('csv-parse/sync');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// --- 1. CONFIGURACIÓN DEL SERVIDOR ---
const app = express();
const server = http.createServer(app); // <-- WEBSOCKETS: Envolvemos Express
const io = new Server(server, {        // <-- WEBSOCKETS: Iniciamos el Túnel
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

// Cola de mensajes
const messageQueue = new Map(); 
const DEBOUNCE_TIME = 4500; 

// --- 2. VARIABLES DE ENTORNO ---
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID; 
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icbot-secure-v29-final"; 
const VERIFY_TOKEN = "ICC_2025"; 

const DEFAULT_PROMPT = `Eres ICBOT, un asistente virtual comercial de Importadora Casa Colombia. Tu objetivo principal es atender al cliente, resolver sus dudas y perfilarlo recopilando sus datos para pasarlo a un asesor humano.`;

// --- VARIABLES DE SALESFORCE ---
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD;
const SF_URL = process.env.SF_URL;

// --- 3. SESIONES ---
app.use(session({
    name: 'icc_session_id', 
    secret: SESSION_SECRET, 
    resave: false, 
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 } 
}));

const proteger = (req, res, next) => {
    if (req.session.isLogged) {
        next();
    } else {
        res.status(401).send("No autorizado.");
    }
};

app.use((req, res, next) => {
    if ((req.path.endsWith('.json') || req.path.includes('/data/')) && !req.path.startsWith('/api/')) {
        return res.status(403).send('🚫 Acceso Denegado');
    }
    next();
});

// --- 4. BASE DE DATOS (WAL MODE + ÍNDICES SENIOR) ---
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
        console.log("📂 Base de Datos Conectada (WAL Mode).");

        const tables = [
            `history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT)`,
            `leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, nombre TEXT, interes TEXT, producto_especifico TEXT, etiqueta TEXT, fecha TEXT, ciudad TEXT, departamento TEXT, correo TEXT, source TEXT DEFAULT 'Organico', status_tag TEXT, farewell_sent INTEGER DEFAULT 0, followup_day INTEGER DEFAULT 0, sf_id TEXT)`,
            `metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0, photoUrl TEXT, archived INTEGER DEFAULT 0, unreadCount INTEGER DEFAULT 0, last_interaction TEXT)`,
            `bot_status (phone TEXT PRIMARY KEY, active INTEGER DEFAULT 1)`,
            `inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT)`,
            `config (key TEXT PRIMARY KEY, value TEXT)`,
            `shortcuts (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT UNIQUE, text TEXT)`,
            `global_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, color TEXT)`,
            `knowledge_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, url TEXT, summary TEXT, active INTEGER DEFAULT 1, date TEXT)`
        ];

        for (const t of tables) await db.exec(`CREATE TABLE IF NOT EXISTS ${t}`);

        const migrations = [
            "ALTER TABLE metadata ADD COLUMN photoUrl TEXT",
            "ALTER TABLE metadata ADD COLUMN archived INTEGER DEFAULT 0",
            "ALTER TABLE metadata ADD COLUMN unreadCount INTEGER DEFAULT 0",
            "ALTER TABLE metadata ADD COLUMN last_interaction TEXT",
            "ALTER TABLE leads ADD COLUMN source TEXT DEFAULT 'Organico'",
            "ALTER TABLE leads ADD COLUMN status_tag TEXT",
            "ALTER TABLE leads ADD COLUMN farewell_sent INTEGER DEFAULT 0",
            "ALTER TABLE config ADD COLUMN logoUrl TEXT",
            "ALTER TABLE leads ADD COLUMN departamento TEXT",
            "ALTER TABLE leads ADD COLUMN producto_especifico TEXT",
            "ALTER TABLE leads ADD COLUMN followup_day INTEGER DEFAULT 0",
            "ALTER TABLE leads ADD COLUMN sf_id TEXT"
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
        // <-- WEBSOCKETS: Ahora usamos server.listen en lugar de app.listen
        serverInstance = server.listen(PORT, () => console.log(`🔥 BACKEND v30.2 ONLINE (Port ${PORT}) - WEBSOCKETS ACTIVOS`));

    } catch (e) { console.error("❌ DB FATAL ERROR:", e); }
})();

// --- EVENTOS WEBSOCKETS BÁSICOS ---
io.on('connection', (socket) => {
    console.log('⚡ Nuevo cliente conectado al Dashboard');
    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado');
    });
});

// --- 5. DIAGNÓSTICO ---
async function verificarTokenMeta() {
    try {
        const r = await axios.get(`https://graph.facebook.com/v21.0/me?access_token=${META_TOKEN}`);
        console.log(`✅ TOKEN META OK. Conectado como: ${r.data.name}`);
    } catch (e) {
        console.error("❌ ERROR CRÍTICO: Token Meta Inválido o Expirado.");
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

// --- 6. UTILIDADES ---
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
function analizarTextoFuente(texto) {
    if(!texto) return null;
    const t = texto.toLowerCase();
    if (t.includes('storeicc.com') || t.includes('deseo asesoría')) return 'Tienda Virtual';
    if (t.includes('importadoracasacolombia.com')) return 'Web';
    return null;
}

function obtenerDepartamento(ciudad) {
    if (!ciudad) return null;
    const c = ciudad.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const mapa = {
        "medellin": "Antioquia", "bello": "Antioquia", "itagui": "Antioquia", "envigado": "Antioquia", "rionegro": "Antioquia", "apartado": "Antioquia", "caucasia": "Antioquia",
        "bogota": "Bogotá D.C.", "soacha": "Cundinamarca", "chia": "Cundinamarca", "zipaquira": "Cundinamarca", "girardot": "Cundinamarca", "facatativa": "Cundinamarca", "mosquera": "Cundinamarca",
        "cali": "Valle del Cauca", "palmira": "Valle del Cauca", "buenaventura": "Valle del Cauca", "tulua": "Valle del Cauca", "cartago": "Valle del Cauca", "yumbo": "Valle del Cauca", "jamundi": "Valle del Cauca",
        "barranquilla": "Atlántico", "soledad": "Atlántico", "malambo": "Atlántico", "sabanagrande": "Atlántico",
        "cartagena": "Bolívar", "magangue": "Bolívar", "turbaco": "Bolívar", "arona": "Bolívar",
        "bucaramanga": "Santander", "floridablanca": "Santander", "giron": "Santander", "piedecuesta": "Santander", "barrancabermeja": "Santander", "san gil": "Santander",
        "pereira": "Risaralda", "dosquebradas": "Risaralda", "santa rosa de cabal": "Risaralda",
        "manizales": "Caldas", "chinchina": "Caldas", "la dorada": "Caldas", "villamaria": "Caldas",
        "armenia": "Quindío", "calarca": "Quindío", "quimbaya": "Quindío",
        "cucuta": "Norte de Santander", "ocana": "Norte de Santander", "villa del rosario": "Norte de Santander", "pamplona": "Norte de Santander",
        "ibague": "Tolima", "espinal": "Tolima", "melgar": "Tolima", "honda": "Tolima",
        "villavicencio": "Meta", "acacias": "Meta", "granada": "Meta", "puerto lopez": "Meta",
        "neiva": "Huila", "pitalito": "Huila", "garzon": "Huila", "la plata": "Huila",
        "santa marta": "Magdalena", "cienaga": "Magdalena", "fundacion": "Magdalena",
        "pasto": "Nariño", "tumaco": "Nariño", "ipiales": "Nariño",
        "popayan": "Cauca", "santander de quilichao": "Cauca", "piendamo": "Cauca",
        "valledupar": "Cesar", "aguachica": "Cesar", "codazzi": "Cesar",
        "monteria": "Córdoba", "cerete": "Córdoba", "lorica": "Córdoba", "sahagun": "Córdoba",
        "sincelejo": "Sucre", "corozal": "Sucre", "san marcos": "Sucre",
        "riohacha": "La Guajira", "maicao": "La Guajira", "uribia": "La Guajira",
        "florencia": "Caquetá", "san vicente del caguan": "Caquetá",
        "yopal": "Casanare", "aguazul": "Casanare", "villanueva": "Casanare",
        "quibdo": "Chocó", "istmina": "Chocó",
        "arauca": "Arauca", "saravena": "Arauca", "tame": "Arauca",
        "mocoa": "Putumayo", "puerto asis": "Putumayo", "orito": "Putumayo",
        "leticia": "Amazonas",
        "san andres": "San Andrés y Providencia",
        "san jose del guaviare": "Guaviare",
        "tunja": "Boyacá", "duitama": "Boyacá", "sogamoso": "Boyacá", "chiquinquira": "Boyacá", "paipa": "Boyacá"
    };
    return mapa[c] || null;
}

// --- 6.5 INTEGRACIÓN SALESFORCE ---
let sfTokenCache = null;
let sfInstanceUrl = null;
let sfTokenExpires = 0;

async function getSalesforceToken() {
    if (sfTokenCache && Date.now() < sfTokenExpires) {
        return { token: sfTokenCache, instanceUrl: sfInstanceUrl };
    }
    if (!SF_CLIENT_ID || !SF_PASSWORD) throw new Error("Credenciales de Salesforce no configuradas en entorno.");
    
    const params = new URLSearchParams();
    params.append('grant_type', 'password');
    params.append('client_id', SF_CLIENT_ID);
    params.append('client_secret', SF_CLIENT_SECRET);
    params.append('username', SF_USERNAME);
    params.append('password', SF_PASSWORD);

    const res = await axios.post(`${SF_URL}/services/oauth2/token`, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    sfTokenCache = res.data.access_token;
    sfInstanceUrl = res.data.instance_url;
    sfTokenExpires = Date.now() + (2 * 60 * 60 * 1000); // El token vive 2 horas, lo cacheamos para eficiencia
    return { token: sfTokenCache, instanceUrl: sfInstanceUrl };
}

async function checkSalesforceLead(phone) {
    try {
        const { token, instanceUrl } = await getSalesforceToken();
        const cleanPhone = phone.replace(/\D/g, ''); // Limpiamos para la consulta SOQL
        
        // Buscamos si el teléfono está en Phone o MobilePhone en Salesforce
        const query = `SELECT Id FROM Lead WHERE Phone = '${cleanPhone}' OR MobilePhone = '${cleanPhone}' LIMIT 1`;
        const url = `${instanceUrl}/services/data/v58.0/query/?q=${encodeURIComponent(query)}`;
        
        const res = await axios.get(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.data.records && res.data.records.length > 0) {
            return res.data.records[0].Id;
        }
        return null; // No existe
    } catch (e) {
        console.error("❌ Error SOQL Salesforce (Check):", e.response ? JSON.stringify(e.response.data) : e.message);
        return null;
    }
}

// --- 7. META API ---
async function uploadToMeta(buffer, mime, name) {
    try {
        const form = new FormData();
        const type = mime.includes('audio') || mime.includes('ogg') ? 'audio' : (mime.includes('image') ? 'image' : (mime.includes('video') ? 'video' : 'document'));
        form.append('file', buffer, { filename: name, contentType: mime });
        form.append('type', type); 
        form.append('messaging_product', 'whatsapp');
        
        const r = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_ID}/media`, form, { 
            headers: { 'Authorization': `Bearer ${META_TOKEN}`, ...form.getHeaders() } 
        });
        return r.data.id;
    } catch (e) { return null; }
}

async function enviarWhatsApp(to, content, type = "text") {
    try {
        const payload = { messaging_product: "whatsapp", to, type };
        if (type === "text") { payload.text = { body: content }; } 
        else if (content.id) { payload[type] = { id: content.id }; if(type === 'document') payload[type].filename = 'Archivo Adjunto.pdf'; } 
        else { payload[type] = { link: content }; }
        
        await axios.post(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, payload, { 
            headers: { 'Authorization': `Bearer ${META_TOKEN}` } 
        });
        return true;
    } catch (e) { 
        console.error(`❌ ERROR ENVIANDO WHATSAPP:`, e.response ? JSON.stringify(e.response.data) : e.message);
        return false; 
    }
}

// --- 8. PROXY DE MEDIOS ---
app.get('/api/media-proxy/:id', proteger, async (req, res) => {
    const mediaId = req.params.id ? req.params.id.replace(/\D/g, '') : '';
    if (!mediaId) return res.status(404).send("ID Inválido");

    try {
        const cacheDir = path.join(__dirname, 'data', 'media_cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        
        const files = fs.readdirSync(cacheDir);
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
        fs.writeFileSync(filePath, fileRes.data);

        res.sendFile(filePath, { headers: { 'Content-Type': contentType } });

        setTimeout(() => {
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e){}
        }, 10 * 60 * 1000);

    } catch (e) { 
        if (!res.headersSent) res.status(500).send("Error procesando medio"); 
    }
});

app.get('/rescate', async (req, res) => {
    const ids = ["1854969351824003", "1854969375157334", "1854969401823998"];
    let html = "<h1 style='font-family:sans-serif;'>Rescate de Fotos del Cliente</h1><div style='display:flex; flex-wrap:wrap; gap:20px;'>";
    
    for (const id of ids) {
        try {
            const urlRes = await axios.get(`https://graph.facebook.com/v21.0/${id}`, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
            const imgRes = await axios.get(urlRes.data.url, { headers: { 'Authorization': `Bearer ${META_TOKEN}`, 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer' });
            const base64 = Buffer.from(imgRes.data, 'binary').toString('base64');
            const mime = urlRes.data.mime_type || 'image/jpeg';
            html += `<div><p style='font-family:sans-serif;'>Foto ${id}</p><img src="data:${mime};base64,${base64}" style="max-width: 350px; border-radius: 8px; border: 2px solid #00a884; box-shadow: 0 4px 10px rgba(0,0,0,0.2);"></div>`;
        } catch (e) {
            const errorDetalle = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
            html += `<div><p>Foto ${id} ❌ FALLÓ</p><pre style="color:red; background:#fee; padding:10px;">${errorDetalle}</pre></div>`;
        }
    }
    html += "</div>";
    res.send(html);
});

// --- 9. LÓGICA IA ---
function limpiarRespuesta(txt) {
    let clean = txt.replace(/```json([\s\S]*?)```/gi, "");
    clean = clean.replace(/\{"es_lead"[\s\S]*?\}/gi, ""); 
    return clean.replace(/[\r\n]+/g, "\n").trim();
}

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
    
    let memoriaDatos = `ID CLIENTE: ${phone}\nNombre en WhatsApp (No confiable): ${name}\n`;
    if (lead) {
        if (lead.nombre) memoriaDatos += `Nombre verificado: ${lead.nombre}\n`;
        if (lead.ciudad) memoriaDatos += `Ciudad: ${lead.ciudad}\n`;
        if (lead.correo) memoriaDatos += `Correo: ${lead.correo}\n`;
        if (lead.interes) memoriaDatos += `Categoría Interés: ${lead.interes}\n`;
        if (lead.producto_especifico) memoriaDatos += `Producto Específico: ${lead.producto_especifico}\n`;
    }

    const busqueda = aiMsg.toLowerCase().split(" ").slice(0,3).join(" ");
    const stock = globalKnowledge.filter(i => (i.searchable||"").toLowerCase().includes(busqueda)).slice(0,5);

    const promptFinal = `
${configUsar}

=== DATOS DE CONTEXTO DEL SISTEMA ===
Reglas Técnicas: ${techRules.join(" | ")}
Horario: ${biz.hours || ''}
Contexto Web: ${webContext}
Memoria del cliente actual: 
${memoriaDatos}
Inventario: ${JSON.stringify(stock)}
Historial reciente: ${JSON.stringify(history)}

=== INSTRUCCIÓN FUNCIONAL (SISTEMA OBLIGATORIO) ===
1. Responde al cliente de forma natural basándote ÚNICAMENTE en tu personalidad.
2. REGLA DE NOMBRE: Si el cliente escribe su nombre en la conversación (ej. "Soy Carlos"), ESE NOMBRE TIENE PRIORIDAD ABSOLUTA. Asígnalo en el JSON.
3. REGLA DE AUTO-APAGADO (ANTI-BUCLES): Tu objetivo final es conseguir Nombre, Correo, Ciudad, Categoría y el PRODUCTO ESPECÍFICO en el que está interesado (ej. "Excavadora Volvo 50 tons"). 
   - SI YA TIENES LOS DATOS, envía ESTE EXACTO MENSAJE de despedida: "Perfecto, [Nombre]. Ya pasé sus datos y su solicitud. Pronto un ejecutivo comercial se contactará con usted. Recuerde que los datos brindados serán usados de acuerdo a nuestra política de protección de datos: https://www.importadoracasacolombia.com/aviso-de-privacidad".
   - SOLO DESPUÉS de dar esa despedida, OBLIGATORIAMENTE pon "apagar_bot": true en tu JSON.
4. SIEMPRE al final de tu respuesta, añade el siguiente bloque JSON estructurado:
\`\`\`json
{"es_lead": true_o_false, "nombre":"...", "categoria_interes":"...", "producto_especifico":"...", "ciudad":"...", "correo":"...", "etiqueta":"Lead", "apagar_bot": false_o_true}
\`\`\`
(Categorías permitidas: Maquinaria nueva, Maquinaria usada, Volquetas, Martillos Hidráulicos, Brazos largos, Accesorios, Repuestos, Servicio, Otro, Consultando).
    `;

    try {
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`, { contents: [{ parts: [{ text: promptFinal }] }] });
        const raw = r.data.candidates[0].content.parts[0].text;
        
        const match = raw.match(/```json([\s\S]*?)```|{([\s\S]*?)}/);
        if (match) {
            try {
                const info = JSON.parse((match[1]||match[0]).replace(/```json|```/g, "").trim());
                await gestionarLead(phone, info, name, lead); 
            } catch(e) {}
        }
        
        let reply = limpiarRespuesta(raw);
        if (!reply || reply.length < 2) reply = "¿En qué te puedo ayudar?";
        
        const timestamp = new Date().toISOString();
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'bot', reply, timestamp]);
        
        io.emit('new_message', { phone: phone, role: 'bot', text: reply, time: timestamp });
        io.emit('update_chats_list');

        return reply;
    } catch (e) { 
        return "Dame un momento, estoy verificando esa información."; 
    }
}

async function gestionarLead(phone, info, fbName, oldLead) {
    const limpiarDato = (d) => (!d || /^(unknown|null|n\/a|no menciona|cliente|pend)$/i.test(d.toString().trim())) ? null : d.trim();
    
    let name = limpiarDato(info.nombre) || (oldLead && oldLead.nombre && oldLead.nombre !== fbName ? oldLead.nombre : fbName);
    
    let ciudadLimpia = limpiarDato(info.ciudad); 
    let dpto = obtenerDepartamento(ciudadLimpia) || (oldLead ? oldLead.departamento : null);
    let interesLimpio = limpiarDato(info.categoria_interes) || limpiarDato(info.interes) || (oldLead ? oldLead.interes : "Consultando");
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
        console.log(`🤖 ICBOT APAGADO AUTOMÁTICAMENTE para ${phone} (Gestión Finalizada)`);
    }
}

function iniciarCronJobs() {
    // 1. CronJob Existente de limpieza de medios
    setInterval(() => {
        try {
            const cacheDir = path.join(__dirname, 'data', 'media_cache');
            if (fs.existsSync(cacheDir)) {
                const files = fs.readdirSync(cacheDir);
                const now = Date.now();
                files.forEach(file => {
                    const filePath = path.join(cacheDir, file);
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > 1800000) {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️ Caché limpiado: Eliminado archivo temporal ${file}`);
                    }
                });
            }
        } catch(e) { console.error("Error limpiando cache:", e); }
    }, 60000 * 30);

    // 2. NUEVO CRONJOB: Seguimiento a las 7:00 AM Hora Bogotá (Chequeo cada 10 mins)
    setInterval(async () => {
        try {
            const horaBogota = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Bogota"}));
            // Disparamos solo si son las 7 AM (entre 7:00 y 7:14)
            if (horaBogota.getHours() === 7 && horaBogota.getMinutes() < 15) {
                const todayStr = horaBogota.toISOString().split('T')[0];
                const lastRun = await getCfg('last_followup_date');
                
                // Evitamos que se ejecute dos veces en la misma mañana
                if (lastRun === todayStr) return; 

                await setCfg('last_followup_date', todayStr);
                console.log("⏰ Ejecutando CronJob de Seguimiento 7:00 AM...");

                const leadsPendientes = await db.all("SELECT * FROM leads WHERE LOWER(etiqueta) = 'pendiente'");
                
                for (const l of leadsPendientes) {
                    const meta = await db.get("SELECT last_interaction FROM metadata WHERE phone = ?", [l.phone]);
                    if (!meta || !meta.last_interaction) continue;

                    const horasInactivo = (Date.now() - new Date(meta.last_interaction).getTime()) / (1000 * 60 * 60);

                    if (horasInactivo >= 24) {
                        let fDay = l.followup_day || 0;
                        fDay++;

                        let msg = "";
                        let cerrar = false;

                        if (fDay === 1) {
                            msg = "¡Hola! 👋 Notamos que tu solicitud quedó pendiente. ¿Podemos ayudarte a finalizarla para asignarte un ejecutivo comercial?";
                        } else if (fDay === 2) {
                            msg = "Hola de nuevo. Queremos asegurarnos de que recibas la mejor atención. ¿Aún te encuentras interesado en nuestra maquinaria o servicios?";
                        } else if (fDay >= 3) {
                            msg = "En vista de no completada su solicitud procedemos a cerrar su ticket. Si deseas retomar la consulta en el futuro, no dudes en escribirnos.";
                            cerrar = true;
                        }

                        if (msg) {
                            const sent = await enviarWhatsApp(l.phone, msg);
                            if (sent) {
                                const timestamp = new Date().toISOString();
                                await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [l.phone, 'bot', msg, timestamp]);
                                io.emit('new_message', { phone: l.phone, role: 'bot', text: msg, time: timestamp });
                            }

                            if (cerrar) {
                                await db.run("UPDATE leads SET etiqueta = 'Perdido', followup_day = ? WHERE id = ?", [fDay, l.id]);
                                await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, 0)", [l.phone]);
                                console.log(`🔒 Ticket cerrado para ${l.phone} por inactividad.`);
                            } else {
                                await db.run("UPDATE leads SET followup_day = ? WHERE id = ?", [fDay, l.id]);
                            }
                        }
                    }
                }
                io.emit('update_chats_list');
            }
        } catch (e) { console.error("Error en CronJob 7AM:", e); }
    }, 10 * 60 * 1000); // Se verifica cada 10 minutos
}

// --- 11. RUTAS API ---
app.post('/auth', (req, res) => { if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) { req.session.isLogged = true; res.json({success:true}); } else { res.status(401).json({success:false}); } });
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));

app.get('/api/data/:type', proteger, async (req, res) => {
    const t = req.params.type;
    // En leads, el "SELECT *" ahora incluirá automáticamente nuestra nueva columna sf_id, no hay que tocar nada.
    if (t === 'leads') res.json(await db.all("SELECT * FROM leads ORDER BY id DESC"));
    else if (t === 'tags') res.json(await db.all("SELECT * FROM global_tags"));
    else if (t === 'shortcuts') res.json(await db.all("SELECT * FROM shortcuts"));
    else if (t === 'knowledge') res.json(await db.all("SELECT * FROM inventory"));
    else if (t === 'config') res.json({ website_data: await getCfg('website_data', ""), tech_rules: await getCfg('tech_rules', []), biz_profile: await getCfg('biz_profile', {}), logo_url: await getCfg('logo_url') });
    else res.json([]);
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

app.post('/api/config/logo', proteger, upload.single('file'), async (req, res) => { await setCfg('logo_url', `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`); res.json({success:true}); });
app.post('/api/config/biz/save', proteger, async (req, res) => { await setCfg('biz_profile', {name:req.body.name, hours:req.body.hours}); res.json({success:true}); });
app.post('/api/tags/add', proteger, async (req, res) => { await db.run("INSERT INTO global_tags (name, color) VALUES (?, ?)", [req.body.name, req.body.color]); res.json({success:true}); });
app.post('/api/tags/delete', proteger, async (req, res) => { await db.run("DELETE FROM global_tags WHERE id = ?", [req.body.id]); res.json({success:true}); });
app.post('/api/tags/update', proteger, async (req, res) => { 
    try {
        await db.run("UPDATE global_tags SET name = ?, color = ? WHERE id = ?", [req.body.name, req.body.color, req.body.id]); 
        res.json({success:true});
    } catch(e) { res.status(500).json({error: "Error editando etiqueta"}); }
});
app.post('/api/shortcuts/add', proteger, async (req, res) => { await db.run("INSERT INTO shortcuts (keyword, text) VALUES (?, ?)", [req.body.keyword, req.body.text]); res.json({success:true}); });
app.post('/api/shortcuts/delete', proteger, async (req, res) => { await db.run("DELETE FROM shortcuts WHERE id = ?", [req.body.id]); res.json({success:true}); });
app.post('/api/contacts/upload-photo', proteger, upload.single('file'), async (req, res) => { await db.run("INSERT INTO metadata (phone, photoUrl) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET photoUrl=excluded.photoUrl", [req.body.phone, `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`]); res.json({success:true}); });
app.post('/api/chat/toggle-bot', proteger, async (req, res) => { await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, ?)", [req.body.phone, req.body.active?1:0]); res.json({success:true}); });
app.post('/api/config/rules/add', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.push(req.body.rule); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/config/rules/delete', proteger, async (req, res) => { let r=await getCfg('tech_rules',[]); r.splice(req.body.index,1); await setCfg('tech_rules',r); res.json({rules:r}); });
app.post('/api/leads/update', proteger, async(req,res)=>{ await db.run(`UPDATE leads SET ${req.body.field}=? WHERE id=?`,[req.body.value, req.body.id]); res.json({success:true}); });
app.post('/api/leads/delete', proteger, async(req,res)=>{ await db.run("DELETE FROM leads WHERE id=?",[req.body.id]); res.json({success:true}); });
app.post('/api/knowledge/delete', proteger, async (req, res) => { await db.run("DELETE FROM inventory WHERE id=?",[req.body.id]); await refreshKnowledge(); res.json({success:true}); });
app.post('/api/knowledge/clear', proteger, async (req, res) => { await db.run("DELETE FROM inventory"); await refreshKnowledge(); res.json({success:true}); });
app.post('/api/config/prompt', proteger, async (req, res) => { await setCfg('bot_prompt', req.body.prompt); res.json({success:true}); });
app.get('/api/config/prompt', proteger, async (req, res) => res.json({ prompt: await getCfg('bot_prompt', DEFAULT_PROMPT) }));
app.post('/api/data/web-knowledge', proteger, async (req, res) => { await db.run("INSERT INTO knowledge_sources (type, url, summary, date) VALUES (?, ?, ?, ?)", ['web', req.body.url, req.body.summary, new Date().toLocaleString()]); res.json({success:true}); });
app.get('/api/data/web-knowledge', proteger, async (req, res) => { res.json(await db.all("SELECT * FROM knowledge_sources ORDER BY id DESC")); });
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
        
        // MOD: Agregué l.sf_id al select para que el front sepa si ya está en CRM
        const query = `SELECT h.phone as id, MAX(h.id) as max_id, h.text as lastText, h.time as timestamp, m.contactName, m.photoUrl, m.labels, m.pinned, m.archived, m.unreadCount, b.active as botActive, l.source, l.status_tag, l.sf_id FROM history h LEFT JOIN metadata m ON h.phone = m.phone LEFT JOIN bot_status b ON h.phone = b.phone LEFT JOIN leads l ON h.phone = l.phone WHERE ${whereClause} GROUP BY h.phone ORDER BY m.pinned DESC, max_id DESC LIMIT 50`;
        const rows = await db.all(query, params);
        res.json(rows.map(r => ({ id: r.id, name: r.contactName || r.id, lastMessage: { text: r.lastText, time: r.timestamp }, botActive: r.botActive !== 0, pinned: r.pinned === 1, archived: r.archived === 1, unreadCount: r.unreadCount || 0, labels: JSON.parse(r.labels || "[]"), photoUrl: r.photoUrl, timestamp: r.timestamp, source: r.source, statusTag: r.status_tag, sfId: r.sf_id })));
    } catch(e) { res.status(500).json([]); }
});

app.get('/api/chat-history/:phone', proteger, async (req, res) => {
    await db.run("UPDATE metadata SET unreadCount = 0 WHERE phone = ?", [req.params.phone]);
    res.json(await db.all("SELECT * FROM history WHERE phone = ? ORDER BY id ASC", [req.params.phone]));
});

app.post('/api/contacts/bulk-update', proteger, async (req, res) => {
    const { phones, action, value } = req.body; 
    try {
        if (!phones || !Array.isArray(phones)) return res.status(400).json({error: "Lista de teléfonos inválida"});
        
        for (const phone of phones) {
            const cleanPhone = phone.replace(/\D/g, '');
            if (action === 'set_label') {
                await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [cleanPhone, JSON.stringify([value])]); 
                await db.run("UPDATE leads SET status_tag = ? WHERE phone = ?", [value.text, cleanPhone]);
            } else if (action === 'add_label') {
                const current = await db.get("SELECT labels FROM metadata WHERE phone = ?", [cleanPhone]);
                let labels = current ? JSON.parse(current.labels || "[]") : [];
                if (!labels.find(l => l.text === value.text)) {
                    labels.push(value);
                    await db.run("UPDATE metadata SET labels = ? WHERE phone = ?", [JSON.stringify(labels), cleanPhone]);
                }
            }
        }
        res.json({success: true});
    } catch (e) {
        console.error("Bulk Error:", e);
        res.status(500).json({error: "Error en actualización masiva"});
    }
});

app.post('/api/chat/action', proteger, async (req, res) => {
    const { phone, action, value } = req.body;
    const cleanPhone = phone.replace(/\D/g, ''); 
    if(action === 'delete') { for(const t of ['history','metadata','bot_status','leads']) await db.run(`DELETE FROM ${t} WHERE phone=?`,[cleanPhone]); }
    else if(action === 'set_labels') { await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [cleanPhone, JSON.stringify(value)]); await db.run("UPDATE leads SET status_tag = ? WHERE phone = ?", [value.length > 0 ? value[0].text : "Sin Etiqueta", cleanPhone]); }
    else if(action === 'toggle_pin') { await db.run("INSERT INTO metadata (phone, pinned) VALUES (?, 1) ON CONFLICT(phone) DO UPDATE SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END", [cleanPhone]); }
    else if(action === 'toggle_archive') { await db.run("INSERT INTO metadata (phone, archived) VALUES (?, 1) ON CONFLICT(phone) DO UPDATE SET archived = CASE WHEN archived = 1 THEN 0 ELSE 1 END", [cleanPhone]); }
    res.json({success:true});
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
    const { phone, message } = req.body; const cleanPhone = phone.replace(/\D/g, ''); 
    try { const sent = await enviarWhatsApp(cleanPhone, message); 
        if(sent) { 
            const timestamp = new Date().toISOString();
            await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [cleanPhone, 'manual', message, timestamp]); 
            await db.run(`INSERT INTO metadata (phone, contactName, addedManual, archived, unreadCount, last_interaction) VALUES (?, ?, 1, 0, 0, ?) ON CONFLICT(phone) DO UPDATE SET last_interaction=excluded.last_interaction`, [cleanPhone, cleanPhone, timestamp]); 
            
            io.emit('new_message', { phone: cleanPhone, role: 'manual', text: message, time: timestamp });
            io.emit('update_chats_list');

            res.json({ success: true }); 
        } else res.status(500).json({ error: "Error enviando" }); 
    } catch(e) { res.status(500).json({ error: "Error interno" }); } 
});

// --- ENPOINTS NUEVOS: SALESFORCE ---
// 1. Verificar existencia por teléfono en tiempo real
app.get('/api/salesforce/check/:phone', proteger, async (req, res) => {
    try {
        const cleanPhone = req.params.phone.replace(/\D/g, '');
        const sfId = await checkSalesforceLead(cleanPhone);
        
        if (sfId) {
            // Actualizamos la base local de una vez por si no lo sabíamos
            await db.run("UPDATE leads SET sf_id = ? WHERE phone = ?", [sfId, cleanPhone]);
            res.json({ exists: true, sf_id: sfId });
        } else {
            res.json({ exists: false });
        }
    } catch (e) {
        res.status(500).json({ error: "Error consultando a Salesforce" });
    }
});

// 2. Cargue Masivo / Individual
app.post('/api/salesforce/push', proteger, async (req, res) => {
    const { leads } = req.body; 
    // leads debe ser un array de objetos, ej: [{ id: 10, ownerId: '005...' }]
    
    if (!leads || !Array.isArray(leads)) return res.status(400).json({error: "Se requiere un array de leads."});
    
    let results = [];
    try {
        const { token, instanceUrl } = await getSalesforceToken();
        
        for (const item of leads) {
            const leadId = item.id;
            const ownerId = item.ownerId || null;
            
            const lead = await db.get("SELECT * FROM leads WHERE id = ?", [leadId]);
            if (!lead) {
                results.push({ id: leadId, status: 'error', message: 'No encontrado en la base local.' });
                continue;
            }
            
            // Paso A: Validar Duplicado en Salesforce
            const existingSfId = await checkSalesforceLead(lead.phone);
            if (existingSfId) {
                // Ya existe: Solo marcamos la BD local, NO lo subimos
                await db.run("UPDATE leads SET sf_id = ? WHERE id = ?", [existingSfId, leadId]);
                results.push({ id: leadId, status: 'duplicate', sf_id: existingSfId, message: 'Ya existe en Salesforce.' });
                continue; 
            }
            
            // Paso B: Crear en Salesforce si no existe
            const sfData = {
                LastName: lead.nombre || "Sin Nombre (WhatsApp)",
                Company: "Lead WhatsApp Bot",
                Phone: lead.phone,
                Email: lead.correo || "",
                City: lead.ciudad || "",
                State: lead.departamento || "",
                Description: `Interés: ${lead.interes || ''} | Producto: ${lead.producto_especifico || ''} | Origen: ${lead.source || 'Bot'}`
            };
            
            // Asignación de ejecutivo si el frontend lo mandó
            if (ownerId) {
                sfData.OwnerId = ownerId; 
            }

            try {
                const sfRes = await axios.post(`${instanceUrl}/services/data/v58.0/sobjects/Lead/`, sfData, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                });
                
                const newSfId = sfRes.data.id;
                // Guardamos el ID de Salesforce en nuestra base de datos SQLite
                await db.run("UPDATE leads SET sf_id = ? WHERE id = ?", [newSfId, leadId]);
                
                results.push({ id: leadId, status: 'success', sf_id: newSfId });
            } catch (err) {
                console.error(`❌ Error POST Lead ${lead.phone}:`, err.response ? JSON.stringify(err.response.data) : err.message);
                results.push({ id: leadId, status: 'error', message: 'Rechazado por Salesforce.' });
            }
        }
        res.json({ success: true, results });
    } catch (e) {
        console.error("❌ Error General Salesforce Endpoint:", e.message);
        res.status(500).json({ error: "Error crítico de conexión con Salesforce." });
    }
});
// -----------------------------------

// --- WEBHOOK BLINDADO ---
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
        const msg = val?.messages?.[0]; 
        
        // --- ANTI-BUCLE ---
        if (msg && msg.from === PHONE_ID) {
             return;
        }

        if (val?.contacts?.[0]?.profile?.name) {
            await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName WHERE addedManual=0", [val.contacts[0].wa_id, val.contacts[0].profile.name]); 
        }
        
        if(msg) { 
            const phone = msg.from; 
            
            // --- AUTO-ETIQUETADO REDES ---
            if (msg.referral) {
                const refSource = `Meta Ads: ${msg.referral.source_url || 'N/A'}`;
                
                const existeLead = await db.get("SELECT id FROM leads WHERE phone = ?", [phone]);
                if (existeLead) {
                    await db.run("UPDATE leads SET source = ?, status_tag = 'REDES' WHERE phone = ?", [refSource, phone]);
                } else {
                    await db.run(`INSERT INTO leads (phone, nombre, source, etiqueta, fecha, status_tag, farewell_sent, followup_day) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`, 
                        [phone, val?.contacts?.[0]?.profile?.name || "Cliente Ads", refSource, "Pendiente", new Date().toISOString(), "REDES"]);
                }

                const meta = await db.get("SELECT labels FROM metadata WHERE phone = ?", [phone]);
                let labels = meta ? JSON.parse(meta.labels || "[]") : [];
                
                if (!labels.find(l => l.text === 'REDES')) {
                    labels.push({ text: 'REDES', color: '#ff0000' }); 
                    await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [phone, JSON.stringify(labels)]);
                }
            }

            let userMsg = msg.text?.body || ""; 
            let isFile = false;

            if(msg.type !== 'text') { 
                isFile = true; 
                let caption = msg[msg.type]?.caption || ""; 
                if (msg[msg.type] && msg[msg.type].id) {
                    userMsg = `[MEDIA:${msg.type.toUpperCase()}:${msg[msg.type].id}] ${caption}`; 
                } else {
                    userMsg = `[EVENTO:${msg.type.toUpperCase()}] ${caption}`;
                }
            } 
            
            // === GUARDADO INDIVIDUAL E INMEDIATO (FIX DE ÁLBUMES) ===
            if (userMsg) {
                const timestamp = new Date().toISOString();
                await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'user', userMsg, timestamp]);
                await db.run("INSERT INTO metadata (phone, archived, unreadCount, last_interaction) VALUES (?, 0, 1, ?) ON CONFLICT(phone) DO UPDATE SET archived=0, unreadCount = unreadCount + 1, last_interaction=excluded.last_interaction", [phone, timestamp]);
                
                io.emit('new_message', { phone: phone, role: 'user', text: userMsg, time: timestamp });
                io.emit('update_chats_list');
            }

            // === DEBOUNCE (SISTEMA DE COLA PARA ESPERAR AL CLIENTE) ===
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
    } catch(e) { console.error("Webhook Error", e); } 
});

process.on('SIGTERM', () => { if (serverInstance) serverInstance.close(() => process.exit(0)); else process.exit(0); });
process.on('SIGINT', () => { if (serverInstance) serverInstance.close(() => process.exit(0)); else process.exit(0); });
