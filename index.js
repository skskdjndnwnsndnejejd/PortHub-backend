// index.js
// Node.js + Express server for PortHub marketplace
// Ready to deploy to Render. Uses Supabase as DB and Telegram Bot API.
// Env vars required: BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, LOG_CHANNEL_ID, OWNER_TG_ID

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // e.g. -1001234567890
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

// ---------- Utilities ----------
function parseNftLink(link) {
  // expecting https://t.me/nft/DeskCalendar-1234 (or without https)
  try {
    const match = link.match(/t\.me\/nft\/([A-Za-z0-9_\-]+)-(\d+)/i);
    if (!match) return null;
    const nameSlug = match[1];
    const num = match[2];
    // reconstruct readable name: try splitting camel case or underscores - fallback to slug
    const readable = nameSlug.replace(/[_\-]+/g, " ");
    return { nameSlug, num, readable, link: `https://t.me/nft/${nameSlug}-${num}` };
  } catch (e) {
    return null;
  }
}

async function ensureUser(tg_id, username = null) {
  if (!tg_id) return null;
  // Upsert into users table: use tg_id as unique identifier
  const { data, error } = await supabase
    .from("users")
    .upsert({ tg_id: Number(tg_id), username: username || null }, { onConflict: "tg_id" })
    .select("*")
    .limit(1);
  if (error) {
    console.error("ensureUser error:", error);
    throw error;
  }
  return data && data[0] ? data[0] : null;
}

