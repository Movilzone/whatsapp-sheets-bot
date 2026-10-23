import express from 'express';
import * as BaileysPkg from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import https from 'https';

const baileys = BaileysPkg.default || BaileysPkg;
const makeWASocket = typeof baileys === 'function' ? baileys : (baileys.default || BaileysPkg.makeWASocket || baileys.makeWASocket);
const DisconnectReason = baileys.DisconnectReason || BaileysPkg.DisconnectReason;
const useMultiFileAuthState = baileys.useMultiFileAuthState || BaileysPkg.useMultiFileAuthState;
const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion || BaileysPkg.fetchLatestBaileysVersion;

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbzkA71Pg1GE-HWggMZaXcGW710U58ZPZUQ39R3IagFIuTivrihtHYA3erllAkGin1bpfw/exec';
const TARGET_NAME = 'solo iphone ventas';
const TARGET_JID = '120363218784172812@g.us';

let currentQRDataUrl = null;
let isConnected = false;
let recentEvents = [];

function normalize(str) {
    return (str || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function sendToGoogleSheets(payload) {
    return new Promise((resolve, reject) => {
        const dataString = JSON.stringify(payload);
        const url = new URL(WEBHOOK_URL);

        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(dataString)
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                https.get(res.headers.location, (redirRes) => {
                    let body = '';
                    redirRes.on('data', d => body += d);
                    redirRes.on('end', () => resolve(body));
                }).on('error', reject);
                return;
            }
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => resolve(body));
        });

        req.on('error', reject);
        req.write(dataString);
        req.end();
    });
}

