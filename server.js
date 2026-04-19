require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

// --- SUPABASE SETUP ---
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Using Service Key so the bot bypasses RLS
const supabase = createClient(supabaseUrl, supabaseKey);
// ----------------------

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

app.get("/", (req, res) => { res.send("🚀 IG Bot Server Running"); });

// --- 1. WEBHOOK VERIFICATION ---
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- PRIVACY POLICY ROUTE (For Meta Approval) ---
app.get("/privacy", (req, res) => { 
  res.send(`
    <h1>Privacy Policy</h1>
    <p>This application is an Instagram Automation tool for businesses.</p>
    <p>1. We only collect the necessary data (Instagram Page IDs, Access Tokens) required to automate messaging on your behalf.</p>
    <p>2. We do not sell or share your data with third parties.</p>
    <p>3. You can request data deletion at any time by contacting the administrator.</p>
  `); 
});

// --- 2. WEBHOOK GATEKEEPER (WITH SNOOZE CHECK) ---
app.post('/webhook', async (req, res) => {
    let body = req.body;

    if (body.object === 'instagram') {
        for (let entry of body.entry) {
            let webhook_event = entry.messaging[0];
            let sender_id = webhook_event.sender.id;
            let page_id = webhook_event.recipient.id; // NEW: Get the Business's IG Page ID
            
            // Fetch user data scoped to this specific client
            let userData = await getUserData(sender_id, page_id);
            
            if (!userData) {
                console.log(`⚠️ Unregistered page messaged: ${page_id}`);
                continue; // Ignore messages to pages not in our profiles table
            }
            
            // CHECK IF BOT IS SNOOZED FOR THIS USER
            if (userData.bot_paused_until) {
                let unpauseTime = new Date(userData.bot_paused_until);
                let currentTime = new Date();
                
                if (currentTime < unpauseTime) {
                    console.log(`🤫 Bot is snoozed for ${sender_id}. Ignoring message.`);
                    continue; 
                }
            }
            
            // If not snoozed, pass to the brain
            await handleMessage(sender_id, webhook_event, userData);
        }
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// --- 3. THE BRAIN (STATE MACHINE) ---
async function handleMessage(sender_id, webhook_event, userData) {
    let currentState = userData.bot_state || 'IDLE';
    let tempData = userData.temp_order_data || {};
    let clientId = userData.client_id; // Extract the specific client ID

    let message_text = webhook_event.message ? webhook_event.message.text : null;
    let cancelBtn = [{ content_type: "text", title: "Cancel ❌", payload: "CANCEL_ORDER" }];

    // --- GLOBAL ESCAPE HATCH ---
    if (message_text && (message_text.toLowerCase() === 'cancel' || message_text.toLowerCase() === 'stop' || message_text.toLowerCase() === 'menu')) {
        await updateUserState(sender_id, clientId, 'IDLE', {});
        let quickReplies = [
            { content_type: "text", title: "Discount Code 🎟️", payload: "CHECK_CODE" },
            { content_type: "text", title: "Place an Order 📦", payload: "PLACE_ORDER" },
            { content_type: "text", title: "Talk to a Person 🙋‍♂️", payload: "TRIGGER_HUMAN_TAKEOVER" }
        ];
        return callSendAPI(sender_id, "Got it, I've cancelled that process. How else can I help you?", quickReplies);
    }

    // Check for Quick Reply button clicks
    if (webhook_event.message && webhook_event.message.quick_reply) {
        let payload = webhook_event.message.quick_reply.payload;
        
        if (payload === "PLACE_ORDER") {
            await updateUserState(sender_id, clientId, 'AWAITING_PRODUCT', tempData);
            return callSendAPI(sender_id, "Great! Please use the share icon below the Instagram post of the product you want to buy, or just paste the post link directly into this chat.", cancelBtn);
        }
        
        if (payload === "CANCEL_ORDER") {
            await updateUserState(sender_id, clientId, 'IDLE', {});
            let quickReplies = [
                { content_type: "text", title: "Place an Order 📦", payload: "PLACE_ORDER" },
                { content_type: "text", title: "Talk to a Person 🙋‍♂️", payload: "TRIGGER_HUMAN_TAKEOVER" }
            ];
            return callSendAPI(sender_id, "Order cancelled. What would you like to do instead?", quickReplies);
        }

        if (payload === "TRIGGER_HUMAN_TAKEOVER") {
            let wakeUpTime = new Date();
            wakeUpTime.setHours(wakeUpTime.getHours() + 5);
            
            await supabase
                .from('customers')
                .update({ bot_paused_until: wakeUpTime.toISOString(), bot_state: 'IDLE' })
                .eq('instagram_user_id', sender_id)
                .eq('client_id', clientId); // Scoped to client
                
            return callSendAPI(sender_id, "Got it! I've paused my automated replies. A human agent will jump in here shortly to help you out.");
        }
        
        if (payload === "CHECK_CODE") {
            return callSendAPI(sender_id, "Our current active promo code is SAVE20!");
        }
    }

    // Route conversation based on their current state
    switch (currentState) {
        case 'AWAITING_PRODUCT':
            let shortcode = null;

            if (message_text) {
                const textRegex = /\/(?:p|reels|reel|tv)\/([A-Za-z0-9_-]+)/i;
                const textMatch = message_text.match(textRegex);
                if (textMatch) shortcode = textMatch[1];
            }

            if (!shortcode && webhook_event.message && webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'share') {
                let sharedUrl = webhook_event.message.attachments[0].payload.url;
                if (sharedUrl.includes('lookaside.fbsbx.com')) {
                    return callSendAPI(sender_id, "Instagram hid the product link from me! 🕵️‍♂️ Could you do me a favor? Tap the 3 dots on the post, click 'Copy Link', and just paste it here for me.", cancelBtn);
                }
                let cleanUrl = sharedUrl.split('?')[0];
                const regex = /\/(?:p|reels|reel|tv)\/([A-Za-z0-9_-]+)/i;
                const match = cleanUrl.match(regex);
                if (match) shortcode = match[1];
            }

            if (shortcode) {
                let { data: product } = await supabase
                    .from('products')
                    .select('*')
                    .ilike('insta_post_url', `%${shortcode}%`)
                    .eq('client_id', clientId) // NEW: Only search this specific client's products!
                    .single();

                if (product) {
                    tempData.product_id = product.id;
                    tempData.product_name = product.product_name;
                    tempData.price = product.price;

                    await updateUserState(sender_id, clientId, 'AWAITING_NAME', tempData);
                    return callSendAPI(sender_id, `Ah, the ${product.product_name}! It is priced at ₹${product.price}. To start the order, what is your full name?`, cancelBtn);
                } else {
                    return callSendAPI(sender_id, "I couldn't find that exact product in our system. Are you sure that is the right post?", cancelBtn);
                }
            } else {
                return callSendAPI(sender_id, "I couldn't find a product link! Please copy the link from the Instagram post and paste it here, or click below to cancel.", cancelBtn);
            }
            break;

        case 'AWAITING_NAME':
            if (message_text) {
                tempData.customer_name = message_text;
                await updateUserState(sender_id, clientId, 'AWAITING_ADDRESS', tempData);
                return callSendAPI(sender_id, `Thanks, ${message_text}! And what is your full delivery address?`, cancelBtn);
            }
            break;

        case 'AWAITING_ADDRESS':
            if (message_text) {
                tempData.customer_address = message_text;
                await updateUserState(sender_id, clientId, 'AWAITING_PAYMENT', tempData);
                
                // Uses the client's specific UPI ID if available, otherwise falls back
                let clientUpi = userData.upi_id || "yourbusiness@upi";
                return callSendAPI(sender_id, `Perfect! Your total is ₹${tempData.price}. Please make the payment via UPI to '${clientUpi}' and upload the payment screenshot here.`, cancelBtn);
            }
            break;

        case 'AWAITING_PAYMENT':
            if (webhook_event.message && webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'image') {
                let imageUrl = webhook_event.message.attachments[0].payload.url;
                tempData.payment_screenshot = imageUrl;
                
                // Finalize order with the client_id tag
                await finalizeOrderInDatabase(sender_id, clientId, tempData);
                
                await updateUserState(sender_id, clientId, 'IDLE', {});
                let successReplies = [
                    { content_type: "text", title: "Discount Code 🎟️", payload: "CHECK_CODE" },
                    { content_type: "text", title: "Place Another Order 📦", payload: "PLACE_ORDER" },
                    { content_type: "text", title: "Talk to a Person 🙋‍♂️", payload: "TRIGGER_HUMAN_TAKEOVER" }
                ];
                return callSendAPI(sender_id, "Screenshot received! 📸 Our team is verifying the payment and will send your confirmation shortly.", successReplies);
            } else {
                return callSendAPI(sender_id, "I need a screenshot of the payment to proceed! Please upload the image, or click below to cancel.", cancelBtn);
            }
            break;

        case 'IDLE':
        default:
            let welcomeText = "Hi there! 👋 I am the digital assistant. How can I help you today?";
            let quickReplies = [
                { content_type: "text", title: "Discount Code 🎟️", payload: "CHECK_CODE" },
                { content_type: "text", title: "Place an Order 📦", payload: "PLACE_ORDER" },
                { content_type: "text", title: "Talk to a Person 🙋‍♂️", payload: "TRIGGER_HUMAN_TAKEOVER" }
            ];
            return callSendAPI(sender_id, welcomeText, quickReplies);
    }
}

// --- 4. THE VOICE ---
async function callSendAPI(sender_id, text, quickReplies = null) {
    const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    
    let payload = {
        recipient: { id: sender_id },
        message: { text: text }
    };

    if (quickReplies) {
        payload.message.quick_replies = quickReplies;
    }

    try {
        await axios.post(url, payload);
    } catch (error) {
        console.error("❌ Error sending message:", error.response ? error.response.data : error.message);
    }
}

// --- 5. SUPABASE HELPERS (SaaS Upgraded) ---
async function getUserData(sender_id, page_id) {
    // 1. Identify which client this Instagram Page belongs to
    let { data: profile } = await supabase
        .from('profiles')
        .select('id, upi_id')
        .eq('insta_page_id', page_id)
        .single();

    if (!profile) return null; // Exit if the page isn't in our system yet
    
    const clientId = profile.id;

    // 2. Look for the customer under this specific client
    let { data: customer } = await supabase
        .from('customers')
        .select('*')
        .eq('instagram_user_id', sender_id)
        .eq('client_id', clientId)
        .single();

    if (!customer) {
        const { data: newUser } = await supabase
            .from('customers')
            .insert([{ 
                instagram_user_id: sender_id, 
                client_id: clientId, // Tag the owner!
                bot_state: 'IDLE', 
                temp_order_data: {} 
            }])
            .select()
            .single();
        newUser.upi_id = profile.upi_id; // Attach temporarily for the bot to use
        return newUser;
    }
    customer.upi_id = profile.upi_id;
    return customer;
}

async function updateUserState(sender_id, client_id, newState, tempData = {}) {
    await supabase
        .from('customers')
        .update({ bot_state: newState, temp_order_data: tempData })
        .eq('instagram_user_id', sender_id)
        .eq('client_id', client_id); // Scoped update
}

async function finalizeOrderInDatabase(sender_id, client_id, finalData) {
    try {
        await supabase
            .from('pending_orders')
            .insert([{ 
                client_id: client_id, // Link order to the correct business
                instagram_user_id: sender_id, 
                original_message: `Order for ${finalData.product_name}`,
                status: "Pending Verification",
                order_details: finalData 
            }]);
        console.log(`✅ Order finalized for ${finalData.customer_name} under client ${client_id}`);
    } catch (error) {
        console.error("❌ Error finalizing order:", error);
    }
}

// --- 6. ADMIN COMMAND CENTER API ---
app.post('/api/verify-order', async (req, res) => {
    const { admin_secret, instagram_user_id, order_id } = req.body;

    if (admin_secret !== process.env.ADMIN_SECRET) {
        return res.status(403).send("Unauthorized: Invalid Admin Secret");
    }

    try {
        await supabase
            .from('pending_orders')
            .update({ status: 'Confirmed' })
            .eq('id', order_id);

        await callSendAPI(instagram_user_id, "🎉 Great news! Your payment has been verified and your order is confirmed. We are packing it up now!");

        res.status(200).send("Order verified and customer notified!");
    } catch (error) {
        console.error("❌ API Error:", error);
        res.status(500).send("Internal Server Error");
    }
});

app.listen(PORT, () => {
  console.log(`🔥 Multi-Tenant Server running on port ${PORT}`);
});