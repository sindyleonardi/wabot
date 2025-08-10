const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const googleTTS = require('google-tts-api');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// --- Konfigurasi API ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const HF_API_KEY = process.env.HF_API_KEY;
const OPENROUTER_MODEL = "z-ai/glm-4.5-air:free";
const HF_IMAGE_MODEL = "stabilityai/stable-diffusion-xl-base-1.0";

// --- Penyimpanan data keuangan ---
const DATA_FILE = path.join(__dirname, 'keuangan.json');

async function bacaDataKeuangan() {
  try {
    const rawData = await fs.readFile(DATA_FILE, 'utf8');
    const data = JSON.parse(rawData);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      console.warn("⚠️ Data keuangan bukan objek, reset ke {}");
      return {};
    }
    return data;
  } catch (e) {
    console.error("❌ Gagal baca file keuangan:", e.message);
    return {};
  }
}

async function simpanDataKeuangan(data) {
  try {
    console.log("🔧 Menyimpan data keuangan...");
    console.log("📊 Data yang akan disimpan:", data);
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log("✅ Data berhasil disimpan ke:", DATA_FILE);
  } catch (err) {
    console.error("❌ GAGAL menyimpan data keuangan!");
    console.error("📁 Path file:", DATA_FILE);
    console.error("⚡ Error:", err.message);
  }
}

// --- Inisialisasi Client WhatsApp ---
const client = new Client({
  authStrategy: new LocalAuth()
});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp SuperBot siap!');
});

// --- Mode Percakapan ---
const userConversationMode = new Map();
const CONVERSATION_TIMEOUT_MS = 5 * 60 * 1000;

// --- Fungsi Cuaca ---
async function getCuaca(queryKota) {
  try {
    const geoURL = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(queryKota)}&count=1`;
    const geoRes = await fetch(geoURL);
    if (!geoRes.ok) return `Gagal mencari lokasi kota "${queryKota}". Coba nama kota lain.`;
    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) return `Kota "${queryKota}" tidak ditemukan.`;

    const { latitude, longitude, name } = geoData.results[0];
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&hourly=precipitation&timezone=auto`;
    const weatherRes = await fetch(weatherUrl);
    if (!weatherRes.ok) return `Gagal mendapatkan data cuaca dari API. (Status: ${weatherRes.status})`;
    const weatherData = await weatherRes.json();
    if (!weatherData || !weatherData.current) return "Data cuaca tidak lengkap. Coba lagi nanti.";

    const getWeatherCondition = (code) => {
      const conditions = {
        0: 'Cerah', 1: 'Sebagian berawan', 2: 'Berawan', 3: 'Mendung', 45: 'Kabut',
        48: 'Kabut es', 51: 'Gerimis ringan', 53: 'Gerimis sedang', 55: 'Gerimis lebat',
        56: 'Gerimis dingin ringan', 57: 'Gerimis dingin lebat', 61: 'Hujan ringan',
        63: 'Hujan sedang', 65: 'Hujan lebat', 66: 'Hujan dingin ringan',
        67: 'Hujan dingin lebat', 71: 'Salju ringan', 73: 'Salju sedang',
        75: 'Salju lebat', 77: 'Butiran salju', 80: 'Hujan sebentar ringan',
        81: 'Hujan sebentar sedang', 82: 'Hujan sebentar lebat', 85: 'Hujan salju ringan',
        86: 'Hujan salju lebat', 95: 'Badai petir', 96: 'Badai petir dengan hujan es ringan',
        99: 'Badai petir dengan hujan es lebat'
      };
      return conditions[code] || 'Tidak diketahui';
    };

    const current = weatherData.current;
    const weatherCode = current.weather_code;
    const precipitation = current.precipitation > 0;
    const willRainSoon = weatherData.hourly?.precipitation?.slice(0, 3).some(p => p > 0);

    let replyText = `*Cuaca di ${name} saat ini:*\n` +
                    `- Suhu: ${current.temperature_2m}°C\n` +
                    `- Kelembapan: ${current.relative_humidity_2m}%\n` +
                    `- Kondisi: ${getWeatherCondition(weatherCode)}\n` +
                    `- Kecepatan angin: ${current.wind_speed_10m} km/jam\n`;

    if (precipitation) replyText += '- Sedang turun hujan.\n';
    if (willRainSoon) replyText += '- Diperkirakan akan hujan dalam 3 jam ke depan.\n';
    else replyText += '- Tidak ada perkiraan hujan dalam 3 jam ke depan.\n';

    return replyText;
  } catch (e) {
    console.error("DEBUG WEATHER ERROR:", e);
    return "Maaf, terjadi kesalahan saat menghubungi server cuaca.";
  }
}

