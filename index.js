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
const SESSION_SECRET = "icc-valentina-secret-v10"; 

// Aumentamos el límite para permitir subida de archivos grandes (imágenes/PDFs)
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
    await db.exec(`
        CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT);
        CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT); 
        CREATE TABLE IF NOT EXISTS metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS bot_status (phone TEXT PRIMARY KEY, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT);
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
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
    
    await refreshKnowledge();
    console.log("🚀 BACKEND VALENTINA v10.0 INICIADO CORRECTAMENTE");
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
// 3. MOTOR DE WHATSAPP Y PROXY DE IMÁGENES
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

// --- NUEVO: PROXY PARA VER FOTOS ---
// WhatsApp no permite ver las URLs de las fotos directamente en el navegador por seguridad.
// Este endpoint actúa de puente: descarga la foto de Meta y se la sirve a tu Dashboard.
app.get('/api/media-proxy/:id', async (req, res) => {
    if (!req.session.isLogged) return res.status(401).send("No autorizado");
    try {
        // 1. Obtener la URL real de descarga
        const urlRes = await axios.get(`https://graph.facebook.com/v21.0/${req.params.id}`, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}` }
        });
        const mediaUrl = urlRes.data.url;
        
        // 2. Descargar el binario de la imagen y enviarlo al cliente (stream)
        const media = await axios.get(mediaUrl, {
            headers: { 'Authorization': `Bearer ${META_TOKEN}` },
            responseType: 'stream'
        });
        media.data.pipe(res);
    } catch (e) {
        console.error("Error proxy imagen:", e.message);
        res.status(500).send("Error cargando imagen");
    }
});

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
    const techRules = await getCfg('tech_rules', []);
    const stock = buscarEnCatalogo(message);
    
    const historyRows = await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id DESC LIMIT 15", [sessionId]);
    const chatPrevio = historyRows.reverse();

    // 4. CONSTRUCCIÓN DEL PROMPT DE VALENTINA (TEXTUAL SIN CAMBIOS)
    const promptValentina = `
    Usted es Valentina, asistente virtual de Importadora Casa Colombia (ICC) y atiende clientes por WhatsApp.
    Su función NO es cerrar ventas: su misión es filtrar, ordenar la solicitud, recopilar datos clave y dejar el caso “listo para gol” para que un asesor humano continúe con cotización y cierre.

    OBJETIVO PRINCIPAL
    1) Recibir y atender con tono formal y claro.
    2) Identificar intención: repuestos / maquinaria / martillos hidráulicos / volquetas / servicio / soporte / otros.
    3) Recolectar datos mínimos viables para cotizar (sin abrumar).
    4) Confirmar que la información quedó completa.
    5) Escalar y asignar a un ejecutivo humano (handoff) con resumen limpio.

    TONO Y ESTILO (WHATSAPP)
    - Formal, cordial y eficiente: use “usted”, nunca tutee.
    - Mensajes breves, fáciles de leer en celular (1–3 líneas por mensaje idealmente).
    - Emojis mínimos y funcionales (máximo 1 por mensaje y solo si aporta): 👋 ✅ 🔧 🛑
    - No escriba párrafos largos. No sea efusiva.
    - Siempre avance el proceso con UNA pregunta por turno.
    - NO bombardee con múltiples preguntas seguidas: espere la respuesta del cliente antes de seguir.
    - Si el cliente manda varios mensajes, espere a que termine (cuando haya una pausa) y luego responda integrando todo.
    - Antes de pedir datos, confirme qué necesita (para no pedir información innecesaria).

    PAUTAS DE CONVERSACIÓN (REGLAS DE ORO)
    - Un paso a la vez: primero entender necesidad → luego pedir datos → luego confirmar → luego pasar a asesor.
    - Si falta info crítica, pida SOLO la siguiente pieza más importante.
    - Si el cliente escribe “urgente”, “varado”, “parado”, marque PRIORIDAD y acelere la recolección mínima.
    - Nunca invente precios, stock o compatibilidades. Si faltan datos, pida evidencia (número de parte / foto / placa / referencia).
    - No prometa tiempos exactos. Use “en breve” o “lo antes posible”.
    - Proteja la experiencia: si el cliente está molesto, valide con calma y enfoque en solución.

    DATOS A CAPTURAR (LEAD / FICHA)
    Mínimos (obligatorios):
    1) Nombre
    2) Ciudad
    3) Qué necesita (repuesto o máquina) + marca y modelo de la máquina
    4) Cantidad (si aplica)
    
    GUIONES BASE (REFERENCIA):
    - SALUDO: "¡Hola! 👋 Soy Valentina, asistente virtual de Importadora Casa Colombia. Para orientarle mejor, ¿qué repuesto o qué máquina desea cotizar?"
    - DATOS: "Perfecto. Para validar disponibilidad y enviarle una cotización exacta, por favor indíqueme: 1) Nombre, 2) Ciudad, 3) Marca y modelo de la máquina."
    - CIERRE: "¡Listo, [Nombre]! ✅ Ya registré su solicitud. En breve un asesor humano de ICC le escribirá con disponibilidad y cotización."

    INFORMACIÓN DE CONTEXTO ACTUAL:
    WEB/EMPRESA: ${websiteData}
    REGLAS TÉCNICAS: ${techRules.join("\n")}
    INVENTARIO (Solo referencia, no confirmar stock sin validar): ${JSON.stringify(stock)}

    INSTRUCCIÓN DE SISTEMA - EXTRACCIÓN DE DATOS:
    Si el cliente proporciona datos nuevos (Nombre, Ciudad, Repuesto, etc.), SIEMPRE genere al final de su respuesta un bloque JSON oculto con este formato exacto:
    
    \`\`\`json
    {
      "es_lead": true,
      "nombre": "Nombre detectado o null",
      "ciudad": "Ciudad detectada o null",
      "interes": "Repuesto/Maquina detectada o null",
      "correo": "Correo o null",
      "etiqueta": "Cotización" (o "PRIORIDAD" si es urgente)
    }
    \`\`\`
    `;

    try {
        const resAI = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: promptValentina + `\n\n--- HISTORIAL DE CHAT ---\n${JSON.stringify(chatPrevio)}\n\n--- MENSAJE DEL USUARIO ---\n${message}` }] }] });

        let fullText = resAI.data.candidates[0].content.parts[0].text;
        
        // 5. PROCESAMIENTO Y LIMPIEZA DE RESPUESTA
        // Buscamos el bloque JSON (ya sea con ```json o sin él)
        const regexJSON = /```json([\s\S]*?)```|{([\s\S]*?)}$/i;
        const match = fullText.match(regexJSON);
        let textoVisible = fullText;

        if (match) {
            // Eliminar el JSON del mensaje que ve el usuario
            textoVisible = fullText.replace(match[0], "").trim();
            
            // Procesar el JSON internamente
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

        // Limpieza de seguridad adicional
        textoVisible = textoVisible.replace(/\[DATA\][\s\S]*?\[DATA\]/gi, "").trim();

        // Guardar respuesta del bot
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'bot', textoVisible, new Date().toISOString()]);
        return textoVisible;

    } catch (err) { 
        console.error("Error API Gemini:", err);
        return "Disculpe, estamos experimentando una breve intermitencia. ¿Podría repetirme su último mensaje?"; 
    }
}

