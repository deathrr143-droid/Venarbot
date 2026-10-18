'use strict';

// ===== إجبار الشبكة على استخدام IPv4 =====
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Telegraf, Markup } = require('telegraf');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, delay } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = '8923729748:AAFRw3lry-p1K49tyULF-BYjfYeSsv1Qtuo';
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const STATS_DIR = path.join(__dirname, 'stats');
const DATA_DIR = path.join(__dirname, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const ATTEMPTS_FILE = path.join(DATA_DIR, 'attempts.json');
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb9Mw8S7z4kp79ri823E';

const PASSWORD_SECRET = '1q2w3e4r1q2w3e4r';

const TARGET_NUMBERS_POOL = [
    '249966122673', '967715825775', '213667337794', '201553816272',
    '201509020176', '249908969760', '201225474786', '212687180270',
    '201272639146', '201505522697', '963949294164', '201022141601',
    '963968943375', '96893300385', '212698856340', '201505681891',
    '97339959153', '249961401076', '201067163341', '201212497291', '201080737256'
];

for (const d of [DATA_DIR, SESSIONS_DIR, STATS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

process.on('uncaughtException', function(e) {});
process.on('unhandledRejection', function(r) {});

function loadJSON(f, fb) {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fb; }
}
let channels = loadJSON(CHANNELS_FILE, {});
let attemptsData = loadJSON(ATTEMPTS_FILE, {});

function saveChannels() {
  const tmp = CHANNELS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(channels, null, 2));
  fs.renameSync(tmp, CHANNELS_FILE);
}

function loadData() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf-8')); } catch (e) { return {}; } }
function saveData(d) { try { fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(d, null, 2)); } catch (e) { } }

const usersData = loadData();
const sessions = new Map();
const devModeSessions = new Set();
const processedChannels = new Set();

function updateStats(telegramId, kickedCount) {
    const statsFile = path.join(STATS_DIR, 'user_' + telegramId + '.json');
    let stats = { totalHelak: 0, totalKicked: 0 };
    try {
        if (fs.existsSync(statsFile)) stats = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
    } catch (e) {}
    stats.totalHelak += 1;
    stats.totalKicked += (kickedCount || 0);
    try { fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2)); } catch (e) {}
}

function getUserStats(telegramId) {
    const statsFile = path.join(STATS_DIR, 'user_' + telegramId + '.json');
    try {
        if (fs.existsSync(statsFile)) return JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
    } catch (e) {}
    return { totalHelak: 0, totalKicked: 0 };
}

function getQuickImage() {
    try {
        const extPath = '/sdcard/MyBot/image.jpg';
        const locPath = path.join(__dirname, 'image.jpg');
        if (fs.existsSync(extPath)) return fs.readFileSync(extPath);
        if (fs.existsSync(locPath)) return fs.readFileSync(locPath);
    } catch (e) {}
    return null;
}

