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
// 1. VARIABLES DE ENTORNO
// ============================================================
const API_KEY = process.env.GEMINI_API_KEY; 
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = "icc-secret-v7-sql-full-resurrected";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// ============================================================
// 2. MOTOR DE BASE DE DATOS (SQLITE)
// ============================================================
let db;
(async () => {
    const DATA_DIR = path.resolve(__dirname, 'data');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    db = await open({
        filename: path.join(DATA_DIR, 'database.db'),
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, role TEXT, text TEXT, time TEXT);
        CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, name TEXT, email TEXT, city TEXT, interest TEXT, label TEXT, time TEXT, original_timestamp TEXT);
        CREATE TABLE IF NOT EXISTS metadata (phone TEXT PRIMARY KEY, contactName TEXT, labels TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, addedManual INTEGER DEFAULT 0, botActive INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, searchable TEXT UNIQUE, raw_data TEXT);
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    `);
    
    await refreshKnowledge();
    console.log("🚀 LORENA 7.1 SQL - MOTOR INICIADO CON ÉXITO");
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
    name: 'icc_session', secret: SESSION_SECRET, resave: true, saveUninitialized: true,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

// ============================================================
// 3. WHATSAPP ENGINE
// ============================================================
async function enviarWhatsApp(destinatario, contenido, tipo = "text") {
    try {
        let payload = { messaging_product: "whatsapp", to: destinatario, type: tipo };
        if (tipo === "text") { payload.text = { body: contenido }; } 
        else if (contenido.id) { 
            payload[tipo] = { id: contenido.id };
            if (tipo === 'document') payload.document.filename = "Archivo_ICC.pdf";
        } else {
            payload[tipo] = { link: contenido };
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
// 4. IA LORENA (CORREGIDA PARA CAPTURA DE DATOS)
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

    const meta = await db.get("SELECT botActive, contactName, addedManual FROM metadata WHERE phone = ?", [sessionId]);
    if (meta && meta.botActive === 0) return null;

    const configPrompt = await getCfg('prompt', "Eres Lorena.");
    const websiteData = await getCfg('website_data', "");
    const techRules = await getCfg('tech_rules', []);
    const historyRows = await db.all("SELECT role, text FROM history WHERE phone = ? ORDER BY id DESC LIMIT 15", [sessionId]);
    const chatPrevio = historyRows.reverse();
    const stock = buscarEnCatalogo(message);

    let reglasTexto = Array.isArray(techRules) ? techRules.map(r => `- ${r}`).join("\n") : techRules;

    const prompt = `ERES LORENA DE ICC. Personalidad: ${configPrompt}. Web: ${websiteData}. Inventario: ${JSON.stringify(stock)}. Reglas: ${reglasTexto}.
    MISION: Identificar NOMBRE, CORREO, CIUDAD e INTERÉS.
    [RESPUESTA JSON OBLIGATORIA]: [DATA] {"es_lead": true, "nombre": "...", "correo": "...", "ciudad": "...", "interes": "...", "etiqueta": "Lead Caliente"} [DATA]`;

    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: prompt + `\nHISTORIAL: ${JSON.stringify(chatPrevio)}\nUSUARIO: ${message}` }] }] });

        let fullText = res.data.candidates[0].content.parts[0].text;
        let textoVisible = fullText;
        
        // Regex mejorado para capturar el JSON incluso con saltos de línea
        const match = fullText.match(/\[DATA\]\s*(\{[\s\S]*?\})\s*\[DATA\]/);

        if (match) {
            textoVisible = fullText.replace(/\[DATA\]\s*(\{[\s\S]*?\})\s*\[DATA\]/, "").trim();
            try {
                const info = JSON.parse(match[1]);

                if(info.es_lead) {
                    const seisHorasAtras = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
                    const yaExiste = await db.get("SELECT id FROM leads WHERE phone = ? AND interest = ? AND time > ?", [sessionId, info.interes, seisHorasAtras]);

                    if (!yaExiste) {
                        let nombreFinal = info.nombre;
                        
                        // Si detecta nombre y no es manual, actualiza metadata
                        if (nombreFinal && !nombreFinal.toLowerCase().includes("desconocido")) {
                            if (!meta || meta.addedManual === 0) {
                                await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName", [sessionId, nombreFinal]);
                            }
                        }
                        
                        const updatedMeta = await db.get("SELECT contactName FROM metadata WHERE phone = ?", [sessionId]);
                        nombreFinal = updatedMeta?.contactName || sessionId;

                        // CORRECCIÓN DE CAMPOS: Mapeo exacto del JSON de la IA a las columnas de la DB
                        await db.run(
                            "INSERT INTO leads (phone, name, email, city, interest, label, time, original_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", 
                            [sessionId, nombreFinal, info.correo || "", info.ciudad || "", info.interes || "", info.etiqueta || "Lead", new Date().toLocaleString(), Date.now().toString()]
                        );
                        console.log("✅ Lead Capturado con éxito:", nombreFinal);
                    }
                }
            } catch (jsonErr) { console.error("Error parseando JSON de IA:", jsonErr); }
        }
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [sessionId, 'bot', textoVisible, new Date().toISOString()]);
        return textoVisible;
    } catch (e) { return "Un momento..."; }
}

// ============================================================
// 5. API ENDPOINTS (TRANSPOSICIÓN TOTAL)
// ============================================================
const proteger = (req, res, next) => req.session.isLogged ? next() : res.status(401).send("No autorizado");

app.post('/auth', (req, res) => {
    if (req.body.user === ADMIN_USER && req.body.pass === ADMIN_PASS) {
        req.session.isLogged = true;
        req.session.save(() => res.json({ success: true }));
    } else res.status(401).json({ success: false });
});

app.get('/api/chats-full', proteger, async (req, res) => {
    const rows = await db.all(`
        SELECT m.*, 
        (SELECT text FROM history WHERE phone = m.phone ORDER BY id DESC LIMIT 1) as lastText,
        (SELECT time FROM history WHERE phone = m.phone ORDER BY id DESC LIMIT 1) as lastTime
        FROM metadata m ORDER BY pinned DESC, lastTime DESC
    `);
    res.json(rows.map(r => ({
        id: r.phone, name: r.contactName || r.phone, pinned: !!r.pinned,
        botActive: !!r.botActive, labels: JSON.parse(r.labels || "[]"),
        lastMessage: { text: r.lastText || "Nuevo", time: r.lastTime }
    })));
});

app.get('/api/data/history', proteger, async (req, res) => {
    const rows = await db.all("SELECT * FROM history ORDER BY id ASC");
    const grouped = rows.reduce((acc, curr) => {
        if(!acc[curr.phone]) acc[curr.phone] = [];
        acc[curr.phone].push({ role: curr.role, text: curr.text, time: curr.time });
        return acc;
    }, {});
    res.json(grouped);
});

app.get('/api/data/leads', proteger, async (req, res) => {
    const rows = await db.all("SELECT * FROM leads ORDER BY id DESC");
    // Mapeo para que el Front reciba los nombres de campo que espera
    res.json(rows.map(r => ({ 
        ...r, 
        fecha: r.time, 
        nombre: r.name, 
        telefono: r.phone, 
        interes: r.interest, 
        ciudad: r.city, 
        correo: r.email 
    })));
});

app.post('/api/leads/delete', proteger, async (req, res) => {
    await db.run("DELETE FROM leads WHERE id = ?", [req.body.id]);
    res.json({ success: true });
});

app.post('/api/save-prompt-web', proteger, async (req, res) => {
    if(req.body.prompt !== undefined) await setCfg('prompt', req.body.prompt);
    if(req.body.website_data !== undefined) await setCfg('website_data', req.body.website_data);
    res.json({ success: true });
});

app.post('/api/config/rules/add', proteger, async (req, res) => {
    let rules = await getCfg('tech_rules', []);
    rules.push(req.body.rule);
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
    await db.run("INSERT INTO metadata (phone, contactName, addedManual) VALUES (?, ?, 1) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName", [req.body.phone, req.body.name]);
    res.json({ success: true });
});

app.post('/api/chat/action', proteger, async (req, res) => {
    const { phone, action, value } = req.body;
    if(action === 'rename') await db.run("UPDATE metadata SET contactName = ?, addedManual = 1 WHERE phone = ?", [value, phone]);
    if(action === 'pin') await db.run("UPDATE metadata SET pinned = ? WHERE phone = ?", [value ? 1 : 0, phone]);
    if(action === 'delete') {
        await db.run("DELETE FROM history WHERE phone = ?", [phone]);
        await db.run("DELETE FROM metadata WHERE phone = ?", [phone]);
    }
    if(action === 'label') {
        const row = await db.get("SELECT labels FROM metadata WHERE phone = ?", [phone]);
        let labels = JSON.parse(row?.labels || "[]");
        if(!labels.includes(value)) labels.push(value);
        await db.run("UPDATE metadata SET labels = ? WHERE phone = ?", [JSON.stringify(labels), phone]);
    }
    res.json({ success: true });
});

app.post('/api/chat/send', proteger, async (req, res) => {
    if (await enviarWhatsApp(req.body.phone, req.body.message)) {
        await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [req.body.phone, 'manual', req.body.message, new Date().toISOString()]);
        res.json({ success: true });
    } else res.status(500).json({ error: "Error" });
});

app.post('/api/chat/upload-send', proteger, upload.single('file'), async (req, res) => {
    try {
        const { phone, type } = req.body;
        const metaId = await uploadToMeta(req.file.buffer, req.file.mimetype, req.file.originalname);
        if (await enviarWhatsApp(phone, { id: metaId }, type)) {
            let icon = type === 'audio' ? '🎤 [Audio]' : (type === 'image' ? '📷 [Imagen]' : '📄 [Archivo]');
            await db.run("INSERT INTO history (phone, role, text, time) VALUES (?, ?, ?, ?)", [phone, 'manual', icon, new Date().toISOString()]);
            res.json({ success: true });
        } else res.status(500).json({ error: "Error" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat/toggle-bot', proteger, async (req, res) => {
    await db.run("INSERT INTO metadata (phone, botActive) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET botActive=excluded.botActive", [req.body.phone, req.body.active ? 1 : 0]);
    res.json({ success: true });
});

app.post('/api/knowledge/csv', proteger, upload.single('file'), async (req, res) => {
    try {
        const n = parse(req.file.buffer.toString('utf-8'), { columns: true });
        for(const r of n) {
            const searchable = Object.values(r).join(" ");
            await db.run("INSERT OR IGNORE INTO inventory (searchable, raw_data) VALUES (?, ?)", [searchable, JSON.stringify(r)]);
        }
        await refreshKnowledge();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "CSV Error" }); }
});

app.post('/api/knowledge/delete', proteger, async (req, res) => {
    // En SQL es mejor borrar por el contenido searchable único
    const rows = await db.all("SELECT searchable FROM inventory");
    if(rows[req.body.index]) {
        await db.run("DELETE FROM inventory WHERE searchable = ?", [rows[req.body.index].searchable]);
        await refreshKnowledge();
        res.json({ success: true });
    } else res.status(404).json({ error: "No encontrado" });
});

app.get('/api/data/knowledge', proteger, async (req, res) => {
    const rows = await db.all("SELECT searchable FROM inventory");
    res.json(rows);
});

app.post('/api/test-ai', proteger, async (req, res) => {
    try {
        const c = await getCfg('prompt', "");
        const web = await getCfg('website_data', "");
        const fullPrompt = `PROMPT: ${c}\nWEB: ${web}\nUSER: ${req.body.message}`;
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] });
        res.json({ response: res.data.candidates[0].content.parts[0].text, logic_log: fullPrompt });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/webhook', (req, res) => (req.query['hub.verify_token'] === 'ICC_2025' ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (contact) {
        const m = await db.get("SELECT addedManual FROM metadata WHERE phone = ?", [contact.wa_id]);
        if (!m || m.addedManual === 0) {
            await db.run("INSERT INTO metadata (phone, contactName) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET contactName=excluded.contactName", [contact.wa_id, contact.profile.name]);
        }
    }
    if (msg) {
        let txt = msg.text?.body || (msg.image ? "📷 Foto" : (msg.audio ? "🎤 Audio" : "Archivo"));
        let r = await procesarConLorena(txt, msg.from);
        if (r) await enviarWhatsApp(msg.from, r);
    }
});

app.use(express.static(__dirname, { index: false }));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => req.session.isLogged ? res.redirect('/') : res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => req.session.isLogged ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));

app.listen(process.env.PORT || 10000, () => console.log("🚀 LORENA 7.1 SQL - THE VAULT (FIDELIDAD TOTAL)"));
