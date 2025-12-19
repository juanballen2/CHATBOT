const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const https = require('https');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');
const cheerio = require('cheerio');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

// CONFIGURACIÓN (Render usará estas variables)
const API_KEY = process.env.GEMINI_KEY; 
const ADMIN_USER = process.env.ADMIN_USER || "admin"; 
const ADMIN_PASS = process.env.ADMIN_PASS || "icc2025"; 

app.use(express.json());
app.use(session({
    secret: 'icc-ultra-secret-key-2025',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 }
}));

// RUTA DE LOGIN (La que te está fallando)
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/auth', (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        req.session.isLogged = true;
        return res.json({ success: true });
    }
    res.status(401).send();
});

// PROTECCIÓN DE RUTAS
const proteger = (req, res, next) => {
    if (req.session.isLogged) return next();
    if (['/login', '/auth', '/webhook'].includes(req.path)) return next();
    res.redirect('/login');
};

app.use(proteger);
app.use(express.static(__dirname));

// WEBHOOK PARA WHATSAPP Y PRUEBAS
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token === 'ICC_2025') return res.status(200).send(challenge);
    res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    // Aquí procesamos los mensajes (Dashboard o WhatsApp)
    res.sendStatus(200);
});

// CARGA DE CATÁLOGO Y LEADS (Mismo código anterior)
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 MOTOR ICC 2.5 LISTO EN PUERTO ${PORT}`);
});
});