// --- Event Handler Utama ---
client.on('message', async msg => {
  const body = msg.body.trim();
  const chatId = msg.from;
  let currentMode = userConversationMode.get(chatId);

  // Cek timeout mode percakapan
  if (currentMode && (Date.now() - currentMode.lastActivity > CONVERSATION_TIMEOUT_MS)) {
    userConversationMode.delete(chatId);
    currentMode = undefined;
    msg.reply('Mode percakapan sebelumnya telah berakhir karena tidak ada aktivitas.');
  }

  // Dapatkan nama pengguna
  let senderName = 'Anda';
  try {
    const contact = await msg.getContact();
    senderName = contact.pushname || contact.name || contact.number;
  } catch (e) {
    console.error("Gagal mendapatkan nama kontak:", e);
  }

  // --- #exit untuk keluar dari mode ---
  if (body.toLowerCase() === '#exit') {
    if (currentMode) {
      userConversationMode.delete(chatId);
      return msg.reply(`Baik, ${senderName}. Anda telah keluar dari mode ${currentMode.mode.toUpperCase()}.`);
    } else {
      return msg.reply(`Halo ${senderName}, Anda tidak sedang dalam mode percakapan.`);
    }
  }

  // --- #help ---
  if (body.toLowerCase() === '#help') {
    userConversationMode.delete(chatId);
    return msg.reply(
      `*WhatsApp SuperBot Menu*\n` +
      `Halo ${senderName}!\n` +
      `*#help* — Menampilkan menu bantuan ini\n` +
      `*#gpt <prompt>* — Tanya AI apa saja (OpenRouter). Ketik *#gpt* saja untuk masuk mode percakapan AI.\n` +
      `*#img <prompt>* — Gambar AI dari teks (Stable Diffusion XL). Ketik *#img* saja untuk masuk mode gambar AI.\n` +
      `*#cuaca <nama_kota>* — Info cuaca terkini (contoh: #cuaca batu)\n` +
      `*Kirim foto* — Akan diubah jadi stiker otomatis\n` +
      `*#vn <kode_bahasa> <teks>* — Voice note TTS multi-bahasa (contoh: #vn en hello world)\n` +
      `*#save <tgl-bln-thn> <jumlah>* — Simpan catatan pendapatan (contoh: #save 1-5-2025 3430000)\n` +
      `*#hasil bulan <nomor>* — Lihat semua catatan & total pendapatan di bulan tertentu\n` +
      `*#del bulan <nomor>* — Hapus semua catatan di bulan tertentu\n` +
      `*#del <tgl-bln-thn>* — Hapus semua catatan pada tanggal tertentu (contoh: #del 3-8-2025)\n` +
      `*#exit* — Keluar dari mode percakapan AI/Gambar.\n` +
      `*Kode bahasa:* id (indonesia), en (english), ja (jepang), ar (arab), es (spanyol), dll.`
    );
  }

  // === Hapus Catatan Keuangan: #del bulan 5 atau #del 3-8-2025
  if (body.toLowerCase().startsWith('#del')) {
    userConversationMode.delete(chatId);
    const args = body.slice(4).trim().split(' ');
    if (args.length === 0) {
      return msg.reply(`Gunakan:\n- #del bulan <nomor> → hapus semua catatan di bulan\n- #del <tgl-bln-thn> → hapus catatan di tanggal tertentu\nContoh: #del 1-5-2025`);
    }

    try {
      const data = await bacaDataKeuangan();
      const tahunSekarang = new Date().getFullYear();

      // --- Hapus per bulan: #del bulan 5
      if (args[0] === 'bulan' && args[1]) {
        const bulanInput = parseInt(args[1]);
        if (isNaN(bulanInput) || bulanInput < 1 || bulanInput > 12) {
          return msg.reply(`Bulan harus angka 1–12, ${senderName}.`);
        }
        const key = `${tahunSekarang}-${String(bulanInput).padStart(2, '0')}`;

        if (!data[key] || data[key].length === 0) {
          return msg.reply(`Tidak ada catatan di bulan ${bulanInput} ${tahunSekarang} untuk dihapus.`);
        }

        const jumlahHapus = data[key].length;
        delete data[key];
        await simpanDataKeuangan(data);

        return msg.reply(`✅ Berhasil menghapus ${jumlahHapus} catatan dari bulan ${bulanInput} ${tahunSekarang}.`);
      }

      // --- Hapus per tanggal: #del 3-8-2025
      const tanggalStr = args.join(' ');
      const [hari, bulan, tahun] = tanggalStr.split('-').map(Number);
      const inputTahun = tahun || tahunSekarang;

      if (!hari || !bulan || isNaN(hari) || isNaN(bulan)) {
        return msg.reply(`Format tanggal salah. Gunakan: #del 3-8-2025 atau #del 03-08-2025`);
      }

      const key = `${inputTahun}-${String(bulan).padStart(2, '0')}`;
      if (!data[key]) {
        return msg.reply(`Tidak ada catatan pada tanggal ${hari}-${bulan}-${inputTahun}.`);
      }

      const jumlahAwal = data[key].length;
      data[key] = data[key].filter(item => {
        const [h, b, t] = item.tanggal.split('-').map(Number);
        return !(h === hari && b === bulan && t === inputTahun);
      });

      const jumlahHapus = jumlahAwal - data[key].length;

      if (jumlahHapus === 0) {
        return msg.reply(`Tidak ada catatan pada tanggal ${hari}-${bulan}-${inputTahun} yang ditemukan.`);
      }

      if (data[key].length === 0) {
        delete data[key];
      }

      await simpanDataKeuangan(data);
      msg.reply(`✅ Berhasil menghapus ${jumlahHapus} catatan dari tanggal ${hari}-${bulan}-${inputTahun}`);
    } catch (e) {
      console.error("Gagal hapus data keuangan:", e);
      msg.reply("Maaf, terjadi kesalahan saat menghapus data.");
    }
    return;
  }

  // === Pencatatan Keuangan: #save <tanggal> <jumlah>
  if (body.toLowerCase().startsWith('#save')) {
    userConversationMode.delete(chatId);
    const args = body.slice(5).trim().split(' ');
    if (args.length !== 2) {
      return msg.reply(`Format salah, ${senderName}. Gunakan: #save <tgl-bln-thn> <jumlah>\nContoh: #save 1-5-2025 3430000`);
    }

    const [tanggalStr, jumlahStr] = args;
    const jumlah = parseInt(jumlahStr.replace(/\D/g, ''));

    if (isNaN(jumlah) || jumlah <= 0) {
      return msg.reply(`Jumlah harus angka positif, ${senderName}.`);
    }

    const [hari, bulan, tahun] = tanggalStr.split('-').map(Number);
    if (!hari || !bulan || !tahun || isNaN(hari) || isNaN(bulan) || isNaN(tahun)) {
      return msg.reply(`Format tanggal salah. Gunakan: 1-5-2025 (hari-bulan-tahun)`);
    }

    const date = new Date(tahun, bulan - 1, hari);
    if (date.getDate() !== hari || date.getMonth() !== bulan - 1 || date.getFullYear() !== tahun) {
      return msg.reply(`Tanggal tidak valid, ${senderName}.`);
    }

    const key = `${tahun}-${String(bulan).padStart(2, '0')}`;
    const entry = { tanggal: `${hari}-${bulan}-${tahun}`, jumlah, timestamp: Date.now() };

    try {
      const data = await bacaDataKeuangan();
      if (!data[key]) data[key] = [];
      data[key].push(entry);
      await simpanDataKeuangan(data);
      msg.reply(`✅ Catatan disimpan:\nTanggal: ${hari}-${bulan}-${tahun}\nJumlah: Rp ${jumlah.toLocaleString()}`);
    } catch (e) {
      console.error("Gagal simpan data keuangan:", e);
      msg.reply("Maaf, terjadi kesalahan saat menyimpan data.");
    }
    return;
  }

  // === Lihat Hasil: #hasil bulan <bulan>
  if (body.toLowerCase().startsWith('#hasil')) {
    userConversationMode.delete(chatId);
    const args = body.slice(6).trim().split(' ');
    if (args.length < 2 || args[0] !== 'bulan') {
      return msg.reply(`Gunakan: #hasil bulan <nomor_bulan>\nContoh: #hasil bulan 5`);
    }

    const bulanInput = parseInt(args[1]);
    if (isNaN(bulanInput) || bulanInput < 1 || bulanInput > 12) {
      return msg.reply(`Bulan harus angka 1–12, ${senderName}.`);
    }

    const tahun = new Date().getFullYear();
    const key = `${tahun}-${String(bulanInput).padStart(2, '0')}`;
    const namaBulan = [
      'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
      'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
    ][bulanInput - 1];

    try {
      const data = await bacaDataKeuangan();
      const records = data[key] || [];

      if (records.length === 0) {
        return msg.reply(`Tidak ada catatan keuangan untuk bulan ${namaBulan} ${tahun}.`);
      }

      records.sort((a, b) => new Date(a.tanggal.split('-').reverse().join('-')) - new Date(b.tanggal.split('-').reverse().join('-')));

      let reply = `📊 *Laporan Keuangan - ${namaBulan} ${tahun}* 📊\n\n`;
      let total = 0;

      records.forEach((item, index) => {
        total += item.jumlah;
        reply += `(${index + 1}) ${item.tanggal} → Rp ${item.jumlah.toLocaleString()}\n`;
      });

      reply += `\n*Total Pendapatan:* Rp ${total.toLocaleString()}`;
      await msg.reply(reply);
    } catch (e) {
      console.error("Gagal baca data keuangan:", e);
      msg.reply("Maaf, terjadi kesalahan saat membaca data.");
    }
    return;
  }

  // === AI Chat Handler (#gpt ...)
  if (body.toLowerCase().startsWith('#gpt') || (currentMode && currentMode.mode === 'gpt')) {
    let prompt = body.toLowerCase().startsWith('#gpt') ? body.slice(4).trim() : body;
    if (!prompt && !currentMode) {
      userConversationMode.set(chatId, { mode: 'gpt', lastActivity: Date.now() });
      return msg.reply(`Halo ${senderName}, Anda telah masuk mode percakapan AI. Silakan ketik pertanyaan Anda. Ketik *#exit* untuk keluar.`);
    } else if (!prompt && currentMode && currentMode.mode === 'gpt') {
      return msg.reply(`Silakan ketik pertanyaan Anda, ${senderName}.`);
    }
    userConversationMode.set(chatId, { mode: 'gpt', lastActivity: Date.now() });
    try {
      msg.reply('_Memproses jawaban AI..._');
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://yourdomain.com/'
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2048
        })
      });
      const data = await response.json();
      if (data.choices && data.choices[0]?.message?.content) {
        msg.reply(data.choices[0].message.content);
      } else if (data.error) {
        msg.reply("Error OpenRouter: " + data.error.message);
        console.log("OpenRouter raw response:", data);
      } else {
        msg.reply("Maaf, tidak ada respon dari model OpenRouter.");
        console.log("OpenRouter raw response:", data);
      }
    } catch (e) {
      console.log("DEBUG OPENROUTER ERROR:", e);
      msg.reply("Maaf, error OpenRouter API: " + (e.message || 'Unknown error.'));
    }
    return;
  }

  // === Text to Image AI (#img ...)
  if (body.toLowerCase().startsWith('#img') || (currentMode && currentMode.mode === 'img')) {
    let prompt = body.toLowerCase().startsWith('#img') ? body.slice(4).trim() : body;
    if (!prompt && !currentMode) {
      userConversationMode.set(chatId, { mode: 'img', lastActivity: Date.now() });
      return msg.reply(`Halo ${senderName}, Anda telah masuk mode pembuatan gambar AI. Silakan ketik deskripsi gambar yang Anda inginkan. Ketik *#exit* untuk keluar.`);
    } else if (!prompt && currentMode && currentMode.mode === 'img') {
      return msg.reply(`Silakan ketik deskripsi gambar Anda, ${senderName}.`);
    }
    userConversationMode.set(chatId, { mode: 'img', lastActivity: Date.now() });
    try {
      msg.reply('_Sedang membuat gambar AI..._');
      const hfResp = await fetch(`https://api-inference.huggingface.co/models/${HF_IMAGE_MODEL}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HF_API_KEY}`,
        },
        body: JSON.stringify({ inputs: prompt })
      });
      const contentType = hfResp.headers.get('content-type');
      if (hfResp.ok && (contentType === 'image/png' || contentType === 'image/jpeg')) {
        const buffer = await hfResp.buffer();
        const media = new MessageMedia(contentType, buffer.toString('base64'), 'ai.png');
        await msg.reply(media);
      } else {
        msg.reply("Gagal membuat gambar AI (model limit/maintenance).");
        try {
          const errText = await hfResp.text();
          console.log("HF error text:", errText);
        } catch (e) {}
      }
    } catch (e) {
      msg.reply("Gagal membuat gambar AI.");
      console.log(e);
    }
    return;
  }

  // === Cuaca Handler (#cuaca ...)
  if (body.toLowerCase().startsWith('#cuaca')) {
    userConversationMode.delete(chatId);
    let input = body.slice(6).trim().toLowerCase();
    const wordsToRemove = ['kota', 'hari ini', 'sekarang', 'kedepan', 'untuk', 'apakah', 'hujan', 'besok'];
    wordsToRemove.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'g');
      input = input.replace(regex, '');
    });
    input = input.replace(/[?.,!]+$/, '').trim();
    const cleanedCityName = input.trim();
    if (!cleanedCityName) {
      return msg.reply(`Format salah, ${senderName}. Contoh: #cuaca malang`);
    }
    msg.reply(`_Mencari data cuaca untuk ${cleanedCityName}..._`);
    const weatherInfo = await getCuaca(cleanedCityName);
    await msg.reply(weatherInfo);
    return;
  }

  // === Foto → Stiker
  if (msg.hasMedia && msg.type === 'image') {
    userConversationMode.delete(chatId);
    try {
      const media = await msg.downloadMedia();
      await msg.reply(`Ini stiker Anda, ${senderName}!`);
      await msg.reply(media, undefined, { sendMediaAsSticker: true });
    } catch (e) {
      msg.reply("Gagal mengubah foto jadi stiker.");
    }
    return;
  }

  // === Voice Note (#vn ...)
  if (body.toLowerCase().startsWith('#vn')) {
    userConversationMode.delete(chatId);
    let vnBody = body.slice(3).trim();
    const spaceIndex = vnBody.indexOf(' ');
    if (spaceIndex === -1) {
      return msg.reply(`Format salah, ${senderName}. Contoh: #vn id selamat pagi dunia`);
    }
    const lang = vnBody.slice(0, spaceIndex).toLowerCase();
    const text = vnBody.slice(spaceIndex + 1).trim();
    if (!text) return msg.reply(`Tulis kalimat setelah kode bahasa, ${senderName}. Contoh: #vn en hello world`);
    try {
      msg.reply(`_Membuat voice (${lang})..._`);
      const url = googleTTS.getAudioUrl(text, { lang, slow: false, host: 'https://translate.google.com' });
      const audioRes = await fetch(url);
      const audioBuffer = await audioRes.buffer();
      const media = new MessageMedia('audio/mpeg', audioBuffer.toString('base64'), 'voice.mp3');
      await msg.reply(media, undefined, { sendAudioAsVoice: true });
    } catch (e) {
      msg.reply("Gagal membuat voice note.");
      console.log(e);
    }
    return;
  }

  // Default: tidak ada perintah dikenali
  if (!currentMode) {
    // Opsional: aktifkan jika ingin respon default
    // msg.reply(`Maaf ${senderName}, saya tidak mengerti. Ketik *#help* untuk bantuan.`);
  }
});

client.initialize();
