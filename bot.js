const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const { getAudioBase64 } = require('google-tts');
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
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
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
    sender
