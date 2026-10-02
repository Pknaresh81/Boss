const fs = require('fs');
const path = require('path');

// 1. Keep-Alive / Fake Clicks Function (Session timeout rokne ke liye)
async function startKeepAlive(page) {
    console.log('[STEP 3 - KEEP-ALIVE] Starting background keep-alive & fake mouse movements...');
    
    // Har 15 seconds mein ek random subtle mouse movement ya click fire karega
    const interval = setInterval(async () => {
        try {
            // Check karein ki page abhi bhi zinda/open hai ya nahi
            if (!page || page.isClosed()) {
                console.log('[STEP 3 - KEEP-ALIVE] Page is closed, stopping keep-alive loop.');
                clearInterval(interval);
                return;
            }

            // Screen par kisi safe jagah par chota sa mouse move ya random click simulate karna
            const x = Math.floor(Math.random() * 300) + 100;
            const y = Math.floor(Math.random() * 300) + 100;

            await page.mouse.move(x, y);
            // Ek halka sa click taaki server ko lage user active hai
            await page.mouse.click(x, y, { delay: 50 });

            console.log(`[STEP 3 - KEEP-ALIVE] Simulated subtle mouse activity at coordinates (${x}, ${y})`);
        } catch (err) {
            console.log('[STEP 3 - KEEP-ALIVE] Error in keep-alive loop:', err.message);
            clearInterval(interval);
        }
    }, 15000); // 15 seconds ka interval

    return interval;
}

// 2. Background API Engine Execution (Saved cookies use karke fast processing)
async function runBackgroundBooking(sessionFilePath, bookingDetails) {
    try {
        if (!fs.existsSync(sessionFilePath)) {
            throw new Error('Session file not found! Please login first (Step 1).');
        }

        const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
        const cookies = sessionData.cookies;

        console.log('[STEP 3 - API ENGINE] Loaded cookies successfully from session.json. Starting background tasks...');

        // Yahan aapke background requests ya API calls configure hongi
        const headers = {
            'Cookie': cookies,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...',
            'Content-Type': 'application/json'
        };

        console.log('[STEP 3 - API ENGINE] Background engine ready with session cookies.');
        return { success: true, headers };

    } catch (error) {
        console.error('[STEP 3 - API ENGINE ERROR]:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { startKeepAlive, runBackgroundBooking };