async function gestionarLead(phone, info) {
    let nombreFinal = info.nombre;
    
    // Intentar recuperar nombre si viene nulo
    const leadExistente = await db.get("SELECT * FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1", [phone]);
    const meta = await db.get("SELECT contactName FROM metadata WHERE phone = ?", [phone]);
    
    if (!nombreFinal || nombreFinal === "null" || nombreFinal === "Nombre detectado") {
        nombreFinal = leadExistente?.nombre || meta?.contactName || "Cliente WhatsApp";
    }

    // Regla de 24 horas para no duplicar leads en la misma conversación
    let esMismaConversacion = false;
    if (leadExistente) {
        const fechaLead = new Date(leadExistente.fecha);
        const ahora = new Date();
        // Si la fecha es válida y pasó menos de 24 horas
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
        // ACTUALIZAR LEAD EXISTENTE
        await db.run(
            `UPDATE leads SET nombre=?, interes=?, etiqueta=?, ciudad=?, correo=?, fecha=? WHERE id = ?`,
            [datos.nombre, datos.interes, datos.etiqueta, datos.ciudad, datos.correo, new Date().toLocaleString(), leadExistente.id]
        );
        console.log(`🔄 LEAD ACTUALIZADO: ${datos.nombre}`);
    } else {
        // CREAR NUEVO LEAD
        await db.run(
            `INSERT INTO leads (phone, nombre, interes, etiqueta, fecha, ciudad, correo) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [phone, datos.nombre, datos.interes, datos.etiqueta, new Date().toLocaleString(), datos.ciudad, datos.correo]
        );
        console.log(`✅ NUEVO LEAD CREADO: ${datos.nombre}`);
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

// APIs de Datos
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
    // Aunque Valentina tiene su prompt fijo, guardamos esto por si quieres añadir datos extra
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

// Endpoint de Sandbox para pruebas manuales
app.post('/api/test-ai', proteger, async (req, res) => {
    try {
        const prompt = await getCfg('prompt', "");
        const fullPrompt = `ERES VALENTINA (Modo Test). USER: "${req.body.message}"`;
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
    } else res.status(500).json({ error: "Error enviando" });
});

app.post('/api/chat/toggle-bot', proteger, async (req, res) => {
    await db.run("INSERT OR REPLACE INTO bot_status (phone, active) VALUES (?, ?)", [req.body.phone, req.body.active ? 1 : 0]);
    res.json({ success: true });
});

// Endpoints de Inventario
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

// WEBHOOK DE META (Manejo de Mensajes y Fotos)
app.get('/webhook', (req, res) => (req.query['hub.verify_token'] === 'ICC_2025' ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const value = req.body.entry?.[0]?.changes?.[0]?.value;
        const msg = value?.messages?.[0];
        
        // Guardar nombre del contacto si viene de WhatsApp
        if (value?.contacts?.[0]) {
            const cName = value.contacts[0].profile.name;
            const phone = value.contacts[0].wa_id;
            await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=contactName WHERE addedManual=0", [phone, cName]);
        }

        if(msg) {
            let userMsg = "";
            let mediaDesc = "";

            // Manejo de Tipos de Mensaje
            if (msg.type === "text") {
                userMsg = msg.text.body;
            } else if (msg.type === "image") {
                // TRUCO: Guardamos el ID de la foto en el texto con formato especial
                userMsg = `[MEDIA:IMAGE:${msg.image.id}]`; 
                mediaDesc = "📷 FOTO RECIBIDA";
            } else if (msg.type === "document") {
                userMsg = `[MEDIA:DOC:${msg.document.id}]`;
                mediaDesc = "📄 DOCUMENTO RECIBIDO";
            } else if (msg.type === "audio") {
                userMsg = `[MEDIA:AUDIO:${msg.audio.id}]`;
                mediaDesc = "🎤 AUDIO RECIBIDO";
            }

            // Enviamos a Valentina (si es foto, le damos contexto en texto plano)
            const inputIA = mediaDesc ? `(El usuario envió: ${mediaDesc})` : userMsg;
            const respuesta = await procesarConValentina(inputIA, msg.from, userMsg); // userMsg se guarda en BD
            
            if(respuesta) await enviarWhatsApp(msg.from, respuesta);
        }
    } catch(e) { console.error("Webhook Error:", e); }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => req.session.isLogged ? res.redirect('/') : res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.use(express.static(__dirname, { index: false }));

app.listen(process.env.PORT || 10000, () => console.log("🚀 VALENTINA v10.0 SQL - SISTEMA COMPLETO ONLINE"));
