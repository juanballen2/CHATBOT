/*
 * SERVER BACKEND - v33.5 (ICBOT FULL PRODUCTION + OMNICANAL AISLADO + IA FANTASMA + FIX CAMPAÑAS)
 * ============================================================
 * 1. FIX: Renombrado oficial a ICBOT completado (Asistente Lorena).
 * 2. ADD: Índices SQL (idx_history_phone, idx_leads_phone).
 * 3. ADD: Cronjob de Limpieza robusto 'media_cache'.
 * 4. FIX: Audios/Videos con soporte Range 206 (codecs=opus).
 * 5. ADD: Sistema Anti-bucle (Auto-apagado del bot).
 * 6. FIX: Prioridad absoluta al nombre dado por el cliente.
 * 7. ADD: WEBSOCKETS (Socket.io) para eliminar el Polling del frontend.
 * 8. MOD: Cronjob seguimiento inteligente (Fix: Plantilla sin parámetros).
 * 9. MOD: Segmentación de Categoría vs Producto Específico.
 * 10.FIX: Se eliminó el bloqueo duro de archivos adjuntos para que la IA los procese.
 * 11.DEL: EXTIRPADO SALESFORCE (Limpieza de código fallido para estabilidad).
 * 12.ADD: Soporte nativo para 'Template Messages' en enviarWhatsApp.
 * 13.MOD: Endpoint /api/chat/send-template preparado para imágenes dinámicas y FormData.
 * 14.ADD: Endpoint /api/chat/bulk-excel (Motor de campañas con Rate Limiting 250ms).
 * 15.FIX: Integración nativa Gemini (System Instructions + JSON estricto + Fusión de roles).
 * 16.ADD: Endpoint /api/omnicanal/webhook para Messenger e Instagram (Bypass IA).
 * 17.ADD: Endpoints /api/salesforce/sync-lead y /sync-bulk (Preparados para API Real).
 * 18.FIX: Rutas /inbox añadidas para el frontend omnicanal.
 * 19.FIX: Aislamiento total DB (Columna 'channel') para separar WhatsApp de Redes.
 * 20.ADD: IA Fantasma (/api/chat/analyze-lead) para auto-llenar CRM leyendo el chat.
 * 21.FIX: Motor de campañas Excel reparado (Eliminada variable forzada, Auto-57 añadido, Fix nombres de imagen).
 * ============================================================
 */

const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io'); 
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

const DEFAULT_PROMPT = `Eres Lorena, Asistente Comercial de Importadora Casa Colombia. Tu objetivo principal es atender al cliente, resolver sus dudas y perfilarlo recopilando sus datos para pasarlo a un asesor humano.
REGLA DE ORO: NUNCA ASUMAS EL NOMBRE DEL CLIENTE. Si el cliente no te ha dicho explícitamente "Me llamo X", debes preguntárselo obligatoriamente (Nombre y Apellido) para su registro.`;

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

        // ACTUALIZACIÓN DE ESTRUCTURA: Se agrega el campo 'channel'
        const tables = [
            `history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT)`,
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
        serverInstance = server.listen(PORT, () => console.log(`🔥 BACKEND v33.5 ONLINE (Port ${PORT}) - WEBSOCKETS ACTIVOS`));

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
        "medellin": "Antioquia", "bogota": "Bogotá D.C.", "cali": "Valle del Cauca", "barranquilla": "Atlántico",
        "cartagena": "Bolívar", "bucaramanga": "Santander", "pereira": "Risaralda", "manizales": "Caldas",
        "armenia": "Quindío", "cucuta": "Norte de Santander", "ibague": "Tolima", "villavicencio": "Meta",
        "neiva": "Huila", "santa marta": "Magdalena", "pasto": "Nariño", "popayan": "Cauca",
        "valledupar": "Cesar", "monteria": "Córdoba", "sincelejo": "Sucre", "riohacha": "La Guajira",
        "florencia": "Caquetá", "yopal": "Casanare", "quibdo": "Chocó", "arauca": "Arauca",
        "mocoa": "Putumayo", "leticia": "Amazonas", "san andres": "San Andrés y Providencia",
        "san jose del guaviare": "Guaviare", "tunja": "Boyacá"
    };
    return mapa[c] || null;
}

