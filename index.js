// index.js
// Node.js + Express server for PortHub marketplace
// Ready to deploy to Render. Uses Supabase as DB and Telegram Bot API.
// Env vars required: BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, LOG_CHANNEL_ID, OWNER_TG_ID

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const OWNER_TG_ID = process.env.OWNER_TG_ID || "6828395702";

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !LOG_CHANNEL_ID) {
  console.error("Missing required ENV vars. Set BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, LOG_CHANNEL_ID.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static("public")); // Статика: index.html, style.css, script.js

// ---------- Utilities ----------
function parseNftLink(link) {
  try {
    const match = link.match(/t\.me\/nft\/([A-Za-z0-9_\-]+)-(\d+)/i);
    if (!match) return null;
    const nameSlug = match[1];
    const num = match[2];
    const readable = nameSlug.replace(/[_\-]+/g, " ");
    return { nameSlug, num, readable, link: `https://t.me/nft/${nameSlug}-${num}` };
  } catch (e) {
    return null;
  }
}

async function ensureUser(tg_id, username = null) {
  if (!tg_id) return null;
  const { data, error } = await supabase
    .from("users")
    .upsert({ tg_id: Number(tg_id), username: username || null }, { onConflict: "tg_id" })
    .select("*")
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function getFileUrlByFileId(file_id) {
  const resp = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id } });
  if (!resp.data || !resp.data.ok) return null;
  const file_path = resp.data.result.file_path;
  if (!file_path) return null;
  return `${TELEGRAM_FILE_API}/${file_path}`;
}

async function sendLogToChannel(text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: LOG_CHANNEL_ID,
      text,
      parse_mode: "HTML"
    });
  } catch (e) {
    console.error("sendLogToChannel error:", e?.response?.data || e.message);
  }
}

// ---------- Telegram webhook handler ----------
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    if (update.message) {
      const msg = update.message;
      const from = msg.from;
      const text = msg.text || msg.caption || "";
      const chatId = msg.chat && msg.chat.id;

      if (String(chatId) === String(OWNER_TG_ID)) {
        const linkMatch = text && text.match(/t\.me\/nft\/[A-Za-z0-9_\-]+-\d+/i);
        if (linkMatch) {
          const link = linkMatch[0].startsWith("http") ? linkMatch[0] : `https://${linkMatch[0]}`;
          const parsed = parseNftLink(link);
          if (parsed) {
            let imageUrl = null;
            if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
              const biggest = msg.photo[msg.photo.length - 1];
              try { imageUrl = await getFileUrlByFileId(biggest.file_id); } catch {}
            } else if (msg.document && msg.document.file_id) {
              try { imageUrl = await getFileUrlByFileId(msg.document.file_id); } catch {}
            }

            const giftFrom = msg.forward_from ? msg.forward_from.id : (from ? from.id : null);
            const giftFromUsername = msg.forward_from ? msg.forward_from.username : from ? from.username : null;

            if (giftFrom) await ensureUser(giftFrom, giftFromUsername);

            const insertObj = {
              user_id: giftFrom || null,
              nft_name: parsed.readable || `${parsed.nameSlug}-${parsed.num}`,
              nft_link: parsed.link,
              nft_image: imageUrl || null,
              is_market: false,
              price: null
            };

            const { data: giftData, error: giftErr } = await supabase.from("gifts").insert(insertObj).select("*").limit(1);
            if (giftErr) console.error("DB error inserting gift:", giftErr);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("webhook handler error:", err);
    res.sendStatus(500);
  }
});

// ---------- API endpoints ----------

// Issue balance
app.post("/issue_balance", async (req, res) => {
  try {
    const { issuer_tg_id, target_tg_id, amount } = req.body;
    if (!issuer_tg_id || String(issuer_tg_id) !== String(OWNER_TG_ID)) return res.status(403).json({ error: "Only owner can issue balance" });
    if (!target_tg_id || typeof amount === "undefined") return res.status(400).json({ error: "target_tg_id and amount required" });

    await ensureUser(target_tg_id);

    const { data, error } = await supabase
      .from("balances")
      .upsert({ user_id: Number(target_tg_id), balance: Number(amount) }, { onConflict: "user_id" })
      .select("*")
      .limit(1);
    if (error) return res.status(500).json({ error: "DB error" });
    return res.json({ success: true, balance: data[0] });
  } catch (e) { return res.status(500).json({ error: "internal" }); }
});

