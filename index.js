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
// 1. CONFIGURACIÓN Y VARIABLES DE ENTORNO
// ============================================================
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-valentina-secret-v10-5"; 

// Aumentamos el límite para permitir subida de archivos grandes (imágenes/PDFs/Videos)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// 🛡️ MIDDLEWARE DE SEGURIDAD DE ARCHIVOS
app.use((req, res, next) => {
    // Protege archivos .json o la carpeta /data/ para que no sean accesibles desde la web pública
    if ((req.path.endsWith('.json') || req.path.includes('/data/')) && !req.path.startsWith('/api/')) {
        return res.status(403).send('🚫 Acceso Prohibido');
    }
    next();
});

// ============================================================
// 2. MOTOR DE BASE DE DATOS SQLITE
// ============================================================
let db;
(async () => {
    const DATA_DIR = path.resolve(__dirname, 'data');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    db = await open({
        filename: path.join(DATA_DIR, 'database.db'),
        driver: sqlite3.Database
    });

    // Creación de Tablas Base si no existen
    // SE AGREGAN TABLAS NUEVAS: shortcuts (atajos) y global_tags (etiquetas colores)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT);
        CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT); 
        CREATE TABLE IF NOT EXISTS metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0, photoUrl TEXT);
        CREATE TABLE IF NOT EXISTS bot_status (phone TEXT PRIMARY KEY, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT);
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS shortcuts (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT UNIQUE, text TEXT);
        CREATE TABLE IF NOT EXISTS global_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, color TEXT);
    `);
    
    // Verificación y reparación de columnas de Leads
    const cols = ['nombre', 'interes', 'etiqueta', 'fecha', 'ciudad', 'correo'];
    for (const c of cols) {
        try { 
            await db.exec(`ALTER TABLE leads ADD COLUMN ${c} TEXT`); 
            console.log(`✅ Columna reparada: ${c}`);
        } catch (e) { 
            // La columna ya existe, ignoramos el error
        }
    }

    // Migración para foto de perfil en metadata (si no existe)
    try { await db.exec(`ALTER TABLE metadata ADD COLUMN photoUrl TEXT`); } catch(e) {}
    
    await refreshKnowledge();
    console.log("🚀 BACKEND VALENTINA v12.0 INICIADO (AUDIOS FIX + ETIQUETAS + ATAJOS)");
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
// 3. MOTOR DE WHATSAPP Y PROXY DE IMÁGENES/VIDEO/AUDIO
// ============================================================
async function enviarWhatsApp(destinatario, contenido, tipo = "text") {
    try {
        let payload = { messaging_product: "whatsapp", to: destinatario, type: tipo };
        
        if (tipo === "text") { 
            payload.text = { body: contenido }; 
        } else if (contenido.id) { 
            // Reenvío de media existente por ID
            if(tipo === 'image') payload.image = { id: contenido.id };
            if(tipo === 'document') payload.document = { id: contenido.id, filename: "Archivo_ICC.pdf" };
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
        console.error("Error enviando WhatsApp:", e.response?.data || e.message);
        return false; 
    }
}

// --- PROXY DE MEDIA MEJORADO (VIDEO/AUDIO STREAMING) ---
app.get('/api/media-proxy/:id', async (req, res) => {
    if (!req.session.isLogged) return res.status(401).send("No autorizado");
    try {
        // 1. Obtener la URL real y el TIPO DE CONTENIDO (Mime Type)
        const urlRes = await axios.get(`https://graph.facebook.com/v21.0/${req.params.id}`, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}` }
        });
        const mediaUrl = urlRes.data.url;
        const mimeType = urlRes.data.mime_type; 
        
        // 2. Descargar el binario y enviarlo con el Header correcto
        const media = await axios.get(mediaUrl, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}` },
            responseType: 'stream'
        });
        
        if (mimeType) {
            res.setHeader('Content-Type', mimeType);
        }
        
        media.data.pipe(res);
    } catch (e) {
        console.error("Error proxy media:", e.message);
        res.status(500).send("Error cargando media");
    }
});

// FUNCIÓN CORREGIDA PARA AUDIOS
async function uploadToMeta(buffer, mimeType, filename) {
    try {
        const form = new FormData();
        
        // FIX CRÍTICO: WhatsApp exige audio/ogg para notas de voz.
        // Si detectamos audio, forzamos el tipo.
        const contentType = mimeType.includes('audio') ? 'audio/ogg' : mimeType;
        const finalFilename = mimeType.includes('audio') ? 'audio.ogg' : filename;

        form.append('file', buffer, { filename: finalFilename, contentType: contentType });
        
        let type = 'document';
        if (mimeType.includes('image')) type = 'image';
        else if (mimeType.includes('audio')) type = 'audio';
        else if (mimeType.includes('video')) type = 'video';
        
        form.append('type', type);
        form.append('messaging_product', 'whatsapp');
        
        const response = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, form, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}`, ...form.getHeaders() }
        });
        return response.data.id;
    } catch (error) { 
        console.error("Upload error:", error.response?.data || error.message);
        return null; 
    }
}