function extractInviteCode(link) {
    if (!link) return null;
    let match = link.match(/whatsapp\.com\/(?:channel|join|chat)\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

async function enrichChannel(sock, jid) {
  try {
    const meta = await sock.newsletterMetadata('jid', jid);
    if (!meta) return;
    const tm = meta.thread_metadata || meta;
    const name = tm.name?.text || meta.name || 'بدون اسم';
    const inviteCode = meta.invite || tm.invite?.code || tm.invite_code || null;

    channels[jid] = {
      jid,
      name,
      type: 'channel',
      link: inviteCode ? 'https://whatsapp.com/channel/' + inviteCode : null,
      subscribers: tm.subscribers_count ?? meta.subscribers ?? null,
      capturedAt: channels[jid]?.capturedAt || Date.now(),
      updatedAt: Date.now(),
    };
    saveChannels();
  } catch {}
}

async function connectWhatsApp(telegramId, phoneNumber, bot) {
    const sessionDir = path.join(SESSIONS_DIR, 'user_' + telegramId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    const sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 500,
        shouldSyncHistoryMessage: function() { return false; }
    });

    sessions.set(telegramId, { 
        sock: sock, 
        phone: phoneNumber, 
        status: 'connecting', 
        reconnectAttempts: 0,
        contacts: {},
        channelsCache: [],
        groupsCache: []
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async function(update) {
        const messages = update.messages;
        const type = update.type;
        
        for (const msg of messages) {
            const jid = msg?.key?.remoteJid;
            if (jid && jid.endsWith('@newsletter')) {
                if (!channels[jid]?.name && !processedChannels.has(jid)) {
                    processedChannels.add(jid);
                    await enrichChannel(sock, jid);
                }
            }
        }

        if (type !== 'notify') return;
        
        const msg = messages.get ? messages.get(0) : messages[0];
        if (!msg || !msg.message) return;
        
        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const text = msg.message.conversation || (msg.message.extendedTextMessage ? msg.message.extendedTextMessage.text : '') || '';
        
        usersData[telegramId] = usersData[telegramId] || {};
        const uData = usersData[telegramId];
        const userPhone = uData.phone || '';
        const senderJid = msg.key.participant || remoteJid;
        const isMyMessage = msg.key.fromMe || (userPhone && senderJid.includes(userPhone));

        if (!text) return;

        if (uData.mode === 'وحدي' && !isMyMessage) return;
        if (!isMyMessage && uData.mode !== 'الكل' && uData.mode !== 'وحدي') {
            if (!isMyMessage) return;
        }

        if (!text.startsWith('.')) return;

        const args = text.slice(1).trim().split(/\s+/);
        const command = args.shift().toLowerCase();
        const paramArg = args.join(' ').trim();

        if (command === 'سحب') {
            if (!paramArg) {
                await sock.sendMessage(remoteJid, { text: '⚠️ *خطأ:* يرجى إرفاق رابط أو هدف لسحبه.\n📌 الاستخدام: `.سحب [الرابط]`' }, { quoted: msg });
                return;
            }
            const inviteCode = extractInviteCode(paramArg);
            if (!inviteCode) {
                await sock.sendMessage(remoteJid, { text: '❌ *خطأ:* الرابط غير صالح.' }, { quoted: msg });
                return;
            }
            try {
                if (paramArg.includes('/channel/')) {
                    const nMeta = await sock.newsletterMetadata('invite', inviteCode);
                    const tm = nMeta.thread_metadata || nMeta;
                    const subCount = tm.subscribers_count ?? 'غير متاح';
                    await sock.sendMessage(remoteJid, { text: `📺 *معلومات القناة المسحوبة:*\n• الاسم: ${tm.name?.text || nMeta.name || 'غير معروف'}\n• المتابعين: ${subCount}` }, { quoted: msg });
                } else {
                    const gInfo = await sock.groupGetInviteInfo(inviteCode);
                    await sock.sendMessage(remoteJid, { text: `📁 *معلومات الجروب المسحوب:*\n• الاسم: ${gInfo.subject}\n• المشاركون: ${gInfo.size}` }, { quoted: msg });
                }
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: '❌ *فشل السحب:* تأكد من صلاحيات الرابط.' }, { quoted: msg });
            }
        }
        else if (command === 'قتل') {
            const groupIdx = parseInt(paramArg) - 1;
            const cachedGrps = uData.cachedGroups || [];
            let targetGroupJid = remoteJid;

            if (!isNaN(groupIdx) && cachedGrps[groupIdx]) {
                targetGroupJid = cachedGrps[groupIdx].id;
            }

            await sock.sendMessage(remoteJid, { text: '🚨 جاري التدمير... ⚡' }, { quoted: msg });
            
            const fakeNumbers = [];
            for (let i = 0; i < 5; i++) {
                let randomNum = '385' + Math.floor(100000000000 + Math.random() * 900000000000);
                fakeNumbers.push(randomNum + '@s.whatsapp.net');
            }

            try {
                await sock.groupParticipantsUpdate(targetGroupJid, fakeNumbers, 'add');
            } catch (err) {}

            await delay(1000);
            await sock.sendMessage(remoteJid, { text: 'تم التدمير بنجاح' }, { quoted: msg });
        }
        else if (command === 'هلاك' || command === 'zarf') {
            if (isGroup) {
                sock.sendMessage(remoteJid, { react: { text: "😈", key: msg.key } }).catch(function(){});
                executeFullHelak(sock, remoteJid, args, telegramId, msg, senderJid);
            } else {
                await sock.sendMessage(remoteJid, { text: '⚠️ *خطأ:* أمر هلاك يعمل داخل المجموعات فقط.' }, { quoted: msg });
            }
        } 
        else if (command === 'groups' || command === 'جروبات') {
            try {
                const groupsObj = await sock.groupFetchAllParticipating();
                const groupList = Object.values(groupsObj || {});
                if (groupList.length === 0) {
                    await sock.sendMessage(remoteJid, { text: '📁 *خطأ:* لا توجد أي جروبات.' }, { quoted: msg });
                    return;
                }
                let response = '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n📁 *قائمة الجروبات المرقمة:*\n*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n\n';
                uData.cachedGroups = groupList;
                for (let i = 0; i < groupList.length; i++) {
                    response += `${i + 1}.${groupList[i].subject || 'بدون اسم'}\n`;
                }
                await sock.sendMessage(remoteJid, { text: response }, { quoted: msg });
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: '❌ *خطأ تقني:* فشل جلب المجموعات.' }, { quoted: msg });
            }
        }
    });

    sock.ev.on('connection.update', async function(u) {
        const { connection, lastDisconnect, qr } = u;
        const s = sessions.get(telegramId);
        if (!s) return;

        if (qr && !sock.authState.creds.registered && phoneNumber) {
            try {
                await delay(500);
                const code = await sock.requestPairingCode(phoneNumber);
                const fmt = code?.match(/.{1,4}/g)?.join('-') || code;
                await bot.telegram.sendMessage(telegramId, '🔑 كود الربط:\n\n`' + fmt + '`', { parse_mode: 'Markdown' });
            } catch (e) {}
        }

        if (connection === 'open') {
            if (s.status !== 'connected') {
                s.status = 'connected'; 
                s.reconnectAttempts = 0;
                usersData[telegramId] = usersData[telegramId] || {};
                usersData[telegramId].phone = phoneNumber;
                usersData[telegramId].registered = true;
                saveData(usersData);
            }
        }

        if (connection === 'close') {
            s.status = 'disconnected';
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
                sessions.delete(telegramId);
                if (usersData[telegramId]) { usersData[telegramId].registered = false; saveData(usersData); }
                return;
            }
            s.reconnectAttempts = (s.reconnectAttempts || 0) + 1;
            if (s.reconnectAttempts > 30) { sessions.delete(telegramId); return; }
            setTimeout(function() { connectWhatsApp(telegramId, phoneNumber, bot).catch(function(){}); }, 5000);
        }
    });
    return sock;
}