async function getFileUrlByFileId(file_id) {
  // getFile -> file_path -> construct file url
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
// Set Telegram webhook to https://<your-domain>/webhook
app.post("/webhook", async (req, res) => {
  // Telegram update
  const update = req.body;

  try {
    // handle only message updates (we rely on manager receiving gifts as messages)
    if (update.message) {
      const msg = update.message;
      const from = msg.from;
      const text = msg.text || msg.caption || "";
      const chatId = msg.chat && msg.chat.id;

      // If message was sent to manager (OWNER_TG_ID) and contains nft link => process gift
      // Note: manager may receive messages in private chat (chat.id == OWNER_TG_ID)
      if (String(chatId) === String(OWNER_TG_ID)) {
        // find nft link in text
        const linkMatch = text && text.match(/t\.me\/nft\/[A-Za-z0-9_\-]+-\d+/i);
        if (linkMatch) {
          const link = linkMatch[0].startsWith("http") ? linkMatch[0] : `https://${linkMatch[0]}`;
          const parsed = parseNftLink(link);
          if (parsed) {
            // If the message contains photo(s), take the largest photo file_id
            let imageUrl = null;
            if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
              // photos sorted by size, last one is biggest
              const biggest = msg.photo[msg.photo.length - 1];
              try {
                imageUrl = await getFileUrlByFileId(biggest.file_id);
              } catch (e) {
                console.warn("Can't fetch file from Telegram:", e?.message || e);
              }
            } else if (msg.document && msg.document.file_id) {
              // sometimes previews can be in document
              try {
                imageUrl = await getFileUrlByFileId(msg.document.file_id);
              } catch (e) {
                console.warn("Can't fetch document file:", e?.message || e);
              }
            }

            // Who gifted? we assume original owner is msg.forward_from or provided in text.
            // But user described: gifted by user 1234567 to manager. Often the message will contain sender info.
            const giftFrom = msg.forward_from ? msg.forward_from.id : (from ? from.id : null);
            const giftFromUsername = msg.forward_from ? msg.forward_from.username : from ? from.username : null;

            // Ensure user record exists for original owner
            if (giftFrom) {
              await ensureUser(giftFrom, giftFromUsername);
            }

            // Save gift in gifts table with user_id = giftFrom (original owner)
            const insertObj = {
              user_id: giftFrom || null,
              nft_name: parsed.readable || `${parsed.nameSlug}-${parsed.num}`,
              nft_link: parsed.link,
              nft_image: imageUrl || null,
              is_market: false,
              price: null
            };

            const { data: giftData, error: giftErr } = await supabase.from("gifts").insert(insertObj).select("*").limit(1);
            if (giftErr) {
              console.error("DB error inserting gift:", giftErr);
            } else {
              console.log("Inserted gift:", giftData[0]);
            }
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

// ---------- API endpoints for WebApp / Admin usage ----------

// 1) Issue balance (Admin function) - only OWNER_TG_ID allowed
// POST /issue_balance { issuer_tg_id, target_tg_id, amount }
app.post("/issue_balance", async (req, res) => {
  try {
    const { issuer_tg_id, target_tg_id, amount } = req.body;
    if (!issuer_tg_id || String(issuer_tg_id) !== String(OWNER_TG_ID)) {
      return res.status(403).json({ error: "Only owner can issue balance" });
    }
    if (!target_tg_id || typeof amount === "undefined") {
      return res.status(400).json({ error: "target_tg_id and amount required" });
    }
    // ensure target user exists
    await ensureUser(target_tg_id);
    // upsert balance
    const { data, error } = await supabase
      .from("balances")
      .upsert({ user_id: Number(target_tg_id), balance: Number(amount) }, { onConflict: "user_id" })
      .select("*")
      .limit(1);
    if (error) {
      console.error("issue_balance error:", error);
      return res.status(500).json({ error: "DB error" });
    }
    return res.json({ success: true, balance: data[0] });
  } catch (e) {
    console.error("issue_balance exception:", e);
    return res.status(500).json({ error: "internal" });
  }
});

// 2) Create lot (seller creates lot from their gift or custom item)
// POST /create_lot { tg_id, gift_id (optional), type: 'nft'|'custom', title, image_url, price }
app.post("/create_lot", async (req, res) => {
  try {
    const { tg_id, gift_id, type, title, image_url, price } = req.body;
    if (!tg_id) return res.status(400).json({ error: "tg_id required" });
    const seller = await ensureUser(tg_id);

    if (type === "nft") {
      if (!gift_id) return res.status(400).json({ error: "gift_id required for nft type" });
      // verify ownership
      const { data: gdata, error: gerr } = await supabase.from("gifts").select("*").eq("id", gift_id).limit(1);
      if (gerr) return res.status(500).json({ error: "DB error" });
      if (!gdata || gdata.length === 0) return res.status(404).json({ error: "gift not found" });
      const gift = gdata[0];
      if (String(gift.user_id) !== String(tg_id)) return res.status(403).json({ error: "not owner of gift" });

      // update gift: is_market true and set price
      const { data: udata, error: uerr } = await supabase.from("gifts").update({ is_market: true, price: Number(price) }).eq("id", gift_id).select("*").limit(1);
      if (uerr) return res.status(500).json({ error: "DB update error" });

      // optionally create a lots entry (not required if marketplace reads gifts where is_market=true)
      const { data: lot, error: lotErr } = await supabase.from("lots").insert({ gift_id: gift_id, seller_id: Number(tg_id), price: Number(price) }).select("*").limit(1);
      if (lotErr) console.warn("lot insert warning:", lotErr);

      return res.json({ success: true, gift: udata[0] });
    } else {
      // custom item case: create a gift for this user and immediately put on market
      const insertObj = {
        user_id: Number(tg_id),
        nft_name: title || "Custom Item",
        nft_link: null,
        nft_image: image_url || null,
        is_market: true,
        price: Number(price)
      };
      const { data, error } = await supabase.from("gifts").insert(insertObj).select("*").limit(1);
      if (error) {
        console.error("create custom gift error:", error);
        return res.status(500).json({ error: "DB error" });
      }
      // create lot row
      const gift = data[0];
      await supabase.from("lots").insert({ gift_id: gift.id, seller_id: Number(tg_id), price: Number(price) });
      return res.json({ success: true, gift });
    }
  } catch (e) {
    console.error("create_lot exception:", e);
    return res.status(500).json({ error: "internal" });
  }
});

// 3) Purchase lot
// POST /purchase { buyer_tg_id, lot_id }
// The function debits buyer balance, credits seller, transfers ownership of gift, writes transaction, logs to channel.
app.post("/purchase", async (req, res) => {
  try {
    const { buyer_tg_id, lot_id } = req.body;
    if (!buyer_tg_id || !lot_id) return res.status(400).json({ error: "buyer_tg_id and lot_id required" });

    // get lot info
    const { data: lotData, error: lotErr } = await supabase.from("lots").select("*, gifts(*)").eq("id", lot_id).limit(1);
    if (lotErr) return res.status(500).json({ error: "DB error" });
    if (!lotData || lotData.length === 0) return res.status(404).json({ error: "lot not found" });
    const lot = lotData[0];
    const gift = lot.gifts;
    if (!gift) return res.status(500).json({ error: "linked gift missing" });

    const price = Number(lot.price);
    const seller_id = Number(lot.seller_id);
    const buyer_id = Number(buyer_tg_id);

    if (seller_id === buyer_id) return res.status(400).json({ error: "cannot buy your own item" });

    // fetch balances
    const { data: buyerBalData } = await supabase.from("balances").select("*").eq("user_id", buyer_id).limit(1);
    const buyerBal = buyerBalData && buyerBalData[0] ? Number(buyerBalData[0].balance) : 0;

    if (buyerBal < price) return res.status(400).json({ error: "insufficient balance" });

    // perform DB transaction pattern (simple sequential ops; consider Supabase transactional RPC for atomicity)
    // 1) debit buyer
    const newBuyerBalance = (buyerBal - price).toFixed(2);
    await supabase.from("balances").upsert({ user_id: buyer_id, balance: newBuyerBalance }, { onConflict: "user_id" });

    // 2) credit seller
    const { data: sellerBalData } = await supabase.from("balances").select("*").eq("user_id", seller_id).limit(1);
    const sellerBal = sellerBalData && sellerBalData[0] ? Number(sellerBalData[0].balance) : 0;
    const newSellerBalance = (sellerBal + price).toFixed(2);
    await supabase.from("balances").upsert({ user_id: seller_id, balance: newSellerBalance }, { onConflict: "user_id" });

    // 3) transfer gift ownership
    await supabase.from("gifts").update({ user_id: buyer_id, is_market: false, price: null }).eq("id", gift.id);

    // 4) remove lot (or mark sold)
    await supabase.from("lots").delete().eq("id", lot_id);

    // 5) create transaction record
    const txInsert = {
      deal_number: `#${gift.id}-${buyer_id}`,
      buyer_username: req.body.buyer_username || null,
      buyer_id: buyer_id,
      seller_id: seller_id,
      nft_link: gift.nft_link,
      nft_name: gift.nft_name,
      price: price
    };
    const { data: txData, error: txErr } = await supabase.from("transactions").insert(txInsert).select("*").limit(1);
    if (txErr) console.warn("transaction log insert error:", txErr);

    // 6) send log to telegram channel
    const buyerUser = await supabase.from("users").select("*").eq("tg_id", buyer_id).limit(1);
    const buyerUsername = (buyerUser.data && buyerUser.data[0] && buyerUser.data[0].username) || req.body
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