function classifyAndParse(text, senderName) {
    const raw = text.trim();
    const lower = normalize(raw);

    // Filter out chatter immediately
    if (/^(hola|buenas|buen dia|buenas tardes|oki|ok|okaa|joya|gracias|listo|dale|si|no|👍|jaja|genial)$/i.test(lower)) {
        return null;
    }

    const hasAmount = /u\$?\s*\d+/i.test(raw) || /\d+\s*usd/i.test(raw) || /\$\s*[\d.]+/i.test(raw);
    const hasIphone = /\b(iphone|iph|1[1-8]\s*(?:pro|max|plus|mini)?|xr|xs)\b/i.test(lower);
    const hasImei = /\b\d{14,15}\b/.test(raw);

    // 1. Ingresos de Stock / Compras de equipos
    if (lower.includes('deja') && (hasIphone || hasImei)) {
        let costo = 0;
        const matchCosto = raw.match(/u\$?\s*([0-9.,]+)/i) || raw.match(/([0-9.,]+)\s*usd/i);
        if (matchCosto) costo = parseFloat(matchCosto[1].replace(/\./g, '').replace(',', '.')) || 0;

        let proveedor = senderName || 'Proveedor';
        const provMatch = raw.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\s+deja/i);
        if (provMatch) proveedor = provMatch[1];

        return {
            type: 'stock',
            payload: {
                action: 'nuevo_stock',
                proveedor: proveedor,
                modelo: raw.substring(0, 30),
                costo: costo,
                notas: raw
            }
        };
    }

    // 2. Cobros / Pagos de clientes
    const isCobro = (lower.startsWith('pago ') || lower.includes(' pago ') || lower.includes('pago*') || (lower.includes('retira') && lower.includes('pago'))) && hasAmount;
    if (isCobro) {
        let montoUsd = 0;
        let montoArs = 0;
        
        const usdMatch = raw.match(/u\$?\s*([0-9.,]+)/i) || raw.match(/([0-9.,]+)\s*usd/i);
        if (usdMatch) montoUsd = parseFloat(usdMatch[1].replace(/\./g, '').replace(',', '.')) || 0;

        const arsMatch = raw.match(/\$\s*([0-9.,]+)/i);
        if (arsMatch && (!usdMatch || raw.indexOf(arsMatch[0]) !== raw.indexOf(usdMatch[0]))) {
            montoArs = parseFloat(arsMatch[1].replace(/\./g, '').replace(',', '.')) || 0;
        }

        let cliente = senderName || 'Cliente';
        const clienteMatch = raw.match(/pago\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i) ||
                             raw.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\s+pago/i);
        if (clienteMatch) cliente = clienteMatch[1];

        return {
            type: 'cobro',
            payload: {
                action: 'nuevo_cobro',
                cliente: cliente,
                monto_usd: montoUsd,
                monto_ars: montoArs,
                medio: (montoUsd > 0 && montoArs > 0) ? 'MIXTO (USD + ARS)' : (montoUsd > 0 ? 'EFECTIVO USD' : 'EFECTIVO ARS'),
                notas: raw
            }
        };
    }

    // 3. Ventas / Entregas de celulares
    const isVentaDirecta = (lower.includes('vendido') || lower.includes('venta') || lower.includes('entrego a') || lower.includes('comprado a')) && (hasIphone || hasAmount || hasImei);
    const isReservaGremio = lower.includes('gremio') && hasIphone;

    if (isVentaDirecta || isReservaGremio) {
        let modelo = '';
        const iphMatch = raw.match(/((?:iph(?:one)?|1[1-8])\s*(?:pro|plus|max|mini)?(?:\s*\d{2,3}gb)?(?:\s*[a-z]+)?)/i);
        if (iphMatch) modelo = iphMatch[1].trim();

        let precioVenta = 0;
        const vtaMatch = raw.match(/vendido\s*a\s*([a-zA-ZáéíóúÁÉÍÓÚñÑ]+)(?:\s*en)?\s*u?\$?\s*([0-9.,]+)/i) ||
                         raw.match(/u?\$?\s*([0-9.,]+)/i);
        let cliente = 'Cliente';
        if (vtaMatch && vtaMatch.length >= 3) {
            cliente = vtaMatch[1].trim();
            precioVenta = parseFloat(vtaMatch[2].replace(/\./g, '').replace(',', '.')) || 0;
        } else if (vtaMatch) {
            precioVenta = parseFloat(vtaMatch[1].replace(/\./g, '').replace(',', '.')) || 0;
        }

        const clienteMatch = raw.match(/(?:a|cliente|entrego a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i) ||
                             raw.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\s+gremio/i);
        if (clienteMatch) cliente = clienteMatch[1].trim();

        let costo = 0;
        const costoMatch = raw.match(/comprado\s*a\s*[a-zA-ZáéíóúñÑ]+\s*u?\$?\s*([0-9.,]+)/i) ||
                           raw.match(/costo\s*u?\$?\s*([0-9.,]+)/i);
        if (costoMatch) costo = parseFloat(costoMatch[1].replace(/\./g, '').replace(',', '.')) || 0;

        const noPago = lower.includes('no pago') || lower.includes('no pagó') || lower.includes('debe');
        const estadoPago = noPago ? 'PENDIENTE' : (precioVenta > 0 ? 'PAGADO TOTAL' : 'CONSULTAR');

        return {
            type: 'venta',
            payload: {
                action: 'nueva_venta',
                cliente: cliente,
                modelo: modelo || raw.substring(0, 30),
                detalle: raw,
                precio: precioVenta,
                costo: costo,
                estado_pago: estadoPago,
                forma_pago: 'EFECTIVO USD',
                cobrado: noPago ? 0 : precioVenta,
                notas: `WhatsApp: ${raw}`
            }
        };
    }

    return null;
}

async function startWhatsApp() {
    const authPath = path.join(process.cwd(), 'auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Movil Zone Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQRDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2, color: { dark: '#075E54', light: '#FFFFFF' } });
            isConnected = false;
        }

        if (connection === 'open') {
            isConnected = true;
            currentQRDataUrl = null;
            console.log('>>> CONECTADO CON ÉXITO A WHATSAPP <<<');
        } else if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify' || m.type === 'append') {
            for (const msg of m.messages) {
                const jid = msg.key.remoteJid;
                const isTarget = jid === TARGET_JID || (jid && jid.endsWith('@g.us') && normalize(jid).includes('120363218784172812'));
                
                const text = msg.message?.conversation || 
                             msg.message?.extendedTextMessage?.text || 
                             msg.message?.imageMessage?.caption || '';

                if (isTarget && text && text.trim().length > 0) {
                    const senderName = msg.pushName || 'Movil Zone';
                    const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
                    
                    const transaction = classifyAndParse(text, senderName);
                    
                    if (transaction) {
                        console.log(`\n🔔 OPERACIÓN DETECTADA [${transaction.type.toUpperCase()}]: ${senderName}: ${text}`);
                        try {
                            const response = await sendToGoogleSheets(transaction.payload);
                            console.log('✅ Enviado a Google Sheets:', response);
                            
                            recentEvents.unshift({
                                fecha: now,
                                emisor: senderName,
                                mensaje: text,
                                tipo: transaction.type,
                                estado: 'Guardado en Google Sheets'
                            });
                            if (recentEvents.length > 20) recentEvents.pop();

                            if (!msg.key.fromMe) {
                                try {
                                    await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
                                } catch (e) {}
                            }
                        } catch (err) {
                            console.error('❌ Error enviando a Google Sheets:', err.message);
                        }
                    } else {
                        console.log(`💬 Chat casual ignorado: "${text}"`);
                    }
                }
            }
        }
    });
}

