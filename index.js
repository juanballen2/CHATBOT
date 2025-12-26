const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

// ============================================================
// 🔑 CONFIGURACIÓN Y CONSTANTES
// ============================================================
app.set('trust proxy', 1);

const API_KEY = "AIzaSyACJytpDnPzl9y5FeoQ5sx8m-iyhPXINto"; 
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025";
const SESSION_SECRET = process.env.SESSION_SECRET || "icc-ultra-secret-2025";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// SERVIR ARCHIVOS ESTÁTICOS (ESTO ARREGLA EL FRONT)
app.use(express.static(__dirname)); 
app.use('/images', express.static(path.join(__dirname, 'images')));

const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    knowledge: path.join(DATA_DIR, 'knowledge.json'),
    config: path.join(DATA_DIR, 'config.json'),
    leads: path.join(DATA_DIR, 'leads.json'),
    history: path.join(DATA_DIR, 'history.json')
};

const readData = (file, fallback) => {
    try {
        if (!fs.existsSync(file)) return fallback;
        const content = fs.readFileSync(file, 'utf8');
        return content ? JSON.parse(content) : fallback;
    } catch (err) { return fallback; }
};

const writeData = (file, data) => {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; } 
    catch (err) { return false; }
};

// ============================================================
// 💾 SESIÓN RE-ESTABLECIDA (YA DEBE FUNCIONAR)
// ============================================================
app.use(session({
    secret: SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    cookie: { 
        secure: false, // Cambiado para evitar el bloqueo en Railway/Render inicial
        maxAge: 1000 * 60 * 60 * 24 
    }
}));

// ============================================================
// 🚦 RUTAS DE ACCESO
// ============================================================

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.isLogged = true;
        req.session.save(() => {
            res.json({ success: true });
        });
    } else {
        res.status(401).json({ success: false, error: "Credenciales inválidas" });
    }
});

const proteger = (req, res, next) => {
    if (req.session.isLogged) return next();
    res.redirect('/login');
};

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// ============================================================
// 🧠 LÓGICA DE INTELIGENCIA Y API
// ============================================================

app.get('/api/data/:type', proteger, (req, res) => res.json(readData(FILES[req.params.type], [])));

app.post('/api/save-personality', proteger, (req, res) => {
    const config = readData(FILES.config, {});
    config.prompt = req.body.prompt;
    writeData(FILES.config, config);
    res.json({ success: true });
});

app.post('/save-context', proteger, (req, res) => {
    const config = readData(FILES.config, {});
    config.tech_rules = req.body.context;
    writeData(FILES.config, config);
    res.json({ success: true });
});

// WEBHOOK TESTER
app.post('/webhook', async (req, res) => {
    // Lógica simplificada para el test del Dashboard
    res.json({ reply: "Lorena está lista. Configura Meta para WhatsApp." });
});

// RUTA PRINCIPAL (DASHBOARD)
app.get('/', proteger, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(process.env.PORT || 10000, () => console.log(`🚀 ICC SISTEMA ONLINE`));