// ============================================================
// 4. LÓGICA DE INTELIGENCIA (VALENTINA)
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

async function procesarConValentina(message, sessionId, mediaDesc = "") {
    // 1. Guardar mensaje del usuario en historial
    await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'user', mediaDesc || message, new Date().toISOString()]);
    
    // 2. Verificar si el bot está activo para este usuario
    const status = await db.get("SELECT active FROM bot_status WHERE phone = ?", [sessionId]);
    if (status && status.active === 0) return null; // Bot apagado manualmente

    // 3. Recuperar contexto y conocimiento
    const websiteData = await getCfg('website_data', "No hay información web extra.");
    const bizProfile = await getCfg('biz_profile', {}); // Info de la empresa nueva
    const techRules = await getCfg('tech_rules', []);
    const stock = buscarEnCatalogo(message);
    
    const historyRows = await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id DESC LIMIT 15", [sessionId]);
    const chatPrevio = historyRows.reverse();

    // 4. CONSTRUCCIÓN DEL PROMPT DE VALENTINA
    const promptValentina = `
    Usted es Valentina, asistente virtual de Importadora Casa Colombia (ICC) y atiende clientes por WhatsApp.
    
    [DATOS EMPRESA]
    Nombre: ${bizProfile.name || 'Importadora Casa Colombia'}
    Horario: ${bizProfile.hours || 'No definido'}
    Web/Info: ${websiteData}
    
    Su función NO es cerrar ventas: su misión es filtrar, ordenar la solicitud, recopilar datos clave y dejar el caso “listo para gol”.

    OBJETIVO PRINCIPAL
    1) Recibir y atender con tono formal y claro.
    2) Identificar intención: repuestos / maquinaria / servicio.
    3) Recolectar datos mínimos: Nombre, Ciudad, Máquina/Repuesto.

    TONO Y ESTILO (WHATSAPP)
    - Formal, cordial y eficiente. Use “usted”.
    - Mensajes breves (1–3 líneas). Emojis mínimos.
    - UNA pregunta por turno.
    - Si el cliente escribe “urgente” o “varado”, marque PRIORIDAD.

    INVENTARIO (Solo referencia): ${JSON.stringify(stock)}
    REGLAS TÉCNICAS: ${techRules.join("\n")}

    INSTRUCCIÓN DE SISTEMA - EXTRACCIÓN DE DATOS:
    Si el cliente proporciona datos nuevos, genere este JSON al final:
    
    \`\`\`json
    {
      "es_lead": true,
      "nombre": "Nombre detectado o null",
      "ciudad": "Ciudad detectada o null",
      "interes": "Repuesto/Maquina detectada o null",
      "correo": "Correo o null",
      "etiqueta": "Cotización"
    }
    \`\`\`
    `;

    try {
        const resAI = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: promptValentina + `\n\n--- HISTORIAL DE CHAT ---\n${JSON.stringify(chatPrevio)}\n\n--- MENSAJE DEL USUARIO ---\n${message}` }] }] });

        let fullText = resAI.data.candidates[0].content.parts[0].text;
        
        // 5. PROCESAMIENTO Y LIMPIEZA DE RESPUESTA
        const regexJSON = /```json([\s\S]*?)```|{([\s\S]*?)}$/i;
        const match = fullText.match(regexJSON);
        let textoVisible = fullText;

        if (match) {
            textoVisible = fullText.replace(match[0], "").trim();
            try {
                const jsonStr = match[1] || match[2] || match[0];
                const cleanJsonStr = jsonStr.replace(/```json/g, "").replace(/```/g, "").trim();
                const info = JSON.parse(cleanJsonStr);
                
                if(info.es_lead) {
                    await gestionarLead(sessionId, info);
                }
            } catch(e) { 
                console.error("Error procesando JSON de Valentina:", e.message); 
            }
        }

        textoVisible = textoVisible.replace(/\[DATA\][\s\S]*?\[DATA\]/gi, "").trim();

        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'bot', textoVisible, new Date().toISOString()]);
        return textoVisible;

    } catch (err) { 
        console.error("Error API Gemini:", err);
        return "Disculpe, estamos experimentando una breve intermitencia. ¿Podría repetirme su último mensaje?"; 
    }
}