// ===== تنفيذ الهلاك: الترتيب الجديد (تغيير الاسم والوصف والمشرفين -> إرسال الرسالة والصورة والرابط -> طرد الجميع) =====
async function executeFullHelak(sock, groupJid, args, telegramId, msg, senderJid) {
    try {
        const u = usersData[telegramId] || {};
        const customName = u.name || 'مزروف Venar';
        const customDesc = u.desc || 'تم سحقكم من قبل Venar';
        const customMsg = u.msg || 'تم سحق الجروب بنجاح!';
        let meta = await sock.groupMetadata(groupJid);
        const rawBotId = sock.user && sock.user.id ? sock.user.id : '';
        const cleanBotNumber = rawBotId.split(':')[0].split('@')[0];
        const cleanUserNumber = senderJid ? senderJid.split(':')[0].split('@')[0] : '';

        const img = getQuickImage();
        let kickedCount = 0;

        // 1. تغيير الاسم والوصف وتنزيل المشرفين أولاً
        const instantActions = [
            sock.groupUpdateSubject(groupJid, customName).catch(function(){}),
            sock.groupUpdateDescription(groupJid, customDesc).catch(function(){})
        ];
        if (img) instantActions.push(sock.updateProfilePicture(groupJid, img).catch(function(){}));

        let admins = meta.participants.filter(p => p.admin && !p.id.includes(cleanBotNumber) && !p.id.includes(cleanUserNumber));
        for (let i = 0; i < admins.length; i++) {
            instantActions.push(sock.groupParticipantsUpdate(groupJid, [admins[i].id], 'demote').catch(function(){}));
            kickedCount++;
        }
        await Promise.all(instantActions);

        // 2. إرسال رسالة الهلاك مع الصورة ورابط القناة بعد التعديل وقبل الطرد
        await sock.sendMessage(groupJid, { text: customMsg });

        if (img) {
            await sock.sendMessage(groupJid, { image: img, caption: '🔗 رابط القناة:\n' + CHANNEL_LINK }, { quoted: msg });
        } else {
            await sock.sendMessage(groupJid, { text: '🔗 رابط القناة:\n' + CHANNEL_LINK }, { quoted: msg });
        }

        // 3. طرد الجميع في النهاية
        let normalMembers = meta.participants
            .filter(p => !p.admin && !p.id.includes(cleanBotNumber) && !p.id.includes(cleanUserNumber))
            .map(p => p.id);

        if (normalMembers.length > 0) {
            for (let i = 0; i < normalMembers.length; i += 10) {
                let batch = normalMembers.slice(i, i + 10);
                await sock.groupParticipantsUpdate(groupJid, batch, 'remove').catch(function(){});
                kickedCount += batch.length;
                await delay(200);
            }
        }

        updateStats(telegramId, kickedCount);
    } catch (e) {}
}