// Create lot
app.post("/create_lot", async (req, res) => {
  try {
    const { tg_id, gift_id, type, title, image_url, price } = req.body;
    if (!tg_id) return res.status(400).json({ error: "tg_id required" });
    const seller = await ensureUser(tg_id);

    if (type === "nft") {
      if (!gift_id) return res.status(400).json({ error: "gift_id required for nft type" });
      const { data: gdata } = await supabase.from("gifts").select("*").eq("id", gift_id).limit(1);
      const gift = gdata[0];
      if (!gift || String(gift.user_id) !== String(tg_id)) return res.status(403).json({ error: "not owner of gift" });

      await supabase.from("gifts").update({ is_market: true, price: Number(price) }).eq("id", gift_id);

      await supabase.from("lots").insert({ gift_id: gift_id, seller_id: Number(tg_id), price: Number(price) });

      return res.json({ success: true, gift });
    } else {
      const insertObj = {
        user_id: Number(tg_id),
        nft_name: title || "Custom Item",
        nft_link: null,
        nft_image: image_url || null,
        is_market: true,
        price: Number(price)
      };
      const { data } = await supabase.from("gifts").insert(insertObj).select("*").limit(1);
      const gift = data[0];
      await supabase.from("lots").insert({ gift_id: gift.id, seller_id: Number(tg_id), price: Number(price) });
      return res.json({ success: true, gift });
    }
  } catch (e) { return res.status(500).json({ error: "internal" }); }
});

// Purchase lot
app.post("/purchase", async (req, res) => {
  try {
    const { buyer_tg_id, lot_id } = req.body;
    if (!buyer_tg_id || !lot_id) return res.status(400).json({ error: "buyer_tg_id and lot_id required" });

    const { data: lotData } = await supabase.from("lots").select("*, gifts(*)").eq("id", lot_id).limit(1);
    const lot = lotData[0];
    const gift = lot.gifts;
    const price = Number(lot.price);
    const seller_id = Number(lot.seller_id);
    const buyer_id = Number(buyer_tg_id);

    if (seller_id === buyer_id) return res.status(400).json({ error: "cannot buy your own item" });

    const { data: buyerBalData } = await supabase.from("balances").select("*").eq("user_id", buyer_id).limit(1);
    const buyerBal = buyerBalData && buyerBalData[0] ? Number(buyerBalData[0].balance) : 0;
    if (buyerBal < price) return res.status(400).json({ error: "insufficient balance" });

    const newBuyerBalance = (buyerBal - price).toFixed(2);
    await supabase.from("balances").upsert({ user_id: buyer_id, balance: newBuyerBalance }, { onConflict: "user_id" });

    const { data: sellerBalData } = await supabase.from("balances").select("*").eq("user_id", seller_id).limit(1);
    const sellerBal = sellerBalData && sellerBalData[0] ? Number(sellerBalData[0].balance) : 0;
    const newSellerBalance = (sellerBal + price).toFixed(2);
    await supabase.from("balances").upsert({ user_id: seller_id, balance: newSellerBalance }, { onConflict: "user_id" });

    await supabase.from("gifts").update({ user_id: buyer_id, is_market: false, price: null }).eq("id", gift.id);
    await supabase.from("lots").delete().eq("id", lot_id);

    const txInsert = {
      deal_number: `#${gift.id}-${buyer_id}`,
      buyer_username: req.body.buyer_username || null,
      buyer_id: buyer_id,
      seller_id: seller_id,
      nft_link: gift.nft_link,
      nft_name: gift.nft_name,
      price: price
    };
    await supabase.from("transactions").insert(txInsert).select("*").limit(1);

    const { data: buyerUserData } = await supabase.from("users").select("*").eq("tg_id", buyer_id).limit(1);
    const buyerUsername = (buyerUserData && buyerUserData[0] && buyerUserData[0].username) || req.body.buyer_username || null;

    await sendLogToChannel(`🛒 Покупка: ${gift.nft_name} от ${buyerUsername || buyer_id} за ${price} TON+`);

    return res.json({ success: true, gift });
  } catch (e) { 
    console.error("purchase exception:", e);
    return res.status(500).json({ error: "internal" }); 
  }
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