// Servidor Web para Render (Dashboard + QR + Keepalive)
app.use(express.json());

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:50px;">
                <h1 style="color:#25D366;">🟢 WhatsApp ya está conectado</h1>
                <p>No se requiere escanear QR. El bot está escuchando el grupo.</p>
                <a href="/">Volver al panel</a>
            </body></html>
        `);
    }
    if (!currentQRDataUrl) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:50px;">
                <h1>Generando código QR...</h1>
                <p>Por favor recargá en 3 segundos.</p>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </body></html>
        `);
    }
    res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5;">
            <div style="background:white;padding:30px;max-width:450px;margin:auto;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                <h2 style="color:#075E54;margin-top:0;">📲 Escaneá con WhatsApp</h2>
                <p style="color:#666;">Abrí WhatsApp en tu celular > Dispositivos vinculados > Vincular un dispositivo</p>
                <img src="${currentQRDataUrl}" style="width:300px;height:300px;border-radius:8px;" />
                <p style="font-size:12px;color:#888;">El código se renueva automáticamente cada 20 segundos.</p>
                <script>setTimeout(() => location.reload(), 20000);</script>
            </div>
        </body></html>
    `);
});

app.get('/', (req, res) => {
    const statusColor = isConnected ? '#25D366' : '#FF9900';
    const statusText = isConnected ? '🟢 ACTIVO Y ESCUCHANDO 24/7' : '🟡 ESPERANDO ESCANEO DE QR';
    
    let rowsHtml = recentEvents.map(e => `
        <tr style="border-bottom:1px solid #eee;">
            <td style="padding:10px;font-size:13px;">${e.fecha}</td>
            <td style="padding:10px;font-weight:bold;">${e.emisor}</td>
            <td style="padding:10px;font-size:13px;">${e.mensaje}</td>
            <td style="padding:10px;"><span style="background:#e8f5e9;color:#2e7d32;padding:4px 8px;border-radius:4px;font-size:12px;">${e.tipo.toUpperCase()}</span></td>
            <td style="padding:10px;color:#2e7d32;font-size:12px;">${e.estado}</td>
        </tr>
    `).join('');

    if (recentEvents.length === 0) {
        rowsHtml = `<tr><td colspan="5" style="padding:20px;text-align:center;color:#888;">Esperando nuevos mensajes en 🚨SOLO IPHONE VENTAS🚨...</td></tr>`;
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Panel WhatsApp Ventas - Movil Zone</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f9; margin: 0; padding: 25px; }
                .container { max-width: 950px; margin: auto; }
                .header { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
                .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
                table { width: 100%; border-collapse: collapse; text-align: left; }
                th { background: #f9fafb; padding: 12px 10px; color: #4b5563; font-size: 13px; text-transform: uppercase; }
                .badge { font-weight: bold; padding: 6px 12px; border-radius: 20px; color: white; display: inline-block; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div>
                        <h2 style="margin:0 0 5px 0; color:#111827;">📱 Control WhatsApp Ventas 24/7</h2>
                        <div style="color:#6b7280; font-size:14px;">Grupo vigilado: <strong>🚨SOLO IPHONE VENTAS🚨</strong></div>
                    </div>
                    <div style="text-align:right;">
                        <span class="badge" style="background:${statusColor};">${statusText}</span>
                        ${!isConnected ? '<div style="margin-top:8px;"><a href="/qr" style="background:#075E54;color:white;text-decoration:none;padding:6px 14px;border-radius:6px;font-size:13px;font-weight:bold;">📲 Ver QR para Escanear</a></div>' : ''}
                    </div>
                </div>

                <div class="card">
                    <h3 style="margin-top:0; color:#374151;">Últimos mensajes registrados hacia Google Sheets</h3>
                    <table>
                        <thead>
                            <tr>
                                <th>Fecha y Hora</th>
                                <th>Remitente</th>
                                <th>Mensaje Detectado</th>
                                <th>Operación</th>
                                <th>Google Sheets</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Servidor Web activo en http://localhost:${PORT}`);
    startWhatsApp().catch(err => console.error('Error iniciando WhatsApp:', err));
});