// --- 7. META API ---
async function uploadToMeta(buffer, mime, name) {
    try {
        const form = new FormData();
        const type = mime.includes('audio') || mime.includes('ogg') ? 'audio' : (mime.includes('image') ? 'image' : (mime.includes('video') ? 'video' : 'document'));
        
        // ⚠️ FIX DE ARCHIVOS: Limpiamos caracteres raros y espacios para que Meta no rebote la imagen
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
Categorías permitidas: Maquinaria nueva, Maquinaria usada, Volquetas, Martillos Hidráulicos, Brazos largos, Accesorios, Repuestos, Servicio, Otro, Consultando.
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

        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`, requestBody);
        
        const rawText = r.data.candidates[0].content.parts[0].text;
        const infoIA = JSON.parse(rawText);
        
        await gestionarLead(phone, infoIA.datos_internos, name, lead); 
        
        let reply = infoIA.mensaje_para_cliente;
        if (!reply || reply.length < 2) reply = "¿En qué te puedo ayudar?";
        
        const timestamp = new Date().toISOString();
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'bot', reply, timestamp]);
        
        io.emit('new_message', { phone: phone, role: 'bot', text: reply, time: timestamp });
        io.emit('update_chats_list');

        return reply;
    } catch (e) { 
        console.error("❌ Error procesando IA:", e.response ? JSON.stringify(e.response.data) : e.message);
        return "Dame un momento, estoy verificando esa información."; 
    }
}

async function gestionarLead(phone, info, fbName, oldLead) {
    if (!info) return; 
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

    setInterval(async () => {
        try {
            const horaBogota = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Bogota"}));
            if (horaBogota.getHours() === 7 && horaBogota.getMinutes() < 15) {
                const todayStr = horaBogota.toISOString().split('T')[0];
                const lastRun = await getCfg('last_followup_date');
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
                        let cerrar = false;
                        let sent = false;

                        if (fDay === 1 || fDay === 2) {
                            const templatePayload = { name: "plantilla_de_retoma", language: { code: "es_CO" } };
                            sent = await enviarWhatsApp(l.phone, templatePayload, 'template');
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
                            console.log(`🔒 Ticket cerrado para ${l.phone} por inactividad.`);
                        } else {
                            await db.run("UPDATE leads SET followup_day = ? WHERE id = ?", [fDay, l.id]);
                        }
                    }
                }
                io.emit('update_chats_list');
            }
        } catch (e) { console.error("Error en CronJob 7AM:", e); }
    }, 10 * 60 * 1000); 
}

// --- 11. RUTAS API ---
app.post('/auth', (req, res) => { if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) { req.session.isLogged = true; res.json({success:true}); } else { res.status(401).json({success:false}); } });
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));

// 🔥 RUTAS DE LA BANDEJA OMNICANAL 🔥
app.get('/inbox', proteger, (req, res) => res.sendFile(path.join(__dirname, 'inbox.html')));
app.get('/inbox.css', (req, res) => res.sendFile(path.join(__dirname, 'inbox.css')));
app.get('/inbox.js', (req, res) => res.sendFile(path.join(__dirname, 'inbox.js')));

app.get('/api/data/:type', proteger, async (req, res) => {
    const t = req.params.type;
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

// ============================================================
// 🔥 IA FANTASMA: AUTO-LLENADO DE CRM (SIN HABLAR CON EL CLIENTE)
// ============================================================
app.post('/api/chat/analyze-lead', proteger, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Falta teléfono" });

    try {
        // 1. Extraemos los últimos 50 mensajes de esa conversación
        const history = await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id ASC LIMIT 50", [phone]);
        if (!history || history.length === 0) return res.json({ success: false, message: "No hay historial para analizar." });

        // 2. Formateamos el texto para que la IA entienda quién dijo qué
        let convoText = history.map(h => `${h.role === 'user' ? 'Cliente' : 'Asesor'}: ${h.text}`).join('\n');

        // 3. El Prompt estricto (Modo Lector)
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
          "categoria_interes": "Una de: Maquinaria nueva, Maquinaria usada, Volquetas, Martillos Hidráulicos, Brazos largos, Accesorios, Repuestos, Servicio, Otro, Consultando",
          "producto_especifico": "Modelo exacto o detalle de lo que busca"
        }`;

        const requestBody = {
            contents: [{ role: 'user', parts: [{ text: promptEstractor }] }],
            generationConfig: { responseMimeType: "application/json" }
        };

        // 4. Llamamos a Gemini en secreto
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`, requestBody);
        const rawText = r.data.candidates[0].content.parts[0].text;
        const extractedData = JSON.parse(rawText);

        // 5. Devolvemos los datos al frontend
        res.json({ success: true, data: extractedData });
    } catch (error) {
        console.error("❌ Error en auto-análisis IA:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "Error analizando chat" });
    }
});

app.get('/api/chats-full', proteger, async (req, res) => {
    try {
        const view = req.query.view || 'active';
        const search = req.query.search ? `%${req.query.search}%` : null;
        let whereClause = '(m.archived = 0 OR m.archived IS NULL)';
        if (view === 'archived') whereClause = 'm.archived = 1';
        else if (view === 'unread') whereClause = 'm.unreadCount > 0 AND (m.archived = 0 OR m.archived IS NULL)';
        
        let params = [];
        if (search) { whereClause += ` AND (m.contactName LIKE ? OR h.phone LIKE ? OR h.text LIKE ?)`; params.push(search, search, search); }
        
        // ACTUALIZACIÓN: Incluimos m.channel en la consulta
        const query = `SELECT h.phone as id, MAX(h.id) as max_id, h.text as lastText, h.time as timestamp, m.contactName, m.photoUrl, m.labels, m.pinned, m.archived, m.unreadCount, m.channel, b.active as botActive, l.source, l.status_tag, l.sf_id, l.interes, l.producto_especifico FROM history h LEFT JOIN metadata m ON h.phone = m.phone LEFT JOIN bot_status b ON h.phone = b.phone LEFT JOIN leads l ON h.phone = l.phone WHERE ${whereClause} GROUP BY h.phone ORDER BY m.pinned DESC, max_id DESC LIMIT 1000`;
        const rows = await db.all(query, params);
        
        res.json(rows.map(r => ({ 
            id: r.id, 
            phone: r.id,
            name: r.contactName || r.id, 
            lastMessage: { text: r.lastText, time: r.timestamp }, 
            botActive: r.botActive !== 0, 
            pinned: r.pinned === 1, 
            archived: r.archived === 1, 
            unreadCount: r.unreadCount || 0, 
            labels: JSON.parse(r.labels || "[]"), 
            photoUrl: r.photoUrl, 
            timestamp: r.timestamp, 
            source: r.source, 
            statusTag: r.status_tag, 
            sfId: r.sf_id,
            interes: r.interes,
            producto_especifico: r.producto_especifico,
            channel: r.channel || 'whatsapp' // Aseguramos que por defecto sea whatsapp si está vacío
        })));
    } catch(e) { res.status(500).json([]); }
});

app.get('/api/chat-history/:phone(*)', proteger, async (req, res) => {
    try {
        const phone = req.params.phone;
        await db.run("UPDATE metadata SET unreadCount = 0 WHERE phone = ?", [phone]);
        const historial = await db.all("SELECT * FROM history WHERE phone = ? ORDER BY id ASC", [phone]);
        res.json(historial || []);
    } catch (e) {
        console.error(`❌ Error al abrir el chat ${req.params.phone}:`, e);
        res.status(500).json([]);
    }
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
                    await db.run("UPDATE leads SET status_tag = ? WHERE phone = ?", [labels.map(l => l.text).join(', '), cleanPhone]);
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
    else if(action === 'set_labels') { 
        await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [cleanPhone, JSON.stringify(value)]); 
        await db.run("UPDATE leads SET status_tag = ? WHERE phone = ?", [value.length > 0 ? value.map(v => v.text).join(', ') : "Sin Etiqueta", cleanPhone]); 
    }
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
                components.push({
                    type: "header",
                    parameters: [{ type: "image", image: { id: mediaId } }]
                });
            } else {
                return res.status(500).json({ error: "Meta rechazó la carga de la imagen." });
            }
        }

        const payload = {
            name: templateName,
            language: { code: language },
            components: components
        };

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
            res.status(500).json({ error: "Error enviando plantilla en Meta" });
        }
    } catch (e) {
        console.error("Error Endpoint Plantilla:", e);
        res.status(500).json({ error: "Error interno enviando plantilla" });
    }
});

// 🔥 CIRUGÍA APLICADA: RUTAS DE CAMPAÑA MASIVA EXCEL REPARADA 🔥
app.post('/api/chat/bulk-excel', proteger, upload.fields([{ name: 'excel', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
    try {
        if (!req.files || !req.files.excel) return res.status(400).json({ error: "Falta el archivo Excel" });
        
        const templateName = req.body.templateName;
        const language = req.body.language || "es_CO";
        
        if (!templateName) return res.status(400).json({ error: "Falta el nombre de la plantilla" });

        let mediaId = null;
        if (req.files.image && req.files.image[0]) {
            const imgFile = req.files.image[0];
            // FIX: Nombre seguro para evitar rechazos de Meta
            const safeName = imgFile.originalname.replace(/[^a-zA-Z0-9.]/g, '_') || 'imagen.jpg';
            mediaId = await uploadToMeta(imgFile.buffer, imgFile.mimetype, safeName);
            if (!mediaId) return res.status(500).json({ error: "Error al subir la imagen a Meta" });
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
            
            // FIX: Auto-agregar '57' si el número es colombiano y viene sin código
            if (cleanPhone.length === 10) cleanPhone = '57' + cleanPhone;

            if (cleanPhone.length < 10) continue; 

            let components = [];
            
            if (mediaId) {
                components.push({
                    type: "header",
                    parameters: [{ type: "image", image: { id: mediaId } }]
                });
            }
            
            // ⚠️ ELIMINAMOS LA INYECCIÓN FORZADA DEL BODY TEXT AQUI ⚠️
            // (La mayoría de plantillas son planas y Meta rechaza si mandamos variables que no existen)

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
                    const logMsg = `[CAMPAÑA EXCEL]\n📢 Plantilla: ${templateName}\n📝 Contacto: ${nameVal}${mediaId ? '\n🖼️ [Imagen Adjunta]' : ''}`;
                    
                    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [cleanPhone, 'manual', logMsg, timestamp]);
                    await db.run(`INSERT INTO metadata (phone, contactName, addedManual, archived, unreadCount, last_interaction) VALUES (?, ?, 1, 0, 0, ?) ON CONFLICT(phone) DO UPDATE SET last_interaction=excluded.last_interaction`, [cleanPhone, nameVal, timestamp]);

                    const existingLead = await db.get("SELECT id FROM leads WHERE phone = ?", [cleanPhone]);
                    if (!existingLead) {
                        await db.run(`INSERT INTO leads (phone, nombre, source, etiqueta, fecha, status_tag, farewell_sent, followup_day) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`, 
                            [cleanPhone, nameVal, 'Campaña Excel', 'Pendiente', timestamp, 'PROMO']);
                    }

                    io.emit('new_message', { phone: cleanPhone, role: 'manual', text: logMsg, time: timestamp });
                } else {
                    console.error(`❌ Meta rechazó el envío para ${cleanPhone}`);
                    errorCount++;
                }
            } catch(e) {
                errorCount++;
            }

            await new Promise(r => setTimeout(r, 250)); // Control de velocidad
        }

        io.emit('update_chats_list');
        res.json({ success: true, sent: successCount, failed: errorCount });

    } catch (error) {
        console.error("Error en bulk-excel:", error);
        res.status(500).json({ error: "Error procesando el archivo Excel" });
    }
});

// ============================================================
// NUEVO WEBHOOK OMNICANAL (BANDEJA HUMANA - BYPASS IA)
// ============================================================

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
                    if (event.message && !event.message.is_echo) {
                        const senderId = event.sender.id;
                        const text = event.message.text || "[Multimedia/Adjunto]";
                        const source = body.object === 'page' ? 'messenger' : 'instagram';
                        const timestamp = new Date().toISOString();

                        // ALMACENAMOS EL CANAL DIRECTAMENTE EN LA BD
                        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [senderId, 'user', text, timestamp]);
                        await db.run(`INSERT INTO metadata (phone, archived, unreadCount, last_interaction, channel) 
                                      VALUES (?, 0, 1, ?, ?) 
                                      ON CONFLICT(phone) DO UPDATE SET archived=0, unreadCount = unreadCount + 1, last_interaction=excluded.last_interaction, channel=excluded.channel`, 
                                      [senderId, timestamp, source]);
                        
                        io.emit('new_message', { phone: senderId, role: 'user', text: text, time: timestamp });
                        io.emit('update_chats_list');

                        console.log(`💬 ${source.toUpperCase()} - De: ${senderId} | Msj: ${text}`);
                    }
                }
            }
        }
    } catch (error) {
        console.error("❌ Error en Webhook Omnicanal:", error);
    }
});

// ============================================================
// WEBHOOK ORIGINAL BLINDADO (SOLO WHATSAPP - CON IA)
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
        const msg = val?.messages?.[0]; 
        
        if (msg && msg.from === PHONE_ID) {
             return;
        }

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
                    userMsg = `[MEDIA:${msg.type.toUpperCase()}:${msg[msg.type].id}] ${caption}`; 
                } else {
                    userMsg = `[EVENTO:${msg.type.toUpperCase()}] ${caption}`;
                }
            } 
            
            if (userMsg) {
                const timestamp = new Date().toISOString();
                // LOS MENSAJES DE WHATSAPP CONSERVAN SU COMPORTAMIENTO ORIGINAL
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
    } catch(e) { console.error("Webhook Error", e); } 
});

// ============================================================
// 10. INTEGRACIÓN SALESFORCE (API REAL)
// ============================================================

// Utilidad interna: Obtener Token de Salesforce
async function getSalesforceToken() {
    const params = new URLSearchParams();
    params.append('grant_type', 'password');
    params.append('client_id', process.env.SF_CLIENT_ID);
    params.append('client_secret', process.env.SF_CLIENT_SECRET);
    params.append('username', process.env.SF_USERNAME);
    params.append('password', process.env.SF_PASSWORD);

    const url = `${process.env.SF_URL}/services/oauth2/token`;
    
    try {
        const res = await axios.post(url, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        return { token: res.data.access_token, instanceUrl: res.data.instance_url };
    } catch (error) {
        console.error("❌ Error autenticando con Salesforce:", error.response ? error.response.data : error.message);
        throw new Error("Credenciales de Salesforce inválidas o expiradas.");
    }
}

// Endpoint para sincronizar 1 solo Lead (Desde el panel lateral CRM)
app.post('/api/salesforce/sync-lead', proteger, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Falta el número de teléfono" });

    try {
        const lead = await db.get("SELECT * FROM leads WHERE phone = ?", [phone]);
        if (!lead) return res.status(404).json({ success: false, message: "Lead no encontrado en la base local" });

        // 1. Nos autenticamos
        const sfAuth = await getSalesforceToken();
        const headers = { 'Authorization': `Bearer ${sfAuth.token}`, 'Content-Type': 'application/json' };

        // 2. BUSCAR DUPLICADOS (Detective)
        let query = `SELECT Id FROM Lead WHERE Phone = '${lead.phone}'`;
        if (lead.correo && lead.correo.includes('@')) {
            query += ` OR Email = '${lead.correo}'`;
        }
        
        const searchUrl = `${sfAuth.instanceUrl}/services/data/v60.0/query/?q=${encodeURIComponent(query)}`;
        const searchRes = await axios.get(searchUrl, { headers });

        if (searchRes.data.totalSize > 0) {
            // EL LEAD YA EXISTE
            const existingSfId = searchRes.data.records[0].Id;
            await db.run("UPDATE leads SET sf_id = ? WHERE id = ?", [existingSfId, lead.id]);
            return res.json({ success: true, sfId: existingSfId, message: "El lead ya existía en Salesforce. Se ha vinculado." });
        }

        // 3. CREAR NUEVO LEAD (Aplicando las Reglas de Oro)
        let nameParts = lead.nombre ? lead.nombre.trim().split(' ') : [];
        let firstName = nameParts.length > 0 ? nameParts[0] : ".";
        let lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : firstName; // Comodín: Apellido = Nombre si falta
        
        const sfPayload = {
            FirstName: firstName,
            LastName: lastName,
            Company: lead.nombre || ".", // Empresa obligatoria = Nombre o "."
            Phone: lead.phone || ".",
            Email: lead.correo && lead.correo.includes('@') ? lead.correo : null, // El email no acepta ".", mandamos null
            City: lead.ciudad || ".",
            State: lead.departamento || ".",
            Description: `[Lead capturado por ICBOT]\nInterés: ${lead.interes || '.'}\nDetalle: ${lead.producto_especifico || '.'}`
        };

        const createUrl = `${sfAuth.instanceUrl}/services/data/v60.0/sobjects/Lead/`;
        const createRes = await axios.post(createUrl, sfPayload, { headers });

        if (createRes.data.success) {
            const newSfId = createRes.data.id;
            await db.run("UPDATE leads SET sf_id = ? WHERE id = ?", [newSfId, lead.id]);
            return res.json({ success: true, sfId: newSfId, message: "Lead creado exitosamente en Salesforce." });
        } else {
            throw new Error("Salesforce devolvió un error desconocido al crear.");
        }

    } catch (error) {
        console.error("❌ Error en Salesforce Sync:", error.response ? JSON.stringify(error.response.data) : error.message);
        
        let errorMsg = "Error interno contactando a Salesforce.";
        if (error.response && error.response.data && error.response.data[0]) {
            errorMsg = `Rechazado por SF: ${error.response.data[0].message}`;
        } else if (error.message) {
            errorMsg = error.message;
        }

        res.status(500).json({ success: false, message: errorMsg });
    }
});

// Endpoint para sincronizar Masivamente
app.post('/api/salesforce/sync-bulk', proteger, async (req, res) => {
    try {
        const leadsPendientes = await db.all("SELECT * FROM leads WHERE sf_id IS NULL OR sf_id = ''");
        if (leadsPendientes.length === 0) {
            return res.json({ success: true, count: 0, message: "Todos los leads ya están sincronizados." });
        }

        const sfAuth = await getSalesforceToken();
        const headers = { 'Authorization': `Bearer ${sfAuth.token}`, 'Content-Type': 'application/json' };

        let successCount = 0;
        let errorCount = 0;

        for (const lead of leadsPendientes) {
            try {
                // Buscar duplicados
                let query = `SELECT Id FROM Lead WHERE Phone = '${lead.phone}'`;
                if (lead.correo && lead.correo.includes('@')) query += ` OR Email = '${lead.correo}'`;
                const searchRes = await axios.get(`${sfAuth.instanceUrl}/services/data/v60.0/query/?q=${encodeURIComponent(query)}`, { headers });

                if (searchRes.data.totalSize > 0) {
                    await db.run("UPDATE leads SET sf_id = ? WHERE id = ?", [searchRes.data.records[0].Id, lead.id]);
                    successCount++;
                    continue;
                }

                // Crear Nuevo
                let nameParts = lead.nombre ? lead.nombre.trim().split(' ') : [];
                let firstName = nameParts.length > 0 ? nameParts[0] : ".";
                let lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : firstName;
                
                const sfPayload = {
                    FirstName: firstName,
                    LastName: lastName,
                    Company: lead.nombre || ".",
                    Phone: lead.phone || ".",
                    Email: lead.correo && lead.correo.includes('@') ? lead.correo : null,
                    City: lead.ciudad || ".",
                    State: lead.departamento || ".",
                    Description: `[Lead masivo ICBOT]\nInterés: ${lead.interes || '.'}\nDetalle: ${lead.producto_especifico || '.'}`
                };

                const createRes = await axios.post(`${sfAuth.instanceUrl}/services/data/v60.0/sobjects/Lead/`, sfPayload, { headers });
                
                if (createRes.data.success) {
                    await db.run("UPDATE leads SET sf_id = ? WHERE id = ?", [createRes.data.id, lead.id]);
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (err) {
                console.error(`Error masivo lead ${lead.phone}:`, err.response ? err.response.data : err.message);
                errorCount++;
            }
            
            // Pausa para no saturar la API
            await new Promise(r => setTimeout(r, 200));
        }

        res.json({ success: true, count: successCount, message: `Completado: ${successCount} subidos/encontrados. ${errorCount} errores.` });

    } catch (error) {
        console.error("❌ Error Crítico Bulk:", error.message);
        res.status(500).json({ success: false, message: "Fallo al iniciar sincronización masiva." });
    }
});

process.on('SIGTERM', () => { if (serverInstance) serverInstance.close(() => process.exit(0)); else process.exit(0); });
process.on('SIGINT', () => { if (serverInstance) serverInstance.close(() => process.exit(0)); else process.exit(0); });