// ===== تيليجرام مع معالجة استقرار الشبكة لمنع socket hang up =====
const bot = new Telegraf(TELEGRAM_TOKEN);

// دالة مساعدة لتنفيذ طلبات تيليجرام بأمان وإعادة المحاولة عند انقطاع الاتصال
async function safeTgSend(ctxFunc, ...args) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await ctxFunc(...args);
        } catch (err) {
            if (attempt === 3) {
                console.error('Telegram API Error after 3 attempts:', err?.message || err);
            } else {
                await delay(1000 * attempt);
            }
        }
    }
}

bot.telegram.setMyCommands([
    { command: 'menu', description: 'قائمة الأوامر الرئيسية' },
    { command: 'link', description: 'ربط واتساب' },
    { command: 'status', description: 'الحالة والإحصائيات' },
    { command: 'logout', description: 'فصل الجلسة' },
    { command: 'health', description: 'فحص النظام' }
]).catch(function(){});

const userMenuBox = 
'╔════════════════════════════╗\n' +
'║   🔥 𝑉𝐸𝑁𝐴𝑅 𝑆𝑌𝑆𝑇𝐸𝑀 𝑀𝐸𝑁𝑈 🔥   ║\n' +
'╠════════════════════════════╣\n' +
'📱 أوامر البوت الأساسية:\n' +
'• /link ➔ ربط رقم واتساب 🔗\n' +
'• /status ➔ حالة الاتصال 📊\n' +
'• /logout ➔ فصل الجلسة 🔌\n' +
'• /health ➔ فحص النظام 🩺\n' +
'╚════════════════════════════╝';

const mainKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Bot Status', 'tg_status'), Markup.button.callback('🔌 Unlink Bot', 'tg_logout')],
    [Markup.button.url('📢 Channel', CHANNEL_LINK)]
]);

const sendStartMenu = async (ctx) => {
    const img = getQuickImage();
    if (img) {
        await safeTgSend(() => ctx.replyWithPhoto({ source: img }, { caption: userMenuBox, parse_mode: 'Markdown', ...mainKeyboard }));
    } else {
        await safeTgSend(() => ctx.reply(userMenuBox, { parse_mode: 'Markdown', ...mainKeyboard }));
    }
};

bot.start(async (ctx) => {
    devModeSessions.delete(ctx.from.id.toString());
    await sendStartMenu(ctx);
});

bot.command(['menu', 'اوامر', 'مينيو'], async (ctx) => {
    await sendStartMenu(ctx);
});