async function gestionarLead(phone, info) {
    let nombreFinal = info.nombre;
    
    const leadExistente = await db.get("SELECT * FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1", [phone]);
    const meta = await db.get("SELECT contactName FROM metadata WHERE phone = ?", [phone]);
    
    if (!nombreFinal || nombreFinal === "null" || nombreFinal === "Nombre detectado") {
        nombreFinal = leadExistente?.nombre || meta?.contactName || "Cliente WhatsApp";
    }

    let esMismaConversacion = false;
    if (leadExistente) {
        const fechaLead = new Date(leadExistente.fecha);
        const ahora = new Date();
        if (!isNaN(fechaLead.getTime()) && (ahora - fechaLead)/(1000*60*60) < 24) {
            esMismaConversacion = true;
        }
    }

    const datos = {
        nombre: nombreFinal,
        interes: info.interes && info.interes !== "null" ? info.interes : (esMismaConversacion ? leadExistente.interes : "General"),
        ciudad: info.ciudad && info.ciudad !== "null" ? info.ciudad : (esMismaConversacion ? leadExistente.ciudad : "No indicada"),
        correo: info.correo && info.correo !== "null" ? info.correo : (esMismaConversacion ? leadExistente.correo : "No indicado"),
        etiqueta: info.etiqueta || "Lead"
    };

    if (esMismaConversacion) {
        await db.run(
            `UPDATE leads SET nombre=?, interes=?, etiqueta=?, ciudad=?, correo=?, fecha=? WHERE id = ?`,
            [datos.nombre, datos.interes, datos.etiqueta, datos.ciudad, datos.correo, new Date().toLocaleString(), leadExistente.id]
        );
    } else {
        await db.run(
            `INSERT INTO leads (phone, nombre, interes, etiqueta, fecha, ciudad, correo) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [phone, datos.nombre, datos.interes, datos.etiqueta, new Date().toLocaleString(), datos.ciudad, datos.correo]
        );
    }
}

// ============================================================
// 5. API ENDPOINTS (RUTAS DEL SISTEMA)
// ============================================================
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No autorizado");

app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isLogged = true;
        req.session.save(() => res.json({ success: true }));
    } else res.status(401).json({ success: false });
});

// APIs de Datos (GET)
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
            tech_rules: await getCfg('tech_rules', []),
            biz_profile: await getCfg('biz_profile', {}) // Perfil empresa
        });
        if (t === 'tags') return res.json(await db.all("SELECT * FROM global_tags")); // Etiquetas globales
        if (t === 'shortcuts') return res.json(await db.all("SELECT * FROM shortcuts")); // Atajos
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

// --- EDICIÓN MANUAL DE LEADS ---
app.post('/api/leads/update', proteger, async (req, res) => {
    const { id, field, value } = req.body;
    // Lista blanca de campos para evitar inyección
    const allowed = ['nombre','ciudad','interes','correo','etiqueta'];
    if(!allowed.includes(field)) return res.status(400).send("Campo no permitido");
    
    await db.run(`UPDATE leads SET ${field} = ? WHERE id = ?`, [value, id]);
    res.json({ success: true });
});

app.post('/api/leads/delete', proteger, async (req, res) => {
    await db.run("DELETE FROM leads WHERE id = ?", [req.body.id]);
    res.json({ success: true });
});

// --- GESTIÓN DE ETIQUETAS Y ATAJOS ---
app.post('/api/tags/add', proteger, async (req, res) => {
    try {
        await db.run("INSERT INTO global_tags (name, color) VALUES (?, ?)", [req.body.name, req.body.color]);
        res.json({success:true});
    } catch(e) { res.status(400).json({error: "Ya existe esa etiqueta"}); }
});
app.post('/api/tags/delete', proteger, async (req, res) => {
    await db.run("DELETE FROM global_tags WHERE id = ?", [req.body.id]);
    res.json({success:true});
});

app.post('/api/shortcuts/add', proteger, async (req, res) => {
    try {
        await db.run("INSERT INTO shortcuts (keyword, text) VALUES (?, ?)", [req.body.keyword, req.body.text]);
        res.json({success:true});
    } catch(e) { res.status(400).json({error: "Ya existe ese atajo"}); }
});
app.post('/api/shortcuts/delete', proteger, async (req, res) => {
    await db.run("DELETE FROM shortcuts WHERE id = ?", [req.body.id]);
    res.json({success:true});
});

// --- CONFIGURACIÓN DE EMPRESA Y REGLAS ---
app.post('/api/config/biz/save', proteger, async (req, res) => {
    // Guarda objeto completo del perfil de empresa (Nombre, horario, foto url si hubiera)
    await setCfg('biz_profile', req.body);
    // Mantenemos compatibilidad con website_data antiguo
    if(req.body.website_data) await setCfg('website_data', req.body.website_data);
    res.json({success:true});
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

// --- GESTIÓN DE CONTACTOS (FOTO Y AGREGAR) ---
app.post('/api/contacts/upload-photo', proteger, upload.single('file'), async (req, res) => {
    if(!req.file) return res.status(400).send("No file uploaded");
    
    // Guardamos la imagen en Base64 en la DB (para simplificar sin sistema de archivos complejo)
    // OJO: Idealmente esto iría a disco, pero para mantener tu estructura simple usamos base64 en SQLite.
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    
    await db.run("INSERT INTO metadata (phone, photoUrl) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET photoUrl=excluded.photoUrl", [req.body.phone, b64]);
    res.json({success:true});
});

app.post('/api/contacts/add', proteger, async (req, res) => {
    await db.run("INSERT INTO metadata (phone, contactName, addedManual) VALUES (?, ?, 1) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName, addedManual=1", [req.body.phone, req.body.name]);
    res.json({ success: true });
});

// --- ACCIONES DE CHAT ---
app.post('/api/chat/action', proteger, async (req, res) => {
    const { phone, action, value } = req.body;
    
    if(action === 'pin') {
        await db.run("INSERT INTO metadata (phone, pinned) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET pinned=excluded.pinned", [phone, value ? 1 : 0]);
    }
    
    // MODIFICADO: Ahora 'value' puede ser el array completo de etiquetas para reemplazar
    if(action === 'set_labels') {
        await db.run("INSERT INTO metadata (phone, labels) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET labels=excluded.labels", [phone, JSON.stringify(value)]);
    }
    // Mantengo compatibilidad con 'label' individual por si acaso
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
        const fullPrompt = `ERES VALENTINA (Modo Test). USER: "${req.body.message}"`;
        const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] });
        res.json({ response: r.data.candidates[0].content.parts[0].text, logic_log: fullPrompt });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- LISTA DE CHATS (MODIFICADA PARA INCLUIR FOTO) ---
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
            photoUrl: meta.photoUrl || null, // Enviamos la foto si existe
            timestamp: lastMsg ? lastMsg.time : new Date().toISOString()
        };
    }));
    
    list.sort((a,b) => (a.pinned === b.pinned) ? new Date(b.timestamp) - new Date(a.timestamp) : (a.pinned ? -1 : 1));
    res.json(list);
});

// Soporte de Video en Envío Manual
app.post('/api/chat/send', proteger, async (req, res) => {
    if(await enviarWhatsApp(req.body.phone, req.body.message)) {
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [req.body.phone, 'manual', req.body.message, new Date().toISOString()]);
        res.json({ success: true });
    } else res.status(500).json({ error: "Error enviando" });
});

app.post('/api/chat/toggle-bot', proteger, async (req, res) => {
    await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, ?)", [req.body.phone, req.body.active ? 1 : 0]);
    res.json({ success: true });
});

// Endpoints de Upload y Media (Para envio de archivos manuales)
app.post('/api/chat/upload-send', proteger, upload.single('file'), async (req, res) => {
    try {
        const { phone, type } = req.body; 
        if(!req.file) return res.status(400).json({error: "No file"});
        
        // Usamos la función uploadToMeta corregida para audios
        const mediaId = await uploadToMeta(req.file.buffer, req.file.mimetype, req.file.originalname);
        
        if(mediaId) {
            await enviarWhatsApp(phone, { id: mediaId }, type);
            let tag = `[MEDIA:${type.toUpperCase()}:${mediaId}]`;
            await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'manual', tag, new Date().toISOString()]);
            res.json({success: true});
        } else {
            res.status(500).json({error: "Error subiendo a Meta"});
        }
    } catch(e) { res.status(500).json({error: e.message}); }
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

// WEBHOOK DE META
app.get('/webhook', (req, res) => (req.query['hub.verify_token'] === 'ICC_2025' ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const value = req.body.entry?.[0]?.changes?.[0]?.value;
        const msg = value?.messages?.[0];
        
        if (value?.contacts?.[0]) {
            const cName = value.contacts[0].profile.name;
            const phone = value.contacts[0].wa_id;
            // Actualizamos nombre si es nuevo, pero respetamos si ya se editó manualmente
            await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=contactName WHERE addedManual=0", [phone, cName]);
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

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => req.session.isLogged ? res.redirect('/') : res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.use(express.static(__dirname, { index: false }));

app.listen(process.env.PORT || 10000, () => console.log("🚀 VALENTINA v12.0 ONLINE (AUDIOS FIX + ETIQUETAS + ATAJOS)"));