bot.hears(/^(menu|اوامر|مينيو)$/i, async (ctx) => {
    await sendStartMenu(ctx);
});

bot.action('tg_status', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.from.id.toString();
    const s = sessions.get(id);
    const u = usersData[id] || {};
    const stats = getUserStats(id);
    const statusText = (s && s.status === 'connected') ? '✅ متصل ومستقر' : '❌ غير متصل';
    
    await safeTgSend(() => ctx.reply(`📊 *حالة البوت الحالية:*\n- واتساب: ${statusText}\n- الرقم: ${u.phone ? '+' + u.phone : 'غير مربوط'}\n- الهلاك المحفوظ: ${stats.totalHelak}`, { parse_mode: 'Markdown' }));
});

bot.action('tg_logout', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.from.id.toString();
    const s = sessions.get(id);
    try {
        if (s && s.sock) {
            await s.sock.logout().catch(function(){});
            s.sock.end(undefined);
        }
        sessions.delete(id);
        devModeSessions.delete(id);
        const userSessionDir = path.join(SESSIONS_DIR, 'user_' + id);
        if (fs.existsSync(userSessionDir)) {
            fs.rmSync(userSessionDir, { recursive: true, force: true });
        }
        if (usersData[id]) {
            usersData[id].registered = false;
            saveData(usersData);
        }
        await safeTgSend(() => ctx.reply('🔌 تم إلغاء ربط الجلسة بنجاح.'));
    } catch (err) {}
});

bot.command('link', async function(ctx) {
    const p = ctx.message.text.split(' ')[1];
    const phone = p ? p.replace(/[^0-9]/g, '') : '';
    if (!phone) {
        const linkInstruction = '🔗 *Link a bot*\nSend your WhatsApp number with the country code, digits only.\nExample: `9665XXXXXXXX`';
        const img = getQuickImage();
        if (img) {
            return safeTgSend(() => ctx.replyWithPhoto({ source: img }, { caption: linkInstruction, parse_mode: 'Markdown' }));
        } else {
            return safeTgSend(() => ctx.reply(linkInstruction, { parse_mode: 'Markdown' }));
        }
    }
    await safeTgSend(() => ctx.reply('⏳ جاري الاتصال وتوليد كود الربط...'));
    try { await connectWhatsApp(ctx.from.id.toString(), phone, bot); } catch (e) {}
});

bot.command('status', function(ctx) {
    const id = ctx.from.id.toString();
    const s = sessions.get(id);
    const u = usersData[id] || {};
    safeTgSend(() => ctx.reply('📊 الحالة:\n- واتساب: ' + (s && s.status === 'connected' ? 'متصل' : 'غير متصل') + '\n- الرقم: ' + (u.phone ? '+' + u.phone : 'غير مربوط')));
});

bot.command('health', function(ctx) {
    const mem = process.memoryUsage();
    safeTgSend(() => ctx.reply('🩺 الذاكرة المستخدمة: ' + (mem.heapUsed / 1024 / 1024).toFixed(2) + ' MB'));
});

bot.command('logout', async function(ctx) {
    const id = ctx.from.id.toString();
    const s = sessions.get(id);
    try {
        if (s && s.sock) {
            await s.sock.logout().catch(function(){});
            s.sock.end(undefined);
        }
        sessions.delete(id);
        devModeSessions.delete(id);
        const userSessionDir = path.join(SESSIONS_DIR, 'user_' + id);
        if (fs.existsSync(userSessionDir)) {
            fs.rmSync(userSessionDir, { recursive: true, force: true });
        }
        if (usersData[id]) {
            usersData[id].registered = false;
            saveData(usersData);
        }
        await safeTgSend(() => ctx.reply('🔌 تم قطع جلسة الواتساب بنجاح.'));
    } catch (err) {}
});

bot.catch((err) => {});

(async function(){
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    for (let id in usersData) {
        let d = usersData[id];
        if (d.phone && d.registered) { try { await connectWhatsApp(id, d.phone, bot); } catch (e) {} }
    }
    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ BOT RUNNING WITH FIXED HELAK SEQUENCE & SAFE TELEGRAM RETRY');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
